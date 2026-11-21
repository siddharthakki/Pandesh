// Qualification of the PACKAGED Build 188 + connector (isolated profile D:/PandeshB188cAccept, Core 3964, CDP 9484, connector ports 4983-4985).
//   node pkg-driver.mjs phase1   (host already launched)   node pkg-driver.mjs phase2   (after a host restart)
// Never touches production (3030), the old isolated Build 188 (3961/3962/9483) or the live gateway/tunnel (3973-3975).
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

const PROFILE = 'D:/PandeshB188cAccept/profile';
const CDP = 9484, CORE = 3964, GW = 4983, TLS = 4984;
const STATE = 'D:/PandeshB188cAccept/pkg-phase1.json';
const phase = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 260) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 260) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const certPem = () => fs.readFileSync(`${PROFILE}/mcp-gateway-tls/gateway-cert.pem`);

// ── CDP: evaluate in the app's own renderer (the same IPC the Connections card uses) ──────────
async function cdp(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return await new Promise((resolve, reject) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { ws.close(); d.result?.exceptionDetails ? reject(new Error(d.result.exceptionDetails.exception?.description ?? 'eval error')) : resolve(d.result?.result?.value); } };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
const view = () => cdp('window.desktop.getChatgptConnector()');
async function waitView(pred, ms = 90_000) { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await view(); if (pred(v)) return v; } catch { /* host not ready */ } await sleep(1500); } return v; }

const tlsCall = (method, p, { body, headers = {} } = {}) => new Promise((resolve) => {
  const r = https.request({ host: '127.0.0.1', port: TLS, path: p, method, headers, ca: certPem(), checkServerIdentity: () => undefined }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t })); });
  r.on('error', (e) => resolve({ error: e.code || e.message })); if (body) r.write(body); r.end();
});
const plainCall = (method, p, body, headers = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: GW, path: p, method, headers }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: t })); });
  r.on('error', (e) => resolve({ error: e.code || e.message })); if (body) r.write(body); r.end();
});
const form = (o) => new URLSearchParams(o).toString();
const mcp = async (token, method, params, id = 1) => { const r = await tlsCall('POST', '/mcp', { body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` } }); let j = null; try { j = JSON.parse(r.body); } catch { /* not json */ } return { status: r.status, json: j, raw: r.body ?? '' }; };
const tool = async (token, name, args, id) => { const r = await mcp(token, 'tools/call', { name, arguments: args }, id); const text = r.json?.result?.content?.[0]?.text ?? ''; let data = null; try { data = JSON.parse(text); } catch { /* text */ } return { ...r, text, data, isError: r.json?.result?.isError === true }; };
const coreHeaders = () => ({ authorization: `Bearer ${fs.readFileSync(`${PROFILE}/core.token`, 'utf8').trim()}`, 'x-host-token': fs.readFileSync(`${PROFILE}/host.token`, 'utf8').trim(), 'content-type': 'application/json', 'x-client-id': 'pkg-driver' });
const coreCall = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${CORE}${p}`, { method: m, headers: coreHeaders(), body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

if (JSON.parse(fs.readFileSync(`${PROFILE}/core.json`, 'utf8')).port !== CORE) { console.error('REFUSED: this profile is not on the expected isolated Core port'); process.exit(2); }

if (phase === 'phase1') {
  // 1. Started by the host on its own (no card interaction), in order: gateway -> pin -> Core -> tunnel.
  const v = await waitView((x) => x.core?.reachable && /tunnel started/.test((x.recentLog ?? []).join('\n')));
  check('1a connector started by itself when the packaged host started (no UI action)', v?.enabled && /gateway started/.test(fs.readFileSync(`${PROFILE}/logs/chatgpt-connector.log`, 'utf8')), v?.state + ' | ' + v?.detail);
  const log = fs.readFileSync(`${PROFILE}/logs/chatgpt-connector.log`, 'utf8');
  const order = ['gateway started', 'matches the pinned loopback certificate', 'tunnel started'].map((s) => log.indexOf(s));
  check('1b startup order: gateway, certificate pin, then tunnel (Core already answering)', order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], order.join('<'));
  check('1c the gateway is the packaged, hash-verified component (no workspace path)', v?.gatewaySource === 'packaged-verified', v?.gatewaySource);
  check('1d health reporting names the isolated Core and build, not production', v?.core?.port === CORE && v?.core?.production === false && /Build 188/.test(v?.core?.build ?? ''), JSON.stringify(v?.core));
  check('1e the stored key is only a masked hint in the renderer view', v?.keyConfigured === true && !JSON.stringify(v).includes('sk-svcacct-PKGTEST'), v?.keyHint);
  check('1f the failure of a dummy key is visible, not hidden', v?.state !== 'running' && (v?.tunnelReachable === false), `${v?.state}: ${v?.detail}`);

  // 2. Pairing code from the app's own IPC (host token) and the OAuth consent flow.
  const code = await cdp('window.desktop.chatgptConnectorPairingCode()');
  check('2a the pairing code is created through the app (Connections card IPC)', /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code?.code ?? ''), code?.expiresAt);
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const reg = JSON.parse((await tlsCall('POST', '/register', { body: JSON.stringify({ client_name: 'pkg client', redirect_uris: [redirect] }), headers: { 'content-type': 'application/json' } })).body);
  const verifier = crypto.randomBytes(32).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: `https://127.0.0.1:${TLS}/mcp` };
  const granted = await plainCall('POST', '/authorize', form({ ...q, code: code.code }), { 'content-type': 'application/x-www-form-urlencoded' });
  const authCode = new URL(granted.headers.location ?? 'http://none/').searchParams.get('code');
  const tok = JSON.parse((await tlsCall('POST', '/token', { body: form({ grant_type: 'authorization_code', code: authCode, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).body);
  check('2b OAuth consent + PKCE token exchange through the packaged gateway over HTTPS', Boolean(tok.access_token && tok.refresh_token));
  const state = fs.readFileSync(`${PROFILE}/mcp-gateway.json`, 'utf8');
  check('2c the pairing token is DPAPI-protected at rest in the packaged profile', /"pairingTokenEnc": "dpapi1:/.test(state) && !/"pairingToken"\s*:/.test(state));
  const list = await mcp(tok.access_token, 'tools/list', {});
  const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort().join(',');
  check('2d tools/list = the five tools; no approve tool', names === 'pandesh_cancel_task,pandesh_list_agents,pandesh_submit_task,pandesh_task_report,pandesh_task_status', names);
  const agents = await tool(tok.access_token, 'pandesh_list_agents', {}, 2);
  check('2e list_agents runs against the isolated Core', !agents.isError && Array.isArray(agents.data?.agents), agents.text.slice(0, 200));

  // The task folder must be an authorized project (the owner's host-only registry): register a read-only scratch folder in THIS isolated Core.
  await coreCall('POST', '/v1/bridge/projects', { name: 'connector test workspace', path: 'D:/PandeshB188cAccept/workspace', access: 'read', aliases: ['connector test workspace'] });
  // 3. A native, read-only task through the connector (deterministic file listing service).
  const sub = await tool(tok.access_token, 'pandesh_submit_task', { instruction: 'List the files in the connector test workspace (D:\\PandeshB188cAccept\\workspace). Read only; do not change anything.', executor: 'opencode' }, 3);
  check('3a native read-only task accepted and started', !sub.isError && sub.data?.taskId, sub.text.slice(0, 220));
  let final = null;
  for (let i = 0; i < 14 && sub.data?.taskId; i++) { const st = await tool(tok.access_token, 'pandesh_task_status', { taskId: sub.data.taskId, wait_seconds: 20 }, 10 + i); final = st; if (/completed|failed|cancelled/.test(st.data?.status ?? '')) break; }
  check('3b the task reaches a terminal state', /completed|failed|cancelled/.test(final?.data?.status ?? ''), String(JSON.stringify(final?.data ?? final?.text ?? 'no status')).slice(0, 220));
  const rep = sub.data?.taskId ? await tool(tok.access_token, 'pandesh_task_report', { taskId: sub.data.taskId }, 40) : null;
  check('3c the report is retrievable', rep && !rep.isError, (rep?.text ?? '').slice(0, 240));

  // 4. Cloud approval gate: a Claude Code task must NOT start without the owner's card.
  const cl = await tool(tok.access_token, 'pandesh_submit_task', { instruction: 'Read-only check: say hello. Do not change any file.', executor: 'claude' }, 50);
  check('4a a Claude Code task waits for the owner (nothing sent yet)', !cl.isError && cl.data?.started !== true && /waiting|approval|owner/i.test(JSON.stringify(cl.data)), JSON.stringify(cl.data ?? cl.text).slice(0, 240));
  if (cl.data?.taskId) { const c = await tool(tok.access_token, 'pandesh_cancel_task', { taskId: cl.data.taskId }, 51); check('4b the pending task can be cancelled from ChatGPT', !c.isError, c.text.slice(0, 120)); }

  fs.writeFileSync(STATE, JSON.stringify({ clientId: reg.client_id, refresh: tok.refresh_token, access: tok.access_token, at: new Date().toISOString() }));
} else if (phase === 'phase2') {
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const v = await waitView((x) => x.core?.reachable && /tunnel started/.test((x.recentLog ?? []).join('\n')));
  check('5a after a host restart the connector came back by itself', v?.enabled && v?.core?.reachable && fs.readFileSync(`${PROFILE}/logs/chatgpt-connector.log`, 'utf8').split('\n').filter((l) => /gateway started/.test(l)).some((l) => Date.parse(l.slice(0, 24)) > Date.parse(saved.at)), `${v?.state}: ${v?.detail}`);
  const old = await mcp(saved.access, 'tools/list', {}, 60);
  check('5b the old in-memory access token is gone (the client must refresh)', old.status === 401, old.status);
  const rr = await tlsCall('POST', '/token', { body: form({ grant_type: 'refresh_token', refresh_token: saved.refresh, client_id: saved.clientId }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const next = JSON.parse(rr.body || '{}');
  check('5c the existing pairing survived the restart (DPAPI state reopened, refresh works)', rr.status === 200 && Boolean(next.access_token), rr.status);
  const ag = next.access_token ? await tool(next.access_token, 'pandesh_list_agents', {}, 61) : null;
  check('5d the recovered session can use the tools', ag && !ag.isError, (ag?.text ?? '').slice(0, 120));
  const view2 = v;
  check('5e health reporting after recovery names the same isolated Core', view2?.core?.port === CORE && view2?.core?.production === false);
  // 6. Revocation in Pandesh cuts access, and a refresh cannot revive it (only THIS test pairing is revoked).
  const pr = await coreCall('GET', '/v1/bridge/pairings');
  const mine = (Array.isArray(pr.body) ? pr.body : pr.body?.pairings ?? []).filter((p) => /pkg client/.test(p.label ?? '') && !p.revokedAt && p.status !== 'revoked');
  for (const p of mine) await coreCall('POST', `/v1/bridge/pairings/${p.id ?? p.pairingId}/revoke`, {});
  const cut = next.access_token ? await tool(next.access_token, 'pandesh_list_agents', {}, 62) : null;
  check('6a revoking the pairing in Pandesh cuts ChatGPT off', mine.length >= 1 && cut?.isError === true, `${mine.length} revoked; ${cut?.text?.slice(0, 100)}`);
  const revive = await tlsCall('POST', '/token', { body: form({ grant_type: 'refresh_token', refresh_token: next.refresh_token ?? 'x', client_id: saved.clientId }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('6b a refresh cannot revive a revoked pairing', revive.status === 400, revive.status);
  check('6c the revoked grant is gone from the state file', !/pairingTokenEnc/.test(fs.readFileSync(`${PROFILE}/mcp-gateway.json`, 'utf8')));
} else { console.error('usage: phase1 | phase2'); process.exit(2); }

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(`D:/PandeshB188cAccept/pkg-${phase}-result.json`, JSON.stringify({ at: new Date().toISOString(), pass: results.length - failed.length, fail: failed.length, results }, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
