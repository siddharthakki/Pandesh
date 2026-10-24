/**
 * Conversation -> KarkeDikha Execution Handoff & Continuity Tests
 *
 * Validates:
 * 1. Stale temporary constraints ("Do not change any files yet") are superseded
 *    by later explicit positive mutation instructions ("Add regression coverage...").
 * 2. Conversational deictic referents ("those two cases", "that bug", "the second option",
 *    "what you just suggested", "those files") are compiled into self-contained
 *    concrete objectives before task creation.
 * 3. Precedence: latest explicit instruction > earlier conflicting temporary constraint > inferred context.
 * 4. Non-conflicting constraints carry forward honestly.
 * 5. Genuinely ambiguous referents fail closed with clarification rather than guessing.
 * 6. Compiled autonomous objectives are self-contained without conversational pronouns.
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import {
  compileAutonomousObjective,
  detectConstraintOverrides,
  reconcileConstraints,
  isTemporaryConstraint,
  hasPositiveMutationIntent,
  hasDeicticReference,
  hasUnresolvedDeicticReference,
  extractEnumeratedCases,
  extractNumberedOptions,
  extractAssistantSuggestion,
  extractAssistantBugDescription,
  extractRelevantFilePaths,
  formatCarriedConstraints,
} from '../../orchestration/ConversationContinuity';
import type { ConversationWorkingStateRecord, ConversationConstraint } from '../../../core/shared/wireTypes';

describe('Conversation -> KarkeDikha Execution Handoff', () => {
  describe('Defect 1: Stale constraint persistence & precedence', () => {
    it('Do not change files yet followed later by explicit add tests -> mutation is allowed', () => {
      const earlierConstraints: ConversationConstraint[] = [
        {
          id: 'cons_1',
          text: 'Do not change any files yet.',
          createdAt: '2026-09-20T10:00:00.000Z',
        },
      ];

      const laterInstruction =
        'Good. Add regression coverage for those two cases. If the tests expose a real implementation bug, fix it minimally. Otherwise don\'t touch production code.';

      expect(isTemporaryConstraint(earlierConstraints[0].text)).toBe(true);
      expect(hasPositiveMutationIntent(laterInstruction)).toBe(true);

      const overriddenIds = detectConstraintOverrides(laterInstruction, earlierConstraints);
      expect(overriddenIds).toContain('cons_1');

      const reconciliation = reconcileConstraints(laterInstruction, earlierConstraints, '2026-09-20T10:05:00.000Z');
      expect(reconciliation.overriddenIds).toContain('cons_1');
      expect(reconciliation.constraints.some(c => c.text.includes('Do not change any files yet'))).toBe(false);
    });

    it('non-conflicting constraints still carry forward', () => {
      const earlierConstraints: ConversationConstraint[] = [
        {
          id: 'cons_temp',
          text: 'Do not change any files yet.',
          createdAt: '2026-09-20T10:00:00.000Z',
        },
        {
          id: 'cons_permanent',
          text: 'preserve the existing API contract',
          createdAt: '2026-09-20T10:00:00.000Z',
        },
        {
          id: 'cons_style',
          text: 'use the existing test framework',
          createdAt: '2026-09-20T10:00:00.000Z',
        },
      ];

      const laterInstruction = 'Add regression tests for the payment calculator.';
      const overriddenIds = detectConstraintOverrides(laterInstruction, earlierConstraints);

      // Temporary constraint is overridden by positive mutation intent
      expect(overriddenIds).toContain('cons_temp');
      // Non-conflicting constraints remain standing
      expect(overriddenIds).not.toContain('cons_permanent');
      expect(overriddenIds).not.toContain('cons_style');

      const reconciliation = reconcileConstraints(laterInstruction, earlierConstraints, '2026-09-20T10:05:00.000Z');
      const remainingTexts = reconciliation.constraints.map(c => c.text);
      expect(remainingTexts).not.toContain('Do not change any files yet.');
      expect(remainingTexts).toContain('preserve the existing API contract');
      expect(remainingTexts).toContain('use the existing test framework');

      // formatCarriedConstraints carries only the non-conflicting constraints
      const state: ConversationWorkingStateRecord = {
        schemaVersion: 1,
        conversationId: 'c1',
        workspaceIdentity: 'w1',
        currentObjective: 'Test payment calculator',
        objectiveFingerprint: 'test payment calculator',
        relevantFiles: [],
        latestExecutionPolicy: 'AUTONOMOUS_EXECUTION',
        userConstraints: reconciliation.constraints,
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        updatedAt: '2026-09-20T10:05:00.000Z',
      };

      const carried = formatCarriedConstraints(state);
      expect(carried).toContain('preserve the existing API contract');
      expect(carried).toContain('use the existing test framework');
      expect(carried).not.toContain('Do not change any files yet');
    });
  });

  describe('Defect 2: Unresolved conversational referent resolution', () => {
    const PRECEDING_ASSISTANT_TURN = `
I have investigated compute_order_total and identified two concrete edge cases:
1. loyalty_percent = 100 through compute_order_total
2. coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary
`;

    it('those two cases resolves to the two cases selected in the immediately preceding conversational turn', () => {
      const extracted = extractEnumeratedCases(PRECEDING_ASSISTANT_TURN);
      expect(extracted).toHaveLength(2);
      expect(extracted[0]).toBe('loyalty_percent = 100 through compute_order_total');
      expect(extracted[1]).toBe('coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary');

      const userInstruction =
        'Good. Add regression coverage for those two cases. If the tests expose a real implementation bug, fix it minimally. Otherwise don\'t touch production code.';

      const result = compileAutonomousObjective({
        text: userInstruction,
        state: null,
        precedingAssistantMessage: PRECEDING_ASSISTANT_TURN,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('loyalty_percent = 100 through compute_order_total');
        expect(result.objective).toContain('coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary');
        expect(result.objective).not.toMatch(/\bthose two cases\b/i);
        expect(hasUnresolvedDeicticReference(result.objective)).toBe(false);
      }
    });

    it('resolves bulleted cases as well as numbered cases', () => {
      const bulletedTurn = `
Here are the cases to cover:
- loyalty_percent = 100 through compute_order_total
- coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary
`;
      const result = compileAutonomousObjective({
        text: 'Add regression tests for those two cases.',
        state: null,
        precedingAssistantMessage: bulletedTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('loyalty_percent = 100 through compute_order_total');
        expect(result.objective).toContain('coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary');
      }
    });

    it('resolves the two cases from the Markdown headings emitted by the packaged Baat Kar response', () => {
      const packagedAssistantTurn = `
## Top two by production risk

### 1. \`quantity\` arriving as a non-integer (gap #2)

This can silently misprice an order when a Decimal quantity reaches Item.line_total().

### 2. A \`float\` sneaking into a price or rate (gap #3)

Decimal(float) can silently shift half-cent rounding in money().
`;
      const extracted = extractEnumeratedCases(packagedAssistantTurn);
      expect(extracted).toEqual([
        'quantity arriving as a non-integer (gap #2)',
        'A float sneaking into a price or rate (gap #3)',
      ]);

      const result = compileAutonomousObjective({
        text: 'Good. Add regression coverage for those two cases. If the tests expose a real implementation bug, fix it minimally. Otherwise don\'t touch production code. Run the focused pricing tests and the full pytest suite.',
        state: null,
        precedingAssistantMessage: packagedAssistantTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('quantity arriving as a non-integer (gap #2)');
        expect(result.objective).toContain('A float sneaking into a price or rate (gap #3)');
        expect(result.objective).toContain('don\'t touch production code');
        expect(result.objective).not.toMatch(/\bthose two cases\b/i);
        expect(hasUnresolvedDeicticReference(result.objective)).toBe(false);
      }
    });

    it('resolves bare two-line cases without bullets or numbers', () => {
      const bareTurn = `
loyalty_percent = 100 through compute_order_total
coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary
`;
      const result = compileAutonomousObjective({
        text: 'Add tests for those two cases.',
        state: null,
        precedingAssistantMessage: bareTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('loyalty_percent = 100 through compute_order_total');
        expect(result.objective).toContain('coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary');
      }
    });

    it('resolves "the second option" to option 2 from preceding turn', () => {
      const assistantTurn = `
We have two approaches:
Option 1: Add input validation directly to registerUser in src/auth/registerUser.ts
Option 2: Create a separate validation middleware in src/middleware/validate.ts
`;
      const result = compileAutonomousObjective({
        text: 'Go ahead and implement the second option.',
        state: null,
        precedingAssistantMessage: assistantTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('Create a separate validation middleware in src/middleware/validate.ts');
        expect(result.objective).not.toMatch(/\bthe second option\b/i);
        expect(hasUnresolvedDeicticReference(result.objective)).toBe(false);
      }
    });

    it('resolves "what you just suggested" to assistant recommendation', () => {
      const assistantTurn = 'I recommend creating a dedicated test helper in test/helpers/orderFixture.ts to mock orders.';
      const result = compileAutonomousObjective({
        text: 'Implement what you just suggested.',
        state: null,
        precedingAssistantMessage: assistantTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('creating a dedicated test helper in test/helpers/orderFixture.ts to mock orders');
        expect(result.objective).not.toMatch(/\bwhat you just suggested\b/i);
        expect(hasUnresolvedDeicticReference(result.objective)).toBe(false);
      }
    });

    it('resolves "that bug" from preceding context and working state', () => {
      const assistantTurn = 'The bug is an off-by-one boundary condition in calculateShipping when merchandise total is zero.';
      const result = compileAutonomousObjective({
        text: 'Fix that bug and add a regression test.',
        state: null,
        precedingAssistantMessage: assistantTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('an off-by-one boundary condition in calculateShipping when merchandise total is zero');
        expect(result.objective).not.toMatch(/\bthat bug\b/i);
        expect(hasUnresolvedDeicticReference(result.objective)).toBe(false);
      }
    });

    it('resolves "those files" from working state and context', () => {
      const state: ConversationWorkingStateRecord = {
        schemaVersion: 1,
        conversationId: 'c1',
        workspaceIdentity: 'w1',
        currentObjective: 'Audit order totals',
        objectiveFingerprint: 'audit order totals',
        relevantFiles: [{ path: 'src/orders/total.ts' }, { path: 'src/orders/discounts.ts' }],
        latestExecutionPolicy: 'AUTONOMOUS_EXECUTION',
        userConstraints: [],
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        updatedAt: '2026-09-20T10:00:00.000Z',
      };

      const result = compileAutonomousObjective({
        text: 'Add regression coverage for those files.',
        state,
        precedingAssistantMessage: 'I reviewed src/orders/total.ts and src/orders/discounts.ts.',
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        expect(result.objective).toContain('src/orders/total.ts');
        expect(result.objective).toContain('src/orders/discounts.ts');
        expect(result.objective).not.toMatch(/\bthose files\b/i);
        expect(hasUnresolvedDeicticReference(result.objective)).toBe(false);
      }
    });
  });

  describe('Fail-closed behavior: genuinely ambiguous references remain blocked/clarified', () => {
    it('blocks with clarification when "those two cases" cannot be resolved (0 cases found)', () => {
      const result = compileAutonomousObjective({
        text: 'Add regression coverage for those two cases.',
        state: null,
        precedingAssistantMessage: 'I looked at the code and everything seems ok.',
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status === 'needs_clarification') {
        expect(result.message).toMatch(/couldn't identify the two cases/i);
      }
    });

    it('blocks with clarification when "those two cases" finds 3 cases (ambiguous which two)', () => {
      const threeCasesTurn = `
Here are the candidate edge cases:
1. loyalty_percent = 100
2. coupon equal to merchandise
3. negative merchandise total
`;
      const result = compileAutonomousObjective({
        text: 'Add regression coverage for those two cases.',
        state: null,
        precedingAssistantMessage: threeCasesTurn,
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status === 'needs_clarification') {
        expect(result.message).toMatch(/couldn't identify the two cases/i);
      }
    });

    it('blocks with clarification when requested option does not exist', () => {
      const oneOptionTurn = `
Approach 1: Refactor the helper function in src/util.ts
`;
      const result = compileAutonomousObjective({
        text: 'Implement the second option.',
        state: null,
        precedingAssistantMessage: oneOptionTurn,
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status === 'needs_clarification') {
        expect(result.message).toMatch(/couldn't identify the requested option/i);
      }
    });

    it('blocks with clarification when "what you suggested" has no suggestion', () => {
      const result = compileAutonomousObjective({
        text: 'Implement what you just suggested.',
        state: null,
        precedingAssistantMessage: 'What do you think about the architecture?',
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status === 'needs_clarification') {
        expect(result.message).toMatch(/not sure which suggestion/i);
      }
    });

    it('blocks with clarification when "that bug" has no bug description', () => {
      const result = compileAutonomousObjective({
        text: 'Fix that bug now.',
        state: null,
        precedingAssistantMessage: 'All unit tests are passing successfully.',
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status === 'needs_clarification') {
        expect(result.message).toMatch(/not sure which bug/i);
      }
    });

    it('blocks with clarification when "those files" has no file paths', () => {
      const result = compileAutonomousObjective({
        text: 'Inspect those files and fix them.',
        state: null,
        precedingAssistantMessage: 'I reviewed the overall design and architecture.',
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status === 'needs_clarification') {
        expect(result.message).toMatch(/not sure which files/i);
      }
    });
  });

  describe('End-to-end acceptance scenario: combined Defect 1 + Defect 2', () => {
    it('compiles a self-contained objective superseding stale constraint and resolving two cases', () => {
      const earlierWorkingState: ConversationWorkingStateRecord = {
        schemaVersion: 1,
        conversationId: 'c1',
        workspaceIdentity: 'w1',
        currentObjective: 'Investigate order calculation edge cases in compute_order_total',
        objectiveFingerprint: 'investigate order calculation edge cases compute order total',
        relevantFiles: [{ path: 'src/orders/total.ts' }],
        latestExecutionPolicy: 'READ_ONLY',
        userConstraints: [
          {
            id: 'c_temp',
            text: 'Do not change any files yet.',
            createdAt: '2026-09-20T09:00:00.000Z',
          },
          {
            id: 'c_perm',
            text: 'maintain backward compatibility with v1 clients',
            createdAt: '2026-09-20T09:00:00.000Z',
          },
        ],
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        updatedAt: '2026-09-20T09:00:00.000Z',
      };

      const precedingAssistantTurn = `
I inspected compute_order_total and identified two concrete edge cases to verify:
1. loyalty_percent = 100 through compute_order_total
2. coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary
`;

      const userInstruction =
        'Good. Add regression coverage for those two cases. If the tests expose a real implementation bug, fix it minimally. Otherwise don\'t touch production code.';

      const result = compileAutonomousObjective({
        text: userInstruction,
        state: earlierWorkingState,
        precedingAssistantMessage: precedingAssistantTurn,
      });

      expect(result.status).toBe('compiled');
      if (result.status === 'compiled') {
        const objective = result.objective;

        // 1. "those two cases" was resolved to concrete cases
        expect(objective).toContain('loyalty_percent = 100 through compute_order_total');
        expect(objective).toContain('coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary');
        expect(objective).not.toMatch(/\bthose two cases\b/i);

        // 2. Stale constraint "Do not change any files yet" is NOT carried forward
        expect(objective).not.toContain('Do not change any files yet');

        // 3. Non-conflicting earlier constraint IS carried forward
        expect(objective).toContain('maintain backward compatibility with v1 clients');

        // 4. Latest explicit instruction is fully preserved
        expect(objective).toContain('If the tests expose a real implementation bug, fix it minimally');
        expect(objective).toContain('Otherwise don\'t touch production code');

        // 5. Objective is self-contained: no unresolved conversational pronouns
        expect(hasUnresolvedDeicticReference(objective)).toBe(false);
      }
    });
  });

  describe('AgentPanel Composer Funnel Integration (mode: autonomous)', () => {
    function createMockContext(): any {
      const state = new Map<string, unknown>();
      return {
        subscriptions: [],
        extensionUri: { fsPath: '/test' },
        workspaceState: {
          get: (k: string) => state.get(k),
          update: async (k: string, v: unknown) => { state.set(k, v); },
        },
        globalState: {
          get: (k: string) => state.get(k),
          update: async (k: string, v: unknown) => { state.set(k, v); },
        },
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
        extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
      };
    }

    it('compiles objective and filters stale constraint when routing autonomous submission', async () => {
      const posted: any[] = [];
      const panel = new AgentPanel(createMockContext(), process.cwd());
      (panel as any).completeWorkspaceRestoration = async () => {};

      (panel as any).view = {
        webview: {
          postMessage: async (msg: any) => { posted.push(msg); return true; },
        },
      };

      // Set working state with earlier temporary constraint
      (panel as any).conversationWorkingState = {
        schemaVersion: 1,
        conversationId: 'c1',
        workspaceIdentity: 'w1',
        currentObjective: 'Investigate order calculation edge cases in compute_order_total',
        objectiveFingerprint: 'investigate order calculation edge cases compute order total',
        relevantFiles: [{ path: 'src/orders/total.ts' }],
        latestExecutionPolicy: 'READ_ONLY',
        latestFindingsSummary: `
1. loyalty_percent = 100 through compute_order_total
2. coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary
`,
        userConstraints: [
          {
            id: 'c_temp',
            text: 'Do not change any files yet.',
            createdAt: '2026-09-20T09:00:00.000Z',
          },
          {
            id: 'c_keep',
            text: 'keep error formatting consistent',
            createdAt: '2026-09-20T09:00:00.000Z',
          },
        ],
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        updatedAt: '2026-09-20T09:00:00.000Z',
      };

      let submittedEffectiveText = '';
      const route = (panel as any).routeComposerSubmission.bind(panel);

      const userText =
        'Good. Add regression coverage for those two cases. If the tests expose a real implementation bug, fix it minimally. Otherwise don\'t touch production code.';

      await route(
        userText,
        (effectiveText: string) => {
          submittedEffectiveText = effectiveText;
        },
        'autonomous',
      );

      // Verify submission was called with the compiled, self-contained objective
      expect(submittedEffectiveText).toBeTruthy();
      expect(submittedEffectiveText).toContain('loyalty_percent = 100 through compute_order_total');
      expect(submittedEffectiveText).toContain('coupon equal to/exceeding merchandise, specifically the zero-merchandise + shipping boundary');
      expect(submittedEffectiveText).not.toMatch(/\bthose two cases\b/i);
      expect(submittedEffectiveText).not.toContain('Do not change any files yet');
      expect(submittedEffectiveText).toContain('keep error formatting consistent');
      expect(hasUnresolvedDeicticReference(submittedEffectiveText)).toBe(false);
    });

    it('fails closed with clarification when autonomous submission has unresolvable references', async () => {
      const posted: any[] = [];
      const panel = new AgentPanel(createMockContext(), process.cwd());

      (panel as any).view = {
        webview: {
          postMessage: async (msg: any) => { posted.push(msg); return true; },
        },
      };

      (panel as any).conversationWorkingState = null;

      let submitted = false;
      const route = (panel as any).routeComposerSubmission.bind(panel);

      await route(
        'Add regression coverage for those two cases.',
        () => {
          submitted = true;
        },
        'autonomous',
      );

      // Autonomous task was NOT started
      expect(submitted).toBe(false);

      // A clarification done message was posted
      const doneMsg = posted.find(m => m.type === 'done');
      expect(doneMsg).toBeDefined();
      expect(doneMsg.content).toMatch(/couldn't identify the two cases/i);
    });
  });

  describe('Real-Path Production Message Path Integration Test (Turn 1 -> Turn 2 -> Turn 3)', () => {
    function createMockContext(): any {
      const state = new Map<string, unknown>();
      return {
        subscriptions: [],
        extensionUri: { fsPath: '/test' },
        workspaceState: {
          get: (k: string) => state.get(k),
          update: async (k: string, v: unknown) => { state.set(k, v); },
        },
        globalState: {
          get: (k: string) => state.get(k),
          update: async (k: string, v: unknown) => { state.set(k, v); },
        },
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
        extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
      };
    }

    it('exercises real message persistence and handoff across Turn 1 (Baat Kar) -> Turn 2 (Baat Kar) -> Turn 3 (Auto)', async () => {
      interface MockMessage {
        id: string;
        conversationId: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        createdAt: string;
      }

      const messages: MockMessage[] = [];
      let workingState: ConversationWorkingStateRecord | null = null;
      const coreConvId = 'core_conv_production_1';
      const localConvId = 'conv_production_1';
      let nextMsgId = 1;
      let nextAttemptId = 1;

      let runtimeEventListener: ((event: any) => void) | undefined;
      let runtimeTokenListener: ((token: any) => void) | undefined;

      const mockClient = {
        messages,
        get workingState() { return workingState; },
        async createConversation(params: any) {
          return {
            id: coreConvId,
            title: params.title ?? 'Real Path Conversation',
            mode: params.mode ?? 'baat_kar',
          };
        },
        async bindWorkspaceConversation(params: any) {
          return {
            schemaVersion: 1,
            workspaceIdentity: params.workspaceIdentity,
            currentConversationId: params.localConversationId,
            currentCoreConversationId: coreConvId,
            conversations: [{
              workspaceIdentity: params.workspaceIdentity,
              localConversationId: params.localConversationId,
              conversationId: coreConvId,
              title: params.title ?? 'Real Path Conversation',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              schemaVersion: 1,
              migrationMetadata: {},
            }],
            turns: [],
            migrationMetadata: {},
          };
        },
        async getWorkspaceConversationLedger(identity: string) {
          return {
            schemaVersion: 1,
            workspaceIdentity: identity,
            currentConversationId: localConvId,
            currentCoreConversationId: coreConvId,
            conversations: [{
              workspaceIdentity: identity,
              localConversationId: localConvId,
              conversationId: coreConvId,
              title: 'Real Path Conversation',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              schemaVersion: 1,
              migrationMetadata: {},
            }],
            turns: [],
            migrationMetadata: {},
          };
        },
        async submit(params: any) {
          const uMsg: MockMessage = {
            id: `msg_u_${nextMsgId++}`,
            conversationId: params.conversationId,
            role: 'user',
            content: params.currentMessage,
            createdAt: new Date().toISOString(),
          };
          messages.push(uMsg);
          const attemptId = `att_${nextAttemptId++}`;
          return {
            attempt: { id: attemptId },
          };
        },
        async executeAttempt(attemptId: string) {
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          let assistantContent = '';
          if (lastUser?.content.includes('Review the pricing implementation')) {
            assistantContent = `I have reviewed the pricing implementation. Here are the gaps identified:
1. Sub-cent rounding interaction when applying percent discounts.
2. Percentage bounds checking missing for pct > 100 or pct < 0.
3. Currency symbol formatting edge cases with negative values.`;
          } else if (lastUser?.content.includes('which two would you consider most likely')) {
            assistantContent = `## Top two by production risk

### 1. \`quantity\` arriving as a non-integer (gap #2)

### 2. A \`float\` sneaking into a price or rate (gap #3)`;
          } else {
            assistantContent = `Understood.`;
          }

          const aMsg: MockMessage = {
            id: `msg_a_${nextMsgId++}`,
            conversationId: coreConvId,
            role: 'assistant',
            content: assistantContent,
            createdAt: new Date().toISOString(),
          };
          messages.push(aMsg);

          if (runtimeEventListener) {
            runtimeEventListener({
              domain: 'attempt',
              entityId: attemptId,
              eventType: 'attempt_transitioned',
              metadata: { to: 'completed' },
            });
          }
        },
        async listMessages(convId: string) {
          return { messages: messages.filter(m => m.conversationId === convId) };
        },
        async listResponseAlternatives() {
          return { alternatives: [] };
        },
        async getAttachment() {
          return { kind: 'text' };
        },
        async saveConversationWorkingState(convId: string, input: any) {
          workingState = {
            schemaVersion: 1,
            conversationId: convId,
            workspaceIdentity: input.workspaceIdentity,
            currentObjective: input.currentObjective,
            objectiveFingerprint: input.currentObjective,
            relevantFiles: input.relevantFiles ?? [],
            relevantSymbols: input.relevantSymbols ?? [],
            latestExecutionPolicy: input.latestExecutionPolicy ?? 'READ_ONLY',
            latestFindingsSummary: input.latestFindingsSummary ?? null,
            userConstraints: input.userConstraints ?? [],
            activePlanAttemptId: null,
            activeMutationAttemptId: null,
            updatedAt: new Date().toISOString(),
          } as any;
          return workingState;
        },
        async getConversationWorkingState(convId: string, identity: string) {
          return workingState;
        },
        async getWorkspaceAttemptRehydration() {
          return { workspaceRoot: '', attempts: [] };
        },
        async listConversationMessageAttachments() {
          return { byMessage: {} };
        },
        async listConversationResearch() {
          return { research: [] };
        },
        async getConversationBranch() {
          return { branch: null };
        },
        async listCapabilityActions() {
          return { attemptId: null, actions: [] };
        },
        async listRecentWorkspaceCapabilityActions() {
          return { actions: [] };
        },
      };

      const mockCoreManager = {
        getClient: () => mockClient,
        onRuntimeEvent: (cb: (event: any) => void) => {
          runtimeEventListener = cb;
          return { dispose: () => { runtimeEventListener = undefined; } };
        },
        onRuntimeToken: (cb: (token: any) => void) => {
          runtimeTokenListener = cb;
          return { dispose: () => { runtimeTokenListener = undefined; } };
        },
        getStatus: () => ({ state: 'connected' }),
      };

      vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(mockCoreManager as any);

      const posted: any[] = [];
      const panel = new AgentPanel(createMockContext(), process.cwd());
      (panel as any).coreManager = mockCoreManager;

      (panel as any).view = {
        webview: {
          postMessage: async (msg: any) => { posted.push(msg); return true; },
        },
      };
      (panel as any).webviewReady = true;

      vi.spyOn(panel as any, 'selectModelForTask').mockResolvedValue({
        selectedModel: 'qwen3.8:27b',
        selectedProvider: 'ollama',
        suitabilitySummary: 'qwen3.8:27b selected',
      } as any);
      vi.spyOn(panel as any, 'buildSupplementalRepositoryContext').mockResolvedValue(null);
      vi.spyOn(panel as any, 'completeWorkspaceRestoration').mockResolvedValue(undefined);

      let submittedAutonomousGoal = '';
      vi.spyOn(panel as any, 'startAutonomousTask').mockImplementation(async (goal: string) => {
        submittedAutonomousGoal = goal;
      });

      // --- Turn 1: Submit through normal Baat Kar path ---
      const turn1Text = 'Review the pricing implementation and existing tests... Do not change any files yet.';
      await (panel as any).handleWebviewMessage({
        type: 'sendMessage',
        text: turn1Text,
        mode: 'chat',
        conversationId: localConvId,
      });

      // Assert Turn 1: User message and real assistant response persisted in Core message store
      expect(messages.some(m => m.role === 'user' && m.content === turn1Text)).toBe(true);
      const turn1Assistant = messages.find(m => m.role === 'assistant' && m.content.includes('Sub-cent rounding'));
      expect(turn1Assistant).toBeDefined();
      expect((panel as any).conversationId).toBe(localConvId);

      // --- Turn 2: Submit through normal Baat Kar path ---
      const turn2Text = 'Of those gaps, which two would you consider most likely to cause a real production pricing error?';
      await (panel as any).handleWebviewMessage({
        type: 'sendMessage',
        text: turn2Text,
        mode: 'chat',
        conversationId: localConvId,
      });

      // Assert Turn 2: Assistant selects two concrete cases and response is persisted in Core
      const turn2Assistant = messages.find(m => m.role === 'assistant' && m.content.includes('quantity\` arriving as a non-integer'));
      expect(turn2Assistant).toBeDefined();
      expect(turn2Assistant!.content).toContain('### 1. \`quantity\` arriving as a non-integer');
      expect(turn2Assistant!.content).toContain('### 2. A \`float\` sneaking into a price or rate');
      expect((panel as any).conversationId).toBe(localConvId);

      // Assert working state was recorded with the findings
      expect(workingState).toBeDefined();
      expect(workingState?.latestFindingsSummary).toContain('quantity\` arriving as a non-integer');
      expect(workingState?.latestFindingsSummary).toContain('float\` sneaking into a price or rate');

      // --- Turn 3: Submit through Auto (Karke Dikha) ---
      // Note: We do NOT inject turn2Assistant into compileAutonomousObjective!
      // prepareTurnContinuity must read the actual stored history via client.listMessages / workingState.
      const turn3Text =
        'Good. Add regression coverage for those two cases. If the tests expose a real implementation bug, fix it minimally. Otherwise don\'t touch production code. Run the focused pricing tests and the full pytest suite.';
      await (panel as any).handleWebviewMessage({
        type: 'startAutonomousTask',
        text: turn3Text,
        conversationId: localConvId,
      });

      // Assert Turn 3: startAutonomousTask was called with the compiled autonomous objective
      expect(submittedAutonomousGoal).toBeTruthy();

      // 1. Concrete cases from Turn 2 are present in the autonomous objective
      expect(submittedAutonomousGoal).toContain('quantity arriving as a non-integer (gap #2)');
      expect(submittedAutonomousGoal).toContain('A float sneaking into a price or rate (gap #3)');

      // 2. Unresolved deictic reference "those two cases" was compiled out
      expect(submittedAutonomousGoal).not.toMatch(/\bthose two cases\b/i);
      expect(hasUnresolvedDeicticReference(submittedAutonomousGoal)).toBe(false);

      // 3. Stale temporary constraint "Do not change any files yet" is superseded and removed
      expect(submittedAutonomousGoal).not.toContain('Do not change any files yet');

      // 4. Non-conflicting constraints survive
      expect(submittedAutonomousGoal).toContain('don\'t touch production code');

      // 5. Conversation ID remains identical across all three turns
      expect((panel as any).conversationId).toBe(localConvId);
      expect((panel as any).activeConversationId).toBe(localConvId);
    });

    it('succeeds even if webview posts startAutonomousTask without conversationId property (fallback to active conversation)', async () => {
      interface MockMessage {
        id: string;
        conversationId: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        createdAt: string;
      }

      const messages: MockMessage[] = [];
      let workingState: ConversationWorkingStateRecord | null = null;
      const coreConvId = 'core_conv_production_2';
      const localConvId = 'conv_production_2';
      let nextMsgId = 1;
      let nextAttemptId = 1;

      let runtimeEventListener: ((event: any) => void) | undefined;

      const mockClient = {
        messages,
        get workingState() { return workingState; },
        async createConversation(params: any) {
          return { id: coreConvId, title: params.title ?? 'Test', mode: 'baat_kar' };
        },
        async bindWorkspaceConversation(params: any) {
          return {
            schemaVersion: 1,
            workspaceIdentity: params.workspaceIdentity,
            currentConversationId: params.localConversationId,
            currentCoreConversationId: coreConvId,
            conversations: [{
              workspaceIdentity: params.workspaceIdentity,
              localConversationId: params.localConversationId,
              conversationId: coreConvId,
              title: 'Test',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              schemaVersion: 1,
              migrationMetadata: {},
            }],
            turns: [],
            migrationMetadata: {},
          };
        },
        async getWorkspaceConversationLedger(identity: string) {
          return {
            schemaVersion: 1,
            workspaceIdentity: identity,
            currentConversationId: localConvId,
            currentCoreConversationId: coreConvId,
            conversations: [{
              workspaceIdentity: identity,
              localConversationId: localConvId,
              conversationId: coreConvId,
              title: 'Test',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              schemaVersion: 1,
              migrationMetadata: {},
            }],
            turns: [],
            migrationMetadata: {},
          };
        },
        async submit(params: any) {
          messages.push({
            id: `msg_u_${nextMsgId++}`,
            conversationId: params.conversationId,
            role: 'user',
            content: params.currentMessage,
            createdAt: new Date().toISOString(),
          });
          return { attempt: { id: `att_${nextAttemptId++}` } };
        },
        async executeAttempt(attemptId: string) {
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          let assistantContent = '';
          if (lastUser?.content.includes('Review the pricing')) {
            assistantContent = `Gaps found:\n1. Rounding bug\n2. Range bug`;
          } else if (lastUser?.content.includes('which two')) {
            assistantContent = `The two cases I would prioritize are:\n1. sub-cent rounding interaction\n2. pct >100 / pct <0 guard`;
          }
          messages.push({
            id: `msg_a_${nextMsgId++}`,
            conversationId: coreConvId,
            role: 'assistant',
            content: assistantContent,
            createdAt: new Date().toISOString(),
          });
          if (runtimeEventListener) {
            runtimeEventListener({
              domain: 'attempt',
              entityId: attemptId,
              eventType: 'attempt_transitioned',
              metadata: { to: 'completed' },
            });
          }
        },
        async listMessages(convId: string) {
          return { messages: messages.filter(m => m.conversationId === convId) };
        },
        async listResponseAlternatives() { return { alternatives: [] }; },
        async getAttachment() { return { kind: 'text' }; },
        async saveConversationWorkingState(convId: string, input: any) {
          workingState = {
            schemaVersion: 1,
            conversationId: convId,
            workspaceIdentity: input.workspaceIdentity,
            currentObjective: input.currentObjective,
            objectiveFingerprint: input.currentObjective,
            relevantFiles: input.relevantFiles ?? [],
            relevantSymbols: input.relevantSymbols ?? [],
            latestExecutionPolicy: input.latestExecutionPolicy ?? 'READ_ONLY',
            latestFindingsSummary: input.latestFindingsSummary ?? null,
            userConstraints: input.userConstraints ?? [],
            activePlanAttemptId: null,
            activeMutationAttemptId: null,
            updatedAt: new Date().toISOString(),
          } as any;
          return workingState;
        },
        async getConversationWorkingState(convId: string, identity: string) {
          return workingState;
        },
        async getWorkspaceAttemptRehydration() { return { workspaceRoot: '', attempts: [] }; },
        async listConversationMessageAttachments() { return { byMessage: {} }; },
        async listConversationResearch() { return { research: [] }; },
        async getConversationBranch() { return { branch: null }; },
        async listCapabilityActions() { return { attemptId: null, actions: [] }; },
        async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
      };

      const mockCoreManager = {
        getClient: () => mockClient,
        onRuntimeEvent: (cb: (event: any) => void) => {
          runtimeEventListener = cb;
          return { dispose: () => { runtimeEventListener = undefined; } };
        },
        onRuntimeToken: () => ({ dispose: () => {} }),
        getStatus: () => ({ state: 'connected' }),
      };

      vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(mockCoreManager as any);

      const panel = new AgentPanel(createMockContext(), process.cwd());
      (panel as any).coreManager = mockCoreManager;
      (panel as any).view = { webview: { postMessage: async () => true } };
      (panel as any).webviewReady = true;

      vi.spyOn(panel as any, 'selectModelForTask').mockResolvedValue({
        selectedModel: 'qwen3.8:27b',
        selectedProvider: 'ollama',
        suitabilitySummary: 'qwen3.8:27b selected',
      } as any);
      vi.spyOn(panel as any, 'buildSupplementalRepositoryContext').mockResolvedValue(null);
      vi.spyOn(panel as any, 'completeWorkspaceRestoration').mockResolvedValue(undefined);

      let submittedAutonomousGoal = '';
      vi.spyOn(panel as any, 'startAutonomousTask').mockImplementation(async (goal: string) => {
        submittedAutonomousGoal = goal;
      });

      // Turn 1
      await (panel as any).handleWebviewMessage({
        type: 'sendMessage',
        text: 'Review the pricing implementation. Do not change any files yet.',
        mode: 'chat',
        conversationId: localConvId,
      });

      // Turn 2
      await (panel as any).handleWebviewMessage({
        type: 'sendMessage',
        text: 'which two would you consider most likely to cause a real production pricing error?',
        mode: 'chat',
        conversationId: localConvId,
      });

      // Turn 3: Omitting conversationId (simulates message without explicit conversationId payload)
      await (panel as any).handleWebviewMessage({
        type: 'startAutonomousTask',
        text: 'Good. Add regression coverage for those two cases.',
      });

      // Objective compiles successfully using active conversation context
      expect(submittedAutonomousGoal).toBeTruthy();
      expect(submittedAutonomousGoal).toContain('sub-cent rounding interaction');
      expect(submittedAutonomousGoal).toContain('pct >100 / pct <0 guard');
      expect(submittedAutonomousGoal).not.toMatch(/\bthose two cases\b/i);
    });
  });
});
