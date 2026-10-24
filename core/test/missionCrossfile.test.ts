import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { fingerprintText, readWorkspaceRange } from '../runtime/missionObservations';
import { executeMissionAction, rejectFreeFormCommand } from '../runtime/missionLoop';
import { classifyScopedCommand, argvForCheck, type MissionEnvelope } from '../runtime/scopedCommand';
import { searchWorkspace } from '../runtime/missionSearch';
import {
  boundedCrossfileContext,
  copyCrossfileValidatorFixture,
  CROSSFILE_VALIDATOR_TASK,
  FIXED_INDEX_JS,
  gitInitFixture,
} from './missionFixture';

const TOKEN = generateToken();
const HELPER_IMPL = 'function isOrdinary';

function runFixtureTests(repo: string) {
  return spawnSync(process.execPath, ['--test', 'tests/validator.test.js'], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('cross-file validator fixture', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-crossfile-'));
    copyCrossfileValidatorFixture(dir);
    gitInitFixture(dir, 'initial crossfile-validator fixture');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('excludes the helper implementation from the initial bounded context', () => {
    const context = boundedCrossfileContext(dir);
    expect(context.prompt).toContain('function validate');
    expect(context.prompt).toContain('legacyValidate');
    expect(context.prompt).not.toContain(HELPER_IMPL);
    expect(context.prompt).not.toContain("require('./lib/ordinary')");
    expect(context.selectedFiles.map((file) => file.path)).not.toContain('lib/ordinary.js');
    expect(fs.readFileSync(path.join(dir, 'lib', 'ordinary.js'), 'utf8')).toContain(HELPER_IMPL);
  });

  it('requires search to discover the helper among decoys', () => {
    const found = searchWorkspace({ workspaceRoot: dir, query: 'isOrdinary' });
    expect(found.ok).toBe(true);
    expect(found.query).toBe('isOrdinary');
    expect(found.resultCount).toBeGreaterThan(0);
    expect(found.output).toContain('lib/ordinary.js');
    expect(found.output).not.toContain('decoys/legacy-validator.js');
    expect(searchWorkspace({ workspaceRoot: dir, query: 'legacyValidate' }).output).toContain('decoys/legacy-validator.js');
  });

  it('records path, range, result count, and fingerprint for a ranged helper read', () => {
    const observation = readWorkspaceRange({
      workspaceRoot: dir,
      requestedPath: 'lib/ordinary.js',
      startLine: 1,
      endLine: 7,
    });
    expect(observation.ok).toBe(true);
    expect(observation.path).toMatch(/lib\/ordinary\.js$/);
    expect(observation.range).toBe('1-7');
    expect(observation.resultCount).toBe(7);
    expect(observation.fingerprint).toBe(fingerprintText(fs.readFileSync(path.join(dir, 'lib', 'ordinary.js'), 'utf8')));
    expect(observation.output).toContain(HELPER_IMPL);
  });

  it('fails the focused test on the fixture baseline and passes after the caller uses the helper', () => {
    const before = runFixtureTests(dir);
    expect(before.status, before.stderr || before.stdout).not.toBe(0);
    fs.writeFileSync(path.join(dir, 'index.js'), FIXED_INDEX_JS, 'utf8');
    const after = runFixtureTests(dir);
    expect(after.status, after.stderr || after.stdout).toBe(0);
  });

  it('rejects outside-path, network, install, and push attempts', () => {
    const envelope: MissionEnvelope = {
      workspaceRoot: dir,
      pushAuthorized: false,
      networkAuthorized: false,
      installAuthorized: false,
    };
    expect(readWorkspaceRange({ workspaceRoot: dir, requestedPath: '../secrets.txt' }).ok).toBe(false);
    const scoped = searchWorkspace({
      workspaceRoot: dir,
      query: 'isOrdinary',
      scopePath: '..',
    });
    expect(scoped.ok).toBe(false);
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
  });
});

class CrossfileScriptedBackend implements ModelBackend {
  requests: ModelChatRequest[] = [];
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push(request);
    const compact = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const empty = { content: '', provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    if (compact.includes('delivery=local_commit') || /commit=[0-9a-f]{7,}/i.test(compact)) {
      return { ...empty, content: 'finishing', toolCalls: [{ name: 'finish', arguments: { summary: 'wired ordinary helper, tests passed, local commit' } }] };
    }
    if (compact.includes('diffReview=pass') && compact.includes('validation=pass')) {
      return { ...empty, content: 'commit', toolCalls: [{ name: 'run_check', arguments: { check: 'commit' } }] };
    }
    if (compact.includes('mutation=approved') && compact.includes('validation=pass')) {
      return { ...empty, content: 'diff', toolCalls: [{ name: 'run_check', arguments: { check: 'diff' } }] };
    }
    if (compact.includes('mutation=approved')) {
      return { ...empty, content: 'test', toolCalls: [{ name: 'run_check', arguments: { check: 'test' } }] };
    }
    if (compact.includes('"action":"read_file"') && compact.includes('lib/ordinary.js')) {
      return {
        ...empty,
        content: 'propose',
        toolCalls: [{ name: 'propose_file_change', arguments: { path: 'index.js', content: FIXED_INDEX_JS } }],
      };
    }
    if (compact.includes('"action":"search"')) {
      return {
        ...empty,
        content: 'read',
        toolCalls: [{ name: 'read_file', arguments: { path: 'lib/ordinary.js', startLine: 1, endLine: 7 } }],
      };
    }
    return { ...empty, content: 'search', toolCalls: [{ name: 'search', arguments: { query: 'isOrdinary' } }] };
  }
}

describe('Core-owned cross-file investigation loop', () => {
  const token = TOKEN;
  let dir: string;
  let repo: string;
  let db: CoreDatabase;
  let api: RunningApiServer;
  let ws: { close(): void };
  let backend: CrossfileScriptedBackend;
  let n = 0;
  let baseUrl: string;

  function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Client-Id': 'test-client',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    return fetch(`${baseUrl}${p}`, { ...init, headers });
  }
  const idemp = () => `idemp-crossfile-${++n}`;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-crossfile-core-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-crossfile-repo-'));
    copyCrossfileValidatorFixture(repo);
    gitInitFixture(repo, 'initial crossfile-validator fixture');
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    backend = new CrossfileScriptedBackend();
    const broadcaster = new EventBroadcaster();
    const workspaceRunner = new CoreToolRunner();
    const governedWorkspace: GovernedCapabilityAdapter = {
      id: 'workspace',
      definitions: () => workspaceRunner.definitions(),
      classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
      health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
      run: (call, context) => workspaceRunner.run(call, context),
    };
    api = await startApiServer({
      db, token, broadcaster, dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: {
        backend,
        toolRunner: workspaceRunner,
        defaultModel: 'fixture',
        defaultWorkingDirectory: repo,
        dataDir: dir,
        governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
      },
    });
    ws = attachWsServer({ httpServer: api.server, token, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;
  });

  afterEach(async () => {
    ws?.close();
    await api?.close();
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('searches, range-reads the helper, proposes the caller fix, validates, reviews, and commits', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const submitted = submitRequest(db, {
      clientId: 'test-client',
      currentMessage: CROSSFILE_VALIDATOR_TASK,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: repo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: idemp(),
      toolPermissionPolicy: { profile: 'autonomous-mission' },
      repositoryContext: boundedCrossfileContext(repo),
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
    await authedFetch(`/v1/attempts/${submitted.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });

    const deadline = Date.now() + 25_000;
    let attempt: any;
    while (Date.now() < deadline) {
      attempt = await (await authedFetch(`/v1/attempts/${submitted.attempt.id}`)).json();
      if (attempt.status === 'waiting_for_approval') {
        const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`)).json();
        const action = snapshot.actions.find((item: any) => item.actionable);
        // The content-authorization boundary fix means `propose_file_change`
        // now needs the same human diff review as `authorize_mission` — it
        // is no longer auto-authorized from path/type/size alone. This
        // fixture never proposes anything out of scope, so approving both is
        // correct; anything else would be unexpected.
        if (!action || (action.toolName !== 'authorize_mission' && action.toolName !== 'propose_file_change')) continue;
        await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
          method: 'POST',
          idempotencyKey: idemp(),
          body: JSON.stringify({
            resolution: 'approved',
            attemptId: action.attemptId,
            expectedAttemptRevision: action.expectedAttemptRevision,
            expectedAttemptStatus: action.expectedAttemptStatus,
            requestedActionDigest: action.requestedActionDigest,
            frozenContextHash: action.frozenContextHash,
          }),
        });
      }
      if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const first = backend.requests[0];
    expect(first.messages.map((message) => message.content).join('\n')).not.toContain(HELPER_IMPL);
    const tools = (await (await authedFetch(`/v1/attempts/${submitted.attempt.id}/tool-invocations`)).json()).toolInvocations;
    expect(attempt.status, JSON.stringify({ status: attempt.status, failureReason: attempt.failureReason, tools }, null, 2)).toBe('completed');
    const names = tools.map((item: any) => item.toolName);
    expect(names).toContain('search');
    expect(names).toContain('read_file');
    expect(names).toContain('workspace_validation');
    expect(names).toContain('run_check');
    const search = tools.find((item: any) => item.toolName === 'search');
    expect(search.argsSummary.query).toBe('isOrdinary');
    expect(search.argsSummary.resultCount).toBeGreaterThan(0);
    const read = tools.find((item: any) => item.toolName === 'read_file');
    expect(read.argsSummary.path).toMatch(/ordinary/);
    expect(read.argsSummary.range).toMatch(/1-7/);
    expect(read.argsSummary.fingerprint).toMatch(/^sha256:/);
    expect(fs.readFileSync(path.join(repo, 'index.js'), 'utf8')).toContain("require('./lib/ordinary')");
    const changed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    expect(changed).toContain('index.js');
  }, 30_000);
});
