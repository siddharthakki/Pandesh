import type { ConversationWorkingStateRecord } from '../../core/shared/wireTypes';
import { classifyControlAcknowledgement, hasExistingWork } from './ConversationContinuity';
import { decideExecutionPolicy } from './ExecutionPolicyRouter';

/**
 * Follow-up routing contract:
 *
 *  - a mutation or genuinely new objective          -> objective arbitration / a new task, as before;
 *  - a read-only question after work was performed  -> an ordinary conversational follow-up;
 *  - a bare control word ("yes", "continue", "new task") only acts as a control while a control question is pending,
 *    which the caller decides before asking this.
 *
 * True only for text that cannot mutate the repository (not a plan, mutation, delegation or referential "fix it"),
 * in a conversation that has already performed, inspected or blocked on work, and that is not itself a bare control
 * acknowledgement. Staying in Karke Dikha mode is never, by itself, a reason to spawn another autonomous task.
 */
export function isReadOnlyFollowUpOnPriorWork(text: string, state: ConversationWorkingStateRecord | null | undefined): boolean {
  if (!state || !hasExistingWork(state)) return false;
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  if (classifyControlAcknowledgement(trimmed)) return false;
  return decideExecutionPolicy(trimmed).policy === 'READ_ONLY';
}
