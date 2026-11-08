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
