/**
 * The workspace folder and how far the person let Pandesh into it.
 *
 * A folder becomes the workspace only when the person says so: from the folder menu next to the message box, or on the
 * card Pandesh shows when a message names a folder by its full path ("check this folder D:\Projects\Site"). Either way
 * the person decides two things on that card: Read (open, list and search the files there; a workspace needs it) and
 * Write (create and change files and run programs there; each change still asks them first). The choice is sent with
 * every request and Core freezes it (core/domain/permissionModes.ts WorkspaceAccess), so a read-only folder is enforced
 * by Core, not by this window.
 *
 * Some folders can never be the workspace: Pandesh's own data folder (its tokens and database live there), a folder
 * that contains it, and the Windows system folders.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type WorkspaceAccess = 'read' | 'read_write';
/** How the folder became the workspace. `earlier_build`: chosen before access levels existed, so it keeps full access. */
export type WorkspaceSource = 'picker' | 'chat' | 'recent' | 'earlier_build';

export interface WorkspaceRecord {
  folder: string;
  access: WorkspaceAccess;
  grantedAt: string;
  source: WorkspaceSource;
}

export interface RecentWorkspace {
  folder: string;
  access: WorkspaceAccess;
  lastUsedAt: string;
}

export interface FolderCheck {
  folder: string;
  /** `ok`: it can be the workspace. Anything else says why not. */
  state: 'ok' | 'missing' | 'not_a_folder' | 'refused' | 'unreadable';
  /** Why it cannot be the workspace (set unless `ok`). */
  reason?: string;
  /** Something the person should know before choosing it (a whole drive, a folder Windows marks read-only). */
  warning?: string;
  readable: boolean;
  /** Windows' read-only flag only: a folder can still refuse a write for other reasons. */
  writable: boolean;
}

const MAX_RECENT = 6;
const LAST_WORKSPACE_FILE = 'last-workspace.json';
const RECENT_FILE = 'workspace-history.json';

export function isWorkspaceAccess(value: unknown): value is WorkspaceAccess {
  return value === 'read' || value === 'read_write';
}

/** The same folder, however it is spelled (case, separators, a trailing slash). */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
}

/** `child` is `parent` or lies inside it. */
export function folderInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function normalize(p: string): string {
  const resolved = path.resolve(p);
  const trimmed = resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

// ------------------------------------------------------------------ the selected workspace, kept across restarts

export function readWorkspaceRecord(dataDir: string): WorkspaceRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, LAST_WORKSPACE_FILE), 'utf8')) as Record<string, unknown>;
    if (typeof raw.folder !== 'string' || !raw.folder.trim()) return null;
    const known = isWorkspaceAccess(raw.access);
    return {
      folder: path.resolve(raw.folder),
      // A folder saved before access levels existed was chosen with full access; it keeps it until the person changes it.
      access: known ? raw.access as WorkspaceAccess : 'read_write',
      grantedAt: typeof raw.grantedAt === 'string' ? raw.grantedAt : String(raw.updatedAt ?? ''),
      source: known && typeof raw.source === 'string' ? raw.source as WorkspaceSource : 'earlier_build',
    };
  } catch {
    return null;
  }
}

export function writeWorkspaceRecord(dataDir: string, record: WorkspaceRecord): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, LAST_WORKSPACE_FILE), `${JSON.stringify({
    folder: path.resolve(record.folder),
    access: record.access,
    grantedAt: record.grantedAt,
    source: record.source,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

/** "Stop using this folder" must survive a restart: both the current file and the one very old builds wrote. */
export function clearWorkspaceRecord(dataDir: string): void {
  for (const name of [LAST_WORKSPACE_FILE, 'last-workspace.txt']) {
    try { fs.rmSync(path.join(dataDir, name), { force: true }); } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------ recent folders (for the folder menu)

export function readRecentWorkspaces(dataDir: string): RecentWorkspace[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, RECENT_FILE), 'utf8')) as { recent?: unknown };
    if (!Array.isArray(raw.recent)) return [];
    return raw.recent
      .filter((r): r is RecentWorkspace => Boolean(r) && typeof (r as RecentWorkspace).folder === 'string' && isWorkspaceAccess((r as RecentWorkspace).access))
      .map((r) => ({ folder: path.resolve(r.folder), access: r.access, lastUsedAt: String(r.lastUsedAt ?? '') }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Puts the folder first with the access just chosen; the list keeps the last few folders. */
export function rememberWorkspace(dataDir: string, folder: string, access: WorkspaceAccess, now = new Date()): RecentWorkspace[] {
  const next = [
    { folder: path.resolve(folder), access, lastUsedAt: now.toISOString() },
    ...readRecentWorkspaces(dataDir).filter((r) => !sameFolder(r.folder, folder)),
  ].slice(0, MAX_RECENT);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, RECENT_FILE), `${JSON.stringify({ recent: next }, null, 2)}\n`, 'utf8');
  } catch {
    // The list is a convenience; failing to save it never blocks choosing the folder.
  }
  return next;
}

// ------------------------------------------------------------------ can this folder be the workspace?

/**
 * Whether a folder can be the workspace, and what the person should know first. Reads only the folder's own entry and
 * listing; it never writes a test file into the person's folder.
 */
export function checkWorkspaceFolder(folder: string, opts: { dataDir: string; env?: NodeJS.ProcessEnv }): FolderCheck {
  const resolved = path.resolve(String(folder ?? '').trim() || '.');
  const base = { folder: resolved, readable: false, writable: false };
  if (!String(folder ?? '').trim() || !path.isAbsolute(String(folder).trim())) {
    return { ...base, state: 'missing', reason: 'a workspace needs a full folder path, such as D:\\Projects\\Site' };
  }
  if (/^\\\\/.test(String(folder).trim())) {
    return { ...base, state: 'refused', reason: 'network folders (\\\\server\\share) cannot be the workspace' };
  }
  const refusal = refusedFolderReason(resolved, opts);
  if (refusal) return { ...base, state: 'refused', reason: refusal };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ...base, state: 'missing', reason: 'this folder does not exist on this PC' };
  }
  if (!stat.isDirectory()) return { ...base, state: 'not_a_folder', reason: 'this is a file, not a folder' };
  try {
    fs.readdirSync(resolved);
  } catch (err) {
    return { ...base, state: 'unreadable', reason: `Windows does not let Pandesh read this folder (${(err as NodeJS.ErrnoException).code ?? 'access denied'})` };
  }
  let writable = true;
  try { fs.accessSync(resolved, fs.constants.W_OK); } catch { writable = false; }
  const warnings: string[] = [];
  if (path.parse(resolved).root.toLowerCase() === resolved.toLowerCase()) {
    warnings.push(`This is the whole ${resolved.replace(/[\\/]+$/, '')} drive: Pandesh would be able to read everything on it.`);
  }
  if (!writable) warnings.push('Windows marks this folder read-only, so changes there may fail.');
  return { ...base, state: 'ok', readable: true, writable, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
}

function refusedFolderReason(folder: string, opts: { dataDir: string; env?: NodeJS.ProcessEnv }): string | null {
  const env = opts.env ?? process.env;
  const dataDir = path.resolve(opts.dataDir);
  if (folderInside(folder, dataDir)) return 'this is Pandesh\'s own data folder, which holds its sign-in tokens and database';
  if (folderInside(dataDir, folder)) return `it contains Pandesh's own data folder (${dataDir}), which holds its sign-in tokens and database. Choose a folder inside it instead`;
  const systemDrive = (env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
  const systemFolders = [
    env.SystemRoot || env.windir || `${systemDrive}\\Windows`,
    env.ProgramFiles || `${systemDrive}\\Program Files`,
    env['ProgramFiles(x86)'] || `${systemDrive}\\Program Files (x86)`,
    env.ProgramData || `${systemDrive}\\ProgramData`,
  ];
  if (process.platform === 'win32') {
    for (const sys of systemFolders) {
      if (sys && folderInside(folder, sys)) return `this is a Windows system folder (${path.resolve(sys)})`;
    }
    if (sameFolder(folder, `${systemDrive}\\`)) return `this is the whole ${systemDrive} drive, which holds Windows itself. Choose a folder on it instead`;
  }
  const home = os.homedir();
  if (home && sameFolder(folder, home)) return 'this is your whole user folder, which holds the settings and sign-ins of every app. Choose a folder inside it, such as Documents';
  return null;
}
