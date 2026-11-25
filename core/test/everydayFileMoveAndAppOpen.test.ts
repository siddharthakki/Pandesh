import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeFileMove, performFileMove, planFileMove } from '../runtime/fileMove';
import { builtinApp, launchApp, neverOpened, resolveAppTarget } from '../runtime/appLaunch';
import type { InstalledAppLookup } from '../runtime/installedAppLookup';
import { readOnlyWorkspaceRefusal } from '../domain/permissionModes';
import { BASE_TOOLS } from '../runtime/chatToolSelection';
import { CONSEQUENTIAL_PI_TOOLS } from '../runtime/turnOutcome';
import { deliverableLedger, namedOutputFiles } from '../runtime/deliverableLedger';

// Everyday tasks, 2026-11-24: "Rename draft.txt to final.txt" and "Open Notepad" had no tool. The rename left a junk
// final.txt behind; the app request was answered with "I cannot open applications".

describe('move_file: rename or move one file inside the selected folder', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-move-'));
    fs.writeFileSync(path.join(root, 'draft.txt'), 'the real draft\n');
    fs.writeFileSync(path.join(root, 'other.txt'), 'something else\n');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('renames in place and leaves the contents alone', () => {
    const plan = planFileMove({ from: 'draft.txt', to: 'final.txt', workspaceRoot: root });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.kind).toBe('rename');
    expect(describeFileMove(plan)).toBe('rename draft.txt to final.txt');
    expect(performFileMove(plan)).toEqual({ ok: true, bytes: 15 });
    expect(fs.existsSync(path.join(root, 'draft.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'final.txt'), 'utf8')).toBe('the real draft\n');
  });

  it('accepts the absolute path the person typed', () => {
    const plan = planFileMove({ from: path.join(root, 'draft.txt'), to: 'final.txt', workspaceRoot: root });
    expect(plan.ok && plan.relTo).toBe('final.txt');
  });

  it('never overwrites an existing file', () => {
    const plan = planFileMove({ from: 'draft.txt', to: 'other.txt', workspaceRoot: root });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toBe('destination exists');
    expect(fs.readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('something else\n');
  });

  it('refuses when the destination appears after the plan was made', () => {
    const plan = planFileMove({ from: 'draft.txt', to: 'final.txt', workspaceRoot: root });
    fs.writeFileSync(path.join(root, 'final.txt'), 'someone else wrote this');
    expect(plan.ok && performFileMove(plan).ok).toBe(false);
    expect(fs.readFileSync(path.join(root, 'final.txt'), 'utf8')).toBe('someone else wrote this');
    expect(fs.existsSync(path.join(root, 'draft.txt'))).toBe(true);
  });

  it('moves into a subfolder, creating it, and into an existing folder keeping the name', () => {
    const plan = planFileMove({ from: 'draft.txt', to: 'archive/2026/draft-old.txt', workspaceRoot: root });
    expect(plan.ok && plan.kind).toBe('move');
    expect(plan.ok && plan.createsFolder).toBe(true);
    expect(plan.ok && performFileMove(plan).ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'archive', '2026', 'draft-old.txt'))).toBe(true);
    const second = planFileMove({ from: 'other.txt', to: 'archive', workspaceRoot: root });
    expect(second.ok && second.relTo).toBe('archive/other.txt');
  });

  it('stays inside the selected folder, in both directions', () => {
    expect(planFileMove({ from: '../outside.txt', to: 'x.txt', workspaceRoot: root })).toMatchObject({ ok: false, reason: 'source outside the selected folder' });
    expect(planFileMove({ from: 'draft.txt', to: '../x.txt', workspaceRoot: root })).toMatchObject({ ok: false, reason: 'destination outside the selected folder' });
    expect(planFileMove({ from: 'draft.txt', to: path.join(os.tmpdir(), 'x.txt'), workspaceRoot: root })).toMatchObject({ ok: false, reason: 'destination outside the selected folder' });
    expect(planFileMove({ from: 'draft.txt', to: 'final.txt', workspaceRoot: null })).toMatchObject({ ok: false, reason: 'no folder selected' });
  });

  it('refuses a missing file, a folder and an invalid name, and says nothing was changed', () => {
    fs.mkdirSync(path.join(root, 'sub'));
    const missing = planFileMove({ from: 'nope.txt', to: 'final.txt', workspaceRoot: root });
    expect(missing).toMatchObject({ ok: false, reason: 'source does not exist' });
    expect(!missing.ok && missing.text).toMatch(/^NOT MOVED: .*Nothing was changed\.$/);
    expect(planFileMove({ from: 'sub', to: 'sub2', workspaceRoot: root })).toMatchObject({ ok: false, reason: 'source is a folder' });
    expect(planFileMove({ from: 'draft.txt', to: 'fi:nal?.txt', workspaceRoot: root })).toMatchObject({ ok: false, reason: 'invalid file name' });
    expect(planFileMove({ from: 'draft.txt', to: 'draft.txt', workspaceRoot: root })).toMatchObject({ ok: false, reason: 'already has this name' });
  });

  it('a rename is not a request for a new file, and a file moved into place counts as there', () => {
    // "draft" in draft.txt was read as the verb "draft", so final.txt became an expected NEW file: a correct rename was
    // reported "Missing: final.txt" and the model was told to create it with write_file.
    expect(namedOutputFiles('Rename D:\\PandeshP0Dev\\daily\\sandbox\\draft.txt to final.txt.')).toEqual([]);
    expect(namedOutputFiles('Rename draft.txt to final.txt.')).toEqual([]);
    expect(namedOutputFiles('Draft a reply and save it to reply.txt.')).toEqual(['reply.txt']);
    expect(namedOutputFiles('Create summary.md from notes.txt.')).toEqual(['summary.md']);
    const plan = planFileMove({ from: 'draft.txt', to: 'final.txt', workspaceRoot: root });
    expect(plan.ok && performFileMove(plan).ok).toBe(true);
    const moved = path.join(root, 'final.txt');
    const asked = 'Make a copy of the notes, then save it as final.txt.';
    expect(deliverableLedger({ requestText: asked, workspace: root, writtenFiles: [], turnStartMs: Date.now() + 60_000 }).missing).toEqual(['final.txt']);
    expect(deliverableLedger({ requestText: asked, workspace: root, writtenFiles: [moved], unchangedFiles: [moved], turnStartMs: Date.now() + 60_000 }).missing).toEqual([]);
  });

  it('is a workspace change: a read-only folder refuses it, and it is always offered', () => {
    expect(readOnlyWorkspaceRefusal('move_file', { from: 'a', to: 'b' }, root)).toMatch(/^Read-only folder/);
    expect(readOnlyWorkspaceRefusal('open_app', { name: 'Notepad' }, root)).toBeNull();
    expect(BASE_TOOLS.has('move_file') && BASE_TOOLS.has('open_app')).toBe(true);
    expect(CONSEQUENTIAL_PI_TOOLS.has('move_file') && CONSEQUENTIAL_PI_TOOLS.has('open_app')).toBe(true);
  });
});

describe('open_app: which program a name means', () => {
  const lookup = (matches: InstalledAppLookup['matches']): InstalledAppLookup => ({ query: 'x', matches, fixedDrives: ['C:\\'] });
  const exists = () => true;

  it("knows Windows' own everyday apps without a lookup", () => {
    expect(resolveAppTarget('Notepad', null)).toMatchObject({ ok: true, builtin: true, name: 'Notepad', start: 'notepad.exe' });
    expect(resolveAppTarget('the notepad app', null)).toMatchObject({ ok: true, builtin: true, name: 'Notepad' });
    expect(resolveAppTarget('calc.exe', null)).toMatchObject({ ok: true, builtin: true, name: 'Calculator', process: 'CalculatorApp.exe' });
    expect(builtinApp('Windows Explorer')?.label).toBe('File Explorer');
  });

  it('never opens shells, script hosts, installers or system tools, by name or by file', () => {
    for (const name of ['cmd', 'PowerShell', 'Windows Terminal', 'regedit', 'python', 'wscript.exe', 'msiexec']) {
      expect(neverOpened(name)).toBe(true);
      expect(resolveAppTarget(name, lookup([{ source: 'path', name: `${name}.exe`, path: `C:\\Windows\\System32\\${name}.exe` }]), exists)).toMatchObject({ ok: false, reason: 'not an app Pandesh opens' });
    }
    const onlyUninstaller = resolveAppTarget('Obsidian', lookup([{ source: 'start_menu', name: 'Uninstall Obsidian', path: 'C:\\Apps\\Obsidian\\Uninstall Obsidian.exe' }]), exists);
    expect(onlyUninstaller).toMatchObject({ ok: false, reason: 'no program file found' });
    const hidden = resolveAppTarget('helper', lookup([{ source: 'start_menu', name: 'helper', path: 'C:\\Windows\\System32\\cmd.exe' }]), exists);
    expect(hidden).toMatchObject({ ok: false, reason: 'no program file found' });
  });

  it('opens the one program Windows lists under that name', () => {
    const target = resolveAppTarget('Obsidian', lookup([
      { source: 'installed_programs', name: 'Obsidian', path: 'C:\\Apps\\Obsidian' },
      { source: 'start_menu', name: 'Obsidian', path: 'C:\\Apps\\Obsidian\\Obsidian.exe' },
      { source: 'app_paths', name: 'Obsidian.exe', path: '"C:\\Apps\\Obsidian\\Obsidian.exe"' },
    ]), exists);
    expect(target).toMatchObject({ ok: true, builtin: false, name: 'Obsidian', file: 'C:\\Apps\\Obsidian\\Obsidian.exe', process: 'Obsidian.exe' });
  });

  it('prefers the exact name, and asks instead of guessing between two programs', () => {
    const matches: InstalledAppLookup['matches'] = [
      { source: 'start_menu', name: 'LM Studio', path: 'C:\\Apps\\LM Studio\\LM Studio.exe' },
      { source: 'start_menu', name: 'LM Studio Helper', path: 'C:\\Apps\\LM Studio\\helper.exe' },
    ];
    expect(resolveAppTarget('LM Studio', lookup(matches), exists)).toMatchObject({ ok: true, file: 'C:\\Apps\\LM Studio\\LM Studio.exe' });
    const vague = resolveAppTarget('LM', lookup(matches), exists);
    expect(vague).toMatchObject({ ok: false, reason: 'more than one program matches' });
    expect(!vague.ok && vague.text).toContain('Ask the user which one');
  });

  it('says so when Windows lists nothing it can start, or the file is gone', () => {
    expect(resolveAppTarget('Frobnicator', lookup([]), exists)).toMatchObject({ ok: false, reason: 'no program file found' });
    expect(resolveAppTarget('Photos', lookup([{ source: 'store_app', name: 'Microsoft.Windows.Photos', path: 'C:\\Program Files\\WindowsApps\\Photos' }]), exists)).toMatchObject({ ok: false, reason: 'no program file found' });
    expect(resolveAppTarget('Gone', lookup([{ source: 'start_menu', name: 'Gone', path: 'C:\\Apps\\Gone.exe' }]), () => false)).toMatchObject({ ok: false, reason: 'no program file found' });
  });
});

describe('open_app: "opened" is only said after Windows shows the process', () => {
  const notepad = { ok: true as const, builtin: true as const, name: 'Notepad', start: 'notepad.exe', process: 'notepad.exe' };

  it('reports opened when a new process appears', async () => {
    let started = 0;
    const result = await launchApp(notepad, { start: () => { started += 1; }, count: async () => (started ? 1 : 0), waitMs: 50 });
    expect(started).toBe(1);
    expect(result).toMatchObject({ opened: true, verified: true, before: 0, after: 1 });
    expect(result.text).toMatch(/^Opened Notepad .*checked/);
  });

  it('reports NOT OPENED when nothing appears', async () => {
    const result = await launchApp(notepad, { start: () => {}, count: async () => 0, waitMs: 30 });
    expect(result).toMatchObject({ opened: false, verified: false });
    expect(result.text).toMatch(/^NOT OPENED: .*Do not say it is open/);
  });

  it('says "already running" when it was, and "asked" when the process cannot be counted', async () => {
    const running = await launchApp(notepad, { start: () => {}, count: async () => 2, waitMs: 30 });
    expect(running).toMatchObject({ opened: true, verified: true });
    expect(running.text).toContain('already running');
    const explorer = await launchApp({ ok: true, builtin: true, name: 'File Explorer', start: 'explorer.exe', process: null }, { start: () => {}, count: async () => 5, waitMs: 30 });
    expect(explorer).toMatchObject({ opened: true, verified: false });
    expect(explorer.text).toContain('not that it is open');
  });

  it('reports NOT OPENED when Windows refuses to start it', async () => {
    const result = await launchApp(notepad, { start: () => { throw new Error('access denied'); }, count: async () => 0, waitMs: 30 });
    expect(result.opened).toBe(false);
    expect(result.text).toContain('access denied');
  });
});
