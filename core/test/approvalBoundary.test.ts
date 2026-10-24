import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval, ensureCapabilityAttempt } from '../domain/capabilityDispatch';
import { createApproval, listApprovalsForAttempt } from '../domain/approvals';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import { listRuntimeEventsForAttempt } from '../domain/runtimeEvents';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from '../runtime/governedCapability';
import { CORE_POLICY_ACTOR } from '../runtime/commandPolicy';
import { CoreError } from '../domain/errors';
import type { ApprovalRecord } from '../shared/wireTypes';
import {
  authorizeDesktopTaskScope,
  classifyDesktopApproval,
  describeDesktopTaskScope,
} from '../../apps/desktop/src/host/desktopTaskScope';
import { copyMissingHelperFixture } from './missionFixture';

let dir: string;
let db: CoreDatabase;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-approval-boundary-'));
  workspace = path.join(dir, 'repo');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello\n');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function registry() {
  return new GovernedCapabilityRegistry().register(createWorkspaceCapabilityAdapter());
}

function dispatch(toolName: string, args: Record<string, unknown>, actor = 'core') {
  return dispatchCapability(db, registry(), {
    correlationId: 'boundary-task',
    toolName,
    arguments: args,
    cwd: workspace,
    actor,
    clientId: 'client-1',
  });
}

function decisionFrom(approval: ApprovalRecord, resolution: 'approved' | 'rejected', actor = 'client-1') {
  return {
    approvalId: approval.id,
    resolution,
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor,
    clientId: 'client-1',
    idempotencyKey: `idemp-${approval.id}-${resolution}`,
  };
}

function kdikhaInstall(marker = 'core-policy-denied-should-not-exist'): string {
  return `mkdir C:\\kdikha\\${marker} && cd /d C:\\kdikha\\${marker} && npm init -y && npm install puppeteer-core`;
}

function kdikhaMarkerPath(marker: string): string {
  return path.join('C:\\kdikha', marker);
}

describe('Core is the final approval authority', () => {
  it('rejects a C:\\kdikha install without executing and persists the denial actor and reason', async () => {
    const marker = `core-denied-${Date.now()}`;
    const command = kdikhaInstall(marker);
    const result = await dispatch('run_command', { command }, 'desktop-host');
    expect(result.outcome).toBe('denied');
    if (result.outcome !== 'denied') throw new Error('expected denied');
    expect(result.reason).toMatch(/outside the selected repository|package installation|browser installation/);
    expect(listToolInvocationsForAttempt(db, result.attemptId)).toHaveLength(0);
    expect(fs.existsSync(kdikhaMarkerPath(marker))).toBe(false);

    const approvals = listApprovalsForAttempt(db, result.attemptId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('rejected');
    expect(approvals[0].summary.policyDecision).toBe('denied');
    expect(String(approvals[0].summary.policyReason)).toMatch(/outside|install/);
    expect(approvals[0].summary.toolName).toBe('run_command');
    expect(approvals[0].summary.requestedCommand).toBe(command);

    const events = listRuntimeEventsForAttempt(db, result.attemptId, 50).filter((event) => event.domain === 'approval');
    const resolved = events.find((event) => event.eventType === 'approval_resolved');
    expect(resolved?.actor).toBe(CORE_POLICY_ACTOR);
    expect(resolved?.metadata.policyDecision).toBe('denied');
    expect(String(resolved?.metadata.policyReason)).toMatch(/outside|install/);
    expect(resolved?.metadata.attemptId).toBe(result.attemptId);
    expect(resolved?.metadata.toolName).toBe('run_command');
  });

  it('rejects absolute and parent-directory paths for reads and edits', async () => {
    const absolute = await dispatch('propose_file_change', { path: 'C:\\kdikha\\evil.txt', content: 'nope' });
    expect(absolute.outcome).toBe('denied');
    const parent = await dispatch('read_file', { path: '../secrets.txt' });
    expect(parent.outcome).toBe('denied');
    const nested = await dispatch('propose_file_change', { path: 'src/../../outside.txt', content: 'nope' });
    expect(nested.outcome).toBe('denied');
    expect(listToolInvocationsForAttempt(db, absolute.attemptId)).toHaveLength(0);
  });

  it('rejects npm install, curl, wget, powershell, and browser-install commands', async () => {
    for (const command of [
      'npm install lodash',
      'curl https://example.com',
      'wget https://example.com/pkg.tgz',
      'powershell -Command Get-ChildItem',
      'npx playwright install',
      'git push origin HEAD',
    ]) {
      const result = await dispatch('run_command', { command });
      expect(result.outcome, command).toBe('denied');
    }
  });

  it('rejects a compound command when one segment is unsafe', async () => {
    const result = await dispatch('run_command', { command: 'npm test && npm install puppeteer-core' });
    expect(result.outcome).toBe('denied');
    if (result.outcome === 'denied') expect(result.reason).toMatch(/install/);
  });

  it('still approves in-scope read, edit, test, diff, and local commit', async () => {
    const read = await dispatch('read_file', { path: 'note.txt' });
    expect(read.outcome).toBe('executed');
    if (read.outcome === 'executed') {
      expect(read.toolInvocation.status).toBe('succeeded');
      expect(String(read.toolInvocation.evidence.output)).toContain('hello');
    }

    const edit = await dispatch('propose_file_change', { path: 'note.txt', content: 'hello world\n' });
    expect(edit.outcome).toBe('approval_required');
    if (edit.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(edit.approval, 'approved'));
    const edited = await dispatch('propose_file_change', { path: 'note.txt', content: 'hello world\n' });
    expect(edited.outcome).toBe('executed');
    expect(fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8')).toBe('hello world\n');

    copyMissingHelperFixture(workspace);
    const testRun = await dispatch('run_command', { command: 'npm test' });
    expect(testRun.outcome).toBe('approval_required');
    if (testRun.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(testRun.approval, 'approved'));
    const tested = await dispatch('run_command', { command: 'npm test' });
    expect(tested.outcome).toBe('executed');

    const diff = await dispatch('run_command', { command: 'git diff' });
    expect(diff.outcome).toBe('approval_required');

    execFileSync('git', ['init'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'add', 'note.txt'], { cwd: workspace });
    const commitCmd = 'git -c user.name=test -c user.email=test@local commit -m "in-scope local commit"';
    const commit = await dispatchCapability(db, registry(), {
      correlationId: 'boundary-commit',
      toolName: 'run_command',
      arguments: { command: commitCmd },
      cwd: workspace,
      actor: 'core',
      clientId: 'client-1',
    });
    expect(commit.outcome).toBe('approval_required');
    if (commit.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(commit.approval, 'approved'));
    const committed = await dispatchCapability(db, registry(), {
      correlationId: 'boundary-commit',
      toolName: 'run_command',
      arguments: { command: commitCmd },
      cwd: workspace,
      actor: 'core',
      clientId: 'client-1',
    });
    expect(committed.outcome).toBe('executed');
    if (committed.outcome === 'executed') expect(committed.toolInvocation.status).toBe('succeeded');
  }, 20_000);

  it('does not let a host auto-approval override a Core denial', async () => {
    const marker = `core-host-override-${Date.now()}`;
    const command = kdikhaInstall(marker);
    const hostScope = authorizeDesktopTaskScope(describeDesktopTaskScope(workspace)!);
    const hostDecision = classifyDesktopApproval(hostScope, {
      toolName: 'run_command',
      paths: [],
      scope: `run_command ${command}`,
      detail: command,
    });
    expect(hostDecision).toBe('prompt');

    const attemptId = ensureCapabilityAttempt(db, {
      correlationId: 'legacy-client',
      actor: 'desktop-host',
      clientId: 'client-1',
    });
    const injected = createApproval(db, {
      attemptId,
      kind: 'mutation',
      summary: {
        toolName: 'run_command',
        arguments: { command },
        requestedCommand: command,
        workspaceRoot: workspace,
      },
      actor: 'desktop-host',
      clientId: 'client-1',
    });
    expect(injected.status).toBe('pending');

    expect(() => resolveCapabilityApproval(db, decisionFrom(injected, 'approved', 'desktop-host'))).toThrow(CoreError);
    const after = listApprovalsForAttempt(db, attemptId).find((row) => row.id === injected.id);
    expect(after?.status).toBe('rejected');
    expect(after?.resolution).toBe('rejected');

    const events = listRuntimeEventsForAttempt(db, attemptId, 50).filter((event) => event.eventType === 'approval_resolved');
    expect(events[0]?.actor).toBe(CORE_POLICY_ACTOR);
    expect(events[0]?.metadata.requestedActor).toBe('desktop-host');
    expect(events[0]?.metadata.policyDecision).toBe('denied');

    const retried = await dispatchCapability(db, registry(), {
      correlationId: 'legacy-client',
      toolName: 'run_command',
      arguments: { command },
      cwd: workspace,
      actor: 'desktop-host',
      clientId: 'client-1',
    });
    expect(retried.outcome).toBe('denied');
    expect(listToolInvocationsForAttempt(db, attemptId)).toHaveLength(0);
    expect(fs.existsSync(kdikhaMarkerPath(marker))).toBe(false);
  });
});
