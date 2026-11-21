import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatgptConnector, verifyGatewayPin, writeConnectorConfig } from '../src/host/chatgptConnector';

const OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';
const haveOpenssl = fs.existsSync(OPENSSL);
const KEY = 'sk-svcacct-PANDESHDUMMYrecoverykey000000000001';
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-connector-r-')); dirs.push(d); return d; };

function makeCert(dir: string, name: string) {
  const cert = path.join(dir, `${name}-cert.pem`); const key = path.join(dir, `${name}-key.pem`);
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '90', '-subj', `/CN=${name}`, '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { cert, key };
}
const listen = (server: https.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

class FakeChild extends EventEmitter {
  pid = 1; stdout = new EventEmitter(); stderr = new EventEmitter(); killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit('exit', 1, null)); return true; }
}

afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe.runIf(haveOpenssl)('certificate pinning of the loopback hop', () => {
  it('accepts only a server that presents exactly the pinned certificate', async () => {
    const dir = tmp();
    const pinned = makeCert(dir, 'pinned'); const other = makeCert(dir, 'other');
    const good = https.createServer({ cert: fs.readFileSync(pinned.cert), key: fs.readFileSync(pinned.key) }, (_q, r) => r.end('x'));
    const evil = https.createServer({ cert: fs.readFileSync(other.cert), key: fs.readFileSync(other.key) }, (_q, r) => r.end('x'));
    const goodPort = await listen(good); const evilPort = await listen(evil);
    try {
      expect(await verifyGatewayPin(goodPort, fs.readFileSync(pinned.cert))).toBe(true);
      // Another certificate on the port (an impostor process) is refused even though it is also self-signed.
      expect(await verifyGatewayPin(evilPort, fs.readFileSync(pinned.cert))).toBe(false);
      // Nothing listening is refused too.
      good.close();
      expect(await verifyGatewayPin(goodPort, fs.readFileSync(pinned.cert), 800)).toBe(false);
    } finally { good.close(); evil.close(); }
  });
});

function harness(opts: { pin?: boolean; healthOk?: () => boolean } = {}) {
  const dataDir = tmp();
  const client = path.join(dataDir, 'tunnel-client.exe'); fs.writeFileSync(client, 'x');
  const gateway = path.join(dataDir, 'server.mjs'); fs.writeFileSync(gateway, 'x');
  writeConnectorConfig(dataDir, { enabled: true, tunnelId: 'tunnel_abcdef123456', clientPath: client, gatewayPath: gateway });
  const tls = path.join(dataDir, 'mcp-gateway-tls'); fs.mkdirSync(tls);
  makeCert(tls, 'gateway'); fs.renameSync(path.join(tls, 'gateway-cert.pem'), path.join(tls, 'gateway-cert.pem'));
  fs.renameSync(path.join(tls, 'gateway-key.pem'), path.join(tls, 'gateway-key.pem'));
  const seenPorts = new Set<number>();   // free the first time a port is asked about, then "in use" (the started process now listens)
  const spawned: Array<{ name: string; child: FakeChild }> = [];
  const spawnFn = ((command: string) => { const child = new FakeChild(); const name = command.endsWith('.exe') ? 'tunnel' : 'gateway'; spawned.push({ name, child }); child.once('exit', () => { for (const p of name === 'tunnel' ? [3975] : [3973, 3974]) seenPorts.delete(p); }); return child; }) as never;
  const connector = new ChatgptConnector({
    dataDir, getKey: async () => KEY, nodePath: 'node', nodeIsElectron: false, log: () => undefined, spawnFn,
    fetchFn: (async (url: string) => ({ ok: String(url).includes('/v1/health') ? true : (opts.healthOk?.() ?? true), json: async () => ({}) })) as never,
    portFree: async (port: number) => { if (seenPorts.has(port)) return false; seenPorts.add(port); return true; }, opensslPath: null, startupWaitMs: 0, watchdogMs: 0,
    verifyPin: async () => opts.pin ?? true, buildLabel: 'Build test', isProductionProfile: false,
  });
  fs.writeFileSync(path.join(dataDir, 'core.json'), JSON.stringify({ port: 4999 }));
  return { dataDir, connector, spawned };
}

describe.runIf(haveOpenssl)('failure recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('does not start the tunnel when the gateway certificate does not match the pin', async () => {
    const { connector, spawned } = harness({ pin: false });
    await connector.start();
    expect(spawned.map((s) => s.name)).toEqual(['gateway']);
    const st = await connector.status();
    expect(st.state).toBe('failed');
    expect(st.detail).toMatch(/expected loopback certificate/);
    await connector.stop('test');
  });

  it('restarts a crashed tunnel with backoff, and gives up after the bounded number of crashes', async () => {
    const { connector, spawned } = harness();
    await connector.start();
    expect(spawned.map((s) => s.name)).toEqual(['gateway', 'tunnel']);
    // Each crash is followed by a restart after a growing delay.
    for (let crash = 1; crash <= 5; crash++) {
      spawned.filter((s) => s.name === 'tunnel').at(-1)!.child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(2000 * 2 ** (crash - 1) + 50);
      expect(spawned.filter((s) => s.name === 'tunnel')).toHaveLength(1 + crash);
    }
    // The sixth crash inside ten minutes ends the retries.
    spawned.filter((s) => s.name === 'tunnel').at(-1)!.child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawned.filter((s) => s.name === 'tunnel')).toHaveLength(6);
    const st = await connector.status();
    expect(st.state).toBe('failed');
    expect(st.lastFailure?.message).toMatch(/stopped 5 times in 10 minutes/);
    await connector.stop('test');
  });

  it('ends a tunnel that is alive but stopped answering (3 missed checks) so it restarts', async () => {
    let healthy = true;
    const dataDir = tmp();
    void dataDir;
    const { connector, spawned } = harness({ healthOk: () => healthy });
    await connector.start();
    const tunnel = spawned.find((s) => s.name === 'tunnel')!;
    healthy = false;
    await connector.watchdogTick(); await connector.watchdogTick();
    expect(tunnel.child.killed).toBe(false);
    await connector.watchdogTick();
    expect(tunnel.child.killed).toBe(true);
    await connector.stop('test');
  });

  it('reports which Core it uses and that it is not production', async () => {
    const { connector, dataDir } = harness();
    await connector.start();
    const st = await connector.status();
    expect(st.core).toMatchObject({ reachable: true, port: 4999, production: false, build: 'Build test', profile: dataDir });
    fs.rmSync(path.join(dataDir, 'core.json'));
    const down = await connector.status();
    expect(down.core.reachable).toBe(false);
    expect(down.state).toBe('degraded');
    expect(down.detail).toMatch(/Core is not answering/);
    await connector.stop('test');
  });
});
