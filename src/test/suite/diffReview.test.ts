import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { CodingProposal } from '../../coding/CodingProposal';
import { buildDiffReviewFindings, combineDiffReviewVerdict, diffReviewAllowsDelivery, DiffReviewInput } from '../../coding/DiffReview';
import { runDiffReviewStage } from '../../coding/DiffReviewStage';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd, windowsHide: true })).stdout.trim();
}

function makeProposal(): CodingProposal {
  return {
    version: 1,
    taskSummary: 'test',
    operations: [{ type: 'replace', path: 'src/A.ts', reason: 'x', content: 'y' }],
    validationCommands: [],
    limits: { maxFiles: 12, maxBytesPerFile: 200_000, totalBytes: 0 },
    warnings: [],
    status: 'proposed',
  };
}

function baseInput(overrides: Partial<DiffReviewInput> = {}): DiffReviewInput {
  return {
    originalTaskGoal: 'fix the bug',
    verifiedProposal: makeProposal(),
    approvedScopePaths: ['src/A.ts'],
    actualDiff: 'diff --git a/src/A.ts b/src/A.ts\n+export const x = 1;',
    actualChangedFiles: ['src/A.ts'],
    validationResults: [{ command: 'tsc --noEmit', exitCode: 0, timedOut: false }],
    qualityGateStatus: 'passed',
    ...overrides,
  };
}

describe('DiffReview — Phase 5 independent actual-diff review', () => {
  it('a clean actual diff produces no host findings and allows a passing model verdict through', () => {
    const findings = buildDiffReviewFindings(baseInput());
    expect(findings.changedFileScope.unexpected).toEqual([]);
    expect(findings.validationFindings).toEqual([]);
    expect(findings.securityFindings).toEqual([]);

    const verdict = combineDiffReviewVerdict(
      findings,
      { verdict: 'pass', requirementFindings: [], explanation: 'matches task goal' },
      'ollama',
      'qwen2.5-coder',
    );
    expect(diffReviewAllowsDelivery(verdict)).toBe(true);
    expect(verdict.reviewerProvider).toBe('ollama');
  });

  it('an unrelated (unapproved) changed file forces reject even if the model verdict passes', () => {
    const findings = buildDiffReviewFindings(baseInput({ actualChangedFiles: ['src/A.ts', 'src/Unrelated.ts'] }));
    const verdict = combineDiffReviewVerdict(
      findings,
      { verdict: 'pass', requirementFindings: [], explanation: 'looks fine' },
      'ollama',
      'qwen2.5-coder',
    );
    expect(verdict.verdict).toBe('reject');
    expect(diffReviewAllowsDelivery(verdict)).toBe(false);
    expect(verdict.changedFileFindings).toContain('unexpected change: src/Unrelated.ts');
  });

  it('rejects an empty delivery candidate when the approved mutation path is missing', () => {
    const findings = buildDiffReviewFindings(baseInput({ actualDiff: '', actualChangedFiles: [] }));
    const verdict = combineDiffReviewVerdict(
      findings,
      { verdict: 'pass', requirementFindings: [], explanation: 'model saw no issue' },
      'ollama',
      'qwen2.5-coder',
      'empty-fingerprint',
    );
    expect(verdict.verdict).toBe('reject');
    expect(verdict.changedFileFindings).toContain('expected change missing: src/A.ts');
  });

  it('a failed validation command forces reject regardless of the model verdict', () => {
    const findings = buildDiffReviewFindings(
      baseInput({ validationResults: [{ command: 'npx tsc --noEmit', exitCode: 1, timedOut: false }] }),
    );
    const verdict = combineDiffReviewVerdict(
      findings,
      { verdict: 'pass', requirementFindings: [], explanation: 'ignored' },
      'ollama',
      'qwen2.5-coder',
    );
    expect(verdict.verdict).toBe('reject');
    expect(verdict.validationFindings).toContain('npx tsc --noEmit exited 1');
  });

  it('a rejecting model verdict on otherwise-clean findings still blocks delivery', () => {
    const findings = buildDiffReviewFindings(baseInput());
    const verdict = combineDiffReviewVerdict(
      findings,
      { verdict: 'reject', requirementFindings: ['does not address the reported bug'], explanation: 'off-task' },
      'ollama',
      'qwen2.5-coder',
    );
    expect(diffReviewAllowsDelivery(verdict)).toBe(false);
  });

  it('a secret detected in the actual diff forces reject', () => {
    const findings = buildDiffReviewFindings(
      baseInput({ actualDiff: 'AKIA1234567890ABCDEF added to config' }),
    );
    expect(findings.securityFindings.length).toBeGreaterThan(0);
    const verdict = combineDiffReviewVerdict(
      findings,
      { verdict: 'pass', requirementFindings: [], explanation: 'ignored' },
      'ollama',
      'qwen2.5-coder',
    );
    expect(verdict.verdict).toBe('reject');
  });

  // Regression for att_17d9bc34: `originalTaskGoal` was accepted here but
  // never read — a confirmed missing check, not a malfunctioning one. An
  // unrelated deletion (INVESTIGATION_NOTE.md, which textually discussed the
  // same defect but was not the actual source) reached delivery review with
  // no way to detect it never touched what the goal named.
  describe('objective relevance (host evidence, no model call)', () => {
    it('flags a change that touches none of the files where every goal-referenced identifier actually lives', () => {
      const findings = buildDiffReviewFindings(baseInput({
        originalTaskGoal: 'Fix approveDelivery so it does not report workspace_delivery_conflict as runtime_error.',
        approvedScopePaths: ['NOTES.md'],
        actualChangedFiles: ['NOTES.md'],
        actualDiff: 'diff --git a/NOTES.md b/NOTES.md\n-approveDelivery has a bug\n-workspace_delivery_conflict becomes runtime_error',
        objectiveRelevanceEvidence: [
          { term: 'approveDelivery', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
          { term: 'workspace_delivery_conflict', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
          { term: 'runtime_error', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
        ],
      }));
      expect(findings.objectiveRelevanceFindings.length).toBeGreaterThan(0);
      const verdict = combineDiffReviewVerdict(
        findings,
        { verdict: 'pass', requirementFindings: [], explanation: 'looks fine' },
        'host',
        'deterministic',
        'fp',
      );
      expect(verdict.verdict).toBe('reject');
      expect(verdict.objectiveRelevanceFindings.length).toBeGreaterThan(0);
    });

    it('does not flag a change that touches the file where a goal-referenced identifier lives', () => {
      const findings = buildDiffReviewFindings(baseInput({
        originalTaskGoal: 'Fix approveDelivery so it does not report workspace_delivery_conflict as runtime_error.',
        approvedScopePaths: ['src/activation/M15AutonomousRuntime.ts'],
        actualChangedFiles: ['src/activation/M15AutonomousRuntime.ts'],
        objectiveRelevanceEvidence: [
          { term: 'approveDelivery', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
          { term: 'workspace_delivery_conflict', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
          { term: 'runtime_error', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
        ],
      }));
      expect(findings.objectiveRelevanceFindings).toEqual([]);
    });

    it('does not flag a change when the goal only partially matches (some referenced identifiers ARE touched)', () => {
      const findings = buildDiffReviewFindings(baseInput({
        originalTaskGoal: 'Fix approveDelivery and update runtimeErrorLogger together.',
        approvedScopePaths: ['src/activation/M15AutonomousRuntime.ts'],
        actualChangedFiles: ['src/activation/M15AutonomousRuntime.ts'],
        objectiveRelevanceEvidence: [
          { term: 'approveDelivery', matchingFiles: ['src/activation/M15AutonomousRuntime.ts'] },
          { term: 'runtimeErrorLogger', matchingFiles: ['src/other/Elsewhere.ts'] },
        ],
      }));
      expect(findings.objectiveRelevanceFindings).toEqual([]);
    });

    it('never flags a change when the goal has no locatable identifiers (e.g. a doc-only or purely descriptive task)', () => {
      const findings = buildDiffReviewFindings(baseInput({
        originalTaskGoal: 'clean up the readme',
        objectiveRelevanceEvidence: [],
      }));
      expect(findings.objectiveRelevanceFindings).toEqual([]);
    });

    it('never flags a change when a referenced identifier is not located anywhere in the repository', () => {
      const findings = buildDiffReviewFindings(baseInput({
        originalTaskGoal: 'Add a brandNewHelperFunction.',
        objectiveRelevanceEvidence: [{ term: 'brandNewHelperFunction', matchingFiles: [] }],
      }));
      expect(findings.objectiveRelevanceFindings).toEqual([]);
    });
  });

  // End-to-end regression against a real git repo and real `git grep` — the
  // closest reproduction of att_17d9bc34's actual failure mode available
  // without a live model.
  it('rejects an unrelated deletion end-to-end via runDiffReviewStage, and accepts the same goal when the relevant file is actually touched', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diff-review-relevance-'));
    try {
      await fs.mkdir(path.join(root, 'src', 'activation'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'src', 'activation', 'runtime.ts'),
        'export async function approveDelivery() {\n  // classifies workspace_delivery_conflict\n  return "runtime_error";\n}\n',
      );
      await fs.writeFile(
        path.join(root, 'NOTES.md'),
        '# Investigation\napproveDelivery loses workspace_delivery_conflict and reports runtime_error instead.\n',
      );
      await git(root, ['init']);
      await git(root, ['config', 'user.email', 'test@example.com']);
      await git(root, ['config', 'user.name', 'Test']);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);

      const goal = 'Fix approveDelivery so it does not report workspace_delivery_conflict as runtime_error.';

      // Unrelated: deletes only the note that discusses the bug in prose,
      // never touches the file that actually declares approveDelivery.
      await fs.rm(path.join(root, 'NOTES.md'));
      const unrelatedProposal = makeProposal();
      unrelatedProposal.operations = [{ type: 'delete', path: 'NOTES.md', reason: 'stale note' }];
      const unrelated = await runDiffReviewStage({
        workspaceRoot: root,
        verifiedProposal: unrelatedProposal,
        approvedScopePaths: ['NOTES.md'],
        validationResults: [{ command: 'tsc --noEmit', exitCode: 0, timedOut: false }],
        qualityGateStatus: 'passed',
        originalTaskGoal: goal,
      });
      expect(unrelated.verdict).toBe('reject');
      expect(unrelated.objectiveRelevanceFindings.length).toBeGreaterThan(0);

      // Restore, then make the actually-relevant change instead.
      await git(root, ['checkout', '--', 'NOTES.md']);
      await fs.writeFile(
        path.join(root, 'src', 'activation', 'runtime.ts'),
        'export async function approveDelivery() {\n  // fixed: preserves the specific classification\n  return "workspace_delivery_conflict";\n}\n',
      );
      const relevantProposal = makeProposal();
      relevantProposal.operations = [{ type: 'replace', path: 'src/activation/runtime.ts', reason: 'fix', content: 'fixed' }];
      const relevant = await runDiffReviewStage({
        workspaceRoot: root,
        verifiedProposal: relevantProposal,
        approvedScopePaths: ['src/activation/runtime.ts'],
        validationResults: [{ command: 'tsc --noEmit', exitCode: 0, timedOut: false }],
        qualityGateStatus: 'passed',
        originalTaskGoal: goal,
      });
      expect(relevant.verdict).toBe('pass');
      expect(relevant.objectiveRelevanceFindings).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('counts goal terms inside files the mutation just created (untracked), not only pre-existing tracked files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diff-review-created-'));
    try {
      await fs.writeFile(path.join(root, 'README.md'), '# KarkeDikha webapp dogfood\n');
      await git(root, ['init']);
      await git(root, ['config', 'user.email', 'test@example.com']);
      await git(root, ['config', 'user.name', 'Test']);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);

      await fs.mkdir(path.join(root, 'lib'));
      await fs.writeFile(path.join(root, 'lib', 'page.js'), 'module.exports = "<h1>KarkeDikha Dogfood</h1>";\n');
      const proposal = makeProposal();
      proposal.operations = [{ type: 'create', path: 'lib/page.js', reason: 'page', content: 'page' }];
      const review = await runDiffReviewStage({
        workspaceRoot: root,
        verifiedProposal: proposal,
        approvedScopePaths: ['lib/page.js'],
        validationResults: [{ command: 'npm test', exitCode: 0, timedOut: false }],
        qualityGateStatus: 'passed',
        originalTaskGoal: 'Build a page with the heading "KarkeDikha Dogfood".',
      });
      expect(review.objectiveRelevanceFindings).toEqual([]);
      expect(review.verdict).toBe('pass');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('excludes only repository-root runtime state from review and fingerprint evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diff-review-runtime-state-'));
    try {
      await fs.mkdir(path.join(root, '.ollama-agent'), { recursive: true });
      await fs.mkdir(path.join(root, 'src', '.ollama-agent'), { recursive: true });
      await fs.writeFile(path.join(root, '.ollama-agent', 'runtime.db'), 'runtime-v1');
      await fs.writeFile(path.join(root, 'src', '.ollama-agent', 'user.ts'), 'export const user = 1;\n');
      await fs.writeFile(path.join(root, 'src', '.ollama-agent-lookalike.ts'), 'export const lookalike = 1;\n');
      await fs.writeFile(path.join(root, 'src', 'A.ts'), 'export const a = 1;\n');
      await git(root, ['init']);
      await git(root, ['config', 'user.email', 'test@example.com']);
      await git(root, ['config', 'user.name', 'Test']);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);

      await fs.writeFile(path.join(root, '.ollama-agent', 'runtime.db'), 'runtime-v2');
      await fs.writeFile(path.join(root, 'src', '.ollama-agent', 'user.ts'), 'export const user = 2;\n');
      await fs.writeFile(path.join(root, 'src', '.ollama-agent-lookalike.ts'), 'export const lookalike = 2;\n');
      await fs.writeFile(path.join(root, 'src', 'A.ts'), 'export const a = 2;\n');

      const proposal = makeProposal();
      proposal.operations = [
        { type: 'replace', path: 'src/A.ts', reason: 'x', content: 'export const a = 2;\n' },
        { type: 'replace', path: 'src/.ollama-agent/user.ts', reason: 'x', content: 'export const user = 2;\n' },
        { type: 'replace', path: 'src/.ollama-agent-lookalike.ts', reason: 'x', content: 'export const lookalike = 2;\n' },
      ];
      let reviewedDiff = '';
      let reviewedPaths: string[] = [];
      const review = () => runDiffReviewStage({
        workspaceRoot: root,
        verifiedProposal: proposal,
        approvedScopePaths: proposal.operations.map(operation => operation.path),
        validationResults: [{ command: 'test', exitCode: 0, timedOut: false }],
        qualityGateStatus: 'passed',
        originalTaskGoal: 'update governed user files',
        reviewerVerdict: async input => {
          reviewedDiff = input.diff;
          reviewedPaths = input.changedFiles;
          return { verdict: 'pass', requirementFindings: [], explanation: 'ok', provider: 'test', model: 'test' };
        },
      });

      const first = await review();
      expect(first.verdict).toBe('pass');
      expect(reviewedPaths.sort()).toEqual(proposal.operations.map(operation => operation.path).sort());
      expect(reviewedDiff).not.toContain('a/.ollama-agent/runtime.db');
      expect(reviewedDiff).toContain('a/src/.ollama-agent/user.ts');
      expect(reviewedDiff).toContain('a/src/.ollama-agent-lookalike.ts');

      await fs.writeFile(path.join(root, '.ollama-agent', 'runtime.db'), 'runtime-v3');
      const runtimeOnlyChanged = await review();
      expect(runtimeOnlyChanged.reviewedDiffFingerprint).toBe(first.reviewedDiffFingerprint);

      await fs.writeFile(path.join(root, 'src', 'A.ts'), 'export const a = 3;\n');
      const userFileChanged = await review();
      expect(userFileChanged.reviewedDiffFingerprint).not.toBe(first.reviewedDiffFingerprint);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
