import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { chooseModel, clearModelAwarenessCache, renderModelDetail, renderModelSummary, snapshotModels, type ModelSnapshot } from '../runtime/modelAwareness';
import type { InstalledModel } from '../runtime/escalation';
import { createCapabilityInventoryAdapter } from '../runtime/capabilityInventory';
import { createLocalVisionInspector } from '../runtime/localVisionInspector';
import { modelSwitchHint, skillModelContext } from '../runtime/modelAwareness';
import { SkillRegistry, resolveSkills } from '../platform/skills/skillRuntime';
import { registerBuiltinSkills } from '../platform/skills/skillSources';

/**
 * Capability awareness: one live picture of the models on this PC (installed / loaded / selected / usable), built from
 * the facts Pandesh already reads from Ollama, and used by screenshot reading, model choice, the model's own summary
 * and capability_explain. The model list below is the owner's real one (2026-11-14).
 */

const GB = 1e9;
const OWNER_MODELS: InstalledModel[] = [
  { name: 'qwen2.5vl:7b', paramsB: 7, capabilities: ['completion', 'vision'], estimatedBytes: 7 * GB },
  { name: 'qwen9b-fixed:latest', paramsB: 9, capabilities: ['completion', 'tools'], estimatedBytes: 11 * GB },
  { name: 'hf.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-GGUF:Q8_0', paramsB: 9, capabilities: ['completion', 'vision', 'tools'], estimatedBytes: 11 * GB },
  { name: 'gemma4:26b-a4b-it-qat', paramsB: 26, capabilities: ['completion', 'vision', 'tools', 'thinking'], estimatedBytes: 17 * GB },
  { name: 'qwen3-coder:swift-27b', paramsB: 27, capabilities: ['completion', 'tools'], estimatedBytes: 19 * GB },
  { name: 'gemma4:12b', paramsB: 12, capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'], estimatedBytes: 9 * GB },
  { name: 'nomic-embed-text:latest', paramsB: 0.14, capabilities: ['embedding'], estimatedBytes: 0.3 * GB },
];
const GPU = { name: 'NVIDIA test GPU', totalVramMb: 16 * 1024, freeVramMb: 4 * 1024 };

const psFetch = (loaded: Array<{ name: string; size_vram: number }>) => (async () => new Response(JSON.stringify({ models: loaded }))) as unknown as typeof fetch;
const snap = (selected: string | null, loaded: string[] = [], kind?: 'cloud') => snapshotModels({
  baseUrl: 'http://127.0.0.1:11434', selectedModel: selected, provider: kind === 'cloud' ? 'openrouter' : 'ollama', gpu: GPU,
  installed: async () => OWNER_MODELS, fetchFn: psFetch(loaded.map((name) => ({ name, size_vram: 8 * GB }))),
});

describe('snapshot keeps installed, loaded, selected and usable apart', () => {
  beforeEach(() => clearModelAwarenessCache());

  it('marks each model with what is true of it right now', async () => {
    const s = await snap('gemma4:12b', ['gemma4:12b', 'qwen2.5vl:7b']);
    const by = new Map(s.models.map((m) => [m.name, m]));
    expect(by.get('gemma4:12b')).toMatchObject({ selected: true, loaded: true, canSee: true, canUseTools: true });
    expect(by.get('qwen2.5vl:7b')).toMatchObject({ selected: false, loaded: true, canSee: true, canUseTools: false });
    expect(by.get('qwen9b-fixed:latest')).toMatchObject({ selected: false, loaded: false, canSee: false, canUseTools: true });
    expect(by.get('nomic-embed-text:latest')).toMatchObject({ isEmbedding: true, autoEligible: false });
    expect(by.get('hf.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-GGUF:Q8_0')?.autoEligible).toBe(false);
    expect(s.available).toBe(true);
    // fit comes from the GPU budget, not from a list
    expect(by.get('qwen3-coder:swift-27b')?.fitsGpu).toBe(false);
    expect(by.get('qwen2.5vl:7b')?.fitsGpu).toBe(true);
  });

  it('says nothing is known when the model server does not answer', async () => {
    const s = await snapshotModels({ baseUrl: 'http://127.0.0.1:1', gpu: null, installed: async () => undefined });
    expect(s.available).toBe(false);
    expect(chooseModel(s, { vision: true }).model).toBeNull();
    expect(renderModelSummary(s)).toMatch(/did not answer.+Do not promise one/);
  });
});

describe('choosing a model from actual capabilities (no extra load when the active one can do it)', () => {
  beforeEach(() => clearModelAwarenessCache());

  it('the active gemma4 reads images itself: nothing is loaded', async () => {
    const c = chooseModel(await snap('gemma4:12b', ['gemma4:12b']), { vision: true });
    expect(c).toMatchObject({ model: 'gemma4:12b', willLoad: false });
    expect(c.why).toMatch(/is the active model and can read images: nothing needs to be loaded/);
  });

  it('an active model that cannot see hands the job to one that is already loaded', async () => {
    const c = chooseModel(await snap('qwen3-coder:swift-27b', ['qwen3-coder:swift-27b', 'qwen2.5vl:7b']), { vision: true });
    expect(c).toMatchObject({ model: 'qwen2.5vl:7b', willLoad: false });
    expect(c.why).toMatch(/already loaded/);
  });

  it('otherwise the smallest model that fits is chosen and the reply says it must load', async () => {
    const c = chooseModel(await snap('qwen9b-fixed:latest', ['qwen9b-fixed:latest']), { vision: true });
    expect(c).toMatchObject({ model: 'qwen2.5vl:7b', willLoad: true });
    expect(c.why).toMatch(/not loaded yet, so using it loads it/);
  });

  it('a loaded model that is larger than graphics memory loses to a fitting one (it would run on the CPU)', async () => {
    const s = await snap('qwen9b-fixed:latest', ['qwen9b-fixed:latest', 'big-vision']);
    const withBig: ModelSnapshot = { ...s, models: [...s.models, { name: 'big-vision', capabilities: ['vision', 'tools'], canSee: true, canUseTools: true, isEmbedding: false, estimatedBytes: 27 * GB, loaded: true, selected: false, fitsGpu: false, autoEligible: true }] };
    const c = chooseModel(withBig, { vision: true });
    expect(c.model).toBe('qwen2.5vl:7b');
    expect(c.alternatives.some((a) => a.name === 'big-vision')).toBe(true);
  });

  it('a cloud selection never becomes the reader: only local models are ever returned', async () => {
    const s = await snap('openrouter/some-model', ['qwen2.5vl:7b'], 'cloud');
    expect(s.selectedKind).toBe('cloud');
    const c = chooseModel(s, { vision: true });
    expect(c.model).toBe('qwen2.5vl:7b');
    expect(renderModelSummary(s)).toMatch(/a cloud model the user picked.+never given to it/);
  });

  it('modified variants are never auto-chosen, and the reason for no choice names what is installed', async () => {
    const only = { ...(await snap(null)), models: (await snap(null)).models.filter((m) => /heretic|qwen9b/.test(m.name)) } as ModelSnapshot;
    const c = chooseModel(only, { vision: true });
    expect(c.model).toBeNull();
    expect(c.why).toMatch(/no installed local model can read images \(installed: qwen9b-fixed:latest, /);
    expect(c.alternatives.some((a) => /heretic/.test(a.name) && /owner picks by hand/.test(a.whyNot))).toBe(true);
  });

  it('needs for vision and tools together pick a model that has both', async () => {
    const c = chooseModel(await snap('qwen9b-fixed:latest'), { vision: true, tools: true });
    expect(c.model).toBe('gemma4:12b');
  });
});

describe('what the model and the user are told', () => {
  beforeEach(() => clearModelAwarenessCache());

  it('the summary is compact, names active/loaded/able models, and separates ability from permission', async () => {
    const text = renderModelSummary(await snap('gemma4:12b', ['gemma4:12b']));
    expect(text.length).toBeLessThan(900);
    expect(text).toMatch(/Active: gemma4:12b \(loaded\) — sees images, uses tools/);
    expect(text).toMatch(/Also able to read images: .*qwen2\.5vl:7b \(.+not loaded\)/);
    expect(text).toMatch(/not permission/);
    expect(text).not.toMatch(/heretic/); // owner-picked variants are not advertised
  });

  it('capability_explain gives the detail and the reasoning, from the same snapshot', async () => {
    const adapter = createCapabilityInventoryAdapter({ modelSnapshot: () => snap('qwen3-coder:swift-27b', ['qwen3-coder:swift-27b']) });
    expect(adapter.classify('capability_explain')).toBe('read_only');
    const run = (args: Record<string, unknown>) => adapter.run({ name: 'capability_explain', arguments: args } as never, {} as never);
    const models = await run({ topic: 'models' });
    expect(models.status).toBe('succeeded');
    expect(models.output).toMatch(/qwen3-coder:swift-27b: .*ACTIVE, loaded.*larger than the GPU budget/);
    expect(models.output).toMatch(/gemma4:12b: sees images, uses tools, reasons, hears audio/);
    expect(models.output).toMatch(/Abilities are not permissions/);
    const eyes = await run({ topic: 'image_reading' });
    expect(eyes.output).toMatch(/To read images: use qwen2\.5vl:7b — .*not loaded yet/);
    const bad = await run({ topic: 'capability', capability: 'does_not_exist' });
    expect(bad.status).toBe('failed');
  });

  it('the detail view reports precisely why nothing can do a job', async () => {
    const s = { ...(await snap('gemma4:12b')), models: [] } as ModelSnapshot;
    expect(renderModelDetail(s, { vision: true })).toMatch(/To read images: no installed local model can read images/);
  });
});

describe('skill discovery and model switching use the same snapshot', () => {
  beforeEach(() => clearModelAwarenessCache());
  const resolve = async (selected: string) => {
    const registry = new SkillRegistry(); registerBuiltinSkills(registry);
    const model = skillModelContext(await snap(selected));
    return { model, decision: resolveSkills(registry, { intent: 'look at this screenshot image', grantedCapabilities: new Set(['workspace.read']), model, workspaceOpen: true, workspaceTrusted: true }).decisions.find((d) => d.id === 'analyze-image') };
  };

  it('an image skill is compatible exactly when the active model can see', async () => {
    const seeing = await resolve('gemma4:12b');
    expect(seeing.model).toEqual({ vision: true, tools: true });
    expect(seeing.decision?.status).not.toBe('skipped');
    const blind = await resolve('qwen3-coder:swift-27b');
    expect(blind.model).toEqual({ vision: false, tools: true });
    expect(blind.decision).toMatchObject({ status: 'skipped', reason: 'incompatible_model' });
  });

  it('and the same facts say which installed model to switch to, or that none exists', async () => {
    expect(modelSwitchHint(await snap('qwen3-coder:swift-27b'), { vision: true })).toMatch(/^switch to qwen2\.5vl:7b: /);
    expect(modelSwitchHint(await snap('gemma4:12b'), { vision: true })).toBeNull();
    const none = { ...(await snap('gemma4:12b')), models: [] } as ModelSnapshot;
    expect(modelSwitchHint(none, { vision: true })).toBe('no installed local model can read images');
    expect(skillModelContext({ ...(await snap('x', [], 'cloud')) })).toBeUndefined();
  });
});

describe('screenshot reading uses the same snapshot', () => {
  it('the active vision model reads the picture and no other model is touched', async () => {
    const png = path.join(os.tmpdir(), `awareness-${process.pid}.png`);
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const used: string[] = [];
      const fetchFn = (async (_url: string, init?: { body?: string }) => { used.push(JSON.parse(init!.body!).model); return new Response(JSON.stringify({ message: { content: 'a WhatsApp window' } })); }) as unknown as typeof fetch;
      const out = await createLocalVisionInspector({ baseUrl: 'http://127.0.0.1:11434', fetchFn, snapshot: () => snap('gemma4:12b', ['gemma4:12b']) })({ path: png, question: 'what is on screen' });
      expect(out).toMatchObject({ ok: true, model: 'gemma4:12b' });
      expect(used).toEqual(['gemma4:12b']);
      const none = await createLocalVisionInspector({ baseUrl: 'http://127.0.0.1:11434', fetchFn, snapshot: async () => ({ ...(await snap('gemma4:12b')), models: [] }) })({ path: png, question: 'x' });
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.reason).toMatch(/no installed local model can read images/);
    } finally { fs.rmSync(png, { force: true }); }
  });
});

// ---- the model really is told, through the real turn ------------------------------------------------------------
describe('the active model receives the live summary in a real turn, local turns only', () => {
  let server: http.Server;
  let previousUrl: string | undefined;
  let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
  let seenUserText: string[] = [];
  let db: CoreDatabase;
  let tempDir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        const send = (obj: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url?.startsWith('/api/generate')) return send({});
        if (req.url?.startsWith('/api/tags')) return send({ models: [{ name: 'fake-model', size: 6e9 }, { name: 'fake-vision', size: 5e9 }] });
        if (req.url?.startsWith('/api/ps')) return send({ models: [{ name: 'fake-model', size_vram: 6e9 }] });
        if (req.url?.startsWith('/api/show')) return send({ capabilities: json.model === 'fake-vision' ? ['completion', 'vision'] : ['completion', 'tools'] });
        if (req.url?.startsWith('/api/chat')) {
          const last = [...json.messages].reverse().find((m: any) => m.role === 'user');
          seenUserText.push(String(last?.content ?? ''));
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: 'OK' }, done: false })}\n`);
          res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`);
          return res.end();
        }
        res.writeHead(404); res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
    process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
  });
  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    clearModelAwarenessCache();
    seenUserText = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-awareness-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
  });
  afterEach(() => { try { db.close(); } catch {} try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} });

  it('which model can read images is in the turn state the model sees, taken from Ollama live', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'aware' });
    const text = 'Which of your models can read a picture, and are you one of them? Write a short report about it.';
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: 'aware' });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', workspaceRoot: tempDir } as any);
    const seen = seenUserText.join('\n');
    expect(seen).toMatch(/MODELS ON THIS PC \(live\)/);
    expect(seen).toMatch(/Active: fake-model \(loaded\) — uses tools/);
    expect(seen).toMatch(/Also able to read images: fake-vision/);
    expect(seen).toMatch(/not permission/);
  }, 60_000);
});

// Live, read-only: asks the real local Ollama (tags, show, ps) and nvidia-smi. `LIVE_OLLAMA=1 LIVE_OLLAMA_OUT=out.txt`.
describe.skipIf(process.env.LIVE_OLLAMA !== '1')('live: the real models on this PC', () => {
  it('builds a snapshot and explains the choice', async () => {
    clearModelAwarenessCache();
    const s = await snapshotModels({ selectedModel: process.env.LIVE_SELECTED || null, provider: 'ollama' });
    const out = [renderModelSummary(s), '', renderModelDetail(s)].join('\n');
    if (process.env.LIVE_OLLAMA_OUT) fs.writeFileSync(process.env.LIVE_OLLAMA_OUT, out);
    expect(s.available).toBe(true);
    expect(s.models.length).toBeGreaterThan(0);
  }, 60_000);
});
