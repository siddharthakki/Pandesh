#!/usr/bin/env node
/**
 * Pandesh MCP gateway: the ONLY surface a ChatGPT connector (through an outbound-only tunnel) can reach.
 *
 *   ChatGPT --(OAuth 2.1 + MCP Streamable HTTP)--> [tunnel] --> this gateway (127.0.0.1) --> Pandesh Core /v1/bridge/* (existing lifecycle)
 *
 * It is deliberately thin. It adds no orchestration: every tool is one call of the existing Panda Bridge task lifecycle, made with a
 * pairing that has the same authority as a paired browser ("extension"): it can submit, watch and cancel tasks, it can start only LOCAL
 * executors, and a cloud agent (Claude Code) only ever produces an approval card that the owner answers in the Pandesh app.
 *
 * Authentication: OAuth 2.1 authorization-code + PKCE(S256) with dynamic client registration (the mechanisms ChatGPT supports).
 * The owner's consent is the Pandesh pairing code, created inside the Pandesh app and typed on the consent page, so granting a
 * connector needs presence at this PC. Tokens are random, stored only as SHA-256 hashes, short-lived (access 1 h), revocable by
 * revoking the pairing in Pandesh. Nothing here listens beyond 127.0.0.1.
 *
 * Environment: PANDESH_DATA_DIR (profile; default %LOCALAPPDATA%/KarkeDikha/desktop), PANDESH_MCP_PORT (default 3973),
 *   PANDESH_MCP_PUBLIC_URL (the https URL ChatGPT uses; default http://127.0.0.1:<port>).
 */
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.PANDESH_DATA_DIR || path.join(process.env.LOCALAPPDATA || '', 'KarkeDikha', 'desktop');
const PORT = Number(process.env.PANDESH_MCP_PORT || 3973);
// Optional loopback TLS mode (off unless PANDESH_MCP_TLS_PORT is set). Why: the Secure MCP Tunnel only forwards OAuth endpoints (/register, /token) that
// sit on an approved HTTPS origin; an http://127.0.0.1 endpoint is called directly by OpenAI's OAuth caller, which cannot reach loopback. In this mode the
// MCP resource, metadata, /register and /token are served over HTTPS on 127.0.0.1:<TLS_PORT> with a self-signed certificate that only tunnel-client trusts
// (--ca-bundle); the plain-HTTP listener on PORT then serves only /authorize (the owner's own browser on this PC goes there directly) and /healthz.
// Both listeners stay on 127.0.0.1. Nothing is public.
const TLS_PORT = process.env.PANDESH_MCP_TLS_PORT ? Number(process.env.PANDESH_MCP_TLS_PORT) : 0;
const TLS_DIR = process.env.PANDESH_MCP_TLS_DIR || path.join(process.env.PANDESH_DATA_DIR || '', 'mcp-gateway-tls');
const PUBLIC = (process.env.PANDESH_MCP_PUBLIC_URL || (TLS_PORT ? `https://127.0.0.1:${TLS_PORT}` : `http://127.0.0.1:${PORT}`)).replace(/\/+$/, '');
const AUTHORIZE_URL = TLS_PORT ? `http://127.0.0.1:${PORT}/authorize` : `${PUBLIC}/authorize`;
const PRODUCTION_PORTS = new Set([3030, 9333, 11434, 3991, 3992, 9481, 3993]);
if (PRODUCTION_PORTS.has(PORT)) { console.error('REFUSED: that port belongs to something else'); process.exit(2); }
const STATE_FILE = path.join(DATA_DIR, 'mcp-gateway.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'mcp-gateway.log');
const ACCESS_TTL = 3600, CODE_TTL = 300, MAX_BODY = 64 * 1024;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

function audit(line) { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ } }

// ------------------------------------------------------------------ state (hashes only; pairing tokens protected with Windows DPAPI)
// In memory: grants[hash(refresh)] = { clientId, pairingId, token (plain, memory only), enc (DPAPI blob or undefined for a legacy plaintext grant) }.
// On disk:   grants[hash(refresh)] = { clientId, pairingId, pairingTokenEnc: 'dpapi1:<base64>' }. A pairing token is never newly written in plaintext.
// A legacy file that still holds plaintext pairing tokens keeps working and is converted ONLY by an explicit "node server.mjs --migrate-state".
// DPAPI (CurrentUser scope, Pandesh-specific entropy) binds the blob to this Windows account on this PC: a copy of the profile folder is useless elsewhere.
// PANDESH_MCP_STATE_PROTECTION=none exists for tests only; it is audited and never set by the Pandesh host.
const PROTECTION = process.env.PANDESH_MCP_STATE_PROTECTION === 'none' ? 'none' : 'dpapi';
const DPAPI_PS = [
  "$ErrorActionPreference = 'Stop'", 'Add-Type -AssemblyName System.Security',
  '$in = [Console]::In.ReadToEnd() | ConvertFrom-Json', "$e = [Text.Encoding]::UTF8.GetBytes('pandesh-mcp-gateway-state-v1')", '$out = @()',
  "foreach ($i in $in.items) { $d = [Convert]::FromBase64String($i); if ($in.op -eq 'protect') { $r = [Security.Cryptography.ProtectedData]::Protect($d, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser) } else { $r = [Security.Cryptography.ProtectedData]::Unprotect($d, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser) }; $out += [Convert]::ToBase64String($r) }",
  '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($out)))',
].join('; ');
const dpapi = (op, items) => new Promise((resolve, reject) => {
  if (!items.length) return resolve([]);
  const encoded = Buffer.from(DPAPI_PS, 'utf16le').toString('base64');
  const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return reject(new Error(`DPAPI ${op} failed`));
    try { const r = JSON.parse(String(stdout).trim()); resolve(Array.isArray(r) ? r : [r]); } catch { reject(new Error(`DPAPI ${op} returned an unreadable reply`)); }
  });
  child.stdin?.end(JSON.stringify({ op, items }));   // secrets travel over stdin only, never the command line
});
const protectToken = async (plain) => {
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  if (PROTECTION === 'none') return `none1:${b64}`;
  return `dpapi1:${(await dpapi('protect', [b64]))[0]}`;
};
const unprotectTokens = async (blobs) => {
  const real = blobs.filter((b) => b.startsWith('dpapi1:')); const out = new Map();
  const plain = real.length ? await dpapi('unprotect', real.map((b) => b.slice(7))) : [];
  real.forEach((b, i) => out.set(b, Buffer.from(plain[i], 'base64').toString('utf8')));
  for (const b of blobs) if (b.startsWith('none1:')) { if (PROTECTION !== 'none') throw new Error('unprotected state refused'); out.set(b, Buffer.from(b.slice(6), 'base64').toString('utf8')); }
  return out;
};
let state = { clients: {}, grants: {} };
let legacyPlainGrants = 0, droppedGrants = 0;
async function loadState() {
  let raw; try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return; /* first run */ }
  state.clients = raw.clients ?? {};
  const entries = Object.entries(raw.grants ?? {});
  const blobs = entries.map(([, g]) => g.pairingTokenEnc).filter(Boolean);
  let opened = new Map();
  try { opened = await unprotectTokens(blobs); } catch (e) { droppedGrants += blobs.length; audit(`state: could not open protected pairings (${e instanceof Error ? e.message : 'error'}); those pairings must be re-paired`); }
  for (const [h, g] of entries) {
    if (g.pairingTokenEnc) { const t = opened.get(g.pairingTokenEnc); if (t) state.grants[h] = { clientId: g.clientId, pairingId: g.pairingId, token: t, enc: g.pairingTokenEnc }; else droppedGrants++; }
    else if (typeof g.pairingToken === 'string') { state.grants[h] = { clientId: g.clientId, pairingId: g.pairingId, token: g.pairingToken }; legacyPlainGrants++; }
  }
  if (PROTECTION === 'none') audit('state protection is OFF (test mode)');
  if (legacyPlainGrants) audit(`state: ${legacyPlainGrants} legacy plaintext pairing(s) loaded unchanged; run "node server.mjs --migrate-state" to protect them`);
}
const persisted = () => ({ clients: state.clients, grants: Object.fromEntries(Object.entries(state.grants).map(([h, g]) => [h, { clientId: g.clientId, pairingId: g.pairingId, ...(g.enc ? { pairingTokenEnc: g.enc } : { pairingToken: g.token }) }])) });
const save = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = `${STATE_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(persisted(), null, 1), { mode: 0o600 }); fs.renameSync(tmp, STATE_FILE); };
async function migrateState() {
  let n = 0; for (const g of Object.values(state.grants)) if (!g.enc) { g.enc = await protectToken(g.token); n++; }
  if (n) save();
  return n;
}
await loadState();
if (process.argv.includes('--migrate-state')) { const n = await migrateState(); audit(`state: migrated ${n} plaintext pairing(s) to DPAPI (explicit request)`); console.log(JSON.stringify({ migrated: n })); process.exit(0); }
/** A pairing Core no longer accepts (revoked in Pandesh): forget every grant and access token that carries it, so a refresh cannot revive it. */
function dropPairing(token) {
  let n = 0;
  for (const [h, g] of Object.entries(state.grants)) if (g.token === token) { delete state.grants[h]; n++; }
  for (const [h, a] of access) if (a.pairingToken === token) { access.delete(h); n++; }
  if (n) { save(); audit(`pairing no longer accepted by Pandesh; ${n} grant(s) forgotten`); }
}
const pending = new Map();   // authorization codes (memory only, 5 minutes)
const access = new Map();    // access token hash -> { clientId, pairingToken, exp }

// ------------------------------------------------------------------ Core (existing Panda Bridge lifecycle)
const coreInfo = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'core.json'), 'utf8'));
async function core(method, p, body, pairingToken) {
  const port = coreInfo().port;
  const headers = { authorization: `Bearer ${fs.readFileSync(path.join(DATA_DIR, 'core.token'), 'utf8').trim()}`, 'content-type': 'application/json', 'x-client-id': 'mcp-gateway' };
  if (pairingToken) headers['x-panda-pairing'] = pairingToken;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (pairingToken && (r.status === 401 || r.status === 403)) dropPairing(pairingToken);
  return { status: r.status, body: j };
}

// ------------------------------------------------------------------ MCP tools
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const taskText = (t) => ({
  taskId: t.id, status: t.status, detail: t.statusDetail ?? null, executor: t.executor ?? null, control: t.control ?? null,
  ...(t.activity?.summary ? { activity: t.activity.summary } : {}), ...(t.approval ? { waitingForOwner: `Pandesh is asking the owner to approve ${t.approval.agentLabel}; nothing was sent yet.` } : {}),
  // What happened to the REQUESTED outcome (a finished worker is not a delivered change): state, summary, Pandesh's own test run.
  ...(t.result?.outcome ? { outcome: { kind: t.result.outcome.intent, state: t.result.outcome.state, summary: t.result.outcome.summary, tests: t.result.outcome.tests ?? null, workerExplanation: t.result.outcome.workerExplanation ?? null } } : {}),
  ...(t.sourceRef?.declaredIntent ? { declaredIntent: t.sourceRef.declaredIntent } : {}),
  ...(t.result?.steps ? { steps: t.result.steps.map((s) => ({ key: s.key, state: s.state, summary: s.summary })) } : {}),
});
const INTENTS = ['code_change', 'inspect', 'answer', 'research', 'operation'];
const TOOLS = [
  { name: 'pandesh_list_agents', description: 'List the agents and services Pandesh can run tasks on, and which are local or cloud (cloud agents need the owner\'s approval in the Pandesh app).', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'pandesh_submit_task', description: 'Give Pandesh a task to run on this PC. Local agents start at once; a cloud agent such as Claude Code only starts after the owner approves it in the Pandesh app. Returns a task id: use pandesh_task_status to follow it and pandesh_task_report for the result.', inputSchema: { type: 'object', properties: { instruction: { type: 'string', description: 'What to do. Name the registered project (or its path) for work on code.' }, intent: { type: 'string', enum: INTENTS, description: "What kind of task this is. 'code_change': change a registered read-write project's files (send `steps` for a multi-step mission) (the owner approves it, Pandesh runs the tests, the owner reviews the diff; nothing is pushed or merged). 'inspect': read-only look at a project. 'answer': a reply only. 'research': find out and report. 'operation': an action on the PC. Declaring a kind never grants permission; a read-only kind keeps the task read-only." }, executor: { type: 'string', description: "'auto' (default: a local agent or service), or an agent id from pandesh_list_agents such as 'claude'." }, steps: { type: 'array', description: 'Optional, with intent code_change: a mission of 2-6 steps run in dependency order in one private copy. The owner approves the mission once (a time-limited development grant); each step that passes Pandesh\'s own test run is committed in the copy and the next step starts; anything else waits for the owner.', items: { type: 'object', properties: { key: { type: 'string' }, instruction: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['instruction'] } } }, required: ['instruction'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'pandesh_list_projects', description: 'The projects registered in Pandesh (by name) and whether code changes are allowed there. Name one in a task to work on it.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'pandesh_updates', description: 'What changed since your last check: only tasks whose state changed after `since` (pass the `cursor` from the previous call), each with its outcome, mission steps and whether it needs the owner. An empty list means nothing changed. Use it to follow a backlog without repeating unchanged reports.', inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'The cursor from the previous pandesh_updates call (ISO time). Omit for everything.' } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'pandesh_task_status', description: 'Current state of a task. Set wait_seconds (up to 50) to wait for it to finish or change.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, wait_seconds: { type: 'number' } }, required: ['taskId'] }, annotations: { readOnlyHint: true } },
  { name: 'pandesh_task_report', description: 'The result of a finished task: what was done, what was verified, and the evidence. Call it when the status is completed.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, annotations: { readOnlyHint: true } },
  { name: 'pandesh_cancel_task', description: 'Stop a task that is waiting or running.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], structuredContent: typeof obj === 'string' ? undefined : obj });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const errText = (r) => r.body?.error?.message ?? (typeof r.body === 'string' ? r.body : `Pandesh answered ${r.status}`);

async function callTool(name, args, grant) {
  const tok = grant.pairingToken;
  if (name === 'pandesh_list_agents') {
    const r = await core('GET', '/v1/bridge/executors', null, tok); if (r.status !== 200) return fail(errText(r));
    return ok({ agents: r.body.executors.filter((e) => e.available && e.dispatchable).map((e) => ({ id: e.id, label: e.label, cloud: e.external, note: e.external ? 'needs the owner\'s approval in the Pandesh app' : 'runs on this PC' })) });
  }
  if (name === 'pandesh_submit_task') {
    const instruction = String(args.instruction ?? '').trim(); if (!instruction) return fail('instruction is required');
    const intent = args.intent === undefined || args.intent === null || args.intent === '' ? undefined : String(args.intent);
    if (intent !== undefined && !INTENTS.includes(intent)) return fail(`intent must be one of ${INTENTS.join(', ')}`);
    const sub = await core('POST', '/v1/bridge/tasks', { clientRequestId: `mcp-${Date.now()}-${rand(4)}`, instruction, ...(intent ? { intent } : {}), ...(Array.isArray(args.steps) ? { steps: args.steps } : {}), sourceRef: { kind: 'chatgpt', title: 'ChatGPT connector', via: 'mcp' } }, tok);
    if (sub.status >= 300) return fail(errText(sub));
    const id = sub.body.taskId; const executor = String(args.executor || 'auto');
    const d = await core('POST', `/v1/bridge/tasks/${id}/dispatch`, { executor }, tok);
    audit(`submit task=${id} executor=${executor} dispatch=${d.status} started=${d.body?.started === true}`);
    if (d.status >= 300) return fail(`${errText(d)} (the task ${id} was created but not started)`);
    return ok({ ...taskText({ ...d.body.task, approval: d.body.approval }), started: d.body.started === true });
  }
  if (name === 'pandesh_list_projects') {
    const r = await core('GET', '/v1/bridge/project-names', null, tok); return r.status === 200 ? ok(r.body) : fail(errText(r));
  }
  if (name === 'pandesh_updates') {
    const since = typeof args.since === 'string' && !Number.isNaN(Date.parse(args.since)) ? `?since=${encodeURIComponent(args.since)}` : '';
    const r = await core('GET', `/v1/bridge/updates${since}`, null, tok); return r.status === 200 ? ok(r.body) : fail(errText(r));
  }
  const id = String(args.taskId ?? ''); if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return fail('taskId is not valid');
  if (name === 'pandesh_task_status') {
    const until = Date.now() + Math.min(50, Math.max(0, Number(args.wait_seconds) || 0)) * 1000; let last = '';
    for (;;) {
      const r = await core('GET', `/v1/bridge/tasks/${id}`, null, tok); if (r.status !== 200) return fail(errText(r));
      const t = r.body.task ?? r.body; const sig = `${t.status}|${t.statusDetail}|${t.control}`;
      if (TERMINAL.has(t.status) || Date.now() >= until || (last && sig !== last)) return ok(taskText({ ...t, approval: r.body.approval, activity: r.body.activity }));
      last = last || sig; await new Promise((res) => setTimeout(res, 2500));
    }
  }
  if (name === 'pandesh_task_report') {
    const r = await core('GET', `/v1/bridge/tasks/${id}`, null, tok); if (r.status !== 200) return fail(errText(r));
    const t = r.body.task ?? r.body;
    // A task waiting on the owner or needing attention has no final report, but its outcome (why it stopped, the worker's own words) is told.
    if (!TERMINAL.has(t.status)) return ok({ ...taskText(t), note: t.status === 'needs_attention' ? 'Stopped before the requested outcome; see outcome. The owner decides in Pandesh.' : t.status === 'awaiting_approval' ? 'Waiting for the owner in Pandesh; see outcome.' : 'Not finished yet; there is no report. Use pandesh_task_status.' });
    const { activity: _log, ...report } = t.result ?? {};
    return ok({ ...taskText(t), report: t.report ?? (t.result ? report : null) });
  }
  if (name === 'pandesh_cancel_task') {
    const r = await core('POST', `/v1/bridge/tasks/${id}/cancel`, {}, tok); audit(`cancel task=${id} status=${r.status}`);
    return r.status === 200 ? ok(taskText(r.body.task ?? r.body)) : fail(errText(r));
  }
  return fail(`unknown tool ${name}`);
}

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
async function rpc(msg, grant) {
  const { id, method, params } = msg;
  const result = (r) => ({ jsonrpc: '2.0', id, result: r });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') return result({ protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pandesh', version: '0.1.8' }, instructions: 'Pandesh runs tasks on the owner\'s PC. Local work starts at once; cloud agents wait for the owner\'s approval in the Pandesh app.' });
  if (method === 'ping') return result({});
  if (method === 'tools/list') return result({ tools: TOOLS });
  if (method === 'tools/call') {
    if (!TOOLS.some((t) => t.name === params?.name)) return error(-32602, `unknown tool ${params?.name}`);
    try { return result(await callTool(params.name, params.arguments ?? {}, grant)); } catch (e) { return result(fail(`Pandesh could not be reached: ${e instanceof Error ? e.message : e}`)); }
  }
  return error(-32601, `method not found: ${method}`);
}

// ------------------------------------------------------------------ OAuth 2.1 (authorization code + PKCE, DCR)
const json = (res, status, obj, extra = {}) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(b); };
const readBody = (req) => new Promise((resolve, reject) => { let n = 0; const parts = []; req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else parts.push(c); }); req.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); req.on('error', reject); });
const form = (t) => Object.fromEntries(new URLSearchParams(t));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const redirectOk = (uri) => { try { const u = new URL(uri); return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)); } catch { return false; } };

function metadata() {
  return {
    resource: { resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC], bearer_methods_supported: ['header'], scopes_supported: ['pandesh.tasks'] },
    server: { issuer: PUBLIC, authorization_endpoint: AUTHORIZE_URL, token_endpoint: `${PUBLIC}/token`, registration_endpoint: `${PUBLIC}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['pandesh.tasks'] },
  };
}
const challenge = (res) => json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"` });
// form-action must also name the registered redirect origin: browsers apply it to the redirect that follows the form POST, so with 'self' alone the
// 302 back to the client (ChatGPT) is blocked and the consent page just stays on screen. The origin comes only from a redirect_uri already matched to a registered client.
const page = (res, status, html, redirectUri) => { let o = ''; try { if (redirectUri) o = ` ${new URL(redirectUri).origin}`; } catch { /* none */ } res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${o}`, 'x-frame-options': 'DENY' }); res.end(`<!doctype html><meta charset=utf-8><title>Connect ChatGPT to Pandesh</title><body style="font:16px system-ui;max-width:34em;margin:3em auto;padding:0 1em">${html}`); };

async function handle(req, res, secure = true) {
  const url = new URL(req.url, PUBLIC); const p = url.pathname;
  if (TLS_PORT && !secure && p !== '/authorize' && p !== '/healthz') return json(res, 404, { error: 'not_found' });   // plain listener: browser consent page only
  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, metadata().resource);
  if (p === '/.well-known/oauth-authorization-server') return json(res, 200, metadata().server);
  if (p === '/register' && req.method === 'POST') {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid_client_metadata' }); }
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectOk)) return json(res, 400, { error: 'invalid_redirect_uri' });
    if (Object.keys(state.clients).length >= 50) return json(res, 429, { error: 'too many registered clients; the owner must clear mcp-gateway.json' });
    const clientId = `c_${rand(12)}`; state.clients[clientId] = { name: String(b.client_name ?? 'client').slice(0, 80), redirectUris: uris, at: new Date().toISOString() }; save();
    audit(`register client=${clientId} name=${state.clients[clientId].name}`);
    return json(res, 201, { client_id: clientId, client_name: state.clients[clientId].name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  }
  if (p === '/authorize') {
    const q = req.method === 'POST' ? form(await readBody(req)) : Object.fromEntries(url.searchParams);
    const c = state.clients[q.client_id];
    if (!c || !c.redirectUris.includes(q.redirect_uri)) return page(res, 400, '<h2>Unknown application</h2><p>This sign-in request does not match a registered application.</p>');
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) return page(res, 400, '<h2>Request refused</h2><p>PKCE (S256) is required.</p>');
    const back = (params) => { const u = new URL(q.redirect_uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (q.state) u.searchParams.set('state', q.state); res.writeHead(302, { location: u.toString() }); res.end(); };
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map((k) => `<input type=hidden name=${k} value="${esc(q[k] ?? '')}">`).join('');
    if (req.method !== 'POST') return page(res, 200, `<h2>Let “${esc(c.name)}” use Pandesh?</h2><p>It will be able to give Pandesh tasks, follow them and read their reports. Cloud agents still need your approval in the Pandesh app each time.</p><p>In the Pandesh app, create a <b>browser pairing code</b> and type it here. This proves you are at this PC.</p><form method=post>${hidden}<input name=code autocomplete=off maxlength=8 style="font:20px monospace;width:8em" autofocus> <button>Allow</button> <button name=deny value=1 formnovalidate>Deny</button></form>`, q.redirect_uri);
    if (q.deny) { audit(`deny client=${q.client_id}`); return back({ error: 'access_denied' }); }
    const r = await core('POST', '/v1/bridge/pair', { code: String(q.code ?? '').trim().toUpperCase(), label: `ChatGPT connector (${c.name})`.slice(0, 80), extensionId: null });
    if (r.status >= 300 || !r.body?.token) return page(res, 403, '<h2>That code did not work</h2><p>It may have expired or been used. Create a new one in Pandesh and try again.</p>');
    const code = rand(24); pending.set(sha(code), { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, pairingToken: r.body.token, pairingId: r.body.pairingId, exp: Date.now() + CODE_TTL * 1000 });
    audit(`consent client=${q.client_id} pairing=${r.body.pairingId}`);
    return back({ code });
  }
  if (p === '/token' && req.method === 'POST') {
    const b = form(await readBody(req)); const fail400 = (e) => json(res, 400, { error: e });
    const issue = async (clientId, pairingToken, pairingId) => {
      const at = rand(32), rt = rand(32);
      const enc = await protectToken(pairingToken);   // fail closed: if the token cannot be protected, nothing is issued
      access.set(sha(at), { clientId, pairingToken, exp: Date.now() + ACCESS_TTL * 1000 });
      state.grants[sha(rt)] = { clientId, pairingId, token: pairingToken, enc }; save();
      return json(res, 200, { access_token: at, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: rt, scope: 'pandesh.tasks' });
    };
    if (b.grant_type === 'authorization_code') {
      const e = pending.get(sha(b.code ?? '')); pending.delete(sha(b.code ?? ''));
      if (!e || e.exp < Date.now() || e.clientId !== b.client_id || e.redirectUri !== b.redirect_uri) return fail400('invalid_grant');
      if (crypto.createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url') !== e.challenge) return fail400('invalid_grant');
      return await issue(e.clientId, e.pairingToken, e.pairingId);
    }
    if (b.grant_type === 'refresh_token') {
      const g = state.grants[sha(b.refresh_token ?? '')]; if (!g || g.clientId !== b.client_id) return fail400('invalid_grant');
      // A refresh must not revive a pairing the owner revoked in Pandesh: ask Core first (a revoked pairing is answered 401 and forgotten).
      const live = await core('GET', '/v1/bridge/status', null, g.token); if (live.status === 401 || live.status === 403) return fail400('invalid_grant');
      delete state.grants[sha(b.refresh_token)]; return await issue(g.clientId, g.token, g.pairingId);   // rotation: a refresh token works once
    }
    return fail400('unsupported_grant_type');
  }
  if (p === '/mcp') {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? '')); const g = m && access.get(sha(m[1]));
    if (!g || g.exp < Date.now()) return challenge(res);
    if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let msg; try { msg = JSON.parse(await readBody(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const msgs = Array.isArray(msg) ? msg : [msg]; const out = [];
    for (const one of msgs) { if (one && one.id === undefined) continue; out.push(await rpc(one, g)); }
    if (!out.length) { res.writeHead(202); return res.end(); }
    return json(res, 200, Array.isArray(msg) ? out : out[0]);
  }
  if (p === '/healthz') return json(res, 200, { ok: true });
  json(res, 404, { error: 'not_found' });
}

const onRequest = (secure) => (req, res) => { handle(req, res, secure).catch((e) => { try { json(res, 500, { error: 'server_error' }); } catch { /* closed */ } audit(`error ${e instanceof Error ? e.message : e}`); }); };
const server = http.createServer(onRequest(false));
server.listen(PORT, '127.0.0.1', () => { console.log(JSON.stringify({ gateway: 'pandesh-mcp', listening: `127.0.0.1:${PORT}`, publicUrl: PUBLIC, authorizeUrl: AUTHORIZE_URL, tls: TLS_PORT || false, dataDir: DATA_DIR })); });
if (TLS_PORT) {
  if (PRODUCTION_PORTS.has(TLS_PORT) || TLS_PORT === PORT) { console.error('REFUSED: bad TLS port'); process.exit(2); }
  let tlsOpts; try { tlsOpts = { key: fs.readFileSync(path.join(TLS_DIR, 'gateway-key.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'gateway-cert.pem')), minVersion: 'TLSv1.2' }; } catch { console.error(`REFUSED: TLS mode needs gateway-key.pem and gateway-cert.pem in ${TLS_DIR}`); process.exit(2); }
  https.createServer(tlsOpts, onRequest(true)).listen(TLS_PORT, '127.0.0.1', () => audit(`tls listener 127.0.0.1:${TLS_PORT}`));
}
