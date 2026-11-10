/**
 * Durable Desktop host preferences (non-secret) under the Desktop data dir.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DesktopHostPreferences {
  /** Explained that closing the window keeps reminders running in the tray. */
  firstCloseExplained: boolean;
  /** Start Jarvis when the user signs in to Windows. */
  openAtLogin: boolean;
  /** Last known wake enabled preference for tray restore. */
  wakeEnabled: boolean;
  wakeMuted: boolean;
  /** Spoken-reply engine. Piper stays the default until Pocket TTS is promoted. */
  ttsEngine: 'piper' | 'pocket';
  /** Which renderer the window loads. `classic` stays the default; `v2` is the
   * Phase 2 React UI. `PANDESH_UI_V2=1|0` in the environment overrides it. */
  uiVariant: 'classic' | 'v2';
}

const DEFAULTS: DesktopHostPreferences = {
  firstCloseExplained: false,
  openAtLogin: false,
  wakeEnabled: false,
  wakeMuted: false,
  ttsEngine: 'piper',
  uiVariant: 'classic',
};

/** The renderer to load: the environment flag wins over the saved preference. */
export function resolveUiVariant(prefs: Pick<DesktopHostPreferences, 'uiVariant'>, env: NodeJS.ProcessEnv = process.env): 'classic' | 'v2' {
  const flag = env.PANDESH_UI_V2?.trim();
  if (flag === '1' || flag === 'true') return 'v2';
  if (flag === '0' || flag === 'false') return 'classic';
  return prefs.uiVariant === 'v2' ? 'v2' : 'classic';
}

/**
 * Whether this profile may write or delete the Windows sign-in entry. Only the real profile may: the entry is the
 * Run value named after Electron's default AppUserModelID ("electron.app.Electron", from the exe's ProductName), which
 * the installed app and every dev, test or scratch instance share. A test instance starts with "off" and applying it
 * deleted the installed app's start-at-login entry (found 2026-11-10 before an isolated v2 screenshot run).
 */
export function ownsLoginItem(dataDir: string, realDesktopDataDir: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(dataDir) === norm(realDesktopDataDir);
}

/** The Run value this app writes: Electron's default AppUserModelID, shared by every copy of the app (see ownsLoginItem). */
export const LOGIN_ITEM_NAME = 'electron.app.Electron';

/** The executable a Run value starts: the first token, quoted or not (unquoted paths may contain spaces before ".exe"). */
export function runValueExecutable(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    return end > 1 ? v.slice(1, end) : null;
  }
  const exe = /^(.+?\.exe)(?=\s|$)/i.exec(v);
  return exe ? exe[1] : v.split(/\s+/)[0];
}

/**
 * One HKCU Run value: its data, `null` when the value does not exist, or `undefined` when the Run key could not be read.
 * The whole key is listed, so "absent" never depends on the wording of reg.exe's (localised) error message.
 */
export function readRunValue(name: string, run: typeof execFileSync = execFileSync): string | null | undefined {
  if (process.platform !== 'win32') return null;
  let out: string;
  try {
    out = String(run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
  } catch {
    return undefined;
  }
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[2].trim();
  }
  return null;
}

/**
 * Whether this instance may write or delete the shared Run value. The profile check alone is not enough: a test that
 * points LOCALAPPDATA at a scratch folder makes its scratch profile look like the real one (the installer smoke does,
 * and deleted the installed app's entry on 2026-11-10). So an entry that starts a different Pandesh, which still exists,
 * is left alone. A missing entry, one that starts this executable, and one whose executable is gone may be written.
 */
export function mayChangeLoginItem(input: {
  ownsProfile: boolean;
  existingValue: string | null | undefined;
  execPath: string;
  exists: (file: string) => boolean;
}): { allowed: boolean; reason: string } {
  if (!input.ownsProfile) return { allowed: false, reason: 'this profile is not the real desktop profile' };
  if (input.existingValue === undefined) return { allowed: false, reason: 'the existing entry could not be read' };
  if (input.existingValue === null) return { allowed: true, reason: 'there is no entry yet' };
  const exe = runValueExecutable(input.existingValue);
  if (!exe) return { allowed: false, reason: 'the existing entry names no program' };
  const norm = (p: string) => path.resolve(p).toLowerCase();
  if (norm(exe) === norm(input.execPath)) return { allowed: true, reason: 'the entry starts this program' };
  if (!input.exists(exe)) return { allowed: true, reason: 'the entry starts a program that no longer exists' };
  return { allowed: false, reason: `the entry starts another Pandesh (${exe})` };
}

export function hostPreferencesPath(dataDir: string): string {
  return path.join(dataDir, 'host-preferences.json');
}

export function readHostPreferences(dataDir: string): DesktopHostPreferences {
  const file = hostPreferencesPath(dataDir);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DesktopHostPreferences>;
    return {
      firstCloseExplained: Boolean(raw.firstCloseExplained),
      openAtLogin: Boolean(raw.openAtLogin),
      wakeEnabled: Boolean(raw.wakeEnabled),
      wakeMuted: Boolean(raw.wakeMuted),
      ttsEngine: raw.ttsEngine === 'pocket' ? 'pocket' : 'piper',
      uiVariant: raw.uiVariant === 'v2' ? 'v2' : 'classic',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeHostPreferences(dataDir: string, patch: Partial<DesktopHostPreferences>): DesktopHostPreferences {
  const next = { ...readHostPreferences(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(hostPreferencesPath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
