/**
 * The JUGAAD companion listener: a separate, opt-in HTTP server with exactly two routes.
 *
 *   POST /companion/v1/pair  — exchange a proof of the one-time code for a sealed device key
 *   POST /companion/v1/rpc   — one encrypted, authenticated call: hello | pull | push
 *
 * It shares nothing with Core's API server: no bearer token, no chat, no approvals, no files. It is off unless the
 * person turned it on, and it binds to 127.0.0.1 (the Android emulator and `adb reverse` reach it there) unless the
 * person chose the local network. Everything a phone may do is listed in `rpc` below.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from '../domain/errors';
import {
  checkFreshness, companionDeviceKey, latestCompanionRevision, listCompanionChanges, openCompanionMessage, redeemCompanionPairing,
  sealCompanionMessage, touchCompanionDevice, type CompanionOp,
} from '../domain/companionSync';
import { handleCompanionOps } from '../runtime/householdService';

export const COMPANION_DEFAULT_PORT = 47821;
const MAX_BODY = 64 * 1024;

export interface CompanionSettings { enabled: boolean; bind: 'loopback' | 'lan'; port: number }

export function readCompanionSettings(dataDir: string): CompanionSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'companion-sync.json'), 'utf8')) as Partial<CompanionSettings>;
    return { enabled: raw.enabled === true, bind: raw.bind === 'lan' ? 'lan' : 'loopback', port: Number.isInteger(raw.port) && raw.port! > 1024 && raw.port! < 65536 ? raw.port! : COMPANION_DEFAULT_PORT };
  } catch {
    return { enabled: false, bind: 'loopback', port: COMPANION_DEFAULT_PORT };
  }
}

export function writeCompanionSettings(dataDir: string, settings: CompanionSettings): void {
  fs.writeFileSync(path.join(dataDir, 'companion-sync.json'), JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** The address a phone on the same network would use. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|virtual|docker|vpn|loopback/i.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new CoreError('invalid_request', 'request too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new CoreError('invalid_request', 'malformed JSON')); } });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export interface CompanionServerHandle { port: number; host: string; close(): Promise<void> }

export interface CompanionLog { (line: string): void }

/** Handles one decrypted call. The full list of what a paired phone can do. */
function rpc(db: CoreDatabase, deviceId: string, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'hello':
      touchCompanionDevice(db, deviceId);
      return { pc: process.env.COMPUTERNAME ?? 'Pandesh PC', latestRevision: latestCompanionRevision(db), serverTime: new Date().toISOString() };
    case 'pull': {
      const since = Math.max(0, Math.trunc(Number(params.since) || 0));
      const changes = listCompanionChanges(db, since, Number(params.limit) || 200);
      const nextSince = changes.length ? changes[changes.length - 1].revision : since;
      touchCompanionDevice(db, deviceId, nextSince);
      return { records: changes, nextSince, latestRevision: latestCompanionRevision(db), more: nextSince < latestCompanionRevision(db) };
    }
    case 'push': {
      const ops = Array.isArray(params.ops) ? params.ops as CompanionOp[] : [];
      touchCompanionDevice(db, deviceId);
      return { results: handleCompanionOps(db, deviceId, ops) };
    }
    default:
      throw new CoreError('invalid_request', `unknown method ${method}`);
  }
}

export function startCompanionServer(db: CoreDatabase, settings: CompanionSettings, log: CompanionLog = () => undefined): Promise<CompanionServerHandle> {
  const host = settings.bind === 'lan' ? '0.0.0.0' : '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || (url !== '/companion/v1/pair' && url !== '/companion/v1/rpc')) { send(res, 404, { ok: false, error: 'not found' }); return; }
    let body: Record<string, unknown>;
    try { body = await readBody(req) as Record<string, unknown>; } catch (err) { send(res, 400, { ok: false, error: err instanceof Error ? err.message : 'bad request' }); return; }
    if (url === '/companion/v1/pair') {
      try {
        const r = redeemCompanionPairing(db, { deviceId: String(body.deviceId ?? ''), label: String(body.label ?? ''), salt: String(body.salt ?? ''), proof: String(body.proof ?? '') });
        log(`companion: paired ${r.device.label} (${r.device.id})`);
        send(res, 200, { ok: true, deviceId: r.device.id, sealedKey: r.sealedKey });
      } catch (err) {
        log(`companion: pairing refused from ${req.socket.remoteAddress}: ${err instanceof Error ? err.message : err}`);
        send(res, err instanceof CoreError && err.code === 'unauthenticated' ? 401 : 400, { ok: false, error: err instanceof Error ? err.message : 'pairing failed' });
      }
      return;
    }
    const deviceId = String(body.d ?? '');
    const key = /^[A-Za-z0-9-]{8,64}$/.test(deviceId) ? companionDeviceKey(db, deviceId) : null;
    if (!key) { send(res, 401, { ok: false, error: 'this phone is not paired (or its pairing was revoked)' }); return; }
    let call: { method?: string; params?: Record<string, unknown>; ts?: number; nonce?: string };
    try {
      call = JSON.parse(openCompanionMessage(key, deviceId, { iv: String(body.iv ?? ''), ct: String(body.ct ?? '') }));
      checkFreshness(deviceId, Number(call.ts), String(call.nonce ?? ''));
    } catch (err) {
      send(res, 401, { ok: false, error: err instanceof Error ? err.message : 'not authenticated' });
      return;
    }
    let reply: Record<string, unknown>;
    try { reply = { ok: true, result: rpc(db, deviceId, String(call.method ?? ''), call.params ?? {}) }; } catch (err) { reply = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    send(res, 200, { ok: true, sealed: sealCompanionMessage(key, `${deviceId}:resp`, JSON.stringify({ ...reply, ts: Date.now(), nonce: call.nonce })) });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, host, () => {
      server.off('error', reject);
      log(`companion: listening on ${host}:${settings.port}`);
      resolve({ port: settings.port, host, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

/** Owns the listener's lifecycle so the host can turn it on and off without restarting Core. */
export class CompanionServerController {
  private handle: CompanionServerHandle | null = null;
  private lastError: string | null = null;
  constructor(private readonly db: CoreDatabase, private readonly dataDir: string, private readonly log: CompanionLog) {}

  async apply(settings = readCompanionSettings(this.dataDir)): Promise<void> {
    if (this.handle && (!settings.enabled || this.handle.port !== settings.port || this.handle.host !== (settings.bind === 'lan' ? '0.0.0.0' : '127.0.0.1'))) {
      await this.handle.close();
      this.handle = null;
    }
    if (settings.enabled && !this.handle) {
      try { this.handle = await startCompanionServer(this.db, settings, this.log); this.lastError = null; } catch (err) { this.lastError = err instanceof Error ? err.message : String(err); this.log(`companion: could not listen: ${this.lastError}`); }
    }
  }

  status(): { listening: boolean; host: string | null; port: number | null; error: string | null; settings: CompanionSettings; lanAddresses: string[] } {
    return { listening: Boolean(this.handle), host: this.handle?.host ?? null, port: this.handle?.port ?? null, error: this.lastError, settings: readCompanionSettings(this.dataDir), lanAddresses: lanAddresses() };
  }

  async close(): Promise<void> { if (this.handle) { await this.handle.close(); this.handle = null; } }
}

const controllers = new WeakMap<CoreDatabase, CompanionServerController>();

/** One listener per Core database: index.ts starts it, the host routes turn it on and off. */
export function companionController(db: CoreDatabase, dataDir: string, log: CompanionLog = (l) => console.log(`[karkedikha-core ${new Date().toISOString()}] ${l}`)): CompanionServerController {
  let c = controllers.get(db);
  if (!c) { c = new CompanionServerController(db, dataDir, log); controllers.set(db, c); }
  return c;
}
