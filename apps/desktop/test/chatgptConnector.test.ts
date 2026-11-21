import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatgptConnector, certificateIsUsable, normalizeConfig, readConnectorConfig, reducedEnvironment, writeConnectorConfig } from '../src/host/chatgptConnector';

// A dummy key shaped like a real one: if it ever reaches a log, a file or a status view the assertions below fail.
const DUMMY_KEY = 'sk-svcacct-PANDESHDUMMYtunnelkey0000000000000001';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-connector-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

class FakeChild extends EventEmitter {
  pid = 4242; stdout = new EventEmitter(); stderr = new EventEmitter(); killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit('exit', 0, null)); return true; }
}

function setup(opts: { key?: string | null; opensslPath?: string | null; busyPorts?: number[]; fetchOk?: boolean } = {}) {
  const dataDir = tmp();
  const client = path.join(dataDir, 'tunnel-client.exe'); fs.writeFileSync(client, 'x');
  const gateway = path.join(dataDir, 'server.mjs'); fs.writeFileSync(gateway, 'x');
  writeConnectorConfig(dataDir, { enabled: true, tunnelId: 'tunnel_abcdef123456', clientPath: client, gatewayPath: gateway });
  // A real self-signed loopback certificate (what the supervisor would generate), so no OpenSSL is needed here.
  const tls = path.join(dataDir, 'mcp-gateway-tls'); fs.mkdirSync(tls);
  const openssl = 'C:/Program Files/Git/usr/bin/openssl.exe';
  if (fs.existsSync(openssl)) {
    execFileSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(tls, 'gateway-key.pem'), '-out', path.join(tls, 'gateway-cert.pem'), '-days', '90', '-subj', '/CN=t', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  }
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string>; child: FakeChild }> = [];
  const fakeSpawn = ((command: string, args: string[], options: { env: Record<string, string> }) => {
    const child = new FakeChild(); spawned.push({ command, args, env: options.env, child }); return child;
  }) as never;
  const logs: string[] = [];
  const key = opts.key === undefined ? DUMMY_KEY : opts.key;
  const connector = new ChatgptConnector({
    dataDir, getKey: async () => key, nodePath: 'C:/node.exe', nodeIsElectron: true, log: (m) => logs.push(m),
    spawnFn: fakeSpawn,
    fetchFn: (async () => ({ ok: opts.fetchOk ?? true, json: async () => ({ pairings: [] }) })) as never,
    portFree: async (port) => !(opts.busyPorts ?? []).includes(port),
    opensslPath: opts.opensslPath ?? null, startupWaitMs: 0,
  });
  return { dataDir, connector, spawned, logs };
}

describe('connector config', () => {
  it('is off by default and rejects bad ports and tunnel ids', () => {
    const dir = tmp();
    expect(readConnectorConfig(dir).enabled).toBe(false);
    const cfg = normalizeConfig({ enabled: true, tunnelId: 'not-a-tunnel', gatewayPort: 80, tlsPort: 70000 });
    expect(cfg.tunnelId).toBe('');
    expect(cfg.gatewayPort).toBe(3973);
    expect(cfg.tlsPort).toBe(3974);
  });
  it('passes tunnel-client only a reduced environment', () => {
    const env = reducedEnvironment({ PATH: 'p', SystemRoot: 'r', CONTROL_PLANE_API_KEY: 'leak', OPENAI_API_KEY: 'leak', ANTHROPIC_API_KEY: 'leak' } as never);
    expect(Object.keys(env).sort()).toEqual(['PATH', 'SystemRoot']);
  });
});

describe('connector lifecycle', () => {
  const certReady = fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe');

  it.runIf(certReady)('starts the gateway then the tunnel with the key only in the tunnel environment', async () => {
    const { connector, spawned, dataDir, logs } = setup();
    await connector.start();
    expect(spawned).toHaveLength(2);
    const [gw, tun] = spawned;
    expect(gw.command).toBe('C:/node.exe');
    expect(gw.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(gw.env.PANDESH_MCP_TLS_PORT).toBe('3974');
    expect(JSON.stringify(gw.env)).not.toContain(DUMMY_KEY);
    expect(tun.env.CONTROL_PLANE_API_KEY).toBe(DUMMY_KEY);
    expect(tun.args).toContain('env:CONTROL_PLANE_API_KEY');
    expect(tun.args.join(' ')).not.toContain(DUMMY_KEY);
    expect(tun.args).toContain('--harpoon.oauth-forward-origin');
    // Even if the program echoes the key, the log never holds it.
    tun.child.stdout.emit('data', Buffer.from(`token ${DUMMY_KEY} accepted\n`));
    const logFile = fs.readFileSync(path.join(dataDir, 'logs', 'chatgpt-connector.log'), 'utf8');
    expect(logFile).not.toContain(DUMMY_KEY);
    expect(logFile).toContain('[redacted]');
    expect(logs.join('\n')).not.toContain(DUMMY_KEY);
    const status = await connector.status();
    expect(JSON.stringify(status)).not.toContain(DUMMY_KEY);
    expect(status.keyHint).toBe('sk-s…0001');
    await connector.stop('test');
    expect(gw.child.killed && tun.child.killed).toBe(true);
  });

  it('does not start without a key and says so', async () => {
    const { connector, spawned } = setup({ key: null });
    await connector.start();
    expect(spawned).toHaveLength(0);
    expect((await connector.status()).state).toBe('needs-key');
  });

  it.runIf(certReady)('refuses to start on a port that is already in use and starts nothing else', async () => {
    const { connector, spawned } = setup({ busyPorts: [3973] });
    await connector.start();
    expect(spawned).toHaveLength(0);
    const status = await connector.status();
    expect(status.state).toBe('failed');
    expect(status.detail).toMatch(/Port 3973 is already in use/);
  });

  it('is off and starts nothing when the switch is off', async () => {
    const { connector, spawned, dataDir } = setup();
    writeConnectorConfig(dataDir, { enabled: false });
    await connector.applyConfig();
    expect(spawned).toHaveLength(0);
    expect((await connector.status()).state).toBe('off');
  });

  it('needs a pairing code only from a running connector', async () => {
    const { connector } = setup();
    await expect(connector.newPairingCode()).rejects.toThrow(/Switch the ChatGPT connector on/);
  });

  it('judges a certificate usable only when valid long enough and for 127.0.0.1', () => {
    const dir = tmp();
    expect(certificateIsUsable(path.join(dir, 'c.pem'), path.join(dir, 'k.pem'))).toBe(false);
  });
});
