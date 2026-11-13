// M2 interruption suite (kill Core at a chosen point, restart, the OWNER presses Resume). Registered into SCENARIOS by scenarios.mjs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { api, newConversation, sql, killCore, startCore, waitCore, sleep, evidence } from './lib.mjs';

const chainOf = (attemptId) => `(select id from attempts where requestId = (select requestId from attempts where id = '${String(attemptId).replace(/[^a-z0-9_]/gi, '')}'))`;
const chainWrites = (attemptId) => sql(`select count(*) n from tool_invocations where toolName = 'write_file' and status = 'succeeded' and attemptId in ${chainOf(attemptId)}`)[0]?.n ?? 0;
const dupWritesOf = (attemptId) => sql(`select argsSummary, count(*) n from tool_invocations where toolName = 'write_file' and status = 'succeeded' and attemptId in ${chainOf(attemptId)} group by argsSummary having n > 1`);
const attemptsOfRequest = (attemptId) => sql('select count(*) n from attempts where requestId = (select requestId from attempts where id = ?)', attemptId)[0]?.n ?? 0;
async function restartCore() { await sleep(1500); startCore(); const up = await waitCore(90000); await sleep(6000); return up; }
async function waitAttempt(id, ms = 300000) {
  const pump = setInterval(async () => { try { for (const a of (await api('/v1/approvals/pending')).approvals ?? []) await api(`/v1/assistant/approvals/${a.id}/resolve`, { method: 'POST', body: { resolution: 'approved' }, host: true }); } catch { /* decided */ } }, 1500);
  try { const end = Date.now() + ms; let a = null; while (Date.now() < end) { a = await api(`/v1/attempts/${id}`); if (['completed', 'failed', 'cancelled'].includes(a.status)) return a; await sleep(2000); } return a; } finally { clearInterval(pump); }
}
const turnFor = async (conv, att) => ({ attemptId: att.id, ms: 0, status: att.status, resultStatus: att.resultStatus, resultReason: att.resultReason, failureReason: att.failureReason ?? null, decisions: [], ...(await evidence(conv, att.id)) });
const bare = (attemptId, before) => ({ attemptId, status: before.status, resultStatus: before.resultStatus, reply: null, tools: [], models: [], decisions: [] });
const overviewRow = async (attemptId) => ((await api('/v1/tasks/overview?limit=50')).tasks ?? []).find((t) => t.attemptId === attemptId);
const anyTool = (a) => sql('select count(*) n from tool_invocations where attemptId = ?', a)[0]?.n >= 1;

export function interruptScenarios({ seedSix, sixCheck, SIX_PROMPT }) {
  async function killResume(c, id, { kill, second, resumeTwice }) {
    const conv = await newConversation(id);
    const k = await c.turn(conv.id, SIX_PROMPT, { killWhen: kill, timeoutMs: 240000 });
    if (!k.killed) return { turns: [k], ok: false, notes: 'the task finished before the kill (no interruption happened)', negative: true };
    const up = await restartCore();
    const before = await api(`/v1/attempts/${k.attemptId}`);
    const listed = await overviewRow(k.attemptId);
    const autoSuccessors = attemptsOfRequest(k.attemptId) - 1; // nothing may have resumed by itself
    let res = await api(`/v1/attempts/${k.attemptId}/resume`, { method: 'POST', body: {} });
    let last = res.attempt; let kills = 1;
    if (resumeTwice) { const again = await api(`/v1/attempts/${k.attemptId}/resume`, { method: 'POST', body: {} }); if (again.attempt.id !== last.id) return { turns: [k], ok: false, notes: 'second Resume created a second successor' }; }
    if (second) {
      const t0 = Date.now();
      while (Date.now() - t0 < 240000 && !second(k.attemptId)) { await sleep(500); const a = await api(`/v1/attempts/${last.id}`); if (['completed', 'failed', 'cancelled'].includes(a.status)) break; }
      const state = await api(`/v1/attempts/${last.id}`);
      if (second(k.attemptId) && state.status !== 'completed') {
        killCore(); kills = 2; if (!(await restartCore())) return { turns: [k], ok: false, notes: 'core did not return after the second kill' };
        res = await api(`/v1/attempts/${last.id}/resume`, { method: 'POST', body: {} }); last = res.attempt;
      }
    }
    const fin = await waitAttempt(last.id);
    const missing = sixCheck(c.ws); const dupes = dupWritesOf(k.attemptId);
    return { turns: [await turnFor(conv.id, fin)], ok: up && missing.length === 0 && dupes.length === 0 && autoSuccessors === 0 && before.resultStatus === 'interrupted' && listed?.resumable === true,
      notes: `coreUp=${up} kills=${kills} interrupted=${before.resultStatus} listedResumable=${listed?.resumable} autoResumed=${autoSuccessors} attemptsInChain=${attemptsOfRequest(k.attemptId)} final=${fin?.resultStatus} missing=${missing.join(',') || '-'} duplicateWrites=${dupes.length} writes=${chainWrites(k.attemptId)}` };
  }
  const six = async (ws) => seedSix(ws);
  return [
    { id: 'I04', cat: 'interrupt', title: 'Kill at the first tool call, owner resumes (M2)', setup: six, run: (c) => killResume(c, 'I04', { kill: anyTool }) },
    { id: 'I05', cat: 'interrupt', title: 'Kill after three writes, owner resumes (M2)', setup: six, run: (c) => killResume(c, 'I05', { kill: (a) => chainWrites(a) >= 3 }) },
    { id: 'I06', cat: 'interrupt', title: 'Kill after all six writes, owner resumes: nothing rewritten (M2)', setup: six, run: (c) => killResume(c, 'I06', { kill: (a) => chainWrites(a) >= 6 }) },
    { id: 'I07', cat: 'interrupt', title: 'Two kills in a row, owner resumes twice (M2)', setup: six, run: (c) => killResume(c, 'I07', { kill: (a) => chainWrites(a) >= 1, second: (a) => chainWrites(a) >= 3 }) },
    { id: 'I08', cat: 'interrupt', title: 'Resume pressed twice creates one successor (M2)', setup: six, run: (c) => killResume(c, 'I08', { kill: (a) => chainWrites(a) >= 2, resumeTwice: true }) },
    { id: 'I09', cat: 'interrupt', title: 'A task the owner stopped cannot be resumed (M2)', setup: six, async run(c) {
      const conv = await newConversation('I09'); let attemptId = null;
      const t = await c.turn(conv.id, SIX_PROMPT, { onAttempt: (a) => { attemptId = a; setTimeout(() => { api(`/v1/attempts/${a}/cancel`, { method: 'POST', body: {} }).catch(() => {}); }, 4000); }, timeoutMs: 120000 });
      let refused = false; let msg = ''; try { await api(`/v1/attempts/${attemptId}/resume`, { method: 'POST', body: {} }); } catch (e) { refused = true; msg = String(e.message).slice(0, 120); }
      const listed = await overviewRow(attemptId);
      return { turns: [t], ok: refused && attemptsOfRequest(attemptId) === 1 && listed?.resumable !== true, notes: `status=${t.status} refused=${refused} (${msg}) listedResumable=${listed?.resumable}`, negative: true };
    } },
    { id: 'I11', cat: 'interrupt', title: 'Kill after the reminder was created: resume creates no second reminder (M2, non-file action)', async run(c) {
      const conv = await newConversation('I11');
      const made = (a) => sql("select count(*) n from tool_invocations where attemptId = ? and toolName = 'create_reminder'", a)[0]?.n >= 1 && sql("select count(*) n from everyday_reminders where title like '%Keller%' or body like '%Keller%'")[0]?.n >= 1;
      const k = await c.turn(conv.id, 'Remind me tomorrow at 9:00 to call Dr. Keller about the invoice.', { workspace: null, killWhen: made, timeoutMs: 180000 });
      if (!k.killed) return { turns: [k], ok: false, notes: 'finished before the kill', negative: true };
      const up = await restartCore(); const before = await api(`/v1/attempts/${k.attemptId}`);
      let fin = null; let note = '';
      try { const r = await api(`/v1/attempts/${k.attemptId}/resume`, { method: 'POST', body: {} }); fin = await waitAttempt(r.attempt.id, 180000); } catch (e) { note = ` resume: ${String(e.message).slice(0, 100)}`; }
      const n = sql("select count(*) n from everyday_reminders where (title like '%Keller%' or body like '%Keller%') and status != 'cancelled'")[0]?.n;
      return { turns: [fin ? await turnFor(conv.id, fin) : bare(k.attemptId, before)], ok: up && n === 1, notes: `coreUp=${up} interrupted=${before.resultStatus} reminders=${n} final=${fin?.resultStatus}${note}` };
    } },
    { id: 'I13', cat: 'interrupt', title: 'Restart with an approval pending: nothing runs by itself; Resume asks again (M2, owner policy)', setup: six, async run(c) {
      const conv = await newConversation('I13');
      const k = await c.turn(conv.id, SIX_PROMPT, { killWhen: (a) => sql("select count(*) n from approvals where attemptId = ? and status = 'pending'", a)[0]?.n >= 1, policy: () => 'pending', timeoutMs: 180000 });
      if (!k.killed) return { turns: [k], ok: false, notes: 'no approval was requested before the end', negative: true };
      const up = await restartCore(); await sleep(15000); // time for any automatic recovery to misbehave
      const wroteByItself = fs.existsSync(path.join(c.ws, 'analysis'));
      const auto = attemptsOfRequest(k.attemptId) - 1;
      const ran = sql(`select count(*) n from tool_invocations where status = 'succeeded' and toolName = 'write_file' and attemptId in ${chainOf(k.attemptId)}`)[0]?.n ?? 0;
      const before = await api(`/v1/attempts/${k.attemptId}`); const listed = await overviewRow(k.attemptId);
      let fin = null; let resumeNote = '';
      try { const r = await api(`/v1/attempts/${k.attemptId}/resume`, { method: 'POST', body: {} }); fin = await waitAttempt(r.attempt.id); } catch (e) { resumeNote = String(e.message).slice(0, 120); }
      const missing = sixCheck(c.ws); const dupes = dupWritesOf(k.attemptId);
      return { turns: [fin ? await turnFor(conv.id, fin) : bare(k.attemptId, before)], ok: up && !wroteByItself && auto === 0 && ran === 0 && !!listed && missing.length === 0 && dupes.length === 0,
        notes: `coreUp=${up} stateAfterRestart=${before.status}/${before.resultStatus} listedResumable=${listed?.resumable} wroteByItself=${wroteByItself} autoSuccessors=${auto} writesBeforeResume=${ran} afterResume missing=${missing.join(',') || '-'} dupes=${dupes.length} ${resumeNote}` };
    } },
  ];
}
