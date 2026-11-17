import { describe, it, expect } from 'vitest';
import { cloudChoices, modelMenu } from '../renderer-v2/src/composerModel';
import { SETTINGS_SECTIONS, cloudSelectionLabel, updateStatusText, usingCloud } from '../renderer-v2/src/settingsModel';

const cloud = {
  selectedModel: 'groq::llama-3.3',
  providers: [
    { id: 'groq', displayName: 'Groq', enabled: true, configured: true },
    { id: 'nokey', displayName: 'No key', enabled: true, configured: false },
    { id: 'off', displayName: 'Off', enabled: false, configured: true },
  ],
  listings: {
    groq: { pool: [{ id: 'llama-3.3', displayName: 'Llama 3.3', vision: false as const, tools: true as const }, { id: 'm2' }] },
    nokey: { pool: [{ id: 'x' }] },
    off: { pool: [{ id: 'y' }] },
  },
};

describe('UI v2 Settings: cloud model choices', () => {
  it('offers only verified-free models of providers that are enabled and have a key', () => {
    const choices = cloudChoices({ model: 'm', modelIsAuto: false, cloud });
    expect(choices.map((c) => c.value)).toEqual(['groq::llama-3.3', 'groq::m2']);
    expect(choices[0]).toMatchObject({ label: 'Llama 3.3', providerName: 'Groq', vision: false, tools: true });
    // a model that does not report vision or tools says so instead of claiming either
    expect(choices[1]).toMatchObject({ vision: 'unknown', tools: 'unknown' });
  });
  it('offers nothing when cloud is off', () => {
    expect(cloudChoices(null)).toEqual([]);
    expect(cloudChoices({ model: 'm', modelIsAuto: false, cloud: { providers: [], listings: {} } })).toEqual([]);
  });
  it('recognises a cloud selection and names it with its provider', () => {
    expect(usingCloud({ model: 'm', modelIsAuto: false, cloud })).toBe(true);
    expect(usingCloud({ model: 'm', modelIsAuto: false, cloud: { ...cloud, selectedModel: null } })).toBe(false);
    expect(cloudSelectionLabel({ model: 'm', modelIsAuto: false, cloud })).toBe('llama-3.3 (Groq)');
    expect(cloudSelectionLabel({ model: 'm', modelIsAuto: false })).toBeNull();
  });
  it('offers the same verified free models in the composer menu as in Settings', () => {
    const menu = modelMenu({ model: 'm', modelIsAuto: false, installedModels: ['m'], cloud });
    expect(menu.options.filter((o) => o.group === 'cloud').map((o) => o.value)).toEqual(['groq::llama-3.3', 'groq::m2']);
  });
});

describe('UI v2 Settings: structure and update words', () => {
  it('has the five sections, each reachable by id', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['models', 'permissions', 'diagnostics', 'updates', 'appearance']);
  });
  it('says plainly when the install cannot update', () => {
    expect(updateStatusText({ available: false, installedRevision: 171, lastResult: null }).tone).toBe('warn');
    expect(updateStatusText(null).tone).toBe('plain');
  });
  it('shows the installed build and the last attempt until it is acknowledged', () => {
    expect(updateStatusText({ available: true, installedRevision: 171, lastResult: null }).text).toBe('Installed build b171.');
    const rolled = updateStatusText({ available: true, installedRevision: 171, lastResult: { status: 'rolled_back', at: '', acknowledged: false, revision: 171, attemptedRevision: 172 } });
    expect(rolled.text).toContain('was undone');
    expect(rolled.tone).toBe('warn');
    expect(updateStatusText({ available: true, installedRevision: 172, lastResult: { status: 'success', at: '', acknowledged: true, revision: 172 } }).text).toBe('Installed build b172.');
    expect(updateStatusText({ available: true, installedRevision: 171, lastResult: { status: 'rollback_failed', at: '', acknowledged: false } }).tone).toBe('danger');
  });
});
