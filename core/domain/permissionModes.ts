/**
 * Chat permission modes (Ask / Auto / Plan Only) and standing authorizations.
 *
 * The mode is a per-conversation setting that Core freezes into every request at submission; a later change never
 * alters a turn that is already running. Authority never comes from the mode alone:
 *
 *  - Ask:       today's behaviour. Protected operations stop for the human.
 *  - Auto:      a protected operation proceeds without a card ONLY when an active, unexpired standing authorization that
 *               was in force when the turn started matches the actual tool, arguments, workspace and files on disk.
 *               Anything else is still reviewed. A model's opinion never authorizes anything.
 *  - Plan Only: no mutation of any kind, including tools that never ask for approval. Read-only work keeps its existing
 *               privacy and external-transfer consent.
 *
 * Every decision here is deterministic and reuses the existing approval record (`createApproval` with
 * `initialResolution`) and runtime-event audit trail; nothing executes from this module.
 */
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { getAttemptContext } from './attemptContext';
import { classifyPrivacy } from './operatorPlan';

export type PermissionMode = 'ask' | 'auto' | 'plan';
export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'plan'];

/** Actor recorded on approvals Core resolves itself under a permission mode. */
export const STANDING_AUTHORIZATION_ACTOR = 'core:standing_authorization';
export const PLAN_ONLY_ACTOR = 'core:permission_mode:plan_only';

/**
 * What a standing authorization can cover in Milestone 1. Deliberately narrow: no file edits (those stay with the
 * human or a frozen mission envelope), no network, no installs, no outbound messages, no money.
 */
export const AUTHORIZATION_CATEGORIES = {
  workspace_read_commands: 'Read-only commands in the trusted workspace: dir, git status/diff/log/show',
  workspace_validation: 'The package.json validation scripts pinned when you granted this (test, lint, typecheck, build, compile)',
  workspace_git_commit: 'git add and git commit inside the trusted workspace, only while the repository has no git hooks',
  workspace_inspect_page: 'Inspecting an HTML page that lives inside the trusted workspace',
  web_research_public: 'Public web searches whose query contains no personal or confidential data',
} as const;
export type AuthorizationCategory = keyof typeof AUTHORIZATION_CATEGORIES;

const WORKSPACE_CATEGORIES: readonly AuthorizationCategory[] = ['workspace_read_commands', 'workspace_validation', 'workspace_git_commit', 'workspace_inspect_page'];
const VALIDATION_SCRIPTS = ['test', 'lint', 'typecheck', 'build', 'compile'] as const;
/** The longest a standing authorization may last; the desktop offers shorter choices. */
export const MAX_AUTHORIZATION_MINUTES = 24 * 60;

export interface StandingAuthorization {
  id: string;
  conversationId: string;
  workspaceRoot: string | null;
  categories: AuthorizationCategory[];
  /** Facts Core read from disk at grant time; a later mismatch means the grant no longer applies. */
  pins: { npmScripts?: Record<string, string>; workspaceDigest?: string };
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/** The permission a request was submitted under. Frozen into the request and attempt context; never client-supplied. */
export interface FrozenPermission {
  mode: PermissionMode;
  /** Standing authorizations that were active when the turn started. Later grants never widen a running turn. */
  authorizationIds: string[];
  conversationId: string | null;
  frozenAt: string;
}

const ASK: FrozenPermission = { mode: 'ask', authorizationIds: [], conversationId: null, frozenAt: '' };

// ------------------------------------------------------------------ mode per conversation

export function getConversationPermissionMode(db: CoreDatabase, conversationId: string): PermissionMode {
  const row = db.get<{ mode: string }>('SELECT mode FROM conversation_permission_modes WHERE conversationId = ?', [conversationId]);
  return PERMISSION_MODES.includes(row?.mode as PermissionMode) ? (row!.mode as PermissionMode) : 'ask';
}

/**
 * Changes the mode for the conversation's NEXT turns. Leaving Auto also revokes the conversation's standing
 * authorizations, so the change narrows authority immediately and never leaves a grant behind.
 */
export function setConversationPermissionMode(db: CoreDatabase, conversationId: string, mode: PermissionMode, actor: string): { mode: PermissionMode; revoked: string[] } {
  if (!PERMISSION_MODES.includes(mode)) throw new CoreError('invalid_request', `permission mode '${String(mode)}' is invalid`);
  return db.transaction(() => {
    if (!db.get('SELECT id FROM conversations WHERE id = ?', [conversationId])) throw new CoreError('not_found', `conversation '${conversationId}' not found`);
    const previous = getConversationPermissionMode(db, conversationId);
    db.run(
      `INSERT INTO conversation_permission_modes (conversationId, mode, updatedAt, updatedBy) VALUES (?, ?, ?, ?)
       ON CONFLICT(conversationId) DO UPDATE SET mode = excluded.mode, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`,
      [conversationId, mode, nowIso(), actor],
    );
    const revoked = mode === 'auto' ? [] : listStandingAuthorizations(db, conversationId).filter((a) => isActive(a)).map((a) => revokeStandingAuthorization(db, a.id, actor, `mode changed to ${mode}`).id);
    recordRuntimeEvent(db, { domain: 'conversation', entityId: conversationId, eventType: 'permission_mode_changed', actor, metadata: { from: previous, to: mode, revoked } });
    return { mode, revoked };
  });
}

// ------------------------------------------------------------------ standing authorizations

function rowToAuthorization(row: Record<string, unknown>): StandingAuthorization {
  return {
    id: String(row.id),
    conversationId: String(row.conversationId),
    workspaceRoot: (row.workspaceRoot as string) ?? null,
    categories: JSON.parse(String(row.categoriesJson)) as AuthorizationCategory[],
    pins: JSON.parse(String(row.pinsJson ?? '{}')),
    createdAt: String(row.createdAt),
    createdBy: String(row.createdBy),
    expiresAt: String(row.expiresAt),
    revokedAt: (row.revokedAt as string) ?? null,
    revokedBy: (row.revokedBy as string) ?? null,
    revokeReason: (row.revokeReason as string) ?? null,
  };
}

export function isActive(auth: StandingAuthorization, nowMs = Date.now()): boolean {
  return !auth.revokedAt && Date.parse(auth.expiresAt) > nowMs;
}

export function getStandingAuthorization(db: CoreDatabase, id: string): StandingAuthorization {
  const row = db.get<Record<string, unknown>>('SELECT * FROM standing_authorizations WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `standing authorization '${id}' not found`);
  return rowToAuthorization(row);
}

export function listStandingAuthorizations(db: CoreDatabase, conversationId: string): StandingAuthorization[] {
  return db.all<Record<string, unknown>>('SELECT * FROM standing_authorizations WHERE conversationId = ? ORDER BY createdAt DESC', [conversationId]).map(rowToAuthorization);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readPackageScripts(workspaceRoot: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(parsed.scripts ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The exact text npm would run for `script`, including its pre/post hooks. */
function scriptChainDigest(scripts: Record<string, string>, script: string): string | null {
  if (typeof scripts[script] !== 'string') return null;
  return sha256(JSON.stringify([scripts[`pre${script}`] ?? null, scripts[script], scripts[`post${script}`] ?? null]));
}

/** Above this many files (dependencies included) the workspace is too large to verify per action, so validation always asks. */
const WORKSPACE_DIGEST_MAX_ENTRIES = 50_000;

/**
 * Path, size and modification time of every file in the workspace except .git, INCLUDING node_modules: validation
 * scripts execute the workspace and its installed dependencies, so any change after the grant (a new test, a rewritten
 * config, a .npmrc, a changed package) means the grant no longer covers the run. Pandesh's own writes are also caught
 * from its file records. A symbolic link or junction points at content outside the pin, so it makes the workspace
 * unverifiable (null), as does exceeding the entry cap: validation then asks the human.
 */
function workspaceDigest(workspaceRoot: string): string | null {
  const hash = crypto.createHash('sha256');
  const stack = [''];
  let entries = 0;
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(path.join(workspaceRoot, rel), { withFileTypes: true });
    } catch {
      return null;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (d.name === '.git') continue;
      if ((entries += 1) > WORKSPACE_DIGEST_MAX_ENTRIES) return null;
      if (d.isSymbolicLink()) return null;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        stack.push(r);
        hash.update(`d\0${r}\0`);
        continue;
      }
      try {
        const st = fs.lstatSync(path.join(workspaceRoot, r));
        hash.update(`f\0${r}\0${st.size}\0${st.mtimeMs}\0`);
      } catch {
        return null;
      }
    }
  }
  return hash.digest('hex');
}

/**
 * A node_modules folder in a parent of the workspace: Node and npm resolve packages and binaries from it, but it is not
 * part of the workspace pin, so a script could run code nobody checked.
 */
function dependenciesAboveWorkspace(workspaceRoot: string): string | null {
  let dir = path.dirname(path.resolve(workspaceRoot));
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The comparable spelling of a path: its nearest existing ancestor resolved by the OS (8.3 short names, junctions,
 * symbolic links, subst drives), the rest appended, case-folded. A file that no longer exists still resolves through
 * its folder.
 */
function canonicalPathSpelling(p: string): string {
  const tail: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...[...tail].reverse()).toLowerCase();
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p).toLowerCase();
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether Pandesh itself recorded writing a file under the workspace (including node_modules) since `sinceIso`.
 * Build 161 audit: the grant stores the canonical workspace path, a write record keeps the spelling it was given; a
 * lexical prefix test missed a write recorded through an 8.3 short name (GitHub's runners) or a junction, and the grant
 * then auto-authorized code Pandesh had just changed. Both sides are compared in their canonical spelling, and a match
 * under either spelling counts.
 */
function pandeshWroteUnder(db: CoreDatabase, workspaceRoot: string, sinceIso: string): boolean {
  const lexical = path.resolve(workspaceRoot).toLowerCase();
  const canonical = canonicalPathSpelling(workspaceRoot);
  const under = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
  return db.all<{ absolutePath: string }>('SELECT absolutePath FROM artifacts WHERE createdAt >= ?', [sinceIso])
    .some((a) => under(path.resolve(a.absolutePath).toLowerCase(), lexical) || under(canonicalPathSpelling(a.absolutePath), canonical));
}

function canonicalDir(p: string): string | null {
  try {
    const real = fs.realpathSync.native(path.resolve(p));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Grants a standing authorization for one conversation. Core reads the workspace itself: the npm scripts that may run
 * are pinned by their exact text, so editing package.json afterwards voids the grant for those scripts.
 */
export function createStandingAuthorization(db: CoreDatabase, input: {
  conversationId: string;
  categories: string[];
  workspaceRoot?: string | null;
  expiresInMinutes: number;
  actor: string;
}): StandingAuthorization {
  const categories = [...new Set(input.categories)];
  if (categories.length === 0) throw new CoreError('invalid_request', 'choose at least one thing to authorize');
  for (const c of categories) if (!Object.hasOwn(AUTHORIZATION_CATEGORIES, c)) throw new CoreError('invalid_request', `'${c}' is not something a standing authorization can cover`);
  const minutes = Number(input.expiresInMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_AUTHORIZATION_MINUTES) throw new CoreError('invalid_request', `expiry must be between 1 and ${MAX_AUTHORIZATION_MINUTES} minutes`);
  const needsWorkspace = categories.some((c) => WORKSPACE_CATEGORIES.includes(c as AuthorizationCategory));
  let workspaceRoot: string | null = null;
  const pins: StandingAuthorization['pins'] = {};
  if (needsWorkspace) {
    workspaceRoot = input.workspaceRoot ? canonicalDir(input.workspaceRoot) : null;
    if (!workspaceRoot) throw new CoreError('invalid_request', 'workspace authorizations need an existing workspace folder');
    if (path.parse(workspaceRoot).root === workspaceRoot) throw new CoreError('invalid_request', 'a drive root cannot be a trusted workspace');
    if (categories.includes('workspace_validation')) {
      const scripts = readPackageScripts(workspaceRoot);
      pins.npmScripts = Object.fromEntries(VALIDATION_SCRIPTS.map((s) => [s, scriptChainDigest(scripts, s)]).filter(([, d]) => d)) as Record<string, string>;
      if (Object.keys(pins.npmScripts).length === 0) throw new CoreError('invalid_request', 'this workspace has no test, lint, typecheck, build or compile script to authorize');
      const digest = workspaceDigest(workspaceRoot);
      if (!digest) throw new CoreError('invalid_request', `Auto cannot verify what this workspace's scripts would run (more than ${WORKSPACE_DIGEST_MAX_ENTRIES} files including node_modules, a symbolic link or junction, or an unreadable folder), so npm scripts here keep asking you`);
      const above = dependenciesAboveWorkspace(workspaceRoot);
      if (above) throw new CoreError('invalid_request', `Auto cannot verify ${above}, which this workspace's scripts could load, so npm scripts here keep asking you`);
      pins.workspaceDigest = digest;
    }
  }
  return db.transaction(() => {
    if (!db.get('SELECT id FROM conversations WHERE id = ?', [input.conversationId])) throw new CoreError('not_found', `conversation '${input.conversationId}' not found`);
    const id = newId('sauth');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();
    db.run(
      `INSERT INTO standing_authorizations (id, conversationId, workspaceRoot, categoriesJson, pinsJson, createdAt, createdBy, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.conversationId, workspaceRoot, JSON.stringify(categories), JSON.stringify(pins), now.toISOString(), input.actor, expiresAt],
    );
    recordRuntimeEvent(db, { domain: 'authorization', entityId: id, eventType: 'standing_authorization_granted', actor: input.actor, metadata: { conversationId: input.conversationId, categories, workspaceRoot, expiresAt, pinnedScripts: Object.keys(pins.npmScripts ?? {}) } });
    return getStandingAuthorization(db, id);
  });
}

export function revokeStandingAuthorization(db: CoreDatabase, id: string, actor: string, reason = 'revoked by the user'): StandingAuthorization {
  const current = getStandingAuthorization(db, id);
  if (current.revokedAt) return current;
  db.run('UPDATE standing_authorizations SET revokedAt = ?, revokedBy = ?, revokeReason = ? WHERE id = ?', [nowIso(), actor, reason.slice(0, 200), id]);
  recordRuntimeEvent(db, { domain: 'authorization', entityId: id, eventType: 'standing_authorization_revoked', actor, metadata: { conversationId: current.conversationId, reason } });
  return getStandingAuthorization(db, id);
}

// ------------------------------------------------------------------ freezing at submission

/** Keys a client may never set on a request's tool permission policy: Core derives them. */
const CORE_OWNED_POLICY_KEYS = ['permission', 'machineControlAuthorized'] as const;

/**
 * Builds the tool permission policy Core stores on a new request: whatever the client sent, minus every key that could
 * grant authority, plus the conversation's current mode and the authorizations active right now.
 */
export function freezeRequestPermission(db: CoreDatabase, input: {
  conversationId: string | null | undefined;
  clientPolicy: Record<string, unknown> | undefined;
  actor: string;
}): { policy: Record<string, unknown>; permission: FrozenPermission; strippedKeys: string[] } {
  const clientPolicy = { ...(input.clientPolicy ?? {}) };
  const strippedKeys = CORE_OWNED_POLICY_KEYS.filter((k) => Object.hasOwn(clientPolicy, k));
  for (const k of strippedKeys) delete clientPolicy[k];
  // The folder's access level can only narrow a turn: anything but exactly 'read_write' is frozen as 'read'.
  if (Object.hasOwn(clientPolicy, 'workspaceAccess')) {
    clientPolicy.workspaceAccess = clientPolicy.workspaceAccess === 'read_write' ? 'read_write' : 'read';
  }
  const conversationId = input.conversationId ?? null;
  const mode = conversationId ? getConversationPermissionMode(db, conversationId) : 'ask';
  const authorizationIds = conversationId && mode === 'auto'
    ? listStandingAuthorizations(db, conversationId).filter((a) => isActive(a)).map((a) => a.id)
    : [];
  const permission: FrozenPermission = { mode, authorizationIds, conversationId, frozenAt: nowIso() };
  return { policy: { ...clientPolicy, permission }, permission, strippedKeys };
}

/** The permission frozen on the first of these attempts that has one; anything without a frozen permission is Ask. */
export function frozenPermissionFor(db: CoreDatabase, attemptIds: Array<string | null | undefined>): FrozenPermission {
  for (const id of attemptIds) {
    if (!id) continue;
    try {
      const p = (getAttemptContext(db, id).approvalPolicy as Record<string, unknown> | undefined)?.permission as FrozenPermission | undefined;
      if (p && PERMISSION_MODES.includes(p.mode)) return { ...ASK, ...p, authorizationIds: Array.isArray(p.authorizationIds) ? p.authorizationIds : [] };
    } catch {
      // No frozen context for this identity (e.g. a capability anchor): keep looking.
    }
  }
  return ASK;
}

// ------------------------------------------------------------------ deterministic action checks

/** Shell syntax that could chain, redirect, substitute or expand. Any of it means "not a single plain command". */
const SHELL_SYNTAX = /[;&|<>`$()%^!\r\n]|\{|\}/;

function tokens(command: string): string[] | null {
  const t = command.trim();
  if (!t || SHELL_SYNTAX.test(t)) return null;
  const out: string[] = [];
  for (const m of t.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** A relative path that stays inside the workspace (no drive, no root, no parent segments). */
function staysInside(p: string): boolean {
  return !/^[a-zA-Z]:|^[\\/]|^~/.test(p) && !p.split(/[\\/]/).includes('..');
}

const GIT_REV = /^(?:[0-9a-f]{4,40}|HEAD(?:~\d{1,3})?)$/;

/** Git config keys whose value git runs (or that pull in more config). */
const GIT_EXEC_KEY = /^(?:core\.(?:hookspath|fsmonitor|pager|editor|sshcommand|askpass|gitproxy|alternaterefscommand)|pager\..+|sequence\.editor|diff\.external|diff\..+\.(?:textconv|command)|filter\..+\.(?:clean|smudge|process)|merge\..+\.driver|gpg\.(?:.+\.)?program|credential\..*helper|include\.path|includeif\..+\.path|uploadpack\.packobjectshook)$/;

function insideDir(p: string, root: string): boolean {
  const a = path.resolve(p).toLowerCase();
  const r = path.resolve(root).toLowerCase();
  return a === r || a.startsWith(r + path.sep);
}

function hooksIn(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => !f.endsWith('.sample'));
  } catch {
    return false;
  }
}

/**
 * Whether git can run in the workspace without executing anything the workspace controls. Reads git's EFFECTIVE config
 * (system, global, repository and everything they include): a program configured by the repository, or by any config
 * file inside the workspace, refuses; a program from the user's own machine config (e.g. Git LFS) is trusted like any
 * installed tool unless it points into the workspace. Hooks (hooksPath or .git/hooks) refuse every git command, since
 * even `git status` can rewrite the index and fire one. Any failure to read the config refuses.
 */
function gitConfigIsPlain(workspaceRoot: string): { ok: boolean; reason?: string } {
  const gitDir = path.join(workspaceRoot, '.git');
  try {
    if (!fs.statSync(gitDir).isDirectory()) return { ok: false, reason: 'the workspace .git is not a plain directory' };
  } catch {
    return { ok: false, reason: 'the workspace is not a git repository' };
  }
  let listing: string;
  try {
    // -C, not cwd: Windows process lookup searches the child's working directory, which is workspace content.
    listing = cp.execFileSync('git', ['-C', workspaceRoot, 'config', '--list', '--show-scope', '--show-origin', '-z'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { ok: false, reason: 'the git configuration could not be read' };
  }
  const parts = listing.split('\0');
  let hooksPath: string | null = null;
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i];
    const origin = parts[i + 1].replace(/^file:/, '');
    const nl = parts[i + 2].indexOf('\n');
    const key = (nl < 0 ? parts[i + 2] : parts[i + 2].slice(0, nl)).toLowerCase();
    const value = nl < 0 ? '' : parts[i + 2].slice(nl + 1);
    if (key === 'core.hookspath') hooksPath = value;
    if (!GIT_EXEC_KEY.test(key)) continue;
    const workspaceOwned = scope === 'local' || scope === 'worktree' || (parts[i + 1].startsWith('file:') && insideDir(origin, workspaceRoot));
    if (workspaceOwned) return { ok: false, reason: `the repository config sets ${key}, which runs or loads external programs` };
    const pointsInside = /(?:^|[\s'"=])\.{1,2}[\\/]/.test(value) || value.replace(/\\/g, '/').toLowerCase().includes(path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase());
    if (pointsInside) return { ok: false, reason: `the git setting ${key} runs a program from inside the workspace` };
  }
  const hooksDir = hooksPath
    ? path.resolve(workspaceRoot, hooksPath.replace(/^~(?=[\\/])/, os.homedir()))
    : path.join(gitDir, 'hooks');
  if (hooksIn(hooksDir)) return { ok: false, reason: 'the repository has git hooks, which git would run' };
  return { ok: true };
}

/**
 * Windows cmd.exe looks for a command in the working directory before PATH, so a `git.bat` or `npm.cmd` in the
 * workspace would run instead of the real tool.
 */
function shadowedInWorkspace(bin: string, workspaceRoot: string): string | null {
  if (process.platform !== 'win32') return null;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC').toLowerCase().split(';').filter(Boolean);
  try {
    return fs.readdirSync(workspaceRoot).find((f) => exts.some((e) => f.toLowerCase() === bin + e)) ?? null;
  } catch {
    return `${bin} (workspace unreadable)`;
  }
}

type CommandMatch = { category: AuthorizationCategory; detail: string } | { category: null; reason: string };

/** Classifies one command line against the workspace categories. Unrecognised means unauthorized. */
export function classifyWorkspaceCommand(command: string, workspaceRoot: string, pins: StandingAuthorization['pins']): CommandMatch {
  const t = tokens(command);
  if (!t) return { category: null, reason: 'the command uses shell syntax (chaining, redirection, variables or substitution)' };
  const [exe, ...args] = t;
  const bin = exe.toLowerCase().replace(/\.(?:exe|cmd)$/, '');
  if (bin === 'dir') {
    if (args.every((a) => /^\/[a-z]$/i.test(a) || staysInside(a))) return { category: 'workspace_read_commands', detail: 'dir' };
    return { category: null, reason: 'dir points outside the workspace' };
  }
  if (bin === 'git' || bin === 'npm') {
    const shadow = shadowedInWorkspace(bin, workspaceRoot);
    if (shadow) return { category: null, reason: `the workspace contains ${shadow}, which would run instead of ${bin}` };
  }
  if (bin === 'git') {
    const [sub, ...rest] = args;
    const plain = gitConfigIsPlain(workspaceRoot);
    if (!plain.ok) return { category: null, reason: plain.reason! };
    if (sub === 'status' && rest.every((a) => ['--short', '-s', '--porcelain', '-b', '--branch'].includes(a))) return { category: 'workspace_read_commands', detail: 'git status' };
    if (sub === 'diff' && rest.every((a) => ['--stat', '--cached', '--staged', '--name-only', '--name-status'].includes(a) || GIT_REV.test(a))) return { category: 'workspace_read_commands', detail: 'git diff' };
    if (sub === 'log' && rest.every((a) => ['--oneline', '--stat'].includes(a) || /^-n?\d{1,3}$/.test(a) || /^--max-count=\d{1,3}$/.test(a))) return { category: 'workspace_read_commands', detail: 'git log' };
    if (sub === 'show' && rest.every((a) => ['--stat', '--name-only'].includes(a) || GIT_REV.test(a))) return { category: 'workspace_read_commands', detail: 'git show' };
    if (sub === 'add' || sub === 'commit') {
      if (sub === 'add' && rest.length > 0 && rest.every((a) => a === '-A' || a === '--all' || (!a.startsWith('-') && staysInside(a)))) return { category: 'workspace_git_commit', detail: 'git add' };
      if (sub === 'commit' && rest.length === 2 && rest[0] === '-m' && rest[1].trim()) return { category: 'workspace_git_commit', detail: 'git commit -m' };
    }
    return { category: null, reason: `git ${sub ?? ''} with these arguments is not covered` };
  }
  if (bin === 'npm') {
    const script = args[0] === 'test' && args.length === 1 ? 'test' : args[0] === 'run' && args.length === 2 ? args[1] : null;
    if (!script || !(VALIDATION_SCRIPTS as readonly string[]).includes(script)) return { category: null, reason: 'only npm test or npm run test/lint/typecheck/build/compile without extra arguments is covered' };
    const pinned = pins.npmScripts?.[script];
    if (!pinned) return { category: null, reason: `the '${script}' script was not pinned when this authorization was granted` };
    if (scriptChainDigest(readPackageScripts(workspaceRoot), script) !== pinned) return { category: null, reason: `package.json '${script}' (or its pre/post script) changed since this authorization was granted` };
    const above = dependenciesAboveWorkspace(workspaceRoot);
    if (above) return { category: null, reason: `${above} is outside the pinned workspace, so '${script}' could run dependencies nobody checked` };
    if (!pins.workspaceDigest || workspaceDigest(workspaceRoot) !== pins.workspaceDigest) return { category: null, reason: `workspace files changed since this authorization was granted (installed dependencies included), or can no longer be verified, so '${script}' would run code you have not seen` };
    return { category: 'workspace_validation', detail: `npm ${script === 'test' ? 'test' : `run ${script}`}` };
  }
  return { category: null, reason: `'${exe}' is not a covered command` };
}

/**
 * Plain words for what Auto never covers. Each phrase stands for a rule in `alwaysEscalateReason` below (the tests
 * check that Core really escalates an example of each), so the assistant can state them without improvising.
 */
export const ALWAYS_ASKS_PHRASES: readonly string[] = [
  'sending email or any other message (WhatsApp, SMS, calls)',
  'purchases, payments and contracts',
  'deleting, removing or uninstalling anything',
  'writing or editing files',
  'calendar changes',
  'network, install and destructive commands (git push/pull/fetch/clone, npm or pip install, curl, wget)',
];

/** Short names for the categories, for one line of the prompt. Typed so a new category cannot be left out. */
const CATEGORY_SHORT_NAMES: Record<AuthorizationCategory, string> = {
  workspace_read_commands: 'read-only workspace commands',
  workspace_validation: 'the pinned validation scripts',
  workspace_git_commit: 'git add/commit in the workspace',
  workspace_inspect_page: 'inspecting a workspace HTML page',
  web_research_public: 'public web searches',
};

export interface PermissionPromptState {
  mode: PermissionMode;
  /** Active standing authorizations frozen on this turn (empty unless Auto). */
  authorizations: Array<{ categories: string[]; expiresAt: string; workspaceRoot?: string | null }>;
}

/** The mode this turn was frozen with and the authorizations it carries that are still active. */
export function permissionPromptState(db: CoreDatabase, attemptIds: Array<string | null | undefined>, nowMs = Date.now()): PermissionPromptState {
  const frozen = frozenPermissionFor(db, attemptIds);
  if (frozen.mode !== 'auto') return { mode: frozen.mode, authorizations: [] };
  const authorizations: PermissionPromptState['authorizations'] = [];
  for (const id of frozen.authorizationIds) {
    try {
      const auth = getStandingAuthorization(db, id);
      if (isActive(auth, nowMs)) authorizations.push({ categories: auth.categories, expiresAt: auth.expiresAt, workspaceRoot: auth.workspaceRoot });
    } catch {
      // A grant that no longer exists covers nothing.
    }
  }
  return { mode: 'auto', authorizations };
}

/** A message about approvals or modes ("we need an auto mode where I don't approve every time"). */
export function asksAboutPermissions(text: string): boolean {
  return /\b(?:auto(?:matic(?:ally)?)?|approv\w*|permissions?|modes?|plan only|ask(?:ing)? (?:me|first|every)|stop asking|every time|allow(?:ed|ing)?|authori[sz]\w*|grants?|revok\w*)\b/i.test(String(text ?? ''));
}

/**
 * The product facts the assistant needs when the user asks about approvals or an "auto mode": the three modes, what
 * Auto can cover, its limits, what always asks, where the switch is, and what is in force for this message. Built from
 * the constants Core enforces, so the answer is product truth rather than an improvised policy. With `brief`, one
 * line: the mode in force and that the others exist (the full facts cost ~350 tokens on every turn).
 */
export function permissionModesPromptSection(current: PermissionPromptState, formatTime: (iso: string) => string = (iso) => iso, options: { brief?: boolean } = {}): string {
  if (options.brief && current.mode === 'ask') {
    return 'PERMISSION MODE: this conversation is in Ask permission (every protected action waits for the user\'s approval card). The other modes are Auto (governed: the user lets a few low-risk kinds of work run without a card for up to 24 hours, revocable) and Plan only (nothing is changed). Only the user switches them, with the permission menu next to the model menu at the message box; never invent other modes or rules.';
  }
  const categories = Object.values(AUTHORIZATION_CATEGORIES).map((text) => `"${text}"`).join('; ');
  const short = (c: string) => CATEGORY_SHORT_NAMES[c as AuthorizationCategory] ?? c;
  let now: string;
  if (current.mode === 'plan') now = 'Plan only.';
  else if (current.mode === 'ask') now = 'Ask permission.';
  else if (current.authorizations.length === 0) now = 'Auto, but nothing is granted, so everything still asks.';
  else {
    now = `Auto, covering ${current.authorizations.map((a) => `${a.categories.map(short).join(', ')}${a.workspaceRoot ? ` in ${a.workspaceRoot}` : ''} until ${formatTime(a.expiresAt)}`).join('; ')}. Everything else asks.`;
  }
  return `PANDESH PERMISSION MODES (product facts; use them for any question about approvals or an "auto mode", never improvise):
- Every conversation has one of three modes. Only the user switches it, with the permission menu next to the model menu at the message box (v2 and Classic interface). You cannot switch it, and never claim you did.
- Ask permission (the default): anything that changes something, goes online or leaves this PC waits for the user's approval card.
- Auto (governed): the user ticks what may run without a card in this conversation, for 1, 8 or 24 hours (never longer than ${MAX_AUTHORIZATION_MINUTES / 60} hours). Only these can be ticked: ${categories}. The workspace ones need a selected workspace folder and apply only inside it. The user can revoke Auto at any time (Revoke, or switch back to Ask), and it ends by itself when it expires. A change applies from the next message; a running task keeps the mode it started with.
- Even in Auto these always ask: ${ALWAYS_ASKS_PHRASES.join('; ')}; and anything that was not ticked.
- Plan only: Pandesh researches and plans; nothing is created, changed, sent or run.
- This conversation, for this message: ${now}
- When the user wants fewer approvals ("auto mode", "stop asking me every time"), explain Auto with these facts and say where the switch is. There are no other modes or settings for this.`;
}

/** Actions that always need the human, whatever the mode or authorization says (requirement: explicit approval). */
export function alwaysEscalateReason(toolName: string, args: Record<string, unknown>): string | null {
  const name = toolName.toLowerCase();
  if (/^gmail_(send|apply|undo|create_draft|create_task|task_next)/.test(name) || /send|email|whatsapp|sms|phone/.test(name)) return 'outbound messages always need your explicit approval';
  if (/purchase|payment|checkout|order|pay_|transfer|invoice|contract|subscribe/.test(name)) return 'purchases, payments and contracts always need your explicit approval';
  if (/delete|trash|remove|kill|terminate|stop_service|uninstall|format/.test(name)) return 'destructive operations always need your explicit approval';
  if (/^(propose_file_change|propose_text_edit|write_file|authorize_mission|print_test_page|delegate_to_opencode)$/.test(name)) return `${toolName} always needs your explicit approval (or a frozen mission envelope)`;
  if (/^calendar_/.test(name) && !/^calendar_(list|get|search|find)/.test(name)) return 'calendar changes always need your explicit approval';
  if (args.alwaysAsk === true) return 'destructive operations always need your explicit approval';
  const command = typeof args.command === 'string' ? args.command : '';
  if (command && /\b(git\s+(push|remote|fetch|pull|clone|reset|clean|checkout|rebase)|npm\s+(publish|install|i|ci|uninstall)|pip\s+install|curl|wget|invoke-webrequest|rm\s|del\s|rmdir|format|shutdown)\b/i.test(command)) {
    return 'network, install and destructive commands always need your explicit approval';
  }
  return null;
}

export interface PermissionDecision {
  decision: 'auto_authorize' | 'review' | 'deny';
  reason: string;
  mode: PermissionMode;
  authorizationId?: string;
  category?: AuthorizationCategory;
}

/**
 * The one decision for a protected action. `mutating` is the caller's own deterministic classification (dispatch risk
 * or the chat tool table); unknown actions must be passed as mutating.
 */
export function decidePermission(db: CoreDatabase, input: {
  attemptIds: Array<string | null | undefined>;
  toolName: string;
  arguments: Record<string, unknown>;
  mutating: boolean;
  workspaceRoot?: string | null;
  nowMs?: number;
}): PermissionDecision {
  const permission = frozenPermissionFor(db, input.attemptIds);
  const mode = permission.mode;
  // A read-only folder refuses before any mode is applied: not even an Auto authorization can change it.
  if (input.mutating && frozenWorkspaceAccess(db, input.attemptIds) === 'read') {
    const refusal = readOnlyWorkspaceRefusal(input.toolName, input.arguments, input.workspaceRoot ?? null);
    if (refusal) return { decision: 'deny', mode, reason: refusal };
  }
  if (mode === 'plan') {
    return input.mutating
      ? { decision: 'deny', mode, reason: `Plan Only: ${input.toolName} would change something, so it was not done. Nothing was changed.` }
      : { decision: 'review', mode, reason: 'Plan Only allows read-only work under its usual consent' };
  }
  if (mode !== 'auto') return { decision: 'review', mode, reason: 'Ask mode: this needs your approval' };
  const escalate = alwaysEscalateReason(input.toolName, input.arguments);
  if (escalate) return { decision: 'review', mode, reason: escalate };
  const nowMs = input.nowMs ?? Date.now();
  let lastReason = 'no standing authorization was in force when this turn started';
  for (const id of permission.authorizationIds) {
    let auth: StandingAuthorization;
    try { auth = getStandingAuthorization(db, id); } catch { continue; }
    if (auth.revokedAt) { lastReason = `standing authorization ${id} was revoked`; continue; }
    if (Date.parse(auth.expiresAt) <= nowMs) { lastReason = `standing authorization ${id} expired at ${auth.expiresAt}`; continue; }
    if (permission.conversationId && auth.conversationId !== permission.conversationId) continue;
    const match = matchAuthorization(auth, input);
    if (match.category === 'workspace_validation' && auth.workspaceRoot && pandeshWroteUnder(db, auth.workspaceRoot, auth.createdAt)) {
      lastReason = 'Pandesh wrote files in this workspace since the authorization was granted, so the scripts would run code you have not seen';
      continue;
    }
    if (match.category) {
      return { decision: 'auto_authorize', mode, authorizationId: auth.id, category: match.category, reason: `covered by standing authorization ${auth.id} (${match.category}: ${match.detail}), valid until ${auth.expiresAt}` };
    }
    lastReason = match.reason;
  }
  return { decision: 'review', mode, reason: lastReason };
}

function sameDir(a: string, b: string): boolean {
  const ca = canonicalDir(a);
  const cb = canonicalDir(b);
  return Boolean(ca && cb && ca.toLowerCase() === cb.toLowerCase());
}

function matchAuthorization(auth: StandingAuthorization, input: { toolName: string; arguments: Record<string, unknown>; workspaceRoot?: string | null }): CommandMatch {
  const has = (c: AuthorizationCategory) => auth.categories.includes(c);
  if (input.toolName === 'run_command' || input.toolName === 'run_checks') {
    // run_checks names its own working directory; run_command runs in the dispatch workspace.
    const where = input.toolName === 'run_checks' ? String(input.arguments.workingDirectory ?? '') : input.workspaceRoot;
    if (!auth.workspaceRoot || !where || !sameDir(auth.workspaceRoot, where)) return { category: null, reason: 'the command does not run in the trusted workspace' };
    if (typeof input.arguments.cwd === 'string' && !sameDir(path.resolve(auth.workspaceRoot, input.arguments.cwd), auth.workspaceRoot)) return { category: null, reason: 'the command changes directory away from the workspace root' };
    const m = classifyWorkspaceCommand(String(input.arguments.command ?? ''), auth.workspaceRoot, auth.pins);
    if (m.category && !has(m.category)) return { category: null, reason: `${m.detail} needs '${m.category}', which this authorization does not include` };
    return m;
  }
  if (input.toolName === 'inspect_page') {
    if (!has('workspace_inspect_page')) return { category: null, reason: 'page inspection is not authorized' };
    const p = String(input.arguments.path ?? '');
    if (!auth.workspaceRoot || !input.workspaceRoot || !sameDir(auth.workspaceRoot, input.workspaceRoot)) return { category: null, reason: 'the page is not in the trusted workspace' };
    if (!p || /^[a-z]+:\/\//i.test(p) || !staysInside(p) || !/\.html?$/i.test(p)) return { category: null, reason: 'only a workspace-relative .html page is covered' };
    return { category: 'workspace_inspect_page', detail: p };
  }
  if (input.toolName === 'web_research') {
    if (!has('web_research_public')) return { category: null, reason: 'web research is not authorized' };
    const query = String(input.arguments.query ?? '');
    const privacy = classifyPrivacy(query, 'public_research');
    if (privacy.privacy !== 'public') return { category: null, reason: `the search query may contain private data (${privacy.reasons.join(', ')})` };
    return { category: 'web_research_public', detail: 'public query' };
  }
  return { category: null, reason: `${input.toolName} is not covered by any standing authorization` };
}

/** Chat tools that only read (some still ask their own consent, e.g. web access). Anything not listed is a mutation. */
const CHAT_READ_TOOLS: ReadonlySet<string> = new Set([
  'recall_execution', 'personal_overview', 'search_second_brain', 'list_tasks',
  'get_system_info', 'list_system_drives', 'request_search_permission', 'find_project_roots', 'search_files', 'resolve_time',
  'dev_stories_status', 'list_reminders', 'list_commitments', 'list_scheduled_tasks', 'get_briefing_data', 'web_research',
  'find_duplicate_files', 'list_directory', 'get_project_context', 'read_file', 'search_recent_projects', 'list_printers',
  'wish_status', 'calculate',
  // Reads what Windows lists as installed; opens a place in the Pandesh window (changes nothing, stops nothing).
  'find_installed_app', 'navigate_to',
]);
/** Pandesh's own record of what this turn did; it changes nothing outside the turn. */
const CHAT_BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(['update_task_outcome']);

/**
 * Plan Only's view of one chat tool call. `bridgeReadOnly` lists bridge tools (connectors, memory, capabilities) whose
 * own registry classifies them read-only. Unknown tools are mutations: fail closed.
 */
export function classifyChatToolCall(toolName: string, args: Record<string, unknown>, bridgeReadOnly: ReadonlySet<string>, workspaceRoot: string | null): 'read' | 'mutating' {
  if (CHAT_READ_TOOLS.has(toolName) || CHAT_BOOKKEEPING_TOOLS.has(toolName) || bridgeReadOnly.has(toolName)) return 'read';
  if (toolName === 'run_checks') {
    const dir = typeof args.workspacePath === 'string' && args.workspacePath ? args.workspacePath : workspaceRoot;
    if (!dir) return 'mutating';
    return classifyWorkspaceCommand(String(args.command ?? ''), dir, {}).category === 'workspace_read_commands' ? 'read' : 'mutating';
  }
  return 'mutating';
}

/** Approval cards that only ask consent for read-only access or a public lookup; Plan Only keeps them as cards. */
export const READ_ONLY_CONSENT_TOOLS: ReadonlySet<string> = new Set(['request_search_permission', 'web_research']);

/**
 * Safety net for every approval site: in a Plan Only turn a mutation or delivery approval is recorded as already
 * rejected by Core, so no client can approve it. Returns the rejection to apply, or null.
 */
export function planOnlyApprovalVeto(db: CoreDatabase, input: { attemptId: string; kind: string; summary: Record<string, unknown> }): { reason: string } | null {
  if (input.kind !== 'mutation' && input.kind !== 'delivery') return null;
  if (READ_ONLY_CONSENT_TOOLS.has(String(input.summary.toolName ?? ''))) return null;
  const scope = typeof input.summary.scopeIdentity === 'string' ? input.summary.scopeIdentity : null;
  if (frozenPermissionFor(db, [scope, input.attemptId]).mode !== 'plan') return null;
  return { reason: `Plan Only: ${String(input.summary.toolName ?? input.kind)} would change something, so it was not done. Nothing was changed.` };
}

// ------------------------------------------------------------------ the workspace folder's access level

/**
 * How far the person let Pandesh into the selected folder, chosen when the folder became the workspace:
 *  - `read`:       open, list and search the files there. Nothing is written and no program is run, whatever the mode
 *                  or a standing authorization says (plain read commands such as dir and git status still run).
 *  - `read_write`: Pandesh may also ask to create and change files and run programs; each still needs the person's
 *                  approval card, or an authorization they granted.
 * The desktop sends it with every request that has a workspace, and Core freezes it with the request like the mode, so
 * a later change never alters a running turn. A request without it (older clients, routines) keeps today's behaviour.
 */
export type WorkspaceAccess = 'read' | 'read_write';
export const READ_ONLY_WORKSPACE_ACTOR = 'core:workspace_access:read_only';

/** Tools that create or change files, or run programs, in a folder. A read-only workspace refuses all of them. */
export const WORKSPACE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'propose_file_change', 'propose_text_edit', 'authorize_mission', 'run_command', 'run_checks',
  'workspace_validation', 'delegate_to_opencode', 'delegate_to_coding_agent', 'file_modification',
]);

/**
 * The narrowest access frozen on any of these attempts: one layer that is read-only makes the action read-only.
 * Attempts without the key (older requests, routines, unknown ids) are read and write, as before.
 */
export function frozenWorkspaceAccess(db: CoreDatabase, attemptIds: Array<string | null | undefined>): WorkspaceAccess {
  for (const id of attemptIds) {
    if (!id) continue;
    try {
      if ((getAttemptContext(db, id).approvalPolicy as Record<string, unknown> | undefined)?.workspaceAccess === 'read') return 'read';
    } catch {
      // No frozen context for this identity (e.g. a capability anchor): keep looking.
    }
  }
  return 'read_write';
}

/**
 * Why this call may not run while the workspace is read-only, or null when it may (a tool that changes no file, or a
 * plain read command such as dir or git status).
 */
export function readOnlyWorkspaceRefusal(toolName: string, args: Record<string, unknown>, workspaceRoot: string | null): string | null {
  const targetFiles = Array.isArray(args.targetFiles) ? args.targetFiles.filter((f) => typeof f === 'string' && f) : [];
  if (!WORKSPACE_CHANGE_TOOLS.has(toolName) && targetFiles.length === 0) return null;
  if (toolName === 'run_command' || toolName === 'run_checks') {
    const command = String(args.command ?? '');
    const dir = [args.workingDirectory, args.workspacePath].find((d): d is string => typeof d === 'string' && Boolean(d)) ?? workspaceRoot;
    if (command && dir && classifyWorkspaceCommand(command, dir, {}).category === 'workspace_read_commands') return null;
    return `Read-only folder: the person let Pandesh read this folder but not change it, so ${toolName} was not run. Nothing was changed. Only the person can allow changes, from the folder menu next to the message box.`;
  }
  return `Read-only folder: the person let Pandesh read this folder but not change it, so ${toolName} was not done. Nothing was changed. Only the person can allow changes, from the folder menu next to the message box.`;
}

/**
 * Safety net for every approval site, next to Plan Only's: while the turn's workspace is read-only, an approval to
 * change files, run a program or deliver a change is recorded as already rejected by Core, so no click can approve it.
 */
export function readOnlyWorkspaceApprovalVeto(db: CoreDatabase, input: { attemptId: string; kind: string; summary: Record<string, unknown> }): { reason: string } | null {
  if (input.kind !== 'mutation' && input.kind !== 'delivery') return null;
  const toolName = String(input.summary.toolName ?? '');
  if (READ_ONLY_CONSENT_TOOLS.has(toolName)) return null;
  const scope = typeof input.summary.scopeIdentity === 'string' ? input.summary.scopeIdentity : null;
  if (frozenWorkspaceAccess(db, [scope, input.attemptId]) !== 'read') return null;
  if (input.kind === 'delivery') return { reason: 'Read-only folder: delivering a change was not done, because the person let Pandesh read this folder but not change it. Nothing was changed.' };
  const reason = readOnlyWorkspaceRefusal(toolName || input.kind, input.summary, null);
  return reason ? { reason } : null;
}

/** Records that Core, not a person, authorized an action, with everything needed to audit why. */
export function recordPermissionDecision(db: CoreDatabase, input: { attemptId: string; toolName: string; arguments: Record<string, unknown>; decision: PermissionDecision; approvalId?: string | null }): void {
  recordRuntimeEvent(db, {
    domain: 'attempt',
    entityId: input.attemptId,
    eventType: input.decision.decision === 'auto_authorize' ? 'permission_auto_authorized' : input.decision.decision === 'deny' ? 'permission_mode_blocked' : 'permission_review_required',
    actor: input.decision.decision === 'deny' ? (input.decision.reason.startsWith('Read-only folder') ? READ_ONLY_WORKSPACE_ACTOR : PLAN_ONLY_ACTOR) : STANDING_AUTHORIZATION_ACTOR,
    metadata: {
      toolName: input.toolName,
      argumentsDigest: sha256(JSON.stringify(input.arguments ?? {})).slice(0, 32),
      mode: input.decision.mode,
      authorizationId: input.decision.authorizationId ?? null,
      category: input.decision.category ?? null,
      reason: input.decision.reason,
      approvalId: input.approvalId ?? null,
    },
  });
}
