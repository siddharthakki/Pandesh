/**
 * navigate_to ("take me there"): the assistant opens only places that exist in the window the message came from, and
 * says a place is open only when that window confirmed it. Before this, asked "where do I set up Google credentials?",
 * the model named a "Connections → Google Services" page v2 did not have and then could not take the user there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { getAttemptContext } from '../domain/attemptContext';
import { classifyChatToolCall } from '../domain/permissionModes';
import { confirmNavigation, navigateTo, navigationConfirmation } from '../domain/uiNavigation';
import { navigationPromptLines, GOOGLE_SETUP_WHERE } from '../domain/productNavigation';
import { UI_DESTINATIONS, destinationsFor, nearestDestinations, parseUiSurface } from '../shared/uiDestinations';

let dir: string;
let db: CoreDatabase;
let conversationId: string;
const noWait = async () => undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-ui-navigation-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const requested = () => db.all<{ entityId: string; metadata: string }>("SELECT entityId, metadata FROM runtime_events WHERE domain = 'ui_navigation' AND eventType = 'ui_navigation_requested'");

describe('the destination registry', () => {
  it('has unique ids, and every interface a place names has both a target and a way there in words', () => {
    expect(new Set(UI_DESTINATIONS.map((d) => d.id)).size).toBe(UI_DESTINATIONS.length);
    for (const d of UI_DESTINATIONS) expect(Object.keys(d.targets).sort(), d.id).toEqual(Object.keys(d.where).sort());
    expect(destinationsFor('v2').map((d) => d.id)).toContain('google_setup');
    expect(destinationsFor('classic').map((d) => d.id)).toContain('google_setup');
    expect(destinationsFor('classic').map((d) => d.id)).not.toContain('software_discovery');
  });

  it('suggests the nearest real places for a request that has none', () => {
    expect(nearestDestinations('google accounts', 'v2')[0].id).toBe('google_setup');
    expect(nearestDestinations('bluetooth pairing', 'v2')).toEqual([]);
    expect(parseUiSurface('v2')).toBe('v2');
    expect(parseUiSurface('mobile')).toBeUndefined();
  });

  it('says where Google is really set up in both interfaces', () => {
    expect(GOOGLE_SETUP_WHERE).toBe('System (bottom of the left rail) → Connections in the v2 interface, or Connections and settings (left sidebar) → Add / Configure → Google Services in the Classic interface');
  });
});

describe('navigate_to', () => {
  it('opens a real place only after the window confirmed it', async () => {
    let published = 0;
    const pending = navigateTo(db, { attemptId: 'att_1', surface: 'v2', destination: 'google_setup', actor: 'pi', publish: () => { published += 1; }, timeoutMs: 2_000, sleep: async () => {
      const ev = requested()[0];
      if (ev && !navigationConfirmation(db, ev.entityId)) confirmNavigation(db, { navigationId: ev.entityId, ok: true, surface: 'v2', actor: 'desktop' });
    } });
    const result = await pending;
    expect(published).toBe(1);
    expect(result.status).toBe('opened');
    expect(result.text).toBe('OPENED: Google account setup (Gmail, Calendar) is now showing in the Pandesh window (System (bottom of the left rail) → Connections).');
    expect(JSON.parse(requested()[0].metadata)).toMatchObject({ attemptId: 'att_1', destination: 'google_setup', target: 'view:connections', surface: 'v2' });
  });

  it('never says opened when the window refused or did not answer', async () => {
    const refused = navigateTo(db, { attemptId: 'att_2', surface: 'v2', destination: 'projects', actor: 'pi', timeoutMs: 2_000, sleep: async () => {
      const ev = requested().at(-1)!;
      if (!navigationConfirmation(db, ev.entityId)) confirmNavigation(db, { navigationId: ev.entityId, ok: false, detail: 'the window did not switch', actor: 'desktop' });
    } });
    expect((await refused)).toMatchObject({ status: 'not_opened' });
    expect((await refused).text).toMatch(/^NOT OPENED: the Pandesh window could not open Projects: the window did not switch\. Do not say it is open; tell the user the way there: Spaces \(left rail\) → Projects\.$/);

    const silent = await navigateTo(db, { attemptId: 'att_3', surface: 'v2', destination: 'projects', actor: 'pi', timeoutMs: 0, sleep: noWait });
    expect(silent.status).toBe('not_confirmed');
    expect(silent.text).toMatch(/^NOT CONFIRMED: .+do not say it is open\. Tell the user the way there: Spaces \(left rail\) → Projects\.$/);
  });

  it('refuses a place that does not exist in this interface, requests nothing and names the nearest real places', async () => {
    const before = requested().length;
    const missing = await navigateTo(db, { attemptId: 'att_4', surface: 'v2', destination: 'google_services', actor: 'pi', sleep: noWait });
    expect(missing.status).toBe('unknown_destination');
    expect(missing.text).toMatch(/^NOT OPENED: "google_services" is not a place in this Pandesh window, so nothing was opened\./);
    expect(missing.text).toMatch(/Nearest real places: google_setup \(Google account setup/);
    const classicOnly = await navigateTo(db, { attemptId: 'att_5', surface: 'classic', destination: 'software_discovery', actor: 'pi', sleep: noWait });
    expect(classicOnly.status).toBe('unknown_destination');
    expect(requested().length).toBe(before);
  });

  it('only the window that was asked can answer, and only for a real request', () => {
    expect(() => confirmNavigation(db, { navigationId: 'uinav_forged', ok: true, actor: 'desktop' })).toThrow(/was not requested/);
  });

  it('changes nothing, so Plan only lets it run', () => {
    expect(classifyChatToolCall('navigate_to', { destination: 'settings' }, new Set(), null)).toBe('read');
    expect(classifyChatToolCall('find_installed_app', { name: 'Notes' }, new Set(), null)).toBe('read');
  });
});

describe('which window sent the message', () => {
  const submit = (extra: Record<string, unknown>) => submitRequest(db, {
    clientId: 'desktop', currentMessage: `m-${Math.random()}`, requestedMode: 'baat_kar', conversationId, requestedProvider: 'ollama', selectedModel: 'm',
    capability: { hasWorkspace: false, gitCapable: false }, correlationId: `c-${Math.random()}`, ...extra,
  });

  it('is frozen from the explicit field only, so a request from elsewhere cannot open places', () => {
    const fromWindow = submit({ uiSurface: 'v2', toolPermissionPolicy: {} });
    expect((getAttemptContext(db, fromWindow.attempt.id).approvalPolicy as Record<string, unknown>).uiSurface).toBe('v2');
    const smuggled = submit({ toolPermissionPolicy: { uiSurface: 'classic' } });
    expect((getAttemptContext(db, smuggled.attempt.id).approvalPolicy as Record<string, unknown>).uiSurface).toBeUndefined();
  });

  it('decides what the model is told: the real places it may open, or that it can only give the way', () => {
    const v2 = navigationPromptLines('v2');
    expect(v2).toMatch(/You can open places in this Pandesh window \(v2 interface\) with 'navigate_to'\. These are the only places that exist: home = Home and chats/);
    expect(v2).toMatch(/says "take me there" \/ "open it" about a place you or they just named, call navigate_to at once/);
    expect(v2).toMatch(/Say it is open only when navigate_to answered OPENED/);
    expect(v2).not.toMatch(/cloud_providers/);
    expect(navigationPromptLines('classic')).not.toMatch(/software_discovery/);
    expect(navigationPromptLines(undefined)).toMatch(/You cannot open screens in this conversation/);
    expect(navigationPromptLines(undefined)).toMatch(/Never ask the user to paste a client secret, password, API key or token into the chat/);
  });
});
