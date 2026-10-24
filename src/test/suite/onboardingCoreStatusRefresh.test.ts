import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { createMockExtensionContext, EventEmitter } from '../mocks/vscode';
import { OnboardingPanel } from '../../onboarding/OnboardingPanel';
import type { OnboardingReadiness } from '../../onboarding/OnboardingReadiness';
import type { OnboardingService } from '../../onboarding/OnboardingService';
import type { CoreConnectionStatus } from '../../core-client/ConnectionState';

/**
 * PRODUCTION-PATH REGRESSION — packaged onboarding stuck on "Core runtime
 * starting".
 *
 * Core is launched in the background and `activate()` opens this panel
 * immediately afterwards, so the panel's one-shot assessment at open time
 * essentially always observes `starting`. The panel had no subscription to
 * CoreManager's status event and re-assessed only when the user clicked
 * "Re-check setup", so it stayed pinned to "Core runtime starting"
 * indefinitely even though Core connected a second later. Because
 * `coreRuntime.connected` gates every mode and the overall verdict, the whole
 * surface stayed NOT READY.
 *
 * The invariant asserted here is the real one: once CoreManager reaches
 * `connected`, the onboarding UI cannot remain indefinitely in "Core runtime
 * starting" — and a slower, older assessment must never overwrite the newer
 * READY state.
 */

function readinessFor(status: CoreConnectionStatus): OnboardingReadiness {
  const connected = status.state === 'connected';
  return {
    overall: connected ? 'ready' : 'not_ready',
    provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'Ollama is running and reachable.' },
    coreRuntime: {
      connected,
      state: status.state,
      detail: status.detail,
      summary: connected ? 'KarkeDikha Core is connected.' : 'KarkeDikha Core is starting.',
    },
    modes: [],
    installedModelCount: 1,
    cloudFallback: {
      policy: 'local-only',
      configured: false,
      summary: 'Off. Repository and task content stays on this machine.',
    },
  } as unknown as OnboardingReadiness;
}

describe('OnboardingPanel re-assesses when Core status changes', () => {
  let context: ReturnType<typeof createMockExtensionContext>;
  let statusEmitter: EventEmitter<CoreConnectionStatus>;
  let status: CoreConnectionStatus;

  beforeEach(() => {
    // Static `current` is module state; each case gets a fresh panel.
    (OnboardingPanel as unknown as { current?: OnboardingPanel }).current = undefined;
    context = createMockExtensionContext();
    statusEmitter = new EventEmitter<CoreConnectionStatus>();
    status = { state: 'starting' };
  });

  function serviceReadingLiveStatus(
    hook?: (generation: number) => Promise<void>,
  ): { service: OnboardingService; assessments: number } {
    const state = { assessments: 0 };
    const service = {
      assess: async () => {
        const generation = ++state.assessments;
        const observed = status;
        if (hook) await hook(generation);
        return readinessFor(observed);
      },
    } as unknown as OnboardingService;
    return { service, get assessments() { return state.assessments; } };
  }

  it('renders READY after CoreManager reaches connected, without user re-check', async () => {
    const { service } = serviceReadingLiveStatus();

    const panel = await OnboardingPanel.show(
      context as never,
      service,
      async () => {},
      statusEmitter.event as unknown as vscode.Event<unknown>,
    );
    const rendered = (panel as unknown as { panel: { renders: string[] } }).panel;

    // Opened while Core is still starting — this is the real activation order.
    expect(rendered.renders.at(-1)).toContain('Core runtime starting');

    // Core connects in the background. No user interaction whatsoever.
    status = { state: 'connected' };
    statusEmitter.fire(status);
    await new Promise((resolve) => setImmediate(resolve));

    expect(rendered.renders.at(-1)).toContain('Core runtime connected');
    expect(rendered.renders.at(-1)).not.toContain('Core runtime starting');
  });

  it('a slower stale starting assessment cannot overwrite the newer connected one', async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // Generation 1 (the `starting` assessment) is held open so it resolves
    // *after* generation 2 (the `connected` one) has already published.
    const { service } = serviceReadingLiveStatus(async (generation) => {
      if (generation === 1) await firstHeld;
    });

    const showPromise = OnboardingPanel.show(
      context as never,
      service,
      async () => {},
      statusEmitter.event as unknown as vscode.Event<unknown>,
    );
    await new Promise((resolve) => setImmediate(resolve));

    // Core connects while the first assessment is still in flight.
    status = { state: 'connected' };
    statusEmitter.fire(status);
    await new Promise((resolve) => setImmediate(resolve));

    // Now let the stale STARTING assessment finally resolve.
    releaseFirst();
    await showPromise;
    await new Promise((resolve) => setImmediate(resolve));

    const panel = (OnboardingPanel as unknown as { current: OnboardingPanel }).current;
    const rendered = (panel as unknown as { panel: { renders: string[] } }).panel;

    expect(rendered.renders.at(-1)).toContain('Core runtime connected');
    expect(rendered.renders.at(-1)).not.toContain('Core runtime starting');
  });

  it('without the status subscription the panel stays stuck (characterizes the defect)', async () => {
    const { service } = serviceReadingLiveStatus();

    const panel = await OnboardingPanel.show(context as never, service, async () => {});
    const rendered = (panel as unknown as { panel: { renders: string[] } }).panel;

    status = { state: 'connected' };
    statusEmitter.fire(status);
    await new Promise((resolve) => setImmediate(resolve));

    // No subscription was passed, so nothing re-assesses — this is exactly the
    // packaged behaviour before the fix.
    expect(rendered.renders.at(-1)).toContain('Core runtime starting');
  });
});
