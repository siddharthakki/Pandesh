import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import { startApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { OllamaModelBackend } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from '../runtime/governedCapability';
import { listRuntimeEventsForAttempt } from '../domain/runtimeEvents';
import { listApprovalsForAttempt } from '../domain/approvals';
import { listCapabilityActions } from '../domain/capabilityDispatch';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import {
  boundedCrossfileContext,
  copyCrossfileValidatorFixture,
  CROSSFILE_VALIDATOR_TASK,
  gitInitFixture,
} from './missionFixture';

const enabled = process.env.KARKEDIKHA_LIVE_CROSSFILE === '1';
const MODEL = process.env.KARKEDIKHA_DEFAULT_MODEL || 'qwen3.8:27b-mtp-q4_K_M';
const EVIDENCE = path.join(process.cwd(), '.tmp', 'crossfile-investigation-workflow.json');
const HELPER_IMPL = 'function isOrdinary';

function runFixtureTests(repo: string) {
  return spawnSync(process.execPath, ['--test', 'tests/validator.test.js'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function inScopePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.includes('..') || /^[a-zA-Z]:/.test(value) || normalized.startsWith('/')) return false;
  return true;
}

function classifyFailure(evidence: Record<string, unknown>): string | null {
  if (evidence.attemptStatus === 'completed') return null;
  const actions = (evidence.actions as Array<{ action?: string; output?: string; ok?: boolean }>) ?? [];
  const blob = JSON.stringify(evidence);
  if (/not authorized|outside the selected repository|package installation|git push/i.test(blob)) return 'core_policy';
  if (evidence.validationExitCode != null && evidence.validationExitCode !== 0) return 'validation';
  if (!actions.some((item) => item.action === 'search')) return 'context_delivery';
  return 'model_output';
}

describe.skipIf(!enabled)('live Core-owned cross-file investigation (local Ollama)', () => {
  it('discovers the excluded helper, fixes the caller, and commits locally', async () => {
    const startedAt = Date.now();
    const token = generateToken();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-crossfile-live-core-'));
    const liveRepo = path.join(process.cwd(), '.tmp', 'crossfile-validator-live');
    fs.rmSync(liveRepo, { recursive: true, force: true });
    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
    copyCrossfileValidatorFixture(liveRepo);
    const initialSha = gitInitFixture(liveRepo, 'initial crossfile-validator fixture');
    const baseline = runFixtureTests(liveRepo);
    expect(baseline.status, baseline.stderr || baseline.stdout).not.toBe(0);

    const context = boundedCrossfileContext(liveRepo);
    expect(context.prompt).not.toContain(HELPER_IMPL);
    expect(context.selectedFiles.map((file) => file.path)).not.toContain('lib/ordinary.js');

    const db = openCoreDatabase(path.join(dataDir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    const api = await startApiServer({
      db, token, broadcaster, dataDir,
      coreInfo: () => ({
        coreVersion: '0.1.0', apiVersion: 1, instanceId: 'live-crossfile', startedAt: new Date().toISOString(),
        nodeVersion: process.version, electronVersion: null, dataDir,
      }),
      onShutdown: () => {},
      executorOptions: {
        backend: new OllamaModelBackend(),
        toolRunner: new CoreToolRunner(),
        defaultModel: MODEL,
        defaultWorkingDirectory: liveRepo,
        dataDir,
        governedCapabilities: new GovernedCapabilityRegistry().register(createWorkspaceCapabilityAdapter()),
      },
    });
    const ws = attachWsServer({ httpServer: api.server, token, broadcaster, instanceId: 'live-crossfile', latestSequence: () => latestSequence(db) });
    const baseUrl = `http://127.0.0.1:${api.port}`;
    let n = 0;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Client-Id': 'live-crossfile-client',
    };
    const authed = (p: string, init: RequestInit & { idempotencyKey?: string } = {}) => {
      const next = { ...headers } as Record<string, string>;
      if (init.idempotencyKey) next['Idempotency-Key'] = init.idempotencyKey;
      return fetch(`${baseUrl}${p}`, { ...init, headers: next });
    };
    const jsonOf = async (res: Response) => {
      const body = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
      return body;
    };

    const conv = createConversation(db, { mode: 'saath_kar', actor: 'live-crossfile' });
    const submitted = submitRequest(db, {
      clientId: 'live-crossfile-client',
      currentMessage: CROSSFILE_VALIDATOR_TASK,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: liveRepo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: `live-crossfile-${Date.now()}`,
      toolPermissionPolicy: { profile: 'autonomous-mission' },
      repositoryContext: context,
      requestedProvider: 'ollama',
      requestedModel: MODEL,
      modelSelection: {
        selectedProvider: 'ollama',
        selectedModel: MODEL,
        selectionReason: 'Configured local Ollama chat model',
        suitabilitySummary: `Using local ${MODEL}. Cloud fallback is disabled.`,
        userOverrode: false,
        candidates: [],
        escalationCandidates: [],
        requiredCapabilities: {
          readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true,
          codingComplexity: 'low', contextRequirement: 'medium', vision: false, validationAndRepair: true,
        },
      },
    });
    await authed(`/v1/attempts/${submitted.attempt.id}/execute`, { method: 'POST', idempotencyKey: `exec-${++n}` });

    const approvals: Array<Record<string, unknown>> = [];
    const denied: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 25 * 60_000;
    let attempt: any;
    while (Date.now() < deadline) {
      attempt = await jsonOf(await authed(`/v1/attempts/${submitted.attempt.id}`));
      if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled') break;
      if (attempt.status === 'waiting_for_approval') {
        const snapshot = await jsonOf(await authed(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`));
        const action = (snapshot.actions ?? []).find((item: any) => item.actionable);
        if (action) {
          const requestedPath = String(action.arguments?.path ?? action.paths?.[0] ?? '');
          if (action.toolName === 'authorize_mission') {
            const resolved = await jsonOf(await authed(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
              method: 'POST',
              idempotencyKey: `approve-${++n}`,
              body: JSON.stringify({
                resolution: 'approved',
                attemptId: action.attemptId,
                expectedAttemptRevision: action.expectedAttemptRevision,
                expectedAttemptStatus: action.expectedAttemptStatus,
                requestedActionDigest: action.requestedActionDigest,
                frozenContextHash: action.frozenContextHash,
              }),
            }));
            approvals.push({ toolName: action.toolName, approvalId: action.approvalId, resolved: resolved.status ?? 'approved' });
            continue;
          }
          // The content-authorization boundary fix means `propose_file_change`
          // now needs the same human diff review as `authorize_mission` — it
          // is no longer auto-authorized from path/type/size alone. Fall
          // through to the same in-scope check every other mutation gets.
          if (action.toolName !== 'propose_file_change' || !inScopePath(requestedPath)) {
            denied.push({ toolName: action.toolName, path: requestedPath, reason: 'out_of_scope' });
            await jsonOf(await authed(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
              method: 'POST',
              idempotencyKey: `deny-${++n}`,
              body: JSON.stringify({
                resolution: 'rejected',
                attemptId: action.attemptId,
                expectedAttemptRevision: action.expectedAttemptRevision,
                expectedAttemptStatus: action.expectedAttemptStatus,
                requestedActionDigest: action.requestedActionDigest,
                frozenContextHash: action.frozenContextHash,
              }),
            }));
            continue;
          }
          const resolved = await jsonOf(await authed(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
            method: 'POST',
            idempotencyKey: `approve-${++n}`,
            body: JSON.stringify({
              resolution: 'approved',
              attemptId: action.attemptId,
              expectedAttemptRevision: action.expectedAttemptRevision,
              expectedAttemptStatus: action.expectedAttemptStatus,
              requestedActionDigest: action.requestedActionDigest,
              frozenContextHash: action.frozenContextHash,
            }),
          }));
          approvals.push({ toolName: action.toolName, path: requestedPath, approvalId: action.approvalId, resolved: resolved.status ?? 'approved' });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const tools = (await jsonOf(await authed(`/v1/attempts/${submitted.attempt.id}/tool-invocations`))).toolInvocations ?? [];
    const capabilitySnapshot = listCapabilityActions(db, { correlationId: conv.id, clientId: 'live-crossfile-client' });
    const approvalAttemptId = capabilitySnapshot.attemptId ?? submitted.attempt.id;
    const capabilityTools = approvalAttemptId === submitted.attempt.id
      ? []
      : listToolInvocationsForAttempt(db, approvalAttemptId);
    const allTools = [...tools, ...capabilityTools];
    const actions = allTools.map((item: any) => ({
      action: item.toolName,
      path: item.argsSummary?.path ?? null,
      query: item.argsSummary?.query ?? null,
      range: item.argsSummary?.range ?? null,
      resultCount: item.argsSummary?.resultCount ?? null,
      fingerprint: item.argsSummary?.fingerprint ?? item.evidence?.fingerprint ?? null,
      ok: item.status === 'succeeded',
      output: String(item.evidence?.output ?? '').slice(0, 800),
    }));
    const validation = allTools.find((item: any) => item.toolName === 'workspace_validation'
      || (item.toolName === 'run_check' && /exit|test/i.test(String(item.evidence?.output ?? ''))));
    const diff = allTools.filter((item: any) => item.toolName === 'run_check').map((item: any) => String(item.evidence?.output ?? '')).find((text: string) => /diff review/i.test(text));
    let commitSha = '';
    let changedPaths: string[] = [];
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: liveRepo, encoding: 'utf8' }).trim();
      changedPaths = execFileSync('git', ['diff', '--name-only', initialSha, 'HEAD'], { cwd: liveRepo, encoding: 'utf8' })
        .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      commitSha = '';
    }
    const approvalRecords = listApprovalsForAttempt(db, approvalAttemptId);
    const approvalEvents = listRuntimeEventsForAttempt(db, approvalAttemptId, 100)
      .filter((event) => event.domain === 'approval');
    const afterTests = runFixtureTests(liveRepo);
    const caller = fs.existsSync(path.join(liveRepo, 'index.js'))
      ? fs.readFileSync(path.join(liveRepo, 'index.js'), 'utf8')
      : '';
    const evidence = {
      requestId: submitted.request.id,
      attemptId: submitted.attempt.id,
      model: MODEL,
      initialSha,
      actions,
      approvals,
      denied,
      approvalActor: approvalEvents.find((event) => event.eventType === 'approval_resolved')?.actor ?? null,
      policyDecisions: approvalRecords.map((row) => ({
        approvalId: row.id,
        toolName: row.summary.toolName,
        policyDecision: row.resolution ?? row.summary.policyDecision,
        policyReason: row.summary.policyReason ?? null,
      })),
      validationCommand: validation?.argsSummary?.gates?.[0] ?? validation?.evidence?.normalizedArguments?.gates?.[0] ?? actions.find((item: any) => item.action === 'run_check' || item.action === 'workspace_validation')?.output,
      validationExitCode: validation?.exitCode ?? afterTests.status,
      diffReview: diff ?? null,
      commitSha: commitSha === initialSha ? null : commitSha,
      changedPaths,
      baselineTestFailed: baseline.status !== 0,
      afterTestPassed: afterTests.status === 0,
      helperInInitialContext: context.prompt.includes(HELPER_IMPL),
      callerUsesHelper: /lib\/ordinary/.test(caller) && /isOrdinary/.test(caller),
      attemptStatus: attempt?.status,
      failureReason: attempt?.failureReason ?? null,
      delivery: attempt?.status === 'completed' ? 'local_commit' : attempt?.status,
      elapsedMs: Date.now() - startedAt,
    };
    const failureClass = classifyFailure(evidence);
    const payload = { ...evidence, failureClass };
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(payload, null, 2), 'utf8');

    ws.close();
    await api.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });

    expect(payload.helperInInitialContext, JSON.stringify(payload, null, 2)).toBe(false);
    expect(payload.baselineTestFailed).toBe(true);
    expect(attempt?.status, JSON.stringify(payload, null, 2)).toBe('completed');
    expect(payload.failureClass).toBeNull();
    expect(payload.requestId).toMatch(/^req_/);
    expect(payload.attemptId).toMatch(/^att_/);
    expect(payload.commitSha).toBeTruthy();
    expect(payload.afterTestPassed).toBe(true);
    expect(payload.callerUsesHelper).toBe(true);
    expect(payload.changedPaths.some((item) => item.replace(/\\/g, '/') === 'index.js')).toBe(true);
    expect(actions.some((item: any) => item.action === 'search' && item.query)).toBe(true);
    expect(actions.some((item: any) => item.action === 'read_file' && item.range && item.fingerprint)).toBe(true);
    expect(actions.some((item: any) => item.action === 'propose_file_change')).toBe(true);
    expect(actions.some((item: any) => item.action === 'workspace_validation' || (item.action === 'run_check' && /test|exit/i.test(String(item.output))))).toBe(true);
    expect(String(payload.diffReview ?? '')).toMatch(/diff review/i);
  }, 26 * 60_000);
});
