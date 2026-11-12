import { describe, expect, it } from 'vitest';
import {
  AUTO_MODEL, EXPIRY_CHOICES, STILL_ASKS_NOTE, WORKSPACE_PERMISSION_CATEGORIES,
  grantProblem, grantRows, modelLabel, modelMenu, permissionChip, permissionStatus, type PermissionState,
} from '../renderer-v2/src/composerModel';
import { AUTHORIZATION_CATEGORIES, MAX_AUTHORIZATION_MINUTES, alwaysEscalateReason } from '../../../core/domain/permissionModes';
import { AUTO_MODEL as HOST_AUTO_MODEL } from '../src/host/desktopSession';

const permission = (over: Partial<PermissionState> = {}): PermissionState => ({
  conversationId: 'conv_1', mode: 'ask', authorizations: [], categories: { ...AUTHORIZATION_CATEGORIES }, pending: false, activeTurnMode: null, ...over,
});

describe('UI v2 composer — model menu', () => {
  it('offers Auto and every installed local model, and selects what the host reports', () => {
    const menu = modelMenu({ model: 'gemma4:12b', modelIsAuto: false, installedModels: ['gemma4:12b', 'qwen3:8b'] });
    expect(menu.options.map((o) => o.value)).toEqual([AUTO_MODEL, 'gemma4:12b', 'qwen3:8b']);
    expect(menu.selected).toBe('gemma4:12b');
  });

  it('uses the host value for Auto', () => {
    expect(AUTO_MODEL).toBe(HOST_AUTO_MODEL);
    expect(modelMenu({ model: null, modelIsAuto: true, installedModels: ['gemma4:12b'] }).selected).toBe(AUTO_MODEL);
    // Under Auto the model Core last chose is not the selection.
    expect(modelMenu({ model: 'gemma4:12b', modelIsAuto: true, installedModels: ['gemma4:12b'] }).selected).toBe(AUTO_MODEL);
  });

  it('never shows another model as selected when the configured one is missing', () => {
    const missing = modelMenu({ model: 'old-model:7b', modelIsAuto: false, installedModels: ['gemma4:12b'] });
    expect(missing.selected).toBe('old-model:7b');
    expect(missing.options.find((o) => o.value === 'old-model:7b')?.label).toBe('old-model:7b (not installed)');
    // Ollama resolves an untagged name to its tag.
    expect(modelMenu({ model: 'gemma4', modelIsAuto: false, installedModels: ['gemma4:latest'] }).selected).toBe('gemma4:latest');
    const none = modelMenu({ model: null, modelIsAuto: false, installedModels: [] });
    expect(none.selected).toBe('');
    expect(none.options.find((o) => o.value === '')).toMatchObject({ disabled: true });
  });

  it('offers Auto free cloud and the free models of enabled providers, with the chosen one selected', () => {
    const menu = modelMenu({
      model: 'm1', modelIsAuto: false, installedModels: ['gemma4:12b'],
      cloud: { selectedModel: 'groq::m1', providers: [{ id: 'groq', displayName: 'Groq', enabled: true, configured: true }], listings: { groq: { pool: [{ id: 'm1' }, { id: 'm2' }] } } },
    });
    expect(menu.selected).toBe('groq::m1');
    expect(menu.options.filter((o) => o.group === 'cloud').map((o) => o.value)).toEqual(['auto::free', 'groq::m1', 'groq::m2']);
    // A provider that is off for chats offers nothing; a choice made earlier stays visible until discovered again.
    const off = modelMenu({ model: null, modelIsAuto: false, installedModels: [], cloud: { selectedModel: 'groq::m9', providers: [{ id: 'groq', displayName: 'Groq', enabled: false, configured: true }], listings: { groq: { pool: [{ id: 'm1' }] } } } });
    expect(off.options.filter((o) => o.group === 'cloud').map((o) => o.value)).toEqual(['groq::m9']);
    expect(off.selected).toBe('groq::m9');
  });

  it('labels Auto as a choice, not as a missing model', () => {
    expect(modelLabel({ model: null, modelIsAuto: true })).toMatch(/^Auto/);
    expect(modelLabel({ model: 'gemma4:12b', modelIsAuto: true })).toBe('gemma4:12b (auto)');
    expect(modelLabel({ model: 'gemma4:12b', modelIsAuto: false })).toBe('gemma4:12b');
    expect(modelLabel({ model: null, modelIsAuto: false })).toBe('model not chosen');
  });
});

describe('UI v2 composer — permission mode', () => {
  it('offers exactly the categories Core can authorize, and keeps workspace ones off without a folder', () => {
    const noFolder = grantRows(permission(), false);
    expect(noFolder.map((r) => r.id).sort()).toEqual(Object.keys(AUTHORIZATION_CATEGORIES).sort());
    for (const row of noFolder) expect(row.disabled).toBe(WORKSPACE_PERMISSION_CATEGORIES.has(row.id));
    expect(noFolder.find((r) => r.id === 'workspace_git_commit')?.text).toMatch(/select a workspace folder first/);
    expect(grantRows(permission(), true).every((r) => !r.disabled)).toBe(true);
    for (const id of WORKSPACE_PERMISSION_CATEGORIES) expect(Object.keys(AUTHORIZATION_CATEGORIES)).toContain(id);
  });

  it('offers 1, 8 and 24 hours and never more than Core allows', () => {
    expect(EXPIRY_CHOICES.map((c) => c.minutes)).toEqual([60, 480, 1440]);
    expect(Math.max(...EXPIRY_CHOICES.map((c) => c.minutes))).toBeLessThanOrEqual(MAX_AUTHORIZATION_MINUTES);
    expect(grantProblem([], 60)).toMatch(/Tick at least one/);
    expect(grantProblem(['web_research_public'], 90)).toMatch(/1, 8 or 24 hours/);
    expect(grantProblem(['web_research_public'], 480)).toBeNull();
  });

  it('says what still asks, and Core really does escalate each of those', () => {
    expect(STILL_ASKS_NOTE).toMatch(/outbound email and messages/);
    expect(alwaysEscalateReason('gmail_send_draft', {})).toMatch(/outbound/);
    expect(alwaysEscalateReason('purchase_item', {})).toMatch(/purchases/);
    expect(alwaysEscalateReason('write_file', {})).toMatch(/explicit approval/);
    expect(alwaysEscalateReason('run_checks', { command: 'git push origin main' })).toMatch(/network, install/);
    expect(alwaysEscalateReason('delete_note', {})).toMatch(/destructive/);
  });

  it('describes Ask, Plan only and Auto with its expiry and a Revoke handle', () => {
    expect(permissionChip(permission()).label).toBe('Ask');
    expect(permissionStatus(permission())).toEqual([]);
    expect(permissionChip(permission({ mode: 'plan' })).label).toBe('Plan only');
    expect(permissionStatus(permission({ mode: 'plan' }))[0].text).toMatch(/Nothing is created, changed, sent or run/);

    const none = permissionStatus(permission({ mode: 'auto' }));
    expect(none[0].text).toMatch(/no active authorization, so everything still asks you/);
    expect(permissionChip(permission({ mode: 'auto' })).label).toBe('Auto · nothing granted');

    const expiresAt = new Date(Date.now() + 8 * 3_600_000).toISOString();
    const active = permission({ mode: 'auto', authorizations: [{ id: 'auth_1', categories: ['web_research_public'], workspaceRoot: null, expiresAt }] });
    const lines = permissionStatus(active);
    expect(lines[0]).toMatchObject({ revokeId: 'auth_1', items: [AUTHORIZATION_CATEGORIES.web_research_public] });
    expect(lines[0].text).toMatch(/^Auto until .+Everything else still asks you\.$/);
    expect(permissionChip(active).label).toMatch(/^Auto · until /);
  });

  it('says when a choice waits for the next message and when a running task keeps its mode', () => {
    expect(permissionStatus(permission({ mode: 'auto', pending: true, pendingWorkspaceRoot: null })).map((l) => l.text))
      .toEqual(['Auto (governed) applies from your next message, for no workspace folder only.']);
    expect(permissionStatus(permission({ mode: 'plan', activeTurnMode: 'ask' }))[0].text)
      .toBe('The running task keeps Ask permission, fixed when it started; your change applies to the next message.');
  });

  it('stays out of the way while a task runs in the default Ask mode', () => {
    expect(permissionStatus(permission({ mode: 'ask', activeTurnMode: 'ask' }))).toEqual([]);
    expect(permissionStatus(permission({ mode: 'plan', activeTurnMode: 'plan' }))[0].text).toBe('This task runs in Plan only mode.');
  });
});
