// M3 routine evaluation: three real routines created through chat (frozen folder + access), then up to 14 simulated days of
// the REAL scheduler. A simulated day = the harness makes each routine due (nextRunAt = now) in the throwaway profile; the scheduler
// then claims, submits and executes it exactly as it does at the real time. Independent checks read the files, the profile DB and
// the notification outbox. Special days: day 4 deletes one routine's folder (must NOT run, owner is notified), day 6 kills Core
// while a routine runs (must be reported as interrupted, nothing replayed). The gate: 7 consecutive days with every expectation met.
// node acceptance/live-eval/m3-routines.mjs   (EVAL_LABEL=...; build the bundle first)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { api, newConversation, turn, standardPolicy, sql, killCore, startCore, waitCore, sleep, DATA, ROOT, LABEL, HERE, PORT, RC } from './lib.mjs';

const freePort = () => { try { for (const line of execSync('netstat -ano -p tcp', { encoding: 'utf8' }).split(/\r?\n/)) { const m = line.match(new RegExp(`127\\.0\\.0\\.1:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`)); if (m) execSync(`taskkill /PID ${m[1]} /F`); } } catch { /* none */ } };
freePort(); killCore(); await sleep(1500); fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true });
startCore(); if (!(await waitCore(90000))) { console.error('Core did not start'); process.exit(2); }
let commit = ''; try { commit = execSync('git rev-parse --short HEAD', { cwd: RC, encoding: 'utf8' }).trim(); } catch { /* none */ }

const WS = { A: path.join(ROOT, 'ws', 'a').replace(/\\/g, '/'), B: path.join(ROOT, 'ws', 'b').replace(/\\/g, '/'), C: path.join(ROOT, 'ws', 'c').replace(/\\/g, '/') };
for (const w of Object.values(WS)) fs.mkdirSync(w, { recursive: true });
const wr = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
wr(path.join(WS.B, 'inbox', 'one.txt'), '1'); wr(path.join(WS.B, 'inbox', 'two.txt'), '2');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const setDue = (ids) => { const db = new DatabaseSync(path.join(DATA, 'core.db')); try { db.exec('PRAGMA busy_timeout = 5000'); const st = db.prepare('UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?'); for (const id of ids) st.run(new Date(Date.now() - 5000).toISOString(), id); } finally { db.close(); } };
const task = (id) => sql('select id, title, enabled, nextRunAt, lastRunAt, lastAttemptId, scopeJson from scheduled_tasks where id = ?', id)[0];

// ---- create the three routines through chat (the model sets them up; Core freezes folder + access) ----
const SPECS = {
  A: { ws: WS.A, ask: 'Every day at 03:17 write today\'s date (as YYYY-MM-DD, nothing else) into reports/date.txt in this folder, replacing what is there. Set that up as a scheduled routine.' },
  B: { ws: WS.B, ask: 'Every day at 03:18 count the files in the inbox folder and write only that number into reports/inbox-count.txt in this folder, replacing what is there. Set that up as a scheduled routine.' },
  C: { ws: WS.C, ask: 'Every day at 03:19 write the word ok followed by today\'s date (like ok 2026-11-13) into logs/status.txt in this folder, replacing what is there. Set that up as a scheduled routine.' },
};
const ids = {}; const setup = [];
for (const [k, s] of Object.entries(SPECS)) {
  const before = new Set(sql('select id from scheduled_tasks').map((r) => r.id));
  const conv = await newConversation(`M3 ${k}`);
  const t = await turn(conv.id, s.ask, { policy: standardPolicy(s.ws), workspace: s.ws, timeoutMs: 240000 });
  const made = sql('select id, scopeJson from scheduled_tasks').filter((r) => !before.has(r.id));
  const scope = made[0] ? JSON.parse(made[0].scopeJson ?? 'null') : null;
  ids[k] = made[0]?.id;
  setup.push({ routine: k, created: made.length === 1, scopeFrozen: scope?.workspaceRoot?.replace(/\\/g, '/') === s.ws && scope?.workspaceAccess === 'read_write', scope, resultStatus: t.resultStatus });
  console.log(`setup ${k}: created=${made.length} scope=${JSON.stringify(scope)} result=${t.resultStatus}`);
}
if (Object.values(ids).some((v) => !v)) { console.error('a routine was not created; M3 cannot proceed', setup); fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.json`), JSON.stringify({ setup, aborted: true }, null, 2)); process.exit(3); }

const notes = (srcLike) => sql('select kind, sourceId, title, body, status from notification_outbox where sourceId like ?', srcLike);
const pump = setInterval(async () => { try { for (const a of (await api('/v1/approvals/pending')).approvals ?? []) await api(`/v1/assistant/approvals/${a.id}/resolve`, { method: 'POST', body: { resolution: 'rejected' }, host: true }); } catch { /* none */ } }, 2000); // a routine must never need an approval: refuse any
async function waitRun(id, prevAttempt, ms = 360000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = task(id);
    if (t.lastAttemptId && t.lastAttemptId !== prevAttempt) {
      const a = await api(`/v1/attempts/${t.lastAttemptId}`);
      if (['completed', 'failed', 'cancelled'].includes(a.status)) return { attemptId: t.lastAttemptId, status: a.status, resultStatus: a.resultStatus, reason: a.resultReason ?? a.failureReason ?? null };
    }
    await sleep(2500);
  }
  return null;
}
const days = []; let streak = 0; let best = 0;
for (let d = 1; d <= 14 && streak < 7; d++) {
  const day = { day: d, checks: {}, ok: true, notes: [] };
  const prev = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, task(id).lastAttemptId]));
  wr(path.join(WS.B, 'inbox', `f${d}.txt`), String(d));                      // B's expected count grows each day
  const expectedB = 2 + d - (d >= 5 ? 0 : 0);
  const folderGone = d === 4; const killDay = d === 6;
  if (folderGone) fs.renameSync(WS.C, WS.C + '_away');
  const t0 = Date.now(); setDue(Object.values(ids));
  const active = Object.keys(ids).filter((k) => !(folderGone && k === 'C'));
  let interruptedAttempt = null;
  if (killDay) {
    // wait for B to start, kill Core while it runs, restart, and check it is reported and not replayed
    const end = Date.now() + 240000; while (Date.now() < end && task(ids.B).lastAttemptId === prev.B) await sleep(500);
    interruptedAttempt = task(ids.B).lastAttemptId; await sleep(1500);
    const st = interruptedAttempt ? (await api(`/v1/attempts/${interruptedAttempt}`)).status : null;
    killCore(); await sleep(1500); startCore(); const up = await waitCore(90000); await sleep(8000);
    const after = await api(`/v1/attempts/${interruptedAttempt}`); const note = notes(`sched-run:${interruptedAttempt}`);
    const successors = sql('select count(*) n from attempts where predecessorAttemptId = ?', interruptedAttempt)[0].n;
    const wasRunning = ['running', 'validating', 'created', 'queued'].includes(st);
    day.checks.restart = { coreUp: up, wasRunningAtKill: wasRunning, resultAfter: after.resultStatus, notified: note.length === 1, autoSuccessors: successors };
    // B finished before the kill? then it is an ordinary completed day; otherwise it must be reported as interrupted and not replayed.
    if (wasRunning) { day.checks.restart.ok = up && after.resultStatus === 'interrupted' && note.length === 1 && successors === 0; }
    else { day.checks.restart.ok = up; day.notes.push('B had already finished when the kill came; restart check is weak this day'); }
    if (!day.checks.restart.ok) day.ok = false;
  }
  for (const k of active) {
    if (killDay && k === 'B') continue;
    const r = await waitRun(ids[k], prev[k]);
    day.checks[k] = { run: r };
    if (!r) { day.ok = false; day.checks[k].problem = 'did not run in time'; continue; }
    let ok = r.status === 'completed' && r.resultStatus === 'completed'; let why = '';
    if (k === 'A') { const v = (rd(path.join(WS.A, 'reports', 'date.txt')) ?? '').trim(); ok = ok && v === today(); why = `date.txt=${JSON.stringify(v)}`; }
    if (k === 'B') { const v = (rd(path.join(WS.B, 'reports', 'inbox-count.txt')) ?? '').trim(); ok = ok && v === String(expectedB); why = `count=${JSON.stringify(v)} expected=${expectedB}`; }
    if (k === 'C') { const v = (rd(path.join(WS.C, 'logs', 'status.txt')) ?? '').trim(); ok = ok && /^ok\s+\d{4}-\d{2}-\d{2}$/.test(v) && v.endsWith(today()); why = `status=${JSON.stringify(v)}`; }
    day.checks[k].ok = ok; day.checks[k].why = why; if (!ok) day.ok = false;
  }
  if (folderGone) {
    await sleep(35000);   // two scheduler ticks
    const n = notes('sched-missing:%'); const ran = task(ids.C).lastAttemptId !== prev.C;
    day.checks.C = { ranDespiteMissingFolder: ran, notified: n.length >= 1, notification: n[0] ? { kind: n[0].kind, title: n[0].title } : null, ok: !ran && n.length >= 1 };
    if (!day.checks.C.ok) day.ok = false;
    fs.renameSync(WS.C + '_away', WS.C);
  }
  // no stray files outside the frozen folders, no unexpected failure notices on healthy days
  const stray = ['daily', 'reports', 'logs'].filter((n) => fs.existsSync(path.join(RC, n)));
  const unexpectedNotices = notes('sched-run:%').filter((n) => !(killDay && n.sourceId === `sched-run:${interruptedAttempt}`));
  day.checks.noStrayFiles = stray.length === 0; day.checks.unexpectedNotices = unexpectedNotices.length;
  if (stray.length || unexpectedNotices.length) day.ok = false;
  const nextOk = Object.values(ids).every((id) => Date.parse(task(id).nextRunAt) > Date.now() + 3600_000);
  day.checks.nextRunAdvanced = nextOk; if (!nextOk) day.ok = false;
  day.seconds = Math.round((Date.now() - t0) / 1000);
  streak = day.ok ? streak + 1 : 0; best = Math.max(best, streak); day.streak = streak; days.push(day);
  console.log(`day ${d}: ${day.ok ? 'OK' : 'FAIL'} streak=${streak} ${day.seconds}s ${JSON.stringify(Object.fromEntries(Object.entries(day.checks).map(([k, v]) => [k, v?.ok ?? v])))}`);
}
clearInterval(pump);
const out = { label: LABEL, commit, at: new Date().toISOString(), note: 'days are simulated by making each routine due; the scheduler, executor, scope and notifications are real', setup, days, bestStreak: best, gateMet: best >= 7 };
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.json`), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.md`), [`# M3 routines ${LABEL} (${commit})`, '', `Best consecutive streak: ${best} (gate 7): **${best >= 7 ? 'MET' : 'NOT MET'}**`, '', '| day | ok | streak | s | detail |', '|---|---|---:|---:|---|', ...days.map((x) => `| ${x.day} | ${x.ok ? 'ok' : 'FAIL'} | ${x.streak} | ${x.seconds} | ${JSON.stringify(Object.fromEntries(Object.entries(x.checks).map(([k, v]) => [k, v?.why ?? v?.ok ?? v]))).replace(/\|/g, '/').slice(0, 200)} |`)].join('\n'));
console.log(`best streak ${best}; gate ${best >= 7 ? 'MET' : 'NOT MET'}`);
process.exit(0);
