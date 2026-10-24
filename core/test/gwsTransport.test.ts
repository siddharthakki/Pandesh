/**
 * Focused tests for the pinned `gws` transport (feasibility checkpoint,
 * AI_OS_ARCHITECTURE.md "Google Workspace CLI (`gws`) as connector
 * transport"). These never invoke the real `gws` binary — CI has no
 * business fetching a third-party executable over the network — so a tiny
 * Node stub script stands in for "some external binary Core spawns by
 * absolute path", proving `runGws`'s env-construction, cancellation, and
 * JSON-parsing mechanics generically.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  parseGwsJson,
  resolveGwsBinaryPath,
  runGws,
  verifyPinnedBinary,
  GWS_BIN_ENV_VAR,
} from '../runtime/connectors/gwsTransport';

let dir: string;
let stubPath: string;
let configDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-transport-'));
  stubPath = path.join(dir, 'stub.js');
  configDir = path.join(dir, 'config');
  // A minimal stand-in for "some absolute-path executable Core spawns" —
  // reports back its own argv and the env it actually received so tests can
  // assert on exactly what crossed the process boundary.
  fs.writeFileSync(
    stubPath,
    `
    const mode = process.argv[2];
    if (mode === 'echo') {
      process.stdout.write(JSON.stringify({
        args: process.argv.slice(3),
        token: process.env.GOOGLE_WORKSPACE_CLI_TOKEN ?? null,
        leaked: process.env.SHOULD_NOT_LEAK ?? null,
        configDir: process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR ?? null,
      }));
      process.exit(0);
    } else if (mode === 'bad-json') {
      process.stdout.write('not actually json');
      process.exit(0);
    } else if (mode === 'sleep') {
      setTimeout(() => { process.stdout.write('{"ok":true}'); process.exit(0); }, Number(process.argv[3] ?? 5000));
    } else if (mode === 'error-exit') {
      process.stdout.write(JSON.stringify({ error: { code: 401, message: 'bad token', reason: 'authError' } }));
      process.exit(1);
    }
    `,
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[GWS_BIN_ENV_VAR];
  delete process.env.SHOULD_NOT_LEAK;
});

describe('resolveGwsBinaryPath', () => {
  it('never falls back to a PATH search or a well-known install directory — only the explicit env var', () => {
    expect(resolveGwsBinaryPath({})).toBeNull();
    expect(resolveGwsBinaryPath({ [GWS_BIN_ENV_VAR]: '  ' })).toBeNull();
    expect(resolveGwsBinaryPath({ [GWS_BIN_ENV_VAR]: 'C:\\tools\\gws\\gws.exe' })).toBe('C:\\tools\\gws\\gws.exe');
  });
});

describe('verifyPinnedBinary', () => {
  it('fails closed with a non-secret reason when the binary is missing', () => {
    const result = verifyPinnedBinary(path.join(dir, 'does-not-exist.exe'), 'a'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not found/);
  });

  it('fails closed when the digest does not match — a swapped/tampered executable is refused', () => {
    const result = verifyPinnedBinary(stubPath, 'f'.repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/digest mismatch/);
  });

  it('succeeds only when the SHA-256 matches exactly', () => {
    const actualDigest = crypto.createHash('sha256').update(fs.readFileSync(stubPath)).digest('hex');
    const result = verifyPinnedBinary(stubPath, actualDigest);
    expect(result.ok).toBe(true);
  });
});

describe('parseGwsJson', () => {
  it('fails closed on empty output', () => {
    const result = parseGwsJson('   ');
    expect(result.ok).toBe(false);
  });

  it('fails closed on malformed JSON without throwing', () => {
    const result = parseGwsJson('not actually json');
    expect(result.ok).toBe(false);
  });

  it('parses a well-formed document', () => {
    const result = parseGwsJson('{"messages":[]}');
    expect(result).toEqual({ ok: true, data: { messages: [] } });
  });
});

describe('runGws', () => {
  it('passes the access token only via GOOGLE_WORKSPACE_CLI_TOKEN and never inherits the caller process env', async () => {
    process.env.SHOULD_NOT_LEAK = 'ambient-secret-must-not-cross';
    const result = await runGws({
      binaryPath: process.execPath,
      args: [stubPath, 'echo'],
      accessToken: 'fake-access-token-for-test',
      configDir,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.token).toBe('fake-access-token-for-test');
    expect(parsed.leaked).toBeNull();
    expect(parsed.configDir).toBe(configDir);
    // The token must never appear in argv either.
    expect(result.stdout).not.toContain('SHOULD_NOT_LEAK');
  });

  it('creates the config dir if it does not exist yet', async () => {
    expect(fs.existsSync(configDir)).toBe(false);
    await runGws({ binaryPath: process.execPath, args: [stubPath, 'echo'], accessToken: 't', configDir });
    expect(fs.existsSync(configDir)).toBe(true);
  });

  it('reports a structured, non-throwing result for a missing binary (ENOENT)', async () => {
    const result = await runGws({
      binaryPath: path.join(dir, 'does-not-exist.exe'),
      args: [],
      accessToken: 't',
      configDir,
    });
    expect(result.exitCode).toBeNull();
    expect(result.aborted).toBe(false);
  });

  it('surfaces a non-zero exit code and its structured JSON error body unchanged', async () => {
    const result = await runGws({ binaryPath: process.execPath, args: [stubPath, 'error-exit'], accessToken: 't', configDir });
    expect(result.exitCode).toBe(1);
    const parsed = parseGwsJson(result.stdout);
    expect(parsed).toEqual({ ok: true, data: { error: { code: 401, message: 'bad token', reason: 'authError' } } });
  });

  it('kills the whole process tree on abort instead of waiting for the timeout', async () => {
    const controller = new AbortController();
    const promise = runGws({
      binaryPath: process.execPath,
      args: [stubPath, 'sleep', '30000'],
      accessToken: 't',
      configDir,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('kills the process on timeout when it runs longer than allowed', async () => {
    const result = await runGws({
      binaryPath: process.execPath,
      args: [stubPath, 'sleep', '30000'],
      accessToken: 't',
      configDir,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  }, 10_000);
});
