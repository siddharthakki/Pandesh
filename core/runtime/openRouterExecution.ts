import type { CoreDatabase } from '../db/connection';
import type { AttemptContextRecord } from '../shared/wireTypes';
import {
  markOpenRouterBudgetUnresolved,
  reconcileOpenRouterBudget,
  reserveOpenRouterBudget,
} from '../domain/openRouterBudget';
import {
  boundedCompletionTokens,
  CONSERVATIVE_OPENROUTER_PRICING,
  estimatePromptTokens,
  reservationUsd,
  type OpenRouterTokenPricing,
} from './openRouterPricing';
import type { ModelChatMessage } from './modelBackend';

export interface OpenRouterCallBudget {
  reserveUsd: number;
  spendCapUsd: number;
}

export function prepareOpenRouterCall(
  db: CoreDatabase,
  context: AttemptContextRecord,
  messages: ModelChatMessage[],
  pricing: OpenRouterTokenPricing = CONSERVATIVE_OPENROUTER_PRICING,
): OpenRouterCallBudget {
  const spendCapUsd = context.modelSelection?.spendCapUsd;
  if (spendCapUsd === undefined || !Number.isFinite(spendCapUsd) || spendCapUsd <= 0) {
    throw new Error('OpenRouter spend cap missing on frozen attempt context');
  }
  const reserveUsd = reservationUsd(
    estimatePromptTokens(messages),
    boundedCompletionTokens(),
    pricing,
  );
  reserveOpenRouterBudget(db, context.attemptId, spendCapUsd, reserveUsd);
  return { reserveUsd, spendCapUsd };
}

export function finalizeOpenRouterCall(
  db: CoreDatabase,
  attemptId: string,
  invocationId: string,
  reserveUsd: number,
  actualCostUsd: number | null | undefined,
): 'reconciled' | 'unresolved' {
  if (actualCostUsd === null || actualCostUsd === undefined || !Number.isFinite(actualCostUsd)) {
    markOpenRouterBudgetUnresolved(db, attemptId, invocationId, reserveUsd);
    return 'unresolved';
  }
  reconcileOpenRouterBudget(db, attemptId, invocationId, reserveUsd, actualCostUsd);
  return 'reconciled';
}
