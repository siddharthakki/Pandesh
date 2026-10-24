/**
 * Named comparison model and list pricing used to estimate the cloud API cost
 * a local run avoided.
 *
 * This is an estimate of provider list price for the same token counts, not a
 * measurement of savings: it deliberately excludes local electricity, hardware
 * amortisation, and operator time, and it assumes no prompt caching or batch
 * discount, so every call's full prompt is charged as fresh input.
 *
 * Update both the rates and `verifiedOn` together, from the source below.
 */
export interface CloudCostBaseline {
  model: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** ISO date on which these rates were read from `source`. */
  verifiedOn: string;
  source: string;
  exclusions: string;
}

export const CLOUD_COST_BASELINE: CloudCostBaseline = {
  model: 'Claude Sonnet 5',
  inputUsdPerMTok: 2,
  outputUsdPerMTok: 10,
  verifiedOn: '2026-09-14',
  source: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  exclusions: 'Excludes local electricity, hardware, and operator time. Assumes no prompt caching or batch discount.',
};

/**
 * Estimated list-price cost of the same traffic on the comparison model.
 *
 * Returns null when no call reported usable token counts, so the caller can
 * show "unavailable" instead of a misleading zero. Calls that reported only
 * one side still contribute that side.
 */
export function estimateCloudCostUsd(
  calls: ReadonlyArray<{ promptTokens?: number | null; completionTokens?: number | null }>,
  baseline: CloudCostBaseline = CLOUD_COST_BASELINE,
): number | null {
  let measured = false;
  let usd = 0;
  for (const call of calls) {
    const prompt = usable(call.promptTokens);
    const completion = usable(call.completionTokens);
    if (prompt === null && completion === null) continue;
    measured = true;
    // Every call is charged its full prompt. Re-sending the same context on
    // the next turn is billed again, which is exactly what the loop does.
    usd += ((prompt ?? 0) / 1_000_000) * baseline.inputUsdPerMTok;
    usd += ((completion ?? 0) / 1_000_000) * baseline.outputUsdPerMTok;
  }
  return measured ? usd : null;
}

function usable(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
