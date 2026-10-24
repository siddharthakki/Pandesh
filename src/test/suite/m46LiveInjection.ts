/**
 * Controlled fault injection for the ladder scenario (OLLAMA_AGENT_M46_INJECT=1).
 *
 * The real runtime, the real governed executor, real validation and real recovery run unchanged. Only the first
 * model replies are scripted, to guarantee the situation the recovery ladder exists for:
 *
 *   1. the first patch is a well-formed but wrong fix (the diagnosis in the task: a comparison in shipping.js);
 *   2. the first repair rewords the very same hypothesis (a different expression, same idea, same file, same region);
 *   3. every later reply comes from the real model.
 *
 * Nothing about the model's own reasoning is scripted after that: whether the widened evidence lets it find the real
 * cause (progress) or it cannot (NO_PROGRESS) is the live result.
 */
export interface InjectionState {
  readInjected: boolean;
  proposalInjected: boolean;
  repairInjected: boolean;
  injected: string[];
}

export function newInjectionState(): InjectionState {
  return { readInjected: false, proposalInjected: false, repairInjected: false, injected: [] };
}

function shippingSource(comparison: string): string {
  return `'use strict';
const { limitFor } = require('./config/billing');

const RATES = { default: 5, eu: 9 };

function shippingFor(orderValue, region) {
  if (${comparison}) return 0;
  return RATES[region] ?? RATES.default;
}

module.exports = { RATES, shippingFor };
`;
}

function proposal(comparison: string, summary: string, reason: string): Record<string, unknown> {
  return {
    version: 1,
    taskSummary: summary,
    operations: [{ type: 'replace', path: 'src/shipping.js', reason, content: shippingSource(comparison) }],
    validationCommands: [{ kind: 'npm-test' }],
  };
}

/** The scripted reply for this prompt, or undefined when the real model should answer. */
export function injectedReply(prompt: string, state: InjectionState): string | undefined {
  if (!state.readInjected && prompt.startsWith('Investigation turn 1.')) {
    state.readInjected = true;
    state.injected.push('read_file src/shipping.js');
    return JSON.stringify({ action: 'read_file', path: 'src/shipping.js', startLine: 1, endLine: 40 });
  }
  if (state.readInjected && !state.proposalInjected && prompt.startsWith('Investigation turn 2.')) {
    state.proposalInjected = true;
    state.injected.push('first patch: >= (hypothesis A)');
    return JSON.stringify({
      action: 'submit_proposal',
      proposal: proposal('orderValue >= limitFor(region)', 'Make the free-shipping comparison inclusive in shippingFor.', 'The comparison in shippingFor is strict; make it inclusive so qualifying orders ship free.'),
    });
  }
  if (state.proposalInjected && !state.repairInjected && prompt.includes('Stage: validator (bounded proposal repair)')) {
    state.repairInjected = true;
    state.injected.push('first repair: reworded hypothesis A');
    return JSON.stringify(proposal('orderValue - limitFor(region) >= 0', 'Express the free-shipping check in shippingFor as a non-negative difference.', 'Compute the margin over the limit and treat a non-negative margin as free shipping.'));
  }
  return undefined;
}

/**
 * M46.9 weak-validation fault injection for the cart scenario (OLLAMA_AGENT_M46_WEAKVAL=1): the first proposal is a
 * well-formed but semantically wrong discount patch that names ONLY `git-diff-check` as validation - the exact
 * dogfood `delivered_wrong` shape. Everything after (governed validation, repair, recovery, delivery) is real.
 */
export interface WeakValidationState { readInjected: boolean; proposalInjected: boolean; injected: string[] }

export function newWeakValidationState(): WeakValidationState {
  return { readInjected: false, proposalInjected: false, injected: [] };
}

const WRONG_PRICING = `'use strict';
function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

function lineTotal(unitPrice, quantity) {
  return roundToCents(unitPrice * quantity);
}

// percent is a whole-number percentage: 10 means 10% off.
function applyDiscount(total, percent) {
  if (!percent) return total;
  return roundToCents(total - total * percent / 10);
}

module.exports = { roundToCents, lineTotal, applyDiscount };
`;

export function weakValidationReply(prompt: string, state: WeakValidationState): string | undefined {
  if (!state.readInjected && prompt.startsWith('Investigation turn 1.')) {
    state.readInjected = true;
    state.injected.push('read_file src/pricing.js');
    return JSON.stringify({ action: 'read_file', path: 'src/pricing.js', startLine: 1, endLine: 40 });
  }
  if (state.readInjected && !state.proposalInjected && prompt.startsWith('Investigation turn 2.')) {
    state.proposalInjected = true;
    state.injected.push('wrong patch (percent / 10) + validation git-diff-check only');
    return JSON.stringify({
      action: 'submit_proposal',
      proposal: {
        version: 1,
        taskSummary: 'Scale the discount percentage in applyDiscount.',
        operations: [{ type: 'replace', path: 'src/pricing.js', reason: 'The discount is applied with the raw percent value; scale it.', content: WRONG_PRICING }],
        validationCommands: [{ kind: 'git-diff-check' }],
      },
    });
  }
  return undefined;
}
