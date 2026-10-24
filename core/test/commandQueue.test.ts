import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import * as queue from '../domain/commandQueue';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdq-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('command queue', () => {
  it('queues three commands, runs first, edits second, skips third; silence does not execute', () => {
    const a = queue.enqueueCommand(db, { instruction: 'Remember that my printer uses A4' });
    const b = queue.enqueueCommand(db, { instruction: 'Remind me in two minutes to check the oven' });
    const c = queue.enqueueCommand(db, { instruction: 'Say hello' });

    const offer1 = queue.offerNextConfirmation(db);
    expect(offer1?.id).toBe(a.id);
    expect(offer1?.status).toBe('confirming');
    const active = queue.confirmRun(db, a.id, offer1!.confirmationToken!, offer1!.revision);
    expect(active.status).toBe('active');
    queue.completeCommand(db, a.id, { outcome: 'note saved' });

    const edited = queue.editCommand(db, b.id, { instruction: 'Remind me in three minutes to check the oven' });
    expect(edited.revision).toBe(2);

    const offer2 = queue.offerNextConfirmation(db);
    expect(offer2?.id).toBe(b.id);
    // Wrong revision must fail closed
    expect(() => queue.confirmRun(db, b.id, offer2!.confirmationToken!, 1)).toThrow(/changed since confirmation|revision/i);
    const run2 = queue.confirmRun(db, b.id, offer2!.confirmationToken!, offer2!.revision);
    expect(run2.status).toBe('active');
    queue.completeCommand(db, b.id);

    queue.skipCommand(db, c.id);
    const snap = queue.queueSnapshot(db);
    expect(snap.waiting).toHaveLength(0);
    expect(snap.active).toBeNull();
    expect(snap.recentTerminal.map((t) => t.status).sort()).toEqual(['completed', 'completed', 'skipped'].sort());
  });

  it('returns confirming commands to waiting when confirmation expires (silence)', () => {
    const item = queue.enqueueCommand(db, { instruction: 'Do a thing' });
    const offered = queue.offerNextConfirmation(db, Date.now(), 10);
    expect(offered?.status).toBe('confirming');
    const expired = queue.expireStaleConfirmations(db, new Date(Date.now() + 1_000).toISOString());
    expect(expired).toBe(1);
    expect(queue.getCommand(db, item.id).status).toBe('waiting');
  });

  it('honors KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS for offer window', () => {
    const prev = process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS;
    process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS = '1500';
    try {
      expect(queue.resolveConfirmationMs()).toBe(1500);
      queue.enqueueCommand(db, { instruction: 'Timed confirm' });
      const offered = queue.offerNextConfirmation(db);
      expect(offered?.confirmationExpiresAt).toBeTruthy();
      const expires = Date.parse(String(offered!.confirmationExpiresAt));
      expect(expires - Date.now()).toBeLessThanOrEqual(2_000);
      expect(offered?.status).toBe('confirming');
    } finally {
      if (prev === undefined) delete process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS;
      else process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS = prev;
    }
  });

  it('reconciles interrupted active without auto-replay', () => {
    const item = queue.enqueueCommand(db, { instruction: 'Remember that my printer uses A4' });
    const offered = queue.offerNextConfirmation(db)!;
    queue.confirmRun(db, item.id, offered.confirmationToken!, offered.revision);
    const reconciled = queue.reconcileInterruptedActive(db);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('waiting');
    expect(reconciled[0].lastError).toMatch(/not auto-replayed/);
  });

  it('blocks dependents when prerequisite failed', () => {
    const first = queue.enqueueCommand(db, { instruction: 'step one' });
    const second = queue.enqueueCommand(db, { instruction: 'step two', dependsOnId: first.id });
    const o1 = queue.offerNextConfirmation(db)!;
    queue.confirmRun(db, first.id, o1.confirmationToken!, o1.revision);
    queue.failCommand(db, first.id, 'boom');
    expect(queue.offerNextConfirmation(db)).toBeNull();
    expect(queue.getCommand(db, second.id).status).toBe('waiting');
  });
});
