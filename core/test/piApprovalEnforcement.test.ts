import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { startScriptedOllama, afterToolResult, type ScriptedOllama } from './support/scriptedOllama';

/**
 * A destructive run_checks command runs only when the operator APPROVES it. A rejected approval must leave the
 * workspace untouched. (The approval outcome is an object; a truthiness check on it let every rejected command run.)
 */

let model: ScriptedOllama;
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;

beforeAll(async () => {
  model = await startScriptedOllama((call) => {
    const toolOutput = afterToolResult(call);
    if (toolOutput !== null) return { text: `Tool said: ${toolOutput}` };
    return { tool: { name: 'run_checks', args: { command: 'del marker.txt' } } };
  });
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await model.close();
});

describe('destructive run_checks honours the operator decision', () => {
  let db: CoreDatabase;
  let tempDir: string;
  let workspace: string;
  let marker: string;
  let decider: NodeJS.Timeout | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-approval-'));
    workspace = path.join(tempDir, 'ws');
    fs.mkdirSync(workspace);
    marker = path.join(workspace, 'marker.txt');
    fs.writeFileSync(marker, 'keep me');
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
  });

  afterEach(() => {
    if (decider) clearInterval(decider);
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  function decideEvery(resolution: 'approved' | 'rejected') {
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try {
          resolveApproval(db, a.id, { resolution, attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
        } catch {}
      }
    }, 50);
  }

  async function askToDelete() {
    const text = `Delete marker.txt in ${workspace}`;
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Approval' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    return new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, workspaceRoot: workspace, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
  }

  it.runIf(process.platform === 'win32')('does not run the command when the operator rejects it', async () => {
    decideEvery('rejected');
    const result = await askToDelete();
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.reply).toMatch(/did not approve|Not run/i);
    expect(db.all(`SELECT id FROM approvals WHERE status = 'rejected'`).length).toBe(1);
  }, 60_000);

  it.runIf(process.platform === 'win32')('runs the command once the operator approves it', async () => {
    decideEvery('approved');
    await askToDelete();
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);
});
