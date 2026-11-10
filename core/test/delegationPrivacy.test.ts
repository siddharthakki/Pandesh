/**
 * P0 gate B (Build 161 audit): private memory of the delegating turn never reaches a specialist that may not read it.
 *
 * End to end through the real engine, the real memory capability and the real delegate tool. A scripted local model
 * records every context it is given (system prompt, history, offered tools). Synthetic canaries only; no brief uses
 * shopping words, so no turn falls back to a web search.
 *
 * Paths: hand-off facts (the parent's tool results), the brief the delegating model writes, the child's own system
 * prompt and history, nested delegation, and the Team view's delegation (which ran the child INSIDE the delegating
 * conversation, so it inherited that whole history).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation, listMessages } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { rememberMemory } from '../domain/memory';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';
import { buildPiMemoryBridge } from '../runtime/piMemoryBridge';
import { Router } from '../api/router';
import { registerAgentRoutes } from '../api/agentRoutes';
import type { ApiContext, ApiResult } from '../api/context';
import { afterToolResult, startScriptedOllama, type ScriptedModelCall, type ScriptedOllama } from './support/scriptedOllama';

const CANARY = 'Lindenallee 7 in Bonn';
const isChild = (call: ScriptedModelCall) => /handled by the Research agent/.test(call.system);
const seen = (call: ScriptedModelCall) => `${call.system}\n${JSON.stringify(call.messages)}`;

let model: ScriptedOllama;
let previousUrl: string | undefined;
let Engine: typeof import('../runtime/piAgentEngine').PiAgentEngine;
let brief = '';
/** The parent model's plan: recall, then delegate with its own brief — or, after Core's own hand-off, try to delegate again. */
let plan: 'recall-then-delegate' | 'delegate-again' = 'recall-then-delegate';

beforeAll(async () => {
  model = await startScriptedOllama((call) => {
    if (isChild(call)) return { text: 'Note written.' };
    const result = afterToolResult(call);
    if (plan === 'delegate-again') {
      return result === null ? { tool: { name: 'delegate_to_agent', args: { agent: 'research', brief } } } : { text: 'Done.' };
    }
    if (result === null) return { tool: { name: 'memory_recall', args: { query: 'address style supplier' } } };
    if (/"entries"/.test(result)) return { tool: { name: 'delegate_to_agent', args: { agent: 'research', brief } } };
    return { text: 'Done.' };
  });
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  Engine = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await model.close();
});

let dir: string;
let db: CoreDatabase;
let registry: GovernedCapabilityRegistry;
let decider: NodeJS.Timeout | null = null;
let childRuns: string[] = [];

function remember(scopeType: 'user' | 'global' | 'project', scopeId: string, subject: string, value: string) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const msg = appendMessage(db, conv.id, { role: 'user', content: value, actor: 'test' }) as { id: string };
  rememberMemory(db, { memoryType: scopeType === 'user' ? 'user' : 'semantic', scopeType, scopeId, subject, predicate: 'is', value, sensitivity: 'internal', sourceConversationId: conv.id, sourceMessageId: msg.id, actor: 'test' });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-privacy-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  registry = new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db }));
  remember('user', 'user_profile', 'home address', CANARY);
  remember('global', 'global', 'house style', 'answers are short and cite sources');
  remember('project', 'Bakery', 'flour supplier', 'Mühle Krause delivers on Wednesdays');
  childRuns = [];
  plan = 'recall-then-delegate';
  // The user's OK on the card that lets the Research agent go online.
  decider = setInterval(() => {
    for (const a of listPendingApprovals(db)) {
      try {
        resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
      } catch { /* resolved meanwhile */ }
    }
  }, 50);
});

afterEach(() => {
  if (decider) clearInterval(decider);
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const memoryBridge = (conversationId: string, attemptId: string) =>
  buildPiMemoryBridge({ db, registry, correlationId: conversationId, clientId: 'desktop', cwd: dir, actor: 'test', actingAttemptId: attemptId });

function newTurn(conversationId: string, text: string) {
  const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
  return { req, att: createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' }) };
}

async function turn(text: string) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Delegation privacy' });
  appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
  const { req, att } = newTurn(conv.id, text);
  const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
  const broadcaster = new EventBroadcaster();
  const from = model.calls.length;
  await new Engine().executeAssistantTurn({
    db, broadcaster, attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model',
    memory: memoryBridge(conv.id, att.id),
    delegation: {
      clientId: 'desktop',
      defaults: { selectedProvider: 'ollama', selectedModel: 'fake-model' },
      run: async (childAttemptId: string) => {
        childRuns.push(childAttemptId);
        const child = db.get<{ requestId: string; conversationId: string; currentMessage: string }>(
          'SELECT a.requestId AS requestId, q.conversationId AS conversationId, q.currentMessage AS currentMessage FROM attempts a JOIN requests q ON q.id = a.requestId WHERE a.id = ?', [childAttemptId]);
        if (!child) throw new Error('child attempt missing');
        const childFence = acquireFence(db, childAttemptId, { owner: 'test', actor: 'test' });
        await new Engine().executeAssistantTurn({ db, broadcaster, attemptId: childAttemptId, requestId: child.requestId, conversationId: child.conversationId, prompt: child.currentMessage, currentMessage: child.currentMessage, fenceToken: childFence.token, model: 'fake-model', memory: memoryBridge(child.conversationId, childAttemptId) });
      },
      cancel: () => { /* not cancelled here */ },
    },
  });
  const calls = model.calls.slice(from);
  return { parent: calls.filter((c) => !isChild(c)), child: calls.filter(isChild) };
}

describe('delegation keeps private memory from a specialist that may not read it', () => {
  it('Research gets the facts it may read and none of the user\'s or the project\'s, and cannot delegate further', async () => {
    brief = 'Write a short note on how convection ovens save energy.';
    const { parent, child } = await turn('What do you remember about my address and our house style? Then have a specialist write a short note on how convection ovens save energy.');
    expect(parent.some((c) => c.tools.includes('delegate_to_agent'))).toBe(true);
    expect(parent.some((c) => seen(c).includes('Lindenallee'))).toBe(true); // the user's own turn may read it
    expect(childRuns).toHaveLength(1);
    expect(child.length).toBeGreaterThan(0);
    for (const call of child) {
      expect(seen(call)).not.toContain('Lindenallee');
      expect(seen(call)).not.toContain('Mühle Krause');
      expect(call.tools).not.toContain('delegate_to_agent');
    }
    expect(child[0].system).toContain('answers are short and cite sources');
  }, 60_000);

  it('a brief that repeats the user\'s private fact is refused before the Research agent starts or any card is raised', async () => {
    brief = `Write a packing list for a weekend trip starting from ${CANARY}.`;
    const { parent, child } = await turn('What do you remember about my address and our house style? Then have a specialist write a packing list for a weekend trip from my home.');
    expect(childRuns).toHaveLength(0);
    expect(child).toHaveLength(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_handoffs')?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approvals')?.n).toBe(0);
    const refusal = parent.map(afterToolResult).find((r) => r !== null && /refused by Pandesh Core/.test(r));
    expect(refusal).toMatch(/private memory the Research agent may not read \(home address\)/);
  }, 60_000);

  it('what the user wrote in this request themselves may be passed on (no false refusal)', async () => {
    brief = `Write a packing list for a weekend trip starting from ${CANARY}.`;
    const { child } = await turn(`Recall our house style, then have a specialist write a packing list for a weekend trip starting from ${CANARY}.`);
    expect(childRuns).toHaveLength(1);
    expect(child.length).toBeGreaterThan(0);
  }, 60_000);

  it('when the user names the agent, Core hands over the user\'s own words only, and a second hand-off by the model is refused', async () => {
    plan = 'delegate-again';
    brief = 'Write a short note on how convection ovens save energy.';
    const { parent, child } = await turn('Ask the Research agent to write a short note on how convection ovens save energy.');
    expect(childRuns).toHaveLength(1);
    for (const call of child) expect(seen(call)).not.toContain('Lindenallee');
    expect(child[0].system).not.toContain('FACTS FROM PANDESH');
    const again = parent.map(afterToolResult).find((r) => r !== null && /already handed this request/.test(r));
    expect(again).toBeTruthy();
  }, 60_000);
});

describe('Team view delegation', () => {
  it('runs the specialist in its own conversation, never inside the delegating one (whose history holds private memory)', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Earlier chat' });
    appendMessage(db, conv.id, { role: 'user', content: 'What is my address?', actor: 'user' });
    appendMessage(db, conv.id, { role: 'assistant', content: `Your home address is ${CANARY}.`, actor: 'pandesh' });
    const { att } = newTurn(conv.id, 'What is my address?');
    const router = new Router<ApiContext, ApiResult>();
    registerAgentRoutes(router, { executor: null });
    const route = router.match('POST', '/v1/agents/delegate');
    expect(route).not.toBeNull();
    for (const body of [
      { parentAttemptId: att.id, toAgentId: 'research', brief: 'Summarise how convection ovens save energy.' },
      { parentAttemptId: att.id, toAgentId: 'operations', brief: 'Check the free disk space.', ownConversation: false },
    ]) {
      const ctx = {
        db, clientId: 'desktop', actor: 'host', correlationId: 'c', query: new URLSearchParams(), params: {}, body,
        principal: { role: 'host', id: 'host', isTrustedOperator: true, isTrustedHost: true, isModelOrTool: false, source: 'host_transport' },
      } as unknown as ApiContext;
      const res = await route!.handler(ctx, route!.match);
      expect(res.status).toBe(201);
      const childConversation = (res.body as { conversationId: string }).conversationId;
      expect(childConversation).not.toBe(conv.id);
      expect(listMessages(db, childConversation).map((m) => String(m.content)).join('\n')).not.toContain('Lindenallee');
    }
  });
});
