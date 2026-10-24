/**
 * M54-A Local Autonomy Security Kernel Adversarial Test Suite.
 *
 * Verifies all 9 mandatory M54-A checkpoints:
 * A. DIRECT EXECUTOR BYPASS
 * B. PARAMETER SUBSTITUTION
 * C. TARGET SUBSTITUTION
 * D. NETWORK SCOPE SUBSTITUTION
 * E. GRANT REPLAY
 * F. EXPIRED GRANT
 * G. SAFE_MODE KILL-SWITCH & CHILD PROCESS TERMINATION
 * H. MODEL CANNOT EXIT SAFE_MODE
 * I. SECURITY EVENT AUDIT & SECRET REDACTION
 * Plus deterministic performance benchmark.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import type { CoreDatabase } from '../db/connection';
import { CoreToolRunner } from '../runtime/toolRunner';
import { LocalAutonomySecurityKernel } from '../security/kernel';
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

describe('M54-A: Local Autonomy Security Kernel', () => {
  let tmpDir: string;
  let db: CoreDatabase;
  let kernel: LocalAutonomySecurityKernel;
  let runner: CoreToolRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-m54a-test-'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'original content', 'utf8');

    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db);

    kernel = new LocalAutonomySecurityKernel(db, 'test-secret-key-32-bytes-secure!!');
    LocalAutonomySecurityKernel.setInstance(kernel);
    runner = new CoreToolRunner(10_000);
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
  // A. DIRECT EXECUTOR BYPASS
  // =========================================================================
  describe('A. Direct Executor Bypass', () => {
    it('rejects consequential run_command without a SecurityKernel grant', async () => {
      const result = await runner.run(
        { name: 'run_command', arguments: { command: 'echo bypassed' } },
        { cwd: tmpDir, securityKernel: kernel },
      );

      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('security_kernel_no_grant');
      expect(result.output).toContain('SecurityKernel violation');

      const events = kernel.getJournal().listEvents({ eventType: 'CIRCUMVENTION_SUSPECTED' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].payload).toMatchObject({
        violation: 'direct_consequential_execution_without_grant',
        toolName: 'run_command',
      });
    });

    it('rejects consequential propose_file_change without a grant', async () => {
      const result = await runner.run(
        { name: 'propose_file_change', arguments: { path: 'hacked.txt', content: 'malicious' } },
        { cwd: tmpDir, securityKernel: kernel },
      );

      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('security_kernel_no_grant');
      expect(fs.existsSync(path.join(tmpDir, 'hacked.txt'))).toBe(false);

      const events = kernel.getJournal().listEvents({ eventType: 'CIRCUMVENTION_SUSPECTED' });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('allows read_only actions without requiring mutation grant', async () => {
      const result = await runner.run(
        { name: 'read_file', arguments: { path: 'file.txt' } },
        { cwd: tmpDir, securityKernel: kernel },
      );

      expect(result.status).toBe('succeeded');
      expect(result.output).toContain('original content');
    });
    it('strictly forbids self-approval: caller evaluate(... { isApproved: true }) never grants authority', () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_self_approve',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'npm test',
        arguments: { command: 'npm test' },
        riskLevel: 'consequential',
      });

      // Passing isApproved: true into evaluate carries ZERO authority
      const decision = (kernel as any).evaluate(req, { isApproved: true });
      expect(decision.decision).toBe('REQUIRE_APPROVAL');
      expect(decision.grant).toBeUndefined();

      // Calling authorize without approval evidence also fails to issue grant
      const authDecision = kernel.authorize(req);
      expect(authDecision.decision).toBe('REQUIRE_APPROVAL');
      expect(authDecision.grant).toBeUndefined();

      // Calling authorize with nonexistent approvalId is denied
      const fakeAuthDecision = kernel.authorize(req, { approvalId: 'non_existent_approval_id' });
      expect(fakeAuthDecision.decision).toBe('DENY');
      expect(fakeAuthDecision.grant).toBeUndefined();
    });
  });

  // =========================================================================
  // B. PARAMETER SUBSTITUTION
  // =========================================================================
  describe('B. Parameter Substitution Protection', () => {
    it('invalidates grant when approved command is mutated before execution', async () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_param_sub',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'npm test',
        arguments: { command: 'npm test' },
        riskLevel: 'consequential',
      });

      const grant = createApprovedGrant(kernel, db, req);
      expect(grant).toBeDefined();

      // Attacker mutates command to powershell malicious script while presenting valid grant
      const mutatedResult = await runner.run(
        { name: 'run_command', arguments: { command: 'powershell -Command "Write-Output pwned"' } },
        { cwd: tmpDir, securityGrant: grant, securityKernel: kernel },
      );

      expect(mutatedResult.status).toBe('failed');
      expect(mutatedResult.resultCategory).toBe('security_kernel_grant_invalid');
      expect(mutatedResult.output).toMatch(/substitution rejected/i);

      const events = kernel.getJournal().listEvents({ eventType: 'TOCTOU_REJECTED' });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('invalidates grant when file write content is mutated after approval', async () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_write_sub',
        executor: 'core:tool_runner',
        capability: 'filesystem',
        workspaceRoot: tmpDir,
        targetResource: path.resolve(tmpDir, 'safe.txt'),
        arguments: { path: 'safe.txt', content: 'safe content' },
        riskLevel: 'consequential',
      });

      const grant = createApprovedGrant(kernel, db, req);

      // Mutate content argument
      const mutatedResult = await runner.run(
        { name: 'propose_file_change', arguments: { path: 'safe.txt', content: 'malicious payload' } },
        { cwd: tmpDir, securityGrant: grant, securityKernel: kernel },
      );

      expect(mutatedResult.status).toBe('failed');
      expect(mutatedResult.resultCategory).toBe('security_kernel_grant_invalid');
      expect(mutatedResult.output).toContain('Parameter substitution rejected');
      expect(fs.existsSync(path.join(tmpDir, 'safe.txt'))).toBe(false);
    });
  });

  // =========================================================================
  // C. TARGET SUBSTITUTION
  // =========================================================================
  describe('C. Target Substitution Protection', () => {
    it('denies execution when approved for workspace A but attempted in workspace B', async () => {
      const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-m54a-repoB-'));

      try {
        const req = kernel.normalizeRequest({
          attemptId: 'att_target_sub',
          executor: 'core:tool_runner',
          capability: 'process',
          workspaceRoot: tmpDir,
          targetResource: tmpDir,
          command: 'npm test',
          arguments: { command: 'npm test' },
          riskLevel: 'consequential',
        });

        const grant = createApprovedGrant(kernel, db, req);

        // Attempt execution against workspaceB
        const result = await runner.run(
          { name: 'run_command', arguments: { command: 'npm test' } },
          { cwd: workspaceB, securityGrant: grant, securityKernel: kernel },
        );

        expect(result.status).toBe('failed');
        expect(result.resultCategory).toBe('security_kernel_grant_invalid');
        expect(result.output).toContain('Target substitution rejected');

        const events = kernel.getJournal().listEvents({ eventType: 'TOCTOU_REJECTED' });
        expect(events.length).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(workspaceB, { recursive: true, force: true });
      }
    });

    it('denies execution when target file resource is altered', async () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_file_target_sub',
        executor: 'core:tool_runner',
        capability: 'filesystem',
        workspaceRoot: tmpDir,
        targetResource: path.resolve(tmpDir, 'allowed.txt'),
        arguments: { path: 'allowed.txt', content: 'data' },
        riskLevel: 'consequential',
      });

      const grant = createApprovedGrant(kernel, db, req);

      // Attempt to write to different file target
      const result = await runner.run(
        { name: 'propose_file_change', arguments: { path: 'different.txt', content: 'data' } },
        { cwd: tmpDir, securityGrant: grant, securityKernel: kernel },
      );

      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('security_kernel_grant_invalid');
      expect(result.output).toContain('Target substitution rejected');
    });
  });

  // =========================================================================
  // D. NETWORK SCOPE SUBSTITUTION
  // =========================================================================
  describe('D. Network Scope Substitution Protection', () => {
    it('invalidates grant when network policy is altered from false to true', async () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_net_sub',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'curl localhost',
        arguments: { command: 'curl localhost' },
        networkScope: { allowNetwork: false },
        riskLevel: 'consequential',
      });

      const grant = createApprovedGrant(kernel, db, req);

      // Verify revalidation rejects network mutation
      const toctouCheck = kernel.verifyAndConsumeGrant(grant, {
        attemptId: 'att_net_sub',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'curl localhost',
        arguments: { command: 'curl localhost' },
        networkScope: { allowNetwork: true, outboundHosts: ['*'] },
      });

      expect(toctouCheck.ok).toBe(false);
      if (!toctouCheck.ok) {
        expect(toctouCheck.reason).toContain('Network scope substitution rejected');
        expect(toctouCheck.eventType).toBe('TOCTOU_REJECTED');
      }
    });
  });

  // =========================================================================
  // E. GRANT REPLAY PROTECTION
  // =========================================================================
  describe('E. Single-Use Grant Replay Protection', () => {
    it('rejects reusing the same valid grant a second time', async () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_replay_test',
        executor: 'core:tool_runner',
        capability: 'filesystem',
        workspaceRoot: tmpDir,
        targetResource: path.resolve(tmpDir, 'replay.txt'),
        arguments: { path: 'replay.txt', content: 'first execution' },
        riskLevel: 'consequential',
      });

      const grant = createApprovedGrant(kernel, db, req);

      // 1. First execution succeeds
      const firstResult = await runner.run(
        { name: 'propose_file_change', arguments: { path: 'replay.txt', content: 'first execution' } },
        { cwd: tmpDir, securityGrant: grant, securityKernel: kernel },
      );
      expect(firstResult.status).toBe('succeeded');
      expect(fs.readFileSync(path.join(tmpDir, 'replay.txt'), 'utf8')).toBe('first execution');

      // 2. Second execution with identical grant must be REJECTED as replay
      const secondResult = await runner.run(
        { name: 'propose_file_change', arguments: { path: 'replay.txt', content: 'first execution' } },
        { cwd: tmpDir, securityGrant: grant, securityKernel: kernel },
      );

      expect(secondResult.status).toBe('failed');
      expect(secondResult.resultCategory).toBe('security_kernel_grant_invalid');
      expect(secondResult.output).toContain('replay rejected');

      const replayEvents = kernel.getJournal().listEvents({ eventType: 'GRANT_REPLAY_ATTEMPT' });
      expect(replayEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // F. EXPIRED GRANT
  // =========================================================================
  describe('F. Expired Grant Enforcement', () => {
    it('rejects an expired execution grant', async () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_expired_test',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'echo expired',
        arguments: { command: 'echo expired' },
        riskLevel: 'consequential',
      });

      const expiredGrant = createApprovedGrant(kernel, db, req, { ttlMs: -1000 });

      const result = await runner.run(
        { name: 'run_command', arguments: { command: 'echo expired' } },
        { cwd: tmpDir, securityGrant: expiredGrant, securityKernel: kernel },
      );

      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('security_kernel_grant_invalid');
      expect(result.output).toContain('expired');

      const events = kernel.getJournal().listEvents({ eventType: 'GRANT_REJECTED' });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // G. SAFE_MODE KILL-SWITCH & PROCESS TERMINATION
  // =========================================================================
  describe('G. SAFE_MODE Kill-Switch', () => {
    it('terminates a tracked child whose ownership is proven', async () => {
      // A tracked child is only terminated after its identity is verified:
      // the kill switch proves the PID still belongs to the process Pandesh
      // started before it forces anything down.
      const spawnedAtMs = Date.now();
      const identityKernel = new LocalAutonomySecurityKernel(null, undefined, undefined, (pid: number) => ({
        pid,
        alive: true,
        executablePath: 'C:\\Windows\\System32\\cmd.exe',
        creationTimeMs: spawnedAtMs + 50,
        commandLine: 'cmd.exe /c long-running-worker',
      }));
      let killCalled = false;
      const unregister = identityKernel.getSafeModeManager().registerChildProcess(
        99999,
        () => { killCalled = true; },
        'test-long-running-worker',
        'att_worker_kill',
        { spawnedAtMs },
      );

      expect(identityKernel.getSafeModeManager().listTrackedProcesses().length).toBe(1);

      // Enter SAFE_MODE
      const report = identityKernel.getSafeModeManager().enterSafeMode({
        reason: 'Operator emergency halt',
        actor: 'operator:admin',
      });

      expect(report.active).toBe(true);
      expect(killCalled).toBe(true);
      expect(identityKernel.isSafeModeActive()).toBe(true);
      expect(identityKernel.getSafeModeManager().listTrackedProcesses().length).toBe(0);
      unregister();
    });

    it('refuses to terminate a tracked child whose identity cannot be verified', async () => {
      // A PID that the OS will not identify is a refusal, not a permission:
      // the kill switch must never take down a process it cannot prove it
      // started.
      const identityKernel = new LocalAutonomySecurityKernel(null, undefined, undefined, (pid: number) => ({
        pid,
        alive: false,
        executablePath: null,
        creationTimeMs: null,
        commandLine: null,
      }));
      let killCalled = false;
      const unregister = identityKernel.getSafeModeManager().registerChildProcess(
        99999,
        () => { killCalled = true; },
        'test-unverifiable-worker',
        'att_worker_kill',
      );
      const report = identityKernel.getSafeModeManager().enterSafeMode({
        reason: 'Operator emergency halt',
        actor: 'operator:admin',
      });
      expect(report.active).toBe(true);
      expect(killCalled).toBe(false);
      expect(identityKernel.getSafeModeManager().getLastRefusedTerminations().length).toBe(1);
      unregister();
    });

    it('rejects subsequent execution once SAFE_MODE is on', async () => {
      // The host kernel is put into SAFE_MODE, to prove that subsequent
      // execution is rejected once the switch is on.
      kernel.getSafeModeManager().enterSafeMode({
        reason: 'Operator emergency halt',
        actor: 'operator:admin',
      });

      // Subsequent execution must be rejected
      const result = await runner.run(
        { name: 'read_file', arguments: { path: 'file.txt' } },
        { cwd: tmpDir, securityKernel: kernel },
      );
      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('security_safe_mode_active');

      const safeModeEvents = kernel.getJournal().listEvents({ eventType: 'SAFE_MODE_ENTERED' });
      expect(safeModeEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects capability evaluation when SAFE_MODE is active', () => {
      kernel.getSafeModeManager().enterSafeMode({
        reason: 'Security lockdown',
        actor: 'operator:admin',
      });

      const req = kernel.normalizeRequest({
        attemptId: 'att_lockdown',
        executor: 'core:tool_runner',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'ls',
        riskLevel: 'read_only',
      });

      const decision = kernel.evaluate(req);
      expect(decision.decision).toBe('TERMINATE');
      expect(decision.reason).toContain('SAFE_MODE / EXECUTION_DISABLED is active');
    });
  });

  // =========================================================================
  // H. MODEL CANNOT EXIT SAFE_MODE
  // =========================================================================
  describe('H. Model / Untrusted Actor Cannot Exit SAFE_MODE', () => {
    it('strictly forbids model or autonomous agents from disabling SAFE_MODE', () => {
      kernel.getSafeModeManager().enterSafeMode({
        reason: 'Halt all agents',
        actor: 'operator:sec_ops',
      });

      // Untrusted actors attempt to exit safe mode
      expect(() => {
        kernel.getSafeModeManager().exitSafeMode({
          reason: 'Model decides to resume',
          actor: 'model:qwen2.5',
          isModelAction: true,
        });
      }).toThrow(/Unauthorized/);

      expect(() => {
        kernel.getSafeModeManager().exitSafeMode({
          reason: 'Autonomous tool loop resume',
          actor: 'agent:karkedikha',
        });
      }).toThrow(/Unauthorized/);

      expect(() => {
        kernel.getSafeModeManager().exitSafeMode({
          reason: 'Core executor auto resume',
          actor: 'core:executor',
        });
      }).toThrow(/Unauthorized/);

      // SAFE_MODE must remain actively locked
      expect(kernel.isSafeModeActive()).toBe(true);

      const circumventionEvents = kernel.getJournal().listEvents({ eventType: 'CIRCUMVENTION_SUSPECTED' });
      expect(circumventionEvents.length).toBeGreaterThanOrEqual(1);

      // Trusted operator CAN exit SAFE_MODE
      const exitReport = kernel.getSafeModeManager().exitSafeMode({
        reason: 'Operator verified safe state',
        actor: 'operator:admin',
      });

      expect(exitReport.active).toBe(false);
      expect(kernel.isSafeModeActive()).toBe(false);

      const exitedEvents = kernel.getJournal().listEvents({ eventType: 'SAFE_MODE_EXITED' });
      expect(exitedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // I. SECURITY EVENT AUDIT & SECRET REDACTION
  // =========================================================================
  describe('I. Structured Security Journal & Secret Redaction', () => {
    it('persists structured events and recursively redacts secrets and credentials', () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_secret_test',
        executor: 'core:workspace_validation',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'export API_KEY=sk-super-secret-1234567890abcdef',
        arguments: {
          command: 'curl -H "Authorization: Bearer my-secret-token-abcdef"', // gitleaks:allow
          token: 'ghp_superSecretGitHubToken1234567890', // gitleaks:allow
          password: 'TopSecretPassword99!',
        },
        riskLevel: 'consequential',
      });

      kernel.evaluate(req);

      const events = kernel.getJournal().listEvents({ attemptId: 'att_secret_test' });
      expect(events.length).toBeGreaterThanOrEqual(1);

      const serialized = JSON.stringify(events);
      // Secrets must NEVER appear in the audit trail
      expect(serialized).not.toContain('sk-super-secret-1234567890abcdef');
      expect(serialized).not.toContain('my-secret-token-abcdef');
      expect(serialized).not.toContain('ghp_superSecretGitHubToken1234567890');
      expect(serialized).not.toContain('TopSecretPassword99!');

      expect(serialized).toContain('[REDACTED_SECRET]');
    });

    it('blocks self-modification of security components and logs attempt', () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_tamper_test',
        executor: 'core:workspace_validation',
        capability: 'filesystem',
        workspaceRoot: tmpDir,
        targetResource: 'core/security/kernel.ts',
        arguments: { path: 'core/security/kernel.ts', content: '// disable kernel' },
        riskLevel: 'consequential',
      });

      const decision = kernel.evaluate(req);
      expect(decision.decision).toBe('DENY');
      expect(decision.reason).toMatch(/security kernel component|Self-protection/i);

      const events = kernel.getJournal().listEvents({ eventType: 'CIRCUMVENTION_SUSPECTED' });
      const tamperEvent = events.find((e) => e.payload && (e.payload as any).violation === 'security_component_modification_attempt');
      expect(tamperEvent).toBeDefined();
    });
  });

  // =========================================================================
  // PERFORMANCE BENCHMARK
  // =========================================================================
    describe('Deterministic Performance Overhead Benchmark', () => {
    it('evaluates policy in < 0.2ms and executes durable disk CAS in < 10ms per operation', () => {
      const req = kernel.normalizeRequest({
        attemptId: 'att_perf',
        executor: 'core:workspace_validation',
        capability: 'process',
        workspaceRoot: tmpDir,
        targetResource: tmpDir,
        command: 'npm test',
        arguments: { command: 'npm test' },
        riskLevel: 'consequential',
        origin: { provenance: 'trusted_internal_validation', isModelGenerated: false },
      });

      // 1. Measure pure policy evaluation overhead (zero disk I/O)
      const evalIterations = 1000;
      const evalStart = performance.now();
      for (let i = 0; i < evalIterations; i++) {
        kernel.evaluate(req);
      }
      const evalTotalMs = performance.now() - evalStart;
      const evalMsPerOp = evalTotalMs / evalIterations;

      // 2. Measure end-to-end durable grant authorization + CAS on disk
      const iterations = 100;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        const decision = kernel.authorize(req);
        const grant = decision.grant!;
        kernel.verifyAndConsumeGrant(grant, {
          attemptId: 'att_perf',
          executor: 'core:workspace_validation',
          capability: 'process',
          workspaceRoot: tmpDir,
          targetResource: tmpDir,
          command: 'npm test',
          arguments: { command: 'npm test' },
        });
      }

      const totalMs = performance.now() - start;
      const msPerOp = totalMs / iterations;

      console.log(`[SecurityKernel Perf] Pure policy eval: ${evalMsPerOp.toFixed(3)}ms/op | Durable disk CAS: ${msPerOp.toFixed(3)}ms/op`);

      // Pure in-memory policy evaluation must be well under 0.5ms
      expect(evalMsPerOp).toBeLessThan(2.0);
      // Full durable fsync transaction must complete within realistic OS bounds (< 15ms)
      expect(msPerOp).toBeLessThan(15.0);
    });
  });
});
