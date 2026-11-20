/**
 * Registered deterministic services for the Panda bridge. A service is plain code (no model): the bridge claims, tracks,
 * cancels, times out and receipts it exactly like any other executor. Executor id: `service:<serviceId>`.
 * Discovery is not authorization: a service only runs inside the roots it was registered with.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../../db/connection';
import { dailyBriefService } from './bridgeBriefService';

export interface ServiceContext { args: Record<string, unknown>; signal: AbortSignal; /** The Core database, for services that only project records Core already holds. */ db?: CoreDatabase; }
export interface ServiceOutput { summary: string; evidence: Record<string, unknown>; files?: string[]; }

export interface BridgeService {
  id: string;
  label: string;
  /** Read-only services never write; anything else must be registered explicitly by the host. */
  readOnly: boolean;
  /** Task classes this service handles; the capability registry routes by them. */
  taskClasses?: string[];
  /** Filesystem roots this service may touch. Empty = no filesystem access. */
  roots: string[];
  run(ctx: ServiceContext): Promise<ServiceOutput>;
}

export class ServiceRegistry {
  private services = new Map<string, BridgeService>();
  register(s: BridgeService): this { this.services.set(s.id, s); return this; }
  get(id: string): BridgeService | undefined { return this.services.get(id); }
  list(): BridgeService[] { return [...this.services.values()]; }
}

/** Resolves a path and refuses anything outside the allowed roots (including `..` and symlink escapes). */
export function resolveInsideRoots(requested: unknown, roots: string[]): string {
  if (typeof requested !== 'string' || !requested) throw new Error('args.path is required');
  const real = fs.realpathSync(path.resolve(requested));
  const ok = roots.some(r => {
    const root = fs.realpathSync(path.resolve(r));
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) throw new Error('path is outside the roots this service is allowed to read');
  return real;
}

function checkAbort(signal: AbortSignal) { if (signal.aborted) throw new Error('cancelled'); }

/** Native filesystem read-only inspection: stat + SHA-256 (+ directory listing). */
export function fsInspectService(roots: string[]): BridgeService {
  return {
    id: 'fs.inspect', label: 'Filesystem inspect (read-only)', readOnly: true, taskClasses: ['filesystem.inspect', 'filesystem.list'], roots,
    async run({ args, signal }) {
      const p = resolveInsideRoots(args.path, roots);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const names = fs.readdirSync(p).slice(0, 200);
        return { summary: `Directory with ${names.length} entries`, evidence: { kind: 'directory', entries: names } };
      }
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(1 << 20);
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { checkAbort(signal); hash.update(buf.subarray(0, n)); }
      } finally { fs.closeSync(fd); }
      return { summary: `File ${st.size} bytes`, evidence: { kind: 'file', bytes: st.size, sha256: hash.digest('hex') } };
    },
  };
}

/** Deterministic workflow: verify a file's SHA-256 against an expected value (fetch → hash → compare → report). */
export function verifyHashWorkflow(roots: string[]): BridgeService {
  const inner = fsInspectService(roots);
  return {
    id: 'workflow.verify-hash', label: 'Workflow: verify file hash', readOnly: true, taskClasses: ['integrity.verify'], roots,
    async run(ctx) {
      const expected = String(ctx.args.sha256 ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('args.sha256 must be a 64-char hex digest');
      const out = await inner.run(ctx);
      const actual = String(out.evidence.sha256 ?? '');
      if (actual !== expected) throw new Error(`hash mismatch: expected ${expected}, got ${actual}`);
      return { summary: 'Hash verified', evidence: { ...out.evidence, expected, match: true } };
    },
  };
}

export function defaultServiceRegistry(roots: string[]): ServiceRegistry {
  return new ServiceRegistry().register(fsInspectService(roots)).register(verifyHashWorkflow(roots));
}

/** Parses the task instruction as service args: JSON object, else `{ text }`. */
export function parseServiceArgs(instruction: string): Record<string, unknown> {
  const t = instruction.trim();
  if (t.startsWith('{')) { try { const v = JSON.parse(t); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* fall through */ } }
  return { text: t };
}

/** Services the Core offers by default. Least privilege: filesystem services see only the bridge's own task workspaces. */
let cachedRegistry: ServiceRegistry | null = null;
export function bridgeServices(dataDir: string): ServiceRegistry {
  if (cachedRegistry) return cachedRegistry;
  const root = path.join(dataDir, 'panda-workspaces');
  fs.mkdirSync(root, { recursive: true });
  const reg = defaultServiceRegistry([root]);
  reg.register(dailyBriefService());
  return (cachedRegistry = reg);
}
