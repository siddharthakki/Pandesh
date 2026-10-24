import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { OpenCodeEngine, OpenCodeEngineAdapter, findOpenCodeExe, getFreePort } from '../runtime/opencodeEngine';
import { EngineRegistry } from '../runtime/adapters/EngineAdapter';

describe('OpenCodeEngine & EngineRegistry', () => {
  const testWorkspace = path.resolve('.tmp/opencode-test-workspace');

  afterAll(() => {
    OpenCodeEngine.stopServer(testWorkspace);
    try {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  it('locates opencode executable or falls back gracefully', () => {
    const exe = findOpenCodeExe();
    expect(exe).toBeDefined();
    expect(typeof exe).toBe('string');
    expect(exe.length).toBeGreaterThan(0);
  });

  it('allocates a free localhost TCP port', async () => {
    const port = await getFreePort(19000);
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it('registers OpenCode, Hermes, and OpenClaw in EngineRegistry', () => {
    const opencode = EngineRegistry.get('opencode');
    expect(opencode).toBeDefined();
    expect(opencode?.id).toBe('opencode');
    expect(opencode?.role).toBe('coding');

    const hermes = EngineRegistry.get('hermes');
    expect(hermes).toBeDefined();
    expect(hermes?.id).toBe('hermes');

    const openclaw = EngineRegistry.get('openclaw');
    expect(openclaw).toBeDefined();
    expect(openclaw?.id).toBe('openclaw');
  });

  it('handles execution gracefully when server is offline or invalid', async () => {
    const adapter = new OpenCodeEngineAdapter();
    const available = await adapter.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('starts server with randomized session credentials and enforces HTTP basic authentication', async () => {
    fs.mkdirSync(testWorkspace, { recursive: true });
    const serverInfo = await OpenCodeEngine.ensureServer(testWorkspace);

    expect(serverInfo.port).toBeGreaterThan(1024);
    expect(serverInfo.serverUrl).toBe(`http://127.0.0.1:${serverInfo.port}`);
    expect(serverInfo.password).toBeDefined();
    expect(serverInfo.password.length).toBe(64); // 32 bytes in hex

    // 1. Unauthenticated ping to /api/session must be rejected (401)
    const unauthPing = await fetch(`${serverInfo.serverUrl}/api/session`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(unauthPing.status).toBe(401);

    // 2. Authenticated ping with correct per-session credential must be accepted (200)
    const authPing = await fetch(`${serverInfo.serverUrl}/api/session`, {
      signal: AbortSignal.timeout(2000),
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${serverInfo.password}`).toString('base64')}`,
      },
    });
    expect(authPing.status).toBe(200);

    // 3. ensureServer reuses existing active server without spawning a new one
    const reused = await OpenCodeEngine.ensureServer(testWorkspace);
    expect(reused.port).toBe(serverInfo.port);
    expect(reused.password).toBe(serverInfo.password);

    // 4. stopServer terminates owned process safely
    OpenCodeEngine.stopServer(testWorkspace);

    // Give process 200ms to exit
    await new Promise((r) => setTimeout(r, 200));

    // After stopServer, port should no longer respond
    let stopped = false;
    try {
      await fetch(`${serverInfo.serverUrl}/api/session`, { signal: AbortSignal.timeout(500) });
    } catch {
      stopped = true;
    }
    expect(stopped).toBe(true);
  });

  it('restarts server with a new per-session credential after being stopped', async () => {
    fs.mkdirSync(testWorkspace, { recursive: true });
    const s1 = await OpenCodeEngine.ensureServer(testWorkspace);
    expect(s1.password).toBeDefined();

    OpenCodeEngine.stopServer(testWorkspace);
    await new Promise((r) => setTimeout(r, 200));

    const s2 = await OpenCodeEngine.ensureServer(testWorkspace);
    expect(s2.password).toBeDefined();
    // New server gets a newly generated cryptographic random password
    expect(s2.password).not.toBe(s1.password);

    OpenCodeEngine.stopServer(testWorkspace);
  });

  it('validates client authentication against the localhost server', async () => {
    fs.mkdirSync(testWorkspace, { recursive: true });
    const serverInfo = await OpenCodeEngine.ensureServer(testWorkspace);
    const exe = findOpenCodeExe();
    const isCmd = process.platform === 'win32' && (exe.endsWith('.cmd') || exe.endsWith('.bat') || exe === 'opencode');

    // 1. Client without password fails to connect
    const unauthRun = cp.spawnSync(exe, ['run', '--server', serverInfo.serverUrl, 'ping'], {
      cwd: testWorkspace,
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      encoding: 'utf8',
      shell: isCmd,
      windowsHide: true,
      timeout: 10000,
    });
    expect(unauthRun.status).not.toBe(0);
    expect(unauthRun.stderr || '').toContain('requires a password');

    // 2. Client with per-session password authenticates successfully
    const authRun = cp.spawnSync(exe, ['run', '--server', serverInfo.serverUrl, '--auto', '--format', 'json', 'hello'], {
      cwd: testWorkspace,
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_SERVER_PASSWORD: serverInfo.password,
        OPENCODE_PASSWORD: serverInfo.password,
      },
      encoding: 'utf8',
      shell: isCmd,
      windowsHide: true,
      timeout: 75000,
    });
    // The server accepts the authenticated connection and creates an authorized session
    const authenticated = authRun.status === 0 || (authRun.stdout || '').includes('"sessionID"');
    expect(authenticated).toBe(true);

    OpenCodeEngine.stopServer(testWorkspace);
  }, 90000);
});
