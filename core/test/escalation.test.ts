/**
 * Escalation (owner rule, 2026-11-12): Pandesh does not give up while a stronger model it may use has not tried; a cloud
 * model is never used without asking; when nothing stronger is left it reports from the records why the task is not done.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation, listMessages } from '../domain/conversations';
import { getAttemptContext } from '../domain/attemptContext';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { classifyOfferReply, maybeEscalate, parseParamsB, pendingCloudOffer, planEscalation, startAcceptedCloudOffer, type InstalledModel } from '../runtime/escalation';
import { getAttempt } from '../domain/attempts';

/** The owner's PC on 2026-11-12 (Ollama /api/show), trimmed. */
const INSTALLED: InstalledModel[] = [
  { name: 'gemma4:12b', paramsB: 11.9, capabilities: ['completion', 'vision', 'tools', 'thinking'] },
  { name: 'qwen3.8:27b-mtp-q4_K_M', paramsB: 27.3, capabilities: ['completion', 'vision', 'tools', 'thinking'] },
  { name: 'qwen3-coder:swift-27b', paramsB: 27.3, capabilities: ['tools', 'thinking', 'completion', 'vision'] },
  { name: 'gemma4:26b-a4b-it-qat', paramsB: 25.2, capabilities: ['completion', 'vision', 'tools', 'thinking'] },
  { name: 'gpt-oss:20b', paramsB: 20.9, capabilities: ['completion', 'tools', 'thinking'] },
  { name: 'qwen9b-fixed:latest', paramsB: 8.95, capabilities: ['tools', 'thinking', 'completion', 'vision'] },
  { name: 'hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q4_K_M', paramsB: 27.3, capabilities: ['completion', 'tools'] },
  { name: 'nomic-embed-text:latest', paramsB: 0.137, capabilities: ['embedding'] },
];

describe('planEscalation', () => {
  const base = { installed: INSTALLED, needsTools: true, needsVision: false, escalationsSoFar: 0 };

  it('goes from gemma4:12b straight to the strongest installed model, a coder for a build request', () => {
    expect(planEscalation({ ...base, usedModels: ['gemma4:12b'], requestText: 'Go ahead and build it. I want a working widget please' }))
      .toMatchObject({ kind: 'escalate', model: 'qwen3-coder:swift-27b' });
    expect(planEscalation({ ...base, usedModels: ['gemma4:12b'], requestText: 'Summarise these meeting notes for me' }))
      .toMatchObject({ kind: 'escalate', model: 'qwen3.8:27b-mtp-q4_K_M' });
  });

  it('never steps down, never picks an uncensored variant or an embedding model', () => {
    const plan = planEscalation({ ...base, usedModels: ['gemma4:12b', 'qwen3-coder:swift-27b'], escalationsSoFar: 1, requestText: 'build it' });
    expect(plan).toMatchObject({ kind: 'escalate', model: 'qwen3.8:27b-mtp-q4_K_M' });
    expect(planEscalation({ ...base, usedModels: ['gemma4:12b', 'qwen3-coder:swift-27b', 'qwen3.8:27b-mtp-q4_K_M'], escalationsSoFar: 1, requestText: 'build it' }))
      .toEqual({ kind: 'exhausted', reason: 'no stronger model is installed on this PC' });
  });

  it('stops at the limit and respects tools and vision needs', () => {
    expect(planEscalation({ ...base, usedModels: ['gemma4:12b'], escalationsSoFar: 2, requestText: 'x' }).kind).toBe('exhausted');
    expect(planEscalation({ ...base, needsVision: true, usedModels: ['gpt-oss:20b'], requestText: 'describe' })).toMatchObject({ model: 'qwen3.8:27b-mtp-q4_K_M' });
    expect(planEscalation({ ...base, installed: INSTALLED.filter((m) => m.name === 'gemma4:12b'), usedModels: ['gemma4:12b'], requestText: 'x' }).kind).toBe('exhausted');
  });

  it('reads Ollama parameter sizes', () => {
    expect(parseParamsB('27.3B')).toBe(27.3);
    expect(parseParamsB('137M')).toBeCloseTo(0.137);
    expect(parseParamsB('')).toBeUndefined();
  });
});

describe('maybeEscalate', () => {
  let dir: string;
  let db: CoreDatabase;
  let conversationId: string;
  let n = 0;
  const deps = () => ({
    db, actor: 'test', installedModels: async () => INSTALLED, isMutatingTool: (t: string) => t === 'write_file', mutate: <T,>(fn: () => T) => fn(),
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalation-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    conversationId = createConversation(db, { mode: 'saath_kar', actor: 'test' }).id;
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function submit(message: string, provider = 'ollama', model = 'gemma4:12b') {
    const r = submitRequest(db, {
      clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId, workspaceRoot: dir,
      capability: { hasWorkspace: true, gitCapable: false }, correlationId: `c-${++n}`, toolPermissionPolicy: {},
      selectedProvider: provider, selectedModel: model,
    });
    return r.attempt!.id;
  }
  function tool(attemptId: string, toolName: string, status = 'succeeded') {
    db.run('INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt) VALUES (?, ?, ?, ?, ?, ?)', [`t-${++n}`, attemptId, toolName, '{}', status, new Date().toISOString()]);
  }
  function endUnfinished(attemptId: string) {
    db.run("UPDATE attempts SET status = 'completed' WHERE id = ?", [attemptId]);
    recordRuntimeEvent(db, { domain: 'attempt', entityId: attemptId, eventType: 'turn_unfinished', actor: 'test', metadata: { reason: 'nothing_built' } });
  }
  const chat = () => listMessages(db, conversationId).map((m: { content: string }) => m.content);

  it('replays the widget chat: gemma built nothing → coder → qwen3.8 → honest report', async () => {
    const first = submit('Go ahead and build it. I want a working widget please');
    tool(first, 'update_task_outcome'); tool(first, 'navigate_to'); tool(first, 'web_research'); tool(first, 'web_research');
    endUnfinished(first);

    const second = await maybeEscalate(deps(), first);
    expect(second).toBeDefined();
    const ctx2 = getAttemptContext(db, second!.id);
    expect(ctx2.selectedModel).toBe('qwen3-coder:swift-27b');
    expect(ctx2.retryGuidance).toMatch(/gemma4:12b did not finish it: nothing was built.*It ran: navigate_to, web_research ×2/);
    expect(chat().at(-1)).toMatch(/\*\*gemma4:12b did not finish this:\*\* nothing was built.*Continuing with \*\*qwen3-coder:swift-27b\*\*/);
    // Asking again for the same attempt does not start a second successor.
    expect(await maybeEscalate(deps(), first)).toBeUndefined();

    endUnfinished(second!.id);
    const third = await maybeEscalate(deps(), second!.id);
    expect(getAttemptContext(db, third!.id).selectedModel).toBe('qwen3.8:27b-mtp-q4_K_M');

    endUnfinished(third!.id);
    expect(await maybeEscalate(deps(), third!.id)).toBeUndefined();
    const report = chat().at(-1)!;
    expect(report).toMatch(/^\*\*This request is not done\.\*\*/);
    expect(report).toMatch(/\*\*gemma4:12b\*\*: nothing was built.*\n- \*\*qwen3-coder:swift-27b\*\*.*\n- \*\*qwen3.8:27b-mtp-q4_K_M\*\*/);
    expect(report).toMatch(/A cloud model is never used without your OK/);
  });

  it('leaves finished, stopped, cloud-picked and side-effect turns alone', async () => {
    const done = submit('build it');
    db.run("UPDATE attempts SET status = 'completed' WHERE id = ?", [done]);
    expect(await maybeEscalate(deps(), done)).toBeUndefined();

    const stopped = submit('build it');
    endUnfinished(stopped);
    db.run("UPDATE attempts SET cancelRequestedAt = ? WHERE id = ?", [new Date().toISOString(), stopped]);
    expect(await maybeEscalate(deps(), stopped)).toBeUndefined();

    const cloud = submit('build it', 'orcarouter', 'deepseek/deepseek-v4-flash-free');
    endUnfinished(cloud);
    expect(await maybeEscalate(deps(), cloud)).toBeUndefined();

    const wrote = submit('build it');
    tool(wrote, 'write_file');
    db.run("UPDATE attempts SET status = 'failed', failureReason = 'timeout waiting for the model' WHERE id = ?", [wrote]);
    expect(await maybeEscalate(deps(), wrote)).toBeUndefined();
  });

  it('continues a model failure with no side effect on a stronger model', async () => {
    const failed = submit('Write me a python script that lists my files');
    db.run("UPDATE attempts SET status = 'failed', failureReason = 'timeout waiting for the model' WHERE id = ?", [failed]);
    const next = await maybeEscalate(deps(), failed);
    expect(getAttemptContext(db, next!.id).selectedModel).toBe('qwen3-coder:swift-27b');
  });

  it('asks before any cloud use, and hands the task over only after "yes"', async () => {
    const offer = { provider: 'orcarouter', model: 'z-ai/glm-5.3-flash-free', verifiedFree: true };
    const withOffer = () => ({ ...deps(), cloudOffer: () => offer });
    const first = submit('Go ahead and build it. I want a working widget please');
    endUnfinished(first);
    const second = await maybeEscalate(withOffer(), first);
    endUnfinished(second!.id);
    const third = await maybeEscalate(withOffer(), second!.id);
    endUnfinished(third!.id);
    expect(await maybeEscalate(withOffer(), third!.id)).toBeUndefined();

    const report = chat().at(-1)!;
    expect(report).toMatch(/Want me to hand this to the cloud model z-ai\/glm-5\.3-flash-free/);
    expect(report).toMatch(/the messages in this chat/);
    expect(report).toMatch(/Gmail, Calendar or memory content/);
    expect(report).toMatch(/Nothing has been sent yet\. Reply \*\*yes\*\*/);

    // The user's "yes" is the next message in the chat.
    const yes = submit('yes');
    const pending = pendingCloudOffer(db, conversationId, getAttempt(db, yes).requestId);
    expect(pending).toEqual({ offerAttemptId: third!.id, provider: 'orcarouter', model: 'z-ai/glm-5.3-flash-free' });
    expect(classifyOfferReply('yes')).toBe('yes');
    // Nothing starts until the engine has recorded the yes.
    expect(startAcceptedCloudOffer(deps(), yes)).toBeUndefined();
    recordRuntimeEvent(db, { domain: 'attempt', entityId: yes, eventType: 'cloud_offer_accepted', actor: 'test', metadata: { ...pending } });

    const cloudAttempt = startAcceptedCloudOffer(deps(), yes);
    const ctx = getAttemptContext(db, cloudAttempt!.id);
    expect(ctx.selectedProvider).toBe('orcarouter');
    expect(ctx.selectedModel).toBe('z-ai/glm-5.3-flash-free');
    expect(ctx.modelSelection).toMatchObject({ cloudChatApproved: true, cloudChatSource: 'approved_offer', cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' } });
    expect(ctx.retryGuidance).toMatch(/local models gemma4:12b, qwen3-coder:swift-27b, qwen3\.8:27b-mtp-q4_K_M did not finish it/);
    // Answered once: the offer is no longer pending.
    expect(pendingCloudOffer(db, conversationId, getAttempt(db, submit('yes')).requestId)).toBeNull();

    // The approved cloud model did not finish either: the top of the ladder, an honest report, no second offer.
    endUnfinished(cloudAttempt!.id);
    expect(await maybeEscalate(withOffer(), cloudAttempt!.id)).toBeUndefined();
    const last = chat().at(-1)!;
    expect(last).toMatch(/the cloud model you approved did not finish it either/);
    expect(last).not.toMatch(/Want me to hand this/);
  });

  it('a "no", or any other message, sends nothing', async () => {
    const a = submit('build it');
    endUnfinished(a);
    await maybeEscalate({ ...deps(), installedModels: async () => [], cloudOffer: () => ({ provider: 'orcarouter', model: 'm-free', verifiedFree: true }) }, a);
    expect(chat().at(-1)).toMatch(/Want me to hand this/);
    expect(classifyOfferReply('no')).toBe('no');
    expect(classifyOfferReply('no, keep it local')).toBe('no');
    expect(classifyOfferReply('yes but not now')).toBeNull();
    expect(classifyOfferReply('Status ?')).toBeNull();
    expect(classifyOfferReply('Yes, use the cloud model')).toBe('yes');
    // A new request in between closes the offer.
    submit('What is the weather tomorrow?');
    expect(pendingCloudOffer(db, conversationId, getAttempt(db, submit('yes')).requestId)).toBeNull();
  });

  it('offers nothing when no free cloud model is chosen', async () => {
    const a = submit('build it');
    endUnfinished(a);
    await maybeEscalate({ ...deps(), installedModels: async () => [], cloudOffer: () => undefined }, a);
    expect(chat().at(-1)).toMatch(/choose a free cloud model in Settings → Cloud/);
    expect(db.get("SELECT 1 FROM runtime_events WHERE eventType = 'cloud_offer'")).toBeUndefined();
  });

  it('reports instead of guessing when Ollama cannot list its models', async () => {
    const a = submit('build it');
    endUnfinished(a);
    expect(await maybeEscalate({ ...deps(), installedModels: async () => undefined }, a)).toBeUndefined();
    expect(chat().at(-1)).toMatch(/Ollama\) could not list its models/);
  });
});
