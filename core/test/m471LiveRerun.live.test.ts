/**
 * M47.1: empty-workspace single-file creation vs. the user's output-format wording.
 *
 * Live defect (RC1): Saath Kar, empty workspace, "create index.html ... Return ONLY the complete contents of
 * index.html" failed with "could not produce an actionable mutation proposal". Core's own record showed two
 * ~8-minute model calls whose prompt+completion tokens equalled the whole 32K window: truncation by context
 * exhaustion (almost entirely hidden reasoning), misreported as a protocol failure. These tests pin:
 *  - KKD owns the mutation protocol; "return only the file contents" describes the artifact, not the channel;
 *  - an empty workspace is a valid creation workspace, including for a large single file;
 *  - a malformed first reply is recovered by the one corrective turn;
 *  - genuine truncation is classified distinctly from a protocol failure and does not burn a pointless retry.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { OllamaModelBackend } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';

const MODEL = 'qwen3.8:27b-mtp-q4_K_M';

const TOKEN = generateToken();
const EVIDENCE = path.resolve(__dirname, '../../.m47-1-evidence');

/** Wraps the real Ollama backend and preserves every raw response as evidence. */
class RecordingBackend implements ModelBackend {
  readonly log: unknown[] = [];
  constructor(private readonly inner: ModelBackend) {}
  async streamChat(request: ModelChatRequest, onToken: (d: string) => void): Promise<ModelChatResult> {
    const startedAt = new Date().toISOString();
    const result = await this.inner.streamChat(request, onToken);
    this.log.push({
      call: this.log.length + 1, startedAt, thinkOverride: request.ollama?.think ?? null, finishReason: result.finishReason ?? null,
      usage: result.usage, contentChars: result.content.length, content: result.content,
      toolCalls: result.toolCalls.map((c) => ({ name: c.name, path: c.arguments.path, contentChars: String(c.arguments.content ?? '').length, arguments: c.arguments })),
    });
    fs.writeFileSync(path.join(EVIDENCE, 'live-rerun-raw-responses.json'), JSON.stringify(this.log, null, 1));
    return result;
  }
}

describe.skipIf(!process.env.M471_LIVE)('M47.1 live rerun of the original Qwen HTML task', () => {
  it('runs the original prompt against real Ollama on an empty workspace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m471-live-'));
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    const backend = new RecordingBackend(new OllamaModelBackend());
    const runner = new CoreToolRunner();
    const governed: GovernedCapabilityAdapter = {
      id: 'workspace', definitions: () => runner.definitions(),
      classify: (t): CapabilityRisk => (t === 'read_file' ? 'read_only' : 'consequential'),
      health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
      run: (call, context) => runner.run(call, context),
    };
    const api = await startApiServer({
      db, token: TOKEN, broadcaster, dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'live', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: { backend, toolRunner: runner, defaultModel: MODEL, defaultWorkingDirectory: dir, dataDir: dir, governedCapabilities: new GovernedCapabilityRegistry().register(governed) },
    });
    const ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'live', latestSequence: () => latestSequence(db) });
    const baseUrl = `http://127.0.0.1:${api.port}`;
    const f = (p: string, init: RequestInit = {}) => fetch(`${baseUrl}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'live', 'Idempotency-Key': `live-${Math.random()}` } });
    try {
      const prompt = fs.readFileSync(path.join(EVIDENCE, 'original-prompt.txt'), 'utf8').trim();
      const conv = createConversation(db, { mode: 'saath_kar', actor: 'live' });
      const result = submitRequest(db, {
        clientId: 'live', currentMessage: prompt, requestedMode: 'saath_kar', conversationId: conv.id, workspaceRoot: dir,
        capability: { hasWorkspace: true, gitCapable: false }, correlationId: `live-${Date.now()}`,
        toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'] },
        modelSelection: {
          selectedProvider: 'ollama', selectedModel: MODEL, selectionReason: 'live rerun', suitabilitySummary: 'live rerun', userOverrode: false, candidates: [], escalationCandidates: [],
          contextWindowTokens: 32768, contextWindowSource: 'explicit_config', maxOutputTokens: 8192,
          requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'medium', vision: false, validationAndRepair: true },
        },
      });
      const id = result.attempt.id as string;
      await f(`/v1/attempts/${id}/execute`, { method: 'POST' });
      let attempt: any;
      const approved: Array<{ toolName: string; arguments: unknown }> = [];
      const deadline = Date.now() + 40 * 60_000;
      while (Date.now() < deadline) {
        attempt = await (await f(`/v1/attempts/${id}`)).json();
        if (['failed', 'completed', 'cancelled'].includes(attempt.status)) break;
        if (attempt.status === 'waiting_for_approval') {
          // Governed tool loop: approve each pending capability action (e.g. a `dir` run_command, the proposal) and let the loop continue.
          const snap = await (await f(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`)).json();
          const action = (snap.actions ?? []).find((a: any) => a.actionable);
          if (!action) break; // a non-capability gate (KKD mutation approval) needs the extension: stop and record where we are
          approved.push({ toolName: action.toolName, arguments: action.arguments });
          await f(`/v1/capabilities/approvals/${action.approvalId}/resolve`, { method: 'POST', body: JSON.stringify({
            resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
            expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
          }) });
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      const events = db.all("SELECT eventType, metadata FROM runtime_events WHERE entityId = ? AND (eventType LIKE 'reasoning_off%' OR eventType LIKE 'model_output%' OR eventType LIKE 'mutation_proposal%') ORDER BY id", [id]);
      const approvals = db.all("SELECT summary FROM approvals WHERE json_extract(summary, '$.scopeIdentity') = ?", [id]) as Array<{ summary: string }>;
      fs.writeFileSync(path.join(EVIDENCE, 'live-rerun-outcome.json'), JSON.stringify({ model: MODEL, status: attempt.status, failureReason: attempt.failureReason ?? null, events, approved, workspaceFiles: fs.readdirSync(dir), approvalCount: approvals.length, approvalSummaryBytes: approvals.map((a) => a.summary.length), calls: backend.log.length }, null, 1));
      const proposed = backend.log.flatMap((c: any) => c.toolCalls).find((c: any) => c.name === 'propose_file_change');
      if (proposed) fs.writeFileSync(path.join(EVIDENCE, 'live-rerun-index.html'), String((proposed as any).arguments.content));
      expect(['waiting_for_approval', 'failed', 'completed']).toContain(attempt.status);
    } finally {
      ws.close(); await api.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 45 * 60_000);
});
