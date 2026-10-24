/** @vitest-environment jsdom */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopAppMetadata } from '../src/ipc';

const rendererRoot = path.resolve(__dirname, '../renderer');

let appMetadata: DesktopAppMetadata = {
  productName: 'Pandesh',
  version: '0.1.1',
  buildNumber: 142,
  buildKind: 'release',
  releaseChannel: 'alpha',
  commit: 'd978955581b2742356299f89142d20d3b2c5da45',
  builtAt: '2026-10-23T09:50:18.560Z',
  installerVersion: '0.1.1',
  coreVersion: '0.1.1',
  coreVersionMismatch: false,
};

let diagnosticsReport = 'Pandesh 0.1.1\nbuild: b142 (release, alpha)';

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({ stop: async () => null, cancel: () => undefined }),
    bytesToBase64: () => '',
  } as never;
  window.karkedikhaDesktop = {
    getSnapshot: async () => null,
    onEvent: () => () => undefined,
    listConversations: async () => [],
    openConversation: async () => ({
      conversation: { id: 'c', title: null, preview: null, state: 'active', repositoryName: null, createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: false },
      messages: [],
      context: { state: 'no_workspace', repositoryName: null, objective: null, latestUserIntent: null, executionPolicy: null, pendingAction: null, relevantFiles: [], relevantSymbols: [], constraints: [], findings: null, validation: null, attachmentNames: [], citationCount: 0, researchSourceCount: 0, messageCount: 0, updatedAt: '' },
    }),
    searchConversations: async () => [],
    getAppMetadata: async () => appMetadata,
    getDiagnosticsReport: async () => diagnosticsReport,
  } as never;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (0, eval)(fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8'));
});

beforeEach(() => {
  appMetadata = {
    productName: 'Pandesh',
    version: '0.1.1',
    buildNumber: 142,
    buildKind: 'release',
    releaseChannel: 'alpha',
    commit: 'd978955581b2742356299f89142d20d3b2c5da45',
    builtAt: '2026-10-23T09:50:18.560Z',
    installerVersion: '0.1.1',
    coreVersion: '0.1.1',
    coreVersionMismatch: false,
  };
  diagnosticsReport = 'Pandesh 0.1.1\nbuild: b142 (release, alpha)';
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Opening the About panel re-reads the live facts from the host. */
async function openAbout(): Promise<void> {
  document.getElementById('app-version-badge')?.click();
  await settle();
  await settle();
}

describe('Pandesh version and build identity in the renderer', () => {
  it('shows the version and the build number in the badge', async () => {
    await settle();
    const badge = document.getElementById('app-version-badge');
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe('v0.1.1 · b142');
  });

  it('never shows an official build number for a local development build', async () => {
    appMetadata = { ...appMetadata, buildKind: 'development', buildNumber: null, releaseChannel: 'dev' };
    await openAbout();
    const badge = document.getElementById('app-version-badge');
    expect(badge?.textContent).toBe('v0.1.1 · dev');
    expect(badge?.textContent).not.toMatch(/b\d+/);
  });

  it('fills the About panel from the host metadata', async () => {
    await openAbout();
    expect(document.getElementById('about-version')?.textContent).toBe('v0.1.1');
    expect(document.getElementById('about-build')?.textContent).toBe('b142');
    expect(document.getElementById('about-commit')?.textContent).toBe('d978955581b2742356299f89142d20d3b2c5da45');
    expect(document.getElementById('about-built')?.textContent).not.toBe('—');
    expect(document.getElementById('about-channel')?.textContent).toBe('alpha');
    expect(document.getElementById('about-core')?.textContent).toBe('0.1.1');
    expect(document.getElementById('about-installer')?.textContent).toBe('0.1.1');
    expect(document.getElementById('about-core-mismatch')?.hidden).toBe(true);
  });

  it('shows a clear warning when the running Core version differs', async () => {
    appMetadata = { ...appMetadata, coreVersion: '0.1.0', coreVersionMismatch: true };
    await openAbout();
    const warning = document.getElementById('about-core-mismatch');
    expect(warning?.hidden).toBe(false);
    expect(warning?.textContent || '').toMatch(/different version/i);
  });

  it('copies the diagnostics block without any credential material', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    await openAbout();
    document.getElementById('about-copy-diagnostics')?.click();
    await settle();
    await settle();
    expect(written.join('\n')).toContain('b142');
    expect(written.join('\n')).not.toMatch(/token|password|secret|api[-_ ]?key/i);
    expect(document.getElementById('about-copy-status')?.textContent).toBe('Copied.');
  });
});
