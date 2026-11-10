/**
 * "Where is <app>?" (Build 161 voice test: the model asked the user where to look). Pandesh now reads what Windows
 * lists as installed, and when an app is not listed it proposes ONE consented search of the fixed drives for
 * <name>.exe instead of asking the user where to look.
 */
import { describe, expect, it, vi } from 'vitest';
import { exeNameFor, findInstalledApp, formatInstalledAppLookup, installedAppScript, validAppQuery } from '../runtime/installedAppLookup';
import { groupsForText, groupOfTool } from '../runtime/chatToolSelection';

const ok = (output: unknown) => vi.fn(async (_script: string) => ({ succeeded: true, exitCode: 0, output: JSON.stringify(output) }));

describe('find_installed_app', () => {
  it('accepts an app name only, never a pattern, a path or a command', () => {
    expect(validAppQuery('LM Studio')).toBe('LM Studio');
    expect(validAppQuery('obsidian.exe')).toBe('obsidian');
    expect(validAppQuery('Notepad++')).toBe('Notepad++');
    for (const bad of ['', 'x', '*', 'C:\\Tools\\app', "a'; Remove-Item C:\\ -Recurse #", 'app$(calc)', 'a'.repeat(61), 42, null]) {
      expect(validAppQuery(bad), String(bad)).toBeNull();
    }
    expect(exeNameFor('LM Studio')).toBe('LM Studio.exe');
  });

  it('places the name in the script as a quoted string compared as text', () => {
    const script = installedAppScript("O'Neil Tool");
    expect(script).toContain("$q = 'O''Neil Tool'");
    expect(script).toContain('IndexOf($q, [System.StringComparison]::OrdinalIgnoreCase)');
    expect(script).not.toMatch(/Remove-Item|Set-ItemProperty|New-Item|Start-Process|Invoke-WebRequest/);
  });

  it('reports where Windows lists the app, from each source once', async () => {
    const runScript = ok({
      matches: [
        { source: 'installed_programs', name: 'Example Notes', path: 'C:\\Program Files\\Example Notes', version: '1.4.2', publisher: 'Example Ltd' },
        { source: 'installed_programs', name: 'Example Notes', path: 'C:\\Program Files\\Example Notes', version: '1.4.2', publisher: 'Example Ltd' },
        { source: 'start_menu', name: 'Example Notes', path: 'C:\\Program Files\\Example Notes\\Example Notes.exe' },
        { source: 'bogus', name: 'x', path: 'y' },
      ],
      fixedDrives: ['C:\\', 'D:\\'],
    });
    const found = await findInstalledApp('Example Notes', { runScript });
    expect(found.matches).toHaveLength(2);
    const text = formatInstalledAppLookup(found);
    expect(text).toContain('- Example Notes 1.4.2: C:\\Program Files\\Example Notes [installed programs]');
    expect(text).toContain('[Start menu shortcut]');
    expect(text).not.toMatch(/request_search_permission/);
  });

  it('when Windows does not list it, proposes one consented search of the fixed drives for <name>.exe', async () => {
    const found = await findInstalledApp('PortableTool', { runScript: ok({ matches: [], fixedDrives: ['C:\\', 'D:\\', 'E:'] }) });
    expect(found.fixedDrives).toEqual(['C:\\', 'D:\\', 'E:\\']);
    const text = formatInstalledAppLookup(found);
    expect(text).toMatch(/is not listed among the installed apps/);
    expect(text).toContain('propose ONE search of the fixed drives (C:\\, D:\\, E:\\) for "PortableTool.exe"');
    expect(text).toContain('request_search_permission with proposedRoots ["C:\\\\","D:\\\\","E:\\\\"]');
    expect(text).toContain('search_files with query "PortableTool.exe"');
    expect(text).toContain('Do not ask the user where to look.');
  });

  it('fails as not available when Windows does not answer', async () => {
    const runScript = vi.fn(async () => ({ succeeded: false, exitCode: 1, output: 'access denied' }));
    await expect(findInstalledApp('Example', { runScript })).rejects.toThrow('access denied');
  });

  it('is offered for "where is <app>" questions', () => {
    expect(groupOfTool('find_installed_app')).toBe('pc');
    for (const q of ['Where is Obsidian?', 'Pandesh, where is LM Studio', "where's the Ollaya app", 'is obsidian installed?', 'find vlc.exe for me']) {
      expect(groupsForText(q).has('pc'), q).toBe(true);
    }
    expect(groupsForText('can you find the notes app on this laptop').has('pc')).toBe(true);
    expect(groupsForText('where is the invoice from the plumber that I got in March').has('pc')).toBe(false);
    expect(groupsForText('write a small program that adds two numbers').has('pc')).toBe(false);
    expect(groupsForText('build me a todo app in React').has('pc')).toBe(false);
  });
});
