/** Shared helpers for the Pandesh Mobile server tests (not a test file itself). */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import { MobileServer, type MobileServerOptions } from '../src/host/mobileServer';

export function tempDir(dirs: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-mobile-test-'));
  dirs.push(dir);
  return dir;
}

export function mockSession(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(e: any) => void>();
  const session = {
    snapshot: vi.fn(() => ({
      coreState: 'connected',
      model: 'gemma4:12b',
      modelIsAuto: false,
      folder: 'C:\\Projects\\example-app',
      running: false,
      attemptId: null,
      selectedConversationId: 'conv-1',
      activeConversationId: 'conv-1',
      pendingApproval: null,
      pendingImageApproval: null,
      pendingWeatherApproval: null,
      workspaceActivities: [],
      lastTurnOutcome: null,
      blockedReason: null,
    })),
    getActiveConversationMessages: vi.fn(async () => [{ id: 'm1', role: 'assistant', content: 'Hello!', createdAt: '2026-11-10T10:00:00Z' }]),
    submitTask: vi.fn(async (text: string) => ({ requestId: 'req-1', attemptId: 'att-1', model: 'gemma4:12b', text: `Pandesh response to: ${text}` })),
    isBusy: vi.fn(() => false),
    sendWhileRunning: vi.fn(async () => ({ requestId: '', attemptId: '', model: 'gemma4:12b', routed: 'queued', commandId: '7' })),
    resolvePending: vi.fn(async () => undefined),
    resolveImageApproval: vi.fn(async () => ({})),
    resolveWeatherApproval: vi.fn(async () => ({})),
    cancel: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (e: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    emit: (e: any) => { for (const l of [...listeners]) l(e); },
    transcribeUtteranceWavBase64: vi.fn(async () => ({ transcript: 'Transcribed utterance', engine: 'whisper', review: { required: false, reasons: [], corrections: [] } })),
    speakText: vi.fn(async () => ({ wavBase64: 'UklGRg==' })),
    refreshHostTelemetry: vi.fn(async () => ({ collectedAt: '2026-11-10T10:00:00Z' })),
    getArtifactContent: vi.fn(async (id: string) => {
      if (id === 'art-image-1') return { kind: 'image', mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), title: 'photo.png' };
      if (id === 'art-doc-1') return { kind: 'document', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4'), title: 'Invoice.pdf' };
      if (id === 'art-file-1') return { kind: 'file', mimeType: 'application/zip', bytes: Buffer.from('PK...'), title: 'Report (final)/draft".zip' };
      if (id === 'art-utf8-1') return { kind: 'file', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4'), title: "Résumé – 日本語 (it's 100%).pdf" };
      if (id === 'art-svg-1') return { kind: 'image', mimeType: 'image/svg+xml', bytes: Buffer.from('<svg onload="alert(1)"></svg>'), title: 'evil.svg' };
      throw new Error('Internal: artifact lookup failed at /secret/db/path.sqlite');
    }),
    ...overrides,
  };
  return session;
}

export async function startServer(dirs: string[], options: Omit<Partial<MobileServerOptions>, 'session'> & { session?: any } = {}) {
  const session = options.session ?? mockSession();
  const logs: string[] = [];
  const server = new MobileServer({
    dataDir: tempDir(dirs),
    port: 0,
    host: '127.0.0.1',
    pairFailureDelayMs: 0,
    secureLink: async () => ({ state: 'not-installed', url: null, detail: 'Tailscale is not installed on this PC.' }),
    log: (m) => logs.push(m),
    ...options,
    session,
  });
  await server.start();
  const port = server.getPairingInfo().port;
  const base = `http://127.0.0.1:${port}`;
  return { server, session, logs, port, base };
}

export async function pair(base: string, code: string, headers: Record<string, string> = {}): Promise<{ status: number; cookie: string; body: any; headers: Headers }> {
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ code }) });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { status: res.status, cookie: setCookie.split(';')[0], body: await res.json(), headers: res.headers };
}

/** Raw HTTP request with any headers (fetch forbids setting Host). */
export function rawRequest(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export interface EventStream {
  events: Array<{ event: string; data: any }>;
  waitFor(pred: (e: { event: string; data: any }) => boolean, timeoutMs?: number): Promise<{ event: string; data: any }>;
  closed: Promise<void>;
  close(): void;
}

/** Opens /api/events and collects the parsed events. */
export function openEvents(port: number, cookie: string): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: any }> = [];
    const waiters: Array<{ pred: (e: any) => boolean; done: (e: any) => void }> = [];
    let buffer = '';
    let closeResolve: () => void = () => undefined;
    const closed = new Promise<void>((r) => { closeResolve = r; });
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`events status ${res.statusCode}`)); res.resume(); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (!data.length) continue;
          const parsed = { event, data: JSON.parse(data.join('\n')) };
          events.push(parsed);
          for (const w of [...waiters]) if (w.pred(parsed)) { waiters.splice(waiters.indexOf(w), 1); w.done(parsed); }
        }
      });
      res.on('close', () => closeResolve());
      res.on('end', () => closeResolve());
      resolve({
        events,
        closed,
        close: () => req.destroy(),
        waitFor: (pred, timeoutMs = 3000) => {
          const hit = events.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error('event not received in time')), timeoutMs);
            waiters.push({ pred, done: (e) => { clearTimeout(timer); done(e); } });
          });
        },
      });
    });
    req.on('error', (err) => { closeResolve(); if (!events.length) reject(err); });
  });
}

/** A minimal 16-bit PCM WAV (silence), as the phone sends it. */
export function wavBytes(samples = 1600, rate = 16000): Buffer {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}
