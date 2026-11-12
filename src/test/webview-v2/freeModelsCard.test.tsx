/**
 * Renders the Pandesh v2 "Free cloud models" card (apps/desktop/renderer-v2/src/FreeModels.tsx) against a mocked host
 * bridge: what it shows, what it lets the user do, and that a key typed into it never comes back into the page.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const KEY = 'gsk_PANDESHDUMMYuitest000000000000000000001';

function state(configured: boolean) {
  const provider = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
    id, displayName, hasAdapter: true, status: 'unverified', statusReasons: ['listed as free upstream; not yet verified by Pandesh against the provider'], conflicts: [],
    sources: [{ source: 'primary', key: `${id}-free` }, { source: 'secondary', key: id }], requiresKey: true, keyUrl: `https://${id}.example/keys`,
    training: 'no', freeKind: 'recurring', models: [{ key: `${id}::m`, modelId: 'm', sources: ['primary'], status: 'unverified', statusReasons: [], limits: {} }], health: null, ...extra,
  });
  return {
    registry: {
      generatedAt: '2026-11-12T07:00:00.000Z',
      counts: { providers: 105, models: 412, modelsByStatus: { verified_free: 1, unverified: 150, restricted: 230, unavailable: 31, unknown: 0 } },
      lastReport: { summary: 'first import: 105 providers, 412 models', errors: [] },
      preferences: { autoProviders: [], disabledProviders: [], preferredOrder: [], fallbackOnRateLimit: true },
      exhaustedProviders: [],
      providers: [
        provider('groq', 'Groq', configured ? { status: 'verified_free', models: [{ key: 'groq::openai/gpt-oss-20b', modelId: 'openai/gpt-oss-20b', sources: ['primary', 'secondary'], status: 'verified_free', statusReasons: [], limits: {} }], health: { checkedAt: '2026-11-12T07:05:00.000Z', ok: true, errorClass: null, latencyMs: 210, freeModels: 1 } } : {}),
        { ...provider('evil', 'Look-alike', { hasAdapter: false, status: 'restricted', statusReasons: ['its registry text contains instruction-like content (treated as data)'] }) },
      ],
      qualifications: configured ? [{ providerId: 'groq', modelId: 'openai/gpt-oss-20b', suiteVersion: 'pandesh-qual-v1', ranAt: '2026-11-12T07:06:00.000Z', capabilities: { chat: true, coding: true, tools: false, structuredOutput: true, longContext: true }, results: [{ id: 'tool_call', outcome: 'fail', latencyMs: 300, detail: 'no tool call returned' }] }] : [],
      sources: [{ name: 'awesome-free-ai-coding', license: 'MIT', repository: 'https://github.com/mvalentsev/awesome-free-ai-coding', fetch: { fetchedAt: '2026-11-12T07:00:00.000Z', carriedOver: false } }],
      unimportedSources: [{ name: 'awesome-free-llm-apis', license: 'MIT', reason: 'No machine-readable data file; README-only lists are not scraped.' }],
      schedule: { enabled: true, dailyTime: '05:45' },
    },
    credentials: { backend: 'windows-credential-manager', status: configured ? { groq: { configured: true, source: 'credential-manager', hint: 'gsk_…0001' } } : {}, legacyOnly: [] },
  };
}

async function mount(configured = false) {
  let current = state(configured);
  const desktop = {
    getFreeModels: vi.fn(async () => current),
    setCloudProviderKey: vi.fn(async () => { current = state(true); return {}; }),
    setFreeModelPreferences: vi.fn(async () => current),
    openExternalUrl: vi.fn(async () => ({ opened: true })),
  };
  (window as unknown as { desktop: unknown }).desktop = desktop;
  vi.resetModules();
  const { FreeModelsCard } = await import('../../../apps/desktop/renderer-v2/src/FreeModels');
  render(<FreeModelsCard />);
  await screen.findByText('Free cloud models');
  return desktop;
}

afterEach(() => cleanup());

describe('Free cloud models card', () => {
  it('shows registry counts, sources and licenses, pending setup, and keeps discovered-only providers out of routing', async () => {
    await mount(false);
    await waitFor(() => expect(document.body.textContent).toContain('105 providers, 412 models'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('Key: pending setup (no key)');
    expect(text).toContain('awesome-free-ai-coding (MIT');
    expect(text).toContain('not imported');
    expect(text).toMatch(/Discovered elsewhere \(1\).*never used/);
    // Auto routing cannot be switched on before a key exists.
    expect((screen.getByLabelText('Auto routing') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Groq API key') as HTMLInputElement).type).toBe('password');
  });

  it('a saved key goes to the host and never comes back into the page; then qualification results show', async () => {
    const desktop = await mount(false);
    const input = screen.getByLabelText('Groq API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByText('Save key'));
    await waitFor(() => expect(desktop.setCloudProviderKey).toHaveBeenCalledWith('groq', KEY));
    await waitFor(() => expect(document.body.textContent).toContain('gsk_…0001 · Windows Credential Manager'));
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(input.value).toBe('');
    expect(document.body.textContent).toMatch(/openai\/gpt-oss-20b: ✓ chat {2}✓ coding {2}✗ tools/);
    expect((screen.getByLabelText('Auto routing') as HTMLInputElement).disabled).toBe(false);
  });
});
