import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SystemOneDecisionService } from '../../systemOne/SystemOneDecisionService';
import { isLoopbackEndpoint } from '../../systemOne/loopback';
import { OllayaProvider } from '../../systemOne/OllayaProvider';
import type { SystemOneSettings } from '../../systemOne/types';

const base: SystemOneSettings = { enabled: true, mode: 'shadow', provider: 'ollaya', endpoint: 'http://127.0.0.1:8771', model: null, timeoutMs: 500 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const telemetry = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-one-')); dirs.push(dir); return path.join(dir, 't', 'system-one-shadow.jsonl'); };
const okFetch = (intent: string) => (async () => ({ ok: true, json: async () => ({ answers: { intent: { choice: intent, probabilities: { [intent]: 0.9 } }, follow_up: { choice: 'mutation' } } }) })) as unknown as typeof fetch;
const readLines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

function serviceWithFetch(settings: SystemOneSettings, file: string, fetchImpl: typeof fetch): SystemOneDecisionService {
  return new SystemOneDecisionService(() => settings, () => file, s => new OllayaProvider(s.endpoint, fetchImpl));
}

describe('SystemOneDecisionService (shadow only, provider-independent) — M43.5/M43.7/M43.8/M43.12', () => {
  it('does nothing — and never calls the provider — unless explicitly enabled (mode=off invariant)', async () => {
    let calls = 0;
    const file = telemetry();
    const fetchSpy = (async () => { calls += 1; throw new Error('must not be called'); }) as unknown as typeof fetch;
    for (const settings of [{ ...base, enabled: false }, { ...base, mode: 'off' as const }]) {
      const service = serviceWithFetch(settings, file, fetchSpy);
      expect(await service.observeAsync({ text: 'hello', deterministicMode: 'chat' })).toBeUndefined();
    }
    expect(calls).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('records agreement/disagreement while the effective decision stays deterministic', async () => {
    const file = telemetry();
    const service = serviceWithFetch(base, file, okFetch('bounded_edit'));
    await service.observeAsync({ text: 'Okay, fix it.', deterministicMode: 'agent', conversationId: 'c1' });
    await service.observeAsync({ text: 'Why?', deterministicMode: 'chat', conversationId: 'c1' });
    const lines = readLines(file);
    expect(lines.map(line => line.agrees)).toEqual([true, false]);
    expect(lines.every((line: { effectiveSource: string }) => line.effectiveSource === 'deterministic')).toBe(true);
    expect(lines[0].systemOne.mappedMode).toBe('agent');
    expect(lines[0].systemOne.provider).toBe('ollaya');
  });

  it('supports an arbitrary configured model id, never hardcoding one', async () => {
    let sentModel: string | undefined;
    const fetchSpy = (async (_url: string, init: { body: string }) => {
      sentModel = JSON.parse(init.body).model;
      return { ok: true, json: async () => ({ answers: { intent: { choice: 'chat' } } }) };
    }) as unknown as typeof fetch;
    const file = telemetry();
    const service = serviceWithFetch({ ...base, model: 'kev:4b' }, file, fetchSpy);
    await service.observeAsync({ text: 'hi', deterministicMode: 'chat' });
    expect(sentModel).toBe('kev:4b');
    expect(readLines(file)[0].systemOne.model).toBe('kev:4b');
  });

  it('is non-blocking on every failure and still records a diagnostic (M43.7/M43.8), returning undefined so routing is unaffected', async () => {
    const file = telemetry();
    const failing: Array<typeof fetch> = [
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
      (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
      (async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) as unknown as typeof fetch,
      ((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch,
    ];
    for (const fetchImpl of failing) {
      const service = serviceWithFetch({ ...base, timeoutMs: 60 }, file, fetchImpl);
      expect(() => service.observe({ text: 'sync-call-must-not-throw', deterministicMode: 'chat' })).not.toThrow();
      expect(await service.observeAsync({ text: 'x', deterministicMode: 'chat' })).toBeUndefined();
    }
    const lines = readLines(file).filter((line: { textPreview: string }) => line.textPreview === 'x');
    expect(lines).toHaveLength(failing.length);
    expect(lines.every((line: { error: string | null }) => typeof line.error === 'string')).toBe(true);
  });

  it('an unknown provider name fails open to deterministic routing without ever touching the network', async () => {
    const file = telemetry();
    const service = new SystemOneDecisionService(() => ({ ...base, provider: 'not-a-real-provider' }), () => file);
    expect(await service.observeAsync({ text: 'x', deterministicMode: 'chat' })).toBeUndefined();
    const lines = readLines(file);
    expect(lines[0].error).toMatch(/unknown System-One provider/);
  });

  it('refuses any non-loopback endpoint before ever building a provider, so conversation text can never leave the machine', async () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:8771')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:8771')).toBe(true);
    expect(isLoopbackEndpoint('http://192.168.1.10:8771')).toBe(false);
    expect(isLoopbackEndpoint('https://api.example.com')).toBe(false);
    let calls = 0;
    const service = serviceWithFetch({ ...base, endpoint: 'http://10.0.0.5:8771' }, telemetry(), (async () => { calls += 1; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch);
    expect(await service.observeAsync({ text: 'x', deterministicMode: 'chat' })).toBeUndefined();
    expect(calls).toBe(0);
  });
});
