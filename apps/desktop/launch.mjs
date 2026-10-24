import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopRoot, '..', '..');

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(path.join(repoRoot, 'out-core', 'core.js'))) {
  run(process.execPath, [path.join(repoRoot, 'esbuild.core.js')]);
}

run(process.execPath, [path.join(desktopRoot, 'esbuild.mjs')]);

const electronPkg = path.join(desktopRoot, 'node_modules', 'electron');
if (!fs.existsSync(electronPkg)) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], desktopRoot);
}

const electronBin = process.platform === 'win32'
  ? path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(desktopRoot, 'node_modules', '.bin', 'electron');
if (!fs.existsSync(electronBin)) {
  console.error(`Electron binary not found at ${electronBin}`);
  process.exit(1);
}

const logDir = path.join(repoRoot, '.tmp');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'desktop-host.log');
const dataDir = process.env.KARKEDIKHA_DESKTOP_DATA_DIR
  ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'KarkeDikha', 'desktop');
fs.mkdirSync(path.join(dataDir, 'electron-profile'), { recursive: true });

const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9333';
const windowStateFile = path.join(dataDir, 'window-state.json');
const tmpWindowStateFile = path.join(logDir, 'desktop-window-state.json');

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getExistingMainPid() {
  for (const f of [tmpWindowStateFile, windowStateFile, path.join(logDir, 'desktop-launch.json')]) {
    try {
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        const pid = data.mainPid || data.pid;
        if (typeof pid === 'number' && isProcessRunning(pid)) {
          if (process.platform === 'win32') {
            try {
              const res = spawnSync('powershell.exe', [
                '-NoProfile',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
              ], { encoding: 'utf8', windowsHide: true });
              const cmd = String(res.stdout || '').toLowerCase();
              if (cmd.includes('--type=')) {
                // Not main process
                continue;
              }
            } catch {
              // ignore
            }
          }
          return pid;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function probeCdpPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return false;
    const list = await res.json();
    return Array.isArray(list) && list.some((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes('renderer/index.html'));
  } catch {
    return false;
  }
}

function readCurrentWindowState() {
  for (const f of [tmpWindowStateFile, windowStateFile]) {
    try {
      if (fs.existsSync(f)) {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function spawnElectronProcess(args = []) {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const env = {
    ...childEnv,
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_EVIDENCE: path.join(repoRoot, '.tmp', 'desktop-slice-evidence.jsonl'),
    KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
    KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  };


  const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot, ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

async function main() {
  const existingPid = getExistingMainPid();

  const isForeground = process.argv.includes('--foreground') || process.env.KARKEDIKHA_DESKTOP_FOREGROUND === '1';

  if (existingPid) {
    spawnElectronProcess();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const state = readCurrentWindowState();
      if (state && state.visible && !state.minimized) {
        console.log(`Pandesh window restored and focused (pid=${state.mainPid || existingPid})`);
        console.log(`Launch command: npm run desktop:launch`);
        console.log(`Host log: ${logPath}`);
        process.exit(0);
      }
      const cdpOk = await probeCdpPage();
      if (cdpOk) {
        console.log(`Pandesh window restored and focused (pid=${existingPid})`);
        console.log(`Launch command: npm run desktop:launch`);
        console.log(`Host log: ${logPath}`);
        process.exit(0);
      }
    }
    if (isProcessRunning(existingPid)) {
      console.log(`Pandesh window restored (pid=${existingPid})`);
      console.log(`Host log: ${logPath}`);
      process.exit(0);
    }
  }

  const startTime = Date.now();
  const newPid = spawnElectronProcess();
  fs.writeFileSync(
    path.join(logDir, 'desktop-launch.json'),
    JSON.stringify({ pid: newPid, logPath, dataDir, startedAt: new Date().toISOString() }, null, 2),
  );

  const deadline = Date.now() + 10000;
  let confirmed = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const state = readCurrentWindowState();
    if (state && state.visible && (!state.updatedAt || new Date(state.updatedAt).getTime() >= startTime - 500)) {
      confirmed = true;
      console.log(`Pandesh launched and visible (pid=${state.mainPid || newPid})`);
      break;
    }
    const cdpOk = await probeCdpPage();
    if (cdpOk) {
      confirmed = true;
      console.log(`Pandesh launched and visible (pid=${newPid})`);
      break;
    }
  }

  if (!confirmed) {
    console.error(`Failed to confirm visible KarkeDikha window within 10s. Check host log at: ${logPath}`);
    process.exit(1);
  }

  console.log(`Launch command: npm run desktop:launch`);
  console.log(`Host log: ${logPath}`);

  if (isForeground) {
    while (isProcessRunning(newPid)) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
