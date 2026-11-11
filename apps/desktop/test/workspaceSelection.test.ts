/**
 * Workspace folder selection with the person's access choice: the host's folder checks and memory, the detector for a
 * folder named in a chat message, the session that sends the choice to Core with every request, and the routing that
 * keeps workers that change files away from a read-only folder.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkWorkspaceFolder, clearWorkspaceRecord, folderInside, readRecentWorkspaces, readWorkspaceRecord, rememberWorkspace, writeWorkspaceRecord,
} from '../src/host/workspaceAccess';
import { findFolderMention, findFolderMentionWithin } from '../src/host/folderMention';
import { planDesktopInteraction, READ_ONLY_FOLDER_BLOCK } from '../src/host/desktopInteractionRouting';
import { AUTO_MODEL, DesktopSession } from '../src/host/desktopSession';
import { RENDERER_VISIBLE_KEYS } from '../src/ipc';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('the workspace record and recent folders', () => {
  it('keeps the folder with its access across restarts; a folder saved by an earlier build keeps full access', () => {
    const dataDir = tempDir('ws-record-');
    const folder = tempDir('ws-folder-');
    expect(readWorkspaceRecord(dataDir)).toBeNull();
    writeWorkspaceRecord(dataDir, { folder, access: 'read', grantedAt: '2026-11-11T09:00:00.000Z', source: 'chat' });
    expect(readWorkspaceRecord(dataDir)).toEqual({ folder: path.resolve(folder), access: 'read', grantedAt: '2026-11-11T09:00:00.000Z', source: 'chat' });
    // What Build 163 and older wrote: a folder and a time, no access.
    fs.writeFileSync(path.join(dataDir, 'last-workspace.json'), JSON.stringify({ folder, updatedAt: '2026-11-10T07:30:00.000Z' }));
    expect(readWorkspaceRecord(dataDir)).toMatchObject({ access: 'read_write', source: 'earlier_build', grantedAt: '2026-11-10T07:30:00.000Z' });
  });

  it('"Stop using this folder" removes both the current file and the one very old builds wrote', () => {
    const dataDir = tempDir('ws-clear-');
    fs.writeFileSync(path.join(dataDir, 'last-workspace.json'), JSON.stringify({ folder: dataDir }));
    fs.writeFileSync(path.join(dataDir, 'last-workspace.txt'), dataDir);
    clearWorkspaceRecord(dataDir);
    expect(fs.existsSync(path.join(dataDir, 'last-workspace.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'last-workspace.txt'))).toBe(false);
    expect(readWorkspaceRecord(dataDir)).toBeNull();
  });

  it('remembers the last six folders, newest first, each once, with the access last chosen', () => {
    const dataDir = tempDir('ws-recent-');
    for (let i = 0; i < 8; i += 1) rememberWorkspace(dataDir, `D:\\Work\\p${i}`, i % 2 ? 'read' : 'read_write', new Date(Date.UTC(2026, 10, 11, 9, i)));
    rememberWorkspace(dataDir, 'd:\\work\\P5\\', 'read_write', new Date(Date.UTC(2026, 10, 11, 10)));
    const recent = readRecentWorkspaces(dataDir);
    expect(recent).toHaveLength(6);
    expect(recent[0]).toMatchObject({ access: 'read_write' });
    expect(recent[0].folder.toLowerCase()).toBe(path.resolve('d:\\work\\P5').toLowerCase());
    expect(recent.filter((r) => r.folder.toLowerCase().endsWith('p5'))).toHaveLength(1);
    expect(recent.map((r) => path.basename(r.folder).toLowerCase())).toEqual(['p5', 'p7', 'p6', 'p4', 'p3', 'p2']);
  });
});

describe('which folders can be the workspace', () => {
  it('accepts an ordinary folder and says when Windows marks it read-only', () => {
    const dataDir = tempDir('ws-check-data-');
    const folder = tempDir('ws-check-ok-');
    expect(checkWorkspaceFolder(folder, { dataDir })).toMatchObject({ state: 'ok', readable: true, writable: true });
    expect(checkWorkspaceFolder(folder, { dataDir }).warning).toBeUndefined();
  });

  it('says plainly why a folder cannot be used: missing, a file, relative, or a network share', () => {
    const dataDir = tempDir('ws-check-data-');
    const folder = tempDir('ws-check-');
    const file = path.join(folder, 'notes.txt');
    fs.writeFileSync(file, 'x');
    expect(checkWorkspaceFolder(path.join(folder, 'nope'), { dataDir })).toMatchObject({ state: 'missing', reason: 'this folder does not exist on this PC' });
    expect(checkWorkspaceFolder(file, { dataDir })).toMatchObject({ state: 'not_a_folder' });
    expect(checkWorkspaceFolder('Projects\\Site', { dataDir }).state).toBe('missing');
    expect(checkWorkspaceFolder('\\\\server\\share\\docs', { dataDir })).toMatchObject({ state: 'refused' });
  });

  it('refuses Pandesh\'s own data folder, a folder that contains it, Windows system folders and the whole user folder', () => {
    const parent = tempDir('ws-check-parent-');
    const dataDir = path.join(parent, 'KarkeDikha', 'desktop');
    fs.mkdirSync(path.join(dataDir, 'workspace-activity'), { recursive: true });
    expect(checkWorkspaceFolder(dataDir, { dataDir }).reason).toMatch(/Pandesh's own data folder/);
    expect(checkWorkspaceFolder(path.join(dataDir, 'workspace-activity'), { dataDir }).state).toBe('refused');
    expect(checkWorkspaceFolder(parent, { dataDir }).reason).toMatch(/contains Pandesh's own data folder/);
    expect(checkWorkspaceFolder(os.homedir(), { dataDir }).state).toBe('refused');
    if (process.platform === 'win32') {
      const env = { ...process.env, SystemRoot: 'C:\\Windows', SystemDrive: 'C:' };
      expect(checkWorkspaceFolder('C:\\Windows\\System32', { dataDir, env }).reason).toMatch(/Windows system folder/);
      expect(checkWorkspaceFolder('C:\\', { dataDir, env }).state).toBe('refused');
      expect(checkWorkspaceFolder('C:\\', { dataDir: 'Z:\\PandeshData', env }).reason).toMatch(/whole C: drive/);
    }
  });

  it('a subfolder is inside its parent however it is spelled', () => {
    expect(folderInside('D:\\Projects\\Site\\src', 'd:/projects/site/')).toBe(true);
    expect(folderInside('D:\\Projects\\Site', 'D:\\Projects\\Site')).toBe(true);
    expect(folderInside('D:\\Projects\\Site2', 'D:\\Projects\\Site')).toBe(false);
  });
});

describe('a folder named in a chat message', () => {
  /** A fake disk: these folders exist, everything else does not; it counts every question. */
  function disk(folders: string[]) {
    const known = new Set(folders.map((f) => path.win32.resolve(f).toLowerCase()));
    const asked: string[] = [];
    const isDirectory = async (p: string) => { asked.push(p); return known.has(path.win32.resolve(p).toLowerCase()); };
    return { isDirectory, asked };
  }

  it('finds a full path in plain words, with spaces in folder names and sentence punctuation after it', async () => {
    const { isDirectory } = disk(['D:\\', 'D:\\My Projects', 'D:\\My Projects\\Site']);
    expect(await findFolderMention('check this folder D:\\My Projects\\Site and tell me what is in it', isDirectory)).toMatchObject({ folder: 'D:\\My Projects\\Site' });
    expect(await findFolderMention('Can you look at D:\\My Projects\\Site?', isDirectory)).toMatchObject({ folder: 'D:\\My Projects\\Site' });
    expect(await findFolderMention('use d:/my projects/site/, please', isDirectory)).toMatchObject({ folder: 'd:\\my projects\\site' });
  });

  it('takes a quoted path as written, and keeps a closing bracket that belongs to the name', async () => {
    const { isDirectory } = disk(['C:\\', 'C:\\Tools (x86)', 'C:\\Users\\me\\My Notes']);
    expect(await findFolderMention('what is in "C:\\Users\\me\\My Notes"', isDirectory)).toMatchObject({ folder: 'C:\\Users\\me\\My Notes' });
    expect(await findFolderMention('scan C:\\Tools (x86)', isDirectory)).toMatchObject({ folder: 'C:\\Tools (x86)' });
    expect(await findFolderMention('scan \u201CC:\\Users\\me\\My Notes\u201D now', isDirectory)).toMatchObject({ folder: 'C:\\Users\\me\\My Notes' });
  });

  it('asks nothing when no folder, a file, a missing folder or two different folders are named', async () => {
    const { isDirectory } = disk(['D:\\', 'D:\\A', 'D:\\B']);
    expect(await findFolderMention('check this folder', isDirectory)).toBeNull();
    expect(await findFolderMention('open D:\\A\\readme.txt', isDirectory)).toBeNull();
    expect(await findFolderMention('look at D:\\Nope', isDirectory)).toBeNull();
    expect(await findFolderMention('compare D:\\A with D:\\B', isDirectory)).toBeNull();
    expect(await findFolderMention('compare D:\\A with D:\\a\\', isDirectory)).toMatchObject({ folder: 'D:\\A' });
    expect(await findFolderMention('see https://example.com/D:/A and abc:\\x', isDirectory)).toBeNull();
  });

  it('asks the disk once about a drive that does not exist, and gives up within its time limit on a slow one', async () => {
    const fake = disk([]);
    expect(await findFolderMention('look at Q:\\a b c d e f g h i j k', fake.isDirectory)).toBeNull();
    expect(fake.asked).toEqual(['Q:\\']);
    const hang = () => new Promise<boolean>(() => undefined);
    const started = Date.now();
    expect(await findFolderMentionWithin('look at Z:\\Archive', 50, hang)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('finds a real folder on this PC', async () => {
    const folder = tempDir('ws-mention-real ');
    const inside = path.join(folder, 'Sub Folder');
    fs.mkdirSync(inside);
    expect(await findFolderMention(`please check this folder ${inside} for duplicates.`)).toMatchObject({ folder: inside });
  });
});

describe('routing with a read-only folder', () => {
  it('refuses the workers that exist to change files, and answers everything else on the read-only path', () => {
    for (const worker of ['autonomous-mission', 'opencode', 'hermes']) {
      expect(planDesktopInteraction({ hasFolder: true, workerId: worker, goalText: 'fix it', workspaceWritable: false })).toMatchObject({ blockReason: READ_ONLY_FOLDER_BLOCK, needsWorkspaceWrite: true });
    }
    expect(planDesktopInteraction({ hasFolder: true, workerId: 'local-core', goalText: 'make a list of the files in this folder', workspaceWritable: false })).toEqual({ mode: 'local_core', requestedMode: 'saath_kar' });
    expect(planDesktopInteraction({ hasFolder: true, workerId: 'local-core', goalText: 'create hello.py', workspaceWritable: true }).mode).toBe('mission');
    expect(planDesktopInteraction({ hasFolder: true, workerId: 'local-core', goalText: 'create hello.py' }).mode).toBe('mission');
  });
});

describe('DesktopSession: the workspace with the person\'s access choice', () => {
  function host(dataDir = tempDir('ws-session-data-')) {
    return { dataDir, session: new DesktopSession({ productRoot: process.cwd(), dataDir }) };
  }

  it('uses a folder read-only, shows it, and restores it read-only after a restart', () => {
    const { dataDir, session } = host();
    const folder = tempDir('ws-session-folder-');
    const snap = session.useWorkspace(folder, { read: true, write: false }, 'chat');
    expect(snap.folder).toBe(path.resolve(folder));
    expect(snap.workspace).toMatchObject({ folder: path.resolve(folder), access: 'read', source: 'chat' });
    expect(snap.recentWorkspaces?.[0]).toMatchObject({ folder: path.resolve(folder), access: 'read' });
    expect(RENDERER_VISIBLE_KEYS).toEqual(expect.arrayContaining(['workspace', 'recentWorkspaces']));
    const restarted = new DesktopSession({ productRoot: process.cwd(), dataDir });
    expect(restarted.restoreLastFolder()?.workspace).toMatchObject({ folder: path.resolve(folder), access: 'read', source: 'chat' });
  });

  it('needs Read, refuses Pandesh\'s own data folder, and changes access only for the next message', () => {
    const { dataDir, session } = host();
    const folder = tempDir('ws-session-folder-');
    expect(() => session.useWorkspace(folder, { read: false, write: true }, 'picker')).toThrow(/needs read access/);
    expect(() => session.useWorkspace(dataDir, { read: true, write: false }, 'picker')).toThrow(/own data folder/);
    expect(session.snapshot().workspace).toBeNull();
    session.useWorkspace(folder, { read: true, write: true }, 'picker');
    expect(session.setWorkspaceAccess('read').workspace?.access).toBe('read');
    expect(session.setWorkspaceAccess('read_write').workspace?.access).toBe('read_write');
  });

  it('keeps full access for a folder chosen by an earlier build, and "Stop using this folder" survives a restart', () => {
    const { dataDir, session } = host();
    const folder = tempDir('ws-session-legacy-');
    fs.writeFileSync(path.join(dataDir, 'last-workspace.json'), JSON.stringify({ folder, updatedAt: '2026-11-10T07:30:00.000Z' }));
    expect(session.restoreLastFolder()?.workspace).toMatchObject({ access: 'read_write', source: 'earlier_build' });
    session.clearFolder();
    const restarted = new DesktopSession({ productRoot: process.cwd(), dataDir });
    expect(restarted.restoreLastFolder()).toBeNull();
    expect(restarted.snapshot().folder).toBeNull();
  });

  it('asks about a named folder unless it is already the workspace or inside it', async () => {
    const { session } = host();
    const workspace = tempDir('ws-session-current-');
    const other = tempDir('ws-session-other-');
    fs.mkdirSync(path.join(workspace, 'src'));
    session.useWorkspace(workspace, { read: true, write: true }, 'picker');
    session.useWorkspace(other, { read: true, write: true }, 'picker');
    session.useWorkspace(workspace, { read: true, write: false }, 'picker');
    expect(await session.inspectFolderMention(`check ${path.join(workspace, 'src')}`)).toBeNull();
    expect(await session.inspectFolderMention(`check ${workspace}`)).toBeNull();
    const mention = await session.inspectFolderMention(`check this folder ${other} please`);
    expect(mention).toMatchObject({ folder: path.resolve(other), check: { state: 'ok' }, rememberedAccess: 'read_write' });
    expect(await session.inspectFolderMention('what is the weather in Ulm?')).toBeNull();
  });

  it('sends the access with every request, and a read-only folder never reaches a worker that changes files', async () => {
    const { session } = host();
    const repo = tempDir('ws-session-repo-');
    fs.mkdirSync(path.join(repo, '.git'));
    await session.selectModel(AUTO_MODEL);
    session.useWorkspace(repo, { read: true, write: false }, 'chat');
    const submitted: Array<Record<string, unknown>> = [];
    const adapter = session as unknown as {
      client: {
        createConversation(input: unknown): Promise<{ id: string }>;
        submit(input: Record<string, unknown>): Promise<{ request: { id: string }; attempt: { id: string }; modelSelection: { selectedModel: string } }>;
        executeAttempt(id: string, input: unknown): Promise<void>;
      };
      coreState: string;
      installedModels: string[];
      refreshInstalledModels(): Promise<string[]>;
      active: { terminal: boolean } | null;
    };
    adapter.coreState = 'connected';
    adapter.installedModels = ['stub:1b'];
    adapter.refreshInstalledModels = async () => adapter.installedModels;
    adapter.client = {
      createConversation: async () => ({ id: 'conv_ws' }),
      submit: async (input) => { submitted.push(input); return { request: { id: `req_${submitted.length}` }, attempt: { id: `att_${submitted.length}` }, modelSelection: { selectedModel: 'stub:1b' } }; },
      executeAttempt: async () => undefined,
    };
    await session.submitTask('create hello.py that prints hello', 'local-core');
    expect(submitted[0]).toMatchObject({ requestedMode: 'saath_kar', workspaceRoot: path.resolve(repo), toolPermissionPolicy: { workspaceAccess: 'read' } });
    // While that task runs, the folder and its access stay as they are.
    expect(session.isBusy()).toBe(true);
    expect(() => session.useWorkspace(repo, { read: true, write: true }, 'picker')).toThrow(/running task/);
    expect(() => session.setWorkspaceAccess('read_write')).toThrow(/running task/);
    adapter.active = null;
    await expect(session.submitTask('fix the failing test', 'autonomous-mission')).rejects.toThrow(/read-only for Pandesh/);
    expect(submitted).toHaveLength(1);
    session.setWorkspaceAccess('read_write');
    await session.submitTask('explain this repository', 'local-core');
    expect(submitted[1]).toMatchObject({ toolPermissionPolicy: { workspaceAccess: 'read_write' } });
  });
});
