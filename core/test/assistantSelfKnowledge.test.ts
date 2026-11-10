/**
 * What the assistant is told about Pandesh itself, after the owner's Build 161 voice test:
 *
 *  - asked for "an auto mode where I don't approve every time", it improvised a generic answer: it now gets the real
 *    permission modes (from the constants Core enforces) and the mode this turn runs in;
 *  - asked about screenshots, it invented a privacy filter: the screenshot tool now says its contents are not visible
 *    to Pandesh and that nothing is filtered;
 *  - a misheard word in a spoken message led to a refusal: Core now records that a message was spoken and the model is
 *    told to ask "did you mean …?" instead.
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
import {
  ALWAYS_ASKS_PHRASES, AUTHORIZATION_CATEGORIES, MAX_AUTHORIZATION_MINUTES, alwaysEscalateReason, asksAboutPermissions, createStandingAuthorization,
  permissionModesPromptSection, permissionPromptState, revokeStandingAuthorization, setConversationPermissionMode,
} from '../domain/permissionModes';
import { KNOWN_MISHEARINGS, inputModalityOf, parseInputModality, spokenInputPromptSection } from '../domain/spokenInput';
import { SCREENSHOT_CONTENTS_NOTE, createComputerUseCapabilityAdapter } from '../runtime/computerUseCapability';

let dir: string;
let db: CoreDatabase;
let conversationId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-self-knowledge-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(text: string, extra: { inputModality?: 'text' | 'voice'; toolPermissionPolicy?: Record<string, unknown> } = {}) {
  return submitRequest(db, {
    clientId: 'desktop', currentMessage: text, requestedMode: 'baat_kar', conversationId,
    requestedProvider: 'ollama', selectedModel: 'm', toolPermissionPolicy: extra.toolPermissionPolicy ?? {},
    capability: { hasWorkspace: false, gitCapable: false }, correlationId: `c-${Math.random()}`,
    ...(extra.inputModality ? { inputModality: extra.inputModality } : {}),
  });
}

describe('the permission modes section of the system prompt', () => {
  const section = permissionModesPromptSection({ mode: 'ask', authorizations: [] });

  it('names the three modes, where the switch is, and that only the user switches it', () => {
    expect(section).toMatch(/Ask permission \(the default\)/);
    expect(section).toMatch(/Auto \(governed\)/);
    expect(section).toMatch(/Plan only: Pandesh researches and plans; nothing is created, changed, sent or run/);
    expect(section).toMatch(/permission menu next to the model menu at the message box/);
    expect(section).toMatch(/You cannot switch it, and never claim you did/);
  });

  it('lists exactly what Auto can cover, its 24-hour limit and that it can be revoked', () => {
    for (const text of Object.values(AUTHORIZATION_CATEGORIES)) expect(section).toContain(`"${text}"`);
    expect(MAX_AUTHORIZATION_MINUTES).toBe(24 * 60);
    expect(section).toMatch(/for 1, 8 or 24 hours \(never longer than 24 hours\)/);
    expect(section).toMatch(/revoke Auto at any time/);
    expect(section).toMatch(/ends by itself when it expires/);
  });

  it('says what always asks, and Core really escalates an example of each', () => {
    const examples: Array<[string, Record<string, unknown>]> = [
      ['gmail_send_draft', {}], ['send_whatsapp_message', {}], ['purchase_item', {}], ['delete_file', {}],
      ['write_file', {}], ['calendar_create_event', {}], ['run_checks', { command: 'npm install left-pad' }], ['run_checks', { command: 'git push' }],
    ];
    for (const [tool, args] of examples) expect(alwaysEscalateReason(tool, args), tool).not.toBeNull();
    expect(ALWAYS_ASKS_PHRASES).toHaveLength(6);
    for (const phrase of ALWAYS_ASKS_PHRASES) expect(section).toContain(phrase);
    expect(section).toMatch(/and anything that was not ticked/);
  });

  it('states the mode of this turn, with Auto\'s grants and their expiry', () => {
    expect(permissionModesPromptSection({ mode: 'plan', authorizations: [] })).toMatch(/for this message: Plan only\./);
    expect(permissionModesPromptSection({ mode: 'auto', authorizations: [] })).toMatch(/Auto, but nothing is granted, so everything still asks\./);
    const auto = permissionModesPromptSection(
      { mode: 'auto', authorizations: [{ categories: ['web_research_public'], expiresAt: '2026-01-01T18:00:00.000Z', workspaceRoot: null }] },
      () => 'Thu 19:00',
    );
    expect(auto).toMatch(/for this message: Auto, covering public web searches until Thu 19:00\. Everything else asks\./);
  });

  it('gives the full facts when the message is about approvals or modes, one line otherwise', () => {
    for (const q of ['we need an auto mode where I don\'t approve every time', 'can you stop asking me every time?', 'what permission modes are there', 'revoke the grant']) {
      expect(asksAboutPermissions(q), q).toBe(true);
    }
    for (const q of ['what is the weather tomorrow', 'summarise this PDF', 'who are you']) expect(asksAboutPermissions(q), q).toBe(false);

    const brief = permissionModesPromptSection({ mode: 'ask', authorizations: [] }, undefined, { brief: true });
    expect(brief).toMatch(/^PERMISSION MODE: this conversation is in Ask permission/);
    expect(brief).toMatch(/Auto \(governed: .+for up to 24 hours, revocable\) and Plan only/);
    expect(brief).toMatch(/permission menu next to the model menu/);
    expect(brief.length).toBeLessThan(500);
    // Outside Ask the model gets the full facts, so it can explain what is in force.
    expect(permissionModesPromptSection({ mode: 'plan', authorizations: [] }, undefined, { brief: true })).toMatch(/^PANDESH PERMISSION MODES/);
  });

  it('reads the mode the turn was frozen with, and drops a grant revoked since', () => {
    expect(permissionPromptState(db, [submit('hello').attempt.id])).toEqual({ mode: 'ask', authorizations: [] });

    setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
    const auth = createStandingAuthorization(db, { conversationId, categories: ['web_research_public'], workspaceRoot: null, expiresInMinutes: 60, actor: 'desktop' });
    const { attempt } = submit('look this up');
    const state = permissionPromptState(db, [attempt.id]);
    expect(state.mode).toBe('auto');
    expect(state.authorizations).toEqual([{ categories: ['web_research_public'], expiresAt: auth.expiresAt, workspaceRoot: null }]);

    revokeStandingAuthorization(db, auth.id, 'desktop');
    expect(permissionPromptState(db, [attempt.id])).toEqual({ mode: 'auto', authorizations: [] });
  });
});

describe('spoken messages', () => {
  it('Core freezes that a message was spoken, from the explicit field only', () => {
    const spoken = submit('is this setup useful for punishment', { inputModality: 'voice' });
    expect(inputModalityOf(getAttemptContext(db, spoken.attempt.id).approvalPolicy as Record<string, unknown>)).toBe('voice');

    const typed = submit('typed text');
    expect(inputModalityOf(getAttemptContext(db, typed.attempt.id).approvalPolicy as Record<string, unknown>)).toBe('text');

    // A copy smuggled inside the tool policy is dropped, and is not an escalation.
    const smuggled = submit('typed again', { toolPermissionPolicy: { profile: 'p', inputModality: 'voice' } });
    const policy = getAttemptContext(db, smuggled.attempt.id).approvalPolicy as Record<string, unknown>;
    expect(policy.inputModality).toBeUndefined();
    expect(policy.profile).toBe('p');
    const ev = db.get<{ eventType: string }>("SELECT eventType FROM runtime_events WHERE entityId = ? AND eventType IN ('permission_frozen', 'permission_escalation_rejected')", [smuggled.attempt.id]);
    expect(ev?.eventType).toBe('permission_frozen');
  });

  it('accepts only "voice" as spoken', () => {
    expect(parseInputModality('voice')).toBe('voice');
    for (const other of ['text', 'VOICE', 1, null, undefined, { voice: true }]) expect(parseInputModality(other)).toBe('text');
  });

  it('tells the model to ask about an odd or alarming word instead of refusing', () => {
    expect(spokenInputPromptSection('text')).toBe('');
    const s = spokenInputPromptSection('voice');
    expect(s).toMatch(/^SPOKEN MESSAGE/);
    expect(s).toMatch(/ask "Did you mean …\?"/);
    expect(s).toMatch(/Never refuse, warn or lecture because of one strange word/);
    expect(s).toMatch(/"Pandesh" heard as "Pandish", "Pan-dish", "punishment"/);
    for (const m of KNOWN_MISHEARINGS) expect(s).toContain(`"${m.word}"`);
    expect(s).toMatch(/"whether or not"/);
  });
});

describe('desktop_screenshot says what it is', () => {
  it('reports that its contents are not visible to Pandesh and that nothing is filtered', async () => {
    const dataDir = path.join(dir, 'data');
    const adapter = createComputerUseCapabilityAdapter({
      dataDir,
      runScript: async (script: string) => {
        const target = /Save\('((?:[^']|'')+)'/.exec(script)?.[1]?.replace(/''/g, "'");
        if (!target) return { succeeded: false, exitCode: 1, output: 'no target' };
        fs.writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return { succeeded: true, exitCode: 0, output: '1920x1080' };
      },
    });
    const definition = adapter.definitions().find((d) => d.name === 'desktop_screenshot');
    expect(definition?.description).toMatch(/Pandesh cannot see what is in the image in this build/);
    expect(definition?.description).toMatch(/nothing filtered/);

    const result = await adapter.run({ name: 'desktop_screenshot', arguments: {} } as never, {} as never);
    expect(result.status).toBe('succeeded');
    expect(result.output).toMatch(/^Captured the Windows desktop: .+desktop-\d+\.png \(4 bytes, 1920x1080, sha256 [0-9a-f]{64}\)\. /);
    expect(result.output).toContain(SCREENSHOT_CONTENTS_NOTE);
    // Capturing, opening and inspecting are kept apart; the tool only captures.
    expect(SCREENSHOT_CONTENTS_NOTE).toMatch(/^Captured means saved, nothing more: .+neither opened for anyone nor inspected\./);
    expect(SCREENSHOT_CONTENTS_NOTE).toMatch(/Pandesh cannot inspect it in this build \(no model reads the image/);
    expect(SCREENSHOT_CONTENTS_NOTE).toMatch(/do not describe, check or verify anything on the screen with it, and never say it shows, confirms or proves something/);
    expect(SCREENSHOT_CONTENTS_NOTE).toMatch(/The user can open it at the path above/);
    expect(SCREENSHOT_CONTENTS_NOTE).toMatch(/nothing is excluded, blurred or filtered/);
    expect(SCREENSHOT_CONTENTS_NOTE).not.toMatch(/exclude private|messaging apps? (?:are|is) (?:excluded|hidden)/i);
  });

  it('the system prompt tells the model the tool only captures and never verifies anything', () => {
    const engine = fs.readFileSync(path.join(__dirname, '../runtime/piAgentEngine.ts'), 'utf8');
    const line = engine.slice(engine.indexOf("- 'desktop_screenshot' only CAPTURES"), engine.indexOf("Both are read-only.", engine.indexOf("- 'desktop_screenshot' only CAPTURES")));
    expect(line).toMatch(/Capturing is not opening .+ and not inspecting .+no model can do in this build/);
    expect(line).toMatch(/never say you looked at, checked, verified or confirmed anything with one; say you saved it and where/);
    expect(line).toMatch(/never claim it leaves out, blurs or protects any app/);
    expect(line).toMatch(/Pandesh never scrapes a WhatsApp Web session/);
  });
});
