/**
 * Tasks-screen projection and the cancel outcome it must report honestly: a requested stop is "stopping"
 * until the worker has exited, a settled stop is "cancelled" (never failed/completed), and a stopped
 * attempt is never continued by Auto reroute.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { getAttempt, requestCancelAttempt, confirmAttemptCancelled, transitionAttempt, failAttempt } from '../domain/attempts';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { listTaskOverview } from '../domain/taskOverview';
import { maybeAutoReroute } from '../runtime/autoRerouteRuntime';
import { FailureCooldowns } from '../platform/autoReroute';

let dir: string;
let db: CoreDatabase;
let n = 0;

function submit(message: string, userOverrode = false) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  return submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId: conv.id,
    workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`,
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'zeta:1b', selectionReason: 'test', suitabilitySummary: 'test', userOverrode, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskov-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('task overview', () => {
  it('lists a running task with model, worker, activity and last event, and keeps it listed behind newer tasks', () => {
    const first = submit('Build the invoice page');
    transitionAttempt(db, first.attempt.id, { toStatus: 'running', actor: 'test' });
    recordRuntimeEvent(db, { domain: 'attempt', entityId: first.attempt.id, eventType: 'tool_call', actor: 'karkedikha:opencode', metadata: { toolName: 'write' } });
    for (let i = 0; i < 4; i++) submit(`later request ${i}`);

    const rows = listTaskOverview(db, 2);
    const row = rows.find((r) => r.attemptId === first.attempt.id)!;
    expect(row).toBeDefined();
    expect(row.status).toBe('running');
    expect(row.title).toBe('Build the invoice page');
    expect(row.model).toBe('zeta:1b');
    expect(row.worker).toBe('OpenCode coding worker');
    expect(row.activity).toBe('Running write');
    expect(row.lastEventType).toBe('Running write');
    expect(row.cancellable).toBe(true);
  });

  it('shows stopping until the stop is settled, then cancelled — and never reroutes it', async () => {
    const sub = submit('Refactor everything');
    const id = sub.attempt.id;
    transitionAttempt(db, id, { toStatus: 'running', actor: 'test' });

    requestCancelAttempt(db, id, { actor: 'test' });
    const stopping = listTaskOverview(db).find((r) => r.attemptId === id)!;
    expect(stopping.status).toBe('cancelling');
    expect(stopping.cancellable).toBe(false);
    expect(stopping.activity).toMatch(/Stop requested/);

    confirmAttemptCancelled(db, id, { actor: 'test' });
    const stopped = listTaskOverview(db).find((r) => r.attemptId === id)!;
    expect(stopped.status).toBe('cancelled');
    expect(stopped.activity).toBe('Stopped by you');
    expect(stopped.cancellable).toBe(false);

    // Even if an engine had recorded the stop as a failure, Auto must not continue the user's stopped work.
    const failedAfterStop = submit('Another');
    transitionAttempt(db, failedAfterStop.attempt.id, { toStatus: 'running', actor: 'test' });
    requestCancelAttempt(db, failedAfterStop.attempt.id, { actor: 'test' });
    db.run("UPDATE attempts SET status = 'failed', failureReason = 'Execution cancelled by user' WHERE id = ?", [failedAfterStop.attempt.id]);
    const successor = await maybeAutoReroute({
      db, actor: 'test', cooldowns: new FailureCooldowns(), isMutatingTool: () => true,
      environment: () => { throw new Error('must not even be consulted'); },
    }, failedAfterStop.attempt.id);
    expect(successor).toBeUndefined();
    expect(getAttempt(db, failedAfterStop.attempt.id).status).toBe('failed');
  });
});
