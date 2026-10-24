import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readHostPreferences,
  writeHostPreferences,
  hostPreferencesPath,
} from '../src/host/desktopHostPreferences';

describe('desktop host preferences', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-prefs-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults and persists first-close / openAtLogin / wake flags', () => {
    expect(readHostPreferences(dir)).toEqual({
      firstCloseExplained: false,
      openAtLogin: false,
      wakeEnabled: false,
      wakeMuted: false,
    });
    const next = writeHostPreferences(dir, {
      firstCloseExplained: true,
      openAtLogin: true,
      wakeEnabled: true,
    });
    expect(next.firstCloseExplained).toBe(true);
    expect(next.openAtLogin).toBe(true);
    expect(next.wakeEnabled).toBe(true);
    expect(fs.existsSync(hostPreferencesPath(dir))).toBe(true);
    expect(readHostPreferences(dir).openAtLogin).toBe(true);
  });
});

describe('background operation honesty', () => {
  it('documents tray vs quit vs asleep in session alert policy text', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/host/desktopSession.ts'),
      'utf8',
    );
    expect(src).toMatch(/window visible or hidden in the tray/);
    expect(src).toMatch(/do not fire after Quit/);
    expect(src).toMatch(/computer is asleep/);
  });

  it('main process hides to tray instead of quitting on close', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    const tray = fs.readFileSync(path.join(__dirname, '../src/host/jarvisTray.ts'), 'utf8');
    expect(main).toContain('requestSingleInstanceLock');
    expect(main).toContain('hideJarvisToTray');
    expect(main).toContain('backgroundThrottling: false');
    expect(main).toContain('powerMonitor');
    expect(main).toMatch(/Quit (?:KarkeDikha|Jarvis|Pandesh)/);
    expect(main).toContain('reconcileRemindersAfterResume');
    expect(main).toContain('showDesktopQueueConfirmNotification');
    expect(main).toContain('confirmCommandRun');
    expect(tray).toMatch(/Start (?:KarkeDikha|Jarvis) when I sign in/);
  });

  it('re-runs task rehydration when a tray-hidden window is reopened, not only at boot', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    const showFn = main.slice(main.indexOf('function showJarvisWindow'), main.indexOf('function hideJarvisToTray'));
    expect(showFn).toContain('restoreActiveTask');
  });

  it('tray menu provides Open JARVIS, Mobile Server status, and Quit', () => {
    const tray = fs.readFileSync(path.join(__dirname, '../src/host/jarvisTray.ts'), 'utf8');
    expect(tray).toContain('Open JARVIS');
    expect(tray).toContain('Mobile Server');
    expect(tray).toContain('Quit');
    expect(tray).toContain('isAvailable');
  });

  it('quit and fallback teardown stop mobile server, dispose IPC, close windows, and exit process', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('shutdownAndQuit');
    expect(main).toContain('mobileServer.stop()');
    expect(main).toContain('ipcMain.removeAllListeners()');
    expect(main).toContain('Tray mode unavailable — window close terminates the app');
    expect(main).toMatch(/another (Pandesh|KarkeDikha\/JARVIS) instance holds the lock; exiting immediately/);
  });
});

