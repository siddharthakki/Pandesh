/**
 * Tailscale status, read-only. This is the ONLY thing this module can do: start the installed `tailscale.exe` with the one
 * fixed argv `status --json` (no shell, nothing from a task, user or model in the argv), then keep an allow-list of fields.
 * Keys, auth URLs, user profiles and routes in the CLI's output are dropped before the value leaves this module.
 * Any other Tailscale command (up/down/login/serve/funnel/set/ssh/file/...) is deliberately not expressible here.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';

export const TAILSCALE_ARGV: readonly string[] = Object.freeze(['status', '--json']);
export const DEFAULT_TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const TIMEOUT_MS = 8_000;
const MAX_OUTPUT = 1024 * 1024;

export interface TailscalePeer { hostName: string; dnsName: string; ips: string[]; online: boolean; lastSeen: string | null; os: string | null }
export interface TailscaleStatus {
  backendState: string; tailnet: string | null; health: string[];
  self: { hostName: string; dnsName: string; ips: string[]; online: boolean } | null;
  peers: TailscalePeer[];
}

export class TailscaleError extends Error {
  constructor(message: string, readonly reason: 'not_installed' | 'failed' | 'timeout' | 'cancelled' | 'bad_output') { super(message); this.name = 'TailscaleError'; }
}

/** The executable, or null. Fixed path, optional KARKEDIKHA_TAILSCALE_EXE override; the file must be named tailscale.exe. */
export function resolveTailscaleExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = env.KARKEDIKHA_TAILSCALE_EXE || DEFAULT_TAILSCALE_EXE;
  if (path.basename(exe).toLowerCase() !== 'tailscale.exe') return null;
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Keeps only the allow-listed fields. Everything else in the CLI output (keys, AuthURL, UserID, routes...) is dropped. */
export function filterTailscaleStatus(raw: unknown): TailscaleStatus {
  if (!raw || typeof raw !== 'object') throw new TailscaleError('tailscale returned no status object', 'bad_output');
  const r = raw as Record<string, unknown>;
  if (typeof r.BackendState !== 'string') throw new TailscaleError('tailscale status has no BackendState', 'bad_output');
  const self = r.Self && typeof r.Self === 'object' ? (r.Self as Record<string, unknown>) : null;
  const peers = r.Peer && typeof r.Peer === 'object' ? Object.values(r.Peer as Record<string, unknown>) : [];
  const tailnet = r.CurrentTailnet && typeof r.CurrentTailnet === 'object' ? str((r.CurrentTailnet as Record<string, unknown>).Name) : '';
  return {
    backendState: r.BackendState, tailnet: tailnet || null, health: strs(r.Health),
    self: self ? { hostName: str(self.HostName), dnsName: str(self.DNSName), ips: strs(self.TailscaleIPs), online: self.Online === true } : null,
    peers: peers.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object').map(p => ({
      hostName: str(p.HostName), dnsName: str(p.DNSName), ips: strs(p.TailscaleIPs), online: p.Online === true,
      lastSeen: str(p.LastSeen) && !str(p.LastSeen).startsWith('0001-') ? str(p.LastSeen) : null, os: str(p.OS) || null,
    })).sort((a, b) => a.hostName.localeCompare(b.hostName)),
  };
}

/** Runs `tailscale status --json`. Rejects with a TailscaleError (never guesses). */
export function readTailscaleStatus(options: { exe?: string | null; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TailscaleStatus> {
  const exe = options.exe === undefined ? resolveTailscaleExe() : options.exe;
  if (!exe) return Promise.reject(new TailscaleError('Tailscale is not installed (tailscale.exe not found)', 'not_installed'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(exe, [...TAILSCALE_ARGV], { env: createSanitizedChildEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new TailscaleError(`could not start tailscale: ${e instanceof Error ? e.message : String(e)}`, 'failed')); return; }
    let out = '', err = '', settled = false;
    const kill = () => { try { child.kill(); } catch { /* gone */ } };
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => { kill(); finish(() => reject(new TailscaleError('the status check was cancelled', 'cancelled'))); };
    const timer = setTimeout(() => { kill(); finish(() => reject(new TailscaleError(`tailscale did not answer within ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)}s`, 'timeout'))); }, options.timeoutMs ?? TIMEOUT_MS);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c: Buffer) => { if (out.length < MAX_OUTPUT) out += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { if (err.length < 8192) err += c.toString('utf8'); });
    child.on('error', e => finish(() => reject(new TailscaleError(`could not start tailscale: ${e.message}`, 'failed'))));
    child.on('close', code => finish(() => {
      if (code !== 0 && !out.trim()) return reject(new TailscaleError(`tailscale exited with ${code}: ${err.trim().slice(0, 200) || 'no message'}`, 'failed'));
      try { resolve(filterTailscaleStatus(JSON.parse(out))); } catch (e) { reject(e instanceof TailscaleError ? e : new TailscaleError('tailscale output was not valid JSON', 'bad_output')); }
    }));
  });
}
