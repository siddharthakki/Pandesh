import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeMissionAction } from '../runtime/missionLoop';
import { reviewWorkspaceDiff } from '../runtime/missionDiffReview';
import { classifyUnsafeDeliveryPath } from '../runtime/missionDeliveryManifest';
import { browserProfileRoot, createBrowserProfileDir, removeBrowserProfileDir } from '../runtime/browserInspection';
import type { MissionEvidence } from '../runtime/missionObservations';
import type { MissionEnvelope } from '../runtime/scopedCommand';

/**
 * Synthetic stand-ins for the artifacts that contaminated fixture commit
 * ede8514. No real cookie or login file is created, read, or printed.
 */
const SYNTHETIC_PROFILE_FILES = [
  '.tmp/karkedikha-browser/profile-9222/Default/Cookies',
  '.tmp/karkedikha-browser/profile-9222/Default/Cookies-journal',
  '.tmp/karkedikha-browser/profile-9222/Default/Login Data',
  '.tmp/karkedikha-browser/profile-9222/Default/Login Data-journal',
  '.tmp/karkedikha-browser/profile-9222/Default/Network/Trust Tokens',
  '.tmp/karkedikha-browser/profile-9222/GPUCache/data_0',
  '.tmp/karkedikha-browser/profile-9222/Code Cache/js/index',
];

function git(cwd: string, ...argv: string[]) {
  return spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
}

function writeFile(root: string, relative: string, contents: string): void {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-delivery-'));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@karkedikha.local');
  git(dir, 'config', 'user.name', 'test');
  writeFile(dir, 'index.html', '<!doctype html><title>base</title>\n');
  git(dir, 'add', '--', 'index.html');
  git(dir, 'commit', '--quiet', '-m', 'base');
  return dir;
}

function contaminate(root: string): void {
  for (const relative of SYNTHETIC_PROFILE_FILES) {
    writeFile(root, relative, 'synthetic-artifact');
  }
}

function envelopeFor(root: string): MissionEnvelope {
  return {
    workspaceRoot: root,
    pushAuthorized: false,
    networkAuthorized: false,
    installAuthorized: false,
  } as MissionEnvelope;
}

function approvedEvidence(paths: string[]): MissionEvidence {
  return {
    approvedMutation: true,
    approvedPath: paths[paths.length - 1],
    approvedPaths: paths,
    validationPassed: true,
    validationCommand: 'npm run test',
    validationExitCode: 0,
    verificationRequired: false,
    diffReview: 'pending',
  };
}

function runCheck(check: 'diff' | 'commit', root: string, evidence: MissionEvidence) {
  return executeMissionAction({ action: { action: 'run_check', check }, envelope: envelopeFor(root), evidence });
}

function committedPaths(root: string): string[] {
  const shown = git(root, 'show', '--name-only', '--pretty=format:', 'HEAD');
  return (shown.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

describe('browser-profile contamination cannot reach a mission commit', () => {
  it('reproduces the unsafe inclusion that broad staging allowed', () => {
    const root = makeRepo();
    try {
      writeFile(root, 'index.html', '<!doctype html><title>feature</title>\n');
      contaminate(root);

      // The pre-correction mechanism: sweep the workspace, then commit.
      git(root, 'add', '-A');
      git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'broad staging');

      const swept = committedPaths(root);
      for (const relative of SYNTHETIC_PROFILE_FILES) {
        expect(swept).toContain(relative);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the artifacts out of the reviewed manifest and the commit', () => {
    const root = makeRepo();
    try {
      writeFile(root, 'index.html', '<!doctype html><title>feature</title>\n');
      contaminate(root);

      const reviewed = runCheck('diff', root, approvedEvidence(['index.html']));
      expect(reviewed.evidence.diffReview).toBe('pass');
      expect(reviewed.observation.output).not.toMatch(/profile-9222/);

      const committed = runCheck('commit', root, reviewed.evidence);
      expect(committed.observation.ok).toBe(true);

      const paths = committedPaths(root);
      expect(paths).toEqual(['index.html']);
      for (const relative of SYNTHETIC_PROFILE_FILES) {
        expect(paths).not.toContain(relative);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe artifact that reaches the manifest or the index', () => {
    const root = makeRepo();
    try {
      contaminate(root);
      const smuggled = runCheck('diff', root, approvedEvidence(SYNTHETIC_PROFILE_FILES));
      expect(smuggled.evidence.diffReview).toBe('reject');
      expect(smuggled.observation.output).toMatch(/unsafe artifact/);

      writeFile(root, 'index.html', '<!doctype html><title>feature</title>\n');
      const reviewed = runCheck('diff', root, approvedEvidence(['index.html']));
      expect(reviewed.evidence.diffReview).toBe('pass');

      git(root, 'add', '--', '.tmp/karkedikha-browser/profile-9222/Default/Cookies');
      const blocked = runCheck('commit', root, reviewed.evidence);
      expect(blocked.observation.ok).toBe(false);
      expect(blocked.observation.output).toMatch(/unsafe artifact staged/);
      expect(blocked.evidence.commitSha).toBeUndefined();
      expect(committedPaths(root)).toEqual(['index.html']);
      expect(committedPaths(root)).not.toContain('.tmp/karkedikha-browser/profile-9222/Default/Cookies');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still reviews and commits ordinary approved project files', () => {
    const root = makeRepo();
    try {
      writeFile(root, 'index.html', '<!doctype html><title>feature</title>\n');
      writeFile(root, 'src/app.js', 'export const total = (bill) => bill;\n');
      writeFile(root, '.tmp/project-notes.txt', 'project-owned scratch file\n');

      const reviewed = runCheck('diff', root, approvedEvidence(['index.html', 'src/app.js']));
      expect(reviewed.evidence.diffReview).toBe('pass');

      const committed = runCheck('commit', root, reviewed.evidence);
      expect(committed.observation.ok).toBe(true);
      expect(committedPaths(root).sort()).toEqual(['index.html', 'src/app.js']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a project-owned .tmp file when it is explicitly approved', () => {
    const root = makeRepo();
    try {
      writeFile(root, '.tmp/project-fixture.json', '{"kept":true}\n');
      const reviewed = runCheck('diff', root, approvedEvidence(['.tmp/project-fixture.json']));
      expect(reviewed.evidence.diffReview).toBe('pass');

      const committed = runCheck('commit', root, reviewed.evidence);
      expect(committed.observation.ok).toBe(true);
      expect(committedPaths(root)).toEqual(['.tmp/project-fixture.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a file introduced or changed after review, before commit', () => {
    const introduced = makeRepo();
    try {
      writeFile(introduced, 'index.html', '<!doctype html><title>feature</title>\n');
      const reviewed = runCheck('diff', introduced, approvedEvidence(['index.html']));
      expect(reviewed.evidence.diffReview).toBe('pass');

      // A path outside the reviewed manifest appears in the index afterwards.
      writeFile(introduced, 'src/sneaky.js', 'export const x = 1;\n');
      git(introduced, 'add', '--', 'src/sneaky.js');
      const committed = runCheck('commit', introduced, reviewed.evidence);
      expect(committed.observation.ok).toBe(true);
      expect(committedPaths(introduced)).toEqual(['index.html']);
    } finally {
      fs.rmSync(introduced, { recursive: true, force: true });
    }

    const changed = makeRepo();
    try {
      writeFile(changed, 'index.html', '<!doctype html><title>feature</title>\n');
      const reviewed = runCheck('diff', changed, approvedEvidence(['index.html']));
      expect(reviewed.evidence.diffReview).toBe('pass');

      writeFile(changed, 'index.html', '<!doctype html><title>edited after review</title>\n');
      const blocked = runCheck('commit', changed, reviewed.evidence);
      expect(blocked.observation.ok).toBe(false);
      expect(blocked.observation.output).toMatch(/changed after diff review/);
      expect(blocked.evidence.commitSha).toBeUndefined();
    } finally {
      fs.rmSync(changed, { recursive: true, force: true });
    }
  });

  it('refuses to commit without a reviewed manifest digest', () => {
    const root = makeRepo();
    try {
      writeFile(root, 'index.html', '<!doctype html><title>feature</title>\n');
      const evidence: MissionEvidence = { ...approvedEvidence(['index.html']), diffReview: 'pass' };
      const blocked = runCheck('commit', root, evidence);
      expect(blocked.observation.ok).toBe(false);
      expect(blocked.observation.output).toMatch(/not diff reviewed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty manifest instead of reviewing the whole workspace', () => {
    const root = makeRepo();
    try {
      contaminate(root);
      const review = reviewWorkspaceDiff(root, []);
      expect(review.verdict).toBe('reject');
      expect(review.summary).toMatch(/no authorized changed-file manifest/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unsafe delivery path classification', () => {
  it('rejects Core browser artifacts and credential-adjacent files by path alone', () => {
    for (const relative of SYNTHETIC_PROFILE_FILES) {
      expect(classifyUnsafeDeliveryPath(relative)).not.toBeNull();
    }
    expect(classifyUnsafeDeliveryPath('profile-1/Default/Cookies')).not.toBeNull();
    expect(classifyUnsafeDeliveryPath('fixtures/.env.local')).not.toBeNull();
    expect(classifyUnsafeDeliveryPath('../escape.txt')).not.toBeNull();
    expect(classifyUnsafeDeliveryPath('.git/config')).not.toBeNull();
  });

  it('accepts ordinary project files including project-owned .tmp content', () => {
    expect(classifyUnsafeDeliveryPath('index.html')).toBeNull();
    expect(classifyUnsafeDeliveryPath('src/app.js')).toBeNull();
    expect(classifyUnsafeDeliveryPath('.tmp/project-notes.txt')).toBeNull();
    expect(classifyUnsafeDeliveryPath('test/fixtures/cookies.test.js')).toBeNull();
  });
});

describe('browser verification profiles live outside the workspace', () => {
  it('creates profiles in Core temp storage and removes them afterwards', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-profile-ws-'));
    try {
      const profileDir = createBrowserProfileDir();
      try {
        expect(fs.existsSync(profileDir)).toBe(true);
        expect(path.resolve(profileDir).startsWith(path.resolve(browserProfileRoot()))).toBe(true);
        expect(path.relative(path.resolve(workspace), path.resolve(profileDir)).startsWith('..')).toBe(true);
        fs.writeFileSync(path.join(profileDir, 'Cookies'), 'synthetic');
      } finally {
        removeBrowserProfileDir(profileDir);
      }
      expect(fs.existsSync(profileDir)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
