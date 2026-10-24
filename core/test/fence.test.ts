import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createRequest } from '../domain/requests';
import { createAttempt, transitionAttempt, failAttempt, confirmAttemptCancelled, requestCancelAttempt, getAttempt } from '../domain/attempts';
import { acquireFence, assertFence } from '../domain/fence';
import { CoreError } from '../domain/errors';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-fence-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function newAttempt() {
  const req = createRequest(db, {
    clientId: 'client-1',
    currentMessage: 'hello there',
    requestedMode: 'baat_kar',
    resolvedMode: 'baat_kar',
    routeReason: 'ordinary question routed to Baat Kar',
    contextPolicy: {
      includeConversationHistory: false,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
    correlationId: 'corr-1',
  });
  return createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client-1' });
}

describe('fence: executor lease and mutation guard (audit F1/F3/F4)', () => {
  it('an unfenced attempt has no fence token and accepts mutations without one', () => {
    const attempt = newAttempt();
    expect(attempt.fenceToken).toBeNull();
    expect(attempt.fenceGeneration).toBe(0);
    expect(() => assertFence(db, attempt.id, null)).not.toThrow();
    expect(() => assertFence(db, attempt.id, undefined)).not.toThrow();
  });

  it('acquireFence issues a fresh token and bumps generation on every call', () => {
    const attempt = newAttempt();
    const first = acquireFence(db, attempt.id, { owner: 'core:111', actor: 'core' });
    expect(first.generation).toBe(1);
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);

    const second = acquireFence(db, attempt.id, { owner: 'core:222', actor: 'core' });
    expect(second.generation).toBe(2);
    expect(second.token).not.toBe(first.token);

    const persisted = getAttempt(db, attempt.id);
    expect(persisted.fenceToken).toBe(second.token);
    expect(persisted.fenceGeneration).toBe(2);
  });

  it('rejects a stale token once a newer fence has been acquired (superseded executor)', () => {
    const attempt = newAttempt();
    const stale = acquireFence(db, attempt.id, { owner: 'core:pid-1', actor: 'core' });
    acquireFence(db, attempt.id, { owner: 'core:pid-2', actor: 'core' }); // simulates a re-acquire after a perceived crash

    expect(() => assertFence(db, attempt.id, stale.token)).toThrow(CoreError);
    try {
      assertFence(db, attempt.id, stale.token);
      throw new Error('expected fence_stale');
    } catch (err) {
      expect(err).toBeInstanceOf(CoreError);
      expect((err as CoreError).code).toBe('fence_stale');
    }
  });

  it('rejects a null/missing token once the attempt is fenced', () => {
    const attempt = newAttempt();
    acquireFence(db, attempt.id, { owner: 'core:pid-1', actor: 'core' });
    expect(() => assertFence(db, attempt.id, null)).toThrow(CoreError);
    expect(() => assertFence(db, attempt.id, undefined)).toThrow(CoreError);
  });

  it('transitionAttempt, failAttempt and confirmAttemptCancelled all reject a stale fence token', () => {
    const a = newAttempt();
    const fenceA = acquireFence(db, a.id, { owner: 'core:pid-1', actor: 'core' });
    acquireFence(db, a.id, { owner: 'core:pid-2', actor: 'core' }); // steals ownership

    expect(() =>
      transitionAttempt(db, a.id, { toStatus: 'running', fenceToken: fenceA.token, actor: 'core' }),
    ).toThrow(CoreError);

    const b = newAttempt();
    const fenceB = acquireFence(db, b.id, { owner: 'core:pid-1', actor: 'core' });
    acquireFence(db, b.id, { owner: 'core:pid-2', actor: 'core' });
    expect(() => failAttempt(db, b.id, { failureReason: 'boom', fenceToken: fenceB.token, actor: 'core' })).toThrow(CoreError);

    const c = newAttempt();
    const fenceC = acquireFence(db, c.id, { owner: 'core:pid-1', actor: 'core' });
    acquireFence(db, c.id, { owner: 'core:pid-2', actor: 'core' });
    requestCancelAttempt(db, c.id, { actor: 'client-1' });
    expect(() => confirmAttemptCancelled(db, c.id, { actor: 'core', fenceToken: fenceC.token })).toThrow(CoreError);
  });

  it('the current fence owner can mutate freely — stale rejection only fires for superseded tokens', () => {
    const attempt = newAttempt();
    const fence = acquireFence(db, attempt.id, { owner: 'core:pid-1', actor: 'core' });
    const running = transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'core' });
    expect(running.status).toBe('running');
    const completed = transitionAttempt(db, attempt.id, { toStatus: 'completed', fenceToken: fence.token, actor: 'core' });
    expect(completed.status).toBe('completed');
  });

  it('a stale executor callback cannot resurrect a cancelled attempt as running (regression: late callback rejected)', () => {
    const attempt = newAttempt();
    const stale = acquireFence(db, attempt.id, { owner: 'core:crashed-executor', actor: 'core' });
    // A fresh executor takes over (e.g. after Core restart) and finishes the attempt.
    const fresh = acquireFence(db, attempt.id, { owner: 'core:new-executor', actor: 'core' });
    transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fresh.token, actor: 'core' });
    transitionAttempt(db, attempt.id, { toStatus: 'completed', fenceToken: fresh.token, actor: 'core' });

    // The crashed executor's delayed callback must not be able to touch the attempt at all.
    expect(() =>
      transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: stale.token, actor: 'core' }),
    ).toThrow(CoreError);
    expect(getAttempt(db, attempt.id).status).toBe('completed');
  });
});
