import { describe, expect, it } from 'vitest';
import { decideCloudPublicText, CLOUD_PUBLIC_TEXT_SYSTEM_PROMPT, type CloudPublicTextFacts } from '../runtime/cloudPublicText';
import { listCloudModels, testCloudConnection } from '../runtime/cloudProviderProbe';
import { ProviderCatalog } from '../platform/providerCatalog';

const SAFE: CloudPublicTextFacts = {
  approved: true,
  freeness: 'free',
  toolCount: 0,
  attachmentCount: 0,
  workspaceContext: false,
  memoryContext: false,
  autonomousContext: false,
  historyTurns: 0,
  text: 'What is the capital of France?',
};

const KEY = 'gsk_TESTKEY123456789'; // gitleaks:allow
const CRED = { baseUrl: 'https://groq.test/openai/v1', apiKey: KEY };

function jsonFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
}

describe('cloud public-text privacy gate', () => {
  it('allows only an approved, verified-free, context-free public text as exactly two messages', () => {
    const decision = decideCloudPublicText(SAFE);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.messages).toEqual([
      { role: 'system', content: CLOUD_PUBLIC_TEXT_SYSTEM_PROMPT },
      { role: 'user', content: SAFE.text },
    ]);
  });

  it('refuses each private context and unverified state, in a fixed order, with no message built', () => {
    const cases: Array<[Partial<CloudPublicTextFacts>, string]> = [
      [{ approved: false }, 'approval_missing'],
      [{ freeness: 'unknown' }, 'not_verified_free'],
      [{ freeness: 'promotional' }, 'not_verified_free'],
      [{ freeness: 'paid' }, 'not_verified_free'],
      [{ toolCount: 3 }, 'tools_present'],
      [{ attachmentCount: 1 }, 'attachments_present'],
      [{ workspaceContext: true }, 'workspace_context'],
      [{ memoryContext: true }, 'memory_context'],
      [{ autonomousContext: true }, 'autonomous_context'],
      [{ historyTurns: 2 }, 'history_present'],
      [{ text: '   ' }, 'text_empty'],
      [{ text: 'x'.repeat(4001) }, 'text_too_long'],
      [{ text: 'my key is sk-abcdefghijklmnop' }, 'secret_like_text'],
    ];
    for (const [patch, code] of cases) {
      const decision = decideCloudPublicText({ ...SAFE, ...patch });
      expect(decision.allowed, code).toBe(false);
      if (!decision.allowed) {
        expect(decision.code).toBe(code);
        expect(decision.reason).toContain('Nothing was sent');
      }
    }
  });
});

describe('cloud model discovery', () => {
  const groq = new ProviderCatalog().get('groq')!;

  it('offers only free generative models and counts every exclusion by reason', async () => {
    const body = {
      data: [
        { id: 'llama-3.1-8b-instant', context_length: 131072 },
        { id: 'nomic-embed-text', context_length: 8192 },
        { id: 'whisper-large-v3' },
      ],
    };
    const listing = await listCloudModels(groq, CRED, { fetchFn: jsonFetch(200, body) });
    expect(listing.ok).toBe(true);
    expect(listing.pool.map((m) => m.id)).toEqual(['llama-3.1-8b-instant']);
    expect(listing.pool[0].contextWindow).toBe(131072);
    expect(listing.excluded.nonGenerative).toBe(2);
  });

  it('uses pricing for OpenRouter: zero price is free, any positive price is paid, missing price is unknown', async () => {
    const openrouter = new ProviderCatalog().get('openrouter')!;
    const body = {
      data: [
        { id: 'vendor/free-model:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'vendor/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'vendor/no-price' },
      ],
    };
    const listing = await listCloudModels(openrouter, { baseUrl: 'https://openrouter.test/api/v1', apiKey: 'sk-or-v1-abcdefgh' }, { fetchFn: jsonFetch(200, body) }); // gitleaks:allow
    expect(listing.pool.map((m) => m.id)).toEqual(['vendor/free-model:free']);
    expect(listing.excluded.paid).toBe(1);
    expect(listing.excluded.unknown).toBe(1);
  });

  it('never leaks the key into a failure message and classifies auth errors', async () => {
    const listing = await listCloudModels(groq, CRED, { fetchFn: jsonFetch(401, `bad key ${KEY}`) });
    expect(listing.ok).toBe(false);
    expect(listing.errorClass).toBe('auth');
    expect(listing.error).not.toContain(KEY);
    expect(listing.pool).toEqual([]);
  });

  it('reports an unreachable provider without throwing', async () => {
    const failing = (async () => { throw new TypeError(`socket hang up for ${KEY}`); }) as unknown as typeof fetch;
    const listing = await listCloudModels(groq, CRED, { fetchFn: failing });
    expect(listing.ok).toBe(false);
    expect(listing.errorClass).toBe('unreachable');
    expect(listing.error).not.toContain(KEY);
  });
});

describe('cloud connection test', () => {
  it('sends one fixed public prompt, records latency and provider limits, and reports the reply', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'x-ratelimit-remaining-requests': '28', 'x-ratelimit-limit-requests': '30' },
      });
    }) as unknown as typeof fetch;
    const result = await testCloudConnection(CRED, 'llama-3.1-8b-instant', { fetchFn });
    expect(result.ok).toBe(true);
    expect(result.replyPreview).toBe('OK');
    expect(result.rateLimit.remainingRequests).toBe('28');
    expect(seen[0].url).toBe('https://groq.test/openai/v1/chat/completions');
    const sent = JSON.parse(seen[0].body);
    expect(sent.messages).toEqual([{ role: 'user', content: 'Reply with the single word OK.' }]);
    expect(sent.max_tokens).toBe(8);
  });

  it('classifies rate limits and unavailable models', async () => {
    const limited = await testCloudConnection(CRED, 'm', { fetchFn: jsonFetch(429, 'slow down', { 'retry-after': '20' }) });
    expect(limited.errorClass).toBe('rate_limited');
    expect(limited.rateLimit.retryAfter).toBe('20');
    const gone = await testCloudConnection(CRED, 'm', { fetchFn: jsonFetch(404, 'no such model') });
    expect(gone.errorClass).toBe('model_unavailable');
  });
});

describe('your own OpenAI-compatible server', () => {
  it('is free of charge only on this PC or your own network', async () => {
    const { isPrivateEndpoint, ProviderCatalog } = await import('../platform/providerCatalog');
    for (const url of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://192.168.2.40:8080/v1', 'http://10.1.2.3/v1', 'http://172.20.0.5/v1', 'http://gpu-box.local:8000/v1', 'http://[::1]:8080/v1']) {
      expect(isPrivateEndpoint(url), url).toBe(true);
    }
    for (const url of ['https://api.openai.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'https://my-llm.example.com/v1', 'not a url']) {
      expect(isPrivateEndpoint(url), url).toBe(false);
    }
    const catalog = new ProviderCatalog();
    const custom = catalog.get('custom-openai');
    expect(custom?.modelRules?.freeness?.kind).toBe('self-hosted');
    expect(custom?.requiresBaseUrlInput).toBe(true);
  });

  it('lists every model of a private server as free, and refuses a public address without calling it', async () => {
    const { listCloudModels } = await import('../runtime/cloudProviderProbe');
    const { ProviderCatalog } = await import('../platform/providerCatalog');
    const descriptor = new ProviderCatalog().get('custom-openai')!;
    const calls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'text-embedding-3-small' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const local = await listCloudModels(descriptor, { baseUrl: 'http://192.168.2.40:8080/v1', apiKey: 'sk-local-1234567890' }, { fetchFn });
    expect(local.ok).toBe(true);
    expect(local.pool.map((m) => m.id)).toEqual(['qwen2.5-7b-instruct']);
    expect(calls).toEqual(['http://192.168.2.40:8080/v1/models']);

    calls.length = 0;
    const publicTry = await listCloudModels(descriptor, { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-public-1234567890' }, { fetchFn });
    expect(publicTry.ok).toBe(false);
    expect(publicTry.error).toMatch(/own network/);
    expect(calls).toHaveLength(0);
  });
});
