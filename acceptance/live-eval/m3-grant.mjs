// Standing write permission, end to end on the real stack (owner decision 2026-11-13): two real routines created through chat, the
// owner grants one standing write permission each THROUGH THE HOST API (confirm:true), then 5 simulated days of the REAL scheduler.
// There is no owner-approval pump: any approval card that appears is counted and REJECTED, so a write that happens did so on the
// grant alone. Independent checks read the files, the profile DB (mission authorization source, grant-use rows, final disk check) and
// the notification outbox.
//   day 1-2  both granted: each run writes fresh content (the harness removes the file first), no card, audited, verified
//   day 3    A's permission revoked by the owner: A must NOT write (a card appears, is rejected), B unaffected
//   day 4    B's instruction changed (a material change): B must NOT write; A still has no permission
//   day 5    A granted again: A writes without a card; B (changed) still asks
// node acceptance/live-eval/m3-grant.mjs   (EVAL_LABEL=...; build the bundle first)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { api, newConversation, turn, standardPolicy, sql, killCore, startCore, waitCore, sleep, DATA, ROOT, LABEL, HERE, PORT, RC } from './lib.mjs';

const freePort = () => { try { for (const line of execSync('netstat -ano -p tcp', { encoding: 'utf8' }).split(/\r?\n/)) { const m = line.match(new RegExp(`127\\.0\\.0\\.1:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`)); if (m) execSync(`taskkill /PID ${m[1]} /F`); } } catch { /* none */ } };
freePort(); killCore(); await sleep(1500); fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });
startCore(); if (!(await waitCore(90000))) { console.error('Core did not start'); process.exit(2); }
let commit = ''; try { commit = execSync('git rev-parse --short HEAD', { cwd: RC, encoding: 'utf8' }).trim(); } catch { /* none */ }

const WS = { A: path.join(ROOT, 'ws', 'a').replace(/\\/g, '/'), B: path.join(ROOT, 'ws', 'b').replace(/\\/g, '/') };
for (const w of Object.values(WS)) fs.mkdirSync(w, { recursive: true });
const wr = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
wr(path.join(WS.B, 'inbox', 'one.txt'), '1'); wr(path.join(WS.B, 'inbox', 'two.txt'), '2');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const wdb = (fn) => { const db = new DatabaseSync(path.join(DATA, 'core.db')); try { db.exec('PRAGMA busy_timeout = 5000'); return fn(db); } finally { db.close(); } };
const setDue = (ids) => wdb((db) => { const st = db.prepare('UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?'); for (const id of ids) st.run(new Date(Date.now() - 5000).toISOString(), id); });
const task = (id) => sql('select id, title, instruction, enabled, nextRunAt, lastAttemptId, scopeJson from scheduled_tasks where id = ?', id)[0];

const SPECS = {
  A: { ws: WS.A, ask: 'Every day at 03:17 write today\'s date (as YYYY-MM-DD, nothing else) into reports/date.txt in this folder, replacing what is there. Set that up as a scheduled routine.' },
  B: { ws: WS.B, ask: 'Every day at 03:18 count the files in the inbox folder and write only that number into reports/inbox-count.txt in this folder, replacing what is there. Set that up as a scheduled routine.' },
};
const ids = {}; const setup = [];
for (const [k, s] of Object.entries(SPECS)) {
  const before = new Set(sql('select id from scheduled_tasks').map((r) => r.id));
  const conv = await newConversation(`Grant ${k}`);
  const t = await turn(conv.id, s.ask, { policy: standardPolicy(s.ws), workspace: s.ws, timeoutMs: 240000 });
  const made = sql('select id, scopeJson from scheduled_tasks').filter((r) => !before.has(r.id));
  ids[k] = made[0]?.id; setup.push({ routine: k, created: made.length === 1, result: t.resultStatus });
  console.log(`setup ${k}: created=${made.length} result=${t.resultStatus}`);
}
if (Object.values(ids).some((v) => !v)) { console.error('a routine was not created', setup); process.exit(3); }

// the approval pump REJECTS: a write that lands did so on the standing permission alone
let cardsRejected = 0; const cardTools = [];
const pump = setInterval(async () => { try { for (const a of (await api('/v1/approvals/pending')).approvals ?? []) { cardsRejected++; cardTools.push(a.summary?.toolName ?? a.toolName ?? '?'); await api(`/v1/assistant/approvals/${a.id}/resolve`, { method: 'POST', body: { resolution: 'rejected' }, host: true }); } } catch { /* none */ } }, 1500);

const grant = (k) => api(`/v1/scheduled-tasks/${ids[k]}/write-grant`, { method: 'POST', body: { confirm: true }, host: true });
const revoke = (k) => api(`/v1/scheduled-tasks/${ids[k]}/write-grant`, { method: 'DELETE', host: true });
const grantState = (k) => api(`/v1/scheduled-tasks/${ids[k]}/write-grant`, { host: true });
const g = {}; for (const k of Object.keys(ids)) g[k] = await grant(k);
// an ordinary client must not be able to grant (no host token)
const clientCannot = await fetch(`http://127.0.0.1:${PORT}/v1/scheduled-tasks/${ids.A}/write-grant`, { method: 'POST', headers: { Authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.json'), 'utf8')).token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'x-client', 'X-Client-Id': 'live-eval' }, body: JSON.stringify({ confirm: true }) }).then((r) => r.status).catch(() => -1);
console.log(`granted: ${JSON.stringify(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.grant.id])))} ordinaryClientGrantStatus=${clientCannot}`);

async function waitRun(id, prevAttempt, ms = 360000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = task(id);
    if (t.lastAttemptId && t.lastAttemptId !== prevAttempt) {
      const a = await api(`/v1/attempts/${t.lastAttemptId}`);
      if (['completed', 'failed', 'cancelled'].includes(a.status)) { await sleep(4000); if (task(id).lastAttemptId !== t.lastAttemptId) continue; } if (['completed', 'failed', 'cancelled'].includes(a.status)) return { attemptId: t.lastAttemptId, status: a.status, resultStatus: a.resultStatus, reason: a.resultReason ?? a.failureReason ?? null };
    }
    await sleep(2500);
  }
  return null;
}
const audit = (attemptId) => ({
  source: sql('select authorizedBy from mission_authorizations where attemptId = ?', attemptId)[0]?.authorizedBy ?? null,
  uses: sql('select path, readbackMatched, finalCheck from routine_write_grant_uses where attemptId = ?', attemptId),
  events: sql("select eventType from runtime_events where entityId = ? and eventType in ('routine_run_verified','routine_run_verification_failed','standing_grant_not_applied','file_write_authorized')", attemptId).map((e) => e.eventType),
});

const days = [];
const expected = (k, d) => (k === 'A' ? (d === 3 || d === 4 ? 'asks' : 'writes') : (d >= 4 ? 'asks' : 'writes'));
for (let d = 1; d <= 5; d++) {
  const day = { day: d, checks: {}, ok: true };
  const prev = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, task(id).lastAttemptId]));
  wr(path.join(WS.B, 'inbox', `f${d}.txt`), String(d)); const expectedB = 2 + d;
  if (d === 3) { const r = await revoke('A'); day.checks.revokeA = { revoked: r.revoked, state: (await grantState('A')).active, ok: r.revoked === 1 }; if (!day.checks.revokeA.ok) day.ok = false; }
  if (d === 4) { wdb((db) => db.prepare('UPDATE scheduled_tasks SET instruction = instruction || ? WHERE id = ?').run(' Also keep a copy of the number in reports/backup.txt.', ids.B)); }
  if (d === 5) { const r = await grant('A'); day.checks.regrantA = { id: r.grant.id, ok: !!r.grant.id }; }
  // fresh file every day: a write that lands is a real write, not an UNCHANGED no-op
  fs.rmSync(path.join(WS.A, 'reports', 'date.txt'), { force: true }); fs.rmSync(path.join(WS.B, 'reports', 'inbox-count.txt'), { force: true }); fs.rmSync(path.join(WS.B, 'reports', 'backup.txt'), { force: true });
  const cardsBefore = cardsRejected; const t0 = Date.now(); setDue(Object.values(ids));
  for (const k of Object.keys(ids)) {
    const r = await waitRun(ids[k], prev[k]); const c = { run: r, expected: expected(k, d) }; day.checks[k] = c;
    if (!r) { day.ok = false; c.problem = 'did not run in time'; continue; }
    const a = audit(r.attemptId); c.audit = a;
    const file = k === 'A' ? path.join(WS.A, 'reports', 'date.txt') : path.join(WS.B, 'reports', 'inbox-count.txt'); const v = (rd(file) ?? '').trim();
    if (c.expected === 'writes') {
      const right = k === 'A' ? v === today() : v === String(expectedB);
      c.ok = right && r.status === 'completed' && r.resultStatus === 'completed' && a.source?.startsWith('standing_grant:') && a.uses.length >= 1 && a.uses.every((u) => u.readbackMatched === 1 && u.finalCheck === 'match') && a.events.includes('routine_run_verified');
      c.why = `file=${JSON.stringify(v)} source=${a.source} uses=${a.uses.length} verified=${a.events.includes('routine_run_verified')}`;
    } else {
      const noted = sql('select count(*) n from notification_outbox where sourceId = ?', `sched-run:${r.attemptId}`)[0].n;
      c.ok = v === '' && r.resultStatus !== 'completed' && !a.uses.length && !String(a.source ?? '').startsWith('standing_grant:') && noted === 1;
      c.why = `file=${JSON.stringify(v)} result=${r.resultStatus} source=${a.source} notified=${noted} notApplied=${a.events.includes('standing_grant_not_applied')}`;
    }
    if (!c.ok) day.ok = false;
  }
  const cardsToday = cardsRejected - cardsBefore; day.checks.cardsRejected = cardsToday;
  day.seconds = Math.round((Date.now() - t0) / 1000); days.push(day);
  console.log(`day ${d}: ${day.ok ? 'OK' : 'FAIL'} ${day.seconds}s cardsRejected=${cardsToday} ${JSON.stringify(Object.fromEntries(Object.keys(ids).map((k) => [k, `${day.checks[k]?.expected}:${day.checks[k]?.ok}:${day.checks[k]?.why ?? day.checks[k]?.problem}`])))}`.slice(0, 600));
}
clearInterval(pump);
const noCardOnGrantedDays = days.filter((x) => x.day <= 2).every((x) => x.checks.cardsRejected === 0);
const history = ['A', 'B'].map((k) => sql('select id, status, revokedBy, revokeReason from routine_write_grants where taskId = ? order by grantedAt', ids[k]));
const out = { label: LABEL, commit, at: new Date().toISOString(), note: 'days are simulated by making each routine due; scheduler, executor, grants, approvals and notifications are real; the approval pump rejects every card', setup, ordinaryClientGrantStatus: clientCannot, noCardOnGrantedDays, cardsRejectedTotal: cardsRejected, cardTools, grantHistory: history, days, allDaysOk: days.every((x) => x.ok) && noCardOnGrantedDays && clientCannot === 403 };
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.json`), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.md`), [`# Standing write permission ${LABEL} (${commit})`, '', `All days as expected: **${out.allDaysOk}**; ordinary client grant -> HTTP ${clientCannot}; cards on granted days: ${noCardOnGrantedDays ? 0 : '>0'}`, '', '| day | ok | detail |', '|---|---|---|', ...days.map((x) => `| ${x.day} | ${x.ok ? 'ok' : 'FAIL'} | ${Object.keys(ids).map((k) => `${k}: ${x.checks[k]?.expected} ${x.checks[k]?.why ?? x.checks[k]?.problem}`).join(' ; ').replace(/\|/g, '/').slice(0, 300)} |`)].join('\n'));
console.log(`all days ok: ${out.allDaysOk}`);
process.exit(0);
