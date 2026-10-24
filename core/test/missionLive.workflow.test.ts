import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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
import {
  boundedRepositoryContext,
  copyMissingHelperFixture,
  gitInitFixture,
  MISSING_HELPER_TASK,
} from './missionFixture';

const enabled = process.env.KARKEDIKHA_LIVE_MISSION === '1';
const MODEL = process.env.KARKEDIKHA_DEFAULT_MODEL || 'qwen3.8:27b-mtp-q4_K_M';
const EVIDENCE = path.join(process.cwd(), '.tmp', 'autonomous-mission-workflow.json');

describe.skipIf(!enabled)('live Core-owned autonomous mission (local Ollama)', () => {
  it('completes the missing-helper fixture with the configured local model', async () => {
    const startedAt = Date.now();
    const token = generateToken();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-mission-live-core-'));
    const liveRepo = path.join(process.cwd(), '.tmp', 'missing-helper-live');
    fs.rmSync(liveRepo, { recursive: true, force: true });
    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
    copyMissingHelperFixture(liveRepo);
    const initialSha = gitInitFixture(liveRepo);
    const db = openCoreDatabase(path.join(dataDir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    const api = await startApiServer({
      db, token, broadcaster, dataDir,
      coreInfo: () => ({
        coreVersion: '0.1.0', apiVersion: 1, instanceId: 'live-mission', startedAt: new Date().toISOString(),
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
    const ws = attachWsServer({ httpServer: api.server, token, broadcaster, instanceId: 'live-mission', latestSequence: () => latestSequence(db) });
    const baseUrl = `http://127.0.0.1:${api.port}`;
    let n = 0;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Client-Id': 'live-mission-client',
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

    const conv = createConversation(db, { mode: 'saath_kar', actor: 'live-mission' });
    const submitted = submitRequest(db, {
      clientId: 'live-mission-client',
      currentMessage: MISSING_HELPER_TASK,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: liveRepo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: `live-mission-${Date.now()}`,
      toolPermissionPolicy: { profile: 'autonomous-mission' },
      repositoryContext: boundedRepositoryContext(liveRepo),
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
    const deadline = Date.now() + 25 * 60_000;
    let attempt: any;
    while (Date.now() < deadline) {
      attempt = await jsonOf(await authed(`/v1/attempts/${submitted.attempt.id}`));
      if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled') break;
      if (attempt.status === 'waiting_for_approval') {
        const snapshot = await jsonOf(await authed(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`));
        const action = (snapshot.actions ?? []).find((item: any) => item.actionable);
        if (action) {
          // The content-authorization boundary fix means `propose_file_change`
          // now needs the same human diff review as `authorize_mission` — it
          // is no longer auto-authorized from path/type/size alone. Fall
          // through to the same in-scope check every other mutation gets.
          const inScope = action.toolName === 'authorize_mission'
            || String(action.paths ?? action.path ?? action.toolName ?? '').includes(path.basename(liveRepo))
            || String(JSON.stringify(action)).includes('src/app.js');
          if (!inScope) throw new Error(`refusing to auto-approve out-of-scope action: ${JSON.stringify(action)}`);
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
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const tools = (await jsonOf(await authed(`/v1/attempts/${submitted.attempt.id}/tool-invocations`))).toolInvocations ?? [];
    const actions = tools.map((item: any) => ({
      action: item.toolName,
      path: item.argsSummary?.path,
      query: item.argsSummary?.query,
      range: item.argsSummary?.range,
      ok: item.status === 'succeeded',
      output: String(item.evidence?.output ?? '').slice(0, 400),
    }));
    const validation = tools.find((item: any) => item.toolName === 'workspace_validation' || (item.toolName === 'run_check' && String(item.evidence?.output ?? '').includes('exit')));
    const diff = tools.filter((item: any) => item.toolName === 'run_check').map((item: any) => String(item.evidence?.output ?? '')).find((text: string) => /diff review/i.test(text));
    let commitSha = '';
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: liveRepo, encoding: 'utf8' }).trim();
    } catch {
      commitSha = '';
    }
    const capabilitySnapshot = listCapabilityActions(db, { correlationId: conv.id, clientId: 'live-mission-client' });
    const approvalAttemptId = capabilitySnapshot.attemptId ?? submitted.attempt.id;
    const approvalRecords = listApprovalsForAttempt(db, approvalAttemptId);
    const approvalEvents = listRuntimeEventsForAttempt(db, approvalAttemptId, 100)
      .filter((event) => event.domain === 'approval');
    const evidence = {
      requestId: submitted.request.id,
      attemptId: submitted.attempt.id,
      model: MODEL,
      initialSha,
      actions,
      approvals,
      approvalActor: approvalEvents.find((event) => event.eventType === 'approval_resolved')?.actor
        ?? approvals[0]?.resolved
        ?? null,
      policyDecisions: approvalRecords.map((row) => ({
        approvalId: row.id,
        toolName: row.summary.toolName,
        policyDecision: row.summary.policyDecision ?? row.resolution,
        policyReason: row.summary.policyReason ?? null,
        actor: approvalEvents.find((event) => event.entityId === row.id && event.eventType === 'approval_resolved')?.actor ?? null,
      })),
      validationCommand: validation?.argsSummary?.gates?.[0] ?? validation?.evidence?.normalizedArguments?.gates?.[0] ?? actions.find((item: any) => item.action === 'run_check')?.output,
      validationExitCode: validation?.exitCode ?? null,
      diffReview: diff ?? null,
      commitSha: commitSha === initialSha ? null : commitSha,
      attemptStatus: attempt?.status,
      failureReason: attempt?.failureReason ?? null,
      delivery: attempt?.status === 'completed' ? 'local_commit' : attempt?.status,
      elapsedMs: Date.now() - startedAt,
    };
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2), 'utf8');

    ws.close();
    await api.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });

    expect(attempt?.status, JSON.stringify(evidence, null, 2)).toBe('completed');
    expect(evidence.requestId).toMatch(/^req_/);
    expect(evidence.attemptId).toMatch(/^att_/);
    expect(evidence.approvalActor).toBeTruthy();
    expect(evidence.policyDecisions.length).toBeGreaterThan(0);
    expect(evidence.commitSha).toBeTruthy();
    expect(actions.some((item: any) => item.action === 'search')).toBe(true);
    expect(actions.some((item: any) => item.action === 'read_file')).toBe(true);
    expect(fs.readFileSync(path.join(liveRepo, 'src', 'app.js'), 'utf8')).toContain('formatMoney');
  }, 26 * 60_000);
});
