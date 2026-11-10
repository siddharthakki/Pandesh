/**
 * Reliability remediation: D6 (idle conversation capability anchors left
 * `running` forever), D9 (Auto selected uninstalled / unreachable models) and
 * D13 (stray "Correction:" boilerplate on benign wording).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { getAttempt } from '../domain/attempts';
import { ensureCapabilityAttempt } from '../domain/capabilityDispatch';
import { settleIdleCapabilityAnchorsOnBoot } from '../domain/bootReconciliation';
import { routeModel, AUTO_CHAT_MODEL } from '../domain/modelRouting';
import { auditPromises } from '../runtime/assistantStatus';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-remediation-d6-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('D6: idle conversation capability anchors', () => {
  it('are settled at Core start, and the conversation gets a fresh anchor on its next call', () => {
    const first = ensureCapabilityAttempt(db, { correlationId: 'conv_a', actor: 'core', clientId: 'desktop' });
    expect(getAttempt(db, first).status).toBe('running');

    expect(settleIdleCapabilityAnchorsOnBoot(db)).toEqual([first]);
    expect(getAttempt(db, first).status).toBe('completed');

    const second = ensureCapabilityAttempt(db, { correlationId: 'conv_a', actor: 'core', clientId: 'desktop' });
    expect(second).not.toBe(first);
    expect(getAttempt(db, second).status).toBe('running');
    // Idempotent within the new generation.
    expect(ensureCapabilityAttempt(db, { correlationId: 'conv_a', actor: 'core', clientId: 'desktop' })).toBe(second);
  });

  // Build 161 audit: production held anchors parked in waiting_for_approval whose approvals had all expired.
  it('also settles an anchor left waiting after every approval on it was answered or expired, but never one still pending', () => {
    const stuck = ensureCapabilityAttempt(db, { correlationId: 'conv_stuck', actor: 'core', clientId: 'desktop' });
    const live = ensureCapabilityAttempt(db, { correlationId: 'conv_live', actor: 'core', clientId: 'desktop' });
    const now = new Date().toISOString();
    for (const [anchor, status] of [[stuck, 'expired'], [live, 'pending']] as const) {
      db.run("UPDATE attempts SET status = 'waiting_for_approval' WHERE id = ?", [anchor]);
      db.run(`INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, summary, revision) VALUES (?, ?, 'mutation', ?, ?, ?, '{}', 1)`,
        [`appr_${anchor}`, anchor, status, now, status === 'pending' ? null : now]);
    }
    expect(settleIdleCapabilityAnchorsOnBoot(db)).toEqual([stuck]);
    expect(getAttempt(db, stuck).status).toBe('completed');
    expect(getAttempt(db, live).status).toBe('waiting_for_approval');
  });
});

describe('D9: Auto routing only selects what is installed', () => {
  it('never selects a model while the catalog is unreachable', () => {
    expect(() => routeModel('saath_kar', undefined, { reachable: false, models: [] } as any)).toThrow(/not reachable/);
  });

  it('serves a question with an installed model when no chain tag is installed', () => {
    const evidence = routeModel('saath_kar', undefined, { reachable: true, models: ['nomic-embed-text:latest', 'gemma3:4b'] } as any);
    expect(evidence.selectedModel).toBe('gemma3:4b');
  });

  it('uses the installed chat model for a question before falling back', () => {
    const evidence = routeModel('saath_kar', undefined, { reachable: true, models: [AUTO_CHAT_MODEL] } as any);
    expect(evidence.selectedModel).toBe(AUTO_CHAT_MODEL);
  });
});

describe('D13: notification correction only for a real promise', () => {
  const facts = { activeWorker: false, canNotify: true, notifyStatement: '' };
  it('ignores wording that is not a promise', () => {
    expect(auditPromises('This list lets you know which supplier is cheapest.', facts)).toBeNull();
    expect(auditPromises('Would you like me to let you know about other options?', facts)).toBeNull();
  });
  it('still corrects a first-person promise', () => {
    expect(auditPromises("I'll let you know when it's done.", facts)).toMatch(/^Correction:/);
  });
});
