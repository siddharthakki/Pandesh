/**
 * A turn that announces a step and stops is not a finished turn.
 *
 * Live run, scratch instance, 2026-11-23 (attempt att_318f6d45, qwen3.8:27b at about 12 tokens/s):
 *   user:      "Try buuilding agai. I hacnged hte model now. ..."
 *   pass 1:    workshop_status, ollama_list_models
 *   pass 2:    update_task_outcome(status: in_progress, nextAction: "Create the detailed 3D house scene ...")
 *   pass 3:    "Now the detailed build — proper storeys, visible floor slabs, distinct materials, and a real garden:"
 *              then 120 s without a frame while the model composed the build_3d_model call; the call was stopped with
 *              "no output from Ollama for 120 s in the middle of the reply".
 *   recorded:  attempt completed; final verification "verified — 1 action completed and reported success
 *              (update_task_outcome)". Nothing was built, and nothing said so.
 *
 * Four gaps let that through; each is pinned here.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateTurnOutcome } from '../runtime/turnOutcome';
import { idleAllowanceMs } from '../runtime/piOllamaNativeFetch';
import { cutOffReplyCorrection, declaredInProgressWithoutAction, endsOnAnnouncingColon } from '../runtime/piAgentEngine';

const ok = (text: string) => ({ content: [{ type: 'text', text }] });
const REPLY = 'Now the detailed build — proper storeys, visible floor slabs, distinct materials, and a real garden:';
const STALL = 'no output from Ollama for 120 s in the middle of the reply (the model may be stuck or the machine overloaded); the call was stopped';
// The engine's own list, reduced to what this turn used.
const LOOKUP_ONLY = /^(?:workshop_status|ollama_list_models|update_task_outcome|request_tools|read_file|web_research)$/;
const turn = [
  { tool: 'workshop_status', status: 'completed', args: { scope: 'conversation' } },
  { tool: 'ollama_list_models', status: 'completed', args: {} },
  { tool: 'update_task_outcome', status: 'completed', args: { status: 'in_progress', nextAction: 'Create the detailed 3D house scene and confirm it opened in the window.' } },
];

describe('the silence watchdog and tool calls', () => {
  it('allows a longer silence when tools are offered, because a tool call arrives in one frame', () => {
    expect(idleAllowanceMs(120_000, false, 300_000)).toBe(120_000);
    expect(idleAllowanceMs(120_000, true, 300_000)).toBe(300_000);
    // Never shorter than the plain allowance, whatever is configured.
    expect(idleAllowanceMs(120_000, true, 30_000)).toBe(120_000);
  });
  it('is wired to whether the request carries tools', () => {
    const src = fs.readFileSync(path.join(__dirname, '../runtime/piOllamaNativeFetch.ts'), 'utf8');
    expect(src).toContain("idleAllowanceMs(plainIdleMs, tools.length > 0, options.toolCallIdleTimeoutMs ?? positiveEnv('PANDESH_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS', 300_000))");
  });
});

describe('the turn verdict', () => {
  it('does not count writing "in progress" into the task record as an action', () => {
    const outcome = evaluateTurnOutcome([
      { tool: 'update_task_outcome', status: 'completed', result: ok('Task record updated (in_progress)') },
      { tool: 'request_tools', status: 'completed', result: ok('Tools added') },
    ]);
    expect(outcome.performed).toEqual([]);
    expect(outcome.verdict).not.toBe('verified');
  });
  it('still counts a real action next to it', () => {
    const outcome = evaluateTurnOutcome([
      { tool: 'update_task_outcome', status: 'completed', result: ok('Task record updated (satisfied)') },
      { tool: 'write_file', status: 'completed', result: ok('Wrote src/house.js (2,140 bytes)') },
    ]);
    expect(outcome.performed).toEqual(['write_file']);
    expect(outcome.verdict).toBe('verified');
  });
});

describe('the reply itself', () => {
  it('a last paragraph that ends on a colon announces something that did not follow', () => {
    expect(endsOnAnnouncingColon(REPLY)).toBe(true);
    expect(endsOnAnnouncingColon('I checked the workshop.\n\nNow the detailed build:**')).toBe(true);
    expect(endsOnAnnouncingColon('Here are the steps:\n\n1. Open the folder\n2. Run the tests')).toBe(false);
    expect(endsOnAnnouncingColon('The house has two storeys and a garden.')).toBe(false);
    expect(endsOnAnnouncingColon('')).toBe(false);
  });
  it('the model\'s own "in progress" with nothing done after it means the task is not finished', () => {
    expect(declaredInProgressWithoutAction(turn, LOOKUP_ONLY)).toBe(true);
    // The build ran after the record was written: finished work is not flagged.
    expect(declaredInProgressWithoutAction([...turn, { tool: 'build_3d_model', status: 'completed', args: {} }], LOOKUP_ONLY)).toBe(false);
    // A build that returned an error did nothing.
    expect(declaredInProgressWithoutAction([...turn, { tool: 'build_3d_model', status: 'completed', args: {}, isError: true }], LOOKUP_ONLY)).toBe(true);
    // The last word in the record is what counts.
    expect(declaredInProgressWithoutAction([...turn, { tool: 'update_task_outcome', status: 'completed', args: { status: 'satisfied' } }], LOOKUP_ONLY)).toBe(false);
    expect(declaredInProgressWithoutAction([{ tool: 'read_file', status: 'completed', args: {} }], LOOKUP_ONLY)).toBe(false);
  });
  it('says the reply was cut off and that the announced step did not happen', () => {
    const text = cutOffReplyCorrection(STALL, false);
    expect(text).toMatch(/^Correction: this reply was cut off — the local model stopped producing output and the call was stopped\./);
    expect(text).toContain('The step it announced was not carried out: nothing was built or changed in this turn.');
    expect(text).toMatch(/Ask me to continue, or to try again\.$/);
    // When tools did act earlier in the turn, it does not claim nothing was done.
    expect(cutOffReplyCorrection(STALL, true)).toContain('what the tools above report is all that was done');
    expect(cutOffReplyCorrection('fetch failed', false)).toContain('the model call failed (fetch failed)');
  });
});

describe('the engine uses them', () => {
  const engine = fs.readFileSync(path.join(__dirname, '../runtime/piAgentEngine.ts'), 'utf8');
  it('retries a call that was cut off while writing, but never one that already issued a tool call', () => {
    expect(engine).toContain("&& !(failedCall.content || []).some((c: any) => c.type === 'toolCall')");
    expect(engine).toContain('partialChars:');
  });
  it('continues a reply that ends on a colon, and records an unfinished turn from the record or the failed call', () => {
    expect(engine).toContain('if (announcesNextStep || endsOnColon || startsWithoutWork) {');
    expect(engine).toContain("nothingMade: (asksToBuildOutsideChat || stillInProgress) && !producedSomething,");
    expect(engine).toContain(": stillInProgress && !isQuestion && !producedSomething ? 'nothing_built'");
    expect(engine).toContain(": replyCutOff && !producedSomething ? 'reply_cut_off'");
    // A cut-off sentence that happens to end in "?" is not the assistant waiting for an answer.
    expect(engine).toContain('const asksUser = !replyCutOff && ');
  });
  it('the task result and the escalation read the new reason', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(read('domain/resultStatus.ts')).toContain("meta.reason === 'reply_cut_off' ? 'the model stopped before finishing its reply");
    expect(read('domain/taskOutcomes.ts')).toContain("=== 'reply_cut_off' ? 'the model stopped before finishing its reply");
    expect(read('runtime/escalation.ts')).toContain("meta.reason === 'reply_cut_off'");
  });
});
