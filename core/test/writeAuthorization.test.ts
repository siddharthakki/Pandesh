/**
 * Chat write_file authorization (Build 154 review): a write needs the human, either one approval of a write envelope
 * for the task in the selected workspace (Core's mission authorization) or one approval of that exact file. Folder
 * search consent and Auto standing authorizations never grant a write; Plan Only writes nothing; out-of-scope paths
 * are refused before anyone is asked. Every write records the authority it ran under.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals } from '../domain/approvals';
import { resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { AUTHORIZATION_CATEGORIES, createStandingAuthorization, decidePermission, setConversationPermissionMode } from '../domain/permissionModes';
import { startScriptedOllama, type ScriptedOllama, type ScriptedReply } from './support/scriptedOllama';

let model: ScriptedOllama;
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
/** The tool calls the scripted model makes, in order; one per model call that follows a tool result. */
let steps: ScriptedReply[] = [];

beforeAll(async () => {
  model = await startScriptedOllama((call) => {
    const done = call.messages.filter((m) => m.role === 'tool').length;
    return steps[done] ?? { text: 'Finished.' };
  });
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await model.close();
});

let dir: string;
let ws: string;
let outside: string;
let db: CoreDatabase;
let conversationId: string;
let decider: NodeJS.Timeout | undefined;
/** Tool names of every approval card the human was shown, in order. */
let asked: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-write-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  ws = path.join(dir, 'repo');
  outside = path.join(dir, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }));
  conversationId = createConversation(db, { mode: 'saath_kar', actor: 'test' }).id;
  asked = [];
  steps = [];
});

afterEach(() => {
  if (decider) clearInterval(decider);
  decider = undefined;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The human: answers every card through the same Core function the desktop route uses. */
function human(decide: (toolName: string) => 'approved' | 'rejected') {
  decider = setInterval(() => {
    for (const a of listPendingApprovals(db)) {
      const toolName = String((a.summary as Record<string, unknown>).toolName ?? '');
      asked.push(toolName);
      try {
        resolveCapabilityApproval(db, {
          approvalId: a.id, resolution: decide(toolName), attemptId: a.attemptId, expectedAttemptRevision: a.expectedAttemptRevision,
          expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash,
          actor: 'test-operator', clientId: 'desktop', idempotencyKey: `k-${a.id}`,
        });
      } catch {}
    }
  }, 40);
}

async function turn(text: string, options: { workspace?: string | null; access?: 'read' | 'read_write' } = {}) {
  const workspaceRoot = options.workspace === undefined ? ws : options.workspace ?? undefined;
  const { request, attempt } = submitRequest(db, {
    clientId: 'desktop', currentMessage: text, requestedMode: 'saath_kar', conversationId, ...(workspaceRoot ? { workspaceRoot } : {}),
    requestedProvider: 'ollama', selectedModel: 'fake-model', toolPermissionPolicy: { profile: 'confirm-mutations', ...(options.access ? { workspaceAccess: options.access } : {}) },
    capability: { hasWorkspace: Boolean(workspaceRoot), gitCapable: false }, correlationId: `c-${Math.random()}`,
  });
  const fence = acquireFence(db, attempt.id, { owner: 'test', actor: 'test' });
  const result = await new PiAgentEngineCtor().executeAssistantTurn({
    db, broadcaster: new EventBroadcaster(), attemptId: attempt.id, requestId: request.id, conversationId,
    workspaceRoot, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model',
  });
  return { attemptId: attempt.id, result };
}

const write = (filePath: string, content = 'export const ok = true;\n'): ScriptedReply => ({ tool: { name: 'write_file', args: { filePath, content } } });

function writeEvents(attemptId: string) {
  return db.all<{ eventType: string; metadata: string }>(
    `SELECT eventType, metadata FROM runtime_events WHERE entityId = ? AND eventType IN ('file_write_authorized', 'file_write_refused') ORDER BY sequence`,
    [attemptId],
  ).map((e) => ({ type: e.eventType, ...JSON.parse(e.metadata) }));
}

describe('Ask mode', () => {
  it('a coding mission asks once, then writes several in-scope files (including a rewrite) without more cards', async () => {
    human(() => 'approved');
    steps = [write('src/a.js'), write('src/b.js'), write('src/a.js', 'export const ok = 2;\n'), write('README.md', '# Notes\n')];
    const { attemptId } = await turn('Build the calculator module');
    expect(asked).toEqual(['authorize_mission']);
    expect(fs.readFileSync(path.join(ws, 'src', 'a.js'), 'utf8')).toBe('export const ok = 2;\n');
    expect(fs.existsSync(path.join(ws, 'src', 'b.js'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'README.md'))).toBe(true);
    const events = writeEvents(attemptId);
    expect(events.map((e) => e.authorizationSource)).toEqual(['mission_envelope', 'mission_envelope', 'mission_envelope', 'mission_envelope']);
    expect(events.every((e) => e.missionAuthorizationId && e.envelopeDigest?.startsWith('sha256:') && e.mode === 'ask')).toBe(true);
    const mission = db.get<{ status: string; authorizedBy: string }>('SELECT status, authorizedBy FROM mission_authorizations WHERE attemptId = ?', [attemptId]);
    expect(mission).toMatchObject({ status: 'authorized', authorizedBy: 'test-operator' });
    expect(db.all(`SELECT id FROM mission_authorized_actions WHERE attemptId = ? AND action = 'write_file'`, [attemptId])).toHaveLength(4);
  }, 60_000);

  it('a declined mission writes nothing and does not ask again in the same task', async () => {
    human(() => 'rejected');
    steps = [write('src/a.js'), write('src/b.js')];
    const { attemptId } = await turn('Build the calculator module');
    expect(asked).toEqual(['authorize_mission']);
    expect(fs.existsSync(path.join(ws, 'src'))).toBe(false);
    expect(writeEvents(attemptId).map((e) => e.type)).toEqual(['file_write_refused', 'file_write_refused']);
  }, 60_000);

  it('the envelope is per task: the next turn in the same conversation asks again', async () => {
    human(() => 'approved');
    steps = [write('a.js')];
    await turn('first task');
    steps = [write('b.js')];
    await turn('second task');
    expect(asked).toEqual(['authorize_mission', 'authorize_mission']);
  }, 60_000);

  it('refuses out-of-scope, protected and linked paths before anyone is asked', async () => {
    human(() => 'approved');
    fs.symlinkSync(outside, path.join(ws, 'linked'), 'junction');
    steps = [
      write('../escape.txt'),
      write(path.join(outside, 'abs.txt')),
      write('.git/config', '[core]\n'),
      write('.env', 'TOKEN=1\n'),
      write('linked/through-junction.txt'),
      write('logo.png', 'x'),
    ];
    const { attemptId } = await turn('Write these files');
    expect(asked).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(ws, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'logo.png'))).toBe(false);
    const events = writeEvents(attemptId);
    expect(events.map((e) => e.type)).toEqual(Array(6).fill('file_write_refused'));
    expect(events[4].reason).toMatch(/symbolic link or junction/);
  }, 60_000);

  it('a file over the envelope limits goes to the human as one exact-file card', async () => {
    human(() => 'approved');
    steps = [write('small.js'), write('big.txt', 'x'.repeat(600 * 1024))];
    const { attemptId } = await turn('Write the data file');
    expect(asked).toEqual(['authorize_mission', 'write_file']);
    expect(fs.statSync(path.join(ws, 'big.txt')).size).toBe(600 * 1024);
    expect(writeEvents(attemptId).map((e) => e.authorizationSource)).toEqual(['mission_envelope', 'human_approval']);
  }, 60_000);
});

describe('folder search permission is read-only', () => {
  it('a searched folder outside the workspace still needs an exact-file approval, and a declined one writes nothing', async () => {
    human((tool) => (tool === 'request_search_permission' ? 'approved' : 'rejected'));
    steps = [
      { tool: { name: 'request_search_permission', args: { proposedRoots: [outside], purpose: 'find notes', accessLevel: 'read_only' } } },
      write(path.join(outside, 'notes.md'), '# notes\n'),
    ];
    const { attemptId } = await turn('Find my notes and save a summary');
    expect(asked).toEqual(['request_search_permission', 'write_file']);
    expect(fs.existsSync(path.join(outside, 'notes.md'))).toBe(false);
    expect(writeEvents(attemptId).at(-1)).toMatchObject({ type: 'file_write_refused', reason: 'the user declined this write' });
  }, 60_000);

  it('an approved document write outside the workspace records the human approval as its authority', async () => {
    human(() => 'approved');
    steps = [
      { tool: { name: 'request_search_permission', args: { proposedRoots: [outside], purpose: 'save report', accessLevel: 'read_only' } } },
      write(path.join(outside, 'report.md'), '# Report\n'),
    ];
    const { attemptId } = await turn('Save the report in that folder', { workspace: null });
    expect(fs.readFileSync(path.join(outside, 'report.md'), 'utf8')).toBe('# Report\n');
    const event = writeEvents(attemptId).at(-1);
    expect(event).toMatchObject({ type: 'file_write_authorized', authorizationSource: 'human_approval' });
    expect(event.approvalId).toMatch(/^appr/);
  }, 60_000);

  it('a folder nobody authorized is refused without a card', async () => {
    human(() => 'approved');
    steps = [write(path.join(outside, 'x.md'))];
    await turn('save it', { workspace: null });
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'x.md'))).toBe(false);
  }, 60_000);
});

describe('Auto mode', () => {
  it('no standing authorization covers a write: the mission card still appears, with Core saying why', async () => {
    setConversationPermissionMode(db, conversationId, 'auto', 'test');
    createStandingAuthorization(db, { conversationId, categories: Object.keys(AUTHORIZATION_CATEGORIES), workspaceRoot: ws, expiresInMinutes: 60, actor: 'test' });
    human(() => 'approved');
    steps = [write('src/a.js'), write('src/b.js')];
    const { attemptId } = await turn('Build it');
    expect(asked).toEqual(['authorize_mission']);
    const card = db.get<{ summary: string }>(`SELECT summary FROM approvals WHERE attemptId = ? AND summary LIKE '%authorize_mission%'`, [attemptId]);
    expect(JSON.parse(card!.summary).policyReason).toMatch(/explicit approval/);
    expect(writeEvents(attemptId).every((e) => e.mode === 'auto' && e.authorizationSource === 'mission_envelope')).toBe(true);
    for (const toolName of ['write_file', 'authorize_mission', 'delegate_to_opencode']) {
      expect(decidePermission(db, { attemptIds: [attemptId], toolName, arguments: { path: 'a.js' }, mutating: true, workspaceRoot: ws }).decision).toBe('review');
    }
  }, 60_000);
});

describe('Plan Only', () => {
  it('writes nothing and shows no card', async () => {
    setConversationPermissionMode(db, conversationId, 'plan', 'test');
    human(() => 'approved');
    steps = [write('src/a.js'), write(path.join(outside, 'b.md'))];
    const { attemptId } = await turn('Plan the module');
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(ws, 'src'))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(db.all(`SELECT id FROM runtime_events WHERE entityId = ? AND eventType = 'permission_mode_blocked'`, [attemptId]).length).toBe(2);
  }, 60_000);
});

describe('write_file guards (micro-tests DRV-010, DRV-012)', () => {
  it('never empties a file that has text, and asks nobody about it', async () => {
    fs.writeFileSync(path.join(ws, 'notes (1).txt'), 'Printer: the toner is in the second drawer.\n');
    human(() => 'approved');
    steps = [write('notes (1).txt', ''), write('notes (1).txt', ''), write('notes (1).txt', '  \n')];
    const { attemptId } = await turn('Rename "notes (1).txt" to printer-notes.txt');
    expect(asked).toEqual([]);
    expect(fs.readFileSync(path.join(ws, 'notes (1).txt'), 'utf8')).toBe('Printer: the toner is in the second drawer.\n');
    const events = writeEvents(attemptId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === 'file_write_refused')).toBe(true);
    expect(events[0].reason).toBe('the write would erase the file');
  }, 60_000);

  it('does not rewrite a file with the text it already holds, so a loop of identical writes stops', async () => {
    human(() => 'approved');
    steps = [write('a.txt', 'same text\n'), write('a.txt', 'same text\n'), write('a.txt', 'same text\n')];
    const { attemptId } = await turn('Write a.txt');
    expect(asked).toEqual(['authorize_mission']);
    expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('same text\n');
    const events = writeEvents(attemptId);
    expect(events[0]).toMatchObject({ type: 'file_write_authorized' });
    expect(events.slice(1).every((e) => e.type === 'file_write_refused' && e.reason === 'the file already has this text')).toBe(true);
  }, 60_000);

  it('an empty write named like a folder creates nothing', async () => {
    human(() => 'approved');
    steps = [write('Sandbox Notes', '')];
    const { attemptId } = await turn('Create a folder called Sandbox Notes');
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(ws, 'Sandbox Notes'))).toBe(false);
    expect(writeEvents(attemptId)[0]).toMatchObject({ type: 'file_write_refused', reason: 'an empty file named like a folder' });
  }, 60_000);

  it('an empty file with an extension (an __init__.py) is still allowed', async () => {
    human(() => 'approved');
    steps = [write('pkg/__init__.py', '')];
    await turn('Make pkg a Python package');
    expect(fs.readFileSync(path.join(ws, 'pkg', '__init__.py'), 'utf8')).toBe('');
  }, 60_000);
});

describe('an approval for a file that changed while its card was open (micro-test PER-019)', () => {
  it('the folder card: approving after the file changed writes nothing and says why', async () => {
    const stale = path.join(ws, 'stale.txt');
    fs.writeFileSync(stale, 'version 1\n');
    human((tool) => {
      if (tool === 'authorize_mission') fs.writeFileSync(stale, 'edited by the person while the card was open\n');
      return 'approved';
    });
    steps = [write('stale.txt', 'version 2 from Pandesh\n')];
    const { attemptId } = await turn('Update stale.txt to version 2');
    expect(asked).toEqual(['authorize_mission']);
    expect(fs.readFileSync(stale, 'utf8')).toBe('edited by the person while the card was open\n');
    expect(writeEvents(attemptId).at(-1)).toMatchObject({ type: 'file_write_refused', reason: 'the file changed while the approval card was open' });
  }, 60_000);

  it('the single-file card outside the workspace: the same', async () => {
    const target = path.join(outside, 'report.md');
    fs.writeFileSync(target, '# Report v1\n');
    human((tool) => {
      if (tool === 'write_file') fs.writeFileSync(target, '# Report, edited meanwhile\n');
      return 'approved';
    });
    steps = [
      { tool: { name: 'request_search_permission', args: { proposedRoots: [outside], purpose: 'update the report', accessLevel: 'read_only' } } },
      write(target, '# Report v2\n'),
    ];
    const { attemptId } = await turn('Update the report in that folder', { workspace: null });
    expect(asked).toEqual(['request_search_permission', 'write_file']);
    expect(fs.readFileSync(target, 'utf8')).toBe('# Report, edited meanwhile\n');
    expect(writeEvents(attemptId).at(-1)).toMatchObject({ type: 'file_write_refused', reason: 'the file changed while the approval card was open' });
  }, 60_000);

  it('an unchanged file is written as approved', async () => {
    const target = path.join(ws, 'steady.txt');
    fs.writeFileSync(target, 'version 1\n');
    human(() => 'approved');
    steps = [write('steady.txt', 'version 2\n')];
    await turn('Update steady.txt');
    expect(fs.readFileSync(target, 'utf8')).toBe('version 2\n');
  }, 60_000);
});

describe('A read-only workspace folder', () => {
  it('writes nothing, runs no program and shows no card, even under every Auto authorization; plain read commands still run', async () => {
    setConversationPermissionMode(db, conversationId, 'auto', 'test');
    createStandingAuthorization(db, { conversationId, categories: Object.keys(AUTHORIZATION_CATEGORIES), workspaceRoot: ws, expiresInMinutes: 60, actor: 'test' });
    fs.writeFileSync(path.join(ws, 'notes.txt'), 'read me\n');
    human(() => 'approved');
    steps = [
      write('src/a.js'),
      { tool: { name: 'run_checks', args: { command: 'npm test' } } },
      { tool: { name: 'run_checks', args: { command: 'dir' } } },
    ];
    const before = model.calls.length;
    const { attemptId } = await turn('Fix the module', { access: 'read' });
    expect(asked).toEqual([]);
    expect(fs.existsSync(path.join(ws, 'src'))).toBe(false);
    const blocked = db.all<{ actor: string; metadata: string }>(`SELECT actor, metadata FROM runtime_events WHERE entityId = ? AND eventType = 'permission_mode_blocked' ORDER BY sequence`, [attemptId]);
    expect(blocked.map((e) => JSON.parse(e.metadata).toolName)).toEqual(['write_file', 'run_checks']);
    expect(blocked.every((e) => e.actor === 'core:workspace_access:read_only')).toBe(true);
    const calls = model.calls.slice(before);
    expect(calls[0].system).toMatch(/READ-ONLY FOLDER/);
    const results = calls.flatMap((c) => c.messages.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content)));
    expect(results.some((r) => /NOT DONE \(read-only folder\)/.test(r))).toBe(true);
    expect(results.some((r) => /notes\.txt/.test(r))).toBe(true); // dir ran and listed the folder
  }, 60_000);

  it('the same turn with read and write asks for the mission as before', async () => {
    human(() => 'approved');
    steps = [write('src/a.js')];
    await turn('Build the module', { access: 'read_write' });
    expect(asked).toEqual(['authorize_mission']);
    expect(fs.existsSync(path.join(ws, 'src', 'a.js'))).toBe(true);
  }, 60_000);
});

describe('delegation cannot route around write approval', () => {
  it('OpenCode delegation asks every time and a declined one does nothing', async () => {
    human(() => 'rejected');
    steps = [{ tool: { name: 'delegate_to_opencode', args: { objective: 'write src/a.js' } } }];
    const { result } = await turn('Delegate the module');
    expect(asked).toEqual(['delegate_to_opencode']);
    expect(fs.existsSync(path.join(ws, 'src'))).toBe(false);
    expect(result.reply).not.toMatch(/OpenCode finished/i);
  }, 60_000);

  it('a searched folder is not a delegation target', async () => {
    human(() => 'approved');
    steps = [
      { tool: { name: 'request_search_permission', args: { proposedRoots: [outside], purpose: 'look', accessLevel: 'read_only' } } },
      { tool: { name: 'delegate_to_opencode', args: { objective: 'edit', workspacePath: outside } } },
    ];
    await turn('Delegate there');
    expect(asked).toEqual(['request_search_permission']);
  }, 60_000);
});

describe('command validation pins installed dependencies', () => {
  const npmTest = (attemptId: string) => decidePermission(db, { attemptIds: [attemptId], toolName: 'run_checks', arguments: { command: 'npm test', workingDirectory: ws }, mutating: true, workspaceRoot: ws });
  function autoTurn() {
    setConversationPermissionMode(db, conversationId, 'auto', 'test');
    createStandingAuthorization(db, { conversationId, categories: ['workspace_validation'], workspaceRoot: ws, expiresInMinutes: 60, actor: 'test' });
    return submitRequest(db, {
      clientId: 'desktop', currentMessage: 'test', requestedMode: 'saath_kar', conversationId, workspaceRoot: ws, requestedProvider: 'ollama',
      selectedModel: 'm', toolPermissionPolicy: {}, capability: { hasWorkspace: true, gitCapable: false }, correlationId: `c-${Math.random()}`,
    }).attempt.id;
  }

  it('a dependency changed after the grant voids it', () => {
    fs.mkdirSync(path.join(ws, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
    const attemptId = autoTurn();
    expect(npmTest(attemptId).decision).toBe('auto_authorize');
    fs.writeFileSync(path.join(ws, 'node_modules', 'dep', 'index.js'), 'require("child_process").execSync("calc")');
    expect(npmTest(attemptId)).toMatchObject({ decision: 'review', reason: expect.stringMatching(/installed dependencies included/) });
  });

  it('a linked dependency cannot be pinned, so the grant is refused and validation keeps asking', () => {
    fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
    fs.symlinkSync(outside, path.join(ws, 'node_modules', 'linked-dep'), 'junction');
    setConversationPermissionMode(db, conversationId, 'auto', 'test');
    expect(() => createStandingAuthorization(db, { conversationId, categories: ['workspace_validation'], workspaceRoot: ws, expiresInMinutes: 60, actor: 'test' }))
      .toThrow(/cannot verify/);
  });

  it('a link added after the grant makes the run unverifiable', () => {
    const attemptId = autoTurn();
    expect(npmTest(attemptId).decision).toBe('auto_authorize');
    fs.symlinkSync(outside, path.join(ws, 'vendor'), 'junction');
    expect(npmTest(attemptId).decision).toBe('review');
  });

  it('a node_modules folder above the workspace is not pinned, so validation asks', () => {
    const attemptId = autoTurn();
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(npmTest(attemptId)).toMatchObject({ decision: 'review', reason: expect.stringMatching(/outside the pinned workspace/) });
  });

  it('git still never runs with workspace hooks (existing safeguard unchanged)', () => {
    cp.execFileSync('git', ['init', '-q', ws], { stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\n');
    setConversationPermissionMode(db, conversationId, 'auto', 'test');
    createStandingAuthorization(db, { conversationId, categories: ['workspace_read_commands'], workspaceRoot: ws, expiresInMinutes: 60, actor: 'test' });
    const attemptId = submitRequest(db, {
      clientId: 'desktop', currentMessage: 'st', requestedMode: 'saath_kar', conversationId, workspaceRoot: ws, requestedProvider: 'ollama',
      selectedModel: 'm', toolPermissionPolicy: {}, capability: { hasWorkspace: true, gitCapable: true }, correlationId: `c-${Math.random()}`,
    }).attempt.id;
    expect(decidePermission(db, { attemptIds: [attemptId], toolName: 'run_command', arguments: { command: 'git status' }, mutating: true, workspaceRoot: ws }))
      .toMatchObject({ decision: 'review', reason: expect.stringMatching(/hooks/) });
  });
});
