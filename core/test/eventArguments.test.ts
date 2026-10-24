import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { startToolInvocation, getToolInvocation } from '../domain/toolInvocations';
import { listRuntimeEventsAfter } from '../domain/runtimeEvents';
import { recordExecutionQuality } from '../domain/executionQuality';
import { projectEventArguments, EVENT_ARGUMENTS_MAX_BYTES } from '../domain/eventArguments';

const sha = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

describe('projectEventArguments', () => {
  it('leaves small arguments untouched', () => {
    const args = { path: 'a.txt', gates: ['npm test'] };
    expect(projectEventArguments(args)).toEqual(args);
  });

  it('projects a long string at any depth to size + hash', () => {
    const big = 'x'.repeat(20_000);
    const out = projectEventArguments({ path: 'a.txt', content: big, nested: { deep: [big] } });
    expect(out.path).toBe('a.txt');
    expect(out.content).toEqual({ $bytes: 20_000, $sha256: sha(big) });
    expect((out.nested as any).deep[0]).toEqual({ $bytes: 20_000, $sha256: sha(big) });
  });

  it('is idempotent and bounded even for many mid-sized fields', () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) args[`f${i}`] = 'y'.repeat(400);
    const once = projectEventArguments(args);
    expect(Buffer.byteLength(JSON.stringify(once), 'utf8')).toBeLessThanOrEqual(EVENT_ARGUMENTS_MAX_BYTES);
    expect(projectEventArguments(once)).toEqual(once);
  });
});

describe('events carrying raw arguments never exceed the event bound', () => {
  let dir: string;
  let db: CoreDatabase;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-args-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function attempt() {
    const req = createRequest(db, {
      clientId: 'c', currentMessage: 'x', requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 't',
      contextPolicy: { includeConversationHistory: false, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      correlationId: 'corr-1',
    });
    return createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'c' });
  }

  it('tool_invocation_started with a 50 KB argument records size+hash instead of throwing', () => {
    const a = attempt();
    const big = 'z'.repeat(50_000);
    const inv = startToolInvocation(db, { attemptId: a.id, toolName: 'propose_file_change', argsSummary: { path: 'a.txt', content: big }, actor: 'c' });
    const event = listRuntimeEventsAfter(db, 0, 500).find((e) => e.eventType === 'tool_invocation_started' && e.entityId === inv.id)!;
    expect((event.metadata.argsSummary as any).content).toEqual({ $bytes: 50_000, $sha256: sha(big) });
    // The durable record keeps the full arguments.
    expect((getToolInvocation(db, inv.id).argsSummary as any).content).toBe(big);
  });

  it('loop_detected metadata carries projected normalizedArguments', () => {
    const a = attempt();
    const big = 'q'.repeat(30_000);
    const event = recordExecutionQuality(db, a.id, {
      eventType: 'loop_detected',
      metadata: { operation: 'propose_file_change', normalizedArguments: projectEventArguments({ path: 'a', content: big }) },
      actor: 'c',
    });
    expect((event.metadata.normalizedArguments as any).content.$bytes).toBe(30_000);
  });
});
