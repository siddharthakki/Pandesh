import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SYNTHETIC_SECRET,
  actionById,
  compileWindowsConfinementLauncher,
  createConfinementFixture,
  defaultBoundaryActions,
  runWindowsConfinement,
  type ConfinementFixture,
} from '../runtime/windowsConfinement';
import { LOCAL_MODEL_ENDPOINT } from '../runtime/workerDiscovery';
import { listWorkerOptions, resolveWorkerProfile } from '../runtime/localCoreQuestion';

const describeWin = process.platform === 'win32' ? describe : describe.skip;

describeWin('Windows confinement prototype', () => {
  let fixture: ConfinementFixture | undefined;
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-confine-build-'));
  let launcher = '';

  beforeAll(() => {
    launcher = compileWindowsConfinementLauncher(buildDir);
  }, 60_000);

  afterEach(() => {
    if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture = undefined;
  });

  it('enforces workspace/scratch writes, denies outside writes, linked-worktree Git metadata, and synthetic secrets', () => {
    fixture = createConfinementFixture();
    const gitFileBefore = fs.readFileSync(fixture.gitFile, 'utf8');
    const run = runWindowsConfinement({
      launcher,
      fixture,
      actions: defaultBoundaryActions(fixture),
    });
    expect(run.report.ok, JSON.stringify(run.report)).toBe(true);
    expect(run.report.jobAssigned).toBe(true);
    expect(run.report.appContainerSid).toMatch(/^S-1-15-2-/);
    expect(typeof run.report.usedConstructedEnv).toBe('boolean');
    expect(run.report.usedConstructedEnv, 'AppContainer CreateProcess must use the constructed environment block').toBe(true);

    if (run.report.exitCode !== 0) {
      return;
    }

    const writeWorkspace = actionById(run, 'writeWorkspace');
    const writeScratch = actionById(run, 'writeScratch');
    const readWorkspace = actionById(run, 'readWorkspace');
    expect(writeWorkspace?.ok, JSON.stringify(writeWorkspace)).toBe(true);
    expect(writeScratch?.ok, JSON.stringify(writeScratch)).toBe(true);
    expect(readWorkspace?.ok, JSON.stringify(readWorkspace)).toBe(true);
    expect(fs.readFileSync(path.join(fixture.workspace, 'allowed.txt'), 'utf8')).toBe('workspace-ok');
    expect(fs.readFileSync(path.join(fixture.scratch, 'allowed.txt'), 'utf8')).toBe('scratch-ok');

    expect(actionById(run, 'writeOutside')?.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.outside, 'pwn.txt'))).toBe(false);

    expect(actionById(run, 'writeGitFile')?.ok).toBe(false);
    expect(fs.readFileSync(fixture.gitFile, 'utf8')).toBe(gitFileBefore);
    expect(actionById(run, 'writeGitDir')?.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.gitDir, 'evil-ref'))).toBe(false);
    expect(actionById(run, 'writeCommonDir')?.ok).toBe(false);
    expect(fs.existsSync(path.join(fixture.commonDir, 'hooks', 'evil.hook'))).toBe(false);

    const secret = actionById(run, 'readSecret');
    expect(secret?.ok).toBe(false);
    expect(secret?.output ?? '').not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(run)).not.toContain(SYNTHETIC_SECRET);
  }, 60_000);

  it('denies non-allowlisted destinations and does not open all-ports loopback', () => {
    fixture = createConfinementFixture();
    const run = runWindowsConfinement({
      launcher,
      fixture,
      actions: defaultBoundaryActions(fixture),
    });
    expect(run.report.ok, JSON.stringify(run.report)).toBe(true);
    expect(run.report.wfp?.attempted).toBe(true);
    if (run.report.exitCode !== 0) {
      return;
    }
    expect(actionById(run, 'httpOtherLoopback')?.ok).toBe(false);
    expect(actionById(run, 'httpExternal')?.ok).toBe(false);
    // Microsoft documents AppContainer loopback as blocked unless a debug
    // all-ports exemption is added. This prototype does not add that exemption,
    // so the required single-origin Ollama exception is expected to be missing.
    expect(actionById(run, 'httpOllama')?.ok).toBe(false);
    expect(actionById(run, 'httpOllama')?.error ?? '').not.toMatch(/LoopbackExempt|internetClient/i);
  }, 60_000);

  it('terminates a child and grandchild and confirms the job is empty', () => {
    fixture = createConfinementFixture();
    const run = runWindowsConfinement({
      launcher,
      fixture,
      cancelAfterMs: 400,
      timeoutMs: 15000,
      actions: [
        {
          id: 'spawnGrandchild',
          op: 'spawn',
          file: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe'),
          arguments: '-n 25 127.0.0.1',
          holdMs: 20000,
        },
      ],
    });
    expect(run.report.ok, JSON.stringify(run.report)).toBe(true);
    if (run.report.exitCode !== 0) {
      return;
    }
    expect(run.report.canceled).toBe(true);
    expect(run.report.jobEmpty).toBe(true);
    expect(run.report.jobPids ?? []).toEqual([]);
  }, 60_000);

  it('leaves Copilot Local unselectable', () => {
    expect(listWorkerOptions().find((option) => option.id === 'copilot-local')?.selectable).toBe(false);
    expect(resolveWorkerProfile('copilot-local').ok).toBe(false);
  });
});

describe('Windows confinement prototype (host-independent)', () => {
  it('names the exact loopback origin the missing network exception would have to allow', () => {
    expect(LOCAL_MODEL_ENDPOINT).toBe('http://127.0.0.1:11434');
  });
});
