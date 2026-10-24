/**
 * Google Workspace CLI (`gws`, https://github.com/googleworkspace/cli) as a
 * pinned, allowlisted transport behind the Jarvis Connector Foundation
 * (`connectorCapability.ts`). This module owns exactly one thing: invoking a
 * digest-verified `gws` binary as a short-lived child process with a fully
 * constructed environment (no inherited `process.env`, no PATH lookup) and
 * returning its structured JSON. It does not decide *which* gws commands are
 * reachable — each connector-specific adapter (e.g. `gwsGmailAdapter.ts`)
 * owns its own static allowlist and never forwards caller-controlled service/
 * resource/method strings into this transport.
 *
 * Feasibility checkpoint evidence for this design lives in
 * [AI_OS_ARCHITECTURE.md](../../../AI_OS_ARCHITECTURE.md) "Google Workspace
 * CLI (`gws`) as connector transport".
 *
 * Security invariants this module enforces:
 * - The binary path is never discovered via PATH; it is read from an
 *   explicit env var and must exist at that exact path.
 * - The binary's SHA-256 digest is verified against a pinned constant before
 *   every invocation (cheap relative to any network round trip this process
 *   makes) — a changed executable fails closed with a non-secret reason.
 * - The access token is passed only via `GOOGLE_WORKSPACE_CLI_TOKEN` in a
 *   from-scratch child environment; it is never placed in argv and the
 *   caller's `process.env` is never spread into the child.
 * - Cancellation kills the whole process tree (mirrors `toolRunner.ts`'s
 *   `runCommand` — Node's `spawn({ signal })` only reaches the immediate
 *   child, not any descendant `gws` itself launches).
 */
import { spawn, spawnSync } from 'node:child_process';
import { LocalAutonomySecurityKernel } from '../../security/kernel';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/** Pinned release identity. Update both together after re-running the
 * feasibility checkpoint's digest verification against the new release. */
export const GWS_PINNED_VERSION = '0.22.5';
// SHA-256 of the extracted gws.exe, derived from the separately pinned and
// verified release ZIP. The archive digest is owned by fetch-gws.mjs; runtime
// verification must compare the executable bytes it actually launches.
export const GWS_PINNED_SHA256_WINDOWS_X64 = '82ad48dd28564be969174aaef3e3f99816f959bf2519eeeb4ab77d84f9fa9c67';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 200_000;

/** Env var an operator sets to the absolute path of the staged `gws`
 * executable. Deliberately not a PATH lookup and not a set of well-known
 * install-directory candidates (contrast `resolveHostBrowserBin.ts`) — a
 * connector transport that can silently pick up *some* `gws` it finds is
 * exactly the ambient-trust shape this design avoids. */
export const GWS_BIN_ENV_VAR = 'KARKEDIKHA_GWS_BIN';

export function resolveGwsBinaryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[GWS_BIN_ENV_VAR]?.trim();
  return explicit ? explicit : null;
}

export type GwsBinaryCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Verifies the staged binary exists and its SHA-256 matches exactly. Reads
 * the file fresh every call (no caching) so a digest changed after process
 * start — a swapped executable, a tampered install directory — is caught on
 * the very next invocation, not only at startup. */
export function verifyPinnedBinary(binaryPath: string, expectedSha256: string): GwsBinaryCheck {
  if (!fs.existsSync(binaryPath)) {
    return { ok: false, reason: `gws binary not found at '${binaryPath}'` };
  }
  let digest: string;
  try {
    digest = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
  } catch (err) {
    return { ok: false, reason: `could not read gws binary at '${binaryPath}': ${err instanceof Error ? err.message : String(err)}` };
  }
  if (digest.toLowerCase() !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      reason: `gws binary digest mismatch at '${binaryPath}' (expected ${expectedSha256}) — refusing to run an unpinned executable`,
    };
  }
  return { ok: true, path: binaryPath };
}

export interface RunGwsInput {
  binaryPath: string;
  /** Full argv after the binary, e.g. ['gmail','users','messages','list','--params','{...}']. */
  args: string[];
  /** Short-lived OAuth2 access token. Jarvis/Desktop owns the refresh token in
   * Electron `safeStorage`; only the minted access token ever reaches this
   * process boundary. */
  accessToken: string;
  /** Directory for gws's own non-secret Discovery-schema cache. Never used
   * for credentials — auth is env-var only, so gws's keyring/login storage
   * is never touched. */
  configDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunGwsResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Builds the child process environment entirely from scratch. Deliberately
 * does not spread `process.env` — Core's own environment (Ollama endpoints,
 * other connectors' credential env vars, etc.) must never be reachable by a
 * `gws` invocation. Only the Windows values a network-capable process needs
 * to resolve DNS/TLS are included. */
function buildConstructedEnv(input: { accessToken: string; configDir: string }): NodeJS.ProcessEnv {
  return {
    GOOGLE_WORKSPACE_CLI_TOKEN: input.accessToken,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: input.configDir,
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    windir: process.env.windir ?? 'C:\\Windows',
    SystemDrive: process.env.SystemDrive ?? 'C:',
  };
}

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

/** Spawns the pinned `gws` binary by absolute path only (never through a
 * shell, never via PATH), with a from-scratch environment, and kills the
 * whole process tree on abort or timeout — the same pattern
 * `toolRunner.ts`'s `runCommand` uses for the identical reason: Node's
 * `spawn({ signal })` and `child.kill()` only reach the immediate process,
 * not any descendant `gws` itself launches. */
export function runGws(input: RunGwsInput): Promise<RunGwsResult> {
  return new Promise((resolve) => {
    const env = buildConstructedEnv({ accessToken: input.accessToken, configDir: input.configDir });
    fs.mkdirSync(input.configDir, { recursive: true });
    const child = spawn(input.binaryPath, input.args, {
      env,
      windowsHide: true,
      // No shell: argv is passed as a real argv array to the OS, so nothing
      // in a caller-supplied JSON string can be interpreted as shell syntax.
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    let settled = false;
    let aborted = false;
    let timedOut = false;

    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // taskkill can itself hang under a restricted Windows token. Bound it,
        // then terminate the immediate child as a fallback so cancellation
        // never waits for the model/tool timeout indefinitely.
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            timeout: 2_000,
            stdio: 'ignore',
          });
        } catch { /* best-effort */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      }
    };

    const onAbort = () => { aborted = true; killTree(); };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (result: Omit<RunGwsResult, 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ ...result, stdout: bound(stdout), stderr: bound(stderr) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    if (input.signal?.aborted) onAbort();

    child.on('error', (err) => {
      // ENOENT (missing binary), EACCES, etc. — never thrown, always a
      // structured failure so a caller can fail closed with a clear reason.
      stderr += `\nspawn error: ${err.message}`;
      finish({ exitCode: null, timedOut, aborted });
    });
    child.on('close', (code) => finish({ exitCode: code, timedOut, aborted }));
  });
}

export type GwsJsonResult = { ok: true; data: unknown } | { ok: false; reason: string };

/** `gws --format json` (the default) prints exactly one JSON document to
 * stdout, success or error shaped `{ "error": { code, message, reason } }`.
 * Malformed/empty output is treated as a transport failure, never guessed
 * at or partially trusted. */
export function parseGwsJson(stdout: string): GwsJsonResult {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, reason: 'gws produced no output' };
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, reason: `gws produced malformed JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}
