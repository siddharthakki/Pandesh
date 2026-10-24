import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOCAL_CORE_QUESTION_PROFILE,
  LOCAL_CORE_TOOL_DEFINITIONS,
  decodeLocalCoreTurn,
  enforceReadOnlyTool,
  executeLocalCoreAction,
  isLocalCoreQuestion,
  recordSuccessfulRead,
  resolveWorkerProfile,
  answerAdmissible,
  checkAnswerReferences,
  localCoreBudget,
  localCoreBudgetAnchor,
  localCoreDeadlineMs,
  type LocalCoreRead,
} from '../runtime/localCoreQuestion';
import { MISSION_WALL_CLOCK_MS } from '../runtime/missionBudget';
import type { MissionEnvelope } from '../runtime/scopedCommand';

function git(cwd: string, ...argv: string[]) {
  return spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-local-core-'));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@karkedikha.local');
  git(dir, 'config', 'user.name', 'KarkeDikha Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const answer = 42;\nexport const other = 7;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n\nA fixture repository.\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'fixture baseline');
  return dir;
}

function envelopeFor(root: string): MissionEnvelope {
  return { workspaceRoot: root, pushAuthorized: false, networkAuthorized: false, installAuthorized: false };
}

describe('Local Core worker selection', () => {
  it('resolves Local Core to the read-only question profile', () => {
    const resolved = resolveWorkerProfile('local-core');
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.profile).toBe(LOCAL_CORE_QUESTION_PROFILE);
    expect(isLocalCoreQuestion(LOCAL_CORE_QUESTION_PROFILE)).toBe(true);
  });

  it('keeps the existing mission profile reachable', () => {
    const resolved = resolveWorkerProfile('autonomous-mission');
    expect(resolved.ok && resolved.profile).toBe('autonomous-mission');
    expect(isLocalCoreQuestion('autonomous-mission')).toBe(false);
  });

  it('refuses unimplemented external workers and unknown ids', () => {
    for (const gated of ['copilot-local', 'codex-cli', 'claude-code']) {
      const resolved = resolveWorkerProfile(gated);
      expect(resolved.ok).toBe(false);
      expect(resolved.ok === false && resolved.reason).toMatch(/not implemented/);
    }
    const unknown = resolveWorkerProfile('some-other-worker');
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.reason).toMatch(/unknown worker/);
  });
});

describe('read-only enforcement at dispatch', () => {
  it('offers only bounded read tools and an answer tool', () => {
    expect(LOCAL_CORE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(['search', 'read_file', 'answer']);
  });

  it('refuses mutation, delivery, and shell tools even when the model emits them', () => {
    for (const tool of ['propose_file_change', 'run_check', 'run_command', 'finish', 'authorize_mission']) {
      const gate = enforceReadOnlyTool(tool);
      expect(gate.allow).toBe(false);
      expect(gate.allow === false && gate.reason).toMatch(/read-only/);
      const decoded = decodeLocalCoreTurn([{ name: tool, arguments: { path: 'app.js', content: 'x', check: 'commit' } }]);
      expect(decoded.ok).toBe(false);
    }
  });

  it('accepts exactly one read-only action per turn', () => {
    const single = decodeLocalCoreTurn([{ name: 'read_file', arguments: { path: 'app.js', startLine: 1, endLine: 2 } }]);
    expect(single.ok).toBe(true);
    const many = decodeLocalCoreTurn([
      { name: 'read_file', arguments: { path: 'app.js' } },
      { name: 'search', arguments: { query: 'answer' } },
    ]);
    expect(many.ok).toBe(false);
    expect(many.extraRejected).toBe(1);
  });
});

describe('answers are bound to reads Core recorded', () => {
  it('rejects a reference that was never read successfully', () => {
    const reads: LocalCoreRead[] = [{ path: 'app.js', range: '1-2' }];
    const verdict = checkAnswerReferences([{ path: 'app.js' }, { path: 'secrets.env' }], reads);
    expect(verdict.ok).toBe(false);
    expect(verdict.unsupportedPaths).toEqual(['secrets.env']);
  });

  it('keeps cited line numbers that fall inside a range Core read', () => {
    const reads: LocalCoreRead[] = [{ path: 'app.js', range: '1-40' }];
    const verdict = checkAnswerReferences([{ path: 'app.js', startLine: 10, endLine: 20 }], reads);
    expect(verdict.ok).toBe(true);
    expect(verdict.droppedRanges).toEqual([]);
    expect(verdict.references).toEqual([{ path: 'app.js', startLine: 10, endLine: 20 }]);
  });

  it('drops cited line numbers outside every range Core read, keeping the verified path', () => {
    const reads: LocalCoreRead[] = [{ path: 'app.js', range: '1-40' }];
    const verdict = checkAnswerReferences([{ path: 'app.js', startLine: 380, endLine: 410 }], reads);
    expect(verdict.ok).toBe(true);
    expect(verdict.droppedRanges).toEqual(['app.js:380-410']);
    expect(verdict.references).toEqual([{ path: 'app.js' }]);
  });

  it('drops a range that only partly overlaps a read range', () => {
    const reads: LocalCoreRead[] = [{ path: 'app.js', range: '20-60' }];
    const verdict = checkAnswerReferences([{ path: 'app.js', startLine: 10, endLine: 30 }], reads);
    expect(verdict.droppedRanges).toEqual(['app.js:10-30']);
    expect(verdict.references).toEqual([{ path: 'app.js' }]);
  });
});

describe('the Local Core absolute deadline is bound to the original attempt start', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it('anchors a resumed attempt to its first start, not to this execution', () => {
    const anchor = localCoreBudgetAnchor({ startedAt: minutesAgo(19), createdAt: minutesAgo(25) });
    const budget = localCoreBudget(anchor);
    expect(budget.remainingAbsoluteMs).toBeLessThanOrEqual(61_000);
    expect(budget.remainingAbsoluteMs).toBeGreaterThan(0);
    // A second execution of the same attempt inherits the same anchor, so the
    // deadline does not move.
    expect(localCoreDeadlineMs(localCoreBudgetAnchor({ startedAt: anchor, createdAt: minutesAgo(25) })))
      .toBe(Date.parse(anchor) + MISSION_WALL_CLOCK_MS);
  });

  it('falls back to creation time when the attempt has not recorded a start', () => {
    const created = minutesAgo(21);
    expect(localCoreBudgetAnchor({ startedAt: null, createdAt: created })).toBe(created);
    expect(answerAdmissible(localCoreBudget(created)).ok).toBe(false);
  });

  it('refuses a late answer produced after the absolute deadline expired', () => {
    const verdict = answerAdmissible(localCoreBudget(minutesAgo(21)));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('20 minute mission wall clock');
  });

  it('accepts an answer that lands inside the deadline', () => {
    expect(answerAdmissible(localCoreBudget(minutesAgo(2))).ok).toBe(true);
  });
});

describe('reads are recorded only when Core observed them succeed', () => {
  it('does not record a failed read or a search as a successful read', () => {
    let reads: LocalCoreRead[] = [];
    reads = recordSuccessfulRead(reads, {
      action: 'read_file', path: 'missing.js', resultCount: 0, truncated: false, ok: false, output: 'blocked',
    });
    reads = recordSuccessfulRead(reads, {
      action: 'search', query: 'answer', resultCount: 3, truncated: false, ok: true, output: 'hits',
    });
    expect(reads).toEqual([]);
  });

  it('accepts an answer only after the cited file is actually read', () => {
    const root = makeRepo();
    const envelope = envelopeFor(root);

    const premature = executeLocalCoreAction({
      action: { action: 'answer', summary: 'app.js exports answer', references: [{ path: 'app.js' }] },
      envelope,
      reads: [],
    });
    expect(premature.observation.ok).toBe(false);
    expect(premature.answer).toBeUndefined();
    expect(premature.observation.output).toMatch(/never read successfully/);

    const read = executeLocalCoreAction({
      action: { action: 'read_file', path: 'app.js', startLine: 1, endLine: 2 },
      envelope,
      reads: [],
    });
    expect(read.observation.ok).toBe(true);
    expect(read.reads.map((item) => item.path)).toEqual(['app.js']);

    const answered = executeLocalCoreAction({
      action: { action: 'answer', summary: 'app.js exports answer', references: [{ path: 'app.js', startLine: 1 }] },
      envelope,
      reads: read.reads,
    });
    expect(answered.observation.ok).toBe(true);
    expect(answered.answer).toMatch(/app\.js:1/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('a repository question leaves the repository unchanged', () => {
  it('reads and searches without altering tracked, untracked, or ignored files', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored content\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'untracked content\n');
    const envelope = envelopeFor(root);

    const inventory = () => {
      const entries = fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const absolute = path.join(entry.parentPath ?? root, entry.name);
          return `${path.relative(root, absolute).replace(/\\/g, '/')}:${fs.readFileSync(absolute).length}`;
        });
      return entries.sort().join('\n');
    };

    const statusOf = () => git(root, 'status', '--porcelain', '--untracked-files=all').stdout;
    const headOf = () => git(root, 'rev-parse', 'HEAD').stdout.trim();
    const before = inventory();
    const statusBefore = statusOf();
    const headBefore = headOf();
    const searched = executeLocalCoreAction({
      action: { action: 'search', query: 'answer' },
      envelope,
      reads: [],
    });
    expect(searched.observation.action).toBe('search');
    const read = executeLocalCoreAction({
      action: { action: 'read_file', path: 'README.md' },
      envelope,
      reads: searched.reads,
    });
    expect(read.observation.ok).toBe(true);
    executeLocalCoreAction({
      action: { action: 'answer', summary: 'README describes the fixture', references: [{ path: 'README.md' }] },
      envelope,
      reads: read.reads,
    });

    // Tracked bytes, untracked and ignored files, and HEAD are all unchanged,
    // and nothing was staged or committed.
    expect(inventory()).toBe(before);
    expect(statusOf()).toBe(statusBefore);
    expect(headOf()).toBe(headBefore);
    expect(statusBefore).toMatch(/\?\? untracked\.txt/);
    expect(statusBefore).not.toMatch(/README\.md/);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
