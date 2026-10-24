import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { submitRequest } from '../domain/submission';
import { getRequest } from '../domain/requests';
import { getAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import { createConversation, listMessages } from '../domain/conversations';
import { createPendingAttachment, finalizeAttachment } from '../domain/attachments';
import { CoreError } from '../domain/errors';
import type { ModelSelectionEvidence } from '../shared/wireTypes';
import { AUTO_MUTATION_MODEL, AUTO_QUESTION_MODEL } from '../domain/modelRouting';
import { LOCAL_CORE_QUESTION_PROFILE } from '../runtime/localCoreQuestion';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-submission-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('submitRequest: one atomic Core submission path (audit F1/F5)', () => {
  it('preserves explicit model evidence even when a catalog is supplied', () => {
    const explicit: ModelSelectionEvidence = {
      requiredCapabilities: {
        readOnlyExplanation: true, repositoryExploration: true, toolCalling: true,
        fileModification: false, codingComplexity: 'low', contextRequirement: 'medium',
        vision: false, validationAndRepair: false,
      },
      selectedProvider: 'ollama', selectedModel: 'operator:model', selectionReason: 'operator',
      suitabilitySummary: 'explicit', userOverrode: true, candidates: [], escalationCandidates: [],
    };
    const result = submitRequest(db, {
      clientId: 'client-explicit', currentMessage: 'Inspect this repository', requestedMode: 'saath_kar',
      selectedProvider: 'ollama', selectedModel: 'operator:model', modelSelection: explicit,
      installedModelsCatalog: { reachable: true, models: [AUTO_QUESTION_MODEL] },
      correlationId: 'explicit-model',
    });
    expect(getAttemptContext(db, result.attempt.id).modelSelection).toEqual(explicit);
  });

  it('routes an auto Local Core question to the measured question model', () => {
    const result = submitRequest(db, {
      clientId: 'client-auto', currentMessage: 'Explain the delivery manifest', requestedMode: 'saath_kar',
      toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
      installedModelsCatalog: { reachable: true, models: [AUTO_QUESTION_MODEL, AUTO_MUTATION_MODEL] },
      correlationId: 'auto-question',
    });
    expect(getAttemptContext(db, result.attempt.id).selectedModel).toBe(AUTO_QUESTION_MODEL);
  });

  it('falls through to the next installed question model with honest candidate evidence', () => {
    const result = submitRequest(db, {
      clientId: 'client-auto-fallback', currentMessage: 'Explain the delivery manifest', requestedMode: 'saath_kar',
      toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
      installedModelsCatalog: { reachable: true, models: [AUTO_MUTATION_MODEL] },
      correlationId: 'auto-question-fallback',
    });
    const selection = getAttemptContext(db, result.attempt.id).modelSelection!;
    expect(selection.selectedModel).toBe(AUTO_MUTATION_MODEL);
    expect(selection.candidates.find((candidate) => candidate.model === AUTO_QUESTION_MODEL)).toMatchObject({ available: false });
  });

  it('freezes bounded Baat repository context while preserving the exact durable user message', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const original = 'What does this repository contain?';
    const result = submitRequest(db, {
      clientId: 'client-1', currentMessage: original, requestedMode: 'baat_kar', conversationId: conversation.id,
      workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true }, correlationId: 'repo-context',
      repositoryContext: {
        prompt: '## Automatically selected repository context\n### README.md\nKarkeDikha',
        selectedFiles: [{ path: 'README.md', estimatedTokens: 12 }],
        estimatedTokens: 20,
      },
    });

    expect(result.request.currentMessage).toBe(original);
    expect(listMessages(db, conversation.id).at(-1)?.content).toBe(original);
    const context = getAttemptContext(db, result.attempt.id);
    expect(context.taskInput).toBe(original);
    expect(context.repositoryContext?.prompt).toContain('README.md');
    expect(context.permittedCapabilities.allowedTools).toEqual([]);
    expect(context.permittedCapabilities.contextPolicy.includeRepositoryContext).toBe(true);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
  });

  it('auto mode is classified server-side and the classification is what gets persisted', () => {
    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'What is the capital of France?',
      requestedMode: 'auto',
      correlationId: 'corr-1',
      idempotencyKey: 'idemp-1',
    });
    expect(result.request.requestedMode).toBe('auto');
    expect(result.request.resolvedMode).toBe('baat_kar');
    expect(result.attempt.kind).toBe('baat_kar');
    expect(result.attempt.status).toBe('created');
    expect(result.attempt.requestId).toBe(result.request.id);

    // Persisted, not just returned — a second read confirms the transaction committed both rows.
    expect(getRequest(db, result.request.id).resolvedMode).toBe('baat_kar');
    expect(getAttempt(db, result.attempt.id).kind).toBe('baat_kar');
  });

  it('an explicit non-auto mode is honored as the override mechanism, not overridden by the classifier', () => {
    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'What is the capital of France?', // would classify as baat_kar
      requestedMode: 'saath_kar', // explicit override
      correlationId: 'corr-2',
      idempotencyKey: 'idemp-2',
    });
    expect(result.request.requestedMode).toBe('saath_kar');
    expect(result.request.resolvedMode).toBe('saath_kar');
    expect(result.attempt.kind).toBe('saath_kar');
  });

  it('a broad mutating goal with no git-capable workspace is routed karke_dikha but marked planning-only', () => {
    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'Please implement and fix the authentication and add tests.',
      requestedMode: 'auto',
      capability: { hasWorkspace: true, gitCapable: false },
      correlationId: 'corr-3',
      idempotencyKey: 'idemp-3',
    });
    expect(result.request.resolvedMode).toBe('karke_dikha');
    expect(result.planningOnly).toBe(true);
  });

  it('rejects an unresolvable requestedMode without creating anything', () => {
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1',
        currentMessage: 'hi',
        requestedMode: 'not_a_real_mode' as never,
        correlationId: 'corr-4',
        idempotencyKey: 'idemp-4',
      }),
    ).toThrow(CoreError);
  });

  it('an invalid submission (empty message) creates neither a request nor an attempt (atomicity)', () => {
    const before = db.all('SELECT id FROM requests');
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1',
        currentMessage: '   ',
        requestedMode: 'auto',
        correlationId: 'corr-5',
        idempotencyKey: 'idemp-5',
      }),
    ).toThrow(CoreError);
    const after = db.all('SELECT id FROM requests');
    expect(after.length).toBe(before.length);
    const attemptsAfter = db.all('SELECT id FROM attempts');
    expect(attemptsAfter.length).toBe(0);
  });

  it('every submission produces exactly one request and exactly one attempt', () => {
    submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'What is the capital of France?',
      requestedMode: 'auto',
      correlationId: 'corr-6',
      idempotencyKey: 'idemp-6',
    });
    expect(db.all('SELECT id FROM requests').length).toBe(1);
    expect(db.all('SELECT id FROM attempts').length).toBe(1);
  });
});

describe('submitRequest: M36 attachment vertical slice', () => {
  function readyTextAttachment(conversationId: string, name = 'notes.txt') {
    const created = createPendingAttachment(db, {
      conversationId, originalName: name, declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    return finalizeAttachment(db, created.id, {
      detectedMimeType: 'text/plain', sha256: `sha-${created.id}`, byteSize: 4, storageRelativePath: `attachments/${conversationId}/${created.id}.bin`, actor: 'test',
    });
  }

  function readyImageAttachment(conversationId: string, name = 'photo.png') {
    const created = createPendingAttachment(db, {
      conversationId, originalName: name, declaredMimeType: 'image/png', kind: 'image', byteSize: 8, actor: 'test',
    });
    return finalizeAttachment(db, created.id, {
      detectedMimeType: 'image/png', sha256: `sha-${created.id}`, byteSize: 8, storageRelativePath: `attachments/${conversationId}/${created.id}.bin`, actor: 'test',
    });
  }

  function visionSelection(vision: boolean): ModelSelectionEvidence {
    return {
      requiredCapabilities: {
        readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
        codingComplexity: 'none', contextRequirement: 'small', vision, validationAndRepair: false,
      },
      selectedProvider: 'ollama',
      selectedModel: vision ? 'llava' : 'qwen2.5-coder:1.5b',
      selectionReason: 'test',
      suitabilitySummary: 'test',
      userOverrode: false,
      candidates: [],
      escalationCandidates: [],
    };
  }

  it('appends the user message, links attachments, and freezes them into the attempt context — all atomically', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const attachment = readyTextAttachment(conv.id);

    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'Summarize the attached file.',
      requestedMode: 'baat_kar',
      conversationId: conv.id,
      attachmentIds: [attachment.id],
      correlationId: 'corr-attach-1',
      idempotencyKey: 'idemp-attach-1',
    });

    expect(result.messageId).not.toBeNull();
    const messages = listMessages(db, conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(result.messageId);

    const context = getAttemptContext(db, result.attempt.id);
    expect(context.attachments).toEqual([
      { attachmentId: attachment.id, sha256: attachment.sha256, kind: 'text', detectedMimeType: 'text/plain', originalName: attachment.originalName, byteSize: 4 },
    ]);
  });

  it('rejects more than 5 attachments in one turn', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const ids = Array.from({ length: 6 }, (_, i) => readyTextAttachment(conv.id, `f${i}.txt`).id);
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1', currentMessage: 'hi', requestedMode: 'baat_kar', conversationId: conv.id,
        attachmentIds: ids, correlationId: 'corr-attach-2', idempotencyKey: 'idemp-attach-2',
      }),
    ).toThrow(CoreError);
    // Atomicity: no message should have been appended either.
    expect(listMessages(db, conv.id)).toHaveLength(0);
  });

  it('requires conversationId when attachmentIds are supplied', () => {
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1', currentMessage: 'hi', requestedMode: 'baat_kar',
        attachmentIds: ['whatever'], correlationId: 'corr-attach-3', idempotencyKey: 'idemp-attach-3',
      }),
    ).toThrow(CoreError);
  });

  it('rejects an attachment belonging to a different conversation, creating nothing', () => {
    const convA = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const convB = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const attachment = readyTextAttachment(convB.id);
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1', currentMessage: 'hi', requestedMode: 'baat_kar', conversationId: convA.id,
        attachmentIds: [attachment.id], correlationId: 'corr-attach-4', idempotencyKey: 'idemp-attach-4',
      }),
    ).toThrow(CoreError);
    expect(listMessages(db, convA.id)).toHaveLength(0);
  });

  it('an image attachment without a vision-capable model selection is an honest blocker, not a silent text-only fallback', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const image = readyImageAttachment(conv.id);
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1', currentMessage: 'What is in this image?', requestedMode: 'baat_kar', conversationId: conv.id,
        attachmentIds: [image.id], modelSelection: visionSelection(false),
        correlationId: 'corr-attach-5', idempotencyKey: 'idemp-attach-5',
      }),
    ).toThrow(CoreError);
    // Atomic: no message, no request, no attempt survives the rejected submission.
    expect(listMessages(db, conv.id)).toHaveLength(0);
  });

  it('an image attachment with a vision-capable model selection succeeds', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const image = readyImageAttachment(conv.id);
    const result = submitRequest(db, {
      clientId: 'client-1', currentMessage: 'What is in this image?', requestedMode: 'baat_kar', conversationId: conv.id,
      attachmentIds: [image.id], modelSelection: visionSelection(true),
      correlationId: 'corr-attach-6', idempotencyKey: 'idemp-attach-6',
    });
    expect(result.attempt.status).toBe('created');
    const context = getAttemptContext(db, result.attempt.id);
    expect(context.attachments?.[0].kind).toBe('image');
  });

  it('rejects an attachment that is not ready (still uploading)', () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const pending = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'f.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    expect(() =>
      submitRequest(db, {
        clientId: 'client-1', currentMessage: 'hi', requestedMode: 'baat_kar', conversationId: conv.id,
        attachmentIds: [pending.id], correlationId: 'corr-attach-7', idempotencyKey: 'idemp-attach-7',
      }),
    ).toThrow(CoreError);
  });
});

describe('CoreDatabase.transaction: reentrant (regression — composed domain functions)', () => {
  it('a transaction that calls another transaction-wrapped function commits exactly once', () => {
    const result = db.transaction(() => {
      return db.transaction(() => {
        db.run("INSERT INTO core_metadata (key, value, updatedAt) VALUES ('reentrant-test', 'ok', datetime('now'))");
        return 'inner-result';
      });
    });
    expect(result).toBe('inner-result');
    const row = db.get<{ value: string }>("SELECT value FROM core_metadata WHERE key = 'reentrant-test'");
    expect(row?.value).toBe('ok');
  });

  it('an inner failure rolls back the whole outer transaction, not just the inner part', () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO core_metadata (key, value, updatedAt) VALUES ('rollback-test', 'should-not-persist', datetime('now'))");
        db.transaction(() => {
          throw new Error('inner failure');
        });
      }),
    ).toThrow('inner failure');
    const row = db.get("SELECT value FROM core_metadata WHERE key = 'rollback-test'");
    expect(row).toBeUndefined();
  });
});
