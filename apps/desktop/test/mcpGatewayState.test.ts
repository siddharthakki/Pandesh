import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// The REAL gateway process against a FAKE Core. Windows only: the gateway protects pairing tokens with DPAPI.
const GATEWAY = path.resolve(__dirname, '../../panda-bridge/mcp-gateway/server.mjs');
const PAIRING_TOKEN = 'PTOK_dummy_pairing_token_0123456789abcdef0123456789abcdef';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const dirs: string[] = []; const procs: ChildProcess[] = []; const servers: http.Server[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) { try { p.kill(); } catch { /* gone */ } }
  for (const s of servers.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 300));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

async function fakeCore(dir: string) {
  const state = { revoked: false };
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/bridge/pair') return send(200, { token: PAIRING_TOKEN, pairingId: 'pair_test' });
    if (req.url === '/v1/bridge/executors') return state.revoked && req.headers['x-panda-pairing'] === PAIRING_TOKEN ? send(401, { error: { message: 'this browser pairing was revoked' } }) : send(200, { executors: [] });
    send(404, {});
  });
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)));
  servers.push(server);
  fs.writeFileSync(path.join(dir, 'core.json'), JSON.stringify({ port })); fs.writeFileSync(path.join(dir, 'core.token'), 'fake-core-token');
  return state;
}

async function startGateway(dir: string, extraArgs: string[] = []) {
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY, ...extraArgs], { env: { ...process.env, PANDESH_DATA_DIR: dir, PANDESH_MCP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(child);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gateway did not start')), 25_000);
    child.stdout!.on('data', (c) => { if (String(c).includes('listening')) { clearTimeout(t); resolve(); } });
    child.once('exit', (code) => { clearTimeout(t); resolve(); void code; });
  });
  return { port, child, base: `http://127.0.0.1:${port}` };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function pair(base: string) {
  const reg = await (await fetch(`${base}/register`, { method: 'POST', body: JSON.stringify({ client_name: 'state test', redirect_uris: [REDIRECT] }) })).json() as { client_id: string };
  const verifier = crypto.randomBytes(32).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${base}/mcp` };
  const granted = await fetch(`${base}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ ...q, code: 'ABCD2345' }) });
  const code = new URL(granted.headers.get('location')!).searchParams.get('code')!;
  const tok = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })).json() as { access_token: string; refresh_token: string };
  return { clientId: reg.client_id, ...tok };
}
const refresh = (base: string, clientId: string, rt: string) => fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId }) });
const callTool = async (base: string, at: string) => (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${at}`, accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pandesh_list_agents', arguments: {} } }) })).json()) as { result?: { isError?: boolean } };
const stateFile = (dir: string) => path.join(dir, 'mcp-gateway.json');
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-gwstate-')); dirs.push(d); return d; };

describe.runIf(process.platform === 'win32')('gateway state: DPAPI-protected pairing tokens', () => {
  it('never writes the pairing token in plaintext, and a restart still honours the pairing', async () => {
    const dir = tmp(); await fakeCore(dir);
    const a = await startGateway(dir);
    const grant = await pair(a.base);
    const file = fs.readFileSync(stateFile(dir), 'utf8');
    expect(file).not.toContain(PAIRING_TOKEN);
    expect(file).not.toContain(grant.refresh_token);
    expect(file).toMatch(/"pairingTokenEnc": "dpapi1:/);
    a.child.kill(); await new Promise((r) => setTimeout(r, 500));
    const b = await startGateway(dir);
    const r = await refresh(b.base, grant.clientId, grant.refresh_token);
    expect(r.status).toBe(200);
    const next = await r.json() as { access_token: string };
    expect((await callTool(b.base, next.access_token)).result?.isError).not.toBe(true);
    expect(fs.readFileSync(stateFile(dir), 'utf8')).not.toContain(PAIRING_TOKEN);
  }, 90_000);

  it('loads a legacy plaintext file unchanged (no automatic migration), then migrates only on the explicit command', async () => {
    const dir = tmp(); await fakeCore(dir);
    const refreshToken = 'legacy-refresh-token-value-0123456789';
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const legacy = JSON.stringify({ clients: { c_legacy: { name: 'old', redirectUris: [REDIRECT], at: new Date().toISOString() } }, grants: { [hash]: { clientId: 'c_legacy', pairingToken: PAIRING_TOKEN, pairingId: 'pair_old' } } }, null, 1);
    fs.writeFileSync(stateFile(dir), legacy);
    const a = await startGateway(dir);
    // Starting the gateway alone must not touch the file.
    expect(fs.readFileSync(stateFile(dir), 'utf8')).toBe(legacy);
    // The legacy pairing still works (and a refresh rotates it into an encrypted grant, never a new plaintext one).
    const r = await refresh(a.base, 'c_legacy', refreshToken);
    expect(r.status).toBe(200);
    a.child.kill(); await new Promise((r2) => setTimeout(r2, 500));
    // Second legacy file for the explicit migration path.
    fs.writeFileSync(stateFile(dir), legacy);
    const out = await new Promise<string>((resolve) => { const c = spawn(process.execPath, [GATEWAY, '--migrate-state'], { env: { ...process.env, PANDESH_DATA_DIR: dir, PANDESH_MCP_PORT: String(5999) } }); let t = ''; c.stdout.on('data', (d) => (t += d)); c.on('exit', () => resolve(t)); });
    expect(JSON.parse(out.trim())).toEqual({ migrated: 1 });
    const migrated = fs.readFileSync(stateFile(dir), 'utf8');
    expect(migrated).not.toContain(PAIRING_TOKEN);
    expect(migrated).toContain('pairingTokenEnc');
    const b = await startGateway(dir);
    expect((await refresh(b.base, 'c_legacy', refreshToken)).status).toBe(200);
  }, 120_000);

  it('forgets a pairing that Pandesh revoked, so a refresh cannot revive it', async () => {
    const dir = tmp(); const core = await fakeCore(dir);
    const a = await startGateway(dir);
    const grant = await pair(a.base);
    expect((await callTool(a.base, grant.access_token)).result?.isError).not.toBe(true);
    core.revoked = true;
    expect((await callTool(a.base, grant.access_token)).result?.isError).toBe(true);
    const r = await refresh(a.base, grant.clientId, grant.refresh_token);
    expect(r.status).toBe(400);
    expect(fs.readFileSync(stateFile(dir), 'utf8')).not.toContain('pairingTokenEnc');
    // The old access token is gone too.
    expect((await callTool(a.base, grant.access_token)).result?.isError ?? true).toBeTruthy();
  }, 90_000);

  it('drops a protected pairing that this Windows account cannot open (copied profile) and still starts', async () => {
    const dir = tmp(); await fakeCore(dir);
    const hash = crypto.createHash('sha256').update('rt-elsewhere').digest('hex');
    fs.writeFileSync(stateFile(dir), JSON.stringify({ clients: { c_x: { name: 'x', redirectUris: [REDIRECT], at: 'now' } }, grants: { [hash]: { clientId: 'c_x', pairingId: 'p', pairingTokenEnc: `dpapi1:${Buffer.from('not a real dpapi blob').toString('base64')}` } } }));
    const a = await startGateway(dir);
    expect((await refresh(a.base, 'c_x', 'rt-elsewhere')).status).toBe(400);
    expect(fs.readFileSync(path.join(dir, 'logs', 'mcp-gateway.log'), 'utf8')).toMatch(/could not open protected pairings/);
  }, 90_000);
});
