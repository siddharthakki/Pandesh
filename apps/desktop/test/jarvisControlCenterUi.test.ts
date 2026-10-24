/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents, eventFromSummary, RECORDED_START } from './recordedMissionStream';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });

  (window as unknown as {
    jarvisVoiceCapture: {
      startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void };
      bytesToBase64: (bytes: Uint8Array) => string;
    };
    karkedikhaDesktop: Record<string, unknown>;
  }).jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({
      stop: async () => null,
      cancel: () => undefined,
    }),
    bytesToBase64: () => '',
  };

  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = {
    getSnapshot: async () => currentSnapshot,
    pickFolder: async () => currentSnapshot,
    submitTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    cancel: async () => undefined,
    selectWorker: async () => currentSnapshot,
    selectProvider: async () => currentSnapshot,
    listModels: async () => ['qwen2.5-coder:1.5b'],
    selectModel: async () => currentSnapshot,
    transcribeUtterance: async () => ({ transcript: 'mock', engine: 'whisper' }),
    getHostTelemetry: async () => currentSnapshot?.hostTelemetry ?? null,
    refreshEverydayTools: async () => currentSnapshot,
    startWebResearch: vi.fn(async () => ({
      researchId: 'research-1', conversationId: 'conv-1', approvalId: 'rappr-1',
      requestedActionDigest: 'digest-1', provider: 'searxng', queryPreview: '<img src=x onerror=alert(1)>', maxSources: 3,
    })),
    resolveWebResearch: vi.fn(async () => ({
      researchId: 'research-1', conversationId: 'conv-1', query: 'question', state: 'completed',
      answer: 'Grounded answer [S1]', failureClassification: null,
      sources: [{ rank: 1, title: '<script>alert(1)</script>', url: 'https://example.com/report', status: 'fetched' }],
    })),
    getWebResearch: vi.fn(),
    openExternalUrl: vi.fn(async () => ({ opened: true })),
    openWorkspaceFolder: vi.fn(async () => ({ opened: true })),
    onEvent: (listener: () => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

async function paint(snapshot: DesktopSnapshot): Promise<void> {
  currentSnapshot = snapshot;
  for (const listener of listeners) listener();
  await Promise.resolve();
  await Promise.resolve();
}

function idleSnap(extra: Partial<DesktopSnapshot> = {}) {
  return desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), {
    installedModels: ['qwen2.5-coder:1.5b'],
    ...extra,
  });
}

describe('Jarvis control-center UI refinement', () => {
  it('keeps Talk to Jarvis and one prominent Mic control visible', async () => {
    await paint(idleSnap());
    expect(document.querySelector('.jarvis-hero h1')?.textContent).toBe('Talk to Jarvis');
    const mic = document.getElementById('mic-button');
    expect(mic?.classList.contains('mic-prominent')).toBe(true);
    expect(mic?.querySelector('.mic-glyph')).toBeTruthy();
    expect(document.getElementById('mic-label')?.textContent).toBe('Mic');
    expect(document.getElementById('mic-toggle-btn')).toBeNull();
    expect(mic?.getAttribute('aria-label')).toMatch(/Talk to Jarvis/i);
    expect(mic?.getAttribute('title')).toMatch(/Talk to Jarvis/i);
    expect(document.querySelector('.sticky-composer')).toBeTruthy();
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('.three-col')).toBeTruthy();
    expect(document.querySelector('.reactor-core')).toBeTruthy();
    expect(document.getElementById('waveform-canvas')).toBeTruthy();
    expect(document.getElementById('mission-timeline')?.classList.contains('execution-stepper')).toBe(true);
    expect(document.querySelector('.telem-panel')).toBeTruthy();
    // Conversation history is now the primary left-rail surface; weather is
    // still present below it rather than being assumed to be the first panel.
    expect(document.querySelector('.col-left')?.querySelector('.panel')).toBe(
      document.getElementById('conversations-rail'),
    );
    expect(document.querySelector('.col-left .weather-panel')).toBeTruthy();
    expect(document.querySelector('.col-left .telem-panel')).toBeTruthy();
  });

  it('labels the central Mic as Listening + Stop while capturing', async () => {
    document.getElementById('cancel')?.click();
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('listening');
    expect(document.getElementById('mic-label')?.textContent).toBe('Stop');
    expect(document.getElementById('neural-ready')?.textContent).toBe('Listening');
    expect(document.getElementById('mic-hint')?.textContent).toMatch(/Listening/i);
    document.getElementById('cancel')?.click();
  });

  it('shows No active workstream when idle and concise activity when a mission runs', async () => {
    await paint(idleSnap({
      task: null,
      requestId: null,
      attemptId: null,
    }));
    document.getElementById('cancel')?.click();
    await paint(idleSnap({
      task: null,
      requestId: null,
      attemptId: null,
    }));
    expect(document.getElementById('workstream-headline')?.textContent).toBe('No active workstream');
    expect((document.getElementById('activity-details') as HTMLDetailsElement | null)?.open ?? false).toBe(false);

    await paint(desktopSnapshotFromEvents([], cockpitInput({ running: true, terminal: false })));
    const headline = document.getElementById('workstream-headline')?.textContent || '';
    expect(headline).not.toBe('No active workstream');
    expect(headline.length).toBeGreaterThan(3);
    expect(document.getElementById('activity')).toBeTruthy();
  });

  it('uses Listening state chip and Stop listening label while capturing', async () => {
    document.getElementById('cancel')?.click();
    await paint(idleSnap());
    document.getElementById('mic-button')?.click();
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('listening');
    expect(document.getElementById('jarvis-state-label')?.textContent).toBe('Listening');
    expect(document.getElementById('mic-label')?.textContent).toBe('Stop');
    expect(document.getElementById('mic-toggle-btn')).toBeNull();
    expect(document.getElementById('mic-button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides full paths by default and collapses authorization behind details', async () => {
    const longPath = 'C:\\Projects\\very\\long\\nested\\workspace\\path\\reading-list';
    await paint(idleSnap({
      folder: longPath,
      taskScope: {
        repository: longPath,
        permittedActions: ['read_file', 'search', 'answer'],
        deliveryDestination: `local git commit in ${longPath}`,
        pushAuthorized: false,
        authorized: true,
      },
    }));
    expect(document.getElementById('folder-path')?.textContent).toBe('reading-list');
    expect(document.getElementById('folder-path')?.textContent).not.toMatch(/C:\\Projects/);
    expect(document.getElementById('pick-folder')?.getAttribute('title')).toBe(longPath);
    expect(document.getElementById('scope-delivery-result')?.textContent).toMatch(/local git commit in reading-list/);
    expect(document.getElementById('scope-delivery-result')?.textContent).not.toMatch(/C:\\Projects\\very/);
    const scope = document.getElementById('task-scope') as HTMLDetailsElement;
    expect(scope.open).toBe(false);
    expect(document.getElementById('scope-state')?.textContent).toBe('Mission authorized');
  });

  it('shows one progress sentence and a status timeline', async () => {
    await paint(desktopSnapshotFromEvents([], cockpitInput({ running: true, terminal: false })));
    expect(document.getElementById('activity-summary')?.textContent).toMatch(/Thinking|Working|mission/i);
    expect(document.getElementById('mission-timeline')).toBeTruthy();
    expect(document.getElementById('timeline-thinking')).toBeTruthy();
    expect(document.getElementById('timeline-checking')).toBeTruthy();
    expect(document.getElementById('timeline-verified')).toBeTruthy();
    expect(document.getElementById('timeline-delivered')).toBeTruthy();
    const events = document.getElementById('activity-details') as HTMLDetailsElement;
    expect(events.open ?? false).toBe(false);
  });

  it('keeps the linear mission stage monotonic across later model turns', async () => {
    const base = idleSnap({ running: true });
    await paint({
      ...base,
      cockpit: {
        ...base.cockpit,
        running: true,
        checkpoints: [
          { id: 'think', at: RECORDED_START, title: 'AI response', outcome: 'ok' },
          { id: 'inspect', at: RECORDED_START, title: 'Read templates/base.html', outcome: 'ok' },
          { id: 'execute', at: RECORDED_START, title: 'Authorization approved', outcome: 'ok' },
        ],
        currentAction: { title: 'AI response', startedAt: RECORDED_START },
      },
    });

    expect(document.getElementById('timeline-thinking')?.classList.contains('is-active')).toBe(false);
    expect(document.getElementById('timeline-checking')?.classList.contains('is-active')).toBe(false);
    expect(document.getElementById('timeline-verified')?.classList.contains('is-active')).toBe(true);
  });

  it('maps failed terminal outcomes and keeps diagnostics collapsed', async () => {
    await paint(desktopSnapshotFromEvents([
      eventFromSummary('exceeded 8 protocol-correction retries', RECORDED_START, { kind: 'error' }),
    ], cockpitInput({ running: false, terminal: true })));
    expect(document.querySelector('.app')?.getAttribute('data-jarvis-state')).toBe('failed');
    const diagnostics = document.getElementById('diagnostics') as HTMLDetailsElement;
    expect(diagnostics.open).toBe(false);
  });

  it('declares scroll regions for page, activity, diagnostics, and results', () => {
    const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
    expect(css).toMatch(/html\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.scroll-region/);
    expect(css).toMatch(/\.activity-scroll/);
    expect(css).toMatch(/\.diagnostics-scroll/);
    expect(css).toMatch(/scrollbar-gutter:\s*stable/);
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(document.getElementById('page-scroll')).toBeTruthy();
    expect(document.getElementById('page-scroll')?.classList.contains('three-col')).toBe(true);
    expect(document.getElementById('result')?.classList.contains('scroll-region')).toBe(true);
    expect(document.getElementById('checkpoint-pane')?.classList.contains('scroll-region')).toBe(true);
    expect(document.querySelector('.col-left')?.classList.contains('scroll-region')).toBe(true);
    expect(document.querySelector('.workstream-body')?.classList.contains('scroll-region')).toBe(true);
  });

  it('uses the quiet spatial canvas with a visible Jarvis focus and stable three-zone scrolling', () => {
    const css = fs.readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
    const app = document.querySelector('.app');
    expect(app?.getAttribute('data-ui')).toBe('quiet-spatial');
    expect(document.querySelector('.jarvis-hero h1')?.textContent).toBe('Talk to Jarvis');
    expect(document.querySelector('.jarvis-hero')?.classList.contains('sr-only')).toBe(false);
    expect(css).toMatch(/\.app\[data-ui="quiet-spatial"\]\s+\.page\.three-col\s*\{[^}]*grid-template-columns:\s*minmax/s);
    expect(css).toMatch(/\.app\[data-ui="quiet-spatial"\]\s+\.col-left,[\s\S]*?overflow-y:\s*auto/);
    expect(css).toMatch(/\.app\[data-ui="quiet-spatial"\]\s+\.workstream-body\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  });

  it('switches Terminal / Files / Assets tabs without fabricating asset content', async () => {
    await paint(idleSnap());
    expect(document.getElementById('btn-terminal')?.textContent).toBe('Today');
    expect(document.querySelector('#tab-terminal .surface-intro h2')?.textContent).toBe('Today');
    expect(document.querySelector('.hardware-more')).toBeTruthy();
    expect((document.querySelector('.hardware-more') as HTMLDetailsElement).open).toBe(false);
    expect(document.getElementById('tab-terminal')?.hidden).toBe(false);
    document.getElementById('btn-files')?.click();
    expect(document.getElementById('tab-files')?.hidden).toBe(false);
    expect(document.getElementById('tab-terminal')?.hidden).toBe(true);
    document.getElementById('btn-media')?.click();
    expect(document.getElementById('tab-assets')?.hidden).toBe(false);
    expect(document.getElementById('tab-assets')?.textContent).toMatch(/no artifacts yet/i);
    expect(document.getElementById('tab-assets')?.textContent).not.toMatch(/system_diagram|hud_preview/i);
  });

  it('requires research approval and renders answer/source content as inert text', async () => {
    const snap = idleSnap();
    await paint({
      ...snap,
      everydayTools: {
        ...snap.everydayTools,
        catalog: [
          ...snap.everydayTools.catalog.filter((entry) => entry.id !== 'web-research'),
          { id: 'web-research', label: 'Governed Web Research', availability: 'available', detail: 'Ready.' },
        ],
      },
    });
    document.getElementById('btn-tools')?.click();
    const input = document.getElementById('research-query') as HTMLInputElement;
    input.value = 'question';
    (document.getElementById('research-start') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('research-approval')?.hidden).toBe(false);
    expect(document.getElementById('research-approval-query')?.textContent).toContain('<img');
    expect(document.getElementById('research-approval-query')?.querySelector('img')).toBeNull();

    (document.getElementById('research-approve') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('research-result')?.textContent).toContain('Grounded answer [S1]');
    expect(document.getElementById('research-sources')?.textContent).toContain('<script>alert(1)</script>');
    expect(document.getElementById('research-sources')?.querySelector('script')).toBeNull();
  });
});
