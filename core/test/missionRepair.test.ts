import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { listExecutionQualityEvents, MAX_VALIDATION_REPAIR_CYCLES } from '../domain/executionQuality';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { compactMissionContext } from '../runtime/missionCompaction';
import { applyValidationSummary, missionValidationStatus, readWorkspaceRange } from '../runtime/missionObservations';
import { executeMissionAction, rejectFreeFormCommand } from '../runtime/missionLoop';
import { classifyScopedCommand, argvForCheck, type MissionEnvelope } from '../runtime/scopedCommand';
import { searchWorkspace } from '../runtime/missionSearch';
import {
  boundedValidationRepairContext,
  copyValidationRepairFixture,
  FIXED_HANDLE_JS,
  gitInitFixture,
  NAIVE_HANDLE_JS,
  VALIDATION_REPAIR_TASK,
} from './missionFixture';

const TOKEN = generateToken();
const REGRESSION_MARK = 'surrounding whitespace';

function runVisible(repo: string) {
  return spawnSync(process.execPath, ['--test', 'tests/visible.test.js'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runAll(repo: string) {
  return spawnSync(process.execPath, ['--test', 'tests/visible.test.js', 'tests/regression.test.js'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('validation-repair fixture', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-repair-fx-'));
    copyValidationRepairFixture(dir);
    gitInitFixture(dir, 'initial validation-repair fixture');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('excludes the regression check from the initial bounded context', () => {
    const context = boundedValidationRepairContext(dir);
    expect(context.prompt).toContain('ordinary handles are lowercase');
    expect(context.prompt).toContain('function normalizeHandle');
    expect(context.prompt).not.toContain(REGRESSION_MARK);
    expect(context.selectedFiles.map((file) => file.path)).not.toContain('tests/regression.test.js');
    expect(fs.readFileSync(path.join(dir, 'tests', 'regression.test.js'), 'utf8')).toContain(REGRESSION_MARK);
    expect(VALIDATION_REPAIR_TASK).not.toMatch(/trim\(|toLowerCase\(|replace\(/);
    expect(VALIDATION_REPAIR_TASK).not.toContain(NAIVE_HANDLE_JS.trim());
    expect(VALIDATION_REPAIR_TASK).not.toContain(FIXED_HANDLE_JS.trim());
  });

  it('fails on the stub, lets a naive lowercase pass the visible check, and needs a repair for the regression', () => {
    const baseline = runAll(dir);
    expect(baseline.status, baseline.stderr || baseline.stdout).not.toBe(0);

    fs.writeFileSync(path.join(dir, 'index.js'), NAIVE_HANDLE_JS, 'utf8');
    const visible = runVisible(dir);
    expect(visible.status, visible.stderr || visible.stdout).toBe(0);
    const naiveAll = runAll(dir);
    expect(naiveAll.status, naiveAll.stderr || naiveAll.stdout).not.toBe(0);
    expect(`${naiveAll.stdout}\n${naiveAll.stderr}`).toContain(REGRESSION_MARK);

    fs.writeFileSync(path.join(dir, 'index.js'), FIXED_HANDLE_JS, 'utf8');
    const repaired = runAll(dir);
    expect(repaired.status, repaired.stderr || repaired.stdout).toBe(0);
  });

  it('rejects outside-path, network, install, and push attempts', () => {
    const envelope: MissionEnvelope = {
      workspaceRoot: dir,
      pushAuthorized: false,
      networkAuthorized: false,
      installAuthorized: false,
    };
    expect(readWorkspaceRange({ workspaceRoot: dir, requestedPath: '../secrets.txt' }).ok).toBe(false);
    expect(classifyScopedCommand('npm install lodash', envelope).allow).toBe(false);
    expect(classifyScopedCommand('curl https://example.com', envelope).allow).toBe(false);
    expect(classifyScopedCommand('git push origin HEAD', envelope).allow).toBe(false);
    expect(argvForCheck('test', envelope, process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/hosts').allow).toBe(false);
    expect(rejectFreeFormCommand('npm install puppeteer-core', envelope).ok).toBe(false);
    const blocked = executeMissionAction({
      action: { action: 'read_file', path: 'C:\\kdikha\\outside.js' },
      envelope,
      evidence: { approvedMutation: false, validationPassed: false, diffReview: 'pending' },
    });
    expect(blocked.observation.ok).toBe(false);
    expect(searchWorkspace({ workspaceRoot: dir, query: 'normalizeHandle', scopePath: '..' }).ok).toBe(false);
  });
});

describe('failed validation observation', () => {
  it('pins a failed validation summary as fail, not missing', () => {
    const evidence = applyValidationSummary(
      { approvedMutation: true, validationPassed: false, diffReview: 'pending' },
      'Validation: failed\n- npm run test (unit_test) — failed, exit 1\nexpected "alice" after surrounding whitespace is ignored',
    );
    expect(missionValidationStatus(evidence)).toBe('fail');
    expect(evidence.validationPassed).toBe(false);
    expect(evidence.validationCommand).toBe('npm run test');
    expect(evidence.validationExitCode).toBe(1);
    const compacted = compactMissionContext({
      goal: 'lowercase handles',
      acceptanceCriteria: ['Focused tests pass'],
      permissions: ['propose_file_change'],
      latestTestResult: evidence.lastValidationSummary,
    }, evidence, [{
      observation: {
        action: 'propose_file_change',
        path: 'index.js',
        resultCount: 1,
        truncated: false,
        ok: true,
        output: evidence.lastValidationSummary ?? '',
      },
    }]);
    expect(compacted.prompt).toContain('validation=fail');
    expect(compacted.prompt).toContain('Latest test:');
    expect(compacted.prompt).toContain(REGRESSION_MARK);
    expect(compacted.prompt).toContain('"action":"propose_file_change"');
  });
});

class RepairScriptedBackend implements ModelBackend {
  requests: ModelChatRequest[] = [];
  constructor(private readonly repairContent: string) {}
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push(request);
    const compact = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const empty = { content: '', provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    if (compact.includes('delivery=local_commit') || /commit=[0-9a-f]{7,}/i.test(compact)) {
      return { ...empty, content: 'finishing', toolCalls: [{ name: 'finish', arguments: { summary: 'repaired handle, tests passed, local commit' } }] };
    }
    if (compact.includes('diffReview=pass') && compact.includes('validation=pass')) {
      return { ...empty, content: 'commit', toolCalls: [{ name: 'run_check', arguments: { check: 'commit' } }] };
    }
    if (compact.includes('mutation=approved') && compact.includes('validation=pass')) {
      return { ...empty, content: 'diff', toolCalls: [{ name: 'run_check', arguments: { check: 'diff' } }] };
    }
    if (compact.includes('validation=fail')) {
      if (compact.includes('"action":"read_file"') && compact.includes('regression.test.js')) {
        return {
          ...empty,
          content: 'repair',
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'index.js', content: this.repairContent } }],
        };
      }
      return {
        ...empty,
        content: 'inspect-failure',
        toolCalls: [{ name: 'read_file', arguments: { path: 'tests/regression.test.js', startLine: 1, endLine: 12 } }],
      };
    }
    if (compact.includes('"action":"read_file"') && compact.includes('index.js')) {
      return {
        ...empty,
        content: 'propose-naive',
        toolCalls: [{ name: 'propose_file_change', arguments: { path: 'index.js', content: NAIVE_HANDLE_JS } }],
      };
    }
    if (compact.includes('"action":"search"')) {
      return {
        ...empty,
        content: 'read',
        toolCalls: [{ name: 'read_file', arguments: { path: 'index.js', startLine: 1, endLine: 8 } }],
      };
    }
    return { ...empty, content: 'search', toolCalls: [{ name: 'search', arguments: { query: 'normalizeHandle' } }] };
  }
}

async function startRepairCore(input: {
  repo: string;
  backend: ModelBackend;
  token?: string;
}) {
  const token = input.token ?? TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-repair-core-'));
  const db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  const workspaceRunner = new CoreToolRunner();
  const governedWorkspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => workspaceRunner.run(call, context),
  };
  const api = await startApiServer({
    db, token, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend: input.backend,
      toolRunner: workspaceRunner,
      defaultModel: 'fixture',
      defaultWorkingDirectory: input.repo,
      dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
    },
  });
  const ws = attachWsServer({ httpServer: api.server, token, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  return { token, dir, db, api, ws, baseUrl: `http://127.0.0.1:${api.port}` };
}

async function drainMission(input: {
  baseUrl: string;
  token: string;
  attemptId: string;
  conversationId: string;
  timeoutMs?: number;
}) {
  let n = 0;
  const authedFetch = (p: string, init: RequestInit & { idempotencyKey?: string } = {}) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      'X-Client-Id': 'test-client',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    return fetch(`${input.baseUrl}${p}`, { ...init, headers });
  };
  await authedFetch(`/v1/attempts/${input.attemptId}/execute`, { method: 'POST', idempotencyKey: `idemp-repair-${++n}` });
  const deadline = Date.now() + (input.timeoutMs ?? 25_000);
  let attempt: any;
  const approvals: string[] = [];
  while (Date.now() < deadline) {
    attempt = await (await authedFetch(`/v1/attempts/${input.attemptId}`)).json();
    if (attempt.status === 'waiting_for_approval') {
      const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(input.conversationId)}`)).json();
      const action = snapshot.actions.find((item: any) => item.actionable);
      // The content-authorization boundary fix means `propose_file_change`
      // requires the same human diff review as `authorize_mission` now — it
      // is no longer auto-authorized from path/type/size alone. This fixture
      // never proposes anything out of scope, so acting as the reviewing
      // human and approving both is correct; anything else is unexpected.
      if (action?.toolName === 'authorize_mission' || action?.toolName === 'propose_file_change') {
        approvals.push(action.toolName);
        await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
          method: 'POST',
          idempotencyKey: `idemp-repair-${++n}`,
          body: JSON.stringify({
            resolution: 'approved',
            attemptId: action.attemptId,
            expectedAttemptRevision: action.expectedAttemptRevision,
            expectedAttemptStatus: action.expectedAttemptStatus,
            requestedActionDigest: action.requestedActionDigest,
            frozenContextHash: action.frozenContextHash,
          }),
        });
      } else if (action) {
        throw new Error(`Hands-off Mission V1 failed: unexpected approval ${action.toolName} ${action.arguments?.path ?? ''}`);
      }
    }
    if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const tools = (await (await authedFetch(`/v1/attempts/${input.attemptId}/tool-invocations`)).json()).toolInvocations;
  return { attempt, tools, approvals };
}

describe('Core-owned validation-failure repair loop', () => {
  let repo: string;
  let core: Awaited<ReturnType<typeof startRepairCore>> | undefined;
  let backend: RepairScriptedBackend;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-repair-repo-'));
    copyValidationRepairFixture(repo);
    gitInitFixture(repo, 'initial validation-repair fixture');
  });
  afterEach(async () => {
    core?.ws.close();
    await core?.api.close();
    core?.db.close();
    if (core?.dir) fs.rmSync(core.dir, { recursive: true, force: true });
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    core = undefined;
  });

  it('returns the failed validation as an observation, accepts one bounded repair, then commits', async () => {
    backend = new RepairScriptedBackend(FIXED_HANDLE_JS);
    core = await startRepairCore({ repo, backend });
    const conv = createConversation(core.db, { mode: 'saath_kar', actor: 'test' });
    const submitted = submitRequest(core.db, {
      clientId: 'test-client',
      currentMessage: VALIDATION_REPAIR_TASK,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: repo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: `repair-${Date.now()}`,
      toolPermissionPolicy: { profile: 'autonomous-mission' },
      repositoryContext: boundedValidationRepairContext(repo),
      modelSelection: {
        selectedProvider: 'ollama',
        selectedModel: 'fixture',
        selectionReason: 'test',
        suitabilitySummary: 'test',
        userOverrode: true,
        candidates: [],
        escalationCandidates: [],
        requiredCapabilities: {
          readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true,
          codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: true,
        },
      },
    });
    const drained = await drainMission({
      baseUrl: core.baseUrl,
      token: core.token,
      attemptId: submitted.attempt.id,
      conversationId: conv.id,
    });

    expect(drained.attempt.status, JSON.stringify({
      status: drained.attempt.status,
      failureReason: drained.attempt.failureReason,
      tools: drained.tools,
    }, null, 2)).toBe('completed');
    expect(drained.approvals[0]).toBe('authorize_mission');
    expect(drained.approvals.slice(1).every((name) => name === 'propose_file_change')).toBe(true);
    // The naive attempt and its repaired follow-up are distinct content, so
    // each needed its own explicit review — never auto-authorized.
    expect(drained.approvals.filter((name) => name === 'propose_file_change').length).toBeGreaterThanOrEqual(2);

    const names = drained.tools.map((item: any) => item.toolName);
    expect(names).toContain('search');
    expect(names).toContain('read_file');
    expect(names.filter((name: string) => name === 'workspace_validation').length).toBeGreaterThanOrEqual(2);

    const validations = drained.tools.filter((item: any) => item.toolName === 'workspace_validation');
    expect(validations[0].status).toBe('failed');
    expect(String(validations[0].evidence?.output ?? '')).toMatch(/Validation: failed|surrounding whitespace/);
    expect(validations.some((item: any) => item.status === 'succeeded')).toBe(true);

    const compactAfterFail = backend.requests
      .map((request) => request.messages.map((message) => message.content).join('\n'))
      .find((text) => text.includes('validation=fail'));
    expect(compactAfterFail, 'failed validation must be returned to the model').toBeTruthy();
    expect(compactAfterFail).toContain('Latest test:');
    expect(compactAfterFail).toMatch(/Validation: failed|surrounding whitespace/);

    const quality = listExecutionQualityEvents(core.db, submitted.attempt.id);
    expect(quality.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'validation_failed',
      'validation_repair_started',
      'validation_repair_completed',
    ]));
    expect(quality.filter((event) => event.eventType === 'validation_repair_started')).toHaveLength(1);
    expect(quality.some((event) => event.eventType === 'validation_repair_exhausted')).toBe(false);

    expect(fs.readFileSync(path.join(repo, 'index.js'), 'utf8')).toContain('.trim()');
    const changed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    expect(changed).toContain('index.js');
    expect(runAll(repo).status).toBe(0);
  }, 30_000);

  it('exhausts bounded repair instead of retrying forever', async () => {
    backend = new RepairScriptedBackend(NAIVE_HANDLE_JS);
    core = await startRepairCore({ repo, backend });
    const conv = createConversation(core.db, { mode: 'saath_kar', actor: 'test' });
    const submitted = submitRequest(core.db, {
      clientId: 'test-client',
      currentMessage: VALIDATION_REPAIR_TASK,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: repo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: `repair-exhaust-${Date.now()}`,
      toolPermissionPolicy: { profile: 'autonomous-mission' },
      repositoryContext: boundedValidationRepairContext(repo),
      modelSelection: {
        selectedProvider: 'ollama',
        selectedModel: 'fixture',
        selectionReason: 'test',
        suitabilitySummary: 'test',
        userOverrode: true,
        candidates: [],
        escalationCandidates: [],
        requiredCapabilities: {
          readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true,
          codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: true,
        },
      },
    });
    const drained = await drainMission({
      baseUrl: core.baseUrl,
      token: core.token,
      attemptId: submitted.attempt.id,
      conversationId: conv.id,
    });
    expect(drained.attempt.status, JSON.stringify({
      status: drained.attempt.status,
      failureReason: drained.attempt.failureReason,
    }, null, 2)).toBe('failed');
    expect(drained.attempt.failureReason).toMatch(/bounded validation repair was exhausted/);
    const quality = listExecutionQualityEvents(core.db, submitted.attempt.id);
    expect(quality.filter((event) => event.eventType === 'validation_repair_started').length).toBe(MAX_VALIDATION_REPAIR_CYCLES);
    expect(quality.some((event) => event.eventType === 'validation_repair_exhausted')).toBe(true);
    expect(runAll(repo).status).not.toBe(0);
  }, 30_000);

  it('refuses a prose-only completion', async () => {
    const refused = executeMissionAction({
      action: { action: 'finish', summary: 'done' },
      envelope: { workspaceRoot: repo, pushAuthorized: false, networkAuthorized: false, installAuthorized: false },
      evidence: { approvedMutation: false, validationPassed: false, diffReview: 'pending' },
    });
    expect(refused.observation.ok).toBe(false);
    expect(refused.observation.output).toMatch(/completion refused/);
  });
});
