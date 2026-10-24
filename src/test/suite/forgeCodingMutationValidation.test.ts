import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodingProposal, fingerprintText } from '../../coding/CodingProposal';
import { WorkspaceMutationEngine, WorkspaceSnapshotBinder } from '../../coding/WorkspaceMutation';
import { CodingValidationRunner, commandSpec } from '../../coding/ValidationRunner';

describe('Forge coding mutation and validation', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-coding-mutate-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'old.ts'), 'old\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('creates, replaces and deletes files with fingerprint checks', async () => {
    const proposal = baseProposal([
      { type: 'create', path: 'src/new.ts', reason: 'new', content: 'new\n' },
      { type: 'replace', path: 'src/old.ts', reason: 'replace', content: 'changed\n', expectedFingerprint: fingerprintText('old\n') },
    ]);
    const result = await applyBound(proposal, root);
    expect(result.filesCreated).toEqual(['src/new.ts']);
    expect(result.filesModified).toEqual(['src/old.ts']);
    expect(await fs.readFile(path.join(root, 'src', 'old.ts'), 'utf8')).toBe('changed\n');
  });

  it('rolls back partial mutation on later failure and reports restored files', async () => {
    const first = baseProposal([
      { type: 'create', path: 'src/new.ts', reason: 'new', content: 'new\n' },
      { type: 'replace', path: 'src/old.ts', reason: 'stale', content: 'bad\n' },
    ]);
    const proposal = await new WorkspaceSnapshotBinder(root).bind(first);
    await fs.writeFile(path.join(root, 'src', 'old.ts'), 'stale\n');
    await expect(new WorkspaceMutationEngine(root).apply(proposal)).rejects.toThrow('workspace_changed_after_review');
    await expect(fs.stat(path.join(root, 'src', 'new.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'src', 'old.ts'), 'utf8')).toBe('stale\n');
  });

  it('rolls back already-mutated files when a later create snapshot turns stale', async () => {
    const proposal = await new WorkspaceSnapshotBinder(root).bind(baseProposal([
      { type: 'create', path: 'src/new.ts', reason: 'new', content: 'new\n' },
      { type: 'create', path: 'src/race.ts', reason: 'race', content: 'bad\n' },
    ]));
    await fs.writeFile(path.join(root, 'src', 'race.ts'), 'other\n');
    await expect(new WorkspaceMutationEngine(root).apply(proposal)).rejects.toThrow('workspace_changed_after_review');
    await expect(fs.stat(path.join(root, 'src', 'new.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'src', 'race.ts'), 'utf8')).toBe('other\n');
  });

  it('rejects disposal, cancellation and outside-workspace mutation', async () => {
    const engine = new WorkspaceMutationEngine(root);
    engine.dispose();
    await expect(engine.apply(await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' }])))).rejects.toThrow('controller_disposed');
    const abort = new AbortController();
    abort.abort();
    await expect(new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' }]), abort.signal)).rejects.toThrow('cancelled');
    await expect(new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'create', path: '../a.ts', reason: 'x', content: 'x' }]))).rejects.toThrow('path_traversal_rejected');
  });

  it('replaces and deletes existing untracked files using host-derived byte fingerprints', async () => {
    await fs.writeFile(path.join(root, 'src', 'untracked.ts'), 'old\r\n');
    const replace = baseProposal([{ type: 'replace', path: 'src/untracked.ts', reason: 'replace', content: 'new\n', expectedFingerprint: 'sha256:bogus' }]);
    const bound = await new WorkspaceSnapshotBinder(root).bind(replace);
    expect(bound.operations[0].snapshot).toMatchObject({ state: 'exists' });
    const result = await new WorkspaceMutationEngine(root).apply(bound);
    expect(result.filesModified).toEqual(['src/untracked.ts']);
    expect(await fs.readFile(path.join(root, 'src', 'untracked.ts'), 'utf8')).toBe('new\n');

    const del = await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'delete', path: 'src/untracked.ts', reason: 'delete src/untracked.ts from repository' }]));
    const deleted = await new WorkspaceMutationEngine(root).apply(del);
    expect(deleted.filesDeleted).toEqual(['src/untracked.ts']);
    await expect(fs.stat(path.join(root, 'src', 'untracked.ts'))).rejects.toThrow();
  });

  it('detects raw-byte changes, create races and disappearing files after review', async () => {
    await fs.writeFile(path.join(root, 'src', 'raw.ts'), Buffer.from('same\n'));
    const raw = await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'replace', path: 'src/raw.ts', reason: 'raw', content: 'same\n' }]));
    await fs.writeFile(path.join(root, 'src', 'raw.ts'), Buffer.from('same\r\n'));
    await expect(new WorkspaceMutationEngine(root).apply(raw)).rejects.toThrow('workspace_changed_after_review');

    const create = await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'create', path: 'src/race.ts', reason: 'race', content: 'x' }]));
    await fs.writeFile(path.join(root, 'src', 'race.ts'), 'other');
    await expect(new WorkspaceMutationEngine(root).apply(create)).rejects.toThrow('workspace_changed_after_review');

    const disappearing = await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'replace', path: 'src/old.ts', reason: 'gone', content: 'x' }]));
    await fs.rm(path.join(root, 'src', 'old.ts'));
    await expect(new WorkspaceMutationEngine(root).apply(disappearing)).rejects.toThrow('workspace_changed_after_review');
  });

  it('classifies binding failures for missing replace targets and existing create targets', async () => {
    await expect(new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'replace', path: 'src/missing.ts', reason: 'missing', content: 'x' }]))).rejects.toThrow('file_missing_at_binding');
    await expect(new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'create', path: 'src/old.ts', reason: 'exists', content: 'x' }]))).rejects.toThrow('create_target_exists');
  });

  it('classifies binder-level duplicate normalized targets, including Windows case-insensitive aliases, without mutating anything', async () => {
    const proposal = baseProposal([
      { type: 'create', path: 'src/Foo.ts', reason: 'first', content: 'a' },
      { type: 'create', path: 'src/foo.ts', reason: 'second', content: 'b' },
    ]);
    await expect(new WorkspaceSnapshotBinder(root).bind(proposal)).rejects.toThrow('duplicate_proposal_target');
    await expect(fs.stat(path.join(root, 'src', 'Foo.ts'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'src', 'foo.ts'))).rejects.toThrow();
  });

  it('attaches bounded, content-free proposal conflict evidence to a create_target_exists binding failure', async () => {
    const proposal = baseProposal([
      { type: 'create', path: 'src/new.ts', reason: 'new', content: 'new\n' },
      { type: 'create', path: 'src/old.ts', reason: 'exists', content: 'super-secret-model-output' },
    ]);
    try {
      await new WorkspaceSnapshotBinder(root).bind(proposal);
      expect.unreachable('bind should have thrown create_target_exists');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const evidence = (error as Error & { proposalConflictEvidence?: Record<string, unknown> }).proposalConflictEvidence;
      expect(evidence).toMatchObject({
        operationIndex: 1,
        targetPath: 'src/old.ts',
        operationKind: 'create',
        classification: 'create_target_exists',
        targetExistedAtBindingTime: true,
        proposalOperationCount: 2,
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain('super-secret-model-output');
      expect(serialized).not.toContain('content');
      expect(serialized).not.toContain('reason');
    }
  });

  it('resolves targetExistedAtBase against the provided base commit, independent of binding-time state', async () => {
    const { spawn } = await import('child_process');
    const run = (args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed`)));
    });
    await run(['init']);
    await run(['config', 'user.email', 'test@example.com']);
    await run(['config', 'user.name', 'Test']);
    await run(['add', '.']);
    await run(['commit', '-m', 'base']);
    const sha = await new Promise<string>((resolve, reject) => {
      let out = '';
      const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, shell: false, windowsHide: true });
      child.stdout.on('data', data => { out += String(data); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error('rev-parse failed')));
    });

    // Absent at base, but appears concurrently before binding: still blocks, and the
    // evidence must distinguish "existed at base" (false) from "existed at binding time" (true).
    await fs.writeFile(path.join(root, 'src', 'concurrent.ts'), 'appeared after base\n');
    try {
      await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'create', path: 'src/concurrent.ts', reason: 'x', content: 'x' }]), undefined, sha);
      expect.unreachable('bind should have thrown create_target_exists');
    } catch (error) {
      const evidence = (error as Error & { proposalConflictEvidence?: Record<string, unknown> }).proposalConflictEvidence;
      expect(evidence).toMatchObject({ targetExistedAtBase: false, targetExistedAtBindingTime: true, baseCommitSha: sha });
    }
  });

  it('does not let path normalization map a new create target onto an already-tracked path', async () => {
    const proposal = baseProposal([{ type: 'create', path: 'src/./old.ts', reason: 'normalized alias', content: 'x' }]);
    await expect(new WorkspaceSnapshotBinder(root).bind(proposal)).rejects.toThrow('create_target_exists');
  });

  it('rejects symlink or junction escapes during host snapshot binding', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-coding-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'escape.ts'), 'outside\n');
      try {
        await fs.symlink(path.join(outside, 'escape.ts'), path.join(root, 'src', 'escape.ts'), 'file');
      } catch {
        return;
      }
      await expect(new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'replace', path: 'src/escape.ts', reason: 'escape', content: 'x' }]))).rejects.toThrow('path_outside_workspace');
    } finally {
      await fs.rm(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('runs approved validation commands and reports non-zero exits', async () => {
    const runner = new CodingValidationRunner(root, 10_000);
    const results = await runner.runAll([{ kind: 'npm-script', script: 'verify' }]);
    expect(results.every(result => result.exitCode === 0)).toBe(true);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { fail: 'node -e "process.exit(7)"' } }));
    const failed = await runner.runAll([{ kind: 'npm-script', script: 'fail' }]);
    expect(failed[0].exitCode).toBe(7);
  });

  it('resolves local TypeScript and Vitest through a real PATH node without npx', async () => {
    await provisionLocalNodeTool(root, path.join('typescript', 'bin'), 'tsc', 'process.exit(0);');
    await provisionLocalNodeTool(root, 'vitest', 'vitest.mjs', 'process.exit(0);');
    const runner = new CodingValidationRunner(root, 10_000);
    const results = await runner.runAll([
      { kind: 'tsc-no-emit' },
      { kind: 'vitest', args: ['src/test/suite/forgeCodingMutationValidation.test.ts'] },
    ]);
    expect(results.map(result => result.exitCode)).toEqual([0, 0]);
    expect(results[0].command).toBe('npx tsc --noEmit --pretty false');
    expect(results[1].command).toBe('npx vitest run src/test/suite/forgeCodingMutationValidation.test.ts');
  });

  it('returns deterministic unavailable results for missing node and local tools', async () => {
    const missingNode = await new CodingValidationRunner(root, 10_000, { envPath: root }).runAll([{ kind: 'tsc-no-emit' }]);
    expect(missingNode[0].output).toMatch(/no valid node\.exe/i);

    const missingTypeScript = await new CodingValidationRunner(root, 10_000).runAll([{ kind: 'tsc-no-emit' }]);
    expect(missingTypeScript[0].output).toMatch(/workspace-local TypeScript/i);

    const missingVitest = await new CodingValidationRunner(root, 10_000).runAll([{ kind: 'vitest', args: [] }]);
    expect(missingVitest[0].output).toMatch(/workspace-local Vitest/i);
  });

  it('normalizes Vitest run arguments and never renders duplicate run tokens', () => {
    expect(commandSpec({ kind: 'vitest', args: ['run', 'src/a.test.ts'] }, root).display).toBe('npx vitest run src/a.test.ts');
    expect(commandSpec({ kind: 'vitest', args: ['--run', 'src/a.test.ts'] }, root).display).toBe('npx vitest run src/a.test.ts');
    expect(commandSpec({ kind: 'vitest', args: ['src/a.test.ts'] }, root).display).toBe('npx vitest run src/a.test.ts');
  });

  it('uses node plus npm-cli for approved scripts and never resolves npx', async () => {
    const spec = commandSpec({ kind: 'npm-script', script: 'verify' }, root);
    expect(spec.ok).toBe(true);
    if (spec.ok) {
      expect(path.basename(spec.executable).toLowerCase()).toMatch(/^node(\.exe)?$/);
      expect(spec.args.join(' ')).toContain('npm-cli.js');
      expect(spec.args.join(' ')).not.toContain('npx-cli.js');
      expect(spec.args).toEqual(expect.arrayContaining(['run', 'verify']));
    }
  });

  it('rejects VS Code Extension Host executables and bogus bundled npm paths during resolution', async () => {
    const fakeHost = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-vscode-host-'));
    try {
      await fs.mkdir(path.join(fakeHost, 'C_VSCode'), { recursive: true });
      await fs.writeFile(path.join(fakeHost, 'C_VSCode', 'Code.exe'), '');
      await fs.writeFile(path.join(fakeHost, 'C_VSCode', 'npx.cmd'), '');
      const result = await new CodingValidationRunner(root, 10_000, { envPath: path.join(fakeHost, 'C_VSCode') }).runAll([{ kind: 'npm-script', script: 'verify' }]);
      expect(result[0].output).toMatch(/no valid node\.exe/i);
    } finally {
      await fs.rm(fakeHost, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('supports validation timeout and cancellation', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { slow: 'node -e "setTimeout(()=>{},5000)"' } }));
    const timedOut = await new CodingValidationRunner(root, 50).runAll([{ kind: 'npm-script', script: 'slow' }]);
    expect(timedOut[0].timedOut).toBe(true);
    const abort = new AbortController();
    abort.abort();
    await expect(new CodingValidationRunner(root, 1000).runAll([{ kind: 'npm-script', script: 'slow' }], abort.signal)).rejects.toThrow('cancelled');
  });
});

async function provisionLocalNodeTool(root: string, directory: string, fileName: string, body: string): Promise<void> {
  const toolDir = path.join(root, 'node_modules', directory);
  await fs.mkdir(toolDir, { recursive: true });
  const toolPath = path.join(toolDir, fileName);
  await fs.writeFile(toolPath, body);
  if (process.platform !== 'win32') {
    fsSync.chmodSync(toolPath, 0o755);
  }
}

function baseProposal(operations: CodingProposal['operations']): CodingProposal {
  return {
    version: 1,
    taskSummary: 'test',
    operations,
    validationCommands: [],
    limits: { maxFiles: 12, maxBytesPerFile: 200_000, totalBytes: 0 },
    warnings: [],
    status: 'proposed',
  };
}

async function applyBound(proposal: CodingProposal, root: string) {
  const bound = await new WorkspaceSnapshotBinder(root).bind(proposal);
  return new WorkspaceMutationEngine(root).apply(bound);
}
