import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { failAttempt, retryAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import type { ModelSelectionEvidence } from '../shared/wireTypes';
import type { RoutingDecisionEvidence } from '../domain/empiricalRouting';

/**
 * M50: the routing decision is frozen into the attempt context at submit. Restart and retry read it back;
 * nothing routes again, so a model installed (or ranked better) later cannot silently replace it.
 */

let directory: string;
let dbPath: string;
let db: CoreDatabase;

const routing: RoutingDecisionEvidence = {
  policyVersion: 'm50-v1',
  selectionMode: 'auto',
  classificationSource: 'structured',
  toolProtocol: 'prompted',
  why: ['Compatible with the current task', 'Tool use through the prompted protocol', 'Available locally'],
  compatibleCandidateCount: 2,
  empiricalEvidenceUsed: false,
  alternatives: [
    { provider: 'ollama', model: 'chosen:14b', rank: 1, behindBecauseOf: null, qualification: 'no benchmark evidence' },
    { provider: 'ollama', model: 'later-better:70b', rank: 2, behindBecauseOf: 'suitability', qualification: 'no benchmark evidence' },
  ],
};

const selection: ModelSelectionEvidence = {
  requiredCapabilities: {
    readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true,
    codingComplexity: 'medium', contextRequirement: 'medium', vision: false, validationAndRepair: true,
  },
  selectedProvider: 'ollama',
  selectedModel: 'chosen:14b',
  selectionReason: 'chosen:14b is the best technically viable model.',
  suitabilitySummary: 'Using a coding model suited to this task',
  userOverrode: false,
  candidates: [],
  escalationCandidates: [{ provider: 'ollama', model: 'later-better:70b', reason: 'Higher reliability on the same provider.' }],
  routing,
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm50-frozen-routing-'));
  dbPath = path.join(directory, 'core.db');
  db = openCoreDatabase(dbPath).db;
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
    requestedModel: 'chosen:14b',
    selectedProvider: 'ollama',
    selectedModel: 'chosen:14b',
    modelSelection: selection,
    toolPermissionPolicy: { profile: 'confirm-mutations' },
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: 'm50-frozen-routing',
  });
}

describe('M50 frozen routing decision', () => {
  it('is stored with the attempt context and returned verbatim', () => {
    const { attempt } = submit();
    expect(getAttemptContext(db, attempt.id).modelSelection?.routing).toEqual(routing);
  });

  it('survives a Core restart unchanged, with the same primary model', () => {
    const { attempt } = submit();
    const before = getAttemptContext(db, attempt.id);
    db.close();
    db = openCoreDatabase(dbPath).db;
    const after = getAttemptContext(db, attempt.id);
    expect(after.selectedModel).toBe('chosen:14b');
    expect(after.modelSelection?.routing).toEqual(routing);
    expect(after.contextHash).toBe(before.contextHash);
  });

  it('a same-model retry reuses the frozen decision; nothing routes again', () => {
    const { attempt } = submit();
    failAttempt(db, attempt.id, { failureReason: 'validation_or_quality_gate_failed', actor: 'test' });
    // A better-ranked model "appearing" is not an input to retry at all; the successor reads the predecessor.
    const successor = retryAttempt(db, { predecessorAttemptId: attempt.id, strategy: 'same_model', actor: 'test' });
    const context = getAttemptContext(db, successor.id);
    expect(context.selectedModel).toBe('chosen:14b');
    expect(context.modelSelection?.routing).toEqual(routing);
  });

  it('an explicit stronger-model retry does not carry a routing story that described a different model', () => {
    const { attempt } = submit();
    failAttempt(db, attempt.id, { failureReason: 'validation_or_quality_gate_failed', actor: 'test' });
    const successor = retryAttempt(db, {
      predecessorAttemptId: attempt.id,
      strategy: 'stronger_model',
      selectedProvider: 'ollama',
      selectedModel: 'later-better:70b',
      actor: 'test',
    });
    const context = getAttemptContext(db, successor.id);
    expect(context.selectedModel).toBe('later-better:70b');
    expect(context.modelSelection?.routing).toBeUndefined();
  });

  it('older frozen records without routing evidence still load', () => {
    const { routing: _omit, ...legacy } = selection;
    const result = submitRequest(db, {
      clientId: 'test-client', currentMessage: 'Fix the parser.', requestedMode: 'karke_dikha', workspaceRoot: directory,
      selectedProvider: 'ollama', selectedModel: 'chosen:14b', modelSelection: legacy,
      toolPermissionPolicy: { profile: 'confirm-mutations' }, capability: { hasWorkspace: true, gitCapable: true },
      correlationId: 'm50-legacy',
    });
    expect(getAttemptContext(db, result.attempt.id).modelSelection?.routing).toBeUndefined();
  });
});
