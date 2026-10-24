import { describe, expect, it } from 'vitest';
import { cloudProviderLabel, isCloudAttemptProvider, isPoolProvider, isSupportedAttemptProvider, refuseCloudProviderBeforeFetch, resolveAttemptModelBackend, usesOpenRouterPool } from '../runtime/attemptModelBackend';
import { CloudCredentialStore } from '../runtime/cloudCredentials';
import { buildMissionEnvelope } from '../runtime/missionAuthorization';
import type { AttemptContextRecord } from '../shared/wireTypes';
import type { CoreDatabase } from '../db/connection';

const OPEN = { cloudSpend: { mode: 'UNRESTRICTED', modelFreeness: 'unknown' } };
const ctx = (provider: string, model = 'm/x', extra: object = {}) => ({ selectedProvider: provider, selectedModel: model, modelSelection: OPEN, ...extra }) as unknown as AttemptContextRecord;
const db = {} as CoreDatabase;

function sseFetch(calls: Array<{ url: string; auth: string; model: string }>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url: String(input), auth: String((init?.headers as Record<string, string>).Authorization ?? ''), model: body.model });
    const lines = [`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'ok' } }] })}`, `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}`, 'data: [DONE]'];
    return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

describe('cloud provider pool in Core', () => {
  it('treats catalog providers as cloud pool providers and unknown names as unsupported', () => {
    for (const id of ['groq', 'gemini', 'ollama-cloud', 'cerebras', 'orcarouter']) {
      expect(isPoolProvider(id)).toBe(true);
      expect(isCloudAttemptProvider(id)).toBe(true);
      expect(isSupportedAttemptProvider(id)).toBe(true);
    }
    expect(isPoolProvider('ollama')).toBe(false);
    expect(isSupportedAttemptProvider('totally-unknown')).toBe(false);
    const creds = new CloudCredentialStore();
    creds.set('custom-remote', { baseUrl: 'https://x.test/v1', apiKey: 'k-12345678' });
    expect(isPoolProvider('custom-remote', creds)).toBe(true);
    expect(cloudProviderLabel('groq')).toBe('Groq');
  });

  it('dispatches the exact provider/model with that provider credential and never to local', async () => {
    const creds = new CloudCredentialStore();
    creds.set('groq', { baseUrl: 'https://groq.test/v1', apiKey: 'gsk_GROQKEY12345' }); // gitleaks:allow
    creds.set('gemini', { baseUrl: 'https://gem.test/v1', apiKey: 'AIzaGEMKEY1234567' }); // gitleaks:allow
    const calls: Array<{ url: string; auth: string; model: string }> = [];
    const local = { streamChat: async () => { throw new Error('LOCAL MUST NOT BE USED'); } };
    const backend = resolveAttemptModelBackend({ context: ctx('groq', 'openai/gpt-oss-120b'), db, injectedBackend: local as never, cloudCredentials: creds, fetchFn: sseFetch(calls) });
    await backend.streamChat({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }], tools: [], stream: true } as never, () => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('groq.test');
    expect(calls[0].auth).toBe('Bearer gsk_GROQKEY12345');
    expect(calls[0].model).toBe('openai/gpt-oss-120b');
  });

  it('refuses before any fetch when that provider has no credential, even if another provider does', () => {
    const creds = new CloudCredentialStore();
    creds.set('groq', { baseUrl: 'https://groq.test/v1', apiKey: 'gsk_GROQKEY12345' }); // gitleaks:allow
    expect(() => refuseCloudProviderBeforeFetch(ctx('gemini'), creds, 'gemini')).toThrow(/Google Gemini API is not configured/);
    expect(() => resolveAttemptModelBackend({ context: ctx('gemini'), db, cloudCredentials: creds })).toThrow(/not falling back/);
    expect(() => refuseCloudProviderBeforeFetch(ctx('groq', ' '), creds, 'groq')).toThrow(/model is required/);
  });

  it('OpenRouter uses the pool path only when a pool credential exists and no spend cap is in play', () => {
    const creds = new CloudCredentialStore();
    expect(usesOpenRouterPool(ctx('openrouter'), creds)).toBe(false);
    creds.set('openrouter', { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-abcdefgh' }); // gitleaks:allow
    expect(usesOpenRouterPool(ctx('openrouter'), creds)).toBe(true);
    expect(usesOpenRouterPool(ctx('openrouter', 'm/x', { modelSelection: { spendCapUsd: 1 } }), creds)).toBe(false);
  });

  it('hard spend policy: Core refuses paid, unknown and unspecified cloud calls before any fetch', () => {
    const creds = new CloudCredentialStore();
    creds.set('groq', { baseUrl: 'https://groq.test/v1', apiKey: 'gsk_GROQKEY12345' }); // gitleaks:allow
    const build = (modelSelection?: object) => () => resolveAttemptModelBackend({ context: ctx('groq', 'm/x', { modelSelection }), db, cloudCredentials: creds });
    expect(build({ cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' } })).not.toThrow();
    expect(build({ cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'paid' } })).toThrow(/Never incur paid usage|paid model/);
    expect(build({ cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'unknown' } })).toThrow(/not known to be free/);
    expect(build({ cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'promotional' } })).toThrow(/credits/);
    expect(build({ cloudSpend: { mode: 'FREE_ONLY', allowCredits: true, modelFreeness: 'promotional' } })).not.toThrow();
    expect(build(undefined)).toThrow(/no cloud spend policy/);
    expect(build({})).toThrow(/no cloud spend policy/);
    expect(build({ cloudSpend: { mode: 'UNRESTRICTED', modelFreeness: 'paid' } })).not.toThrow();
  });

  it('image attachments are sent with their real MIME type (PNG is not mislabelled as JPEG)', async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}\ndata: [DONE]\n', { status: 200 });
    }) as unknown as typeof fetch;
    const backend = new (await import('../runtime/openaiCompatibleBackend')).OpenAICompatibleModelBackend({ baseUrl: 'https://x.test/v1', apiKey: 'k', provider: 'groq', label: 'Groq', fetchFn });
    await backend.streamChat({ model: 'm', messages: [{ role: 'user', content: 'what is this', images: ['AAAA', 'BBBB'], imageMimeTypes: ['image/png', 'image/webp'] }, { role: 'user', content: 'legacy', images: ['CCCC'] }] }, () => undefined);
    expect(bodies[0]).toContain('data:image/png;base64,AAAA');
    expect(bodies[0]).toContain('data:image/webp;base64,BBBB');
    expect(bodies[0]).toContain('data:image/jpeg;base64,CCCC'); // only when no type was recorded
  });

  it('credential store rejects invalid provider ids, lists ids without keys, and clears all', () => {
    const creds = new CloudCredentialStore();
    expect(() => creds.set('../x', { baseUrl: 'https://a.test', apiKey: 'k-12345678' })).toThrow(/Invalid provider/);
    creds.set('groq', { baseUrl: 'https://a.test', apiKey: 'k-12345678' });
    expect(JSON.stringify(creds.providers())).not.toContain('k-12345678');
    creds.clearAll();
    expect(creds.providers()).toEqual([]);
  });

  it('labels mission authorization for any non-local provider as explicit cloud routing', () => {
    const env = buildMissionEnvelope({ workspaceRoot: process.cwd(), objective: 'x', model: 'm', selectedProvider: 'groq' });
    expect(env.routingPolicy).toBe('explicit-cloud');
    expect(env.selectedProvider).toBe('groq');
    expect(buildMissionEnvelope({ workspaceRoot: process.cwd(), objective: 'x', model: 'm', selectedProvider: 'ollama' }).routingPolicy).toBe('local-only');
  });
});
