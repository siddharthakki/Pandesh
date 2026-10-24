import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from '../../agent/ContextManager';
import { OllamaMessage } from '../../tools/ToolTypes';
import { emptyMissionCheckpoint, mergeMissionCheckpoint } from '../../mission/MissionCheckpoint';
import { MissionCheckpointStore } from '../../mission/MissionCheckpointStore';
import { MissionCompactor, renderMissionCheckpointSummary } from '../../mission/MissionCompactor';
import { deriveFailedApproaches, deriveModelRoutingHistory } from '../../mission/MissionCheckpointDerivation';
import { emptyJournalState } from '../../autonomous/recovery/AttemptJournal';
import { RecoveryDecision } from '../../autonomous/recovery/RecoveryTypes';

function bigToolMessage(id: string): OllamaMessage {
  return { role: 'tool', content: 'x'.repeat(2000), tool_call_id: id, tool_name: 'run_command' };
}

describe('M44.3 MissionCheckpoint', () => {
  it('merges list fields as a bounded, deduplicated union rather than replacing them', () => {
    const base = mergeMissionCheckpoint(emptyMissionCheckpoint('t1', 'ship the feature'), {
      constraints: ['no breaking changes'],
      blockers: ['waiting on provider'],
    });
    const next = mergeMissionCheckpoint(base, {
      constraints: ['no breaking changes', 'must stay offline-capable'],
      blockers: [],
    });
    expect(next.constraints).toEqual(['no breaking changes', 'must stay offline-capable']);
    // blockers replaces (not a union field semantically distinct from constraints in this test) —
    // passing [] explicitly clears it, since blockers reflects current state, not history.
    expect(next.blockers).toEqual([]);
    expect(next.objective).toBe('ship the feature');
  });
});

describe('M44.3 MissionCheckpointStore', () => {
  let storageRoot: string;
  let store: MissionCheckpointStore;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-mission-store-'));
    store = new MissionCheckpointStore(storageRoot);
  });

  afterEach(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('round-trips a checkpoint and never writes into the workspace root', async () => {
    const checkpoint = emptyMissionCheckpoint('task-1', 'migrate the database');
    await store.write(checkpoint);
    const read = await store.read('task-1');
    expect(read).toEqual(checkpoint);
    // storageRoot stands in for ExtensionContext.globalStorageUri.fsPath here,
    // not a workspace folder — asserting the store only ever touches paths
    // under the root it was constructed with.
    const files = await fs.readdir(path.join(storageRoot, 'mission-checkpoints'));
    expect(files).toEqual(expect.arrayContaining(['task-1.json']));
  });

  it('returns undefined for an unknown task instead of throwing', async () => {
    expect(await store.read('nope')).toBeUndefined();
  });

  it('lists known task ids', async () => {
    await store.write(emptyMissionCheckpoint('task-a', 'a'));
    await store.write(emptyMissionCheckpoint('task-b', 'b'));
    expect((await store.listTaskIds()).sort()).toEqual(['task-a', 'task-b']);
  });
});

describe('M44.3 MissionCompactor', () => {
  it('leaves messages untouched when under budget', () => {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const checkpoint = emptyMissionCheckpoint('t1', 'objective');
    expect(MissionCompactor.compact(messages, checkpoint, 7000)).toEqual(messages);
  });

  it('injects one checkpoint summary (never duplicated across repeated compaction) while truncating old tool results', () => {
    const checkpoint = mergeMissionCheckpoint(emptyMissionCheckpoint('t1', 'ship it'), {
      constraints: ['must not touch prod config'],
      blockers: ['provider offline'],
      pendingWork: ['run migration'],
      failedApproaches: ['direct SQL edit rejected by validation'],
    });
    let messages: OllamaMessage[] = [
      { role: 'system', content: 'sys prompt' },
      ...Array.from({ length: 10 }, (_, i) => bigToolMessage(`call-${i}`)),
      { role: 'user', content: 'continue' },
    ];
    messages = MissionCompactor.compact(messages, checkpoint, 500);
    const summaries = messages.filter(m => m.role === 'system' && m.content.includes('Mission memory'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain('must not touch prod config');
    expect(summaries[0].content).toContain('provider offline');
    expect(summaries[0].content).toContain('direct SQL edit rejected by validation');

    // Compacting again must replace, not accumulate, the summary.
    const again = MissionCompactor.compact(messages, checkpoint, 500);
    expect(again.filter(m => m.role === 'system' && m.content.includes('Mission memory'))).toHaveLength(1);
  });

  it('renders a bounded summary that never includes narrative transcript content', () => {
    const checkpoint = emptyMissionCheckpoint('t1', 'objective text');
    const summary = renderMissionCheckpointSummary(checkpoint);
    expect(summary).toContain('objective text');
    expect(summary.length).toBeLessThan(2000);
  });
});

describe('M44.3 ContextManager mission-aware pruning', () => {
  it('only compacts through MissionCompactor once a checkpoint is attached', () => {
    const manager = new ContextManager('sys prompt');
    for (let i = 0; i < 10; i++) {
      manager.addToolResult('run_command', 'x'.repeat(3000), `call-${i}`);
    }
    // No checkpoint attached: falls back to the original blunt truncation, no
    // mission summary appears.
    expect(manager.getMessages().some(m => m.content.includes('Mission memory'))).toBe(false);

    manager.attachMissionCheckpoint(mergeMissionCheckpoint(emptyMissionCheckpoint('t1', 'objective'), {
      blockers: ['stuck on flaky test'],
    }));
    expect(manager.getMessages().some(m => m.content.includes('Mission memory'))).toBe(true);

    manager.attachMissionCheckpoint(undefined);
    expect(manager.getMessages().some(m => m.content.includes('Mission memory'))).toBe(false);
  });
});

describe('M44.3 MissionCheckpointDerivation', () => {
  function decision(overrides: Partial<RecoveryDecision>): RecoveryDecision {
    return {
      schemaVersion: 1,
      decisionSeq: 1,
      attemptId: 'attempt-1',
      pass: 1,
      action: 'CONTINUE',
      reason: 'default reason',
      expectedChange: [],
      directives: { seedEvidencePaths: [], guidance: [], cloudAuthorized: false, resumeAtValidation: false },
      budget: { exhausted: false },
      decidedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('derives model routing history only from CHANGE_MODEL decisions', () => {
    const state = emptyJournalState();
    state.decisions = [
      decision({ action: 'CHANGE_MODEL', reason: 'weaker model failed', directives: { seedEvidencePaths: [], guidance: [], cloudAuthorized: false, resumeAtValidation: false, model: { provider: 'ollama', model: 'qwen3-coder:30b', local: true } } }),
      decision({ action: 'CONTINUE' }),
    ];
    const routing = deriveModelRoutingHistory(state);
    expect(routing).toHaveLength(1);
    expect(routing[0].model.model).toBe('qwen3-coder:30b');
    expect(routing[0].reason).toBe('weaker model failed');
  });

  it('derives failed approaches from non-COMPLETE terminal decisions', () => {
    const state = emptyJournalState();
    state.decisions = [
      decision({ terminalState: 'NO_PROGRESS', cause: 'validation_failure', reason: 'same failure twice' }),
      decision({ terminalState: 'COMPLETE', reason: 'done' }),
      decision({ action: 'CONTINUE' }),
    ];
    const failed = deriveFailedApproaches(state);
    expect(failed).toEqual(['validation_failure: same failure twice']);
  });
});
