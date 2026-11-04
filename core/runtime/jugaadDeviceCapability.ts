import { execFile } from 'node:child_process';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';

export interface AdbResult { ok: boolean; stdout: string; stderr: string }
export type AdbRunner = (args: string[]) => Promise<AdbResult>;

export interface JugaadDeviceCapabilityOptions {
  /** Defaults to JUGAAD_ADB_SERIAL. Required: with several devices attached the adapter never guesses. */
  serial?: string;
  /** Pairing token the user minted in JUGAAD → Config. Defaults to JUGAAD_BRIDGE_TOKEN. Never accepted as a tool argument. */
  token?: string;
  adbPath?: string;
  packageName?: string;
  runAdb?: AdbRunner;
}

const READ_ONLY_TOOLS = new Set([
  'jugaad_status', 'jugaad_pulse', 'jugaad_expenses', 'jugaad_vault', 'jugaad_ui_read',
]);

const SERIAL_RE = /^[A-Za-z0-9._:-]{3,64}$/;

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function defaultRunner(adbPath: string): AdbRunner {
  return (args) => new Promise((resolve) => {
    execFile(adbPath, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err?.message || '') });
    });
  });
}

/** `content call` prints `Result: Bundle[{json=<payload>}]`; the payload may itself contain braces. */
export function parseBridgeReply(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('json=');
  const end = stdout.lastIndexOf('}]');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start + 5, end));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** Extracts visible text (with bounds) from a `uiautomator dump`. Read-only view of what is on screen. */
export function visibleTextFromDump(xml: string): string[] {
  const out: string[] = [];
  const unescape = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="(\[[^"]+\])"/g)) {
    const label = unescape(m[1] || m[2]).trim();
    if (label) out.push(`${m[3]} ${label}`);
  }
  return out;
}

/**
 * JUGAAD (Android household app) as a governed Pandesh capability, reached through authorized ADB to
 * one named device. Two layers:
 *  - the app's own read-only bridge (content provider, user-enabled, token-gated) for status, expenses,
 *    vault metadata and Household Pulse — the encrypted database is never copied or opened;
 *  - UI inspection/navigation via uiautomator and input. Reading the screen is read-only; taps are
 *    consequential and so go through the existing mutation approval gate.
 */
export function createJugaadDeviceCapabilityAdapter(options: JugaadDeviceCapabilityOptions = {}): GovernedCapabilityAdapter {
  const adb = options.runAdb ?? defaultRunner(options.adbPath ?? process.env.ADB_PATH ?? 'adb');
  const pkg = options.packageName ?? 'com.jugaad.home';
  const uri = `content://${pkg}.pandesh`;
  const serial = () => options.serial ?? process.env.JUGAAD_ADB_SERIAL ?? '';
  const token = () => options.token ?? process.env.JUGAAD_BRIDGE_TOKEN ?? '';

  function target(): { serial: string } | ToolExecutionResult {
    const s = serial().trim();
    if (!s) return failure('JUGAAD_ADB_SERIAL is not set; refusing to guess which attached device to use', 'device_not_selected');
    if (!SERIAL_RE.test(s)) return failure('device serial has an unexpected format', 'invalid_arguments');
    return { serial: s };
  }
  const isFailure = (v: { serial: string } | ToolExecutionResult): v is ToolExecutionResult => 'status' in v;

  async function bridge(method: string, extras: Record<string, string> = {}, withToken = true): Promise<ToolExecutionResult> {
    const t = target();
    if (isFailure(t)) return t;
    if (withToken && !token()) {
      return failure('No JUGAAD pairing token configured. In JUGAAD → Config → Pandesh Access tap Enable and set JUGAAD_BRIDGE_TOKEN.', 'authorization_required');
    }
    const args = ['-s', t.serial, 'shell', 'content', 'call', '--uri', uri, '--method', method];
    if (withToken) args.push('--arg', token());
    for (const [k, v] of Object.entries(extras)) args.push('--extra', `${k}:s:${v}`);
    const res = await adb(args);
    if (!res.ok) return failure(`adb failed: ${res.stderr.slice(0, 300)}`, 'adb_failed');
    const reply = parseBridgeReply(res.stdout);
    if (!reply) return failure('JUGAAD bridge returned no parsable reply (is the app installed with the bridge?)', 'bridge_unreachable');
    if (reply.ok === false) {
      const code = String(reply.error ?? 'error');
      const cat = code === 'unauthorized' || code === 'bridge_disabled' ? 'authorization_required' : 'bridge_error';
      return failure(`JUGAAD bridge refused: ${code}`, cat);
    }
    return { status: 'succeeded', exitCode: 0, output: JSON.stringify(reply, null, 2), resultCategory: `jugaad_${method}` };
  }

  async function uiRead(): Promise<ToolExecutionResult> {
    const t = target();
    if (isFailure(t)) return t;
    const dump = await adb(['-s', t.serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty']);
    if (!dump.ok) return failure(`uiautomator dump failed: ${dump.stderr.slice(0, 300)}`, 'adb_failed');
    const lines = visibleTextFromDump(dump.stdout);
    if (!lines.length) return failure('no visible text found (screen locked or app not in foreground?)', 'ui_empty');
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n'), resultCategory: 'jugaad_ui_read' };
  }

  async function input(args: string[], category: string): Promise<ToolExecutionResult> {
    const t = target();
    if (isFailure(t)) return t;
    const res = await adb(['-s', t.serial, 'shell', 'input', ...args]);
    if (!res.ok) return failure(`adb input failed: ${res.stderr.slice(0, 300)}`, 'adb_failed');
    return { status: 'succeeded', exitCode: 0, output: 'done', resultCategory: category };
  }

  const coord = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : null);

  return {
    id: 'jugaad-device',
    definitions: () => [
      { name: 'jugaad_status', description: 'Report whether the JUGAAD app bridge on the selected phone is enabled and whether Pandesh is authorized. Read-only; reveals no private data.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'jugaad_pulse', description: 'Household Pulse exactly as JUGAAD last computed it (status, headline, projected surplus, top risk, savings suggestion). Needs the user-issued pairing token. Read-only.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'jugaad_expenses', description: 'Wallet transactions (title, category, amount, date, hasReceipt). Optional from/to ISO dates and limit (max 200). Needs the pairing token. Read-only.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
      { name: 'jugaad_vault', description: 'Vault metadata only (counts by category and source, item list; no images, OCR text or paths). Optional sourceType (e.g. RECOVERED) and limit. Needs the pairing token. Read-only.', parameters: { type: 'object', properties: { sourceType: { type: 'string' }, limit: { type: 'number' } }, required: [] } },
      { name: 'jugaad_ui_read', description: 'Read the visible text and bounds of the JUGAAD screen currently on the phone. Read-only.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'jugaad_ui_tap', description: 'Tap screen coordinates on the phone to navigate JUGAAD. Can change app state, so it needs approval.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
      { name: 'jugaad_ui_swipe', description: 'Swipe between two points on the phone (scrolling). Needs approval.', parameters: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
      { name: 'jugaad_ui_back', description: 'Press the Android Back key on the phone. Needs approval.', parameters: { type: 'object', properties: {}, required: [] } },
    ],
    classify: (toolName) => (READ_ONLY_TOOLS.has(toolName) ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call: ModelToolCall) => {
      const a = call.arguments ?? {};
      switch (call.name) {
        case 'jugaad_status': return bridge('status', {}, false).then(async (r) => {
          if (r.status !== 'succeeded' || !token()) return r;
          // Fold token validity into the status report without exposing the token.
          const authed = await bridge('status');
          return authed.status === 'succeeded' ? { ...r, output: authed.output } : r;
        });
        case 'jugaad_pulse': return bridge('pulse');
        case 'jugaad_expenses': {
          const extras: Record<string, string> = {};
          for (const k of ['from', 'to'] as const) {
            const v = a[k];
            if (typeof v === 'string') {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return failure(`${k} must be YYYY-MM-DD`, 'invalid_arguments');
              extras[k] = v;
            }
          }
          if (typeof a.limit === 'number') extras.limit = String(Math.trunc(a.limit));
          return bridge('expenses', extras);
        }
        case 'jugaad_vault': {
          const extras: Record<string, string> = {};
          if (typeof a.sourceType === 'string') {
            if (!/^[A-Z_]{2,24}$/.test(a.sourceType)) return failure('sourceType must be an upper-case code such as RECOVERED', 'invalid_arguments');
            extras.sourceType = a.sourceType;
          }
          if (typeof a.limit === 'number') extras.limit = String(Math.trunc(a.limit));
          return bridge('vault', extras);
        }
        case 'jugaad_ui_read': return uiRead();
        case 'jugaad_ui_tap': {
          const x = coord(a.x), y = coord(a.y);
          if (x === null || y === null) return failure('x and y must be non-negative integers', 'invalid_arguments');
          return input(['tap', String(x), String(y)], 'jugaad_ui_tap');
        }
        case 'jugaad_ui_swipe': {
          const v = [a.x1, a.y1, a.x2, a.y2].map(coord);
          if (v.some((n) => n === null)) return failure('x1,y1,x2,y2 must be non-negative integers', 'invalid_arguments');
          return input(['swipe', ...v.map(String), '400'], 'jugaad_ui_swipe');
        }
        case 'jugaad_ui_back': return input(['keyevent', '4'], 'jugaad_ui_back');
        default: return failure(`unknown tool '${call.name}'`, 'invalid_arguments');
      }
    },
  };
}
