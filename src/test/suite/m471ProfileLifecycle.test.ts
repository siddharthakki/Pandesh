import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { InferenceProvider, ModelInfo, ProviderChatOptions, ProviderType } from '../../providers/ProviderTypes';
import { ProviderTimeoutError } from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';
import {
  PARTIAL_PROFILE_TTL_MS,
  PROFILE_TTL_MS,
  RuntimeProfileStore,
  conservativeProfile,
  makeIdentity,
  profileTtlMs,
} from '../../runtimeProfile/RuntimeCapabilityProfile';
import { probeRuntime } from '../../runtimeProfile/RuntimeProbe';
import { RuntimeIntelligence } from '../../runtimeProfile/RuntimeIntelligence';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';

/**
 * Golden E was PARTIAL because the live probe did not finish inside the run window, so the run recorded no profile
 * at all. A probe is several requests against a possibly large model; its answers have to be usable and durable as
 * they arrive, an interrupted probe has to resume rather than start over, and an incomplete profile must not stand in
 * for a finished one for two weeks.
 */

const UNKNOWN = 'unlisted-probe-model:12b';
const PROBE_JSON = '{"ok": true, "word": "ready"}';
const text = (content: string): ChatResponse => ({ message: { role: 'assistant', content }, done: true });

type Script = (messages: ChatMessage[], tools: ToolDefinition[], options: ProviderChatOptions, call: number) => ChatResponse | Error;

class Provider implements InferenceProvider {
  readonly providerType: ProviderType = 'ollama';
  readonly endpoint = 'http://localhost:11434';
  calls: Array<{ tools: number; schema: boolean }> = [];
  constructor(private readonly script: Script) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return []; }
  async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> { return { name: model, contextWindow: 16_384 }; }
  async chat(messages: ChatMessage[], tools: ToolDefinition[], options: ProviderChatOptions): Promise<ChatResponse> {
    this.calls.push({ tools: tools.length, schema: Boolean(options.responseFormat) });
    const result = this.script(messages, tools, options, this.calls.length);
    if (result instanceof Error) throw result;
    return result;
  }
}

const strong: Script = (messages, tools) => {
  if (tools.length > 0) {
    return messages[messages.length - 1].role === 'tool'
      ? text('done')
      : { message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'probe_echo', arguments: { word: 'ready' } } }] }, done: true };
  }
  return text(PROBE_JSON);
};

describe('probe progress is durable', () => {
  const identity = makeIdentity({ model: UNKNOWN, providerType: 'ollama' });

  it('reports a partial snapshot after each answered step and a complete profile at the end', async () => {
    const snapshots: Array<{ steps: string[]; complete?: boolean }> = [];
    const profile = await probeRuntime(new Provider(strong), conservativeProfile(identity), {
      onProgress: partial => { snapshots.push({ steps: [...(partial.completedSteps ?? [])], complete: partial.complete }); },
    });
    expect(snapshots.map(item => item.steps.at(-1))).toEqual(['schema', 'prompt_only', 'tools']);
    expect(snapshots.every(item => item.complete === false)).toBe(true);
    expect(profile.complete).toBe(true);
    expect(profile.completedSteps).toEqual(['schema', 'prompt_only', 'tools']);
  });

  it('a probe cut short after one step has already left that answer behind', async () => {
    const controller = new AbortController();
    let last: ReturnType<typeof conservativeProfile> | undefined;
    const profile = await probeRuntime(new Provider(strong), conservativeProfile(identity), {
      signal: controller.signal,
      onProgress: partial => {
        last = partial;
        if (partial.completedSteps?.includes('schema')) controller.abort();
      },
    });
    expect(last?.structuredSchema).toBe('yes');
    expect(last?.completedSteps).toEqual(['schema']);
    expect(profile.complete).toBe(false);
    expect(profile.structuredSchema).toBe('yes');
  });

  it('a runtime that stops answering yields a partial profile, not a 14-day "complete" one that learned nothing', async () => {
    const stalled = new Provider(() => new ProviderTimeoutError('timed out', 'ollama', 1000, 'transport', 'transport:undici-headers'));
    const profile = await probeRuntime(stalled, conservativeProfile(identity), {});
    expect(profile.complete).toBe(false);
    expect(profile.completedSteps ?? []).toEqual([]);
    expect(profileTtlMs(profile)).toBe(PARTIAL_PROFILE_TTL_MS);
    expect(profileTtlMs({ ...profile, complete: true })).toBe(PROFILE_TTL_MS);
    // Absent means complete: a profile written before the field existed keeps the long TTL.
    expect(profileTtlMs({ ...profile, complete: undefined })).toBe(PROFILE_TTL_MS);
  });
});

describe('a resumed probe does not repeat answered steps', () => {
  const identity = makeIdentity({ model: UNKNOWN, providerType: 'ollama' });

  it('asks only the steps the earlier probe did not answer', async () => {
    const earlier = {
      ...conservativeProfile(identity),
      source: 'probe' as const,
      probedAt: new Date().toISOString(),
      structuredSchema: 'yes' as const,
      emptyCompletion: 'not_observed' as const,
      complete: false,
      completedSteps: ['schema' as const],
      evidence: ['schema probe returned well-formed JSON in 900ms'],
    };
    const provider = new Provider(strong);
    const profile = await probeRuntime(provider, earlier, {});
    // Schema was already answered: no schema-constrained request is repeated; prompt-only and tools run.
    expect(provider.calls.some(call => call.schema)).toBe(false);
    expect(provider.calls.length).toBe(3); // prompt-only, tool call, tool continuation
    expect(profile.structuredSchema).toBe('yes');
    expect(profile.complete).toBe(true);
    expect(profile.evidence[0]).toContain('schema probe returned well-formed JSON');
    expect(profile.evidence.some(line => line.startsWith('resuming probe after schema'))).toBe(true);
  });
});

describe('the first dispatch does not wait for the whole probe', () => {
  beforeEach(() => ModelProfileRegistry.clearNegotiation());

  it('an unknown model proceeds on the partial profile once the start-relevant steps answer; the tools steps finish in the background', async () => {
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const provider = new Provider(strong);
    const originalChat = provider.chat.bind(provider);
    provider.chat = async (messages, tools, options) => {
      // The contract steps (schema, prompt-only) are immediate; the slow tools/continuation steps are held.
      if (tools.length > 0) await slow;
      return originalChat(messages, tools, options);
    };
    const runtime = new RuntimeIntelligence({ enabled: true, blockingBudgetMs: 60_000 });

    const started = Date.now();
    const prepared = await runtime.prepare(provider, UNKNOWN);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(prepared?.profile.structuredSchema).toBe('yes');
    expect(prepared?.profile.complete).toBe(false);
    expect(prepared?.profile.completedSteps).toEqual(['schema', 'prompt_only']);

    releaseSlow();
    for (let i = 0; i < 50 && (await runtime.findForModel('ollama', UNKNOWN))?.complete !== true; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    expect((await runtime.findForModel('ollama', UNKNOWN))?.complete).toBe(true);
  });

  it('is still bounded: a runtime that answers nothing yields the conservative profile after the blocking budget', async () => {
    const provider = new Provider(() => new Promise<ChatResponse>(() => undefined) as never);
    const runtime = new RuntimeIntelligence({ enabled: true, blockingBudgetMs: 100 });
    const prepared = await runtime.prepare(provider, 'another-unknown:3b');
    expect(prepared?.profile.source).toBe('conservative');
  });
});

describe('RuntimeIntelligence persists and resumes', () => {
  let dir: string;
  let storePath: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-profile-life-'));
    storePath = path.join(dir, 'profiles.json');
    ModelProfileRegistry.clearNegotiation();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('a probe killed after its first step leaves a usable partial profile in the store, and the next process resumes it', async () => {
    // Process 1: the runtime answers the schema step, then the window closes (modelled as an abort).
    const first = new RuntimeIntelligence({ enabled: true, storePath });
    const controller = new AbortController();
    const dying = new Provider((messages, tools, options, call) => {
      if (call >= 2) { controller.abort(); return text(''); }
      return strong(messages, tools, options, call);
    });
    await first.prepare(dying, UNKNOWN, { signal: controller.signal }).catch(() => undefined);
    const stored = (await new RuntimeProfileStore(storePath).list()).find(profile => profile.identity.model === UNKNOWN);
    expect(stored?.structuredSchema).toBe('yes');
    expect(stored?.completedSteps).toContain('schema');
    expect(stored?.complete).toBe(false);

    // Process 2: a fresh instance (as after a restart). The partial profile is fresh, so it is used as it stands...
    const second = new RuntimeIntelligence({ enabled: true, storePath });
    const provider = new Provider(strong);
    const prepared = await second.prepare(provider, UNKNOWN);
    expect(prepared?.profile.structuredSchema).toBe('yes');
    expect(provider.calls.length).toBe(0);

    // ...and once it is past its short TTL the store stops trusting it, yet still hands it back as the resume base.
    const aged = new RuntimeProfileStore(storePath, () => new Date(Date.now() + PARTIAL_PROFILE_TTL_MS + 60_000));
    const identity = stored!.identity;
    expect(await aged.get(identity)).toBeUndefined();
    expect((await aged.getAny(identity))?.completedSteps).toContain('schema');
  });
});
