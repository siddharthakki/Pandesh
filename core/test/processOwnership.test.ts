import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProcessOwnershipBoundary,
  createProcessOwnershipLedger,
  verifyProcessOwnership,
  type OwnershipProvenance,
  type ProcessIdentitySnapshot,
} from '../runtime/processOwnership';

const OWNER = 'owner-token-1';

function identity(overrides: Partial<ProcessIdentitySnapshot> = {}): ProcessIdentitySnapshot {
  return {
    pid: 4242,
    alive: true,
    executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
    creationTimeMs: 1_700_000_000_000,
    commandLine: 'node.exe core.js',
    ...overrides,
  };
}

function provenance(overrides: Partial<OwnershipProvenance> = {}): OwnershipProvenance {
  return {
    pid: 4242,
    ownerToken: OWNER,
    creationTimeMs: 1_700_000_000_000,
    spawnedAtMs: 1_700_000_000_000,
    executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
    recordedAt: '2026-10-24T00:00:00.000Z',
    source: 'test',
    ...overrides,
  };
}

describe('Process ownership verification boundary', () => {
  it('verifies a process whose identity, creation time, executable and provenance all match', () => {
    const verdict = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      identity: identity(),
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.code).toBe('verified');
  });

  it('refuses when there is no ownership provenance at all', () => {
    const verdict = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\x\\node.exe' },
      identity: identity(),
      provenance: null,
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('provenance_missing');
  });

  it('refuses when the provenance belongs to a different owner', () => {
    const verdict = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\x\\node.exe' },
      identity: identity(),
      provenance: provenance({ ownerToken: 'someone-else' }),
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('provenance_mismatch');
  });

  it('treats missing identity information as a refusal, never as permission', () => {
    const noIdentity = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\x\\node.exe' },
      identity: null,
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(noIdentity.verified).toBe(false);
    expect(noIdentity.code).toBe('identity_unavailable');

    const noCreationTime = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\x\\node.exe' },
      identity: identity({ creationTimeMs: null }),
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(noCreationTime.verified).toBe(false);
    expect(noCreationTime.code).toBe('identity_unavailable');

    const noExecutable = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\x\\node.exe' },
      identity: identity({ executablePath: null }),
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(noExecutable.verified).toBe(false);
    expect(noExecutable.code).toBe('identity_unavailable');
  });

  it('refuses a recycled pid whose creation time no longer matches', () => {
    const verdict = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      identity: identity({ creationTimeMs: 1_700_000_900_000 }),
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('pid_reused');
  });

  it('refuses when the pid now runs a different executable', () => {
    const verdict = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      identity: identity({ executablePath: 'C:\\Users\\siddh\\dev\\server.exe' }),
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('executable_mismatch');
  });

  it('refuses when the executable lives outside the allowed roots', () => {
    const verdict = verifyProcessOwnership({
      expectation: {
        pid: 4242,
        creationTimeMs: 1_700_000_000_000,
        executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
        allowedExecutableRoots: ['C:\\Program Files\\Pandesh'],
      },
      identity: identity({ executablePath: 'C:\\Windows\\System32\\cmd.exe' }),
      provenance: provenance(),
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('outside_allowed_root');
  });

  it('uses the spawn window when no exact creation time was recorded', () => {
    const inside = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: null, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      identity: identity({ creationTimeMs: 1_700_000_003_000 }),
      provenance: provenance({ creationTimeMs: null, spawnedAtMs: 1_700_000_000_000 }),
      currentOwnerToken: OWNER,
    });
    expect(inside.verified).toBe(true);

    const outside = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: null, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      identity: identity({ creationTimeMs: 1_700_000_900_000 }),
      provenance: provenance({ creationTimeMs: null, spawnedAtMs: 1_700_000_000_000 }),
      currentOwnerToken: OWNER,
    });
    expect(outside.verified).toBe(false);
    expect(outside.code).toBe('pid_reused');
  });

  it('refuses when neither a creation time nor a spawn window was recorded', () => {
    const verdict = verifyProcessOwnership({
      expectation: { pid: 4242, creationTimeMs: null, executablePath: 'C:\\x\\node.exe' },
      identity: identity(),
      provenance: provenance({ creationTimeMs: null, spawnedAtMs: null }),
      currentOwnerToken: OWNER,
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.code).toBe('identity_unavailable');
  });
});

describe('Process ownership ledger', () => {
  function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'own-')); }

  it('persists provenance across holders and can drop it again', () => {
    const dir = tmpDir();
    const ledger = createProcessOwnershipLedger({ dataDir: dir });
    ledger.record(provenance());
    const other = createProcessOwnershipLedger({ dataDir: dir });
    expect(other.get(4242)?.ownerToken).toBe(OWNER);
    other.remove(4242);
    expect(createProcessOwnershipLedger({ dataDir: dir }).get(4242)).toBeNull();
  });

  it('treats an unreadable ledger as empty, so nothing can be owned', () => {
    const dir = tmpDir();
    const ledger = createProcessOwnershipLedger({
      dataDir: dir,
      existsFn: () => true,
      readFileFn: () => 'not json',
    });
    expect(ledger.get(4242)).toBeNull();
  });
});

describe('Process ownership boundary termination', () => {
  function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'own-b-')); }

  it('kills a process only after ownership is proven', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const boundary = createProcessOwnershipBoundary({
      dataDir: dir,
      ownerToken: OWNER,
      identityProvider: async () => identity(),
    });
    boundary.recordLaunch({
      pid: 4242,
      creationTimeMs: 1_700_000_000_000,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      source: 'test',
    });
    const result = await boundary.terminate({
      pid: 4242,
      expectation: { creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      killFn,
    });
    expect(result.terminated).toBe(true);
    expect(killFn).toHaveBeenCalledWith(4242);
  });

  it('never calls the kill function for a process it cannot prove it owns', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const boundary = createProcessOwnershipBoundary({
      dataDir: dir,
      ownerToken: OWNER,
      identityProvider: async () => identity(),
    });
    // No provenance recorded: Pandesh never started this process.
    const result = await boundary.terminate({ pid: 4242, killFn });
    expect(result.terminated).toBe(false);
    expect(result.verdict.code).toBe('provenance_missing');
    expect(killFn).not.toHaveBeenCalled();
  });

  it('never calls the kill function when the pid was recycled', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const boundary = createProcessOwnershipBoundary({
      dataDir: dir,
      ownerToken: OWNER,
      identityProvider: async () => identity({ creationTimeMs: 1_700_000_900_000 }),
    });
    boundary.recordLaunch({
      pid: 4242,
      creationTimeMs: 1_700_000_000_000,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      source: 'test',
    });
    const result = await boundary.terminate({
      pid: 4242,
      expectation: { creationTimeMs: 1_700_000_000_000, executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' },
      killFn,
    });
    expect(result.terminated).toBe(false);
    expect(result.verdict.code).toBe('pid_reused');
    expect(killFn).not.toHaveBeenCalled();
  });

  it('never calls the kill function when the identity cannot be read', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const boundary = createProcessOwnershipBoundary({
      dataDir: dir,
      ownerToken: OWNER,
      identityProvider: async () => ({ pid: 4242, alive: false, executablePath: null, creationTimeMs: null, commandLine: null }),
    });
    boundary.recordLaunch({
      pid: 4242,
      creationTimeMs: 1_700_000_000_000,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      source: 'test',
    });
    const result = await boundary.terminate({ pid: 4242, killFn });
    expect(result.terminated).toBe(false);
    // The OS either says the process is gone or refuses to disclose it.
    // Both are refusals, and neither one authorizes a kill.
    expect(['not_alive', 'identity_unavailable']).toContain(result.verdict.code);
    expect(killFn).not.toHaveBeenCalled();
  });
});
