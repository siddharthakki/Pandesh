/**
 * The Windows sign-in entry belongs to the installed app only.
 *
 * Electron names the Run value after its default AppUserModelID, "electron.app.Electron" (from the exe's
 * ProductName), and the installed app and every dev, test or scratch instance share that exe metadata. A fresh test
 * profile starts with start-at-login off, and applying "off" at startup deleted the installed app's entry. A test
 * profile now keeps its own preference and leaves the Windows entry alone.
 *
 * The profile check alone was not enough: the installer smoke points LOCALAPPDATA at a scratch folder, so its scratch
 * profile looked like the real one, and the Build 162 smoke run deleted the installed app's entry (2026-11-10). An entry
 * that starts a different Pandesh that still exists is now left alone too.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOGIN_ITEM_NAME, mayChangeLoginItem, ownsLoginItem, readRunValue, runValueExecutable } from '../src/host/desktopHostPreferences';

const installed = 'E:\\Pandesh\\electron\\Pandesh.exe';
const smokeCopy = 'C:\\Users\\someone\\AppData\\Local\\Temp\\karkedikha-installer-smoke-1\\install\\electron\\Pandesh.exe';
const installedEntry = `"${installed}" "E:\\Pandesh\\app"`;

describe('Windows start-at-login ownership', () => {
  const real = 'C:\\Users\\someone\\AppData\\Local\\KarkeDikha\\desktop';

  it('only the real profile owns it, whatever the spelling of the same folder', () => {
    expect(ownsLoginItem(real, real)).toBe(true);
    expect(ownsLoginItem('c:\\users\\someone\\appdata\\local\\karkedikha\\desktop\\', real)).toBe(true);
    expect(ownsLoginItem('C:\\Users\\someone\\AppData\\Local\\Temp\\pandesh-test-profile', real)).toBe(false);
    expect(ownsLoginItem('D:\\scratch\\KarkeDikha\\desktop', real)).toBe(false);
  });

  it('reads which program a Run value starts, quoted or not', () => {
    expect(runValueExecutable(installedEntry)).toBe(installed);
    expect(runValueExecutable('C:\\Program Files\\LM Studio\\LM Studio.exe --run-as-service')).toBe('C:\\Program Files\\LM Studio\\LM Studio.exe');
    expect(runValueExecutable('C:\\Tools\\tray.exe')).toBe('C:\\Tools\\tray.exe');
    expect(runValueExecutable('   ')).toBeNull();
    expect(runValueExecutable('"unterminated')).toBeNull();
  });

  it('reads one value from the listed Run key: present, absent, or unreadable', () => {
    if (process.platform !== 'win32') return;
    const listing = [
      '',
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '    electron.app.LM Studio    REG_SZ    C:\\Program Files\\LM Studio\\LM Studio.exe --run-as-service',
      `    ${LOGIN_ITEM_NAME}    REG_SZ    ${installedEntry}`,
      '    Docker Desktop    REG_EXPAND_SZ    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" -Autostart',
      '',
    ].join('\r\n');
    const calls: unknown[][] = [];
    const fakeReg = ((...args: unknown[]) => { calls.push(args); return listing; }) as never;
    expect(readRunValue(LOGIN_ITEM_NAME, fakeReg)).toBe(installedEntry);
    expect(readRunValue('Docker Desktop', fakeReg)).toBe('"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" -Autostart');
    expect(readRunValue('electron.app.Missing', fakeReg)).toBeNull();
    expect(calls[0][0]).toBe('reg');
    expect(calls[0][1]).toEqual(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
    const failingReg = (() => { throw new Error('reg.exe failed'); }) as never;
    expect(readRunValue(LOGIN_ITEM_NAME, failingReg)).toBeUndefined();
  });

  it('leaves an entry that starts another Pandesh alone, even when the profile looks like the real one', () => {
    const exists = (file: string) => file.toLowerCase() === installed.toLowerCase();
    // The installer smoke: its scratch profile matches the LOCALAPPDATA it set, but the entry starts the installed app.
    expect(mayChangeLoginItem({ ownsProfile: true, existingValue: installedEntry, execPath: smokeCopy, exists })).toEqual({
      allowed: false,
      reason: `the entry starts another Pandesh (${installed})`,
    });
    // The installed app itself, however the path is spelled.
    expect(mayChangeLoginItem({ ownsProfile: true, existingValue: installedEntry, execPath: 'e:\\pandesh\\electron\\PANDESH.exe', exists }).allowed).toBe(true);
    // No entry yet, or one left behind by a removed install: the real profile may write it.
    expect(mayChangeLoginItem({ ownsProfile: true, existingValue: null, execPath: installed, exists }).allowed).toBe(true);
    expect(mayChangeLoginItem({ ownsProfile: true, existingValue: '"D:\\Old\\electron\\Pandesh.exe" "D:\\Old\\app"', execPath: installed, exists }).allowed).toBe(true);
    // A scratch profile never may, and an unreadable Run key changes nothing.
    expect(mayChangeLoginItem({ ownsProfile: false, existingValue: null, execPath: installed, exists }).allowed).toBe(false);
    expect(mayChangeLoginItem({ ownsProfile: true, existingValue: undefined, execPath: installed, exists }).allowed).toBe(false);
    expect(mayChangeLoginItem({ ownsProfile: true, existingValue: '""', execPath: installed, exists }).allowed).toBe(false);
  });

  it('main.ts decides before it writes or deletes the Windows entry, and names the value it read', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    const fn = main.slice(main.indexOf('function applyOpenAtLogin('), main.indexOf('function showJarvisWindow('));
    const decide = fn.indexOf('mayChangeLoginItem({');
    const write = fn.indexOf('app.setLoginItemSettings(');
    expect(decide).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(decide);
    expect(fn).toContain('ownsProfile: ownsLoginItem(dataDir, defaultDesktopDataDir())');
    expect(fn).toContain('existingValue: readRunValue(LOGIN_ITEM_NAME)');
    expect(fn).toContain('execPath: process.execPath');
    expect(fn.slice(decide, write)).toMatch(/if \(!decision\.allowed\) \{[\s\S]*?return;\s*\}/);
    expect(fn.slice(write)).toContain('name: LOGIN_ITEM_NAME');
    expect(main.match(/app\.setLoginItemSettings\(/g)).toHaveLength(1);
  });
});
