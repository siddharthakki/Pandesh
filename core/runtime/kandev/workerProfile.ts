/**
 * Isolated profile for delegated workers (Claude Code, OpenCode, ...) launched by Kandev.
 *
 * scripts/kandev/start-kandev.ps1 starts Kandev with a clean, allow-listed environment whose HOME/USERPROFILE/APPDATA/
 * XDG_*\/CLAUDE_CONFIG_DIR point at `<kandev home>/worker-home`. This module fills that profile; it never points a
 * worker at the user's own agent profiles:
 * - Claude: its own config dir holding only the current OAuth *access token* (no refresh token, none of the user's
 *   MCP OAuth tokens, plugins, hooks, CLAUDE.md or auto-memory). The token is re-copied whenever the user's own
 *   Claude session refreshes it, so a worker can never rotate (and thereby invalidate) the user's login. Settings deny
 *   reads of the user's private directories.
 * - OpenCode v2: its own managed-service port. Without it `opencode acp` attaches to the user's personal OpenCode
 *   background service (127.0.0.1:49374) and runs inside the user's config, plugins (engram memory) and session DB.
 *   The worker config itself is scripts/kandev/opencode-worker.json (no plugins, no MCP, external dirs denied).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const OPENCODE_WORKER_SERVICE_PORT = 38621;

/** Commands a Claude worker may run without asking: run the project's own checks, read git. node is allowed because npm test already runs worker-written code in the same process environment. No installs, pushes, or shell escapes. */
export const CLAUDE_WORKER_ALLOW = [
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npm run typecheck:*)', 'Bash(npm run build:*)',
  'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(node:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git ls-files:*)', 'Bash(git grep:*)', 'Bash(git checkout -- :*)',
];

export function kandevHome(): string {
  return process.env.KARKEDIKHA_KANDEV_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kkd-kandev');
}

export function workerHome(): string {
  return path.join(kandevHome(), 'worker-home');
}

function realHome(): string {
  return process.env.USERPROFILE || process.env.HOME || '.';
}

/** Claude permission-rule form of an absolute Windows/POSIX path: //c/Users/x/... */
function rulePath(p: string): string {
  const posix = path.resolve(p).replace(/\\/g, '/');
  return '/' + posix.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
}

/** User-private locations a worker must not read or write, even when asked to. */
export function privatePaths(): string[] {
  const home = realHome();
  return [
    path.join(home, '.claude'), path.join(home, '.claude.json'), path.join(home, '.config'), path.join(home, '.local'),
    path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.gnupg'), path.join(home, '.npmrc'),
    path.join(home, '.gitconfig'), path.join(home, '.git-credentials'), path.join(home, '.engram'),
    path.join(home, 'AppData'), path.join(workerHome(), '.claude', '.credentials.json'),
    ...(process.env.KARKEDIKHA_KANDEV_PRIVATE_PATHS || '').split(';').filter(Boolean),
  ];
}

function writeIfChanged(file: string, content: string): boolean {
  try { if (fs.readFileSync(file, 'utf8') === content) return false; } catch { /* missing */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return true;
}

export interface ClaudeTokenState { present: boolean; expiresInMin: number | null }

/**
 * Copies only the Claude OAuth access token into the worker profile. Returns how long the worker's token is valid.
 * Never copies refreshToken or mcpOAuth.
 */
export function syncWorkerClaudeToken(): ClaudeTokenState {
  const realFile = path.join(process.env.CLAUDE_CONFIG_DIR_USER || path.join(realHome(), '.claude'), '.credentials.json');
  let oauth: Record<string, unknown> | undefined;
  try { oauth = JSON.parse(fs.readFileSync(realFile, 'utf8'))?.claudeAiOauth; } catch { return { present: false, expiresInMin: null }; }
  if (!oauth?.accessToken) return { present: false, expiresInMin: null };
  const scoped = {
    accessToken: oauth.accessToken, expiresAt: oauth.expiresAt, scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier,
  };
  writeIfChanged(path.join(workerHome(), '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: scoped }));
  const expiresAt = Number(oauth.expiresAt);
  return { present: true, expiresInMin: Number.isFinite(expiresAt) ? Math.round((expiresAt - Date.now()) / 60_000) : null };
}

/** Creates/refreshes the isolated worker profile. Idempotent; cheap enough to call on every reconcile tick. */
export function prepareWorkerProfile(): { home: string; claude: ClaudeTokenState } {
  const home = workerHome();
  const claudeDir = path.join(home, '.claude');
  const deny = privatePaths().flatMap(p => {
    const r = rulePath(p);
    return [`Read(${r})`, `Read(${r}/**)`, `Edit(${r})`, `Edit(${r}/**)`];
  });
  writeIfChanged(path.join(claudeDir, 'settings.json'), JSON.stringify({
    // Workers never drive Kandev itself (task state, dependencies, permissions); KKD does that.
    // Routine work is decided by Claude's own permission engine instead of a round trip to the KKD broker: `acceptEdits`
    // auto-approves file edits inside the session's working directory (the story's worktree) only, deny rules still win,
    // and the allow list is the project's check commands plus read-only git. Anything else still reaches the broker.
    permissions: { allow: CLAUDE_WORKER_ALLOW, deny: [...deny, 'mcp__kandev', 'WebFetch', 'WebSearch'], defaultMode: 'acceptEdits' },
    enableAllProjectMcpServers: false,
    includeCoAuthoredBy: false,
    cleanupPeriodDays: 14,
  }, null, 2));
  writeIfChanged(path.join(home, '.config', 'opencode', 'service.json'), JSON.stringify({ port: OPENCODE_WORKER_SERVICE_PORT }, null, 2));
  return { home, claude: syncWorkerClaudeToken() };
}
