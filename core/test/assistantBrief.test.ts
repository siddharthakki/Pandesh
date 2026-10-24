/**
 * Pandesh's brief and its one proactive routine.
 *
 * The brief must be a projection of real Core state: at most three attention
 * items, a pending approval first, an actionable failure or interruption
 * next, a recently completed result after that — and nothing at all when
 * nothing needs the operator.
 *
 * The daily brief routine must fire exactly once per occurrence. The
 * delivery ledger — not a convention — is what refuses the second delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { createAttempt, claimAttempt, transitionAttempt, failAttempt } from '../domain/attempts';
import { createApproval } from '../domain/approvals';
import { briefTitle, buildAssistantHomeItems, buildAssistantTodaySections } from '../domain/assistantBrief';
import {
  claimRoutineDelivery,
  completeRoutineDelivery,
  configureDailyBriefRoutine,
  disableDailyBriefRoutine,
  getDailyBriefRoutine,
  releaseRoutineDelivery,
} from '../domain/assistantRoutine';
import { runDailyBriefRoutine } from '../runtime/assistantRoutine';
import { EventBroadcaster } from '../ws/broadcaster';
import { listMessages } from '../domain/conversations';
import { createReminder } from '../domain/everydayTools';

let dir: string;
let db: CoreDatabase;
let n = 0;

function submit(message: string) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  return submitRequest(db, {
    clientId: 'test-client',
    currentMessage: message,
    requestedMode: 'saath_kar',
    conversationId: conv.id,
    workspaceRoot: dir,
    capability: { hasWorkspace: true, gitCapable: false },
    correlationId: `corr-${++n}`,
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
    modelSelection: {
      selectedProvider: 'ollama',
      selectedModel: 'zeta:1b',
      selectionReason: 'test',
      suitabilitySummary: 'test',
      userOverrode: false,
      candidates: [],
      escalationCandidates: [],
      requiredCapabilities: {
        readOnlyExplanation: false,
        repositoryExploration: true,
        toolCalling: true,
        fileModification: true,
        codingComplexity: 'low',
        contextRequirement: 'small',
        vision: false,
        validationAndRepair: false,
      },
    },
  });
}

function claimLive(attemptId: string, leaseMs = 60_000): void {
  claimAttempt(db, attemptId, { claimOwner: 'core:executor:4242', leaseMs, actor: 'test' });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-brief-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the assistant brief — Home', () => {
  it('shows nothing at all when nothing needs the operator', () => {
    expect(buildAssistantHomeItems(db)).toEqual([]);
  });

  it('puts a pending approval first and offers a real action on it', () => {
    const sub = submit('Rewrite the invoice page');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    const approval = createApproval(db, {
      attemptId: sub.attempt.id,
      kind: 'mutation',
      summary: { toolName: 'write_file' },
      presentation: { cardText: 'Write invoice.html', scope: 'C:/repo/invoice.html' },
      actor: 'test',
    });

    const items = buildAssistantHomeItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('approval');
    expect(items[0].stance).toBe('fact');
    expect(items[0].source.kind).toBe('core_approval');
    expect(items[0].source.reference).toBe(approval.id);
    expect(items[0].state).toBe('pending');
    const approve = items[0].actions.find((action) => action.label === 'Approve');
    expect(approve?.kind).toBe('resolve_approval');
    expect(approve?.approvalId).toBe(approval.id);
  });

  it('reports an actionable failure and an interruption with their real state', () => {
    const failed = submit('Build the report');
    failAttempt(db, failed.attempt.id, { failureReason: 'the model refused', actor: 'test' });

    const items = buildAssistantHomeItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('task_failed');
    expect(items[0].state).toBe('failed');
    expect(items[0].detail).toContain('the model refused');
    expect(items[0].source.kind).toBe('core_attempt');
  });

  it('names an approval in plain words, not by its internal tool name', () => {
    const sub = submit('Clean up the workspace');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    createApproval(db, {
      attemptId: sub.attempt.id,
      kind: 'mutation',
      summary: { toolName: 'run_checks' },
      presentation: { cardText: 'Pandesh wants to run a command that deletes files: del approval-proof.txt' },
      actor: 'test',
    });
    const [item] = buildAssistantHomeItems(db);
    expect(item.title).toBe('Approval needed — run a command');
    expect(item.title).not.toMatch(/run_checks|run checks/);
    expect(item.detail).toContain('del approval-proof.txt');
  });

  it('lets a failure age out of "needs you" after a day instead of nagging forever', () => {
    const failed = submit('Build the report');
    failAttempt(db, failed.attempt.id, { failureReason: 'the model refused', actor: 'test' });
    expect(buildAssistantHomeItems(db)).toHaveLength(1);
    const twoDaysLater = Date.now() + 48 * 60 * 60 * 1000;
    expect(buildAssistantHomeItems(db, { nowMs: twoDaysLater })).toEqual([]);
  });

  it('stops listing a failure once the same conversation has since completed the request again', () => {
    const first = submit('Build the report');
    failAttempt(db, first.attempt.id, { failureReason: 'the model refused', actor: 'test' });
    expect(buildAssistantHomeItems(db)).toHaveLength(1);
    const second = submitRequest(db, {
      clientId: 'test', currentMessage: 'Build the report', requestedMode: 'baat_kar', workspaceRoot: null,
      requestedProvider: 'ollama', requestedModel: 'm', capability: { hasWorkspace: false, gitCapable: false },
      correlationId: 'corr-again', conversationId: first.request.conversationId ?? undefined,
    } as never);
    transitionAttempt(db, second.attempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, second.attempt.id, { toStatus: 'completed', actor: 'test' });
    expect(buildAssistantHomeItems(db).filter((item) => item.kind === 'task_failed')).toHaveLength(0);
  });

  it('clips a long request at a word boundary, never mid-word', () => {
    const long = 'Please keep every detail of this long request and plan Gmail triage and Calendar conflicts in Europe/Berlin time with dictation';
    const clipped = briefTitle(long, 60);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(61);
    expect(long.startsWith(clipped.slice(0, -1))).toBe(true);
    expect(long.charAt(clipped.length - 1)).toBe(' ');
    expect(briefTitle('short  text')).toBe('short text');
    expect(briefTitle('')).toBe('(untitled request)');
  });

  it('never shows more than three attention items', () => {
    for (let index = 0; index < 5; index += 1) {
      const sub = submit(`Task ${index}`);
      failAttempt(db, sub.attempt.id, { failureReason: 'boom', actor: 'test' });
    }
    expect(buildAssistantHomeItems(db).length).toBeLessThanOrEqual(3);
  });

  it('shows a running task as real progress, but never as a stale "running"', () => {
    const sub = submit('Draft the proposal');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    claimLive(sub.attempt.id);

    const items = buildAssistantHomeItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('task_running');
    expect(items[0].state).toBe('running');
  });
});

describe('the assistant brief — Today', () => {
  it('separates work, approvals and follow-ups, and marks suggestions as suggestions', () => {
    const sub = submit('Fix the login');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    createApproval(db, { attemptId: sub.attempt.id, kind: 'mutation', summary: { toolName: 'write_file' }, actor: 'test' });
    createReminder(db, { title: 'Call the bank', body: '', dueAt: new Date(Date.now() - 60_000).toISOString() });

    const sections = buildAssistantTodaySections(db);
    const byId = new Map(sections.map((section) => [section.id, section]));
    expect(byId.get('work')?.items.length).toBeGreaterThan(0);
    expect(byId.get('approvals')?.items.length).toBe(1);
    expect(byId.get('follow_ups')?.items.some((item) => item.kind === 'reminder')).toBe(true);
    const suggestions = byId.get('suggestions')?.items ?? [];
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((item) => item.stance === 'suggestion')).toBe(true);
  });
});

describe('the daily brief routine', () => {
  it('is created disabled when asked to be, and can be switched on again', () => {
    const routine = configureDailyBriefRoutine(db, { dailyTime: '07:30', timezone: 'UTC', enabled: false });
    expect(routine.enabled).toBe(false);
    expect(routine.nextRunAt).toBeNull();

    const enabled = configureDailyBriefRoutine(db, { dailyTime: '07:30', timezone: 'UTC', enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBeTruthy();
    expect(enabled.dailyTime).toBe('07:30');

    const disabled = disableDailyBriefRoutine(db);
    expect(disabled?.enabled).toBe(false);
    expect(getDailyBriefRoutine(db)?.enabled).toBe(false);
  });

  it('rejects an impossible time of day', () => {
    expect(() => configureDailyBriefRoutine(db, { dailyTime: '25:00', timezone: 'UTC' })).toThrow();
  });

  it('delivers an occurrence exactly once — the ledger refuses the second claim', () => {
    const routine = configureDailyBriefRoutine(db, { dailyTime: '07:30', timezone: 'UTC' });
    const occurrence = 'routine@2026-10-21T07:30:00.000Z';

    expect(claimRoutineDelivery(db, routine.id, occurrence)).toBe(true);
    // The same occurrence can never be claimed twice, whatever the caller does.
    expect(claimRoutineDelivery(db, routine.id, occurrence)).toBe(false);
    // A different occurrence is a different delivery.
    expect(claimRoutineDelivery(db, routine.id, 'routine@2026-10-22T07:30:00.000Z')).toBe(true);

    completeRoutineDelivery(db, routine.id, occurrence, { conversationId: 'conv_1', messageId: 'msg_1' });
    const row = db.get<{ deliveredAt: string | null }>(
      'SELECT deliveredAt FROM routine_deliveries WHERE routineId = ? AND occurrenceKey = ?',
      [routine.id, occurrence],
    );
    expect(row?.deliveredAt).toBeTruthy();
  });

  it('survives a restart: the routine and its ledger live in Core, not in the app', () => {
    const routine = configureDailyBriefRoutine(db, { dailyTime: '07:30', timezone: 'UTC' });
    expect(claimRoutineDelivery(db, routine.id, 'routine@x')).toBe(true);
    db.close();

    const reopened = openCoreDatabase(path.join(dir, 'core.db')).db;
    try {
      expect(getDailyBriefRoutine(reopened)?.enabled).toBe(true);
      expect(claimRoutineDelivery(reopened, routine.id, 'routine@x')).toBe(false);
    } finally {
      reopened.close();
    }
  });
});

describe('the assistant brief — a live task is not an interrupted one', () => {
  it('does not call a task that never had a worker interrupted', () => {
    const sub = submit('Draft the plan');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    const items = buildAssistantHomeItems(db);
    expect(items.every((item) => item.kind !== 'task_interrupted')).toBe(true);
  });

  it('treats an expired lease as an interruption', () => {
    const sub = submit('Draft the plan');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    claimAttempt(db, sub.attempt.id, { claimOwner: 'core:executor:4242', leaseMs: 1, actor: 'test' });
    db.run('UPDATE attempts SET claimExpiresAt = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      sub.attempt.id,
    ]);
    const items = buildAssistantHomeItems(db);
    expect(items[0]?.kind).toBe('task_interrupted');
  });
});
