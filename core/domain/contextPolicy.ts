import type { ContextPolicy, ResolvedMode } from '../shared/wireTypes';

/**
 * Builds the explicit, bounded context-policy declaration for a resolved mode.
 * This is the single place that decides which context layers a request is
 * allowed to draw from — see docs/m32-architecture.md CONTEXT ISOLATION.
 * Deliberately a pure function of (mode, hasConversation, hasRepository,
 * hasStory): it never inspects message content, so it cannot be tricked into
 * including more than the mode contract allows.
 */
export function buildContextPolicy(
  mode: ResolvedMode,
  available: { hasConversation: boolean; hasRepository: boolean; hasStory: boolean },
): ContextPolicy {
  switch (mode) {
    case 'baat_kar':
      // Baat Kar: its own conversation plus bounded repository excerpts when
      // supplied. Never project/global-story context or execution tools.
      return {
        includeConversationHistory: available.hasConversation,
        includeProjectContext: false,
        includeRepositoryContext: available.hasRepository,
        includeGlobalStoryContext: false,
      };
    case 'saath_kar':
      // Saath Kar: its conversation plus explicit project/repository context.
      return {
        includeConversationHistory: available.hasConversation,
        includeProjectContext: available.hasRepository,
        includeRepositoryContext: available.hasRepository,
        includeGlobalStoryContext: false,
      };
    case 'karke_dikha':
      // Karke Dikha: goal + story/repository evidence. No conversation history —
      // an autonomous attempt is not a chat continuation, and per the charter a
      // retry must not inherit prior transcript either.
      return {
        includeConversationHistory: false,
        includeProjectContext: available.hasRepository,
        includeRepositoryContext: available.hasRepository,
        includeGlobalStoryContext: available.hasStory,
      };
  }
}
