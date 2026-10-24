import * as fs from 'node:fs';

const WINDOWS_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const POSIX_CANDIDATES = [
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

/**
 * Host-managed browser binary. Prefers `KARKEDIKHA_BROWSER_BIN` so a desktop
 * host can pin Edge/Chrome once per session instead of making each task
 * rediscover executables or npm-install a browser.
 */
export function resolveHostBrowserBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const explicit = env.KARKEDIKHA_BROWSER_BIN?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = platform === 'win32' ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
