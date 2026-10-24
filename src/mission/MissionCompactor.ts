import { OllamaMessage } from '../tools/ToolTypes';
import { TokenBudget } from '../models/TokenBudget';
import { MissionCheckpoint } from './MissionCheckpoint';

const SUMMARY_MARKER = '[[mission-checkpoint-summary]]';
const MAX_ITEMS_PER_SECTION = 8;
const MAX_ITEM_CHARS = 160;

function renderSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  const shown = items.slice(-MAX_ITEMS_PER_SECTION).map(item => `- ${item.slice(0, MAX_ITEM_CHARS)}`);
  const omitted = items.length > MAX_ITEMS_PER_SECTION ? items.length - MAX_ITEMS_PER_SECTION : 0;
  const suffix = omitted > 0 ? `\n  (+${omitted} earlier, preserved in the mission checkpoint)` : '';
  return `${title}:\n${shown.join('\n')}${suffix}`;
}

/**
 * Renders the durable facts a mission must not lose to truncation — the
 * categories the mission checkpoint already tracks — as one compact block.
 * Never includes narrative transcript content, only what the checkpoint
 * itself holds structurally.
 */
export function renderMissionCheckpointSummary(checkpoint: MissionCheckpoint): string {
  const sections = [
    `Objective: ${checkpoint.objective}`,
    renderSection('Constraints', checkpoint.constraints),
    renderSection('Blockers', checkpoint.blockers),
    renderSection('Pending work', checkpoint.pendingWork),
    renderSection('Completed work', checkpoint.completedWork),
    renderSection('Failed approaches (do not repeat)', checkpoint.failedApproaches),
    checkpoint.validationState.passed !== undefined
      ? `Validation: ${checkpoint.validationState.passed ? 'passing' : 'failing'} as of last check`
      : '',
  ].filter(Boolean);
  return `${SUMMARY_MARKER}\nMission memory (durable — not truncated by context pruning):\n${sections.join('\n\n')}`;
}

/**
 * A second, mission-aware pruning strategy layered in front of
 * `TokenBudget.pruneOldToolResults`. It never invents its own truncation
 * logic — it reuses `pruneOldToolResults` for the actual char-budget walk —
 * it only ensures the mission's durable facts (constraints, blockers,
 * pending/completed work, failed approaches, validation state) survive that
 * walk by injecting them as one system-role message right after the system
 * prompt, replacing any prior injection so it never accumulates duplicates.
 */
export class MissionCompactor {
  static compact(messages: readonly OllamaMessage[], checkpoint: MissionCheckpoint, budget: number): OllamaMessage[] {
    if (!TokenBudget.wouldExceedBudget([...messages], budget)) {
      return [...messages];
    }
    const withoutPriorSummary = messages.filter(message => !(message.role === 'system' && message.content.startsWith(SUMMARY_MARKER)));
    const summaryMessage: OllamaMessage = { role: 'system', content: renderMissionCheckpointSummary(checkpoint) };
    const systemIndex = withoutPriorSummary.findIndex(message => message.role === 'system');
    const insertAt = systemIndex >= 0 ? systemIndex + 1 : 0;
    const withSummary = [
      ...withoutPriorSummary.slice(0, insertAt),
      summaryMessage,
      ...withoutPriorSummary.slice(insertAt),
    ];
    return TokenBudget.pruneOldToolResults(withSummary, budget);
  }
}
