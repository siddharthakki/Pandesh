// Launches a NORMAL, isolated VS Code window — not an
// @vscode/test-electron `runTests()` Extension Development Host.
//
// Checkpoint C root cause: when VS Code is launched via `runTests()` (i.e.
// with `--extensionTestsPath`), `environmentService.isExtensionDevelopment &&
// environmentService.extensionTestsLocationURI` is true, and DialogService
// refuses to render any modal dialog at all. No amount of CDP/WebDriver/focus
// fixing can work around that: the dialog is never created in the first
// place. The only fix is to stop using the extension-test host for any
// scenario that needs a real modal or QuickPick.
//
// This module only uses @vscode/test-electron for:
//   - downloadAndUnzipVSCode()               (fetch a real Code build)
//   - resolveCliArgsFromVSCodeExecutablePath() (get the matching `code` CLI)
//
// It never calls runTests() and never passes --extensionTestsPath. Both the
// production VSIX and the test-only companion-driver VSIX are installed via
// the ordinary `--install-extension` CLI flow into an isolated user-data/
// extensions pair, then the downloaded Code.exe is spawned directly like any
// normal user launch, with `--remote-debugging-port` so an external Node
// process can drive the real, unpatched UI over CDP.

import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import jsonEvidence from './jsonEvidence.cjs';

const { writeJsonAtomic } = jsonEvidence;

/**
 * When this harness itself runs inside an Electron-hosted process tree (e.g.
 * a coding agent's own VS Code extension host), `ELECTRON_RUN_AS_NODE=1` is
 * commonly set in that process's environment and inherited by every spawned
 * child. Electron respects that variable unconditionally: a real, unmodified
 * Code.exe launched with it set runs as a plain Node.js process instead of
 * starting Chromium/the workbench GUI at all — CLI flags like
 * `--user-data-dir` then fail as "bad option" (Node doesn't recognize them)
 * and no `--remote-debugging-port` is ever bound, which otherwise looks
 * exactly like a hung/slow window from the caller's side (ECONNREFUSED after
 * a long poll). Clearing it for the spawned Code.exe child — and only for
 * that child — restores normal GUI startup regardless of what the parent
 * process's own environment happens to be.
 */
function withoutElectronRunAsNode(env) {
  const merged = { ...process.env, ...env };
  // Setting it to '' is NOT enough: Electron's native bootstrap checks
  // whether the variable is present in the environment block at all
  // (getenv() returning non-NULL), before any JS-level truthiness check ever
  // runs — so the key itself must be absent, not merely empty.
  delete merged.ELECTRON_RUN_AS_NODE;
  return merged;
}

function runCli(cli, args, label) {
  const result = spawnSync(cli[0], [...cli.slice(1), ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

/**
 * Download (or reuse the cached) VS Code build and return both the
 * executable path (for launching the app) and the CLI args (for
 * --install-extension).
 */
export async function resolveVSCode() {
  const vscodeExecutablePath = await downloadAndUnzipVSCode();
  const cliArgs = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  return { vscodeExecutablePath, cliArgs };
}

/**
 * Install a VSIX into an isolated user-data-dir/extensions-dir pair using the
 * downloaded VS Code's own CLI. Equivalent to:
 *   code --user-data-dir <dir> --extensions-dir <dir> --install-extension <vsix> --force
 */
/**
 * VS Code renders `vscode.window.show*Message({modal:true})` as a native OS
 * dialog by default (`window.dialogStyle: "native"`) — a separate OS window
 * outside the Chromium page CDP attaches to, so it never appears in the DOM
 * a CDP driver can query or click. Force the in-renderer "custom" dialog so
 * the real modal is part of the same page CDP already drives. This is a
 * harness-only User setting written into the isolated user-data-dir, never
 * production configuration.
 */
export function writeUserSettingsForCustomDialogs(userDataDir) {
  const userDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, 'settings.json');
  const existing = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ ...existing, 'window.dialogStyle': 'custom' }, null, 2),
  );
}

export function installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath }) {
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`cannot install extension, VSIX not found at ${vsixPath}`);
  }
  runCli(
    cliArgs,
    [
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      '--install-extension',
      vsixPath,
      '--force',
    ],
    `--install-extension ${vsixPath}`,
  );
}

/**
 * Launch a normal, isolated VS Code window directly (no --extensionTestsPath,
 * no --disable-extensions, no production auto-approval arguments). The
 * caller is responsible for terminating the returned child process.
 *
 * @returns {import('child_process').ChildProcess}
 */
export function launchPlainHost(
  vscodeExecutablePath,
  { userDataDir, extensionsDir, workspacePath, remoteDebuggingPort, env, extraArgs = [] },
) {
  const args = [
    '--user-data-dir',
    userDataDir,
    '--extensions-dir',
    extensionsDir,
    '--new-window',
    '--disable-updates',
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--remote-debugging-port=${remoteDebuggingPort}`,
    ...extraArgs,
    ...(workspacePath ? [workspacePath] : []),
  ];

  const child = spawn(vscodeExecutablePath, args, {
    env: withoutElectronRunAsNode(env),
    // Keep bounded stdout/stderr evidence for lifecycle failures. The window
    // remains normal and visible; only its inherited console streams change.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    detached: false,
  });

  const outputLimit = 64 * 1024;
  const chunks = { stdout: [], stderr: [] };
  const capture = (name) => (chunk) => {
    const text = Buffer.from(chunk).toString('utf8');
    chunks[name].push(text);
    while (Buffer.byteLength(chunks[name].join(''), 'utf8') > outputLimit) chunks[name].shift();
  };
  child.stdout?.on('data', capture('stdout'));
  child.stderr?.on('data', capture('stderr'));
  const processDetails = () => ({
    pid: child.pid ?? null,
    executable: vscodeExecutablePath,
    arguments: args,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    stdout: chunks.stdout.join(''),
    stderr: chunks.stderr.join(''),
  });
  return { child, args, processDetails };
}

/**
 * Opens a second normal window under the SAME --user-data-dir/--extensions-dir
 * as an already-running plain host (M31 requirement: one shared profile so
 * SecretStorage/Core auth is genuinely shared). VS Code's own single-instance
 * IPC means this CLI invocation detects the already-running process bound to
 * this user-data-dir and forwards an "open new window" request to it rather
 * than starting an independent Electron process — so this call's own
 * `--remote-debugging-port` is not honored; the new window shows up as an
 * additional `page` CDP target on the FIRST window's debugging port. The
 * returned child process exits quickly once the IPC hand-off completes; it is
 * not the process that owns the window.
 */
export function openWindowInSameInstance(
  vscodeExecutablePath,
  { userDataDir, extensionsDir, workspacePath, env, extraArgs = [] },
) {
  const args = [
    '--user-data-dir',
    userDataDir,
    '--extensions-dir',
    extensionsDir,
    '--new-window',
    '--disable-updates',
    '--disable-telemetry',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    ...extraArgs,
    ...(workspacePath ? [workspacePath] : []),
  ];

  const child = spawn(vscodeExecutablePath, args, {
    env: withoutElectronRunAsNode(env),
    stdio: 'ignore',
    windowsHide: false,
    detached: false,
  });

  return { child, args };
}

export function terminatePlainHost(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // best effort
  }
}

let nextPort = 9500 + (process.pid % 400);
export function allocateDebugPort() {
  const port = nextPort;
  nextPort += 1;
  return port;
}

/**
 * Detects an active VS Code installer/updater process (`CodeSetup-*.exe`,
 * including its self-extracting `is-*.tmp` child) anywhere on the machine.
 *
 * Windows' Inno Setup-based VS Code installer takes a single, machine-wide
 * named mutex ("vscode-updating") for the duration of an install/update —
 * not scoped to any one user-data-dir. Every VS Code process on the system,
 * including a completely isolated, separately-downloaded instance launched
 * by this harness, checks that same mutex on startup and refuses to launch
 * while it is held (`checkInnoSetupMutex: ... Code is currently being
 * updated`). That makes a live updater a pure infrastructure precondition
 * this harness cannot control or work around — worth checking for up front
 * instead of discovering it only after a 45s CDP-wait timeout.
 *
 * Returns `[]` on non-Windows platforms, or if the query itself fails (this
 * is a best-effort preflight, not a hard dependency).
 */
export function detectActiveVSCodeUpdater() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name like 'CodeSetup%'\" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout || !result.stdout.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list.map((proc) => {
    const dotNetDateMatch = /\/Date\((\d+)\)\//.exec(proc.CreationDate ?? '');
    return {
      pid: proc.ProcessId,
      startedAt: dotNetDateMatch ? new Date(Number(dotNetDateMatch[1])).toISOString() : (proc.CreationDate ?? null),
      commandLine: proc.CommandLine ?? null,
    };
  });
}

/**
 * Spawns a real Extension Development Host (same args @vscode/test-electron's
 * runTests() would use: --extensionTestsPath + --extensionDevelopmentPath)
 * but, unlike runTests(), returns the live child process handle immediately
 * instead of a promise that only resolves on exit. This is required for the
 * restart-recovery acceptance scenarios, which must forcibly terminate a real
 * Extension Host process mid-task (simulating a crash/reload) rather than
 * letting it run to completion.
 */
export function spawnKillableExtensionHost(
  vscodeExecutablePath,
  { extensionDevelopmentPath, extensionTestsPath, userDataDir, extensionsDir, workspacePath, remoteDebuggingPort, env, extraArgs = [] },
) {
  const args = [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-workspace-trust',
    '--user-data-dir', userDataDir,
    '--extensions-dir', extensionsDir,
    `--remote-debugging-port=${remoteDebuggingPort}`,
    ...extraArgs,
    workspacePath,
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
  ];
  const child = spawn(vscodeExecutablePath, args, {
    env: withoutElectronRunAsNode(env),
    stdio: 'ignore',
    windowsHide: false,
    detached: false,
  });
  return child;
}

export function writeControlFile(controlFilePath, control) {
  writeJsonAtomic(controlFilePath, { schemaVersion: 1, ...control });
}
