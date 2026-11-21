/**
 * ChatGPT connector supervisor (host side).
 *
 * Starts, watches and stops the two local processes that let ChatGPT reach Pandesh through OpenAI's Secure MCP Tunnel:
 *   1. the MCP gateway (apps/panda-bridge/mcp-gateway/server.mjs): loopback only; MCP + OAuth /register + /token over
 *      HTTPS on 127.0.0.1:<tlsPort>, /authorize over plain loopback HTTP for the person's own browser;
 *   2. OpenAI's outbound-only `tunnel-client`.
 *
 * Security rules this module keeps:
 *   - Off by default. Nothing starts unless the person switched the connector on in Pandesh.
 *   - The OpenAI tunnel key is held only in the Windows Credential Manager (CredentialVault, provider id `openai-tunnel`).
 *     It is read at process start and handed to tunnel-client through that one process's environment (`env:` reference),
 *     never on a command line, never in a file, never in a log line, never returned to the renderer (only a masked hint).
 *   - Fixed argv, no shell, no model- or task-supplied input. Programs are paths the person configured.
 *   - It never kills a process it did not start, and refuses to start when a port is already taken.
 *   - Consent is unchanged: ChatGPT is paired only by a one-time Pandesh pairing code created here, and
 *     "Disconnect" revokes every ChatGPT pairing and stops both processes.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as path from 'node:path';
import { maskedKeyHint } from './cloudProviderSettings';

export const CONNECTOR_KEY_PROVIDER = 'openai-tunnel';
export const CONNECTOR_PAIRING_LABEL_PREFIX = 'ChatGPT connector';
const CONFIG_FILE = 'chatgpt-connector.json';
const LOG_FILE = path.join('logs', 'chatgpt-connector.log');
const CERT_RENEW_BEFORE_MS = 14 * 24 * 3600 * 1000;
const CERT_DAYS = 90;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 10 * 60 * 1000;

export interface ConnectorConfig {
  enabled: boolean;
  tunnelId: string;
  /** Full path to OpenAI's tunnel-client.exe. */
  clientPath: string;
  /** Full path to apps/panda-bridge/mcp-gateway/server.mjs. */
  gatewayPath: string;
  gatewayPort: number;
  tlsPort: number;
  healthPort: number;
}

export const DEFAULT_CONNECTOR_CONFIG: ConnectorConfig = {
  enabled: false,
  tunnelId: '',
  clientPath: '',
  gatewayPath: '',
  gatewayPort: 3973,
  tlsPort: 3974,
  healthPort: 3975,
};

export type ConnectorState = 'off' | 'needs-setup' | 'needs-key' | 'starting' | 'running' | 'degraded' | 'failed';

export interface ConnectorStatus {
  state: ConnectorState;
  /** One plain sentence for the settings card. */
  detail: string;
  enabled: boolean;
  keyConfigured: boolean;
  /** Masked (first/last four) or null. The key itself never leaves the host. */
  keyHint: string | null;
  tunnelId: string;
  gatewayRunning: boolean;
  tunnelRunning: boolean;
  /** Does tunnel-client's own health endpoint answer? */
  tunnelReachable: boolean;
  activePairings: number;
  lastError: string | null;
  /** The most recent failure and when it happened (kept after recovery, so a past problem stays visible). */
  lastFailure: { at: string; message: string } | null;
  /** Which Core the gateway talks to: always this Pandesh's own data directory, never another profile. */
  core: { reachable: boolean; port: number | null; profile: string; production: boolean; build: string | null };
  /** Recent log lines (key redacted). */
  recentLog: string[];
}

export interface ConnectorDeps {
  dataDir: string;
  /** Reads the stored key (CredentialVault.get). */
  getKey: () => Promise<string | null>;
  /** Program that runs the gateway script. In Electron this is the app executable with ELECTRON_RUN_AS_NODE=1. */
  nodePath: string;
  nodeIsElectron: boolean;
  log: (message: string) => void;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  /** Is this TCP port free on loopback? */
  portFree?: (port: number) => Promise<boolean>;
  /** Path to openssl for certificate generation (null = none found). */
  opensslPath?: string | null;
  now?: () => number;
  /** How long to wait for the gateway to listen before starting the tunnel. */
  startupWaitMs?: number;
  /** True when this profile is the real production profile (shown in status; never a reason to start differently). */
  isProductionProfile?: boolean;
  /** "Build 188 (d1b94da)" style label of the running Pandesh, for status. */
  buildLabel?: string;
  /** Health watchdog period (ms); 0 disables it. */
  watchdogMs?: number;
  /** Checks the gateway presents exactly the certificate on disk. Default: a real TLS handshake with that certificate as the only trust root. */
  verifyPin?: (port: number, certPem: Buffer) => Promise<boolean>;
}

/**
 * Certificate pinning for the loopback hop: connect to the gateway with ONLY the on-disk certificate trusted and compare
 * the presented leaf's SHA-256 fingerprint with that certificate's. A different process (or certificate) on the port fails.
 */
export function verifyGatewayPin(port: number, certPem: Buffer, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let expected: string;
    try { expected = new X509Certificate(certPem).fingerprint256; } catch { resolve(false); return; }
    const socket = tls.connect({ host: '127.0.0.1', port, ca: certPem, rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity: () => undefined });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('secureConnect', () => done(socket.authorized && socket.getPeerCertificate().fingerprint256 === expected));
  });
}

const SAFE_ENV_KEYS = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'COMPUTERNAME', 'USERNAME'];

export function reducedEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) if (source[key] !== undefined) out[key] = String(source[key]);
  return out;
}

export function normalizeConfig(raw: unknown): ConnectorConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const port = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 ? (v as number) : d);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 600) : '');
  const tunnelId = str(r.tunnelId);
  return {
    enabled: r.enabled === true,
    tunnelId: /^tunnel_[A-Za-z0-9_-]{4,120}$/.test(tunnelId) ? tunnelId : '',
    clientPath: str(r.clientPath),
    gatewayPath: str(r.gatewayPath),
    gatewayPort: port(r.gatewayPort, DEFAULT_CONNECTOR_CONFIG.gatewayPort),
    tlsPort: port(r.tlsPort, DEFAULT_CONNECTOR_CONFIG.tlsPort),
    healthPort: port(r.healthPort, DEFAULT_CONNECTOR_CONFIG.healthPort),
  };
}

export function readConnectorConfig(dataDir: string): ConnectorConfig {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8'))); } catch { return { ...DEFAULT_CONNECTOR_CONFIG }; }
}

export function writeConnectorConfig(dataDir: string, patch: Partial<ConnectorConfig>): ConnectorConfig {
  const next = normalizeConfig({ ...readConnectorConfig(dataDir), ...patch });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, CONFIG_FILE), JSON.stringify(next, null, 1), { mode: 0o600 });
  return next;
}

export function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(true); });
  });
}

export function findOpenssl(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'OpenSSL-Win64', 'bin', 'openssl.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Valid loopback leaf (SAN 127.0.0.1) that lasts at least 14 more days? */
export function certificateIsUsable(certPath: string, keyPath: string, now = Date.now()): boolean {
  try {
    if (!fs.existsSync(keyPath)) return false;
    const cert = new X509Certificate(fs.readFileSync(certPath));
    return Date.parse(cert.validTo) - now > CERT_RENEW_BEFORE_MS && /IP Address:127\.0\.0\.1/.test(cert.subjectAltName ?? '');
  } catch {
    return false;
  }
}

interface Supervised {
  name: 'gateway' | 'tunnel';
  child?: ChildProcess;
  crashes: number[];
  retry?: NodeJS.Timeout;
  failed?: string;
}

export class ChatgptConnector {
  private readonly spawnFn: typeof spawn;
  private readonly fetchFn: typeof fetch;
  private readonly portFree: (port: number) => Promise<boolean>;
  private readonly now: () => number;
  private desired = false;
  private starting: Promise<void> | undefined;
  private lastErrorValue: string | null = null;
  private lastFailure: { at: string; message: string } | null = null;
  private readonly lastLines: string[] = [];
  private watchdog: NodeJS.Timeout | undefined;
  private strikes: Record<'gateway' | 'tunnel', number> = { gateway: 0, tunnel: 0 };
  private get lastError(): string | null { return this.lastErrorValue; }
  private set lastError(value: string | null) {
    this.lastErrorValue = value;
    if (value) this.lastFailure = { at: new Date(this.now()).toISOString(), message: value };
  }
  private keyForRedaction = '';
  private readonly parts: Record<'gateway' | 'tunnel', Supervised> = { gateway: { name: 'gateway', crashes: [] }, tunnel: { name: 'tunnel', crashes: [] } };

  constructor(private readonly deps: ConnectorDeps) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.portFree = deps.portFree ?? defaultPortFree;
    this.now = deps.now ?? Date.now;
  }

  config(): ConnectorConfig { return readConnectorConfig(this.deps.dataDir); }
  private tlsDir(): string { return path.join(this.deps.dataDir, 'mcp-gateway-tls'); }
  private certPath(): string { return path.join(this.tlsDir(), 'gateway-cert.pem'); }
  private keyPath(): string { return path.join(this.tlsDir(), 'gateway-key.pem'); }

  private audit(message: string): void {
    const line = this.redact(`${new Date(this.now()).toISOString()} ${message}`);
    try {
      const file = path.join(this.deps.dataDir, LOG_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`);
    } catch { /* the log is best effort */ }
    this.lastLines.push(line.slice(0, 300));
    if (this.lastLines.length > 30) this.lastLines.shift();
    this.deps.log(`ChatGPT connector: ${this.redact(message)}`);
  }

  private redact(text: string): string {
    return this.keyForRedaction.length >= 8 ? text.split(this.keyForRedaction).join('[redacted]') : text;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────

  /** Applies the saved switch: starts when enabled, stops when not. Safe to call at app start. */
  async applyConfig(): Promise<ConnectorStatus> {
    if (this.config().enabled) await this.start(); else await this.stop('switched off');
    return this.status();
  }

  async enable(): Promise<ConnectorStatus> {
    writeConnectorConfig(this.deps.dataDir, { enabled: true });
    this.audit('switched on by the person');
    await this.start();
    return this.status();
  }

  async disable(): Promise<ConnectorStatus> {
    writeConnectorConfig(this.deps.dataDir, { enabled: false });
    this.audit('switched off by the person');
    await this.stop('switched off');
    return this.status();
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startInner().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startInner(): Promise<void> {
    const cfg = this.config();
    this.lastError = null;
    const problem = this.setupProblem(cfg);
    if (problem) { this.lastError = problem; this.desired = false; this.audit(`not started: ${problem}`); return; }
    const key = await this.deps.getKey().catch(() => null);
    if (!key) { this.lastError = 'The OpenAI tunnel key is not stored yet.'; this.desired = false; this.audit('not started: no tunnel key stored'); return; }
    this.keyForRedaction = key;
    const cert = await this.ensureCertificate();
    if (cert) { this.lastError = cert; this.desired = false; this.audit(`not started: ${cert}`); return; }
    this.desired = true;
    for (const p of [this.parts.gateway, this.parts.tunnel]) { p.crashes = []; p.failed = undefined; }
    if (!(await this.startPart(this.parts.gateway, cfg))) return;
    // The tunnel is started after the gateway answers on loopback; its own start-up probe needs it.
    const listening = await this.waitForPort(cfg.tlsPort, this.deps.startupWaitMs ?? 8000);
    if (this.deps.startupWaitMs !== 0 || this.deps.verifyPin) {
      const pinned = listening && await (this.deps.verifyPin ?? verifyGatewayPin)(cfg.tlsPort, fs.readFileSync(this.certPath()));
      if (!pinned) {
        this.lastError = 'The gateway did not present the expected loopback certificate, so the tunnel was not started.';
        this.parts.tunnel.failed = this.lastError; this.audit(this.lastError);
        return;
      }
      this.audit('gateway certificate matches the pinned loopback certificate');
    }
    await this.startPart(this.parts.tunnel, cfg);
    this.startWatchdog();
  }

  private setupProblem(cfg: ConnectorConfig): string | null {
    if (!cfg.tunnelId) return 'Set the tunnel id (tunnel_…) first.';
    if (!cfg.clientPath || !fs.existsSync(cfg.clientPath)) return 'tunnel-client.exe was not found at the configured path.';
    if (!cfg.gatewayPath || !fs.existsSync(cfg.gatewayPath)) return 'The MCP gateway script was not found at the configured path.';
    if (new Set([cfg.gatewayPort, cfg.tlsPort, cfg.healthPort]).size !== 3) return 'The three connector ports must differ.';
    return null;
  }

  /** Returns an error sentence, or null when a usable certificate exists (generating one when needed). */
  private async ensureCertificate(): Promise<string | null> {
    if (certificateIsUsable(this.certPath(), this.keyPath(), this.now())) return null;
    const openssl = this.deps.opensslPath === undefined ? findOpenssl() : this.deps.opensslPath;
    if (!openssl) return 'No loopback certificate exists and OpenSSL (for example Git for Windows) was not found to create one.';
    fs.mkdirSync(this.tlsDir(), { recursive: true });
    const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', this.keyPath(), '-out', this.certPath(), '-days', String(CERT_DAYS), '-subj', '/CN=pandesh-mcp-gateway-loopback', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:FALSE'];
    const failure = await new Promise<string | null>((resolve) => {
      execFile(openssl, args, { windowsHide: true, timeout: 30_000 }, (err) => resolve(err ? `OpenSSL could not create the loopback certificate (${err.message.split('\n')[0].slice(0, 120)}).` : null));
    });
    if (failure) return failure;
    this.audit(`created a new loopback certificate (valid ${CERT_DAYS} days)`);
    return null;
  }

  private async waitForPort(port: number, ms: number): Promise<boolean> {
    const end = this.now() + ms;
    for (;;) {
      if (!(await this.portFree(port))) return true;
      if (this.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private async startPart(part: Supervised, cfg: ConnectorConfig): Promise<boolean> {
    if (!this.desired || part.child) return Boolean(part.child);
    const ports = part.name === 'gateway' ? [cfg.gatewayPort, cfg.tlsPort] : [cfg.healthPort];
    for (const port of ports) {
      if (!(await this.portFree(port))) {
        const msg = `Port ${port} is already in use, so the ${part.name} was not started (Pandesh does not stop programs it did not start).`;
        this.lastError = msg; part.failed = msg; this.audit(msg);
        return false;
      }
    }
    let command: string; let args: string[]; const env = reducedEnvironment();
    if (part.name === 'gateway') {
      command = this.deps.nodePath;
      args = [cfg.gatewayPath];
      if (this.deps.nodeIsElectron) env.ELECTRON_RUN_AS_NODE = '1';
      Object.assign(env, { PANDESH_DATA_DIR: this.deps.dataDir, PANDESH_MCP_PORT: String(cfg.gatewayPort), PANDESH_MCP_TLS_PORT: String(cfg.tlsPort), PANDESH_MCP_TLS_DIR: this.tlsDir() });
    } else {
      const key = await this.deps.getKey().catch(() => null);
      if (!key) { this.lastError = 'The OpenAI tunnel key is not stored.'; part.failed = this.lastError; return false; }
      this.keyForRedaction = key;
      command = cfg.clientPath;
      args = ['run', '--control-plane.tunnel-id', cfg.tunnelId, '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--ca-bundle', this.certPath(), '--mcp.server-url', `url=https://127.0.0.1:${cfg.tlsPort}/mcp`, '--harpoon.oauth-forward-origin', `https://127.0.0.1:${cfg.tlsPort}`, '--health.listen-addr', `127.0.0.1:${cfg.healthPort}`];
      env.CONTROL_PLANE_API_KEY = key;
    }
    const child = this.spawnFn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    part.child = child;
    const pipe = (stream: NodeJS.ReadableStream | null) => stream?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) this.audit(`${part.name}: ${line.trim().slice(0, 300)}`);
    });
    pipe(child.stdout); pipe(child.stderr);
    child.once('error', (err) => { this.audit(`${part.name} could not start: ${err.message}`); this.lastError = `The ${part.name} could not start.`; });
    child.once('exit', (code, signal) => {
      part.child = undefined;
      this.audit(`${part.name} exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
      if (this.desired) this.scheduleRestart(part, cfg);
    });
    this.audit(`${part.name} started (pid ${child.pid ?? '?'})`);
    return true;
  }

  private scheduleRestart(part: Supervised, cfg: ConnectorConfig): void {
    const now = this.now();
    part.crashes = part.crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (part.crashes.length > MAX_CRASHES) {
      part.failed = `The ${part.name} stopped ${MAX_CRASHES} times in 10 minutes, so Pandesh stopped restarting it.`;
      this.lastError = part.failed; this.audit(part.failed);
      return;
    }
    const delay = Math.min(60_000, 2000 * 2 ** (part.crashes.length - 1));
    this.audit(`restarting ${part.name} in ${Math.round(delay / 1000)} s`);
    part.retry = setTimeout(() => { part.retry = undefined; void this.startPart(part, this.config()); }, delay);
    part.retry.unref?.();
    void cfg;
  }

  /**
   * Health watchdog: a process that is alive but not answering (a hung tunnel after a network change, a wedged gateway) is
   * ended after 3 missed checks, and the normal bounded-restart path brings it back. Never touches a process it did not start.
   */
  private startWatchdog(): void {
    const every = this.deps.watchdogMs ?? 30_000;
    if (!every || this.watchdog) return;
    this.watchdog = setInterval(() => { void this.watchdogTick(); }, every);
    this.watchdog.unref?.();
  }

  async watchdogTick(): Promise<void> {
    if (!this.desired) return;
    const cfg = this.config();
    const probes: Array<['gateway' | 'tunnel', string]> = [['gateway', `http://127.0.0.1:${cfg.gatewayPort}/healthz`], ['tunnel', `http://127.0.0.1:${cfg.healthPort}/api/status`]];
    for (const [name, url] of probes) {
      const part = this.parts[name];
      if (!part.child) { this.strikes[name] = 0; continue; }
      let ok = false;
      try { ok = (await this.fetchFn(url, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* missed */ }
      this.strikes[name] = ok ? 0 : this.strikes[name] + 1;
      if (this.strikes[name] >= 3) {
        this.strikes[name] = 0;
        this.audit(`${name} stopped answering health checks; ending it so it restarts`);
        try { part.child.kill(); } catch { /* already gone */ }
      }
    }
  }

  /** Stops only the processes this supervisor started. */
  async stop(reason: string): Promise<void> {
    this.desired = false;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; }
    for (const part of [this.parts.tunnel, this.parts.gateway]) {
      if (part.retry) { clearTimeout(part.retry); part.retry = undefined; }
      const child = part.child;
      if (!child) continue;
      part.child = undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill(); } catch { clearTimeout(timer); resolve(); }
      });
      this.audit(`${part.name} stopped (${reason})`);
    }
    this.keyForRedaction = '';
  }

  // ── Core calls (host token: only Pandesh itself may create pairing codes or revoke pairings) ──────────

  private async core(method: string, route: string, body?: unknown): Promise<any> {
    const { dataDir } = this.deps;
    const port = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8')).port;
    const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
    const hostToken = fs.readFileSync(path.join(dataDir, 'host.token'), 'utf8').trim();
    const res = await this.fetchFn(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Host-Token': hostToken, 'Content-Type': 'application/json', 'X-Client-Id': 'desktop-chatgpt-connector' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Pandesh Core refused (${res.status})`);
    return json;
  }

  /** A one-time code the person types on the ChatGPT consent page. Shown only in the Pandesh window. */
  async newPairingCode(): Promise<{ code: string; expiresAt: string }> {
    if (!this.desired) throw new Error('Switch the ChatGPT connector on first.');
    const r = await this.core('POST', '/v1/bridge/pairing-codes', {});
    this.audit('a pairing code was created in the Pandesh window');
    return { code: String(r.code), expiresAt: String(r.expiresAt) };
  }

  private async chatgptPairings(): Promise<Array<{ id: string; label: string }>> {
    const r = await this.core('GET', '/v1/bridge/pairings');
    const list: any[] = Array.isArray(r) ? r : Array.isArray(r?.pairings) ? r.pairings : [];
    return list
      .filter((p) => !p.revokedAt && p.status !== 'revoked' && String(p.label ?? '').startsWith(CONNECTOR_PAIRING_LABEL_PREFIX))
      .map((p) => ({ id: String(p.id ?? p.pairingId), label: String(p.label) }));
  }

  /** Revokes every ChatGPT pairing, then stops the connector and switches it off. */
  async disconnect(): Promise<{ revoked: number; errors: number }> {
    let revoked = 0; let errors = 0;
    try {
      for (const p of await this.chatgptPairings()) {
        try { await this.core('POST', `/v1/bridge/pairings/${encodeURIComponent(p.id)}/revoke`, {}); revoked++; } catch { errors++; }
      }
    } catch { errors++; }
    this.audit(`disconnect: ${revoked} pairing(s) revoked, ${errors} error(s)`);
    await this.disable();
    return { revoked, errors };
  }

  // ── status ─────────────────────────────────────────────────────────────────────────────────

  async status(): Promise<ConnectorStatus> {
    const cfg = this.config();
    const key = await this.deps.getKey().catch(() => null);
    const gatewayRunning = Boolean(this.parts.gateway.child);
    const tunnelRunning = Boolean(this.parts.tunnel.child);
    let tunnelReachable = false;
    if (tunnelRunning) {
      try { tunnelReachable = (await this.fetchFn(`http://127.0.0.1:${cfg.healthPort}/api/status`, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* not up yet */ }
    }
    let activePairings = 0;
    if (this.desired) { try { activePairings = (await this.chatgptPairings()).length; } catch { /* Core not ready */ } }
    const failed = this.parts.gateway.failed ?? this.parts.tunnel.failed;
    let state: ConnectorState; let detail: string;
    if (!cfg.enabled) { state = 'off'; detail = 'The ChatGPT connector is off. ChatGPT cannot reach Pandesh.'; }
    else if (!cfg.tunnelId || !cfg.clientPath || !cfg.gatewayPath) { state = 'needs-setup'; detail = this.lastError ?? 'Finish setup: tunnel id and program paths.'; }
    else if (!key) { state = 'needs-key'; detail = 'Store the OpenAI tunnel key to start the connector.'; }
    else if (failed) { state = 'failed'; detail = failed; }
    else if (this.desired && gatewayRunning && tunnelRunning && tunnelReachable) { state = 'running'; detail = activePairings > 0 ? `Connected. ${activePairings} ChatGPT pairing(s) active.` : 'Running. Create a pairing code to connect ChatGPT.'; }
    else if (this.desired && (gatewayRunning || tunnelRunning)) { state = gatewayRunning && tunnelRunning ? 'starting' : 'degraded'; detail = state === 'starting' ? 'Starting…' : 'One part is restarting.'; }
    else { state = 'failed'; detail = this.lastError ?? 'The connector is switched on but not running.'; }
    const core = await this.coreView();
    if (state === 'running' && !core.reachable) { state = 'degraded'; detail = 'The tunnel is up, but this Pandesh\'s Core is not answering, so ChatGPT tasks would fail.'; }
    return { state, detail, enabled: cfg.enabled, keyConfigured: Boolean(key), keyHint: key ? maskedKeyHint(key) : null, tunnelId: cfg.tunnelId, gatewayRunning, tunnelRunning, tunnelReachable, activePairings, lastError: this.lastError, lastFailure: this.lastFailure, core, recentLog: this.lastLines.slice(-12) };
  }

  private async coreView(): Promise<ConnectorStatus['core']> {
    const base = { profile: this.deps.dataDir, production: Boolean(this.deps.isProductionProfile), build: this.deps.buildLabel ?? null };
    try {
      const port = JSON.parse(fs.readFileSync(path.join(this.deps.dataDir, 'core.json'), 'utf8')).port as number;
      const ok = (await this.fetchFn(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok;
      return { ...base, reachable: ok, port };
    } catch {
      return { ...base, reachable: false, port: null };
    }
  }
}
