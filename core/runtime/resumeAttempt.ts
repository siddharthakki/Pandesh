/**
 * Resume interrupted work (M2, reliability program).
 *
 * A Core restart, crash or app update used to end a running task with "Interrupted … not replayed automatically"; the
 * owner had to ask again and the new turn knew nothing of what had already been done. Resuming creates a successor attempt
 * of the SAME request (same model, same folder, same permission policy — every approval and fence applies again) whose
 * prompt carries Core's own account of the interrupted attempt, built from the tool journal and never from the model's
 * words: what was already done (and must not be repeated), what was started without a recorded outcome, and what was
 * only read. The replay guard (replayGuard.ts) enforces "not repeated" in code.
 */
import type { CoreDatabase } from '../db/connection';
import { getAttempt, rerouteAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { deriveResultStatus } from '../domain/resultStatus';
import { listEntriesForAttempt } from '../domain/toolJournal';
import { isConsequentialTool } from './turnOutcome';
import { predecessorChain } from './replayGuard';
import { CoreError } from '../domain/errors';

export interface ResumeSummary { done: string[]; unknown: string[]; read: string[] }

/** What the interrupted attempt (and the attempts before it) did, from the journal and the invocation ledger. */
export function summarizeForResume(db: CoreDatabase, attemptId: string): ResumeSummary {
  const done: string[] = []; const unknown: string[] = []; const read: string[] = [];
  const chain = [attemptId, ...predecessorChain(db, attemptId)].reverse();
  for (const id of chain) {
    for (const e of listEntriesForAttempt(db, id)) {
      const detail = e.summary && e.summary.trim().length > 2 ? ` — ${e.summary.replace(/\s+/g, ' ').slice(0, 110)}` : '';
      if (!isConsequentialTool(e.toolName)) {
        const target = String((e.args as { filePath?: string; dirPath?: string; path?: string }).filePath ?? (e.args as { dirPath?: string }).dirPath ?? '').slice(0, 80);
        if (e.status === 'succeeded' && read.length < 12) read.push(`${e.toolName}${target ? ` ${target}` : ''}`);
        continue;
      }
      if (e.status === 'succeeded') done.push(`${e.toolName} ${JSON.stringify(e.args).slice(0, 110)}${detail}`);
    }
    for (const r of db.all<{ toolName: string; argsSummary: string }>("SELECT toolName, argsSummary FROM tool_invocations WHERE attemptId = ? AND status = 'pending'", [id])) {
      if (isConsequentialTool(r.toolName)) unknown.push(`${r.toolName} ${r.argsSummary.slice(0, 110)}`);
    }
  }
  return { done: done.slice(-25), unknown: unknown.slice(-10), read };
}

export function resumeGuidance(summary: ResumeSummary, workspace: string | null = null): string {
  const lines = ['This task was INTERRUPTED (the app or Core restarted while it ran) and is being resumed. Pandesh Core\'s record of the earlier attempt:'];
  lines.push(summary.done.length ? `ALREADY DONE (do not repeat; Core refuses an identical repeat):\n- ${summary.done.join('\n- ')}` : 'Nothing consequential was completed before the interruption.');
  if (summary.unknown.length) lines.push(`STARTED BUT OUTCOME UNKNOWN (check the real state with a read tool before deciding whether to do it):\n- ${summary.unknown.join('\n- ')}`);
  if (summary.read.length) lines.push(`Already read (no need to read again unless it may have changed):\n- ${summary.read.join('\n- ')}`);
  if (workspace) lines.push(`The task's working folder is ${workspace}. Folder names in the request (inbox, reports, ...) mean folders inside it: use the file tools (list_directory, read_file, write_file) there, exactly as the first attempt did, not mail or other connectors.`);
  lines.push('Continue the SAME request from where it stopped. Do only what is still missing, then say exactly what now exists. Ignore any earlier reply that says the work is under way.');
  return lines.join('\n\n');
}

/**
 * Creates the successor attempt for an interrupted or failed (not cancelled) attempt. Idempotent: an attempt that already
 * has a successor returns it. Throws a CoreError when the attempt cannot be resumed.
 */
export function resumeInterruptedAttempt(db: CoreDatabase, attemptId: string, actor: string) {
  const attempt = getAttempt(db, attemptId);
  const result = deriveResultStatus(db, attemptId);
  if (attempt.cancelRequestedAt || result.status === 'cancelled') throw new CoreError('invalid_transition', 'a task the user stopped is not resumed');
  if (!['interrupted', 'failed', 'partial'].includes(result.status)) throw new CoreError('invalid_transition', `a ${result.status} task cannot be resumed`);
  if (db.get("SELECT 1 FROM approvals WHERE attemptId = ? AND status = 'rejected' LIMIT 1", [attemptId])) throw new CoreError('invalid_transition', 'a task whose approval was declined is not resumed');
  const context = getAttemptContext(db, attemptId);
  const chainLength = predecessorChain(db, attemptId).length + 1;
  const guidance = resumeGuidance(summarizeForResume(db, attemptId), (context as { workspaceRoot?: string | null }).workspaceRoot ?? null);
  const successor = db.transaction(() => {
    const created = rerouteAttempt(db, {
      predecessorAttemptId: attemptId, actor, provider: context.selectedProvider, model: context.selectedModel,
      fingerprint: 'interrupted', reason: 'Resumed after an interruption', rerouteIndex: chainLength, continuesUnfinishedTurn: true, guidance,
    });
    recordRuntimeEvent(db, { domain: 'attempt', entityId: created.id, eventType: 'attempt_escalated', actor, metadata: { predecessorAttemptId: attemptId, failedModel: context.selectedModel, selectedModel: context.selectedModel, provider: context.selectedProvider, why: 'interrupted', reason: 'resumed' } });
    recordRuntimeEvent(db, { domain: 'attempt', entityId: created.id, eventType: 'attempt_resumed', actor, metadata: { predecessorAttemptId: attemptId, previousStatus: attempt.status, previousResult: result.status } });
    return created;
  });
  return successor;
}
