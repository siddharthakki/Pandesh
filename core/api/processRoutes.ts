/**
 * Phase 2e — Visual Execution: the processes Pandesh itself started.
 *
 * Read-only projection of the existing records — the process-ownership ledger
 * (`processOwnership.ts`), the Port Manager registry (`portManager.ts`) and the
 * browser launch record — each checked against the live process right now:
 * alive, same executable, and a creation time that matches what was recorded
 * (so a recycled pid is never shown as Pandesh's). Nothing here stops a
 * process; stopping goes through task cancellation and the ownership boundary.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import { defaultExec, type ExecRunner } from '../runtime/capabilityInventory';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}

export interface OwnedProcessView {
  pid: number;
  source: string;
  recordedAt: string | null;
  executablePath: string | null;
  port: number | null;
  serviceName: string | null;
  state: 'running' | 'ended' | 'pid_reused' | 'unknown';
  reason: string;
  live: { executablePath: string | null; startedAt: string | null; commandLine: string | null } | null;
}

interface Recorded { pid: number; source: string; recordedAt: string | null; executablePath: string | null; creationTimeMs: number | null; port: number | null; serviceName: string | null }

const json = <T,>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } };
const norm = (p: string | null | undefined) => (p ?? '').trim().replace(/\//g, '\\').toLowerCase();

export function readRecordedProcesses(dataDir: string): Recorded[] {
  const out = new Map<number, Recorded>();
  for (const p of Object.values(json<Record<string, { pid: number; executablePath: string | null; creationTimeMs: number | null; recordedAt: string; source: string }>>(path.join(dataDir, 'process-ownership-ledger.json'), {}))) {
    if (p && Number.isInteger(p.pid)) out.set(p.pid, { pid: p.pid, source: p.source, recordedAt: p.recordedAt ?? null, executablePath: p.executablePath ?? null, creationTimeMs: p.creationTimeMs ?? null, port: null, serviceName: null });
  }
  for (const s of json<Array<{ name: string; port: number; pid: number | null; processStartMs: number | null; executable: string | null; startedAt: string }>>(path.join(dataDir, 'port-manager-registry.json'), [])) {
    if (!s?.pid) continue;
    const prev = out.get(s.pid);
    out.set(s.pid, { pid: s.pid, source: prev?.source ?? `port-manager:${s.name}`, recordedAt: prev?.recordedAt ?? s.startedAt ?? null, executablePath: prev?.executablePath ?? s.executable ?? null, creationTimeMs: prev?.creationTimeMs ?? s.processStartMs ?? null, port: s.port, serviceName: s.name });
  }
  for (const b of json<Array<{ pid?: number; executablePath?: string; launchedAt?: string; creationTimeMs?: number }>>(path.join(dataDir, 'browser-launched-processes.json'), [])) {
    if (b?.pid && !out.has(b.pid)) out.set(b.pid, { pid: b.pid, source: 'browser', recordedAt: b.launchedAt ?? null, executablePath: b.executablePath ?? null, creationTimeMs: b.creationTimeMs ?? null, port: null, serviceName: null });
  }
  return [...out.values()];
}

/** One CIM query for every recorded pid: alive, executable, creation time. */
export async function liveIdentities(pids: number[], exec: ExecRunner = defaultExec): Promise<Map<number, { executablePath: string | null; creationTimeMs: number | null; commandLine: string | null }>> {
  const out = new Map<number, { executablePath: string | null; creationTimeMs: number | null; commandLine: string | null }>();
  const valid = pids.filter((p) => Number.isInteger(p) && p > 0).slice(0, 200);
  if (valid.length === 0 || process.platform !== 'win32') return out;
  const filter = valid.map((p) => `ProcessId=${p}`).join(' OR ');
  const script = `@(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ExecutablePath,CommandLine,@{n='Created';e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}}) | ConvertTo-Json -Compress`;
  const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 20_000);
  if (r.code !== 0) return out;
  let rows: unknown = [];
  try { rows = JSON.parse(r.stdout.trim() || '[]'); } catch { return out; }
  for (const row of (Array.isArray(rows) ? rows : [rows]) as Array<{ ProcessId: number; ExecutablePath: string | null; CommandLine: string | null; Created: number | null }>) {
    out.set(Number(row.ProcessId), { executablePath: row.ExecutablePath ?? null, creationTimeMs: typeof row.Created === 'number' ? row.Created : null, commandLine: row.CommandLine ? String(row.CommandLine).slice(0, 300) : null });
  }
  return out;
}

export function classifyProcess(rec: Recorded, live: { executablePath: string | null; creationTimeMs: number | null; commandLine: string | null } | undefined): Pick<OwnedProcessView, 'state' | 'reason'> {
  if (!live) return { state: 'ended', reason: 'No process with this id is running.' };
  if (rec.executablePath && live.executablePath && norm(rec.executablePath) !== norm(live.executablePath)) return { state: 'pid_reused', reason: `The id now belongs to ${live.executablePath}, not what Pandesh started.` };
  if (rec.creationTimeMs && live.creationTimeMs && Math.abs(rec.creationTimeMs - live.creationTimeMs) > 1500) return { state: 'pid_reused', reason: 'The id was reused by a process started at a different time.' };
  if (!live.executablePath || !rec.creationTimeMs) return { state: 'unknown', reason: 'Running, but its identity could not be fully confirmed.' };
  return { state: 'running', reason: 'Running; executable and start time match what Pandesh recorded.' };
}

export function registerProcessRoutes(router: Router<ApiContext, ApiResult>, options: { dataDir: string; exec?: ExecRunner }): void {
  router.get('/v1/processes', async (ctx) => {
    requireHost(ctx);
    const recorded = readRecordedProcesses(options.dataDir);
    const live = await liveIdentities(recorded.map((r) => r.pid), options.exec);
    const processes: OwnedProcessView[] = recorded.map((r) => {
      const l = live.get(r.pid);
      return { pid: r.pid, source: r.source, recordedAt: r.recordedAt, executablePath: r.executablePath, port: r.port, serviceName: r.serviceName, ...classifyProcess(r, l), live: l ? { executablePath: l.executablePath, startedAt: l.creationTimeMs ? new Date(l.creationTimeMs).toISOString() : null, commandLine: l.commandLine } : null };
    }).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''));
    return { status: 200, body: { checkedAt: new Date().toISOString(), processes } };
  });
}
