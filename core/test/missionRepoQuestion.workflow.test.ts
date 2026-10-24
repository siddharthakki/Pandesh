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
import { createConversation, listMessages } from '../domain/conversations';
import { OllamaModelBackend } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter } from '../runtime/governedCapability';
import { listModelInvocationsForAttempt } from '../domain/modelInvocations';
import { LOCAL_CORE_QUESTION_PROFILE } from '../runtime/localCoreQuestion';

const enabled = process.env.KARKEDIKHA_LIVE_REPO_QUESTION === '1';
const MODEL = process.env.KARKEDIKHA_DEFAULT_MODEL || 'qwen3.8:27b-mtp-q4_K_M';
const EVIDENCE = path.join(process.cwd(), '.tmp', 'repo-question-workflow.json');
const REPO_ROOT = process.cwd();

/**
 * Same question the packaged Desktop "Local Core" proof asks
 * (apps/desktop/scripts/drive-local-core-question.mjs) — it names Core's
 * delivery-manifest, diff-review, and mission-loop modules under
 * core/runtime, so a correct answer requires reading at least three current
 * files there and citing them.
 */
const QUESTION = [
  'In the current KarkeDikha Core delivery path under core/runtime, not the legacy VS Code extension code,',
  'which module builds the authorized changed-file manifest that a mission is allowed to commit,',
  'and how does the review digest stop a file changed after diff review from reaching the commit?',
  'Cite the files you read.',
].join(' ');

const EXPECTED_MODULES = ['missiondeliverymanifest', 'missiondiffreview', 'missionloop'];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/** Parses citations out of Core's own `formatLocalCoreAnswer` text — the
 * durable text stored as the tool invocation's evidence and as the delivered
 * assistant message, not a re-parse of anything the model said unverified. */
function parseCitedReferences(answerText: string): Array<{ path: string; startLine?: number; endLine?: number }> {
  const marker = answerText.indexOf('References (');
  if (marker < 0) return [];
  const tail = answerText.slice(marker);
  const refs: Array<{ path: string; startLine?: number; endLine?: number }> = [];
  for (const line of tail.split(/\r?\n/)) {
    const match = /^-\s+(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(line.trim());
    if (!match) continue;
    refs.push({
      path: match[1],
      startLine: match[2] ? Number(match[2]) : undefined,
      endLine: match[3] ? Number(match[3]) : undefined,
    });
  }
  return refs;
}

describe.skipIf(!enabled)('live Core-owned repository question with citations (local Ollama)', () => {
  it('answers a repo question, cites only files it actually read, and mutates nothing', async () => {
    const startedAt = Date.now();
    const token = generateToken();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-repo-question-live-core-'));
    const liveRepo = path.join(process.cwd(), '.tmp', 'repo-question-live');
    fs.rmSync(liveRepo, { recursive: true, force: true });
    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });

    const productHead = git(['rev-parse', 'HEAD'], REPO_ROOT);
    execFileSync('git', ['clone', '--no-hardlinks', '--quiet', REPO_ROOT, liveRepo]);
    git(['checkout', '--quiet', productHead], liveRepo);
    git(['remote', 'remove', 'origin'], liveRepo);
    git(['config', 'user.email', 'proof@localhost'], liveRepo);
    git(['config', 'user.name', 'Repo Question Proof'], liveRepo);
    const baselineHead = git(['rev-parse', 'HEAD'], liveRepo);
    const baselineStatus = git(['status', '--porcelain', '--untracked-files=all'], liveRepo);
    expect(baselineStatus).toBe('');

    const db = openCoreDatabase(path.join(dataDir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    const api = await startApiServer({
      db, token, broadcaster, dataDir,
      coreInfo: () => ({
        coreVersion: '0.1.0', apiVersion: 1, instanceId: 'live-repo-question', startedAt: new Date().toISOString(),
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
    const ws = attachWsServer({ httpServer: api.server, token, broadcaster, instanceId: 'live-repo-question', latestSequence: () => latestSequence(db) });
    const baseUrl = `http://127.0.0.1:${api.port}`;
    let n = 0;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Client-Id': 'live-repo-question-client',
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

    const conv = createConversation(db, { mode: 'saath_kar', actor: 'live-repo-question' });
    const submitted = submitRequest(db, {
      clientId: 'live-repo-question-client',
      currentMessage: QUESTION,
      requestedMode: 'saath_kar',
      conversationId: conv.id,
      workspaceRoot: liveRepo,
      capability: { hasWorkspace: true, gitCapable: true },
      correlationId: `live-repo-question-${Date.now()}`,
      toolPermissionPolicy: { profile: LOCAL_CORE_QUESTION_PROFILE },
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
          readOnlyExplanation: true, repositoryExploration: true, toolCalling: true, fileModification: false,
          codingComplexity: 'low', contextRequirement: 'medium', vision: false, validationAndRepair: false,
        },
      },
    });
    await authed(`/v1/attempts/${submitted.attempt.id}/execute`, { method: 'POST', idempotencyKey: `exec-${++n}` });

    // Local Core's tool set has no mutating action, so no approval should ever
    // be requested. Any that appears is denied and recorded as an anomaly —
    // never silently approved — and fails the assertions below.
    const anomalies: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 20 * 60_000;
    let attempt: any;
    while (Date.now() < deadline) {
      attempt = await jsonOf(await authed(`/v1/attempts/${submitted.attempt.id}`));
      if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled') break;
      if (attempt.status === 'waiting_for_approval') {
        const snapshot = await jsonOf(await authed(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`));
        const action = (snapshot.actions ?? []).find((item: any) => item.actionable);
        if (action) {
          anomalies.push({ toolName: action.toolName, at: new Date().toISOString() });
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
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const tools = (await jsonOf(await authed(`/v1/attempts/${submitted.attempt.id}/tool-invocations`))).toolInvocations ?? [];
    const actions = tools.map((item: any) => ({
      action: item.toolName,
      path: item.argsSummary?.path ?? null,
      query: item.argsSummary?.query ?? null,
      range: item.argsSummary?.range ?? null,
      fingerprint: item.argsSummary?.fingerprint ?? null,
      cached: Boolean(item.argsSummary?.cached),
      ok: item.status === 'succeeded',
      output: String(item.evidence?.output ?? ''),
    }));

    const successfulReads = actions.filter((item: any) => item.action === 'read_file' && item.ok);
    const answerAction = actions.find((item: any) => item.action === 'answer' && item.ok);
    const citedReferences = answerAction ? parseCitedReferences(answerAction.output) : [];
    const readKeys = new Set(successfulReads.map((item: any) => normalizePath(String(item.path ?? ''))));
    const unsupportedCitations = citedReferences.filter((ref) => !readKeys.has(normalizePath(ref.path)));
    const citedCoreRuntimeFiles = [...new Set(
      citedReferences
        .map((ref) => normalizePath(ref.path))
        .filter((p) => p.startsWith('core/runtime/')),
    )];
    const expectedModulesCited = EXPECTED_MODULES.filter((mod) => citedCoreRuntimeFiles.some((p) => p.replace(/[^a-z0-9]/g, '').includes(mod)));

    const mutationToolNames = ['propose_file_change', 'propose_text_edit', 'run_check', 'authorize_mission', 'run_command'];
    const mutationAttempts = actions.filter((item: any) => mutationToolNames.includes(item.action));

    const afterStatus = git(['status', '--porcelain', '--untracked-files=all'], liveRepo);
    const afterHead = git(['rev-parse', 'HEAD'], liveRepo);

    const invocations = listModelInvocationsForAttempt(db, submitted.attempt.id);
    const turns = invocations.map((inv) => ({
      status: inv.status,
      latencyMs: inv.latencyMs,
      promptTokens: (inv.usageMetadata as any)?.promptTokens ?? null,
      completionTokens: (inv.usageMetadata as any)?.completionTokens ?? null,
      generationMs: (inv.usageMetadata as any)?.generationMs ?? null,
    }));
    const totalCompletionTokens = turns.reduce((sum, t) => sum + (t.completionTokens ?? 0), 0);
    const totalGenerationMs = turns.reduce((sum, t) => sum + (t.generationMs ?? 0), 0);
    const totalPromptTokens = turns.reduce((sum, t) => sum + (t.promptTokens ?? 0), 0);
    const repeatedReads = actions.filter((item: any) => item.action === 'read_file' && item.cached).length;
    const protocolCorrections = actions.filter((item: any) => !item.ok).length;

    const conversationMessages = listMessages(db, conv.id);
    const finalAnswer = conversationMessages.filter((m) => m.role === 'assistant').at(-1)?.content ?? '';

    const evidence = {
      requestId: submitted.request.id,
      attemptId: submitted.attempt.id,
      model: MODEL,
      question: QUESTION,
      attemptStatus: attempt?.status,
      failureReason: attempt?.failureReason ?? null,
      elapsedMs: Date.now() - startedAt,
      turnCount: invocations.length,
      turns,
      totalPromptTokens,
      totalCompletionTokens,
      totalGenerationMs,
      tokensPerSecond: totalGenerationMs > 0 ? Number(((totalCompletionTokens / totalGenerationMs) * 1000).toFixed(2)) : null,
      repeatedReads,
      protocolCorrections,
      anomalies,
      actions,
      successfulReadCount: successfulReads.length,
      citedReferences,
      unsupportedCitations,
      citedCoreRuntimeFiles,
      expectedModulesCited,
      mutationAttempts,
      baselineHead,
      afterHead,
      repositoryUnchanged: afterHead === baselineHead && afterStatus === '',
      finalAnswer,
    };
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2), 'utf8');

    ws.close();
    await api.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(liveRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

    expect(evidence.attemptStatus, JSON.stringify(evidence, null, 2)).toBe('completed');
    expect(evidence.anomalies.length, JSON.stringify(evidence, null, 2)).toBe(0);
    expect(evidence.mutationAttempts.length, JSON.stringify(evidence, null, 2)).toBe(0);
    expect(evidence.repositoryUnchanged, JSON.stringify(evidence, null, 2)).toBe(true);
    expect(evidence.unsupportedCitations.length, JSON.stringify(evidence, null, 2)).toBe(0);
    expect(evidence.citedCoreRuntimeFiles.length, JSON.stringify(evidence, null, 2)).toBeGreaterThanOrEqual(3);
    expect(evidence.expectedModulesCited.length, JSON.stringify(evidence, null, 2)).toBeGreaterThanOrEqual(3);
  }, 21 * 60_000);
});
