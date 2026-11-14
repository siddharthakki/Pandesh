/**
 * A test copy of Pandesh says what it is and cannot hold a Google account (tracker item 23, 2026-11-12): a micro-test
 * copy that looked exactly like production got Gmail and Calendar connected by a click in its window, and real mail
 * reached test evidence.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { googleConnectRefusal, isTestProfile, TEST_PROFILE_GOOGLE_ENV, windowTitleForProfile } from '../src/host/desktopHostPreferences';

describe('test-copy guard', () => {
  const real = 'C:\\Users\\someone\\AppData\\Local\\KarkeDikha\\desktop';
  const test = 'D:\\PandeshMicrotests\\profile-fix';

  it('names a test copy in its window title and leaves the real one alone', () => {
    expect(isTestProfile(real, real)).toBe(false);
    expect(windowTitleForProfile(real, real)).toBe('Pandesh');
    expect(isTestProfile(test, real)).toBe(true);
    expect(windowTitleForProfile(test, real)).toMatch(/^Pandesh — TEST COPY \(profile-fix\) — not your real Pandesh$/);
  });

  it('refuses Google in a test copy unless the person starting it opted in', () => {
    expect(googleConnectRefusal(real, real, {})).toBeNull();
    expect(googleConnectRefusal(test, real, {})).toMatch(/test copy of Pandesh .* cannot be connected to a Google account/);
    expect(googleConnectRefusal(test, real, { [TEST_PROFILE_GOOGLE_ENV]: '1' })).toBeNull();
    expect(googleConnectRefusal(test, real, { [TEST_PROFILE_GOOGLE_ENV]: 'true' })).not.toBeNull();
  });

  it('main.ts checks the guard before Google sign-in starts, logs every connection and keeps the test title', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    const handler = main.slice(main.indexOf('ipcMain.handle(DESKTOP_CHANNELS.connectGmail'), main.indexOf('ipcMain.handle(DESKTOP_CHANNELS.disconnectGmail'));
    expect(handler.indexOf('googleConnectRefusal(')).toBeGreaterThan(-1);
    expect(handler.indexOf('googleConnectRefusal(')).toBeLessThan(handler.indexOf('session.connectGmail()'));
    expect(handler).toContain("hostLog(`Google connect started");
    expect(main).toContain("window.on('page-title-updated', (event) => event.preventDefault())");
    // The gmail.modify consent follows the same rule, and the OAuth-client removal is logged too.
    const inbox = main.slice(main.indexOf('ipcMain.handle(DESKTOP_CHANNELS.allowInboxOrganization'), main.indexOf('ipcMain.handle(DESKTOP_CHANNELS.saveGoogleOAuthClient'));
    expect(inbox.indexOf('googleConnectRefusal(')).toBeGreaterThan(-1);
    expect(inbox.indexOf('googleConnectRefusal(')).toBeLessThan(inbox.indexOf('session.allowInboxOrganization()'));
    const clear = main.slice(main.indexOf('ipcMain.handle(DESKTOP_CHANNELS.clearGoogleOAuthClient'));
    expect(clear.slice(0, 400)).toContain("hostLog('Google OAuth client removed");
  });
});

describe('real-profile detection cannot be redirected by the environment', () => {
  it('uses the OS profile folder, so a LOCALAPPDATA-redirected copy is still a test copy', async () => {
    const { realDesktopDataDirFromOs } = await import('../src/host/desktopHostPreferences');
    const saved = process.env.LOCALAPPDATA; const savedProfile = process.env.USERPROFILE;
    try {
      process.env.LOCALAPPDATA = 'D:\PandeshMicrotests\fake-localappdata'; process.env.USERPROFILE = 'D:\PandeshMicrotests\fake-home';
      const real = realDesktopDataDirFromOs();
      expect(real.toLowerCase()).not.toContain('fake-');
      const redirectedProfile = path.join(process.env.LOCALAPPDATA, 'KarkeDikha', 'desktop');
      expect(isTestProfile(redirectedProfile, real)).toBe(true);
      expect(googleConnectRefusal(redirectedProfile, real, {})).toMatch(/test copy/);
    } finally { if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved; if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile; }
  });
  it('main.ts decides test-vs-real from the OS profile, never from LOCALAPPDATA', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).not.toMatch(/(ownsLoginItem|isTestProfile|googleConnectRefusal|windowTitleForProfile)\([^)]*defaultDesktopDataDir\(\)/);
  });
});
