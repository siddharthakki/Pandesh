// node acceptance/live-eval/run.mjs [--ids F01,F02] [--slow] [--label b170-pre] [--fresh]
// Starts an isolated Core from this tree's out-core/core.js (build it first: node esbuild.core.js), runs the scenarios,
// classifies each from INDEPENDENT evidence and writes results/<label>.json + results/<label>.md.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { PORT, startCore, waitCore, killCore, turn as coreTurn, standardPolicy, api, ROOT, RC, LABEL, HERE, sleep } from './lib.mjs';
import { SCENARIOS, HONEST } from './scenarios.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const ids = opt('ids')?.split(',');
const picked = SCENARIOS.filter((s) => (ids ? ids.includes(s.id) : flag('slow') || !s.slow));
// A Core left over from an earlier label would keep the port and answer with the wrong secrets.
const freePort = () => {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(new RegExp(`127\\.0\\.0\\.1:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
      if (m) execSync(`taskkill /PID ${m[1]} /F`);
    }
  } catch { /* nothing listening */ }
};
if (flag('fresh')) { freePort(); killCore(); await sleep(1500); fs.rmSync(ROOT, { recursive: true, force: true }); }
fs.mkdirSync(ROOT, { recursive: true });
let commit = ''; try { commit = execSync('git rev-parse --short HEAD', { cwd: RC, encoding: 'utf8' }).trim(); } catch {}

if (!(await waitCore(2000))) { startCore(); if (!(await waitCore(90000))) { console.error('Core did not start'); process.exit(2); } }
const info = await api('/v1/core/info').catch(() => ({}));
console.log(`Core up (${JSON.stringify(info).slice(0, 120)}), ${picked.length} scenarios, label ${LABEL}, commit ${commit}`);

const reps = Number(opt('repeat') ?? 1); const shared = {}; const results = [];
for (const s0 of picked.flatMap((x) => Array.from({ length: reps }, (_, k) => ({ x, k })))) {
  const s = reps > 1 ? Object.assign(Object.create(s0.x), { id: s0.x.id + '#' + (s0.k + 1) }) : s0.x;
  const ws = path.join(ROOT, 'ws', s.id.replace('#', '_')).replace(/\\/g, '/');
  fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true });
  if (s.setup) await s.setup(ws);
  const ctx = { ws, shared, turn: (conv, msg, o = {}) => coreTurn(conv, msg, { policy: standardPolicy(ws), workspace: ws, ...o, ...(o.workspace === null ? { workspace: undefined } : {}) }) };
  const t0 = Date.now(); let res;
  try { res = await s.run(ctx); } catch (e) { res = { turns: [], ok: false, notes: `HARNESS ERROR: ${String(e.stack ?? e).slice(0, 400)}`, error: true }; }
  const primary = res.primary ?? res.turns[res.turns.length - 1] ?? {};
  const status = primary.resultStatus ?? primary.status ?? null; const reply = primary.reply ?? '';
  const honest = HONEST.test(reply.slice(0, 400)) || /NOT DONE|PARTLY DONE|NOT COMPLETE|not done/i.test(reply); // an admission near the top or a Core banner
  let verdict;
  if (res.error) verdict = 'ERROR';
  else if (res.ok && status === 'completed') verdict = 'PASS';
  else if (res.ok && status !== 'completed' && !res.negative) verdict = 'STATUS_CONTRADICTION';
  else if (res.ok) verdict = 'PASS';                                   // negative scenarios or recovery: ok already encodes the right behaviour
  else if (status === 'completed' && !honest) verdict = 'FALSE_COMPLETION';
  else if (status === 'completed' && honest) verdict = 'STATUS_CONTRADICTION'; // reply admits the gap but status says completed
  else verdict = 'HONEST_FAIL';
  const toolCalls = res.turns.reduce((n, t) => n + (t.tools?.length ?? 0), 0);
  const interventions = res.turns.reduce((n, t) => n + (t.decisions?.filter((d) => d.choice === 'approved').length ?? 0), 0);
  const rejected = res.turns.reduce((n, t) => n + (t.decisions?.filter((d) => d.choice === 'rejected').length ?? 0), 0);
  const outcome = primary.taskOutcome?.status ?? null;
  const row = { id: s.id, cat: s.cat, title: s.title, verdict, ok: !!res.ok, attemptStatus: status, taskOutcomeStatus: outcome, ms: Date.now() - t0, toolCalls, approvalsGranted: interventions, approvalsRefused: rejected, models: [...new Set(res.turns.flatMap((t) => (t.models ?? []).map((m) => m.model)))].filter(Boolean), notes: res.notes, replyHead: reply.slice(0, 240), reply: reply.slice(0, 2500), replyAdmits: honest, resultReason: primary.resultReason ?? null, toolNames: [...new Set(res.turns.flatMap((t) => (t.tools ?? []).map((x) => x.tool)))] };
  results.push(row); console.log(`${s.id.padEnd(5)} ${verdict.padEnd(20)} status=${status} outcome=${outcome} ${Math.round(row.ms / 1000)}s  ${res.notes ?? ''}`.slice(0, 220));
}

const count = (v) => results.filter((r) => r.verdict === v).length;
const executed = results.filter((r) => r.verdict !== 'ERROR');
const summary = {
  label: LABEL, commit, at: new Date().toISOString(), scenarios: results.length,
  pass: count('PASS'), falseCompletion: count('FALSE_COMPLETION'), statusContradiction: count('STATUS_CONTRADICTION'), honestFail: count('HONEST_FAIL'), harnessError: count('ERROR'),
  verifiedCompletionRate: executed.length ? +(count('PASS') / executed.length).toFixed(3) : null,
  falseCompletionRate: executed.length ? +(count('FALSE_COMPLETION') / executed.length).toFixed(3) : null,
  totalApprovalsGranted: results.reduce((n, r) => n + r.approvalsGranted, 0),
  medianMs: executed.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(executed.length / 2)] ?? null,
};
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.json`), JSON.stringify({ summary, results }, null, 2));
const md = [`# Live eval ${LABEL} (${commit})`, '', '```json', JSON.stringify(summary, null, 1), '```', '', '| id | cat | verdict | attempt | outcome | s | notes |', '|---|---|---|---|---|---:|---|',
  ...results.map((r) => `| ${r.id} | ${r.cat} | ${r.verdict} | ${r.attemptStatus} | ${r.taskOutcomeStatus ?? ''} | ${Math.round(r.ms / 1000)} | ${String(r.notes ?? '').replace(/\|/g, '/').slice(0, 160)} |`)].join('\n');
fs.writeFileSync(path.join(HERE, 'results', `${LABEL}.md`), md);
console.log(JSON.stringify(summary, null, 1));
