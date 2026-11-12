/**
 * Owner test of Build 166 (2026-11-12): after a restart the v2 menu showed "OrcaRouter — glm-5.3-flash-free (cloud)" as
 * the selected model, but every chat ran on local Auto, and choosing Auto could not clear the stored cloud pick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTO_MODEL, DesktopSession } from '../src/host/desktopSession';
import { loadCloudSettings, saveCloudSettings } from '../src/host/cloudProviderSettings';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function hostWithStoredCloudPick(enabled: string[]): { host: DesktopSession; dataDir: string } {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).includes('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gemma4:12b' }] }), { status: 200 });
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  }));
  const dataDir = tmp('kd-cloud-restart-data-');
  saveCloudSettings(dataDir, { enabledProviders: enabled, selectedModel: 'orcarouter::z-ai/glm-5.3-flash-free' });
  return { host: new DesktopSession({ productRoot: tmp('kd-cloud-restart-product-'), dataDir }), dataDir };
}

describe('a free cloud model picked before a restart', () => {
  it('is still the model the next chat runs on', () => {
    const { host } = hostWithStoredCloudPick(['orcarouter']);
    const snap = host.snapshot();
    expect(snap.selectedInferenceProvider).toBe('cloud');
    expect(snap.provider).toBe('cloud');
    expect(snap.cloud?.selectedModel).toBe('orcarouter::z-ai/glm-5.3-flash-free');
  });

  it('is not restored when its provider is no longer enabled', () => {
    const { host } = hostWithStoredCloudPick([]);
    expect(host.snapshot().selectedInferenceProvider).toBe('ollama');
  });

  it('is cleared by choosing Auto, so the menu and the chat agree again', async () => {
    const { host, dataDir } = hostWithStoredCloudPick(['orcarouter']);
    const snap = await host.selectModel(AUTO_MODEL);
    expect(snap.selectedInferenceProvider).toBe('ollama');
    expect(snap.modelIsAuto).toBe(true);
    expect(loadCloudSettings(dataDir).selectedModel).toBeNull();
    expect(snap.cloud?.selectedModel ?? null).toBeNull();
  });
});
