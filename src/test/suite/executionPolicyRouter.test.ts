import { describe, expect, it } from 'vitest';
import { decideExecutionPolicy } from '../../orchestration/ExecutionPolicyRouter';

/**
 * Unified Conversation V1 — Step 7 product workflow tests for the Auto
 * execution-policy router. These are deterministic classifier-level tests;
 * the real Baat/Saath/Karke submission paths this router dispatches into are
 * exercised by the existing per-mode suites (unchanged by this milestone).
 */
describe('decideExecutionPolicy', () => {
  it('A. routes a read-only investigation question to READ_ONLY', () => {
    const decision = decideExecutionPolicy('Where is registerUser implemented and which tests cover it?');
    expect(decision.policy).toBe('READ_ONLY');
  });

  it('A. routes "why does X fail" to READ_ONLY', () => {
    expect(decideExecutionPolicy('Why does this fail?').policy).toBe('READ_ONLY');
    expect(decideExecutionPolicy('Explain this code.').policy).toBe('READ_ONLY');
    expect(decideExecutionPolicy("Don't change anything yet.").policy).toBe('READ_ONLY');
  });

  it('B. routes a bounded edit to COLLABORATIVE_EDIT, not AUTONOMOUS_EXECUTION', () => {
    const decision = decideExecutionPolicy('Change getDisplayName so an empty username returns Unknown.');
    expect(decision.policy).toBe('COLLABORATIVE_EDIT');
  });

  it('C. routes an explicit fix-and-verify request to AUTONOMOUS_EXECUTION', () => {
    const decision = decideExecutionPolicy(
      'Fix registerUser so it rejects an empty username, update the tests, and run the relevant validation.',
    );
    expect(decision.policy).toBe('AUTONOMOUS_EXECUTION');
  });

  it('C. recognizes other end-to-end delegation phrasing as AUTONOMOUS_EXECUTION', () => {
    expect(decideExecutionPolicy('Take care of this.').policy).toBe('AUTONOMOUS_EXECUTION');
    expect(decideExecutionPolicy('Implement this and verify it.').policy).toBe('AUTONOMOUS_EXECUTION');
    expect(decideExecutionPolicy('Do it end-to-end.').policy).toBe('AUTONOMOUS_EXECUTION');
    expect(decideExecutionPolicy('Fix the failing test and repair anything else that breaks.').policy).toBe('AUTONOMOUS_EXECUTION');
  });

  it('B regression (installed acceptance): a leading "Okay,"/"Well," clause does not hide the mutation verb from it', () => {
    // Found live: this exact wording (this milestone's own Turn 2 acceptance
    // text) was misrouted READ_ONLY because the comma after "Okay" isn't a
    // sentence terminator the verb-anchor recognized.
    expect(decideExecutionPolicy('Okay, change getDisplayName so empty usernames show Unknown.').policy).toBe('COLLABORATIVE_EDIT');
    expect(decideExecutionPolicy('Well, change getDisplayName so empty usernames show Unknown.').policy).toBe('COLLABORATIVE_EDIT');
    expect(decideExecutionPolicy('Actually, rename this method.').policy).toBe('COLLABORATIVE_EDIT');
  });

  it('B regression: conversational acknowledgments may precede a bounded mutation without hiding it', () => {
    expect(
      decideExecutionPolicy(
        'Good. Now add a validation for password. Should be 12 characters, should have a number, capital alphabet and a special character.',
      ).policy,
    ).toBe('COLLABORATIVE_EDIT');
    expect(decideExecutionPolicy('Great, now change the button label.').policy).toBe('COLLABORATIVE_EDIT');
  });

  it('A regression: acknowledgments alone or before an explanation stay READ_ONLY', () => {
    expect(decideExecutionPolicy('Good.').policy).toBe('READ_ONLY');
    expect(decideExecutionPolicy('Thanks. Explain why password validation matters.').policy).toBe('READ_ONLY');
  });

  it('D. a bare "fix it" follow-up after a READ_ONLY finding escalates to at most COLLABORATIVE_EDIT', () => {
    const decision = decideExecutionPolicy('Okay, fix it.', { previousPolicy: 'READ_ONLY' });
    expect(decision.policy).toBe('COLLABORATIVE_EDIT');
  });

  it('D. the same bare follow-up with no continuity at all still never guesses READ_ONLY or autonomy', () => {
    const decision = decideExecutionPolicy('fix it');
    expect(decision.policy).toBe('COLLABORATIVE_EDIT');
  });

  it('E. "fix it and run the relevant tests" is AUTONOMOUS_EXECUTION even as a follow-up turn', () => {
    const decision = decideExecutionPolicy('Fix it and run the relevant tests.', { previousPolicy: 'READ_ONLY' });
    expect(decision.policy).toBe('AUTONOMOUS_EXECUTION');
  });

  it('H. an ambiguous modification request (could plausibly need autonomy) defaults to COLLABORATIVE_EDIT', () => {
    // Mutation intent is clear ("fix"), but nothing here clearly delegates
    // end-to-end execution — Step 2 requires resolving this ambiguity toward
    // less autonomy, not more.
    const decision = decideExecutionPolicy('Fix the flaky test.');
    expect(decision.policy).not.toBe('AUTONOMOUS_EXECUTION');
    expect(decision.policy).toBe('COLLABORATIVE_EDIT');
  });

  it('a bare "continue" after a rejected proposal stays at most COLLABORATIVE_EDIT (reject safety)', () => {
    // I. The router itself never resurrects a rejected attempt — it only ever
    // decides a policy for a NEW turn, which the caller then submits as a
    // brand-new request/attempt. Staying capped at COLLABORATIVE_EDIT (not
    // escalating to autonomous) is the router's contribution to that
    // invariant; the "no silent re-execution of a rejected mutation" part is
    // enforced by Core's approval/attempt model, unchanged by this milestone.
    const decision = decideExecutionPolicy('continue', { previousPolicy: 'COLLABORATIVE_EDIT', hasPendingProposal: false });
    expect(decision.policy).toBe('COLLABORATIVE_EDIT');
  });

  it('never escalates a bare follow-up past AUTONOMOUS_EXECUTION continuation', () => {
    const decision = decideExecutionPolicy('continue', { previousPolicy: 'AUTONOMOUS_EXECUTION' });
    expect(decision.policy).toBe('AUTONOMOUS_EXECUTION');
  });

  it('is deterministic: same input and continuity always produce the same decision', () => {
    const a = decideExecutionPolicy('Rename this method.', { previousPolicy: 'READ_ONLY' });
    const b = decideExecutionPolicy('Rename this method.', { previousPolicy: 'READ_ONLY' });
    expect(a).toEqual(b);
  });

  it('negated mutation verbs do not trigger COLLABORATIVE_EDIT or AUTONOMOUS_EXECUTION', () => {
    const decision = decideExecutionPolicy('Please do not delete or modify the config file, just tell me what it does.');
    expect(decision.policy).toBe('READ_ONLY');
  });

  it('routes a planning/design request to COLLABORATIVE_EDIT', () => {
    expect(decideExecutionPolicy('Can you draft a plan for the new authentication architecture?').policy).toBe('COLLABORATIVE_EDIT');
  });

  it('routes a bounded repository-inspection request to READ_ONLY', () => {
    expect(decideExecutionPolicy('Can you review the file src/index.ts and explain what it does?').policy).toBe('READ_ONLY');
  });
});
