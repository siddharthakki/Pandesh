/**
 * Execution epochs for one Saath Kar attempt.
 *
 * The per-execution tool-turn budget (`MAX_TOOL_TURNS`) bounds ONE model
 * execution epoch, not the governed task. When an epoch ends only because its
 * tool turns ran out and the attempt is otherwise healthy, the executor keeps
 * the SAME attempt (same frozen context: workspace, repository package, tools,
 * approval policy, conversation) and starts the next epoch from a compact,
 * machine-built checkpoint instead of failing the attempt and forcing a user
 * retry. This is unrelated to the Karke Dikha mission-loop phase budgets.
 *
 * Pure: no I/O. The executor owns events, persistence and the failure paths.
 */
import type { ModelChatMessage } from './modelBackend';
import type { PriorOperation } from './loopProgress';

/** Total execution epochs one attempt may use (1 initial + 3 automatic continuations). Owned by the executor loop. */
export const MAX_EXECUTION_EPOCHS = 4;

/** Most recent assistant text / validation text carried into the checkpoint. */
const CARRY_CHARS = 700;
const MAX_LISTED_OPERATIONS = 24;
const OPERATION_LABEL_CHARS = 160;

export interface EpochCheckpointInput {
  objective: string;
  /** The epoch that just ended (1-based). */
  epoch: number;
  maxEpochs: number;
  toolTurnsPerEpoch: number;
  workspaceRoot: string | null;
  /** Whether the frozen attempt context carries a repository package. */
  repositoryBound: boolean;
  operations: ReadonlyMap<string, PriorOperation>;
  /** The current loop delta (messages after the frozen base). */
  delta: readonly ModelChatMessage[];
}

export interface EpochCheckpoint {
  /** Replacement loop delta: the checkpoint, then the final turn kept verbatim. */
  delta: ModelChatMessage[];
  checkpointChars: number;
  operationCount: number;
  mutatingCount: number;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * Builds the continuation checkpoint and the compacted delta that replaces the
 * raw transcript. Only recorded facts are used: nothing is inferred or invented.
 */
export function buildEpochCheckpoint(input: EpochCheckpointInput): EpochCheckpoint {
  const { delta, operations } = input;
  let lastAssistantIndex = -1;
  for (let i = delta.length - 1; i >= 0; i--) {
    if (delta[i].role === 'assistant') { lastAssistantIndex = i; break; }
  }
  // The final turn (assistant call + its tool results) stays verbatim so the model sees its immediate state.
  const tail = lastAssistantIndex >= 0 ? delta.slice(lastAssistantIndex) : [];
  const head = lastAssistantIndex >= 0 ? delta.slice(0, lastAssistantIndex) : delta;

  const mutating: string[] = [];
  const toolCounts = new Map<string, number>();
  for (const [key, op] of operations) {
    const tool = key.slice(0, key.indexOf(':') >= 0 ? key.indexOf(':') : key.length);
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    if (op.mutating) mutating.push(`${clip(key, OPERATION_LABEL_CHARS)} -> ${op.resultCategory}`);
  }
  const explored = [...toolCounts].map(([tool, n]) => `${tool} x${n}`).join(', ') || 'none';
  const listed = mutating.slice(-MAX_LISTED_OPERATIONS);
  const omitted = mutating.length - listed.length;

  let lastAssistant = '';
  for (let i = head.length - 1; i >= 0; i--) {
    if (head[i].role === 'assistant' && head[i].content.trim()) { lastAssistant = head[i].content; break; }
  }
  let lastValidation = '';
  for (let i = delta.length - 1; i >= 0; i--) {
    if (delta[i].role === 'tool' && delta[i].content.startsWith('[validation]')) { lastValidation = delta[i].content; break; }
  }

  const lines = [
    `EXECUTION CONTINUATION (epoch ${input.epoch + 1} of ${input.maxEpochs}). This is a continuation of the SAME task, not a new task: ` +
      `the previous execution used its ${input.toolTurnsPerEpoch}-tool-turn budget before giving a final answer. ` +
      'The workspace and repository are unchanged and still bound to this task; continue working in them.',
    `Objective: ${clip(input.objective, 1500)}`,
    `Workspace: ${input.workspaceRoot ?? '(none)'}; repository context: ${input.repositoryBound ? 'bound to this task' : 'not selected for this task'}.`,
    `Tool calls already made (${operations.size}): ${explored}. Do not repeat exploration you have already done unless the workspace changed; the earlier raw outputs were compacted away, so re-read only what you need.`,
    mutating.length === 0
      ? 'Workspace changes/proposals recorded so far: none.'
      : `Workspace changes/proposals recorded so far (${mutating.length}${omitted > 0 ? `, showing last ${listed.length}` : ''}; the recorded outcome is the category after "->"):\n- ${listed.join('\n- ')}`,
    lastValidation ? `Most recent validation result: ${clip(lastValidation, CARRY_CHARS)}` : 'Validation: no validation result recorded in the last epoch.',
    lastAssistant ? `Your last stated intent before the budget ended: ${clip(lastAssistant, CARRY_CHARS)}` : '',
    'Next step: pick up the remaining concrete work toward the objective and finish with a final answer that states what is done and what is not.',
  ].filter(Boolean);
  const content = lines.join('\n');
  void head; // the raw head of the transcript is intentionally dropped, only its recorded facts above are kept
  return {
    delta: [{ role: 'system', content }, ...tail],
    checkpointChars: content.length,
    operationCount: operations.size,
    mutatingCount: mutating.length,
  };
}
