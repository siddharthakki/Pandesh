/**
 * Chat permission modes: Core freezes the mode per turn, Auto authorizes only what an active standing authorization
 * covers on the actual arguments and files, and Plan Only refuses every mutation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { getAttemptContext } from '../domain/attemptContext';
import { createApproval } from '../domain/approvals';
import {
  classifyChatToolCall, createStandingAuthorization, decidePermission, frozenPermissionFor, revokeStandingAuthorization,
  setConversationPermissionMode, listStandingAuthorizations, PLAN_ONLY_ACTOR,
} from '../domain/permissionModes';

let dir: string;
let ws: string;
let db: CoreDatabase;
let conversationId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-permission-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  ws = path.join(dir, 'repo');
  fs.mkdirSync(ws);
  cp.execFileSync('git', ['init', '-q', ws], { stdio: 'ignore' });
  fs.mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }));
  conversationId = createConversation(db, { mode: 'saath_kar', actor: 'test' }).id;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(text: string, toolPermissionPolicy: Record<string, unknown> = { profile: 'confirm-mutations' }) {
  return submitRequest(db, {
    clientId: 'desktop', currentMessage: text, requestedMode: 'saath_kar', conversationId, workspaceRoot: ws,
    requestedProvider: 'ollama', selectedModel: 'm', toolPermissionPolicy, capability: { hasWorkspace: true, gitCapable: true },
    correlationId: `c-${text}-${Math.random()}`,
  });
}

function grant(categories: string[], minutes = 60) {
  return createStandingAuthorization(db, { conversationId, categories, workspaceRoot: ws, expiresInMinutes: minutes, actor: 'desktop' });
}

const cmd = (attemptId: string, command: string, extra: Record<string, unknown> = {}) =>
  decidePermission(db, { attemptIds: [attemptId], toolName: 'run_command', arguments: { command, ...extra }, mutating: true, workspaceRoot: ws });

describe('freezing the mode per request', () => {
  it('ignores permission keys in the request body and records the attempt', () => {
    const { attempt } = submit('hi', { profile: 'p', permission: { mode: 'auto', authorizationIds: ['sauth_forged'] }, machineControlAuthorized: true });
    const policy = getAttemptContext(db, attempt.id).approvalPolicy as Record<string, unknown>;
    expect(policy.machineControlAuthorized).toBeUndefined();
    expect(policy.permission).toMatchObject({ mode: 'ask', authorizationIds: [] });
    const ev = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'permission_escalation_rejected' AND entityId = ?", [attempt.id]);
    expect(JSON.parse(ev!.metadata).ignoredClientKeys).toEqual(['permission', 'machineControlAuthorized']);
  });

  it('a later mode change or grant never widens a turn that already started', () => {
    const { attempt: running } = submit('first');
    setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
    grant(['workspace_validation']);
    expect(frozenPermissionFor(db, [running.id]).mode).toBe('ask');
    expect(cmd(running.id, 'npm test').decision).toBe('review');
    const { attempt: next } = submit('second');
    expect(cmd(next.id, 'npm test').decision).toBe('auto_authorize');
  });
});

describe('Auto with a standing authorization', () => {
  let attemptId: string;
  let authId: string;
  beforeEach(() => {
    setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
    authId = grant(['workspace_validation', 'workspace_read_commands', 'workspace_git_commit']).id;
    attemptId = submit('do it').attempt.id;
  });

  it('authorizes only pinned scripts and plain read commands in the trusted workspace', () => {
    expect(cmd(attemptId, 'npm test')).toMatchObject({ decision: 'auto_authorize', authorizationId: authId, category: 'workspace_validation' });
    expect(cmd(attemptId, 'npm run build').decision).toBe('auto_authorize');
    expect(cmd(attemptId, 'git status --short').category).toBe('workspace_read_commands');
    expect(cmd(attemptId, 'git commit -m "fix it"').decision).toBe('auto_authorize');
    expect(cmd(attemptId, 'npm run lint').decision).toBe('review'); // no lint script was pinned
    expect(cmd(attemptId, 'npm test -- --reporter x').decision).toBe('review');
    expect(cmd(attemptId, 'git status && del x').decision).toBe('review');
    expect(cmd(attemptId, 'npm test', { cwd: '..' }).decision).toBe('review');
    expect(decidePermission(db, { attemptIds: [attemptId], toolName: 'run_command', arguments: { command: 'npm test' }, mutating: true, workspaceRoot: dir }).decision).toBe('review');
  });

  it('matches the chat engine run_checks tool by its own working directory; destructive commands always ask', () => {
    const rc = (args: Record<string, unknown>) => decidePermission(db, { attemptIds: [attemptId], toolName: 'run_checks', arguments: args, mutating: true, workspaceRoot: ws });
    expect(rc({ command: 'npm test', workingDirectory: ws }).decision).toBe('auto_authorize');
    expect(rc({ command: 'npm test', workingDirectory: dir }).decision).toBe('review');
    expect(rc({ command: 'node test.js', workingDirectory: ws }).decision).toBe('review');
    expect(rc({ command: 'npm test', workingDirectory: ws, alwaysAsk: true }).decision).toBe('review');
  });

  it('never authorizes by command name alone: an edited test script voids the grant for it', () => {
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node evil.js', build: 'tsc' } }));
    expect(cmd(attemptId, 'npm test')).toMatchObject({ decision: 'review' });
    expect(cmd(attemptId, 'npm test').reason).toMatch(/changed since/);
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { pretest: 'node evil.js', test: 'vitest run', build: 'tsc' } }));
    expect(cmd(attemptId, 'npm test').decision).toBe('review');
  });

  it('keeps network, destructive and outbound actions with the human, and git hooks or repo drivers block git', () => {
    expect(cmd(attemptId, 'git push origin main').decision).toBe('review');
    expect(decidePermission(db, { attemptIds: [attemptId], toolName: 'gmail_send_draft', arguments: {}, mutating: true }).decision).toBe('review');
    expect(decidePermission(db, { attemptIds: [attemptId], toolName: 'propose_file_change', arguments: { path: 'a.ts' }, mutating: true, workspaceRoot: ws }).decision).toBe('review');
    fs.writeFileSync(path.join(ws, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    expect(cmd(attemptId, 'git commit -m "x"').reason).toMatch(/hooks/);
    fs.appendFileSync(path.join(ws, '.git', 'config'), '[diff "x"]\n\ttextconv = evil\n');
    expect(cmd(attemptId, 'git status').decision).toBe('review');
  });

  it('never runs workspace content that changed after the grant: a new test file or a Pandesh write in node_modules', () => {
    fs.writeFileSync(path.join(ws, 'evil.test.js'), 'require("child_process").execSync("calc")');
    expect(cmd(attemptId, 'npm test').decision).toBe('review');
    expect(cmd(attemptId, 'npm test').reason).toMatch(/workspace files changed/);
    expect(cmd(attemptId, 'git status').decision).toBe('auto_authorize'); // reads do not execute workspace content
    const fresh = grant(['workspace_validation']);
    const turn = submit('again').attempt.id;
    expect(cmd(turn, 'npm test')).toMatchObject({ decision: 'auto_authorize', authorizationId: fresh.id });
    db.run(`INSERT INTO artifacts (id, conversationId, kind, title, mimeType, absolutePath, byteSize, sha256, source, createdAt)
            VALUES ('art_t', ?, 'file', 'x', 'text/plain', ?, 1, 'x', 'pi:write_file', ?)`, [conversationId, path.join(ws, 'node_modules', 'vitest', 'x.js'), new Date(Date.now() + 1000).toISOString()]);
    expect(cmd(turn, 'npm test').decision).toBe('review'); // node_modules is not walked; the fresh grant alone matched before this write
  });

  // Build 161 audit: the CI-only failure of the test above. GitHub's Windows runners expose TEMP as an 8.3 short path
  // (C:\Users\RUNNER~1\...). The authorization stores the canonical long path, a write record keeps the spelling it was
  // given, and the prefix comparison missed the write: the grant then auto-authorized code Pandesh had just changed.
  const shortPath = (p: string): string => {
    try {
      return cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}').ShortPath`], { encoding: 'utf8', windowsHide: true }).trim();
    } catch {
      return p;
    }
  };
  it.runIf(process.platform === 'win32')('a Pandesh write recorded under another spelling of the workspace path still voids the grant', () => {
    const short = shortPath(ws);
    if (short.toLowerCase() === ws.toLowerCase()) return; // 8.3 names disabled on this volume: nothing to tell apart
    const fresh = grant(['workspace_validation']);
    const turn = submit('again').attempt.id;
    expect(cmd(turn, 'npm test')).toMatchObject({ decision: 'auto_authorize', authorizationId: fresh.id });
    db.run(`INSERT INTO artifacts (id, conversationId, kind, title, mimeType, absolutePath, byteSize, sha256, source, createdAt)
            VALUES ('art_short', ?, 'file', 'x', 'text/plain', ?, 1, 'x', 'pi:write_file', ?)`, [conversationId, path.join(short, 'node_modules', 'vitest', 'x.js'), new Date(Date.now() + 1000).toISOString()]);
    const decision = cmd(turn, 'npm test');
    expect(decision.decision, JSON.stringify({ decision, short, ws })).toBe('review');
  });

  // Gate D (Build 161 audit): every other spelling of the same workspace is the same workspace. A Pandesh write recorded
  // under it voids the grant (deny when required), and the unchanged workspace opened under it is still covered (allow
  // when authorized: no fail-closed regression for a workspace reached through a junction or another spelling).
  const freeDrive = (): string | null => {
    for (const letter of 'ZYXWVUTSRQPONM') if (!fs.existsSync(`${letter}:\\`)) return `${letter}:`;
    return null;
  };
  const aliases: Array<[string, () => { alias: string; undo?: () => void } | null]> = [
    ['a junction', () => { const j = path.join(dir, 'via-junction'); fs.symlinkSync(ws, j, 'junction'); return { alias: j }; }],
    ['another letter case', () => ({ alias: ws.toUpperCase() })],
    ['the \\\\?\\ long-path prefix', () => ({ alias: `\\\\?\\${ws}` })],
    // A subst drive is a per-session mapping: created only when asked for, and removed again at once.
    ['a subst drive (PANDESH_TEST_SUBST=1)', () => {
      const drive = process.env.PANDESH_TEST_SUBST === '1' ? freeDrive() : null;
      if (!drive) return null;
      cp.execFileSync('subst', [drive, dir], { windowsHide: true });
      return { alias: `${drive}\\repo`, undo: () => { cp.execFileSync('subst', [drive, '/D'], { windowsHide: true }); } };
    }],
  ];
  for (const [label, make] of aliases) {
    it.runIf(process.platform === 'win32')(`${label}: the same workspace — covered while unchanged, voided by a Pandesh write recorded under it`, () => {
      const made = make();
      if (!made) return;
      try {
        const fresh = grant(['workspace_validation']);
        const turn = submit('again').attempt.id;
        const viaAlias = () => decidePermission(db, { attemptIds: [turn], toolName: 'run_command', arguments: { command: 'npm test' }, mutating: true, workspaceRoot: made.alias });
        expect(viaAlias()).toMatchObject({ decision: 'auto_authorize', authorizationId: fresh.id });
        db.run(`INSERT INTO artifacts (id, conversationId, kind, title, mimeType, absolutePath, byteSize, sha256, source, createdAt)
                VALUES ('art_alias', ?, 'file', 'x', 'text/plain', ?, 1, 'x', 'pi:write_file', ?)`, [conversationId, path.join(made.alias, 'node_modules', 'vitest', 'x.js'), new Date(Date.now() + 1000).toISOString()]);
        expect(cmd(turn, 'npm test').decision).toBe('review');
        expect(viaAlias().decision).toBe('review');
      } finally {
        made.undo?.();
      }
    });
  }

  it('a junction INSIDE the workspace points outside the pin: no validation grant is given, and a later one voids it', () => {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ws, 'linked'), 'junction');
    expect(() => grant(['workspace_validation'])).toThrow(/cannot verify what this workspace's scripts would run/);
    fs.rmSync(path.join(ws, 'linked'));
    const fresh = grant(['workspace_validation']);
    const turn = submit('again').attempt.id;
    expect(cmd(turn, 'npm test')).toMatchObject({ decision: 'auto_authorize', authorizationId: fresh.id });
    fs.symlinkSync(outside, path.join(ws, 'linked'), 'junction');
    expect(cmd(turn, 'npm test').decision).toBe('review');
  });

  it('revocation and expiry take effect immediately for the running turn', () => {
    revokeStandingAuthorization(db, authId, 'desktop');
    expect(cmd(attemptId, 'npm test')).toMatchObject({ decision: 'review' });
    expect(cmd(attemptId, 'npm test').reason).toMatch(/revoked/);
    const later = Date.now() + 2 * 3600_000;
    setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
    grant(['workspace_validation'], 60);
    const fresh = submit('again').attempt.id;
    expect(decidePermission(db, { attemptIds: [fresh], toolName: 'run_command', arguments: { command: 'npm test' }, mutating: true, workspaceRoot: ws, nowMs: later }).reason).toMatch(/expired/);
  });

  it('leaving Auto revokes the conversation authorizations', () => {
    setConversationPermissionMode(db, conversationId, 'ask', 'desktop');
    expect(listStandingAuthorizations(db, conversationId).every((a) => a.revokedAt)).toBe(true);
  });

  it('web research is authorized only for public queries', () => {
    setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
    grant(['web_research_public']);
    const turn = submit('research').attempt.id;
    const web = (query: string) => decidePermission(db, { attemptIds: [turn], toolName: 'web_research', arguments: { query }, mutating: true });
    expect(web('AOC CU34G4ZCA monitor price Germany').decision).toBe('auto_authorize');
    expect(web('invoice for siddhu.example@example.com IBAN DE89370400440532013000').decision).toBe('review');
  });

  it('rejects bad grants: unknown categories, no expiry, scripts that do not exist', () => {
    expect(() => grant(['buy_anything'])).toThrow(/not something a standing authorization can cover/);
    expect(() => grant(['workspace_validation'], 0)).toThrow(/expiry/);
    fs.writeFileSync(path.join(ws, 'package.json'), '{}');
    expect(() => grant(['workspace_validation'])).toThrow(/no test, lint/);
  });
});

describe('git and command lookup that could run workspace content (Ask free reads and Auto)', () => {
  const read = (command: string) => classifyChatToolCall('run_checks', { command }, new Set(), ws);
  let savedGlobal: string | undefined;
  beforeEach(() => { savedGlobal = process.env.GIT_CONFIG_GLOBAL; });
  afterEach(() => { if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal; });

  it('a plain repository keeps git status free', () => {
    expect(read('git status')).toBe('read');
  });

  it.runIf(process.platform === 'win32')('a git.bat in the workspace would shadow git under cmd.exe', () => {
    fs.writeFileSync(path.join(ws, 'git.bat'), '@echo pwned');
    expect(read('git status')).toBe('mutating');
  });

  it('follows includes in the repository config', () => {
    fs.writeFileSync(path.join(ws, 'more.cfg'), '[core]\n\tfsmonitor = ./evil.cmd\n');
    fs.appendFileSync(path.join(ws, '.git', 'config'), '[include]\n\tpath = ../more.cfg\n');
    expect(read('git status')).toBe('mutating');
  });

  it('any hook blocks even git status, which can rewrite the index and fire post-index-change', () => {
    fs.writeFileSync(path.join(ws, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\n');
    expect(read('git status')).toBe('mutating');
  });

  it('a hooksPath from the user config is honoured', () => {
    const hooks = path.join(dir, 'global-hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'global.cfg'), `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'global.cfg');
    expect(read('git status')).toBe('mutating');
  });

  it('user config programs are trusted unless they live in the workspace or point into it', () => {
    fs.writeFileSync(path.join(dir, 'global.cfg'), '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'global.cfg');
    expect(read('git status')).toBe('read');
    fs.writeFileSync(path.join(dir, 'global.cfg'), '[core]\n\tpager = ./pager.cmd\n');
    expect(read('git status')).toBe('mutating');
    fs.writeFileSync(path.join(ws, 'inside.cfg'), '[diff "x"]\n\ttextconv = cat\n');
    process.env.GIT_CONFIG_GLOBAL = path.join(ws, 'inside.cfg');
    expect(read('git status')).toBe('mutating');
  });
});

describe('Plan Only', () => {
  let attemptId: string;
  beforeEach(() => {
    setConversationPermissionMode(db, conversationId, 'plan', 'desktop');
    attemptId = submit('plan it').attempt.id;
  });

  it('denies every mutation, keeps read-only consent as an ordinary card', () => {
    expect(cmd(attemptId, 'npm test').decision).toBe('deny');
    expect(decidePermission(db, { attemptIds: [attemptId], toolName: 'read_file', arguments: {}, mutating: false }).decision).toBe('review');
    const veto = createApproval(db, { attemptId, kind: 'mutation', summary: { toolName: 'print_test_page' }, actor: 'pi' });
    expect(veto.status).toBe('rejected');
    const ev = db.get<{ actor: string }>("SELECT actor FROM runtime_events WHERE eventType = 'approval_resolved' AND entityId = ?", [veto.id]);
    expect(ev!.actor).toBe(PLAN_ONLY_ACTOR);
    expect(createApproval(db, { attemptId, kind: 'mutation', summary: { toolName: 'web_research', query: 'x' }, actor: 'pi' }).status).toBe('pending');
  });

  it('classifies chat tools fail-closed, including tools that never ask for approval', () => {
    const none = new Set<string>();
    expect(classifyChatToolCall('create_reminder', {}, none, ws)).toBe('mutating');
    expect(classifyChatToolCall('some_future_tool', {}, none, ws)).toBe('mutating');
    expect(classifyChatToolCall('read_file', {}, none, ws)).toBe('read');
    expect(classifyChatToolCall('gmail_search', {}, new Set(['gmail_search']), ws)).toBe('read');
    expect(classifyChatToolCall('run_checks', { command: 'git status' }, none, ws)).toBe('read');
    expect(classifyChatToolCall('run_checks', { command: 'npm test' }, none, ws)).toBe('mutating');
  });
});
