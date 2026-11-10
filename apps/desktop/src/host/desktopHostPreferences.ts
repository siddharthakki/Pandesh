/**
 * Durable Desktop host preferences (non-secret) under the Desktop data dir.
 */
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
 * Whether this profile may write or delete the Windows sign-in entry. Only the real profile may: the entry is the
 * Run value named after Electron's default AppUserModelID ("electron.app.Electron", from the exe's ProductName), which
 * the installed app and every dev, test or scratch instance share. A test instance starts with "off" and applying it
 * deleted the installed app's start-at-login entry (found 2026-11-10 before an isolated v2 screenshot run).
 */
export function ownsLoginItem(dataDir: string, realDesktopDataDir: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(dataDir) === norm(realDesktopDataDir);
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
