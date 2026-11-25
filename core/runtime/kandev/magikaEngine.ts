/**
 * Optional Magika engine for file-type detection. Magika (Google, Apache-2.0) runs locally from an isolated virtual
 * environment; file contents never leave the machine. It is only an engine behind the existing `doc.detect-type`
 * capability: when it is not installed, times out, or returns something unusable, callers fall back to the signature table.
 * It runs through the approved `documentOcr.runLocalTool` (fixed argv, sanitized environment, timeout, process-tree kill),
 * so this file does not import child_process and the M54 architecture guard is unaffected.
 */
import * as fs from 'node:fs';
import { runLocalTool } from '../documentOcr';

export const DEFAULT_MAGIKA_EXE = 'D:\\PandeshServices\\magika\\venv\\Scripts\\magika.exe';

export interface MagikaResult {
  label: string;
  description: string;
  mime: string;
  group: string;
  isText: boolean;
  score: number | null;
}

/** Path of the Magika executable, or null when it is not installed (the signature table is then the only engine). */
export function resolveMagikaExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.KARKEDIKHA_MAGIKA_EXE;
  if (configured === '' || configured === 'off') return null;
  const exe = configured || DEFAULT_MAGIKA_EXE;
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

/** Parses `magika --json <file>` output. Returns null for anything that is not a well-formed successful result. */
export function parseMagikaJson(stdout: string): MagikaResult | null {
  try {
    const j = JSON.parse(stdout) as Array<{ result?: { status?: string; value?: { output?: Record<string, unknown>; score?: unknown } } }>;
    const r = Array.isArray(j) ? j[0]?.result : undefined;
    if (!r || r.status !== 'ok' || !r.value?.output) return null;
    const o = r.value.output;
    if (typeof o.label !== 'string' || typeof o.mime_type !== 'string') return null;
    return {
      label: o.label, description: typeof o.description === 'string' ? o.description : o.label, mime: o.mime_type,
      group: typeof o.group === 'string' ? o.group : 'unknown', isText: o.is_text === true,
      score: typeof r.value.score === 'number' ? r.value.score : null,
    };
  } catch { return null; }
}

/** Runs Magika on one file. Never throws: any failure (not installed, timeout, bad output, cancel) yields null. */
export async function runMagika(filePath: string, options: { exe?: string | null; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MagikaResult | null> {
  const exe = options.exe === undefined ? resolveMagikaExe() : options.exe;
  if (!exe) return null;
  try {
    const run = await runLocalTool(exe, ['--json', filePath], { timeoutMs: options.timeoutMs ?? 15_000, signal: options.signal, maxBuffer: 1024 * 1024 });
    if (run.code !== 0) return null;
    return parseMagikaJson(run.stdout);
  } catch { return null; }
}
