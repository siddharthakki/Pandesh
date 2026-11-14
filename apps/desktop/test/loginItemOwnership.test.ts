/**
 * The Windows sign-in entry belongs to the real desktop profile only.
 *
 * Electron names the Run value after its default AppUserModelID, "electron.app.Electron" (from the exe's
 * ProductName), and the installed app and every dev, test or scratch instance share that exe metadata. A fresh test
 * profile starts with start-at-login off, and applying "off" at startup deleted the installed app's entry. A test
 * profile now keeps its own preference and leaves the Windows entry alone.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ownsLoginItem } from '../src/host/desktopHostPreferences';

describe('Windows start-at-login ownership', () => {
  const real = 'C:\\Users\\someone\\AppData\\Local\\KarkeDikha\\desktop';

  it('only the real profile owns it, whatever the spelling of the same folder', () => {
    expect(ownsLoginItem(real, real)).toBe(true);
    expect(ownsLoginItem('c:\\users\\someone\\appdata\\local\\karkedikha\\desktop\\', real)).toBe(true);
    expect(ownsLoginItem('C:\\Users\\someone\\AppData\\Local\\Temp\\pandesh-test-profile', real)).toBe(false);
    expect(ownsLoginItem('D:\\scratch\\KarkeDikha\\desktop', real)).toBe(false);
  });

  it('main.ts checks ownership before it writes or deletes the Windows entry', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    const fn = main.slice(main.indexOf('function applyOpenAtLogin('), main.indexOf('app.setLoginItemSettings('));
    expect(fn).toContain('if (!ownsLoginItem(dataDir, realDesktopDataDirFromOs()))');
    expect(fn).toMatch(/return;\s*\}\s*try \{\s*$/);
    expect(main.match(/app\.setLoginItemSettings\(/g)).toHaveLength(1);
  });
});
