/**
 * LIVE Setup acceptance against a real local Ollama. Skipped unless KKD_LIVE_SETUP=1.
 *
 *   KKD_LIVE_SETUP=1 [KKD_LIVE_SETUP_OUT=file.json] npx vitest run src/test/suite/m471SetupLive.test.ts
 *
 * Exercises the production OnboardingService (the same object the Setup panel drives) with the real provider:
 * discovery, per-mode Auto/manual (including a refused manual choice), bounded re-probe and its cooldown, an
 * unavailable endpoint and recovery, diagnostics redaction, and that assessing makes no non-loopback request.
 * Nothing about the model's answers is judged here; this is about the configuration surface being truthful.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscodeMock from '../mocks/vscode';
import { Config } from '../../config/Config';
import { OnboardingService } from '../../onboarding/OnboardingService';
import { buildDiagnosticsText } from '../../onboarding/OnboardingDiagnostics';
import { renderSetupHtml } from '../../onboarding/OnboardingView';
import { RuntimeIntelligence } from '../../runtimeProfile/RuntimeIntelligence';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';

const enabled = process.env.KKD_LIVE_SETUP === '1';
const ENDPOINT = process.env.KKD_LIVE_OLLAMA ?? 'http://127.0.0.1:11434';
const PROBE_MODEL = process.env.KKD_LIVE_SETUP_MODEL ?? 'gemma4:12b';
const NO_TOOLS_MODEL = process.env.KKD_LIVE_SETUP_NO_TOOLS_MODEL ?? 'functiongemma:270m';

const report: Record<string, unknown> = {};

describe.skipIf(!enabled)('Setup against a real Ollama', () => {
  let dir: string;
  let service: OnboardingService;
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  const render = (readiness: Awaited<ReturnType<OnboardingService['assess']>>) =>
    renderSetupHtml({ loading: false, readiness, openSections: new Set(['models', 'profile', 'advanced', 'fallback']) }, 'vscode-test', 'n');

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-live-setup-'));
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.apiBase', ENDPOINT);
    ModelCapabilityRegistry.resetInstance();
    RuntimeIntelligence.configureShared({ enabled: true, storePath: path.join(dir, 'runtime-profiles.json') });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetched.push(String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url));
      return realFetch(input, init);
    }) as typeof fetch;
    service = new OnboardingService(vscodeMock.createMockExtensionContext().secrets as never, () => ({ state: 'connected' }), '0.1.1');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (process.env.KKD_LIVE_SETUP_OUT) await fs.writeFile(process.env.KKD_LIVE_SETUP_OUT, JSON.stringify(report, null, 2));
    console.log('M471_LIVE_SETUP', JSON.stringify(report));
  });

  it('detects Ollama, shows the endpoint and the models the runtime actually reports, local-only by default', async () => {
    const readiness = await service.assess();
    expect(readiness.provider.reachable).toBe(true);
    expect(readiness.provider.apiBase).toBe(ENDPOINT);
    expect(readiness.models.length).toBeGreaterThan(0);
    expect(readiness.cloudFallback.policy).toBe('local-only');
    expect(readiness.modes.map(mode => mode.selection)).toEqual(['auto', 'auto', 'auto']);
    const html = render(readiness);
    for (const model of readiness.models.slice(0, 3)) expect(html).toContain(model.name);
    expect(html).toContain('Cloud fallback: Off');
    // Opening/assessing Setup contacts only the local provider.
    for (const url of fetched) expect(new URL(url).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/);
    report.discovery = {
      endpoint: readiness.provider.apiBase,
      models: readiness.models.map(model => ({ name: model.name, state: model.state, ctx: model.contextTokens, tools: model.tools, structured: model.structuredOutput, reasoning: model.reasoning, profile: model.profileStatus })),
      autoModes: readiness.modes.map(mode => ({ mode: mode.label, model: mode.model, ready: mode.ready, fallbackOrder: mode.fallbackOrder })),
      overall: readiness.overall,
      fetchHosts: [...new Set(fetched.map(url => new URL(url).host))],
    };
  }, 60_000);

  it('Auto/manual per mode: a capable manual choice is used, an incapable one is refused, back to Auto works', async () => {
    const before = await service.assess();
    const available = before.models.filter(model => model.state === 'ready').map(model => model.name);
    expect(available).toContain(PROBE_MODEL);

    expect(await service.setModeModel('baat_kar', PROBE_MODEL)).toEqual({ ok: true });
    let readiness = await service.assess();
    expect(readiness.modes.find(mode => mode.mode === 'baat_kar')).toMatchObject({ selection: 'manual', manualModel: PROBE_MODEL, ready: true, model: PROBE_MODEL });

    const refused = available.includes(NO_TOOLS_MODEL) ? await service.setModeModel('karke_dikha', NO_TOOLS_MODEL) : { ok: false as const, reason: 'model not installed here' };
    expect(refused.ok).toBe(false);
    readiness = await service.assess();
    expect(readiness.modes.find(mode => mode.mode === 'karke_dikha')?.selection).toBe('auto');

    expect(await service.setModeModel('baat_kar', '')).toEqual({ ok: true });
    readiness = await service.assess();
    expect(readiness.modes.find(mode => mode.mode === 'baat_kar')?.selection).toBe('auto');
    report.perMode = { manualAccepted: PROBE_MODEL, incapableRefusedFor: 'karke_dikha', refusal: 'reason' in refused ? refused.reason : undefined, backToAuto: true };
  }, 120_000);

  it('Re-probe is real, bounded, and the profile view updates', async () => {
    const first = await service.reprobe(PROBE_MODEL);
    expect(first.status).toBe('probed');
    const readiness = await service.assess();
    const model = readiness.models.find(item => item.name === PROBE_MODEL)!;
    expect(model.profileStatus).not.toBe('none');
    const second = await service.reprobe(PROBE_MODEL);
    expect(second.status).toBe('cooldown');
    expect(render(readiness)).toContain('Profile details');
    report.reprobe = {
      first: first.status,
      second: second.status,
      profile: { source: model.profileStatus, complete: model.profile?.complete, steps: model.profile?.completedSteps, structured: model.structuredOutput, tools: model.tools, reasoning: model.reasoning, ctx: model.contextTokens, probedAt: model.probedAt },
    };
  }, 300_000);

  it('an unavailable endpoint gives actionable controls, and Setup recovers when the provider is back', async () => {
    expect(await service.setEndpoint('http://127.0.0.1:1')).toMatchObject({ ok: true });
    const down = await service.assess();
    expect(down.provider.reachable).toBe(false);
    expect(down.overall).toBe('not_ready');
    const html = render(down);
    for (const label of ['Edit endpoint', 'Retry', 'Setup help', 'Test connection']) expect(html).toContain(`>${label}<`);
    const test = await service.testConnection();
    expect(test.ok).toBe(false);

    expect(await service.setEndpoint(ENDPOINT)).toMatchObject({ ok: true });
    const up = await service.assess();
    expect(up.provider.reachable).toBe(true);
    expect(Config.getApiBase()).toBe(ENDPOINT);
    report.unavailable = { overallWhenDown: down.overall, detail: down.provider.detail, testConnection: test.message, recovered: up.provider.reachable };
  }, 120_000);

  it('diagnostics carry the build and runtime summary and no secrets', async () => {
    const readiness = await service.assess();
    const text = buildDiagnosticsText(readiness);
    expect(text).toMatch(/Build: 0\.1\.1 · M47\.1 · \S+/);
    expect(text).toContain('Provider: Ollama (ollama) at');
    expect(text).toContain('Data policy: local-only');
    expect(text).not.toMatch(/api[_-]?key|bearer|token=|password/i);
    report.diagnosticsPreview = text.split('\n').slice(0, 12);
  }, 60_000);
});
