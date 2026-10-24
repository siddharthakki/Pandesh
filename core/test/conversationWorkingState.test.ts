/**
 * Durable Conversational Continuity V1 — Core-side durability tests.
 *
 * These prove the properties the extension host is allowed to rely on:
 * the working state survives a Core restart, is scoped to one workspace, is
 * bounded, resets completely when a new objective starts, and reaches the
 * model as a clearly-framed remembered summary rather than as evidence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createConversation } from '../domain/conversations';
import {
  clearConversationWorkingState,
  formatContinuityBrief,
  getConversationWorkingState,
  readConversationWorkingState,
  saveConversationWorkingState,
} from '../domain/conversationWorkingState';
import { CoreError } from '../domain/errors';

const WORKSPACE_A = 'workspace-identity-aaaa';
const WORKSPACE_B = 'workspace-identity-bbbb';

let directory: string;
let databasePath: string;
let db: CoreDatabase;
let conversationId: string;

function reopen(): void {
  db.close();
  db = openCoreDatabase(databasePath).db;
}

function save(overrides: Record<string, unknown> = {}, identity = WORKSPACE_A) {
  return saveConversationWorkingState(db, conversationId, {
    workspaceIdentity: identity,
    currentObjective: 'Fix empty-username validation in registerUser',
    latestUserIntent: 'Why does registerUser accept an empty username?',
    latestExecutionPolicy: 'READ_ONLY',
    relevantFiles: [{ path: 'src/auth/registerUser.ts', contentHash: 'a'.repeat(64), observedAt: '2026-09-07T00:00:00.000Z' }],
    relevantSymbols: ['registerUser'],
    userConstraints: [{ id: 'cons_1', text: "don't change the tests", createdAt: '2026-09-07T00:00:00.000Z' }],
    actor: 'test:actor',
    ...overrides,
  } as never);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-conversation-working-state-'));
  databasePath = path.join(directory, 'core.db');
  db = openCoreDatabase(databasePath).db;
  conversationId = createConversation(db, { mode: 'saath_kar', actor: 'test:actor' }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('conversation working state durability', () => {
  it('survives a Core process restart with its objective, constraints and file references intact', () => {
    const saved = save();
    expect(saved.version).toBe(1);
    expect(saved.objectiveId).toMatch(/^obj_/);

    reopen();

    const restored = getConversationWorkingState(db, conversationId, WORKSPACE_A);
    expect(restored).not.toBeNull();
    expect(restored!.objectiveId).toBe(saved.objectiveId);
    expect(restored!.currentObjective).toBe('Fix empty-username validation in registerUser');
    expect(restored!.userConstraints.map(item => item.text)).toEqual(["don't change the tests"]);
    expect(restored!.relevantFiles).toEqual([
      { path: 'src/auth/registerUser.ts', contentHash: 'a'.repeat(64), observedAt: '2026-09-07T00:00:00.000Z' },
    ]);
    expect(restored!.relevantSymbols).toEqual(['registerUser']);
    expect(restored!.latestExecutionPolicy).toBe('READ_ONLY');
  });

  it('never returns one workspace\'s objective to another workspace', () => {
    save();
    expect(getConversationWorkingState(db, conversationId, WORKSPACE_B)).toBeNull();
    // …and a second workspace cannot overwrite or inherit it either.
    expect(() => save({}, WORKSPACE_B)).toThrow(CoreError);
  });

  it('keeps the same objective identity across updates and increments the version', () => {
    const first = save();
    const second = save({ latestExecutionPolicy: 'COLLABORATIVE_EDIT', latestUserIntent: 'Fix it.' });
    expect(second.objectiveId).toBe(first.objectiveId);
    expect(second.version).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('drops every objective-scoped field when a new objective starts', () => {
    const first = save({ latestFindingsSummary: 'registerUser has no emptiness check' });
    const second = saveConversationWorkingState(db, conversationId, {
      workspaceIdentity: WORKSPACE_A,
      startNewObjective: true,
      currentObjective: 'Inspect payment validation',
      latestUserIntent: 'Different issue: inspect payment validation.',
      latestExecutionPolicy: 'READ_ONLY',
      actor: 'test:actor',
    });
    expect(second.objectiveId).not.toBe(first.objectiveId);
    expect(second.userConstraints).toEqual([]);
    expect(second.relevantFiles).toEqual([]);
    expect(second.relevantSymbols).toEqual([]);
    expect(second.latestFindingsSummary).toBeNull();
    expect(second.pendingAction).toBeNull();
  });

  it('rejects unbounded, absolute, escaping or malformed input', () => {
    expect(() => save({ currentObjective: 'x'.repeat(401) })).toThrow(/currentObjective exceeds/);
    expect(() => save({ relevantFiles: [{ path: 'C:/outside/file.ts' }] })).toThrow(/repository-relative/);
    expect(() => save({ relevantFiles: [{ path: '../escape.ts' }] })).toThrow(/repository-relative/);
    expect(() => save({ relevantFiles: [{ path: 'a.ts', contentHash: 'not-a-hash' }] })).toThrow(/SHA-256/);
    expect(() => save({ userConstraints: Array.from({ length: 13 }, (_, i) => ({ text: `c${i}` })) }))
      .toThrow(/at most 12/);
    expect(() => save({ latestExecutionPolicy: 'FULL_TRUST' })).toThrow(/unknown execution policy/);
    expect(() => save({ pendingAction: { kind: 'take_over', description: 'x' } })).toThrow(/unknown pendingAction/);
  });

  it('de-duplicates constraints, files and symbols rather than accumulating them', () => {
    const saved = save({
      userConstraints: [
        { text: "don't change the tests" },
        { text: "Don't change the tests" },
      ],
      relevantFiles: [{ path: 'a.ts' }, { path: 'a.ts' }],
      relevantSymbols: ['registerUser', 'registerUser'],
    });
    expect(saved.userConstraints).toHaveLength(1);
    expect(saved.relevantFiles).toHaveLength(1);
    expect(saved.relevantSymbols).toEqual(['registerUser']);
  });

  it('is removed with its conversation and by an explicit workspace-scoped clear', () => {
    save();
    clearConversationWorkingState(db, conversationId, WORKSPACE_B);
    expect(getConversationWorkingState(db, conversationId, WORKSPACE_A)).not.toBeNull();
    clearConversationWorkingState(db, conversationId, WORKSPACE_A);
    expect(getConversationWorkingState(db, conversationId, WORKSPACE_A)).toBeNull();
  });
});

describe('continuity brief', () => {
  it('frames the remembered state as a summary, never as current repository truth', () => {
    save({ latestFindingsSummary: 'registerUser never checks for an empty username' });
    const brief = formatContinuityBrief(readConversationWorkingState(db, conversationId)!);
    expect(brief).toMatch(/remembered summary/i);
    expect(brief).toMatch(/not evidence about the current code/i);
    expect(brief).toMatch(/re-read any file/i);
    expect(brief).toContain('Objective: Fix empty-username validation in registerUser');
    expect(brief).toContain("Constraints the user set for this objective (still in force): don't change the tests");
    expect(brief).toContain('src/auth/registerUser.ts');
    expect(brief).toContain('registerUser never checks for an empty username');
  });

  it('omits sections that hold nothing, so a fresh objective stays terse', () => {
    saveConversationWorkingState(db, conversationId, {
      workspaceIdentity: WORKSPACE_A,
      currentObjective: 'Inspect payment validation',
      latestUserIntent: 'Inspect payment validation',
      actor: 'test:actor',
    });
    const brief = formatContinuityBrief(readConversationWorkingState(db, conversationId)!);
    expect(brief).not.toMatch(/Constraints the user set/);
    expect(brief).not.toMatch(/Files referred to/);
    expect(brief).not.toMatch(/What was previously found/);
  });
});
