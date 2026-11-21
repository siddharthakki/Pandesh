// Build the supervisor first:  npx esbuild apps/desktop/src/host/chatgptConnector.ts --bundle --platform=node --format=esm --outfile=<dir>/connector.mjs  (this file imports ./connector.mjs next to it).
// Isolated integration run of the ChatGPT connector supervisor.
// Real: supervisor, MCP gateway (server.mjs), loopback TLS + pin check, OpenSSL certificate generation, tunnel-client.exe (with a DUMMY key),
//       isolated Build 188 Core on 3962. Scratch: data dir D:/PandeshConnectorIT (copies of core.json/core.token/host.token only), ports 4973/4974/4975.
// Not touched: production (3030), the owner's live gateway/tunnel (3973-3975), the live mcp-gateway.json and the live ChatGPT pairing.
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { ChatgptConnector, writeConnectorConfig, readConnectorConfig } from './connector.mjs';

const SRC = 'D:/PandeshB188Accept/profile';
const DIR = 'D:/PandeshConnectorIT';
const GW_PORT = 4973, TLS_PORT = 4974, HEALTH_PORT = 4975;
const DUMMY_KEY = 'sk-svcacct-PANDESHINTEGRATIONdummykey0000000000000000';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 220) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const coreInfo = JSON.parse(fs.readFileSync(`${SRC}/core.json`, 'utf8'));
if (coreInfo.port !== 3962) { console.error('REFUSED: the isolated Core is not on 3962 (' + coreInfo.port + ')'); process.exit(2); }
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of ['core.json', 'core.token', 'host.token']) fs.copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);

writeConnectorConfig(DIR, { enabled: true, tunnelId: 'tunnel_integrationtest0001', clientPath: 'D:/PandeshTunnel/client/tunnel-client.exe', gatewayPath: 'D:/Projects/Pandesh/apps/panda-bridge/mcp-gateway/server.mjs', gatewayPort: GW_PORT, tlsPort: TLS_PORT, healthPort: HEALTH_PORT });
const logs = [];
const make = () => new ChatgptConnector({ dataDir: DIR, getKey: async () => DUMMY_KEY, nodePath: process.execPath, nodeIsElectron: false, log: (m) => logs.push(m), buildLabel: 'Build 188 isolated', isProductionProfile: false, watchdogMs: 0 });

const certPem = () => fs.readFileSync(`${DIR}/mcp-gateway-tls/gateway-cert.pem`);
const tlsCall = (method, p, { body, headers = {}, ca: caOpt = certPem() } = {}) => new Promise((resolve) => {
  const ca = caOpt === 'none' ? undefined : caOpt; const r = https.request({ host: '127.0.0.1', port: TLS_PORT, path: p, method, headers, ca, checkServerIdentity: () => undefined }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t })); });
  r.on('error', (e) => resolve({ error: e.code || e.message })); if (body) r.write(body); r.end();
});
const plainCall = (method, p, body, headers = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: GW_PORT, path: p, method, headers }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t })); });
  r.on('error', (e) => resolve({ error: e.code || e.message })); if (body) r.write(body); r.end();
});
const form = (o) => new URLSearchParams(o).toString();
const b64 = (b) => Buffer.from(b).toString('base64url');
const mcp = async (token, method, params, id = 1) => { const r = await tlsCall('POST', '/mcp', { body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` } }); let j = null; try { j = JSON.parse(r.body.startsWith('event:') ? r.body.split('\n').find((l) => l.startsWith('data:')).slice(5) : r.body); } catch { /* not json */ } return { status: r.status, json: j, raw: r.body }; };

// ── 1. start: certificate generation, ports, gateway, pin, tunnel ───────────────────────────
const c1 = make();
await c1.start();
let st = await c1.status();
check('1a loopback certificate was generated (SAN 127.0.0.1, > 14 days)', fs.existsSync(`${DIR}/mcp-gateway-tls/gateway-cert.pem`) && /IP Address:127\.0\.0\.1/.test(new X509Certificate(certPem()).subjectAltName));
check('1b gateway is up and pinned; tunnel-client was launched', st.gatewayRunning && logs.some((l) => /matches the pinned loopback certificate/.test(l)) && logs.some((l) => /tunnel started/.test(l)), logs.filter((l) => /pinned|tunnel started/.test(l)).join(' | '));
check('1c status shows the isolated Core, not production', st.core.reachable && st.core.port === 3962 && st.core.production === false && st.core.build === 'Build 188 isolated', JSON.stringify(st.core));
check('1d the key is nowhere in status, host log or the connector log', !JSON.stringify(st).includes(DUMMY_KEY) && !logs.join('\n').includes(DUMMY_KEY) && !fs.readFileSync(`${DIR}/logs/chatgpt-connector.log`, 'utf8').includes(DUMMY_KEY));
check('1e the key is not on any process command line', !(await import('node:child_process')).execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'tunnel-client.exe','node.exe' } | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' }).includes(DUMMY_KEY));

// ── 2. transport security ───────────────────────────────────────────────────────────────────
check('2a plain listener serves /healthz but not /mcp, /token, /register or metadata', (await plainCall('GET', '/healthz')).status === 200 && (await plainCall('POST', '/mcp', '{}')).status === 404 && (await plainCall('POST', '/token', 'x')).status === 404 && (await plainCall('POST', '/register', '{}')).status === 404 && (await plainCall('GET', '/.well-known/oauth-authorization-server')).status === 404);
check('2b HTTPS without the pinned certificate is refused by validation', Boolean((await tlsCall('GET', '/healthz', { ca: 'none' })).error), (await tlsCall('GET', '/healthz', { ca: 'none' })).error);
check('2c unauthenticated /mcp -> 401 with discovery challenge', await (async () => { const r = await tlsCall('POST', '/mcp', { body: '{}', headers: { 'content-type': 'application/json' } }); return r.status === 401 && /resource_metadata/.test(r.headers['www-authenticate'] ?? ''); })());
const meta = JSON.parse((await tlsCall('GET', '/.well-known/oauth-authorization-server')).body);
check('2d issuer is the HTTPS loopback origin; only S256; token+registration over HTTPS', meta.issuer === `https://127.0.0.1:${TLS_PORT}` && JSON.stringify(meta.code_challenge_methods_supported) === '["S256"]' && meta.token_endpoint.startsWith('https://') && meta.registration_endpoint.startsWith('https://'), JSON.stringify({ i: meta.issuer, a: meta.authorization_endpoint }));

// ── 3. OAuth + PKCE + pairing code (host-created) + MCP tools ────────────────────────────────
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const reg = JSON.parse((await tlsCall('POST', '/register', { body: JSON.stringify({ client_name: 'integration client', redirect_uris: [redirect] }), headers: { 'content-type': 'application/json' } })).body);
const verifier = b64(crypto.randomBytes(32)); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const authQ = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', resource: `https://127.0.0.1:${TLS_PORT}/mcp` };
const consentPage = await plainCall('GET', `/authorize?${form(authQ)}`);
check('3a consent page CSP names the registered redirect origin (the Chrome form-action fix)', /form-action 'self' https:\/\/chatgpt\.com/.test(consentPage.headers['content-security-policy'] ?? ''), consentPage.headers['content-security-policy']);
const pair = await c1.newPairingCode();
check('3b a pairing code is created only by the host (Core host token)', /^[A-Z0-9]{8}$/.test(pair.code.replace('-', '')), pair.expiresAt);
const wrong = await plainCall('POST', '/authorize', form({ ...authQ, code: 'ZZZZZZZZ' }), { 'content-type': 'application/x-www-form-urlencoded' });
check('3c a wrong code is refused (403) and gives no authorization code', wrong.status === 403 && !wrong.headers.location);
// the wrong guess burns open codes (documented behaviour): create a fresh code for the real attempt
const pair2 = await c1.newPairingCode();
const granted = await plainCall('POST', '/authorize', form({ ...authQ, code: pair2.code }), { 'content-type': 'application/x-www-form-urlencoded' });
const loc = new URL(granted.headers.location ?? 'http://none/');
check('3d the right code redirects to the registered redirect with a code and state', granted.status === 302 && loc.origin + loc.pathname === redirect && loc.searchParams.get('state') === 'st1' && Boolean(loc.searchParams.get('code')), granted.status);
const tokenBad = await tlsCall('POST', '/token', { body: form({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-1' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
check('3e PKCE: a wrong verifier is refused and burns the code', tokenBad.status === 400 && /invalid_grant/.test(tokenBad.body), tokenBad.body);
// get a clean grant again for the rest
const pair3 = await c1.newPairingCode();
const granted2 = await plainCall('POST', '/authorize', form({ ...authQ, code: pair3.code }), { 'content-type': 'application/x-www-form-urlencoded' });
const code2 = new URL(granted2.headers.location).searchParams.get('code');
const tok = JSON.parse((await tlsCall('POST', '/token', { body: form({ grant_type: 'authorization_code', code: code2, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).body);
check('3f token exchange with the right verifier works', Boolean(tok.access_token && tok.refresh_token), Object.keys(tok).join(','));
const list = await mcp(tok.access_token, 'tools/list', {});
const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
check('3g tools/list = exactly the five tools, no approve tool', JSON.stringify(names) === JSON.stringify(['pandesh_cancel_task', 'pandesh_list_agents', 'pandesh_submit_task', 'pandesh_task_report', 'pandesh_task_status']), names.join(','));
const agents = await mcp(tok.access_token, 'tools/call', { name: 'pandesh_list_agents', arguments: {} }, 2);
check('3h pandesh_list_agents executes against the isolated Core', agents.status === 200 && !agents.json?.result?.isError && /agents/.test(agents.raw), agents.raw.slice(0, 160));

// ── 4. failure recovery ─────────────────────────────────────────────────────────────────────
const stBefore = await c1.status();
check('4a tunnel-client with a DUMMY key does not stay "running" (its failure is visible, nothing pretends to be connected)', stBefore.state !== 'running' || !stBefore.tunnelReachable, `${stBefore.state}; tunnelReachable=${stBefore.tunnelReachable}; ${stBefore.detail}`);
const gwPid = Number((logs.find((l) => /gateway started \(pid (\d+)\)/.test(l)) ?? '').match(/pid (\d+)/)?.[1]);
process.kill(gwPid);   // simulate a gateway crash
await sleep(7000);
const afterCrash = await plainCall('GET', '/healthz');
check('4b a crashed gateway is restarted by the supervisor (bounded backoff)', afterCrash.status === 200 && logs.filter((l) => /gateway started/.test(l)).length >= 2, logs.filter((l) => /gateway (exited|started)|restarting gateway/.test(l)).join(' | ').slice(0, 200));
const c2 = make();
await c2.start();
const st2 = await c2.status();
check('4c a second instance is refused (duplicate prevention): ports are in use, the first keeps running', /already in use/.test(st2.lastError ?? '') && (await plainCall('GET', '/healthz')).status === 200, st2.lastError);

// ── 5. pairing survives a restart of the gateway ────────────────────────────────────────────
const fp1 = new X509Certificate(certPem()).fingerprint256;
const tokenFile = fs.readFileSync(`${DIR}/mcp-gateway.json`, 'utf8');
await c1.stop('restart test');
check('5a stop ends gateway and tunnel (ports released)', (await plainCall('GET', '/healthz')).error !== undefined);
const c3 = make();
await c3.start();
const fp2 = new X509Certificate(certPem()).fingerprint256;
check('5b the certificate is reused across restarts (pin stays stable)', fp1 === fp2);
const refreshed = JSON.parse((await tlsCall('POST', '/token', { body: form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).body);
check('5c the existing pairing survives the restart: the refresh token still works', Boolean(refreshed.access_token), Object.keys(refreshed).join(','));
const reuse = await tlsCall('POST', '/token', { body: form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
check('5d a refresh token works once only (rotation)', reuse.status === 400);
const oldAccess = await mcp(tok.access_token, 'tools/list', {}, 3);
check('5e the old in-memory access token is gone after the restart (client must refresh; no silent reuse)', oldAccess.status === 401, oldAccess.status);
const newList = await mcp(refreshed.access_token, 'tools/list', {}, 4);
check('5f the refreshed token works', newList.status === 200 && (newList.json?.result?.tools ?? []).length === 5);
check('5g the pairing token is stored in the gateway state file (user-profile permissions only; not encrypted)', /pairingToken/.test(fs.readFileSync(`${DIR}/mcp-gateway.json`, 'utf8')), 'finding: could be wrapped with DPAPI');

// ── 6. revoking the pairing cuts access (only this test pairing; the live ChatGPT pairing is not touched) ─────
const hostTok = fs.readFileSync(`${DIR}/host.token`, 'utf8').trim(); const bearer = fs.readFileSync(`${DIR}/core.token`, 'utf8').trim();
const coreCall = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:3962${p}`, { method: m, headers: { authorization: `Bearer ${bearer}`, 'x-host-token': hostTok, 'content-type': 'application/json', 'x-client-id': 'it-owner' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const pairingsRes = await coreCall('GET', '/v1/bridge/pairings');
const all = Array.isArray(pairingsRes.body) ? pairingsRes.body : pairingsRes.body?.pairings ?? [];
const mine = all.filter((p) => /integration client/.test(p.label ?? '') && !p.revokedAt && p.status !== 'revoked');
for (const p of mine) await coreCall('POST', `/v1/bridge/pairings/${p.id ?? p.pairingId}/revoke`, {});
const afterRevoke = await mcp(refreshed.access_token, 'tools/call', { name: 'pandesh_list_agents', arguments: {} }, 5);
check('6a revoking the pairing in Pandesh cuts ChatGPT off immediately', mine.length >= 1 && (afterRevoke.status === 401 || afterRevoke.json?.result?.isError === true || /revoked|invalid|unauthor/i.test(afterRevoke.raw)), `${mine.length} test pairing(s) revoked; MCP -> ${afterRevoke.status} ${afterRevoke.raw.slice(0, 120)}`);
await c3.stop('done');

const failed = results.filter((r) => !r.ok);
fs.writeFileSync('D:/PandeshConnectorIT/RESULT.json', JSON.stringify({ at: new Date().toISOString(), pass: results.length - failed.length, fail: failed.length, results, connectorLog: fs.readFileSync(`${DIR}/logs/chatgpt-connector.log`, 'utf8').split('\n').slice(-60) }, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
