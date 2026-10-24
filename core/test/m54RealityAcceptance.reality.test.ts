import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { CoreToolRunner } from '../runtime/toolRunner';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';
import { runHardenedGit, hardenedGitArgs, hardenedGitEnv } from '../security/hardenedGit';
import { checkArchitectureGuard } from '../security/architectureGuard';
import { deriveRequestPrincipal } from '../api/server';
import type { CapabilityRequest, ExecutionGrant } from '../security/types';

function createApprovedGrant(
  kernel: LocalAutonomySecurityKernel,
  db: CoreDatabase,
  req: CapabilityRequest,
  options?: { ttlMs?: number },
): ExecutionGrant {
  const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.run('PRAGMA foreign_keys = OFF');
  db.run(
    `INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary)
     VALUES (?, ?, 'mutation', 'resolved', ?, ?, 'approved', ?)`,
    [approvalId, req.attemptId, now, now, JSON.stringify({ requestedCommand: req.command })],
  );
  db.run('PRAGMA foreign_keys = ON');

  const decision = kernel.authorize(req, { approvalId, ttlMs: options?.ttlMs });
  if (decision.decision !== 'ALLOW' || !decision.grant) {
    throw new Error(`Failed to authorize grant: ${decision.reason}`);
  }
  return decision.grant;
}

describe('M54-A0 Reality Acceptance Test Suite', () => {
  let tmpDir: string;
  let db: CoreDatabase;
  let kernel: LocalAutonomySecurityKernel;
  let runner: CoreToolRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-m54a0-reality-'));
    db = openDatabase(path.join(tmpDir, 'reality.db'));
    runMigrations(db);
    kernel = new LocalAutonomySecurityKernel(db, 'reality-secret-32-bytes-secure!!');
    LocalAutonomySecurityKernel.setInstance(kernel);
    runner = new CoreToolRunner(15_000);
  });

  afterEach(() => {
    try {
      LocalAutonomySecurityKernel.setInstance(null);
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // =========================================================================
  // REALITY TEST A: Child Environment Canary
  // =========================================================================
  it('Reality A: Child environment canary prevents child from reading parent secrets', async () => {
    // Inject synthetic canary credentials into parent process.env
    const CANARY_SECRET_1 = 'karkedikha_canary_super_secret_auth_token_9999';
    const CANARY_SECRET_2 = 'ghp_syntheticGitHubPersonalAccessToken1234567890'; // gitleaks:allow
    const CANARY_SECRET_3 = 'sk-google-synthetic-provider-api-key-abcdef';

    process.env.KARKEDIKHA_CORE_TOKEN = CANARY_SECRET_1;
    process.env.GITHUB_TOKEN = CANARY_SECRET_2;
    process.env.GOOGLE_API_KEY = CANARY_SECRET_3;

    try {
      const sanitized = createSanitizedChildEnvironment();
      expect(sanitized.KARKEDIKHA_CORE_TOKEN).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.GOOGLE_API_KEY).toBeUndefined();

      // Spawn real command through CoreToolRunner
      const req = kernel.normalizeRequest({
        attemptId: 'att_canary',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'node -e "console.log(JSON.stringify({ c1: process.env.KARKEDIKHA_CORE_TOKEN, c2: process.env.GITHUB_TOKEN, c3: process.env.GOOGLE_API_KEY }))"',
        arguments: { command: 'node -e "console.log(JSON.stringify({ c1: process.env.KARKEDIKHA_CORE_TOKEN, c2: process.env.GITHUB_TOKEN, c3: process.env.GOOGLE_API_KEY }))"' },
        riskLevel: 'consequential',
      });
      const grant = createApprovedGrant(kernel, db, req);

      const result = await runner.run(
        {
          name: 'run_command',
          arguments: {
            command: 'node -e "console.log(JSON.stringify({ c1: process.env.KARKEDIKHA_CORE_TOKEN, c2: process.env.GITHUB_TOKEN, c3: process.env.GOOGLE_API_KEY }))"',
          },
        },
        { cwd: tmpDir, securityGrant: grant, securityKernel: kernel },
      );

      expect(result.status).toBe('succeeded');
      expect(result.output).not.toContain(CANARY_SECRET_1);
      expect(result.output).not.toContain(CANARY_SECRET_2);
      expect(result.output).not.toContain(CANARY_SECRET_3);

      const parsed = JSON.parse(result.output.trim());
      expect(parsed.c1).toBeUndefined();
      expect(parsed.c2).toBeUndefined();
      expect(parsed.c3).toBeUndefined();
    } finally {
      delete process.env.KARKEDIKHA_CORE_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GOOGLE_API_KEY;
    }
  });

  // =========================================================================
  // REALITY TEST B: Principal Spoofing
  // =========================================================================
  it('Reality B: Caller-supplied role headers carry ZERO authority', () => {
    const operatorSecret = 'real-operator-token-secret-123';
    const hostSecret = 'real-host-token-secret-456';
    const clientSecret = 'standard-agent-bearer-token-789';

    // 1. Attacker sends x-caller-type: operator with standard bearer token
    const fakeOperatorReq = {
      headers: {
        authorization: `Bearer ${clientSecret}`,
        'x-caller-type': 'operator',
        'x-principal-type': 'host_operator',
      },
    } as any;

    const principal1 = deriveRequestPrincipal(fakeOperatorReq, clientSecret, operatorSecret, hostSecret, 'client-attacker');
    expect(principal1.role).toBe('agent_client');
    expect(principal1.isTrustedOperator).toBe(false);
    expect(principal1.isTrustedHost).toBe(false);

    // 2. Attacker sends fake x-caller-type without valid token
    const unauthenticatedReq = {
      headers: {
        'x-caller-type': 'operator',
      },
    } as any;

    const principal2 = deriveRequestPrincipal(unauthenticatedReq, clientSecret, operatorSecret, hostSecret, 'unknown');
    expect(principal2.role).toBe('unknown');
    expect(principal2.isTrustedOperator).toBe(false);

    // 3. Genuine operator credential succeeds
    const genuineOperatorReq = {
      headers: {
        'x-operator-token': operatorSecret,
      },
    } as any;

    const principal3 = deriveRequestPrincipal(genuineOperatorReq, clientSecret, operatorSecret, hostSecret, 'operator-client');
    expect(principal3.role).toBe('host_operator');
    expect(principal3.isTrustedOperator).toBe(true);
    expect(principal3.isTrustedHost).toBe(true);
  });

  // =========================================================================
  // REALITY TEST C: Self-Approval Rejection
  // =========================================================================
  it('Reality C: Requester cannot self-approve; kernel decides with DB evidence', () => {
    const req = kernel.normalizeRequest({
      attemptId: 'att_self_appr',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'npm test',
      arguments: { command: 'npm test' },
      riskLevel: 'consequential',
    });

    // Caller passes isApproved: true to evaluate -> zero authority
    const evalDecision = (kernel as any).evaluate(req, { isApproved: true });
    expect(evalDecision.decision).toBe('REQUIRE_APPROVAL');
    expect(evalDecision.grant).toBeUndefined();

    // Caller invokes authorize without approval -> zero authority
    const authNoEvidence = kernel.authorize(req);
    expect(authNoEvidence.decision).toBe('REQUIRE_APPROVAL');
    expect(authNoEvidence.grant).toBeUndefined();

    // Caller invokes authorize with unapproved / fake approvalId -> DENY
    const authFake = kernel.authorize(req, { approvalId: 'bogus_fake_id' });
    expect(authFake.decision).toBe('DENY');
    expect(authFake.grant).toBeUndefined();

    // Only genuine resolved approval in DB produces a grant
    const validGrant = createApprovedGrant(kernel, db, req);
    expect(validGrant).toBeDefined();
    expect(validGrant.grantId).toMatch(/^grant_/);
  });

  // =========================================================================
  // REALITY TEST D: Fresh DB Creation & Persistence
  // =========================================================================
  it('Reality D: Fresh database creates all security tables and persists across reopen', () => {
    const freshDbPath = path.join(tmpDir, 'fresh.db');
    const db1 = openDatabase(freshDbPath);
    runMigrations(db1);

    const tables = db1.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    expect(tables).toContain('execution_grants');
    expect(tables).toContain('security_events');
    expect(tables).toContain('security_safe_mode');

    // Verify indexes exist
    const indexes = db1.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
    expect(indexes).toContain('idx_execution_grants_epoch');
    expect(indexes).toContain('idx_security_events_epoch');

    // Insert a test event and grant
    const kernel1 = new LocalAutonomySecurityKernel(db1, 'test-key', 'epoch_test_1');
    kernel1.getJournal().record({
      eventType: 'SAFE_MODE_ENTERED',
      payload: { reason: 'durability test' },
    });

    db1.close();

    // Reopen DB and verify persistence
    const db2 = openDatabase(freshDbPath);
    const events = db2.all<{ id: string; eventType: string }>('SELECT id, eventType FROM security_events');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].eventType).toBe('SAFE_MODE_ENTERED');
    db2.close();
  });

  // =========================================================================
  // REALITY TEST E: Kernel-without-DB Fails Closed in Production
  // =========================================================================
  it('Reality E: Kernel without DB fails closed in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    LocalAutonomySecurityKernel.setInstance(null);

    try {
      expect(() => {
        LocalAutonomySecurityKernel.getInstance(null);
      }).toThrow(/SecurityKernel initialization violation/);
    } finally {
      process.env.NODE_ENV = originalEnv;
      LocalAutonomySecurityKernel.setInstance(kernel);
    }
  });

  // =========================================================================
  // REALITY TEST F: Concurrent Replay CAS (10 simultaneous consumers -> 1 succeeds)
  // =========================================================================
  it('Reality F: 10 concurrent consumers of ONE grant result in exactly 1 success and 9 replay rejections', async () => {
    const req = kernel.normalizeRequest({
      attemptId: 'att_concurrency',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo concurrent',
      arguments: { command: 'echo concurrent' },
      riskLevel: 'consequential',
    });

    const grant = createApprovedGrant(kernel, db, req);

    // Launch 10 simultaneous attempts to consume the EXACT same grant
    const attempts = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() =>
        kernel.verifyAndConsumeGrant(grant, {
          attemptId: 'att_concurrency',
          networkScope: { allowNetwork: false },
          executor: 'core:tool_runner',
          capability: 'process',
          workspaceRoot: tmpDir,
          targetResource: tmpDir,
          command: 'echo concurrent',
          arguments: { command: 'echo concurrent' },
        }),
      ),
    );

    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(9);
    for (const failure of failures) {
      expect(failure.eventType).toBe('GRANT_REPLAY_ATTEMPT');
    }
  });

  // =========================================================================
  // REALITY TEST G: SAFE_MODE Permanent Revocation
  // =========================================================================
  it('Reality G: SAFE_MODE permanently revokes grant across exit and DB reopen', () => {
    const req = kernel.normalizeRequest({
      attemptId: 'att_perm_revocation',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo safe',
      arguments: { command: 'echo safe' },
      riskLevel: 'consequential',
    });

    const grant = createApprovedGrant(kernel, db, req);

    // 1. Enter SAFE_MODE
    kernel.getSafeModeManager().enterSafeMode({
      reason: 'Adversarial containment',
      actor: 'operator:admin',
    });

    // 2. Grant must be rejected while safe mode is active
    const check1 = kernel.verifyAndConsumeGrant(grant, {
      attemptId: 'att_perm_revocation',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo safe',
      arguments: { command: 'echo safe' },
      networkScope: { allowNetwork: false },
    });
    expect(check1.ok).toBe(false);

    // 3. Exit SAFE_MODE
    kernel.getSafeModeManager().exitSafeMode({
      reason: 'Operator resume',
      actor: 'operator:admin',
    });
    expect(kernel.isSafeModeActive()).toBe(false);

    // 4. Grant must REMAIN INVALID forever even though safe mode has exited!
    const check2 = kernel.verifyAndConsumeGrant(grant, {
      attemptId: 'att_perm_revocation',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo safe',
      arguments: { command: 'echo safe' },
      networkScope: { allowNetwork: false },
    });
    expect(check2.ok).toBe(false);
    expect(check2.reason).toContain('revoked');

    // 5. Close DB, reopen, and verify grant remains permanently revoked
    db.close();
    const reopenedDb = openDatabase(path.join(tmpDir, 'reality.db'));
    const kernelReopened = new LocalAutonomySecurityKernel(reopenedDb, 'reality-secret-32-bytes-secure!!', kernel.epoch);

    const check3 = kernelReopened.verifyAndConsumeGrant(grant, {
      attemptId: 'att_perm_revocation',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo safe',
      arguments: { command: 'echo safe' },
      networkScope: { allowNetwork: false },
    });
    expect(check3.ok).toBe(false);
    expect(check3.reason).toContain('revoked');

    reopenedDb.close();
    // Re-open for afterEach
    db = openDatabase(path.join(tmpDir, 'reality.db'));
  });

  // =========================================================================
  // REALITY TEST H: Epoch / Restart Invalidation
  // =========================================================================
  it('Reality H: Execution grants die across runtime restart / epoch change', () => {
    const epoch1 = 'epoch_instance_1_alpha';
    const epoch2 = 'epoch_instance_2_beta';

    const kernel1 = new LocalAutonomySecurityKernel(db, 'secret-key-1', epoch1);
    const req = kernel1.normalizeRequest({
      attemptId: 'att_restart',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo restart',
      arguments: { command: 'echo restart' },
      riskLevel: 'consequential',
    });

    const grantEpoch1 = createApprovedGrant(kernel1, db, req);
    expect(grantEpoch1.epoch).toBe(epoch1);

    // Simulate restart with new epoch
    const kernel2 = new LocalAutonomySecurityKernel(db, 'secret-key-1', epoch2);

    const result = kernel2.verifyAndConsumeGrant(grantEpoch1, {
      attemptId: 'att_restart',
      executor: 'core:tool_runner',
      capability: 'process',
      workspaceRoot: tmpDir,
      targetResource: tmpDir,
      command: 'echo restart',
      arguments: { command: 'echo restart' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('previous security epoch (stale across restart)');
    expect(result.eventType).toBe('GRANT_REJECTED');
  });

  // =========================================================================
  // REALITY TEST I: Real Process Spawning & Tracked Termination
  // =========================================================================
  it('Reality I: Real background process is tracked and terminated upon entering SAFE_MODE', async () => {
    // Spawn a real long-running node worker
    const child = child_process.spawn(
      'node',
      ['-e', 'setInterval(() => {}, 1000);'],
      { stdio: 'ignore' },
    );

    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    let killCallbackInvoked = false;
    kernel.getSafeModeManager().registerChildProcess(
      pid,
      () => {
        killCallbackInvoked = true;
        try {
          process.kill(pid);
        } catch {
          // ignore
        }
      },
      'node-worker',
      'att_worker_reality',
    );

    expect(kernel.getSafeModeManager().listTrackedProcesses().length).toBe(1);

    // Enter SAFE_MODE
    kernel.getSafeModeManager().enterSafeMode({
      reason: 'Reality kill-switch test',
      actor: 'operator:admin',
    });

    expect(killCallbackInvoked).toBe(true);
    expect(kernel.getSafeModeManager().listTrackedProcesses().length).toBe(0);

    // Give OS 100ms to clean up
    await new Promise((r) => setTimeout(r, 100));

    // Verify process is terminated
    let isAlive = true;
    try {
      // process.kill with signal 0 checks for process existence
      process.kill(pid, 0);
    } catch {
      isAlive = false;
    }
    expect(isAlive).toBe(false);
  });

  // =========================================================================
  // REALITY TEST J: Architecture Guard (Zero Unauthorized Process Spawns)
  // =========================================================================
  it('Reality J: Static architecture guard verifies zero unauthorized child_process imports', () => {
    const report = checkArchitectureGuard();
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  // =========================================================================
  // REALITY TEST K: Malicious Git Config Hardening
  // =========================================================================
  it('Reality K: Host hardened Git ignores planted hooks, fsmonitor, and external diff', () => {
    const gitRepoDir = fs.mkdtempSync(path.join(tmpDir, 'malicious-repo-'));
    const plantedMarker = path.join(gitRepoDir, 'pwned.marker');

    try {
      // 1. Initialize git repo
      child_process.execSync('git init', { cwd: gitRepoDir, stdio: 'ignore' });

      // 2. Plant malicious core.fsmonitor pointing to a malicious script
      const maliciousScript = path.join(gitRepoDir, 'malicious_fsmonitor.bat');
      fs.writeFileSync(maliciousScript, `@echo off\necho pwned > "${plantedMarker}"\nexit 1\n`, 'utf8');

      // Set malicious config directly in local repo .git/config
      child_process.execSync(`git config core.fsmonitor "${maliciousScript.replace(/\\/g, '/')}"`, { cwd: gitRepoDir, stdio: 'ignore' });
      child_process.execSync(`git config core.hooksPath "${gitRepoDir.replace(/\\/g, '/')}"`, { cwd: gitRepoDir, stdio: 'ignore' });
      child_process.execSync(`git config diff.external "${maliciousScript.replace(/\\/g, '/')}"`, { cwd: gitRepoDir, stdio: 'ignore' });

      // 3. Run hardened git command
      const statusResult = runHardenedGit(['status', '--porcelain'], { cwd: gitRepoDir });
      expect(statusResult.status).toBe(0);

      // 4. Verify that the planted malicious script was NEVER executed!
      expect(fs.existsSync(plantedMarker)).toBe(false);
    } finally {
      fs.rmSync(gitRepoDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // REALITY TEST L: Credential Inheritance Exclusion
  // =========================================================================
  it('Reality L: Child process environment excludes cloud, OAuth, and provider credentials', () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-access-key-canary';
    process.env.OPENAI_API_KEY = 'sk-openai-api-key-canary';
    process.env.ANTHROPIC_API_KEY = 'ant-api-key-canary';
    process.env.DATABASE_PASSWORD = 'super-secret-db-password';
    process.env.KARKEDIKHA_OPERATOR_SECRET = 'op-secret-canary';

    try {
      const childEnv = createSanitizedChildEnvironment();

      expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(childEnv.OPENAI_API_KEY).toBeUndefined();
      expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(childEnv.DATABASE_PASSWORD).toBeUndefined();
      expect(childEnv.KARKEDIKHA_OPERATOR_SECRET).toBeUndefined();

      // Only safe toolchain variables should be preserved
      if (process.env.PATH) {
        expect(childEnv.PATH).toBeDefined();
      }
      if (process.platform === 'win32') {
        const sysRoot = childEnv.SystemRoot ?? childEnv.SYSTEMROOT ?? childEnv.windir;
        expect(sysRoot).toBeDefined();
      }
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.DATABASE_PASSWORD;
      delete process.env.KARKEDIKHA_OPERATOR_SECRET;
    }
  });
});
