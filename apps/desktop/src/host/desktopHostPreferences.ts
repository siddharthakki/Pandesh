/**
 * Durable Desktop host preferences (non-secret) under the Desktop data dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
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
  /** Who can reach Pandesh Mobile: nobody ('off'), the home network and Tailscale ('lan', the default), or only the
   * local `tailscale serve` proxy ('tailscale': the server listens on 127.0.0.1). */
  mobileAccess: 'off' | 'lan' | 'tailscale';
}

const DEFAULTS: DesktopHostPreferences = {
  firstCloseExplained: false,
  openAtLogin: false,
  wakeEnabled: false,
  wakeMuted: false,
  ttsEngine: 'piper',
  uiVariant: 'classic',
  mobileAccess: 'lan',
};

/** The renderer to load: the environment flag wins over the saved preference. */
export function resolveUiVariant(prefs: Pick<DesktopHostPreferences, 'uiVariant'>, env: NodeJS.ProcessEnv = process.env): 'classic' | 'v2' {
  const flag = env.PANDESH_UI_V2?.trim();
  if (flag === '1' || flag === 'true') return 'v2';
  if (flag === '0' || flag === 'false') return 'classic';
  return prefs.uiVariant === 'v2' ? 'v2' : 'classic';
}

/**
 * The real desktop profile, from the operating system's own record of the user's profile folder (os.userInfo), NOT from
 * LOCALAPPDATA or USERPROFILE. A test copy that redirected LOCALAPPDATA used to compute "the real profile" as its own
 * folder, so it was treated as the real Pandesh: no TEST COPY title, Google sign-in allowed, start-at-login entry
 * writable (audit 2026-11-12, step 0).
 */
export function realDesktopDataDirFromOs(): string {
  const home = os.userInfo().homedir;
  return process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'KarkeDikha', 'desktop')
    : path.join(home, '.local', 'share', 'karkedikha', 'desktop');
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

/**
 * A test, dev or scratch copy of Pandesh (any profile other than the real desktop profile).
 *
 * 2026-11-12 (tracker item 23): a micro-test copy that looked exactly like production got Gmail and Calendar connected
 * by a click in its window while production was in use, and real mail reached test evidence. A test copy now says what
 * it is in its title, and it cannot be connected to a Google account unless the person starting it opted in.
 */
export function isTestProfile(dataDir: string, realDesktopDataDir: string): boolean {
  return !ownsLoginItem(dataDir, realDesktopDataDir);
}

export function windowTitleForProfile(dataDir: string, realDesktopDataDir: string): string {
  return isTestProfile(dataDir, realDesktopDataDir) ? `Pandesh — TEST COPY (${path.basename(path.resolve(dataDir))}) — not your real Pandesh` : 'Pandesh';
}

export const TEST_PROFILE_GOOGLE_ENV = 'PANDESH_TEST_PROFILE_ALLOW_GOOGLE';

/** Why Google may not be connected in this profile, or null when it may. */
export function googleConnectRefusal(dataDir: string, realDesktopDataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isTestProfile(dataDir, realDesktopDataDir) || env[TEST_PROFILE_GOOGLE_ENV] === '1') return null;
  return `This window is a test copy of Pandesh (profile ${path.resolve(dataDir)}), not your real Pandesh, so it cannot be connected to a Google account. Connect Google in your real Pandesh instead.`;
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
      mobileAccess: raw.mobileAccess === 'off' || raw.mobileAccess === 'tailscale' ? raw.mobileAccess : 'lan',
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
