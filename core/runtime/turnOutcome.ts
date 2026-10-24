/**
 * What actually happened in a turn — decided from evidence, not from the
 * model's own claim that it finished.
 *
 * The defect this fixes: a turn that asked for something to be *done* ended
 * by saying "done", and Core recorded the final verification as passed and
 * the attempt as completed. A declined approval, a missing permission, a
 * connector that was not connected — all of them produced a green result,
 * because the only witness was the model's own sentence.
 *
 * The rule this module applies is narrow and defensible:
 *
 *   - A *consequential* action (one that changes something outside the
 *     conversation) is verified only when the tool itself says it succeeded.
 *   - A read-only action is never a reason to fail a turn: a model that could
 *     not read a file and said so plainly has done its job.
 *   - A turn with no tool call at all is a conversation, not a task, and is
 *     reported as such.
 *
 * The verdict is derived from the tool results Core already recorded. It never
 * re-runs anything and never trusts the reply text.
 */

export interface TurnToolCall {
  tool: string;
  status?: string;
  result?: unknown;
}

export type TurnOutcomeVerdict =
  /** A consequential action ran and the tool said it succeeded. */
  | 'verified'
  /** A consequential action was refused: nothing happened at all. */
  | 'unverified'
  /** A consequential action ran and returned a failure result. */
  | 'attempted_failed'
  /** The turn only read, or only talked. Nothing to verify. */
  | 'conversational';

export interface TurnOutcome {
  verdict: TurnOutcomeVerdict;
  /** Plain words for the reason, ready to be shown to the operator. */
  reason: string;
  /** The consequential tools that ran and reported success. */
  performed: string[];
  /** The consequential tools that were refused: nothing happened. */
  refused: string[];
  /** The consequential tools that ran and returned a failure result. */
  failed: string[];
}

/**
 * The Pi surface's tools that change something outside the conversation.
 *
 * A tool is consequential when calling it can be observed by the world:
 * a file written, a command run, a draft created, an event changed, a
 * promise recorded, a memory stored, a file shared. Read-only tools are
 * deliberately absent — their failure is information, not a broken task.
 */
export const CONSEQUENTIAL_PI_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'run_command',
  'propose_file_change',
  'propose_text_edit',
  'gmail_create_draft',
  'gmail_send_draft',
  'gmail_apply_plan',
  'gmail_undo_plan',
  'calendar_draft_event',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'create_reminder',
  'create_note',
  'update_note',
  'delete_note',
  'create_commitment',
  'update_commitment',
  'memory_remember',
  'memory_forget',
  'memory_resolve_contradiction',
  'schedule_task',
  'cancel_scheduled_task',
  'send_to_phone',
  'delegate_to_opencode',
  'dev_stories_dispatch',
  'dev_story_approve_review',
]);

/**
 * The words Core's own tools use when an action did not happen at all.
 *
 * A refusal is different from a failure. A refused action left the world
 * untouched: the approval was declined, the service was not connected, the
 * permission was not granted. A failed action *ran* and returned a bad
 * result — a build that does not compile is a finding, not a non-action, and
 * the turn that reports it has done its job.
 *
 * Every governed tool reports refusal in these terms, so the check needs no
 * per-tool special case.
 */
const REFUSED_PATTERN =
  /\b(NOT DONE|NOT AVAILABLE|declined|denied|rejected|refused|not granted|has not been granted|not connected|is not connected|nothing was done|nothing was written|no action was taken|was not sent|did not happen|approval is still|awaiting approval)\b/i;

interface ToolResultShape {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as ToolResultShape).content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/**
 * Decides what happened in a turn.
 *
 * `calls` is the tool ledger Core already keeps for the turn. The ledger
 * holds a 'running' entry when a call starts and a 'completed' entry when it
 * finishes, so a call that finished is judged by its completed entry — only
 * a call that started and never finished counts as refused, because an action
 * that never reported success never happened.
 */
export function evaluateTurnOutcome(calls: readonly TurnToolCall[]): TurnOutcome {
  const performed: string[] = [];
  const refused: string[] = [];
  const failed: string[] = [];

  // The last completed entry per tool is the authoritative outcome; a tool
  // that only ever has a 'running' entry was interrupted mid-call.
  const completed = new Map<string, TurnToolCall>();
  const started = new Set<string>();
  for (const call of calls) {
    if (!CONSEQUENTIAL_PI_TOOLS.has(call.tool)) continue;
    if (call.status === 'running') {
      started.add(call.tool);
      continue;
    }
    completed.set(call.tool, call);
  }

  for (const [tool, call] of completed) {
    const text = resultText(call.result);
    const errored = Boolean((call.result as ToolResultShape | undefined)?.isError);
    if (REFUSED_PATTERN.test(text)) {
      if (!refused.includes(tool)) refused.push(tool);
    } else if (errored) {
      if (!failed.includes(tool)) failed.push(tool);
    } else if (!performed.includes(tool)) {
      performed.push(tool);
    }
  }

  // A consequential call that started and never finished: the turn was
  // stopped or the process died before it could report an outcome.
  for (const tool of started) {
    if (completed.has(tool)) continue;
    if (!refused.includes(tool)) refused.push(tool);
  }

  if (refused.length > 0) {
    return {
      verdict: 'unverified',
      reason: `the requested work did not happen: ${refused.join(', ')} reported that it could not do it`,
      performed,
      refused,
      failed,
    };
  }
  if (failed.length > 0) {
    return {
      verdict: 'attempted_failed',
      reason: `${failed.join(', ')} ran and reported a failure result; the turn reports what actually happened`,
      performed,
      refused,
      failed,
    };
  }
  if (performed.length > 0) {
    return {
      verdict: 'verified',
      reason: `${performed.length} action${performed.length === 1 ? '' : 's'} completed and reported success`,
      performed,
      refused,
      failed,
    };
  }
  return {
    verdict: 'conversational',
    reason: 'no action was taken in this turn; it was an answer, not a task',
    performed,
    refused,
    failed,
  };
}
