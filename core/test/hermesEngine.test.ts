import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { createAttempt, getAttempt } from '../domain/attempts';
import { createRequest } from '../domain/requests';
import { createConversation } from '../domain/conversations';
import { getApproval, resolveApproval } from '../domain/approvals';
import { listArtifactsForAttempt } from '../domain/artifacts';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import { listRuntimeEventsForAttempt, recordRuntimeEvent } from '../domain/runtimeEvents';
import {
  HermesEngine,
  HermesEngineAdapter,
  DEFAULT_HERMES_URL,
} from '../runtime/hermesEngine';
import { EngineRegistry } from '../runtime/adapters/EngineAdapter';
import { RuntimeExecutor } from '../runtime/executor';

describe('HermesEngine & HermesEngineAdapter', () => {
  let openedDb: ReturnType<typeof openCoreDatabase>;
  let db: CoreDatabase;
  let broadcaster: EventBroadcaster;
  let tempDir: string;
  let mockServer: http.Server | null = null;
  let mockServerPort = 0;
  let mockServerBaseUrl = '';
  let mockRuns: Map<string, any>;
  let mockApprovals: Map<string, any>;
  let mockCapabilities: any;
  let serverRequests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body?: any }>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-hermes-test-'));
    openedDb = openCoreDatabase(path.join(tempDir, 'core.db'));
    db = openedDb.db;
    broadcaster = new EventBroadcaster();
    mockRuns = new Map();
    mockApprovals = new Map();
    serverRequests = [];
    mockCapabilities = {
      capabilities: {
        runs: true,
        tools: true,
        skills: true,
        version: '1.0.0',
      },
      models: ['qwen3-coder:swift-27b', 'hermes-3-llama-3.1-8b'],
    };

    // Spin up lightweight mock Hermes HTTP server
    await new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        let bodyRaw = '';
        req.on('data', (c) => (bodyRaw += c));
        req.on('end', () => {
          let parsedBody: any;
          try {
            parsedBody = JSON.parse(bodyRaw);
          } catch {}

          serverRequests.push({
            method: req.method || 'GET',
            url: req.url || '/',
            headers: req.headers,
            body: parsedBody,
          });

          const url = req.url || '';

          // GET /v1/capabilities
          if (url === '/v1/capabilities' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mockCapabilities));
            return;
          }

          // POST /v1/runs
          if (url === '/v1/runs' && req.method === 'POST') {
            const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const runData = {
              id: runId,
              status: 'running',
              prompt: parsedBody?.prompt,
              model: parsedBody?.model,
              workspaceRoot: parsedBody?.workspace_root,
              idempotencyKey: req.headers['idempotency-key'] || parsedBody?.idempotency_key,
              output: 'Hermes execution completed successfully.',
              modifiedFiles: parsedBody?.workspace_root
                ? [path.join(parsedBody.workspace_root, 'hermes_output.txt')]
                : ['output.txt'],
            };
            mockRuns.set(runId, runData);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: runId, status: 'running' }));
            return;
          }

          // GET /v1/runs/:id/events (SSE)
          if (url.match(/^\/v1\/runs\/[^/]+\/events$/) && req.method === 'GET') {
            const parts = url.split('/');
            const runId = parts[3];
            const run = mockRuns.get(runId);

            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });

            // Send events
            res.write(`data: ${JSON.stringify({ type: 'token', delta: 'Analyzing objective with Hermes skills.\n' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'tool_call', call_id: 'c1', tool: 'search_files', args: { pattern: '*.ts' } })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'tool_result', call_id: 'c1', tool: 'search_files', output: ['app.ts', 'index.ts'], success: true })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'token', delta: 'Task finished cleanly.' })}\n\n`);
            res.write(`data: ${JSON.stringify({
              type: 'run_finish',
              status: 'completed',
              output: 'Hermes multi-tool task completed.',
              modified_files: run?.modifiedFiles || [],
            })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
          }

          // POST /v1/runs/:id/approval
          if (url.match(/^\/v1\/runs\/[^/]+\/approval$/) && req.method === 'POST') {
            const parts = url.split('/');
            const runId = parts[3];
            mockApprovals.set(runId, parsedBody);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: 'approved' }));
            return;
          }

          // POST /v1/runs/:id/stop
          if (url.match(/^\/v1\/runs\/[^/]+\/stop$/) && req.method === 'POST') {
            const parts = url.split('/');
            const runId = parts[3];
            const run = mockRuns.get(runId);
            if (run) run.status = 'cancelled';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: 'cancelled' }));
            return;
          }

          // GET /v1/runs/:id
          if (url.match(/^\/v1\/runs\/[^/]+$/) && req.method === 'GET') {
            const parts = url.split('/');
            const runId = parts[3];
            const run = mockRuns.get(runId);
            if (!run) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Run not found' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(run));
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        });
      });

      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer!.address() as any;
        mockServerPort = addr.port;
        mockServerBaseUrl = `http://127.0.0.1:${mockServerPort}`;
        process.env.HERMES_URL = mockServerBaseUrl;
        process.env.HERMES_ENABLED = 'true';
        process.env.HERMES_API_KEY = 'test-hermes-secret-key';
        resolve();
      });
    });
  });

  afterEach(async () => {
    delete process.env.HERMES_URL;
    delete process.env.HERMES_ENABLED;
    delete process.env.HERMES_API_KEY;
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
    }
    try {
      openedDb.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('registers Hermes in EngineRegistry with role specialist and real name', () => {
    const hermes = EngineRegistry.get('hermes');
    expect(hermes).toBeDefined();
    expect(hermes?.id).toBe('hermes');
    expect(hermes?.role).toBe('specialist');
    expect(hermes?.name).toBe('Hermes Agent');
  });

  it('discovers Hermes and verifies /v1/capabilities', async () => {
    const check = await HermesEngine.checkCapabilities();
    expect(check.available).toBe(true);
    expect(check.capabilities?.runs).toBe(true);
    expect(check.capabilities?.models).toContain('qwen3-coder:swift-27b');

    // Verify headers included Bearer authentication
    const capReq = serverRequests.find((r) => r.url === '/v1/capabilities');
    expect(capReq).toBeDefined();
    expect(capReq?.headers.authorization).toBe('Bearer test-hermes-secret-key');
  });

  it('fails closed when Hermes is disabled via HERMES_ENABLED=false', async () => {
    process.env.HERMES_ENABLED = 'false';
    const check = await HermesEngine.checkCapabilities();
    expect(check.available).toBe(false);
    expect(check.error).toContain('disabled');

    const adapter = new HermesEngineAdapter();
    const isAvail = await adapter.isAvailable();
    expect(isAvail).toBe(false);
  });

  function makeTestRequest(convoId: string, message: string) {
    return createRequest(db, {
      conversationId: convoId,
      clientId: 'test-client',
      currentMessage: message,
      requestedMode: 'karke_dikha',
      resolvedMode: 'karke_dikha',
      routeReason: 'test',
      correlationId: `corr-${Date.now()}-${Math.random()}`,
      actor: 'test',
      contextPolicy: {
        includeConversationHistory: true,
        includeProjectContext: false,
        includeRepositoryContext: false,
        includeGlobalStoryContext: false,
      },
    });
  }

  it('submits a task via /v1/runs with idempotency key and attempt binding', async () => {
    const convo = createConversation(db, { title: 'Hermes test conversation', mode: 'karke_dikha', actor: 'test' });
    const req = makeTestRequest(convo.id, 'Generate a greeting module');
    const attempt = createAttempt(db, {
      requestId: req.id,
      kind: 'karke_dikha',
      actor: 'test',
    });

    const workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });

    const result = await HermesEngine.executeHermesRun({
      db,
      broadcaster,
      attemptId: attempt.id,
      requestId: req.id,
      conversationId: convo.id,
      workspaceRoot: workspaceDir,
      prompt: req.currentMessage,
      fenceToken: 'fence-1',
    });

    expect(result.success).toBe(true);
    expect(result.reply).toContain('Hermes');

    // Verify Hermes POST /v1/runs was called with proper headers and payload
    const runReq = serverRequests.find((r) => r.url === '/v1/runs' && r.method === 'POST');
    expect(runReq).toBeDefined();
    expect(runReq?.headers['idempotency-key']).toBe(`kkd:attempt:${attempt.id}`);
    expect(runReq?.body.prompt).toBe('Generate a greeting module');
    expect(runReq?.body.idempotency_key).toBe(`kkd:attempt:${attempt.id}`);

    // Verify hermes_run_bound runtime event was recorded in KKD
    const events = listRuntimeEventsForAttempt(db, attempt.id);
    const boundEvent = events.find((e) => e.eventType === 'hermes_run_bound');
    expect(boundEvent).toBeDefined();
    expect(boundEvent?.metadata?.idempotencyKey).toBe(`kkd:attempt:${attempt.id}`);
    expect(boundEvent?.metadata?.runId).toBeDefined();

    // Verify attempt reached completed status
    const updatedAttempt = getAttempt(db, attempt.id);
    expect(updatedAttempt.status).toBe('completed');
  });

  it('streams tool calls and maps them into KKD tool invocations', async () => {
    const convo = createConversation(db, { title: 'Multi-tool test', mode: 'karke_dikha', actor: 'test' });
    const req = makeTestRequest(convo.id, 'Analyze code and report');
    const attempt = createAttempt(db, {
      requestId: req.id,
      kind: 'karke_dikha',
      actor: 'test',
    });

    let tokenBroadcasted = false;
    broadcaster.publishRuntimeToken = vi.fn((ev) => {
      if (ev.delta) tokenBroadcasted = true;
    });

    const result = await HermesEngine.executeHermesRun({
      db,
      broadcaster,
      attemptId: attempt.id,
      requestId: req.id,
      conversationId: convo.id,
      prompt: req.currentMessage,
      fenceToken: 'fence-1',
    });

    expect(result.success).toBe(true);
    expect(tokenBroadcasted).toBe(true);

    // Verify tool invocation was recorded in KKD database
    const invocations = listToolInvocationsForAttempt(db, attempt.id);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations[0].toolName).toBe('search_files');
    expect(invocations[0].status).toBe('succeeded');
  });

  it('handles cancellation and calls POST /v1/runs/:id/stop', async () => {
    const convo = createConversation(db, { title: 'Cancel test', mode: 'karke_dikha', actor: 'test' });
    const req = makeTestRequest(convo.id, 'Long running task');
    const attempt = createAttempt(db, {
      requestId: req.id,
      kind: 'karke_dikha',
      actor: 'test',
    });

    const abortController = new AbortController();
    abortController.abort(); // Cancel immediately

    const result = await HermesEngine.executeHermesRun({
      db,
      broadcaster,
      attemptId: attempt.id,
      requestId: req.id,
      conversationId: convo.id,
      prompt: req.currentMessage,
      fenceToken: 'fence-1',
      signal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('aborted');

    const updated = getAttempt(db, attempt.id);
    // A turn the user stopped is settled as `cancelled`, never `failed`: a failed
    // attempt is eligible for Auto reroute, which would silently restart the work
    // the user just stopped. The terminal edge must exist from every non-terminal
    // state — settling straight from `running` is refused, so the attempt hops
    // through `cancelling` first.
    expect(updated.status).toBe('cancelled');
    expect(updated.cancelledAt).toBeTruthy();
    expect(updated.failureReason).toBeNull();
  });

  it('reconciles interrupted runs safely without duplicate execution', async () => {
    const convo = createConversation(db, { title: 'Reconcile test', mode: 'karke_dikha', actor: 'test' });
    const req = makeTestRequest(convo.id, 'Interrupted task');
    const attempt = createAttempt(db, {
      requestId: req.id,
      kind: 'karke_dikha',
      actor: 'test',
    });

    // Simulate an attempt interrupted during execution with a bound Hermes run
    const fakeRunId = 'run_interrupted_123';
    mockRuns.set(fakeRunId, {
      id: fakeRunId,
      status: 'completed',
      output: 'Finished while KKD was restarting',
    });

    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: attempt.id,
      eventType: 'hermes_run_bound',
      actor: 'karkedikha:hermes',
      metadata: { runId: fakeRunId, idempotencyKey: `kkd:attempt:${attempt.id}` },
    });

    const reconciliation = await HermesEngine.reconcileInterruptedRun(attempt.id, db, broadcaster);
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.status).toBe('completed');

    // Case 2: Unknown / uncertain run -> fail closed without repeating
    const unknownReq = makeTestRequest(convo.id, 'Uncertain task');
    const unknownAttempt = createAttempt(db, {
      requestId: unknownReq.id,
      kind: 'karke_dikha',
      actor: 'test',
    });
    mockRuns.set('run_uncertain', {
      id: 'run_uncertain',
      status: 'unknown',
    });
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: unknownAttempt.id,
      eventType: 'hermes_run_bound',
      actor: 'karkedikha:hermes',
      metadata: { runId: 'run_uncertain' },
    });

    const uncertainRec = await HermesEngine.reconcileInterruptedRun(unknownAttempt.id, db, broadcaster);
    expect(uncertainRec.reconciled).toBe(false);
    expect(uncertainRec.reason).toContain('uncertain; will not repeat automatically');
  });

  it('handles human approval request loop for file modification', async () => {
    // Override SSE endpoint for approval scenario
    const approvalRunId = 'run_with_approval';
    mockRuns.set(approvalRunId, { id: approvalRunId, status: 'running' });

    // Custom handler on mock server
    mockServer!.removeAllListeners('request');
    mockServer!.on('request', (req, res) => {
      let bodyRaw = '';
      req.on('data', (c) => (bodyRaw += c));
      req.on('end', () => {
        const url = req.url || '';
        if (url === '/v1/capabilities') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(mockCapabilities));
          return;
        }
        if (url === '/v1/runs' && req.method === 'POST') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: approvalRunId, status: 'running' }));
          return;
        }
        if (url.match(/^\/v1\/runs\/[^/]+\/approval$/)) {
          const body = JSON.parse(bodyRaw);
          mockApprovals.set(approvalRunId, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.match(/^\/v1\/runs\/[^/]+\/events$/)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({
            type: 'approval_request',
            tool: 'write_file',
            files: ['src/config.ts'],
            prompt: 'May I update src/config.ts with new settings?',
          })}\n\n`);

          // Wait a tick, then finish
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({
              type: 'run_finish',
              status: 'completed',
              output: 'File updated successfully after approval.',
              modified_files: ['src/config.ts'],
            })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
          }, 300);
          return;
        }
        if (url.match(/^\/v1\/runs\/[^/]+$/)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: approvalRunId, status: 'completed', output: 'Done' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    const convo = createConversation(db, { title: 'Approval test', mode: 'karke_dikha', actor: 'test' });
    const req = makeTestRequest(convo.id, 'Update config');
    const attempt = createAttempt(db, {
      requestId: req.id,
      kind: 'karke_dikha',
      actor: 'test',
    });

    // Auto-approve in background when approval is created
    const interval = setInterval(() => {
      const curAttempt = getAttempt(db, attempt.id);
      if (curAttempt.status === 'waiting_for_approval') {
        const row = db.get<{ id: string }>(`SELECT id FROM approvals WHERE attemptId = ? AND status = 'pending'`, [attempt.id]);
        if (row?.id) {
          const approval = getApproval(db, row.id);
          resolveApproval(db, row.id, {
            resolution: 'approved',
            attemptId: approval.attemptId,
            gate: approval.kind,
            expectedAttemptRevision: approval.expectedAttemptRevision,
            expectedAttemptStatus: approval.expectedAttemptStatus,
            requestedActionDigest: approval.requestedActionDigest,
            frozenContextHash: approval.frozenContextHash,
            expectedRevision: approval.revision,
            actor: 'operator',
            clientId: 'client-1',
          });
          clearInterval(interval);
        }
      }
    }, 50);

    const result = await HermesEngine.executeHermesRun({
      db,
      broadcaster,
      attemptId: attempt.id,
      requestId: req.id,
      conversationId: convo.id,
      prompt: req.currentMessage,
      fenceToken: 'fence-1',
    });

    clearInterval(interval);
    expect(result.success).toBe(true);
    expect(mockApprovals.get(approvalRunId)?.decision).toBe('approved');
  });

  it('capability-aware engine selection correctly routes to Hermes, OpenCode, and Pi', async () => {
    const executor = new RuntimeExecutor(db, broadcaster);

    // 1. Explicit worker: 'hermes' routes to hermes when available
    const hermesContext: any = {
      approvalPolicy: { worker: 'hermes' },
      modelSelection: { requiredCapabilities: {} },
    };
    const engine1 = await (executor as any).selectEngine(hermesContext, 'karke_dikha');
    expect(engine1).toBe('hermes');

    // 2. Explicit worker: 'pi' routes to pi
    const piContext: any = {
      approvalPolicy: { worker: 'pi' },
      modelSelection: { requiredCapabilities: {} },
    };
    const engine2 = await (executor as any).selectEngine(piContext, 'baat_kar');
    expect(engine2).toBe('pi');

    // 3. Autonomous skills / specialist capability routes to hermes
    const specialistContext: any = {
      modelSelection: {
        requiredCapabilities: {
          specialist: true,
        },
      },
    };
    const engine3 = await (executor as any).selectEngine(specialistContext, 'karke_dikha');
    expect(engine3).toBe('hermes');

    // 4. Default conversation routes to pi
    const generalContext: any = {
      modelSelection: { requiredCapabilities: {} },
    };
    const engine4 = await (executor as any).selectEngine(generalContext, 'baat_kar');
    expect(engine4).toBe('pi');
  });
});
