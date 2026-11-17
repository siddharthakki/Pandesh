import { describe, expect, it } from 'vitest';
import {
  AUTO_MODEL, EXPIRY_CHOICES, STILL_ASKS_NOTE, WORKSPACE_PERMISSION_CATEGORIES,
  cloudAvailability, cloudConfirmation, grantProblem, grantRows, isCloudValue, modelLabel, modelMenu, permissionChip, permissionStatus, type PermissionState,
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

  it('lists every verified free model of the providers that are on and have a key, and no others', () => {
    const cloud = {
      selectedModel: 'groq::m1',
      providers: [
        { id: 'groq', displayName: 'Groq', enabled: true, configured: true },
        { id: 'off', displayName: 'Off', enabled: false, configured: true },
        { id: 'nokey', displayName: 'No key', enabled: true, configured: false },
      ],
      listings: { groq: { pool: [{ id: 'm1' }, { id: 'm2' }] }, off: { pool: [{ id: 'x' }] }, nokey: { pool: [{ id: 'y' }] } },
    };
    const menu = modelMenu({ model: 'm1', modelIsAuto: false, installedModels: ['gemma4:12b'], cloud });
    expect(menu.selected).toBe('groq::m1');
    expect(menu.options.filter((o) => o.group === 'cloud').map((o) => o.value)).toEqual(['groq::m1', 'groq::m2']);
    expect(menu.options.filter((o) => o.group === 'local').map((o) => o.value)).toEqual(['gemma4:12b']);
    // Local-only: with nothing set up there is no cloud entry at all.
    expect(modelMenu({ model: 'gemma4:12b', modelIsAuto: false, installedModels: ['gemma4:12b'], cloud: { selectedModel: null, providers: [], listings: {} } }).options.some((o) => o.group === 'cloud')).toBe(false);
  });

  it('keeps a stored cloud pick visible when its list is not checked yet, and says so', () => {
    const menu = modelMenu({ model: 'm9', modelIsAuto: false, installedModels: [], cloud: { selectedModel: 'groq::m9', providers: [{ id: 'groq', displayName: 'Groq', enabled: true, configured: true }], listings: {} } });
    expect(menu.selected).toBe('groq::m9');
    expect(menu.options.find((o) => o.value === 'groq::m9')?.label).toMatch(/not on the checked free list/);
  });

  it('says for each provider whether it can be used, without a key value', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const rows = cloudAvailability({
      model: null, modelIsAuto: true,
      cloud: {
        selectedModel: null,
        providers: [
          { id: 'groq', displayName: 'Groq', enabled: true, configured: true },
          { id: 'nvidia', displayName: 'NVIDIA', enabled: true, configured: true },
          { id: 'cerebras', displayName: 'Cerebras', enabled: true, configured: false },
          { id: 'orca', displayName: 'Orca', enabled: false, configured: true },
          { id: 'bad', displayName: 'Bad', enabled: true, configured: true },
          { id: 'unused', displayName: 'Unused', enabled: false, configured: false },
        ],
        listings: { groq: { ok: true, checkedAt: '2026-11-17T09:00:00Z', pool: [{ id: 'a' }, { id: 'b' }] }, bad: { ok: false, checkedAt: '2026-11-17T11:00:00Z', errorClass: 'auth', pool: [] } },
      },
    }, now);
    expect(rows.map((r) => [r.id, r.state])).toEqual([['groq', 'ready'], ['nvidia', 'not_checked'], ['cerebras', 'no_key'], ['orca', 'off'], ['bad', 'failed']]);
    expect(rows[0].text).toBe('2 free models, checked 3 hours ago');
    expect(JSON.stringify(rows)).not.toMatch(/key":|apiKey|hint/i);
  });

  it('states what leaves this PC before a chat moves to a cloud model', () => {
    expect(isCloudValue('groq::m1')).toBe(true);
    expect(isCloudValue('gemma4:12b')).toBe(false);
    expect(isCloudValue(AUTO_MODEL)).toBe(false);
    const c = cloudConfirmation({ model: null, modelIsAuto: true, cloud: { providers: [{ id: 'groq', displayName: 'Groq', enabled: true, configured: true, privacyWarning: 'Groq may log prompts.' }] } }, 'groq::m1');
    expect(c.title).toBe('Run this chat on m1 at Groq?');
    expect(c.lines.join(' ')).toMatch(/sent to Groq over the internet/);
    expect(c.lines.join(' ')).toMatch(/files, pictures, email, calendar and memory are not sent/);
    expect(c.lines).toContain('Groq may log prompts.');
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
