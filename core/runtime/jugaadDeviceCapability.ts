import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CapabilityHealth, GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';

/**
 * JUGAAD device bridge — a thin, READ-ONLY ADB client of the JUGAAD Android app's
 * `PandeshBridgeProvider` (authority `com.jugaad.home.pandesh`).
 *
 * Provider contract (household-platform b749dc8): `ContentResolver.call(uri, method, token, extras)`
 * replies with one `json` string. Methods `status` (token optional), `pulse`, `expenses`
 * (extras limit/from/to), `vault` (extras limit/sourceType). No mutating method exists.
 *
 * The pairing token is held in memory only (pushed by the Desktop host, which owns the
 * DPAPI-encrypted copy). It is delivered to the phone through the `adb shell` STDIN so it never
 * appears on a host command line, and it is stripped from everything this module returns.
 */

export const JUGAAD_PACKAGE = 'com.jugaad.home';
export const JUGAAD_PROVIDER_URI = `content://${JUGAAD_PACKAGE}.pandesh`;

const ADB_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 8000;
/** Hex, base64url and similar. Deliberately excludes every shell metacharacter and whitespace. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const SERIAL_SHAPE = /^[A-Za-z0-9._:-]{1,64}$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_TYPE_SHAPE = /^[A-Z_]{1,24}$/;

export interface AdbRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type AdbRunner = (args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<AdbRunResult>;

export function resolveAdbBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.KARKEDIKHA_ADB_BIN?.trim();
  if (explicit) return explicit;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined]) {
    if (!root) continue;
    const candidate = path.join(root, 'platform-tools', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'adb';
}

export function createSpawnAdbRunner(adbBin: string = resolveAdbBinary()): AdbRunner {
  return (args, opts = {}) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const child = spawn(adbBin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs ?? ADB_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (stdout.length < 200_000) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < 20_000) stderr += d.toString('utf8'); });
    child.on('error', (err) => { stderr += `${(err as NodeJS.ErrnoException).code ?? 'spawn_error'}`; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* adb exited before reading stdin */ });
    child.stdin.end(opts.stdin ?? '');
  });
}

export interface AdbDevice {
  serial: string;
  state: string;
  model: string | null;
  product: string | null;
  /** True for `emulator-*` serials, so the UI can keep a phone from being confused with an AVD. */
  emulator: boolean;
}

/** Parses `adb devices -l`. Pure; tested directly. */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|unauthorized|offline|no permissions\S*|authorizing)\b(.*)$/.exec(line.trim());
    if (!match) continue;
    const rest = match[3] ?? '';
    const field = (name: string) => new RegExp(`\\b${name}:(\\S+)`).exec(rest)?.[1] ?? null;
    devices.push({
      serial: match[1],
      state: match[2],
      model: field('model')?.replace(/_/g, ' ') ?? null,
      product: field('product'),
      emulator: match[1].startsWith('emulator-'),
    });
  }
  return devices;
}

export type JugaadBridgeReply = { ok: boolean; error?: string; [key: string]: unknown };

/** Parses the `content call` stdout `Result: Bundle[{json={...}}]`. Returns null when it is not a bridge reply. */
export function parseContentCallReply(stdout: string): JugaadBridgeReply | null {
  const match = /Bundle\[\{json=([\s\S]*)\}\]\s*$/.exec(stdout.trim());
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JugaadBridgeReply : null;
  } catch {
    return null;
  }
}

export interface JugaadVerification {
  connected: boolean;
  /** Stable machine reason when not connected. Never contains the token. */
  reason?: 'no_session' | 'adb_unavailable' | 'device_offline' | 'bridge_not_installed' | 'bridge_disabled' | 'token_rejected' | 'bridge_error';
  detail?: string;
  bridgeEnabled?: boolean;
  authorizedCalls?: number;
  app?: string;
}

type CallOutcome =
  | { kind: 'reply'; reply: JugaadBridgeReply }
  | { kind: 'failure'; reason: NonNullable<JugaadVerification['reason']>; detail: string };

function failureOutput(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(200, Math.max(1, Math.trunc(n))) : fallback;
}

export interface JugaadBridge {
  readonly adapter: GovernedCapabilityAdapter;
  listDevices(): Promise<{ devices: AdbDevice[]; error?: string }>;
  /** Stores serial + token in memory and verifies via `status`. A failed verification clears the session again. */
  connect(serial: string, token: string): Promise<JugaadVerification>;
  /** Re-verifies the current session through `status`. */
  verify(): Promise<JugaadVerification>;
  /** Erases Core's in-memory token. Does NOT revoke anything inside JUGAAD. */
  disconnect(): void;
  /** Non-secret summary. */
  session(): { present: boolean; serial: string | null };
}

export function createJugaadBridge(options: { runner?: AdbRunner } = {}): JugaadBridge {
  const run: AdbRunner = options.runner ?? createSpawnAdbRunner();
  let current: { serial: string; token: string } | null = null;
  let rejected = false;

  /** One provider call. The token travels on adb's stdin, never in an argv. */
  async function call(method: 'status' | 'pulse' | 'expenses' | 'vault', extras: Record<string, string> = {}, creds = current): Promise<CallOutcome> {
    if (!creds) return { kind: 'failure', reason: 'no_session', detail: 'JUGAAD is not connected' };
    const extraArgs = Object.entries(extras).map(([k, v]) => `--extra ${k}:s:${v}`).join(' ');
    const script = `content call --uri ${JUGAAD_PROVIDER_URI} --method ${method} --arg ${creds.token}${extraArgs ? ` ${extraArgs}` : ''}\nexit\n`;
    const result = await run(['-s', creds.serial, 'shell', '-T'], { stdin: script });
    const clean = (s: string) => s.split(creds.token).join('[redacted]');
    if (result.timedOut) return { kind: 'failure', reason: 'device_offline', detail: 'adb timed out talking to the device' };
    const combined = `${result.stdout}\n${result.stderr}`;
    const reply = parseContentCallReply(result.stdout);
    if (reply) return { kind: 'reply', reply };
    if (/device .* not found|device offline|no devices|unauthorized|more than one device/i.test(combined)) {
      return { kind: 'failure', reason: 'device_offline', detail: bound(clean(combined).trim()) };
    }
    if (/ENOENT|not recognized|cannot find|spawn_error/i.test(combined) && result.code === null) {
      return { kind: 'failure', reason: 'adb_unavailable', detail: 'adb could not be started' };
    }
    if (/unknown url|no content provider|unable to find|could not find provider|permission denial/i.test(combined)) {
      return { kind: 'failure', reason: 'bridge_not_installed', detail: 'the JUGAAD app on this device does not expose the Pandesh bridge' };
    }
    return { kind: 'failure', reason: 'bridge_error', detail: bound(clean(combined).trim()) || 'no reply from the bridge' };
  }

  async function verifyWith(creds: { serial: string; token: string } | null): Promise<JugaadVerification> {
    const outcome = await call('status', {}, creds);
    if (outcome.kind === 'failure') return { connected: false, reason: outcome.reason, detail: outcome.detail };
    const r = outcome.reply;
    const base = { bridgeEnabled: r.bridgeEnabled === true, authorizedCalls: typeof r.authorizedCalls === 'number' ? r.authorizedCalls : undefined, app: typeof r.app === 'string' ? r.app : undefined };
    if (r.bridgeEnabled !== true) return { connected: false, reason: 'bridge_disabled', detail: 'the bridge is switched off in JUGAAD (Config → generate a token)', ...base };
    if (r.authorized !== true) return { connected: false, reason: 'token_rejected', detail: 'JUGAAD rejected this token (wrong, rotated or revoked in JUGAAD)', ...base };
    return { connected: true, ...base };
  }

  async function execute(call_: ModelToolCall): Promise<ToolExecutionResult> {
    const args = call_.arguments ?? {};
    if (!current) return failureOutput('JUGAAD is not connected. Pair the phone in Settings → Integrations → JUGAAD.', 'jugaad_not_connected');

    if (call_.name === 'jugaad_status') {
      const v = await verifyWith(current);
      if (!v.connected && v.reason === 'token_rejected') rejected = true;
      return {
        status: v.connected ? 'succeeded' : 'failed', exitCode: v.connected ? 0 : null,
        output: JSON.stringify({ connected: v.connected, device: current.serial, ...(v.reason ? { reason: v.reason, detail: v.detail } : {}), authorizedCalls: v.authorizedCalls }),
        resultCategory: v.connected ? 'jugaad_status' : `jugaad_${v.reason}`, normalizedArguments: {},
      };
    }

    let method: 'pulse' | 'expenses' | 'vault';
    const extras: Record<string, string> = {};
    const normalized: Record<string, unknown> = {};
    if (call_.name === 'jugaad_pulse') {
      method = 'pulse';
    } else if (call_.name === 'jugaad_expenses') {
      method = 'expenses';
      extras.limit = String(clampLimit(args.limit, 200)); normalized.limit = Number(extras.limit);
      const from = args.from, to = args.to;
      if ((from === undefined) !== (to === undefined)) return failureOutput('from and to must be given together (YYYY-MM-DD)', 'invalid_arguments');
      if (from !== undefined) {
        if (typeof from !== 'string' || typeof to !== 'string' || !DATE_SHAPE.test(from) || !DATE_SHAPE.test(to)) return failureOutput('from and to must be YYYY-MM-DD dates', 'invalid_arguments');
        extras.from = from; extras.to = to; normalized.from = from; normalized.to = to;
      }
    } else if (call_.name === 'jugaad_vault') {
      method = 'vault';
      extras.limit = String(clampLimit(args.limit, 50)); normalized.limit = Number(extras.limit);
      if (args.sourceType !== undefined) {
        if (typeof args.sourceType !== 'string' || !SOURCE_TYPE_SHAPE.test(args.sourceType)) return failureOutput('sourceType must be an upper-case code such as RECOVERED', 'invalid_arguments');
        extras.sourceType = args.sourceType; normalized.sourceType = args.sourceType;
      }
    } else {
      return failureOutput(`unknown JUGAAD tool '${call_.name}'`, 'capability_unknown_tool');
    }

    const outcome = await call(method, extras);
    if (outcome.kind === 'failure') return failureOutput(outcome.detail, `jugaad_${outcome.reason}`);
    const reply = outcome.reply;
    if (reply.ok !== true) {
      const error = typeof reply.error === 'string' ? reply.error : 'bridge_error';
      if (error === 'unauthorized' || error === 'bridge_disabled') rejected = true;
      return failureOutput(`JUGAAD bridge refused the read: ${error}`, `jugaad_${error.split(':')[0]}`);
    }
    rejected = false;
    return { status: 'succeeded', exitCode: 0, output: bound(JSON.stringify(summarize(method, reply))), resultCategory: `jugaad_${method}`, normalizedArguments: normalized };
  }

  const adapter: GovernedCapabilityAdapter = {
    id: 'jugaad',
    definitions: () => [
      { name: 'jugaad_status', description: 'Check whether the paired JUGAAD phone app is reachable and authorized. Read-only.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'jugaad_pulse', description: "Read the user's live Household Pulse from the paired JUGAAD phone (status, headline, projected spend, top risk, days left in cycle). Read-only; returns what the user sees on their Wallet screen. Never guess Pulse numbers without calling this.", parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'jugaad_expenses', description: "Read the user's expense transactions from the paired JUGAAD phone (title, category, amount, currency, date, whether a receipt is attached). Optional from/to as YYYY-MM-DD (both required together) and limit (1-200). The result includes a deterministic spend summary; report its `complete` flag honestly. Read-only.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
      { name: 'jugaad_vault', description: "Read document-Vault METADATA from the paired JUGAAD phone: counts by category and source type (including recovered receipts) plus a bounded list of entries (title, merchant, amount, category, status). Never returns document text or files. Optional sourceType filter such as RECOVERED and limit (1-200). Read-only.", parameters: { type: 'object', properties: { sourceType: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
    ],
    classify: () => 'read_only',
    health: (): CapabilityHealth => {
      const checkedAt = new Date().toISOString();
      if (!current) return { state: 'authorization_required', reason: 'JUGAAD is not paired', checkedAt };
      if (rejected) return { state: 'authorization_required', reason: 'JUGAAD rejected the token (rotated or revoked on the phone)', checkedAt };
      return { state: 'available', checkedAt };
    },
    run: execute,
  };

  return {
    adapter,
    async listDevices() {
      const result = await run(['devices', '-l'], { timeoutMs: 8_000 });
      if (result.code === null) return { devices: [], error: 'adb could not be started' };
      return { devices: parseAdbDevices(result.stdout) };
    },
    async connect(serial, token) {
      const cleanToken = token.trim();
      if (!SERIAL_SHAPE.test(serial)) return { connected: false, reason: 'device_offline', detail: 'select a device first' };
      if (!TOKEN_SHAPE.test(cleanToken)) return { connected: false, reason: 'token_rejected', detail: 'that does not look like a JUGAAD token (letters and digits only, 16-128 characters)' };
      const creds = { serial, token: cleanToken };
      const verification = await verifyWith(creds);
      if (verification.connected) { current = creds; rejected = false; } else { current = null; }
      return verification;
    },
    async verify() {
      if (!current) return { connected: false, reason: 'no_session' };
      const v = await verifyWith(current);
      rejected = !v.connected && v.reason === 'token_rejected';
      return v;
    },
    disconnect() { current = null; rejected = false; },
    session: () => ({ present: current !== null, serial: current?.serial ?? null }),
  };
}

/** Deterministic, evidence-safe reductions so a small model never has to do arithmetic. */
function summarize(method: 'pulse' | 'expenses' | 'vault', reply: JugaadBridgeReply): Record<string, unknown> {
  if (method === 'expenses') {
    const items = Array.isArray(reply.items) ? reply.items as Array<Record<string, unknown>> : [];
    const sums = new Map<string, number>();
    let counted = 0;
    for (const item of items) {
      if (item.excluded === true || typeof item.amount !== 'number') continue;
      const currency = typeof item.currency === 'string' ? item.currency : '?';
      sums.set(currency, Math.round(((sums.get(currency) ?? 0) + item.amount) * 100) / 100);
      counted += 1;
    }
    const total = typeof reply.total === 'number' ? reply.total : items.length;
    return {
      summary: {
        transactionsCounted: counted, excludedTransactions: items.length - counted,
        sumOfAmountsByCurrency: Object.fromEntries(sums),
        complete: items.length >= total,
        note: items.length >= total ? 'covers every matching transaction' : `PARTIAL: ${items.length} of ${total} transactions returned; narrow the date range for a complete figure`,
      },
      ...reply,
    };
  }
  if (method === 'vault') {
    const bySource = reply.bySourceType && typeof reply.bySourceType === 'object' ? reply.bySourceType as Record<string, unknown> : {};
    return { recoveredReceipts: typeof bySource.RECOVERED === 'number' ? bySource.RECOVERED : 0, ...reply };
  }
  return reply;
}

/** The one instance Core registers and its routes drive. Tests build their own with a fake runner. */
export const defaultJugaadBridge: JugaadBridge = createJugaadBridge();
