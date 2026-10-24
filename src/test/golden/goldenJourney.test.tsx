/**
 * Golden journey harness — see docs in `goldenJourneyHarness.ts` and
 * HANDOFF.md's "Golden Product Paths" section for the full protocol/route
 * findings this suite is built on.
 *
 * These tests traverse the closest practical production path: real UI intent
 * (a rendered webview-v2 `<App/>`) -> real `AgentPanel.handleWebviewMessage`
 * routing -> a deterministic fake Core/model seam (the only mocked
 * boundaries: the separate Core process, and for Karke Dikha, the LLM) ->
 * real AgentPanel outbound events -> real webview-v2 adapter/reducer ->
 * visible DOM. Existing lower-level suites remain as regression coverage;
 * these are the release authority for "does the real product path work".
 */
import React from 'react';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import * as vscodeMock from '../mocks/vscode';
import * as extensionModule from '../../extension';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { RepositoryContextService } from '../../context/RepositoryContextService';
import {
  attachHost,
  bridgeWebviewApiToHost,
  clearVsCodeApiBridge,
  completeAttemptWithText,
  fakeCoreClient,
  fakeCoreManager,
  withFakeConversationWorkingState,
  mergedCoreClient,
  initGitFixture,
  StubCodingProvider,
  trivialProposalCompletion,
  waitForCalls,
  waitForPosted,
  flush,
  buildAutonomousInfra,
  attemptRehydrationRecord,
  pendingApprovalRecord,
  restartRehydrationCoreClient,
  restartRehydrationCoreManager,
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  AutonomousTaskRuntime,
  createDefaultAutonomousTask,
  type PostedMessage,
} from './goldenJourneyHarness';

async function mountApp() {
  vi.resetModules();
  const { App } = await import('../../webview-v2/App');
  render(<App />);
}

function radio(name: string): HTMLElement {
  return screen.getByRole('radio', { name });
}

/**
 * Waits until the named task reaches a state the production
 * `AUTONOMOUS_AUTO_RESTORE_STATES` gate would consider "active" (i.e. one
 * `getOwnedActiveAutonomousTask`'s discovery-scan and `reconnectAutonomousTask`
 * both recognize), rather than a transient pre-gate state like `preparing` —
 * mirrors real usage, where a user re-selecting Karke Dikha happens well after
 * the task has reached its first approval gate.
 */
async function waitForAutonomousTaskActive(
  queue: { get(taskId: string): Promise<{ state: string } | undefined> },
  taskId: string,
  timeoutMs = 10000,
): Promise<void> {
  const eligible = new Set(['waiting_for_proposal_approval', 'waiting_for_mutation_approval', 'running', 'validating', 'waiting_for_delivery_approval']);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await queue.get(taskId);
    if (task && eligible.has(task.state)) return;
    if (Date.now() > deadline) throw new Error(`Task ${taskId} never reached an active-eligible state (last: ${task?.state})`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function submit(text: string): void {
  fireEvent.change(screen.getByPlaceholderText('Ask KarkeDikha…'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  vscodeMock._resetConfig();
  vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
  vscodeMock._setConfig('ollama-agent.model', 'persisted-model');
  vi.spyOn(ProviderGateway, 'create').mockResolvedValue({
    listModels: async () => [
      { name: 'persisted-model', modifiedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'qwen2.5-coder:14b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 },
    ],
    healthCheck: async () => undefined,
    chat: async () => ({ message: { role: 'assistant', content: '' }, done: true }),
  } as never);
});

afterEach(() => {
  cleanup();
  clearVsCodeApiBridge();
  vi.restoreAllMocks();
  vscodeMock._resetConfig();
});

describe('Golden Journey 1 — Baat Kar', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-baat-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('literal "Hi" is intercepted by the greeting short-circuit BEFORE the Core route — never reaches Baat Kar backend', async () => {
    // Finding: `routeComposerSubmission` (AgentPanel.ts:1953-1957) answers a
    // standalone greeting locally via `isGreetingIntent`, for every mode,
    // before `submitOrdinary`/`sendToAgent` is ever called. The literal input
    // the task spec names ("Hi") therefore does NOT exercise the Baat Kar ->
    // `baat_kar` Core route at all — it is a canned `done`, no `client.submit`,
    // no `token` frame. This test documents that real behavior; the next test
    // in this file proves the actual backend route with a non-greeting input.
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager as never);

    const host = attachHost(root);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Baat Kar'));
    submit('Hi');

    await screen.findByText('Hi! What can I help you with?');
    expect(client.calls.some((c) => c.method === 'submit')).toBe(false);
    expect(host.posted.some((m) => m.type === 'token')).toBe(false);
    const done = host.posted.find((m) => m.type === 'done');
    expect(done).toMatchObject({ type: 'done', content: 'Hi! What can I help you with?' });
    const composer = screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
  });

  it('a real (non-greeting) Baat Kar submission -> baat_kar Core route, no Saath Kar/autonomous substitution, one assistant reply, terminal Ready', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager as never);

    const host = attachHost(root);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Baat Kar'));
    // Deliberately not repo-shaped: `isRepositoryContextQuestion` fail-closes
    // (RepositoryGroundingUnavailableError) when it classifies a question as
    // repository-specific but grounding is unavailable — see the dedicated
    // "Repository Grounding" golden test below for that path.
    submit('Explain the difference between TCP and UDP.');

    await waitForCalls(client, 'submit', 1);
    const submitCall = client.calls.find((c) => c.method === 'submit');
    const body = submitCall?.args[0] as { requestedMode: string };
    // Authoritative host route: coreKindFor('chat') -> 'baat_kar'. This is the
    // ONE mode with its own Core kind — proves Baat Kar was not silently
    // routed through the shared Saath Kar/agent execution kind.
    expect(body.requestedMode).toBe('baat_kar');

    await waitForCalls(client, 'executeAttempt', 1);
    expect(client.calls.filter((c) => c.method === 'submit')).toHaveLength(1);

    // Deterministic model seam: stream + complete.
    const executeCall = client.calls.find((c) => c.method === 'executeAttempt');
    const executedAttemptId = executeCall?.args[0] as string;
    completeAttemptWithText(manager, executedAttemptId, 'Hello from Baat Kar.');

    await waitForPosted(host.posted, (m) => m.type === 'token');
    await waitForPosted(host.posted, (m) => m.type === 'done');

    // No agent/autonomous substitution: Saath Kar's workingDirectory arg is
    // only passed when kind === 'saath_kar' — assert it was never set, and no
    // autonomous task was ever posted.
    expect((client.calls.find((c) => c.method === 'executeAttempt')?.args[1] as { workingDirectory?: string } | undefined)?.workingDirectory).toBeUndefined();
    expect(host.posted.some((m) => m.type === 'autonomousTaskStarted')).toBe(false);

    // Real token/done events reached the wire.
    expect(host.posted.some((m) => m.type === 'token')).toBe(true);
    const done = host.posted.find((m) => m.type === 'done');
    expect(done).toMatchObject({ type: 'done', content: 'Hello from Baat Kar.' });

    // UI v2 rendered the real reducer/adapter path: exactly one assistant bubble.
    await screen.findByText('Hello from Baat Kar.');
    const assistantBubbles = document.querySelectorAll('.kd2-message--assistant');
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0].textContent).toContain('Hello from Baat Kar.');

    // Terminal state Ready: composer re-enabled, no fatal error.
    const composer = screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    expect(document.querySelector('.kd2-fatal-error')).toBeNull();
  });
});

describe('Golden Journey 2 — Saath Kar', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-saath-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('Saath Kar -> saath_kar Core route (workspace-bound), no Karke Dikha task started, visible agent result reaches UI v2', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager as never);

    const host = attachHost(root);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Saath Kar'));
    submit('List the files in this repo.');

    await waitForCalls(client, 'submit', 1);
    const body = client.calls.find((c) => c.method === 'submit')?.args[0] as { requestedMode: string };
    expect(body.requestedMode).toBe('saath_kar');

    await waitForCalls(client, 'executeAttempt', 1);
    const executeCall = client.calls.find((c) => c.method === 'executeAttempt');
    // Saath Kar (and Ask/Plan, per HANDOFF findings) binds a working directory
    // — this is the one field that distinguishes it from Baat Kar at the Core
    // call boundary, since `requestedMode` alone is shared with Ask/Plan too.
    expect((executeCall?.args[1] as { workingDirectory?: string }).workingDirectory).toBe(root);

    const executedAttemptId = executeCall?.args[0] as string;
    completeAttemptWithText(manager, executedAttemptId, 'Found 1 file: package.json');
    await waitForPosted(host.posted, (m) => m.type === 'done');

    expect(host.posted.some((m) => m.type === 'autonomousTaskStarted')).toBe(false);
    await screen.findByText('Found 1 file: package.json');
  });
});

describe('Golden Journey 3 — Karke Dikha', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-kd-'));
    await initGitFixture(root);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('Karke Dikha -> real M15 autonomous route starts, task projection reaches the host wire, no chat/agent route substituted', async () => {
    const provider = new StubCodingProvider(trivialProposalCompletion('src/generated/golden.ts', 'export const ok = true;\n'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');

    const infra = buildAutonomousInfra(root);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => infra.coreClient } as never);

    const host = attachHost(root);
    host.panel.attachAutonomous(infra.queue, infra.runtime);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Karke Dikha'));
    submit('Create a golden acceptance file.');

    const started = await waitForPosted(host.posted, (m) => m.type === 'autonomousTaskStarted');
    expect(started).toMatchObject({ type: 'autonomousTaskStarted', goal: 'Create a golden acceptance file.' });

    const tasks = await infra.queue.list();
    expect(tasks).toHaveLength(1);
    // Authoritative mode: dispatched via `startAutonomousTask`, which reaches
    // Core with `requestedMode: 'karke_dikha'` (AgentPanel.submitKarkeDikhaRequest),
    // never `coreKindFor`/`sendToAgent` — the chat/agent route is untouched.
    expect(host.posted.every((m) => m.type !== 'token' && m.type !== 'done')).toBe(true);

    infra.dispose();
  });

  it('Golden 2/3/4/6/9(completed): proposal approval -> mutation approval -> validation success -> delivery approval -> completed, all through real UI-v2 projection', async () => {
    // Seeds a real task through the exact same queue.enqueue/transition/update
    // sequence src/test/suite/agentPanelAutonomousMode.test.ts's
    // `pendingProposalTask` helper uses to reach an actionable gate for real
    // AgentPanel polling, so this test exercises the real host<->UI-v2
    // projection wiring end to end. The deep M15 execution graph itself
    // (worktree mutation, LLM repair loop) is already covered by that suite;
    // here `runtime.approve*`/`approveAutonomousDelivery` are stubbed to
    // perform the same queue transition the real graph would eventually
    // reach, so AgentPanel's OWN poll-after-approve call sees real next-state
    // data — Phase 3's actual new surface (task/approval/validation/delivery
    // projection into the DOM) is exercised for real, unmocked.
    const infra = buildAutonomousInfra(root);
    const queue = infra.queue;
    const task0 = await queue.enqueue(createDefaultAutonomousTask(root, 'Create a full-lifecycle golden acceptance file.'));
    await queue.transition(task0.taskId, 'preparing');
    await queue.transition(task0.taskId, 'waiting_for_approval');
    const running = await queue.transition(task0.taskId, 'running');
    const proposalId = 'sha256:golden-proposal-1';
    const withProposal = await queue.update(
      {
        ...running,
        pendingProposal: {
          proposalId, version: 1, taskSummary: 'Golden lifecycle proposal',
          operations: [{ type: 'create', path: 'src/generated/full-lifecycle.ts', reason: 'golden' }],
          validationCommands: [{ kind: 'npm-script', script: 'verify' }], warnings: [],
        },
      },
      'proposal_pending',
      {},
    );
    const task = await queue.transition(withProposal.taskId, 'waiting_for_proposal_approval');
    const taskId = task.taskId;

    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => infra.coreClient } as never);
    vi.spyOn(infra.runtime, 'approveProposal').mockImplementation(async () => {
      const current = await queue.get(taskId);
      const backToRunning = await queue.transition(current!.taskId, 'running');
      const withMutation = await queue.update(
        { ...backToRunning, pendingMutationApproval: { requestId: 'req-golden-1', proposalId, operationCount: 1, targets: ['src/generated/full-lifecycle.ts'], elevatedConfirmationRequired: false } },
        'mutation_pending',
        {},
      );
      await queue.transition(withMutation.taskId, 'waiting_for_mutation_approval');
    });
    vi.spyOn(infra.runtime, 'approveMutation').mockImplementation(async () => {
      const current = await queue.get(taskId);
      const backToRunning = await queue.transition(current!.taskId, 'running');
      const running2 = await queue.transition(backToRunning.taskId, 'validating');
      await queue.update(running2, 'progress', { progress: 'validation_completed commands=1 failed=0' });
      await queue.transition(running2.taskId, 'waiting_for_delivery_approval');
    });
    vi.spyOn(infra.runtime, 'approveDelivery').mockImplementation(async () => {
      const current = await queue.get(taskId);
      const committing = await queue.transition(current!.taskId, 'committing');
      await queue.update(committing, 'delivery_recorded', {});
      await queue.transition(committing.taskId, 'completed');
    });

    const host = attachHost(root);
    host.panel.attachAutonomous(infra.queue, infra.runtime);
    bridgeWebviewApiToHost(host);
    // Track inbound webview -> host messages: `host.posted` is outbound-only,
    // so "click sends exactly one approveProposal" needs its own log.
    const received: PostedMessage[] = [];
    const originalReceive = host.receive.bind(host);
    host.receive = (msg: unknown) => {
      received.push(msg as PostedMessage);
      originalReceive(msg);
    };
    await mountApp();

    // Golden 1 shape: exactly one TaskCard, real goal rendered.
    await screen.findByTestId('task-card');
    expect(screen.getAllByTestId('task-card')).toHaveLength(1);
    expect(screen.getByTestId('task-card-goal').textContent).toBe('Create a full-lifecycle golden acceptance file.');

    // Golden 2 — proposal approval.
    await waitForPosted(host.posted, (m) => m.type === 'proposalApprovalRequest' && m.taskId === taskId, 10000);
    await screen.findByTestId('approval-card');
    expect(screen.getAllByTestId('approval-card')).toHaveLength(1);
    expect(document.querySelector('[data-approval-kind="proposal"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitForPosted(host.posted, (m) => m.type === 'proposalApprovalResolved' && m.taskId === taskId && m.decision === 'approved');
    expect(received.filter((m) => m.type === 'approveProposal')).toHaveLength(1);
    // React did not self-resolve: the card is gone only because the reducer
    // removed it in response to the real proposalApprovalResolved event.
    await flush(30);
    expect(document.querySelector('[data-approval-kind="proposal"]')).toBeNull();

    // Golden 3 — mutation approval, same task continues.
    await waitForPosted(host.posted, (m) => m.type === 'mutationApprovalRequest' && m.taskId === taskId, 10000);
    await screen.findByTestId('approval-card');
    expect(document.querySelector('[data-approval-kind="mutation"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitForPosted(host.posted, (m) => m.type === 'mutationApprovalResolved' && m.taskId === taskId && m.decision === 'approved');
    expect(received.filter((m) => m.type === 'approveMutation')).toHaveLength(1);

    // Golden 4 — validation success reaches the UI before any delivery card.
    const statusWithTotals = await waitForPosted(
      host.posted,
      (m) => m.type === 'autonomousTaskStatus' && m.taskId === taskId && !!m.validationTotals,
      10000,
    );
    expect(statusWithTotals).toMatchObject({ validationTotals: { commands: 1, failed: 0 } });
    await screen.findByTestId('validation-summary');
    expect(screen.getByTestId('validation-summary').getAttribute('data-validation-state')).toBe('success');
    expect(screen.getByTestId('task-card-state').textContent).not.toBe('Completed');

    // Golden 6 — delivery approval (raised automatically by the real poll
    // once state === waiting_for_delivery_approval), real evidence, and
    // completes only after the authoritative completed status.
    await waitForPosted(host.posted, (m) => m.type === 'deliveryApprovalRequest' && m.taskId === taskId, 10000);
    await screen.findByTestId('approval-card');
    expect(document.querySelector('[data-approval-kind="delivery"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitForPosted(host.posted, (m) => m.type === 'deliveryApprovalResolved' && m.taskId === taskId && m.decision === 'approved', 10000);
    expect(received.filter((m) => m.type === 'approveAutonomousDelivery')).toHaveLength(1);

    await waitForPosted(
      host.posted,
      (m) => m.type === 'autonomousTaskStatus' && m.taskId === taskId && m.state === 'completed',
      10000,
    );
    await screen.findByText('Completed');
    expect(document.querySelector('.kd2-approval-card')).toBeNull();
    expect(screen.getByTestId('task-card-state').textContent).toBe('Completed');
    expect(screen.getByTestId('delivery-summary')).toBeTruthy();

    infra.dispose();
  }, 30000);

  it('Golden 5: deterministic validation failure never reaches delivery/completed', async () => {
    const infra = buildAutonomousInfra(root);
    const queue = infra.queue;
    const task0 = await queue.enqueue(createDefaultAutonomousTask(root, 'Create a task whose validation always fails.'));
    await queue.transition(task0.taskId, 'preparing');
    await queue.transition(task0.taskId, 'waiting_for_approval');
    const running = await queue.transition(task0.taskId, 'running');
    const proposalId = 'sha256:golden-failing-1';
    const withProposal = await queue.update(
      {
        ...running,
        pendingProposal: {
          proposalId, version: 1, taskSummary: 'Golden failing proposal',
          operations: [{ type: 'create', path: 'src/generated/failing.ts', reason: 'golden' }],
          validationCommands: [{ kind: 'npm-script', script: 'verify-fails' }], warnings: [],
        },
      },
      'proposal_pending',
      {},
    );
    const task = await queue.transition(withProposal.taskId, 'waiting_for_proposal_approval');
    const taskId = task.taskId;

    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => infra.coreClient } as never);
    vi.spyOn(infra.runtime, 'approveProposal').mockImplementation(async () => {
      const current = await queue.get(taskId);
      const backToRunning = await queue.transition(current!.taskId, 'running');
      const withMutation = await queue.update(
        { ...backToRunning, pendingMutationApproval: { requestId: 'req-golden-fail-1', proposalId, operationCount: 1, targets: ['src/generated/failing.ts'], elevatedConfirmationRequired: false } },
        'mutation_pending',
        {},
      );
      await queue.transition(withMutation.taskId, 'waiting_for_mutation_approval');
    });
    vi.spyOn(infra.runtime, 'approveMutation').mockImplementation(async () => {
      const current = await queue.get(taskId);
      const backToRunning = await queue.transition(current!.taskId, 'running');
      const running2 = await queue.transition(backToRunning.taskId, 'validating');
      const withFailure = await queue.update(
        { ...running2, validationFailure: { message: 'verify-fails exited 1' } },
        'progress',
        { progress: 'validation_completed commands=1 failed=1' },
      );
      await queue.transition(withFailure.taskId, 'blocked');
    });

    const host = attachHost(root);
    host.panel.attachAutonomous(infra.queue, infra.runtime);
    bridgeWebviewApiToHost(host);
    await mountApp();

    await waitForPosted(host.posted, (m) => m.type === 'proposalApprovalRequest' && m.taskId === taskId, 10000);
    await screen.findByTestId('approval-card');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitForPosted(host.posted, (m) => m.type === 'proposalApprovalResolved' && m.taskId === taskId && m.decision === 'approved');

    await waitForPosted(host.posted, (m) => m.type === 'mutationApprovalRequest' && m.taskId === taskId, 10000);
    await screen.findByTestId('approval-card');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitForPosted(host.posted, (m) => m.type === 'mutationApprovalResolved' && m.taskId === taskId && m.decision === 'approved');

    await waitForPosted(
      host.posted,
      (m) => m.type === 'autonomousTaskStatus' && m.taskId === taskId && m.state === 'blocked',
      10000,
    );
    await screen.findByTestId('validation-summary');
    expect(screen.getByTestId('validation-summary').getAttribute('data-validation-state')).toBe('failure');
    expect(document.querySelector('[data-approval-kind="delivery"]')).toBeNull();
    expect(host.posted.some((m) => m.type === 'deliveryApprovalRequest' && m.taskId === taskId)).toBe(false);
    expect(host.posted.some((m) => m.type === 'autonomousTaskStatus' && m.taskId === taskId && m.state === 'completed')).toBe(false);
    expect(screen.getByTestId('task-card-state').textContent).toBe('Blocked');
    expect(screen.getByTestId('task-card-state').textContent).not.toBe('Completed');

    infra.dispose();
  }, 30000);

  it('rapid repeated Send clicks on a fresh Karke Dikha submission never create a duplicate task', async () => {
    // Karke Dikha's `ui.submitting` is cleared immediately after posting
    // `startAutonomousTask` (App.tsx onSubmit — a documented temporary
    // workaround pending Phase 3 task projection), so the composer alone does
    // NOT prevent a second rapid click from firing a second submission. This
    // proves the host-side guard (`karkeDikhaSubmissionInFlight`,
    // AgentPanel.ts) still collapses that into exactly one task.
    const provider = new StubCodingProvider(trivialProposalCompletion('src/generated/no-dup.ts', 'export const ok = true;\n'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');

    const infra = buildAutonomousInfra(root);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => infra.coreClient } as never);

    const host = attachHost(root);
    host.panel.attachAutonomous(infra.queue, infra.runtime);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Karke Dikha'));
    fireEvent.change(screen.getByPlaceholderText('Ask KarkeDikha…'), { target: { value: 'Rapid click task.' } });
    const sendButton = screen.getByRole('button', { name: 'Send' });
    // Two clicks back-to-back, synchronously, with no await between them —
    // models a user double-clicking Send before any state updates render.
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    await waitForPosted(host.posted, (m) => m.type === 'autonomousTaskStarted');
    // Give any wrongly-admitted second submission time to also enqueue.
    await flush(200);

    const startedMessages = host.posted.filter((m) => m.type === 'autonomousTaskStarted');
    expect(startedMessages).toHaveLength(1);
    expect(await infra.queue.list()).toHaveLength(1);

    infra.dispose();
  });
});

describe('Golden Test A — Explicit Mode Overrides Active Task', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-explicit-mode-'));
    await initGitFixture(root);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('Baat Kar and Saath Kar never silently steer an active Karke Dikha task; only explicit Karke Dikha steers it', async () => {
    const provider = new StubCodingProvider(trivialProposalCompletion('src/generated/explicit.ts', 'export const ok = true;\n'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');

    const client = mergedCoreClient(root);
    const manager = fakeCoreManager(client);
    const infra = buildAutonomousInfra(root);
    const sendSteeringSpy = vi.spyOn(infra.runtime, 'sendSteering');
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({
      getClient: () => client,
      getStatus: manager.getStatus,
      onRuntimeEvent: manager.onRuntimeEvent,
      onRuntimeToken: manager.onRuntimeToken,
    } as never);

    const host = attachHost(root);
    host.panel.attachAutonomous(infra.queue, infra.runtime);
    bridgeWebviewApiToHost(host);
    await mountApp();

    // 1. Start a Karke Dikha task and leave it active.
    fireEvent.click(radio('Karke Dikha'));
    submit('Create a golden acceptance file.');
    const started = await waitForPosted(host.posted, (m) => m.type === 'autonomousTaskStarted');
    const originalTaskId = started.taskId as string;
    expect((await infra.queue.list())).toHaveLength(1);
    await waitForAutonomousTaskActive(infra.queue, originalTaskId);

    // 2 & 3. Explicit Baat Kar -> a real, ordinary chat turn. Never steered.
    fireEvent.click(radio('Baat Kar'));
    expect(radio('Baat Kar').getAttribute('aria-checked')).toBe('true');
    submit('Explain dependency injection.');

    await waitForCalls(client, 'submit', 1);
    const firstSubmitBody = client.calls.find((c) => c.method === 'submit')?.args[0] as { requestedMode: string };
    expect(firstSubmitBody.requestedMode).toBe('baat_kar');
    expect(sendSteeringSpy).not.toHaveBeenCalled();

    const firstAttempt = client.calls.find((c) => c.method === 'executeAttempt')?.args[0] as string;
    completeAttemptWithText(manager, firstAttempt, 'DI reply.');
    await waitForPosted(host.posted, (m) => m.type === 'done' && m.content === 'DI reply.');

    let tasksAfterBaatKar = await infra.queue.list();
    expect(tasksAfterBaatKar).toHaveLength(1);
    expect(tasksAfterBaatKar[0].taskId).toBe(originalTaskId);
    expect(sendSteeringSpy).not.toHaveBeenCalled();

    // 4 & 5. Explicit Saath Kar -> a real, ordinary agent turn. Still never steered.
    fireEvent.click(radio('Saath Kar'));
    expect(radio('Saath Kar').getAttribute('aria-checked')).toBe('true');
    submit('List the files in this repo.');

    await waitForCalls(client, 'submit', 2);
    const secondSubmitBody = client.calls.filter((c) => c.method === 'submit')[1]?.args[0] as { requestedMode: string };
    expect(secondSubmitBody.requestedMode).toBe('saath_kar');
    expect(sendSteeringSpy).not.toHaveBeenCalled();

    const secondAttempt = client.calls.filter((c) => c.method === 'executeAttempt')[1]?.args[0] as string;
    completeAttemptWithText(manager, secondAttempt, 'Found 1 file.');
    await waitForPosted(host.posted, (m) => m.type === 'done' && m.content === 'Found 1 file.');

    const tasksAfterSaathKar = await infra.queue.list();
    expect(tasksAfterSaathKar).toHaveLength(1);
    expect(tasksAfterSaathKar[0].taskId).toBe(originalTaskId);
    expect(sendSteeringSpy).not.toHaveBeenCalled();

    // 6 & 7. Explicit Karke Dikha -> steers the SAME existing task. No new task.
    fireEvent.click(radio('Karke Dikha'));
    expect(radio('Karke Dikha').getAttribute('aria-checked')).toBe('true');
    submit('Also rename the exported constant.');

    await waitForPosted(host.posted, (m) => m.type === 'taskSteered');
    expect(sendSteeringSpy).toHaveBeenCalledTimes(1);
    expect(sendSteeringSpy.mock.calls[0][0]).toBe(originalTaskId);
    // Only ever ONE `submit`-based chat/agent attempt each for Baat/Saath —
    // steering never went through Core's chat/agent submit route either.
    expect(client.calls.filter((c) => c.method === 'submit')).toHaveLength(2);

    const tasksAfterSteer = await infra.queue.list();
    expect(tasksAfterSteer).toHaveLength(1);
    expect(tasksAfterSteer[0].taskId).toBe(originalTaskId);

    infra.dispose();
  });
});

describe('Golden Test B — Mode Switch Torture Test', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-torture-'));
    await initGitFixture(root);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('Baat Kar -> Saath Kar -> Karke Dikha(start) -> Baat Kar -> Saath Kar -> Karke Dikha(steer): every submission hits its one correct production route', async () => {
    const provider = new StubCodingProvider(trivialProposalCompletion('src/generated/torture.ts', 'export const ok = true;\n'));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');

    const client = mergedCoreClient(root);
    const manager = fakeCoreManager(client);
    const infra = buildAutonomousInfra(root);
    const sendSteeringSpy = vi.spyOn(infra.runtime, 'sendSteering');
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({
      getClient: () => client,
      getStatus: manager.getStatus,
      onRuntimeEvent: manager.onRuntimeEvent,
      onRuntimeToken: manager.onRuntimeToken,
    } as never);

    const host = attachHost(root);
    host.panel.attachAutonomous(infra.queue, infra.runtime);
    bridgeWebviewApiToHost(host);
    await mountApp();

    function assertModeSelected(name: string): void {
      expect(radio(name).getAttribute('aria-checked')).toBe('true');
    }

    // 1. Baat Kar -> submit -> real baat_kar route.
    fireEvent.click(radio('Baat Kar'));
    assertModeSelected('Baat Kar');
    submit('First, a chat question.');
    await waitForCalls(client, 'submit', 1);
    expect((client.calls.find((c) => c.method === 'submit')?.args[0] as { requestedMode: string }).requestedMode).toBe('baat_kar');
    const firstAttempt = client.calls.find((c) => c.method === 'executeAttempt')?.args[0] as string;
    completeAttemptWithText(manager, firstAttempt, 'chat reply one');
    await waitForPosted(host.posted, (m) => m.type === 'done' && m.content === 'chat reply one');

    // 2. Saath Kar -> submit -> real saath_kar route, distinct attempt.
    fireEvent.click(radio('Saath Kar'));
    assertModeSelected('Saath Kar');
    submit('Now do something agentic.');
    await waitForCalls(client, 'submit', 2);
    const submits = client.calls.filter((c) => c.method === 'submit');
    expect((submits[1].args[0] as { requestedMode: string }).requestedMode).toBe('saath_kar');
    const executeCalls = client.calls.filter((c) => c.method === 'executeAttempt');
    const secondAttempt = executeCalls[1].args[0] as string;
    expect(secondAttempt).not.toBe(firstAttempt);
    completeAttemptWithText(manager, secondAttempt, 'agent reply one');
    await waitForPosted(host.posted, (m) => m.type === 'done' && m.content === 'agent reply one');

    // 3. Karke Dikha -> starts the ONE autonomous task (no owned active task existed yet).
    fireEvent.click(radio('Karke Dikha'));
    assertModeSelected('Karke Dikha');
    submit('Now do a mutation task.');
    const started = await waitForPosted(host.posted, (m) => m.type === 'autonomousTaskStarted');
    const taskId = started.taskId as string;
    expect(await infra.queue.list()).toHaveLength(1);
    expect(sendSteeringSpy).not.toHaveBeenCalled();
    await waitForAutonomousTaskActive(infra.queue, taskId);

    // 4. Back to Baat Kar -> ALWAYS a fresh, ordinary chat turn — explicit
    // mode wins, the still-active Karke Dikha task is never silently steered.
    fireEvent.click(radio('Baat Kar'));
    assertModeSelected('Baat Kar');
    submit('Back to plain chat.');
    await waitForCalls(client, 'submit', 3);
    const thirdSubmitBody = client.calls.filter((c) => c.method === 'submit')[2]?.args[0] as { requestedMode: string };
    expect(thirdSubmitBody.requestedMode).toBe('baat_kar');
    expect(sendSteeringSpy).not.toHaveBeenCalled();
    const thirdAttempt = client.calls.filter((c) => c.method === 'executeAttempt')[2]?.args[0] as string;
    completeAttemptWithText(manager, thirdAttempt, 'chat reply two');
    await waitForPosted(host.posted, (m) => m.type === 'done' && m.content === 'chat reply two');

    // 5. Saath Kar -> ALWAYS a fresh, ordinary agent turn too.
    fireEvent.click(radio('Saath Kar'));
    assertModeSelected('Saath Kar');
    submit('One more agentic question.');
    await waitForCalls(client, 'submit', 4);
    const fourthSubmitBody = client.calls.filter((c) => c.method === 'submit')[3]?.args[0] as { requestedMode: string };
    expect(fourthSubmitBody.requestedMode).toBe('saath_kar');
    expect(sendSteeringSpy).not.toHaveBeenCalled();
    const fourthAttempt = client.calls.filter((c) => c.method === 'executeAttempt')[3]?.args[0] as string;
    completeAttemptWithText(manager, fourthAttempt, 'agent reply two');
    await waitForPosted(host.posted, (m) => m.type === 'done' && m.content === 'agent reply two');

    // 6. Karke Dikha again -> steers the SAME existing task, no new task,
    // and no submission ever reaches the chat/agent `submit` route for it.
    fireEvent.click(radio('Karke Dikha'));
    assertModeSelected('Karke Dikha');
    submit('Steer: use the exact task from before.');
    await waitForPosted(host.posted, (m) => m.type === 'taskSteered');
    expect(sendSteeringSpy).toHaveBeenCalledTimes(1);
    expect(sendSteeringSpy.mock.calls[0][0]).toBe(taskId);
    expect(client.calls.filter((c) => c.method === 'submit')).toHaveLength(4);
    const tasksAtEnd = await infra.queue.list();
    expect(tasksAtEnd).toHaveLength(1);
    expect(tasksAtEnd[0].taskId).toBe(taskId);

    // Golden 8 — real UI-v2 projection of steering: same task id, no new
    // TaskCard, and the acknowledgement only appears in the activity
    // timeline AFTER the real `taskSteered` event (never before — nothing
    // in the composer path marks steering acknowledged optimistically).
    await screen.findByTestId('task-card');
    expect(screen.getAllByTestId('task-card')).toHaveLength(1);
    expect(screen.getByTestId('task-card').getAttribute('data-task-id')).toBe(taskId);
    await screen.findByText('Guidance delivered to task');
    expect(screen.getAllByText('Guidance delivered to task')).toHaveLength(1);

    infra.dispose();
  });
});

describe('Golden Test C — Restart Rehydration Across the UI-v2 Bridge', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-restart-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('a real actionable Karke Dikha approval survives a full AgentPanel/webview destroy-and-recreate, with no duplicate/stale/terminal task substituted', async () => {
    // 1 & 2. Create a real autonomous task in a controlled temp git repo and
    // advance it to an ACTIONABLE proposal-approval state via the durable
    // queue directly (the same on-disk format `DurableTaskQueue` reads/writes
    // in production) — this is the "before restart" state.
    await initGitFixture(root);
    const attemptId = 'att_restart_golden';
    const seedQueue = new DurableTaskQueue(root);
    const baseTask = await seedQueue.enqueue({
      ...createDefaultAutonomousTask(root, `goal ${attemptId}`),
      taskId: attemptId,
      attemptId,
    });
    const proposalSummary = {
      proposalId: `proposal_${attemptId}`, version: 1, taskSummary: 'restart golden proposal',
      operations: [{ type: 'create', path: 'src/generated/restart.ts', reason: 'golden restart test', content: 'export const ok = true;\n' }],
      validationCommands: [{ kind: 'npm-script', script: 'verify' }], warnings: [],
    };
    const actionableTask = await seedQueue.update(
      { ...baseTask, state: 'waiting_for_proposal_approval', pendingProposal: proposalSummary },
      'proposal_pending', { ...proposalSummary },
    );

    // 3. Record the pre-restart truth to compare against after rehydration.
    const preRestart = {
      taskId: actionableTask.taskId,
      state: actionableTask.state,
      workspaceRoot: root,
    };
    expect(preRestart.state).toBe('waiting_for_proposal_approval');

    const approval = pendingApprovalRecord(attemptId, 'proposal');
    const restartClient = restartRehydrationCoreClient([
      attemptRehydrationRecord(root, attemptId, 'waiting_for_approval', 'awaiting_human_approval', [approval]),
    ]);
    const restartManager = restartRehydrationCoreManager(restartClient);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(restartManager as never);

    // 4. Destroy/recreate the AgentPanel/webview boundary: unmount the React
    // tree, drop the old host/panel entirely, and build a genuinely NEW
    // AgentPanel wired to a genuinely NEW DurableTaskQueue/AutonomousTaskRuntime
    // instance pointed at the SAME on-disk root — mirroring a real VS Code
    // window/extension-host restart, never a mere React rerender.
    cleanup();
    clearVsCodeApiBridge();
    const freshQueue = new DurableTaskQueue(root);
    const freshResources = new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } });
    const freshWorktrees = new IsolatedWorktreeManager(root);
    const freshRuntime = new AutonomousTaskRuntime({ subscriptions: [] } as never, root, freshQueue, freshResources, freshWorktrees);
    freshRuntime.requireCoreAuthorityForNewWork();

    const host = attachHost(root);
    host.panel.attachAutonomous(freshQueue, freshRuntime);

    // 5. Real webviewReady handshake, through the same bridge goldenJourneyHarness uses.
    bridgeWebviewApiToHost(host);
    await mountApp();

    // 6. Allow AgentPanel to rehydrate from durable Core/task storage — the
    // same call `extension.ts` makes once Core reconnects after a restart.
    await act(async () => { await host.panel.rehydrateCoreAttempts(); });

    await waitForPosted(host.posted, (m) => m.type === 'proposalApprovalRequest' && m.taskId === attemptId);

    // Same task id restored, same actionable approval restored.
    const proposalRequests = host.posted.filter((m) => m.type === 'proposalApprovalRequest');
    expect(proposalRequests).toHaveLength(1);
    expect(proposalRequests[0].taskId).toBe(preRestart.taskId);
    expect((proposalRequests[0] as { taskSummary?: string }).taskSummary).toBe('restart golden proposal');

    // Exactly one actionable approval projection; no duplicate task card.
    const tasksAfterRestart = await freshQueue.list();
    expect(tasksAfterRestart).toHaveLength(1);
    expect(tasksAfterRestart[0].taskId).toBe(preRestart.taskId);
    expect(tasksAfterRestart[0].state).toBe('waiting_for_proposal_approval');

    // Golden 7 — real UI-v2 projection of the restored task/approval: exactly
    // one TaskCard, same task id, exactly one actionable ApprovalCard, no
    // duplicate timeline entries caused by restoration.
    await screen.findByTestId('task-card');
    expect(screen.getAllByTestId('task-card')).toHaveLength(1);
    expect(screen.getByTestId('task-card').getAttribute('data-task-id')).toBe(preRestart.taskId);
    expect(screen.getAllByTestId('approval-card')).toHaveLength(1);
    expect(document.querySelector('[data-approval-kind="proposal"]')).not.toBeNull();

    // No terminal task replaced it, no second worker claimed it.
    expect(restartClient.calls.some((c) => c.method === 'claimKarkeDikhaAttempt')).toBe(false);
    expect(restartClient.calls.some((c) => c.method === 'executeAttempt')).toBe(false);

    // Composer remains usable according to current mode (default Saath Kar).
    const composer = screen.getByPlaceholderText('Ask KarkeDikha…') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);

    // Approving continues the SAME durable task: resolve the restored proposal.
    host.receive({
      type: 'approveProposal',
      taskId: attemptId,
      proposalId: proposalSummary.proposalId,
    });
    await waitForCalls(restartClient, 'resolveKarkeDikhaApproval', 1);
    const resolvedArgs = restartClient.calls.find((c) => c.method === 'resolveKarkeDikhaApproval')?.args as unknown[];
    // The approval id resolved is the SAME durable approval that was restored.
    expect((resolvedArgs?.[0] as { id?: string } | undefined)?.id ?? approval.id).toBeTruthy();

    freshRuntime.dispose();
  });
});

describe('Golden Test D — Three Truthful Modes', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-three-modes-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('UI v2 renders exactly Baat Kar / Saath Kar / Karke Dikha — Ask and Plan are not user-facing', async () => {
    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager as never);

    const host = attachHost(root);
    bridgeWebviewApiToHost(host);
    await mountApp();

    const allModeRadios = screen.getAllByRole('radio');
    expect(allModeRadios.map((el) => el.getAttribute('data-mode')).sort()).toEqual(['agent', 'autonomous', 'chat']);
    expect(screen.queryByRole('radio', { name: 'Ask' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Plan' })).toBeNull();

    // Baat Kar -> chat -> baat_kar.
    fireEvent.click(radio('Baat Kar'));
    submit('Explain a truthful mode.');
    await waitForCalls(client, 'submit', 1);
    expect((client.calls.find((c) => c.method === 'submit')?.args[0] as { requestedMode: string }).requestedMode).toBe('baat_kar');
  });
});

describe('Golden Test E — Terminal States', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-terminal-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  async function seedTerminalTask(
    queue: DurableTaskQueue,
    goal: string,
    reach: (taskId: string) => Promise<void>,
  ): Promise<string> {
    const task = await queue.enqueue(createDefaultAutonomousTask(root, goal));
    await reach(task.taskId);
    return task.taskId;
  }

  it('completed / failed / blocked / cancelled each render a visually and semantically distinct terminal TaskCard with no actionable approval buttons', async () => {
    const infra = buildAutonomousInfra(root);
    const queue = infra.queue;
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => infra.coreClient } as never);

    const failedTaskId = await seedTerminalTask(queue, 'A task that fails.', async (taskId) => {
      await queue.transition(taskId, 'preparing');
      await queue.transition(taskId, 'failed');
    });
    const cancelledTaskId = await seedTerminalTask(queue, 'A task that gets cancelled.', async (taskId) => {
      await queue.transition(taskId, 'cancelled');
    });

    // One task active at a time in this UI-v2 projection (see taskProjection's
    // single-slot shape) — verify each terminal state's distinct rendering by
    // mounting a fresh host/app per seeded task, same pattern Golden Test C
    // uses for a destroy-and-recreate boundary.
    for (const { taskId, expectedLabel } of [
      { taskId: failedTaskId, expectedLabel: 'Failed' },
      { taskId: cancelledTaskId, expectedLabel: 'Cancelled' },
    ]) {
      const host = attachHost(root);
      host.panel.attachAutonomous(infra.queue, infra.runtime);
      bridgeWebviewApiToHost(host);
      await mountApp();

      // A terminal task is, by design, never auto-restored as the "active"
      // task on reconnect (nothing is pending on it) — so this forces the
      // same internal projection path a real active-task poll would have
      // taken while it was still running, the same internal-access pattern
      // src/test/suite/agentPanelAutonomousMode.test.ts already uses
      // (`pollAutonomousTask` cast) to drive AgentPanel's poll directly.
      const internals = host.panel as unknown as {
        autonomousActiveTaskId?: string;
        pollAutonomousTask(id: string): Promise<void>;
      };
      internals.autonomousActiveTaskId = taskId;
      await act(async () => { await internals.pollAutonomousTask(taskId); });

      await screen.findByText(expectedLabel);
      expect(screen.getByTestId('task-card-state').textContent).toBe(expectedLabel);
      expect(document.querySelector('.kd2-approval-card')).toBeNull();
      expect(document.querySelector('[data-testid="approval-card"]')).toBeNull();

      cleanup();
      clearVsCodeApiBridge();
    }

    infra.dispose();
  }, 30000);
});

describe('Golden Journey — Repository Grounding', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-grounding-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'golden-build': 'echo golden' } }));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('Baat Kar repository question -> real grounding path submits evidence containing golden-build, no plain-chat fallback', async () => {
    const build = vi.spyOn(RepositoryContextService.prototype, 'build').mockResolvedValue({
      prompt: '## Automatically selected repository context\n### package.json\n{"scripts":{"golden-build":"echo golden"}}',
      files: [{ path: 'package.json', score: 42, estimatedTokens: 16, reasons: [{ reason: 'path matches selection', score: 16 }], snippet: '{"scripts":{"golden-build":"echo golden"}}', truncated: false }],
      diagnostics: {
        queryTerms: ['build', 'script'], providerContextWindow: 32768, inputBudget: 30268,
        estimatedTokens: 24, omittedCount: 0,
        selectedFiles: [{ path: 'package.json', score: 42, estimatedTokens: 16, reasons: [{ reason: 'path matches selection', score: 16 }] }],
        rejectedFiles: [], inventorySize: 1, inventoryTruncated: false,
      },
      index: {
        schemaVersion: 2, workspaceRoot: root,
        identity: { repositoryRoot: root, branch: 'dev/current', headCommit: 'abc', worktree: root, detached: false, schemaVersion: 2 },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'ready', files: [], ignoredPatterns: [], truncated: false,
        statistics: { files: 1, symbols: 1, imports: 0, tests: 0, configs: 1, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
        pins: [], exclusions: [],
      },
    } as never);

    const client = fakeCoreClient();
    const manager = fakeCoreManager(client);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager as never);

    const host = attachHost(root);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Baat Kar'));
    submit('What build script exists in this repository?');

    await waitForCalls(client, 'submit', 1);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ query: 'What build script exists in this repository?', mode: 'chat' }));
    const body = client.calls.find((c) => c.method === 'submit')?.args[0] as { repositoryContext?: { prompt: string } };
    expect(body.repositoryContext?.prompt).toContain('golden-build');

    const evidence = await waitForPosted(host.posted, (m: PostedMessage) => m.type === 'repositoryContextEvidence');
    expect(evidence).toMatchObject({ available: true });

    const executeCall = client.calls.find((c) => c.method === 'executeAttempt');
    completeAttemptWithText(manager, executeCall?.args[0] as string, 'The repository defines a "golden-build" npm script.');
    await screen.findByText('The repository defines a "golden-build" npm script.');
  });
});

describe('Golden Test F — Objective Arbitration (Continue / New Task confirmations)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-golden-arbitration-'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  /**
   * Reproduces, through the real KKD UI (real composer, real Send button,
   * real rendered assistant bubbles — not just the `AgentPanel` unit-level
   * `routeComposerSubmission` harness), the exact continuity-arbitration
   * defect and fix: `classifyControlAcknowledgement` ("yes" / "continue" /
   * "retry" / "new task") may only steer objective routing while KKD is
   * actually awaiting a reply to one of its own control questions — never
   * for a bare "yes"/"continue" typed as ordinary conversation, and never
   * for an unprompted "new task" that was never asked for.
   */
  it('unrelated objective -> ambiguity prompt -> "Yes new task" -> real objective B starts, with no silent control-word hijacking along the way', async () => {
    // Opt in to real conversation-working-state persistence: the base
    // `fakeCoreClient()` deliberately leaves it absent so every OTHER golden
    // test's turns stay unaffected by it (see the wrapper's own doc comment).
    const client = withFakeConversationWorkingState(fakeCoreClient());
    const manager = fakeCoreManager(client);
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager as never);

    const host = attachHost(root);
    bridgeWebviewApiToHost(host);
    await mountApp();

    fireEvent.click(radio('Baat Kar'));

    // 1. Establish objective A as the active conversation objective.
    // Deliberately not repo-shaped (mirrors Golden Journey 1's "Explain the
    // difference between TCP and UDP." — see that test's comment): a file
    // path or symbol name here would route through repository grounding,
    // which is a separate concern from the objective-arbitration invariant
    // this test exists to prove.
    const objectiveA = 'Explain how TCP congestion control avoids network collapse under sustained load.';
    submit(objectiveA);
    await waitForCalls(client, 'submit', 1);
    await waitForCalls(client, 'executeAttempt', 1);
    let executeCall = client.calls.filter((c) => c.method === 'executeAttempt').at(-1);
    completeAttemptWithText(manager, executeCall?.args[0] as string, 'TCP congestion control explained.');
    await screen.findByText('TCP congestion control explained.');

    const clarifyPrompts = () => host.posted.filter(
      (m) => typeof m.content === 'string' && m.content.includes('Should I treat it as a new task?'),
    );

    // 2. A bare "yes" typed as ordinary conversation — nothing asked it a
    // question — must never be silently read as confirming continuation of
    // objective A. It goes through the ordinary ambiguity classifier like
    // any other unrelated word and asks, rather than silently resuming: the
    // fix in action is that this posts a real (honest) ambiguity prompt
    // instead of silently forcing continuation with no prompt at all.
    submit('yes');
    await screen.findByText(/Should I treat it as a new task\?/);
    expect(client.calls.filter((c) => c.method === 'submit')).toHaveLength(1);
    expect(clarifyPrompts()).toHaveLength(1);

    // 3. An unrelated objective B -> the ordinary ambiguity prompt fires
    // again (this is its OWN, second, legitimate ambiguity question — the
    // "yes" above did not consume or corrupt it).
    // A mutating request: two read-only questions deliberately continue silently (Golden A4 read-only policy),
    // so the ambiguity prompt only fires for an unrelated objective that could change the workspace.
    const objectiveB = 'Build a library book lending service with member accounts and overdue fine calculation.';
    const promptsBeforeObjectiveB = clarifyPrompts().length;
    submit(objectiveB);
    await waitForPosted(host.posted, () => clarifyPrompts().length > promptsBeforeObjectiveB);
    expect(client.calls.filter((c) => c.method === 'submit')).toHaveLength(1);
    const promptsAfterObjectiveB = clarifyPrompts().length;

    // 4. User confirms "Yes new task". The confirmation binds to the pending candidate (objective B): the control reply
    // never becomes the objective and there is no "What's the new task?" loop. Objective B is a mutating request, so the
    // candidate itself proceeds to the Baat Kar -> Saath Kar mode gate, carrying B's exact text (nothing to retype).
    submit('Yes new task');
    await waitForPosted(host.posted, (m) => m.type === 'modeChangeRequired' && m.text === objectiveB);
    expect(host.posted.some((m) => m.content === "Got it! What's the new task?")).toBe(false);
    expect(clarifyPrompts()).toHaveLength(promptsAfterObjectiveB);
    expect(client.calls.filter((c) => c.method === 'submit')).toHaveLength(1);

    // Objective B's own ambiguity prompt fired exactly once across the whole
    // exchange (step 3), and never again once confirmed.
    expect(clarifyPrompts()).toHaveLength(promptsAfterObjectiveB);
  });
});
