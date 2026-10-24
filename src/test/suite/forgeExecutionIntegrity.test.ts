import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ApprovalEnvelopeService,
  ForgeExecutionReadiness,
  TransactionJournal,
  ValidationSideEffectDetector,
  WorkspaceMutationLease,
  bindProviderIdentity,
  bindTextEncoding,
  bindToolIdentity,
  classifySensitivePath,
  minimalValidationEnvironment,
  validateHardenedRelativePath,
} from '../../coding/ExecutionIntegrity';
import { CodingProposal } from '../../coding/CodingProposal';
import { WorkspaceSnapshotBinder } from '../../coding/WorkspaceMutation';

describe('Forge execution integrity contracts', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-integrity-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'old\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
    await git(['init']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('reports deterministic readiness and blocks dirty target documents', async () => {
    const readiness = await new ForgeExecutionReadiness(root, {
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      trusted: true,
      dirtyDocuments: [{ uri: { scheme: 'file', fsPath: path.join(root, 'src', 'a.ts') }, isDirty: true }],
      extensionBuild: 'test',
      now: () => '2026-07-06T00:00:00.000Z',
    }).check(['src/a.ts']);
    expect(readiness.version).toBe(1);
    expect(readiness.blockingFailures.map(issue => issue.code)).toContain('dirty_document_blocked');
    expect(JSON.stringify(readiness)).not.toContain(process.env.USERPROFILE ?? 'unlikely-secret-path');
  });

  it('binds approval envelopes to branch, HEAD, snapshots and one-time nonce use', async () => {
    const proposal = await new WorkspaceSnapshotBinder(root).bind(baseProposal([{ type: 'replace', path: 'src/a.ts', reason: 'update', content: 'new\n' }]));
    const readiness = await new ForgeExecutionReadiness(root).check(['src/a.ts']);
    expect(readiness.blockingFailures).toEqual([]);
    const service = new ApprovalEnvelopeService();
    const envelope = service.create(proposal, readiness, 'run-1');
    expect(envelope.operations[0].snapshot).toMatchObject({ state: 'exists' });
    expect(envelope.proposalHash).toMatch(/^sha256:/);
    service.consume(envelope, readiness);
    expect(() => service.consume(envelope, readiness)).toThrow('approval_replay_rejected');
  });

  it('enforces hardened Windows path and encoding policy', () => {
    expect(validateHardenedRelativePath('src/CON.ts')).toBe('reserved_windows_name_rejected');
    expect(validateHardenedRelativePath('src/file.txt:ads')).toBe('alternate_data_stream_rejected');
    expect(validateHardenedRelativePath('src/name.')).toBe('ambiguous_windows_path_rejected');
    expect(validateHardenedRelativePath('src/good.ts')).toBeUndefined();
    expect(bindTextEncoding(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('line\r\n')]))).toMatchObject({ encoding: 'utf8-bom', eol: 'crlf', finalNewline: true });
    expect(() => bindTextEncoding(Buffer.from([0xff, 0xfe, 0x00]))).toThrow('utf16_rejected');
  });

  it('classifies sensitive paths and strips secrets from validation environment', () => {
    expect(classifySensitivePath('.env.local')).toMatchObject({ blocked: true });
    expect(classifySensitivePath('package.json')).toMatchObject({ requiresElevation: true });
    const env = minimalValidationEnvironment({ PATH: 'x', GITHUB_TOKEN: 'secret', API_KEY: 'secret' });
    expect(env.PATH).toBe('x');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();
    expect(env.FORGE_NETWORK_POLICY).toBe('network_denied');
  });

  it('serializes workspace lease ownership and recovers stale transaction state', async () => {
    const lease = await WorkspaceMutationLease.acquire(root, 'run-a', 'test', 30_000);
    await expect(WorkspaceMutationLease.acquire(root, 'run-b', 'test', 30_000)).rejects.toThrow('workspace_lease_held');
    await lease.release();
    expect((await WorkspaceMutationLease.peek(root)).state).toBe('free');

    const journal = await TransactionJournal.writePrepared(root, 'tx-1', { paths: ['src/a.ts'] });
    expect(await TransactionJournal.recoveryState(root)).toMatchObject({ state: 'recovery_required' });
    await TransactionJournal.complete(journal);
    expect(await TransactionJournal.recoveryState(root)).toMatchObject({ state: 'clean' });
  });

  it('detects validation side effects outside approved paths', async () => {
    const detector = new ValidationSideEffectDetector(root, ['src/a.ts']);
    await detector.capture();
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'approved\n');
    await fs.writeFile(path.join(root, 'src', 'unexpected.ts'), 'side effect\n');
    expect(await detector.detect()).toEqual(['src/unexpected.ts']);
  });

  it('binds tool and provider identity without trusting localhost alone', () => {
    const tool = bindToolIdentity({ id: 'read', version: '1', descriptor: { a: 1 }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } });
    expect(tool.descriptorHash).toMatch(/^sha256:/);
    expect(bindProviderIdentity('ollama', 'http://localhost:11434', 'qwen').ok).toBe(true);
    expect(bindProviderIdentity('ollama', 'https://example.com', 'qwen')).toMatchObject({ ok: false, reason: 'provider_identity_mismatch' });
  });

  async function git(args: string[]): Promise<void> {
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`)));
    });
  }
});

function baseProposal(operations: CodingProposal['operations']): CodingProposal {
  return {
    version: 1,
    taskSummary: 'test',
    operations,
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    limits: { maxFiles: 12, maxBytesPerFile: 200_000, totalBytes: 0 },
    warnings: [],
    status: 'proposed',
  };
}
