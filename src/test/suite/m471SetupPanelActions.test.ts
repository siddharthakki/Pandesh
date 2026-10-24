import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { OnboardingPanel } from '../../onboarding/OnboardingPanel';
import type { OnboardingService } from '../../onboarding/OnboardingService';
import { evaluateOnboardingReadiness, type OnboardingReadiness } from '../../onboarding/OnboardingReadiness';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import type { TaskModelCandidate } from '../../models/TaskModelSelection';

/**
 * The Setup panel's message handling: what each button does, with the service stubbed at its boundary. Rendering is
 * covered in m471SetupConfiguration; this proves the actions are wired, validated, and honest about their outcome.
 */
function candidate(model: string): TaskModelCandidate {
  const registry = ModelCapabilityRegistry.getInstance();
  return {
    provider: 'ollama',
    model,
    available: true,
    capabilities: registry.getCapabilities(model, 'ollama'),
    configuredRoles: ['agent', 'chat', 'edit', 'reviewer'],
    reliability: registry.getObservedReliability(model),
  };
}

function readiness(over: Partial<Parameters<typeof evaluateOnboardingReadiness>[0]> = {}): OnboardingReadiness {
  return evaluateOnboardingReadiness({
    providerType: 'ollama',
    provider: { providerType: 'ollama', label: 'Ollama', apiBase: 'http://127.0.0.1:11434', reachable: true, detail: 'ok' },
    coreRuntime: { connected: true, state: 'connected', summary: 'connected' },
    candidates: [candidate('qwen3.8:27b-mtp-q4_k_m'), candidate('gemma4:12b')],
    cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    build: { version: '0.1.1', milestone: 'M47.1', sha: 'abc1234', dirty: false },
    advanced: { context: { kind: 'auto' }, outputReservation: { kind: 'auto' }, wireOutputCap: 'not_sent', reasoning: 'auto', recoveryCeiling: { tokens: 32_768, source: 'default' } },
    ...over,
  });
}

describe('Setup panel actions', () => {
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let context: ReturnType<typeof vscodeMock.createMockExtensionContext>;
  let panelHandle: { renders: string[]; send(message: unknown): Promise<void> };
  let clipboard: string[];

  const settle = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(async () => {
    (OnboardingPanel as unknown as { current?: OnboardingPanel }).current = undefined;
    vscodeMock._resetConfig();
    context = vscodeMock.createMockExtensionContext();
    clipboard = [];
    vi.spyOn(vscodeMock.env.clipboard, 'writeText').mockImplementation(async (text: string) => { clipboard.push(text); });
    service = {
      assess: vi.fn(async () => readiness()),
      setModeModel: vi.fn(async () => ({ ok: true as const })),
      setEndpoint: vi.fn(async () => ({ ok: true as const, endpoint: 'http://127.0.0.1:11434' })),
      testConnection: vi.fn(async () => ({ ok: true, message: 'Connected to http://127.0.0.1:11434.' })),
      reprobe: vi.fn(async () => ({ status: 'probed' as const })),
    };
    const panel = await OnboardingPanel.show(context as never, service as unknown as OnboardingService, async () => {});
    const raw = (panel as unknown as { panel: { renders: string[]; messageEmitter: { fire(message: unknown): void } } }).panel;
    panelHandle = {
      renders: raw.renders,
      send: async message => { raw.messageEmitter.fire(message); await settle(); await settle(); },
    };
  });

  it('copies diagnostics that contain the build and no secrets, and confirms it', async () => {
    service.assess.mockResolvedValue(readiness({
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, apiBase: 'http://u:hunter2@127.0.0.1:11434/?token=abc', detail: 'ok' },
    }));
    await panelHandle.send({ type: 'recheck' });
    await panelHandle.send({ type: 'copyDiagnostics' });
    expect(clipboard).toHaveLength(1);
    expect(clipboard[0]).toContain('Build: 0.1.1 · M47.1 · abc1234');
    expect(clipboard[0]).not.toContain('hunter2');
    expect(clipboard[0]).not.toContain('token=abc');
    expect(panelHandle.renders.at(-1)).toContain('Diagnostics copied');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('a mode change saves through the validating service and reports success', async () => {
    vscodeMock._setQuickPickSelection({ label: 'gemma4:12b', model: 'gemma4:12b' });
    await panelHandle.send({ type: 'changeMode', mode: 'baat_kar' });
    expect(service.setModeModel).toHaveBeenCalledWith('baat_kar', 'gemma4:12b');
    expect(panelHandle.renders.at(-1)).toContain('will use gemma4:12b');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('switching a mode back to Auto passes the empty model', async () => {
    vscodeMock._setQuickPickSelection({ label: 'Auto', model: '' });
    await panelHandle.send({ type: 'changeMode', mode: 'karke_dikha' });
    expect(service.setModeModel).toHaveBeenCalledWith('karke_dikha', '');
    expect(panelHandle.renders.at(-1)).toContain('back on Auto');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('a refused manual choice is not saved and the reason is shown', async () => {
    service.setModeModel.mockResolvedValue({ ok: false as const, reason: 'The explicit override model "tiny" is incompatible with the task requirements.' });
    vscodeMock._setQuickPickSelection({ label: 'tiny', model: 'tiny' });
    await panelHandle.send({ type: 'changeMode', mode: 'karke_dikha' });
    expect(panelHandle.renders.at(-1)).toContain('class="notice bad"');
    expect(panelHandle.renders.at(-1)).toContain('Not saved.');
    expect(panelHandle.renders.at(-1)).toContain('incompatible');
  });

  it('cancelling the picker changes nothing', async () => {
    vscodeMock._setQuickPickSelection(undefined);
    await panelHandle.send({ type: 'changeMode', mode: 'saath_kar' });
    expect(service.setModeModel).not.toHaveBeenCalled();
  });

  it('an invalid endpoint is rejected with the reason; a valid one triggers a re-check', async () => {
    vscodeMock._setInputBoxValue('nonsense');
    service.setEndpoint.mockResolvedValueOnce({ ok: false as const, reason: 'Enter a full URL such as http://127.0.0.1:11434.' });
    await panelHandle.send({ type: 'editEndpoint' });
    expect(panelHandle.renders.at(-1)).toContain('Enter a full URL');

    const assessments = service.assess.mock.calls.length;
    vscodeMock._setInputBoxValue('http://127.0.0.1:11434');
    await panelHandle.send({ type: 'editEndpoint' });
    expect(service.assess.mock.calls.length).toBeGreaterThan(assessments);
    expect(panelHandle.renders.at(-1)).toContain('Endpoint saved and reachable');
  });

  it('test connection shows its own result without re-assessing models', async () => {
    const assessments = service.assess.mock.calls.length;
    service.testConnection.mockResolvedValue({ ok: false, message: 'Could not reach http://127.0.0.1:11434: ECONNREFUSED' });
    await panelHandle.send({ type: 'testConnection' });
    expect(service.assess.mock.calls.length).toBe(assessments);
    expect(panelHandle.renders.at(-1)).toContain('Could not reach');
    expect(panelHandle.renders.at(-1)).toContain('class="notice bad"');
  });

  it('re-probe reports a cooldown instead of repeating the work, and a real probe refreshes the view', async () => {
    service.reprobe.mockResolvedValueOnce({ status: 'cooldown' as const, retryAfterMs: 42_000 });
    await panelHandle.send({ type: 'reprobe', model: 'qwen3.8:27b-mtp-q4_k_m' });
    expect(panelHandle.renders.at(-1)).toContain('probed moments ago');
    expect(panelHandle.renders.at(-1)).toContain('42 s');

    const assessments = service.assess.mock.calls.length;
    await panelHandle.send({ type: 'reprobe', model: 'qwen3.8:27b-mtp-q4_k_m' });
    expect(service.assess.mock.calls.length).toBeGreaterThan(assessments);
    expect(panelHandle.renders.at(-1)).toContain('Re-probed');
  });

  it('remembers which sections the user opened across re-renders', async () => {
    await panelHandle.send({ type: 'toggleSection', id: 'models', open: true });
    await panelHandle.send({ type: 'recheck' });
    expect(panelHandle.renders.at(-1)).toMatch(/data-section="models" open>/);
    await panelHandle.send({ type: 'toggleSection', id: 'models', open: false });
    await panelHandle.send({ type: 'recheck' });
    expect(panelHandle.renders.at(-1)).not.toMatch(/data-section="models" open>/);
  });

  it('turning cloud fallback off writes local-only and says so', async () => {
    await panelHandle.send({ type: 'disableCloudFallback' });
    expect(vscodeMock._configUpdates().some(update => update.key === 'ollama-agent.modelRoutingPolicy' && update.value === 'local-only')).toBe(true);
    expect(panelHandle.renders.at(-1)).toContain('Cloud fallback is off');
  });

  it('opening and re-rendering Setup never touches the cloud setup flow', async () => {
    const cloud = vi.fn(async () => {});
    (OnboardingPanel as unknown as { current?: OnboardingPanel }).current = undefined;
    await OnboardingPanel.show(context as never, service as unknown as OnboardingService, cloud);
    await panelHandle.send({ type: 'recheck' });
    expect(cloud).not.toHaveBeenCalled();
  });
});
