import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readResolvedCss } from '../helpers/resolveCssImports';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');
const requireCjs = createRequire(__filename);
// The one central presentation mapping shipped to the webview, imported
// directly so the tests exercise the exact production mapping table.
const everyday = requireCjs(path.join(media, 'everyday-presentation.js'));

describe('M33 central phase mapping (media/everyday-presentation.js)', () => {
  it('maps every Karke Dikha lifecycle state into the fixed vocabulary', () => {
    const expectations: Record<string, string> = {
      queued: 'Preparing the work',
      scheduled: 'Preparing the work',
      waiting_for_resources: 'Preparing the work',
      preparing: 'Preparing the work',
      running: 'Making changes',
      waiting_for_approval: 'Waiting for your approval',
      waiting_for_proposal_approval: 'Waiting for your approval',
      waiting_for_mutation_approval: 'Waiting for your approval',
      waiting_for_delivery_approval: 'Waiting for your approval',
      validating: 'Checking the result',
      committing: 'Preparing delivery',
      creating_pull_request: 'Preparing delivery',
      monitoring_ci: 'Preparing delivery',
      waiting_for_review: 'Preparing delivery',
      updating_pull_request: 'Preparing delivery',
      completed: 'Completed',
      cancelled: 'Stopped',
      cancelling: 'Stopped',
      failed: 'Blocked',
      blocked: 'Blocked',
      recovery_required: 'Blocked',
      paused: 'Processing task',
    };
    for (const [state, phase] of Object.entries(expectations)) {
      expect(everyday.phaseForLifecycleState(state), state).toBe(phase);
    }
  });

  it('maps Core attempt statuses truthfully per kind', () => {
    expect(everyday.phaseForAttemptStatus('running', 'baat_kar')).toBe('Understanding your request');
    expect(everyday.phaseForAttemptStatus('running', 'saath_kar')).toBe('Understanding your request');
    expect(everyday.phaseForAttemptStatus('running', 'karke_dikha')).toBe('Making changes');
    expect(everyday.phaseForAttemptStatus('waiting_for_approval', 'karke_dikha')).toBe('Waiting for your approval');
    expect(everyday.phaseForAttemptStatus('completed', 'baat_kar')).toBe('Completed');
    expect(everyday.phaseForAttemptStatus('cancelled', 'saath_kar')).toBe('Stopped');
    expect(everyday.phaseForAttemptStatus('failed', 'saath_kar')).toBe('Blocked');
  });

  it('renders unknown states as the neutral Processing task and reports them diagnostically', () => {
    const reported: Array<[string, string]> = [];
    everyday.setUnknownStateReporter((context: string, state: string) => reported.push([context, state]));
    expect(everyday.phaseForLifecycleState('quantum_flux')).toBe('Processing task');
    expect(everyday.phaseForAttemptStatus('quantum_flux', 'baat_kar')).toBe('Processing task');
    expect(reported).toEqual([
      ['lifecycle', 'quantum_flux'],
      ['attempt', 'quantum_flux'],
    ]);
  });

  it('exposes terminality and a sentence for every phase', () => {
    for (const phase of Object.values(everyday.PHASES) as string[]) {
      expect(everyday.sentenceForPhase(phase)).toBeTruthy();
    }
    expect(everyday.isTerminalPhase('Completed')).toBe(true);
    expect(everyday.isTerminalPhase('Stopped')).toBe(true);
    expect(everyday.isTerminalPhase('Blocked')).toBe(true);
    expect(everyday.isTerminalPhase('Making changes')).toBe(false);
  });
});

describe('M33 deterministic mode recommendation (Unified Conversation V1 policy)', () => {
  it('recommends Saath Kar (not Karke Dikha) for a bounded fix with no end-to-end delegation', () => {
    // Unified Conversation V1: a bounded modification defaults to a governed
    // Saath Kar proposal, not unattended autonomous execution — see
    // src/orchestration/ExecutionPolicyRouter.ts.
    const reco = everyday.recommendMode('Fix the settings page so invalid paths show a useful error.');
    expect(reco.mode).toBe('agent');
    expect(reco.name).toBe('Saath Kar');
    expect(reco.reason).toBeTruthy();
    expect(everyday.recommendMode('Add a file named hello.txt containing the word hello.').mode).toBe('agent');
  });

  it('installed-acceptance regression: a leading "Okay,"/"Well," clause does not hide the mutation verb from it', () => {
    expect(everyday.recommendMode('Okay, change getDisplayName so empty usernames show Unknown.').mode).toBe('agent');
    expect(everyday.recommendMode('Well, change getDisplayName so empty usernames show Unknown.').mode).toBe('agent');
  });

  it('recommends Karke Dikha only when the request clearly delegates end-to-end execution', () => {
    expect(everyday.recommendMode('Fix the settings page so invalid paths show a useful error, then run the tests to verify.').mode).toBe('autonomous');
    expect(everyday.recommendMode('Take care of this.').mode).toBe('autonomous');
    expect(everyday.recommendMode('Do it end-to-end.').mode).toBe('autonomous');
  });

  it('recommends Baat Kar for questions and explanations', () => {
    expect(everyday.recommendMode('What is a race condition?').mode).toBe('chat');
    expect(everyday.recommendMode('Reply with exactly one short word: hello.').mode).toBe('chat');
  });

  it('recommends Saath Kar for repository inspection and planning', () => {
    expect(everyday.recommendMode('List the files in this repository and explain the layout.').mode).toBe('agent');
    expect(everyday.recommendMode('Draft a plan for the migration.').mode).toBe('agent');
  });

  it('a bare follow-up caps at Saath Kar unless it continues an active autonomous task', () => {
    expect(everyday.recommendMode('fix it').mode).toBe('agent');
    expect(everyday.recommendMode('Okay, fix it.', 'chat').mode).toBe('agent');
    expect(everyday.recommendMode('continue', 'autonomous').mode).toBe('autonomous');
  });

  it('agrees with Core routing on the plain read-only and planning happy paths', async () => {
    // Chip recommendation vs Core's server-owned router: for requests that
    // are NOT mutations, the chip must never contradict what Core would
    // decide. Bounded mutations are the one deliberate divergence introduced
    // by Unified Conversation V1 (see src/orchestration/ExecutionPolicyRouter.ts's
    // header) — Core's classifyRequest still routes every mutation straight
    // to Karke Dikha for its other (non-composer) callers, so it is
    // intentionally excluded from this parity check.
    const routing = await import('../../../core/domain/routing');
    const cases = [
      'What is a race condition?',
      'List the files in this repository and explain the layout.',
      'Draft a plan for the migration.',
    ];
    const toResolved: Record<string, string> = { chat: 'baat_kar', agent: 'saath_kar', autonomous: 'karke_dikha' };
    for (const text of cases) {
      expect(toResolved[everyday.recommendMode(text).mode], text).toBe(routing.classifyRequest(text).resolvedMode);
    }
  });
});

describe('M33 unified composer surface (media/chat.html + chat-everyday.js)', () => {
  it('ships the recommendation chip, phase strip, and history containers', async () => {
    const html = await read('chat.html');
    expect(html).toContain('id="everyday-reco-row"');
    expect(html).toContain('id="everyday-phase"');
    expect(html).toContain('id="everyday-history-list"');
    expect(html).toContain('class="everyday-mode-option" data-mode="chat"');
    expect(html).toContain('class="everyday-mode-option" data-mode="agent"');
    expect(html).toContain('class="everyday-mode-option" data-mode="autonomous"');
    // Loader order: presentation mapping loads before the everyday layer.
    expect(html).toMatch(/'chat-sidebar-ui\.js'[\s\S]*'everyday-presentation\.js',\s*'chat-everyday\.js'/);
  });

  it('keeps raw attempt/task ids behind a collapsed Details disclosure', async () => {
    const html = await read('chat.html');
    expect(html).toMatch(/<details id="kd-task-details" class="kd-task-details">[\s\S]*id="autonomous-task-id"[\s\S]*id="autonomous-attempt-id"[\s\S]*<\/details>/);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>)/);
  });

  it('routes every send through the existing submission messages only', async () => {
    const js = await read('chat-everyday.js');
    // The everyday layer stamps the effective mode and lets chat.js post the
    // one production submission — it never posts sendMessage or
    // startAutonomousTask itself.
    expect(js).not.toContain("type: 'sendMessage'");
    expect(js).not.toContain("type: 'startAutonomousTask'");
    expect(js).toContain("type: 'everydayModeDecision'");
    expect(js).toContain('modeSelect.value = selected');
  });

  it('records the routing decision diagnostically with override provenance', async () => {
    const js = await read('chat-everyday.js');
    expect(js).toContain('recommendedMode: MODE_KIND[recommendation.mode]');
    expect(js).toContain('overridden: selected !== recommendation.mode');
  });

  it('labels a current blocker as this task and a retry as the previous attempt', async () => {
    const js = await read('chat-everyday.js');
    expect(js).toContain('Task blocked: ${friendly}');
    expect(js).toContain('Task blocked: ${firstLine(failure.message, 160)}');
    expect(js).toContain('Previous attempt blocked. ${message.message || \'Retrying safely.\'}');
  });

  it('reskins approval cards with plain-language purpose and repository-change scope', async () => {
    const html = await read('chat.html');
    expect(html.match(/everyday-approval-why/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html.match(/Changes the repository:/g)?.length).toBe(3);
    // Existing envelope plumbing ids are untouched.
    for (const id of ['proposal-approve-btn', 'mutation-approve-btn', 'delivery-approve-btn', 'proposal-approval-card', 'mutation-approval-card', 'delivery-approval-card']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('retires duplicate composers and the mode-first rail from the default surface', async () => {
    const css = readResolvedCss(path.join(media, 'chat-layout-fixes.css'));
    expect(css).toContain('.mode-buttons { display: none !important; }');
    expect(css).toContain('#autonomous-composer { display: none !important; }');
    expect(css).toContain('#input-area { display: flex !important;');
  });
});
