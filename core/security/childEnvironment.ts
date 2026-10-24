/**
 * M54-A0 Authoritative Child Environment Scrubber.
 *
 * Implements an explicit ALLOWLIST of environment variables required
 * for compilers, runtime engines, and system toolchains.
 * Under NO circumstances may parent process credentials, tokens, or
 * secrets leak into child process environments.
 */

const ALLOWED_ENV_VAR_KEYS = new Set([
  // Windows System & Paths
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'DriverData',
  'PUBLIC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'NUMBER_OF_PROCESSORS',

  // POSIX / Cross-platform standard
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',

  // Toolchain runtime identifiers (without auth)
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'npm_config_user_agent',
  'GIT_EXEC_PATH',
  'GIT_PAGER',
]);

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|key|auth|credential|bearer|session|oauth|google|gh_|github_|karkedikha)/i;

const ALLOWED_ENV_VAR_KEYS_LOWER = new Set(
  Array.from(ALLOWED_ENV_VAR_KEYS).map((k) => k.toLowerCase()),
);

export function isEnvironmentKeyPermitted(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) {
    return false;
  }
  return ALLOWED_ENV_VAR_KEYS.has(key) || ALLOWED_ENV_VAR_KEYS_LOWER.has(key.toLowerCase());
}

export function createSanitizedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isEnvironmentKeyPermitted(key)) {
      env[key] = value;
    }
  }

  // Apply explicit overrides, ensuring none violate secret policy
  for (const [key, value] of Object.entries(overrides)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      continue; // Refuse to inject secret keys even via overrides
    }
    env[key] = value;
  }

  return env;
}
