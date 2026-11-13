// M0 live-eval driver: an ISOLATED Core (this tree's out-core/core.js) on a throwaway profile, driven over its real
// HTTP API exactly as the desktop host does. Independent checks read the file system and the isolated profile's DB.
// Nothing here touches the production profile, Google accounts or the network except through the model/tools under test.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RC = path.resolve(process.env.EVAL_RC ?? path.join(HERE, '..', '..')); // tree holding out-core/core.js
export const LABEL = process.env.EVAL_LABEL ?? 'local';
export const ROOT = process.env.EVAL_ROOT ?? `D:/PandeshRecoveryEval/${LABEL}`; // outside the repo
export const DATA = path.join(ROOT, 'profile');
export const PORT = Number(process.env.EVAL_PORT ?? 58941);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cachedSecrets;
export function secrets() {
  if (cachedSecrets) return cachedSecrets;
  fs.mkdirSync(ROOT, { recursive: true });
  const f = path.join(ROOT, 'secrets.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ token: crypto.randomBytes(24).toString('hex'), host: crypto.randomBytes(24).toString('hex') }));
  return (cachedSecrets = JSON.parse(fs.readFileSync(f, 'utf8')));
}

export function startCore(extraEnv = {}) {
  const s = secrets();
  fs.mkdirSync(DATA, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|KARKEDIKHA_|PANDESH_|ELECTRON_|NODE_OPTIONS|ANTHROPIC|GOOGLE|OPENAI)/i.test(k)) env[k] = v;
  Object.assign(env, {
    KARKEDIKHA_DATA_DIR: DATA, KARKEDIKHA_CORE_TOKEN: s.token, KARKEDIKHA_HOST_TOKEN: s.host, KARKEDIKHA_CORE_PORT: String(PORT),
    KARKEDIKHA_IMAGE_STUDIO_URL: 'http://127.0.0.1:59999', // dead on purpose: the eval never drives ComfyUI
    ...extraEnv,
  });
  const out = fs.openSync(path.join(ROOT, 'core.log'), 'a');
  const child = spawn(process.execPath, [path.join(RC, 'out-core', 'core.js')], { cwd: RC, env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.writeFileSync(path.join(ROOT, 'core.pid'), String(child.pid));
  return child.pid;
}
export function killCore() {
  try { const pid = Number(fs.readFileSync(path.join(ROOT, 'core.pid'), 'utf8')); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export async function api(p, { method = 'GET', body, host = false } = {}) {
  const s = secrets();
  const headers = { Authorization: `Bearer ${s.token}`, 'X-Client-Id': 'live-eval' };
  if (host) headers['X-Host-Token'] = s.host;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
  return json;
}
export async function waitCore(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { await api('/v1/core/info'); return true; } catch { await sleep(1000); } }
  return false;
}
/** Read-only SQL against the isolated profile (never production). */
export function sql(query, ...params) {
  const db = new DatabaseSync(path.join(DATA, 'core.db'), { readOnly: true });
  try { return db.prepare(query).all(...params); } finally { db.close(); }
}

export async function newConversation(title) { return api('/v1/conversations', { method: 'POST', body: { mode: 'saath_kar', title } }); }

const TERMINAL = ['completed', 'failed', 'cancelled'];
/** Submit one user message through the same endpoints the host uses and wait for a settled attempt. */
export async function turn(conversationId, message, { policy = () => 'rejected', workspace, model, timeoutMs = 420000, onAttempt, killAfterMs, killWhen } = {}) {
  const body = {
    currentMessage: message, requestedMode: 'saath_kar', conversationId,
    workspaceRoot: workspace ?? undefined, hasWorkspace: Boolean(workspace), gitCapable: false,
    toolPermissionPolicy: { profile: 'local-core-question', worker: 'local-core', ...(workspace ? { workspaceAccess: 'read_write' } : {}) },
    uiSurface: 'v2',
    ...(model ? { requestedProvider: 'ollama', requestedModel: model } : { autoSelectModel: true }),
  };
  const t0 = Date.now();
  const sub = await api('/v1/submit', { method: 'POST', body });
  const attemptId = sub.attempt.id;
  await api(`/v1/attempts/${attemptId}/execute`, { method: 'POST', body: workspace ? { workingDirectory: workspace } : {} });
  if (onAttempt) onAttempt(attemptId);
  const decisions = []; let att; let killed = false;
  while (Date.now() - t0 < timeoutMs) {
    if (!killed && ((killAfterMs && Date.now() - t0 > killAfterMs) || (killWhen && killWhen(attemptId)))) { killCore(); killed = true; return { attemptId, killed: true, ms: Date.now() - t0, decisions }; }
    try {
      const pend = (await api('/v1/approvals/pending')).approvals ?? [];
      for (const a of pend) {
        const choice = policy(a);
        decisions.push({ summary: String(typeof a.summary === 'string' ? a.summary : JSON.stringify(a.summary)).slice(0, 160), choice });
        try { await api(`/v1/assistant/approvals/${a.id}/resolve`, { method: 'POST', body: { resolution: choice }, host: true }); } catch (e) { decisions.push({ error: String(e.message).slice(0, 160) }); }
      }
    } catch { /* ignore */ }
    att = await api(`/v1/attempts/${attemptId}`);
    if (TERMINAL.includes(att.status ?? att.attempt?.status)) break;
    for (let i = 0; i < 60; i++) { await sleep(25); if (killWhen && killWhen(attemptId)) break; } // fine-grained so a kill lands at the chosen point
  }
  return { attemptId, ms: Date.now() - t0, status: att?.status, resultStatus: att?.resultStatus ?? null, resultReason: att?.resultReason ?? null, failureReason: att?.failureReason ?? null, decisions, ...(await evidence(conversationId, attemptId)) };
}

export async function evidence(conversationId, attemptId) {
  const msgs = (await api(`/v1/conversations/${conversationId}/messages`)).messages ?? [];
  const reply = [...msgs].reverse().find((m) => m.role === 'assistant');
  let tools = []; let models = [];
  try { const r = await api(`/v1/attempts/${attemptId}/tool-invocations`); tools = r.toolInvocations ?? r.invocations ?? r; } catch {}
  try { const r = await api(`/v1/attempts/${attemptId}/model-invocations`); models = r.modelInvocations ?? r.invocations ?? r; } catch {}
  const outcome = sql('select status, blocker, summary from task_outcomes where attemptId = ?', attemptId)[0] ?? null;
  let journal = []; try { journal = sql('select toolName, status, effect, substr(resultText,1,240) r from tool_execution_journal where attemptId = ? order by seq', attemptId); } catch {}
  return {
    journal, reply: reply?.content ?? null, taskOutcome: outcome,
    tools: Array.isArray(tools) ? tools.map((t) => ({ tool: t.toolName, status: t.status, args: String(typeof t.argsSummary === 'string' ? t.argsSummary : JSON.stringify(t.argsSummary ?? '')).slice(0, 140) })) : [],
    models: Array.isArray(models) ? models.map((m) => ({ model: m.actualModel ?? m.requestedModel, provider: m.actualProvider, status: m.status, ms: m.latencyMs })) : [],
  };
}

export const DANGER = /\b(send|post|publish|delete|remove|uninstall|registry|install|pay|purchase|email|gmail|push|share)\b/i;
export const inside = (a, dir) => JSON.stringify(a).toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/').includes(dir.toLowerCase().replace(/\\/g, '/'));
const toolOf = (a) => { try { const x = typeof a.summary === 'string' ? JSON.parse(a.summary) : a.summary; return String(x?.toolName ?? ''); } catch { return ''; } };
/** Approve this program's own tool classes and anything confined to the scenario workspace; refuse the rest. The decision
 *  reads the approval's tool name, never free text (a 'project' word in a search-permission card once matched). */
export const standardPolicy = (ws) => (a) => {
  const t = JSON.stringify(a); const tool = toolOf(a);
  if (/^(memory_|create_reminder|create_project|add_task|update_task|create_commitment|schedule_task|create_note)/.test(tool)) return 'approved';
  if (tool === 'request_search_permission') { try { const roots = JSON.parse(a.summary).proposedRoots ?? []; return roots.length && roots.every((r) => inside(r, ws)) ? 'approved' : 'rejected'; } catch { return 'rejected'; } }
  if (ws && inside(a, ws) && !DANGER.test(t)) return 'approved';
  return 'rejected';
};
