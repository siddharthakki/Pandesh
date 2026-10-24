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
}

const DEFAULTS: DesktopHostPreferences = {
  firstCloseExplained: false,
  openAtLogin: false,
  wakeEnabled: false,
  wakeMuted: false,
};

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
