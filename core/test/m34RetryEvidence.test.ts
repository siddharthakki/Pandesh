import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { failAttempt, retryAttempt } from '../domain/attempts';
import { attemptRetryEligibility } from '../domain/retryPolicy';
import { getAttemptContext } from '../domain/attemptContext';
import { listExecutionQualityEvents, recordExecutionQuality } from '../domain/executionQuality';
import { listTaskHistory } from '../domain/history';
import { CoreError } from '../domain/errors';
import type { ModelSelectionEvidence } from '../shared/wireTypes';

let directory: string;
let db: CoreDatabase;

const selection: ModelSelectionEvidence = {
  requiredCapabilities: {
    readOnlyExplanation: false,
    repositoryExploration: true,
    toolCalling: true,
    fileModification: true,
    codingComplexity: 'medium',
    contextRequirement: 'medium',
    vision: false,
    validationAndRepair: true,
  },
  selectedProvider: 'ollama',
  selectedModel: 'coder:14b',
  selectionReason: 'Least costly configured capable coding model.',
  suitabilitySummary: 'Using a coding model suited to this task',
  userOverrode: false,
  candidates: [],
  escalationCandidates: [{ provider: 'ollama', model: 'coder:30b', reason: 'Higher reliability on the same provider.' }],
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm34-retry-'));
  db = openCoreDatabase(path.join(directory, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function submit() {
  return submitRequest(db, {
    clientId: 'test-client',
    currentMessage: 'Fix the parser and run its tests.',
    requestedMode: 'karke_dikha',
    workspaceRoot: directory,
    requestedProvider: 'ollama',
    requestedModel: 'coder:14b',
    selectedProvider: 'ollama',
    selectedModel: 'coder:14b',
    modelSelection: selection,
    toolPermissionPolicy: { profile: 'confirm-mutations' },
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: 'm34-retry-original',
  });
}

describe('M34 blocker retry and execution-quality authority', () => {
  it('creates one stronger linked successor while preserving request, goal, and prior evidence', () => {
    const original = submit();
    failAttempt(db, original.attempt.id, { failureReason: 'validation_or_quality_gate_failed', actor: 'test' });
    expect(attemptRetryEligibility(db, original.attempt.id)).toMatchObject({ eligible: true, strongerModelAvailable: true });

    const strongerSelection = { ...selection, selectedModel: 'coder:30b', selectionReason: 'Retrying with a stronger coding model.' };
    const first = retryAttempt(db, {
      predecessorAttemptId: original.attempt.id,
      strategy: 'stronger_model',
      selectedProvider: 'ollama',
      selectedModel: 'coder:30b',
      modelSelection: strongerSelection,
      actor: 'test',
    });
    const duplicate = retryAttempt(db, {
      predecessorAttemptId: original.attempt.id,
      strategy: 'stronger_model',
      selectedProvider: 'ollama',
      selectedModel: 'coder:30b',
      modelSelection: strongerSelection,
      actor: 'test',
    });

    expect(duplicate.id).toBe(first.id);
    expect(first.requestId).toBe(original.request.id);
    const originalContext = getAttemptContext(db, original.attempt.id);
    const successorContext = getAttemptContext(db, first.id);
    expect(successorContext.contextIdentity).toBe(originalContext.contextIdentity);
    expect(successorContext.taskInput).toBe(originalContext.taskInput);
    expect(successorContext.selectedModel).toBe('coder:30b');
    expect(listExecutionQualityEvents(db, first.id).map(event => event.eventType)).toEqual([
      'retry_created',
      'model_selection_decided',
    ]);
    const history = listTaskHistory(db);
    expect(history.find(item => item.attemptId === first.id)?.predecessorAttemptId).toBe(original.attempt.id);
    expect(history.find(item => item.attemptId === original.attempt.id)?.successorAttemptId).toBe(first.id);
  });

  it('disables retry after permission denial and enforces exactly two repair cycles', () => {
    const denied = submit();
    failAttempt(db, denied.attempt.id, { failureReason: 'permission denied for destructive action', actor: 'test' });
    expect(attemptRetryEligibility(db, denied.attempt.id)).toMatchObject({ eligible: false, prohibitedBySafety: true });
    expect(() => retryAttempt(db, { predecessorAttemptId: denied.attempt.id, actor: 'test' })).toThrow(CoreError);

    const repairable = submitRequest(db, {
      clientId: 'test-client',
      currentMessage: 'Repair another test.', requestedMode: 'karke_dikha', workspaceRoot: directory,
      requestedProvider: 'ollama', requestedModel: 'coder:14b', selectedProvider: 'ollama', selectedModel: 'coder:14b',
      modelSelection: selection, toolPermissionPolicy: { profile: 'confirm-mutations' },
      capability: { hasWorkspace: true, gitCapable: true }, correlationId: 'repairable',
    });
    for (const cycle of [1, 2]) {
      recordExecutionQuality(db, repairable.attempt.id, {
        eventType: 'validation_repair_started', metadata: { cycle, command: 'npm test' }, actor: 'test',
      });
    }
    expect(() => recordExecutionQuality(db, repairable.attempt.id, {
      eventType: 'validation_repair_started', metadata: { cycle: 3, command: 'npm test' }, actor: 'test',
    })).toThrow(CoreError);
  });
});
