import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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

const TOKEN = generateToken();

const FOOTER_BASELINE = [
  '<html>',
  '<body>',
  '<div id="cookie-consent">',
  '  <p>We use cookies.</p>',
  '  <button>Accept</button>',
  '</div>',
  '<footer>&copy; 2025 Kha Ke Dikha. All rights reserved.</footer>',
  '</body>',
  '</html>',
  '',
].join('\n');

const FOOTER_TASK = 'Update the footer copyright year in templates/base.html from 2025 to 2026. '
  + 'Do not change anything else in the file. Make an anchored edit, validate, review the diff, and commit locally. Do not push.';

function initRepo(repo: string) {
  fs.mkdirSync(path.join(repo, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'templates', 'base.html'), FOOTER_BASELINE, 'utf8');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'footer-fixture', private: true, scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2), 'utf8');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@local',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@local',
  };
  execFileSync('git', ['init'], { cwd: repo, env });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'add', '-A'], { cwd: repo, env });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'initial footer fixture'], { cwd: repo, env });
}

/**
 * Scripts the model side of a footer-year mission: propose an anchored edit
 * immediately (no frozen edit is wired into request submission yet — see
 * `core/runtime/missionAuthorization.ts`'s `MissionFrozenEdit` docs — so this
 * always goes through human diff review, exactly like an unmatched
 * `propose_file_change`), then progress through diff review, commit, and
 * finish once the evidence line in the compacted system prompt says so.
 */
class FooterTextEditBackend implements ModelBackend {
  requests: ModelChatRequest[] = [];
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push(request);
    const compact = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const empty = { content: '', provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    if (compact.includes('delivery=local_commit') || /commit=[0-9a-f]{7,}/i.test(compact)) {
      return { ...empty, content: 'finishing', toolCalls: [{ name: 'finish', arguments: { summary: 'footer year updated to 2026, validated, reviewed, committed' } }] };
    }
    if (compact.includes('diffReview=pass') && compact.includes('validation=pass')) {
      return { ...empty, content: 'commit', toolCalls: [{ name: 'run_check', arguments: { check: 'commit' } }] };
    }
    if (compact.includes('mutation=approved') && compact.includes('validation=pass')) {
      return { ...empty, content: 'diff', toolCalls: [{ name: 'run_check', arguments: { check: 'diff' } }] };
    }
    return {
      ...empty,
      content: 'propose',
      toolCalls: [{ name: 'propose_text_edit', arguments: { path: 'templates/base.html', find: '&copy; 2025', replace: '&copy; 2026' } }],
    };
  }
}

describe('Core-owned propose_text_edit mission loop', () => {
  const token = TOKEN;
  let dir: string;
  let repo: string;
  let db: CoreDatabase;
  let api: RunningApiServer;
  let ws: { close(): void };
  let backend: FooterTextEditBackend;
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
  const idemp = () => `idemp-text-edit-${++n}`;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-text-edit-core-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-text-edit-repo-'));
    initRepo(repo);
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    backend = new FooterTextEditBackend();
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

  it('anchored-edits the footer year, validates, reviews a one-line diff, and commits only templates/base.html', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const submitted = submitRequest(db, {
      clientId: 'test-client',
      currentMessage: FOOTER_TASK,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: repo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: idemp(),
      toolPermissionPolicy: { profile: 'autonomous-mission' },
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

    let approvedTextEditDiff: string | undefined;
    const deadline = Date.now() + 25_000;
    let attempt: any;
    while (Date.now() < deadline) {
      attempt = await (await authedFetch(`/v1/attempts/${submitted.attempt.id}`)).json();
      if (attempt.status === 'waiting_for_approval') {
        const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`)).json();
        const action = snapshot.actions.find((item: any) => item.actionable);
        if (!action || (action.toolName !== 'authorize_mission' && action.toolName !== 'propose_text_edit')) continue;
        if (action.toolName === 'propose_text_edit' && action.presentation?.diff) {
          approvedTextEditDiff = action.presentation.diff as string;
        }
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

    const tools = (await (await authedFetch(`/v1/attempts/${submitted.attempt.id}/tool-invocations`)).json()).toolInvocations;
    expect(attempt.status, JSON.stringify({ status: attempt.status, failureReason: attempt.failureReason, tools }, null, 2)).toBe('completed');

    // The model never sent full file content — only path/find/replace — and
    // Core computed the result itself, leaving the cookie-consent banner and
    // every other line byte-for-byte unchanged.
    const finalContent = fs.readFileSync(path.join(repo, 'templates', 'base.html'), 'utf8');
    expect(finalContent).toBe(FOOTER_BASELINE.replace('&copy; 2025', '&copy; 2026'));
    expect(finalContent).toContain('<p>We use cookies.</p>');
    expect(finalContent).toContain('<button>Accept</button>');

    // The approval card's diff (generated by Core, before approval) shows
    // exactly one removed line and one added line.
    expect(approvedTextEditDiff).toBeTruthy();
    const removed = (approvedTextEditDiff ?? '').split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
    const added = (approvedTextEditDiff ?? '').split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);

    // The final commit contains only templates/base.html.
    const changed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo, encoding: 'utf8' })
      .split('\n').map((line) => line.trim()).filter(Boolean);
    expect(changed).toEqual(['templates/base.html']);

    // The mutation's own tool invocation lives on the capability anchor
    // attempt Core creates for it (`core/domain/capabilityDispatch.ts`), not
    // on the mission attempt directly — mirroring `propose_file_change` in
    // `missionCrossfile.test.ts`. The mission attempt's own tool-invocation
    // stream carries the post-mutation validation and typed checks.
    const names = tools.map((item: any) => item.toolName);
    expect(names).toContain('workspace_validation');
    expect(names).toContain('run_check');
  }, 30_000);
});
