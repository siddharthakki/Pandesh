/**
 * Local Outlook connector: talks to the read-only STA worker (outlookWorkerScript.ts) over JSON lines.
 *
 * COM never runs in Core's event loop: it runs in a child PowerShell process of its own. Calls are serial (one STA),
 * the queue is bounded, every call has a timeout, and a timeout, a cancel or a crash ends the worker process; the next
 * call starts a fresh one. Nothing here can change a mailbox: the worker has no write command.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OUTLOOK_WORKER_SCRIPT } from './outlookWorkerScript';

export interface OutlookAccount { storeId: string; name: string; inboxItems: number | null; inboxUnread: number | null }
export interface OutlookFolder { path: string; name: string; items: number; unread: number }
export interface OutlookMessage {
  entryId: string; conversationId: string; internetMessageId: string; subject: string; fromName: string; fromAddress: string; to: string;
  received: string; unread: boolean; attachments: number; body?: string; bulkHint?: boolean;
}
export interface OutlookMessageDetail extends OutlookMessage { body: string; attachmentList: Array<{ name: string; size: number }> }
export interface OutlookListResult { messages: OutlookMessage[]; folderItems: number; hasMore: boolean }

export type ConnectorHealth = { state: 'unknown' | 'ok' | 'down'; lastOkAt: string | null; lastError: string | null; restarts: number; queued: number };

export class OutlookError extends Error {
  constructor(readonly code: 'unavailable' | 'timeout' | 'cancelled' | 'busy' | 'failed', message: string) { super(message); }
}

export interface OutlookConnectorOptions {
  dataDir: string;
  /** Test seam: a different program that speaks the same protocol. */
  command?: { file: string; args: string[] };
  maxQueue?: number;
  defaultTimeoutMs?: number;
}

interface Pending { id: string; line: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onAbort?: () => void; signal?: AbortSignal; started: boolean }

export class OutlookConnector {
  private child: cp.ChildProcess | null = null;
  private buffer = '';
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private seq = 0;
  private readonly state: ConnectorHealth = { state: 'unknown', lastOkAt: null, lastError: null, restarts: 0, queued: 0 };
  private readonly maxQueue: number;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: OutlookConnectorOptions) {
    this.maxQueue = options.maxQueue ?? 8;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  health(): ConnectorHealth { return { ...this.state, queued: this.queue.length + (this.current ? 1 : 0) }; }

  accounts(signal?: AbortSignal) { return this.call<{ accounts: OutlookAccount[] }>('accounts', {}, { signal }).then((r) => r.accounts); }
  ping(signal?: AbortSignal) { return this.call<{ version: string; stores: number }>('ping', {}, { signal, timeoutMs: this.defaultTimeoutMs }); }
  folders(storeId: string, depth = 2, signal?: AbortSignal) { return this.call<{ folders: OutlookFolder[] }>('folders', { storeId, depth }, { signal }).then((r) => r.folders); }
  list(p: { storeId: string; folder?: string; sinceIso?: string; limit: number; offset?: number; bodyChars?: number }, signal?: AbortSignal) {
    return this.call<OutlookListResult>('list', p, { signal, timeoutMs: this.defaultTimeoutMs * 2 });
  }
  get(p: { storeId: string; entryId: string; bodyChars?: number }, signal?: AbortSignal) { return this.call<OutlookMessageDetail>('get', p, { signal }); }

  /** Ends the worker. Pending calls fail with "cancelled"; the next call starts a fresh worker. */
  stop(): void { this.killWorker(new OutlookError('cancelled', 'the Outlook connector was stopped')); }

  private call<T>(cmd: string, params: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (process.platform !== 'win32' && !this.options.command) return Promise.reject(new OutlookError('unavailable', 'Outlook is only available on Windows'));
    if (opts.signal?.aborted) return Promise.reject(new OutlookError('cancelled', 'cancelled'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new OutlookError('busy', 'the Outlook connector has too many requests waiting'));
    return new Promise<T>((resolve, reject) => {
      const id = String(++this.seq);
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      const p: Pending = { id, line: JSON.stringify({ id, cmd, ...params }), resolve: resolve as (v: unknown) => void, reject, started: false, signal: opts.signal,
        timer: setTimeout(() => this.expire(p, timeoutMs), timeoutMs) };
      // The timer starts at the call, so a long wait in the queue counts: callers never wait unboundedly.
      if (opts.signal) { p.onAbort = () => this.abort(p); opts.signal.addEventListener('abort', p.onAbort, { once: true }); }
      this.queue.push(p);
      this.pump();
    });
  }

  private settle(p: Pending, how: { ok: true; value: unknown } | { ok: false; error: Error }) {
    clearTimeout(p.timer);
    if (p.onAbort) p.signal?.removeEventListener('abort', p.onAbort);
    if (how.ok) p.resolve(how.value); else p.reject(how.error);
  }

  private expire(p: Pending, ms: number) {
    const err = new OutlookError('timeout', `Outlook did not answer within ${Math.round(ms / 1000)} s`);
    this.drop(p, err);
  }
  private abort(p: Pending) { this.drop(p, new OutlookError('cancelled', 'cancelled')); }

  /** A call that has not started just leaves the queue. A call in flight ends the worker, whose COM state is then unknown. */
  private drop(p: Pending, err: Error) {
    const i = this.queue.indexOf(p);
    if (i >= 0) { this.queue.splice(i, 1); this.settle(p, { ok: false, error: err }); return; }
    if (this.current === p) {
      if (err instanceof OutlookError && err.code === 'timeout') this.state.lastError = err.message;
      this.killWorker(err);
    }
  }

  private killWorker(reason: Error) {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    if (child) { try { child.removeAllListeners(); child.stdout?.removeAllListeners(); child.kill(); if (process.platform === 'win32' && child.pid) cp.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined); } catch { /* already gone */ } }
    const inflight = this.current;
    this.current = null;
    if (inflight) this.settle(inflight, { ok: false, error: reason });
    if (reason instanceof OutlookError && reason.code === 'cancelled') for (const q of this.queue.splice(0)) this.settle(q, { ok: false, error: reason });
    this.pump();
  }

  private spawnWorker(): cp.ChildProcess {
    let file: string; let args: string[];
    if (this.options.command) ({ file, args } = this.options.command);
    else {
      const dir = path.join(this.options.dataDir, 'mail');
      fs.mkdirSync(dir, { recursive: true });
      const script = path.join(dir, 'outlookWorker.ps1');
      try { if (fs.readFileSync(script, 'utf8') !== OUTLOOK_WORKER_SCRIPT) throw new Error('stale'); } catch { fs.writeFileSync(script, OUTLOOK_WORKER_SCRIPT, 'utf8'); }
      file = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script];
    }
    const child = cp.spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => this.onData(child, d));
    child.stderr!.on('data', () => undefined);
    child.on('error', (err) => { if (this.child === child) { this.state.state = 'down'; this.state.lastError = err.message; this.killWorker(new OutlookError('unavailable', `Outlook worker could not start: ${err.message}`)); } });
    child.on('exit', (code) => { if (this.child === child) { this.state.state = 'down'; this.state.lastError = `the Outlook worker ended (exit ${code})`; this.killWorker(new OutlookError('unavailable', this.state.lastError)); } });
    this.state.restarts += this.child === null && this.state.lastOkAt !== null ? 1 : 0;
    return child;
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    try {
      if (!this.child) this.child = this.spawnWorker();
      this.current = next;
      next.started = true;
      this.child.stdin!.write(`${next.line}\n`);
    } catch (err) {
      this.current = null;
      this.state.state = 'down'; this.state.lastError = err instanceof Error ? err.message : String(err);
      this.settle(next, { ok: false, error: new OutlookError('unavailable', this.state.lastError) });
      this.pump();
    }
  }

  private onData(child: cp.ChildProcess, chunk: string) {
    if (child !== this.child) return;
    this.buffer += chunk;
    if (this.buffer.length > 40_000_000) { this.killWorker(new OutlookError('failed', 'the Outlook worker sent too much data')); return; }
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: { id?: string; ok?: boolean; data?: unknown; error?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.current;
      if (!p || msg.id !== p.id) continue;
      this.current = null;
      if (msg.ok) { this.state.state = 'ok'; this.state.lastOkAt = new Date().toISOString(); this.state.lastError = null; this.settle(p, { ok: true, value: msg.data }); }
      else { this.state.lastError = msg.error ?? 'failed'; this.settle(p, { ok: false, error: new OutlookError('failed', msg.error ?? 'Outlook reported an error') }); }
    }
    this.pump();
  }
}
