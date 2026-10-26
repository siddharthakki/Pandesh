/**
 * Builds a portable Windows Pandesh folder that launches without
 * Cursor, VS Code, or npm. Layout:
 *
 *   dist/pandesh-win32-x64/
 *     Launch-Pandesh.cmd
 *     README.txt
 *     electron/          (Electron runtime)
 *     app/               (package.json, out/, renderer/)
 *     runtime/           (node.exe + core.js)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';
import { buildReleaseManifest, writeReleaseManifest, gitSourceState } from './lib/release-manifest.mjs';
import {
  composeBuildIdentity,
  readAppVersion,
  verifyBuildIdentity,
  writeBuildIdentity,
} from './lib/build-identity.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outDir = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');

/**
 * Node 24 on Windows refuses to spawn a .cmd/.bat file without a shell (CVE-2024-27980 hardening): the call returns
 * `status: null` with an EINVAL error instead of running npm. A batch file is therefore run through the shell, with
 * every argument quoted; anything else is still spawned directly.
 */
export function run(command, args, cwd = repoRoot) {
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = isBatch
    ? spawnSync([/\s/.test(command) ? `"${command}"` : command, ...args.map((part) => `"${String(part).replace(/"/g, '\\"')}"`)].join(' '), {
      cwd, stdio: 'inherit', windowsHide: true, env: process.env, shell: true,
    })
    : spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true, env: process.env, shell: false });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function copyRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

function resolveNodeBinary() {
  const configured = process.env.KARKEDIKHA_DESKTOP_NODE?.trim();
  if (configured && fs.existsSync(configured)) return configured;
  return process.execPath;
}

console.log('Building Core and Desktop bundles…');
run(process.execPath, [path.join(repoRoot, 'esbuild.core.js'), '--production']);
run(process.execPath, [path.join(desktopRoot, 'esbuild.mjs')]);

const stagedAsr = path.join(repoRoot, 'runtime-assets', 'node_modules', '@xenova', 'transformers', 'package.json');
if (!fs.existsSync(stagedAsr)) {
  console.log('Staging local ASR runtime assets (first time)…');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'stage-asr-runtime-assets.mjs')]);
}
const whisperConfig = path.join(repoRoot, 'models', 'whisper-base-en', 'Xenova', 'whisper-base.en', 'config.json');
if (!fs.existsSync(whisperConfig)) {
  console.log('Fetching whisper-base.en model (first time)…');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'fetch-whisper-model.mjs')]);
}
const owwJarvis = path.join(repoRoot, 'models', 'openwakeword', 'hey_jarvis_v0.1.onnx');
if (!fs.existsSync(owwJarvis)) {
  console.log('Fetching openWakeWord hey_jarvis models…');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'fetch-openwakeword-models.mjs')]);
}
const piperExe = path.join(repoRoot, 'runtime', 'piper', 'piper.exe');
if (!fs.existsSync(piperExe) && process.platform === 'win32') {
  console.log('Fetching Piper TTS (intentional voice dependency)…');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'fetch-piper.mjs')]);
}
const gwsExe = path.join(repoRoot, 'runtime', 'gws', 'gws.exe');
if (!fs.existsSync(gwsExe) && process.platform === 'win32') {
  console.log('Fetching pinned gws (Gmail connector transport)…');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'fetch-gws.mjs')]);
}

const electronDist = path.join(desktopRoot, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], desktopRoot);
}
if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  throw new Error(`Electron binary missing at ${electronDist}`);
}

const coreJs = path.join(repoRoot, 'out-core', 'core.js');
if (!fs.existsSync(coreJs)) throw new Error(`Core bundle missing at ${coreJs}`);

// A prior smoke/launch run can leave its electron.exe (or a descendant
// process) holding file handles open inside outDir for a few hundred ms
// after the parent process appears to have exited (Windows AV scanning,
// slow-to-release DLL handles). Retry the removal instead of failing the
// whole packaging run on a transient EPERM/EBUSY.
function rmOutDirWithRetry(dir, attempts = 5, delayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const retryable = err && (err.code === 'EPERM' || err.code === 'EBUSY');
      if (!retryable || attempt === attempts) {
        if (retryable) {
          throw new Error(
            `Could not remove ${dir} after ${attempts} attempts (${err.code}). ` +
            'A previous portable build is likely still running (leftover electron.exe/node.exe ' +
            'holding files open) — close it and retry.',
          );
        }
        throw err;
      }
      console.warn(`rmSync(${dir}) failed with ${err.code}, retrying (${attempt}/${attempts})…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

rmOutDirWithRetry(outDir);
fs.mkdirSync(outDir, { recursive: true });

console.log(`Staging portable tree at ${outDir}`);
copyRecursive(electronDist, path.join(outDir, 'electron'));

const iconIco = path.join(desktopRoot, 'assets', 'icon.ico');
if (process.platform === 'win32' && fs.existsSync(iconIco)) {
  console.log('Embedding Jarvis icon into electron.exe…');
  await rcedit(path.join(outDir, 'electron', 'electron.exe'), { icon: iconIco });
}

const appDir = path.join(outDir, 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify({
  name: 'pandesh',
  // The ONE authoritative application version. Electron's app.getVersion()
  // reads this file, so the footer, the About panel and the installer all
  // name the same version without a second copy anywhere.
  version: readAppVersion(repoRoot),
  private: true,
  main: 'out/main.js',
  productName: 'Pandesh',
}, null, 2)}\n`);
copyRecursive(path.join(desktopRoot, 'out'), path.join(appDir, 'out'));
copyRecursive(path.join(desktopRoot, 'renderer'), path.join(appDir, 'renderer'));
copyRecursive(path.join(repoRoot, 'models', 'whisper-base-en'), path.join(outDir, 'models', 'whisper-base-en'));
if (fs.existsSync(path.join(repoRoot, 'models', 'openwakeword'))) {
  copyRecursive(path.join(repoRoot, 'models', 'openwakeword'), path.join(outDir, 'models', 'openwakeword'));
}
copyRecursive(path.join(repoRoot, 'runtime-assets', 'node_modules'), path.join(outDir, 'runtime-assets', 'node_modules'));
// Pi agent runtime dependency: the Core dynamically imports @earendil-works/pi-agent-core
// and @earendil-works/pi-ai against runtime/core.js, so they must live in
// runtime/node_modules (next to core.js) in the packaged app. Without them every
// Pi task fails with ERR_MODULE_NOT_FOUND and surfaces as an interrupted task.
const piDepsSrc = path.join(repoRoot, 'node_modules', '@earendil-works');
const piDepsDest = path.join(outDir, 'runtime', 'node_modules', '@earendil-works');
if (fs.existsSync(piDepsSrc)) {
  copyRecursive(piDepsSrc, piDepsDest);
} else {
  console.warn('[package-portable] @earendil-works not installed; Pi agent will be unavailable in the packaged app');
}
const typeboxSrc = path.join(repoRoot, 'node_modules', 'typebox');
const typeboxDest = path.join(outDir, 'runtime', 'node_modules', 'typebox');
if (fs.existsSync(typeboxSrc)) {
  copyRecursive(typeboxSrc, typeboxDest);
}
const partialJsonSrc = path.join(repoRoot, 'node_modules', 'partial-json');
const partialJsonDest = path.join(outDir, 'runtime', 'node_modules', 'partial-json');
if (fs.existsSync(partialJsonSrc)) {
  copyRecursive(partialJsonSrc, partialJsonDest);
}
if (fs.existsSync(path.join(repoRoot, 'runtime', 'piper'))) {
  copyRecursive(path.join(repoRoot, 'runtime', 'piper'), path.join(outDir, 'runtime', 'piper'));
}
// Gmail connector transport: staged, digest-pinned binary — never on PATH,
// never fetched by the packaged app itself at runtime (fetch-gws.mjs is a
// build-time-only step). Missing/mismatched digest fails closed at the
// gwsTransport.ts call site, not silently here.
let gwsStaged = false;
if (fs.existsSync(gwsExe)) {
  copyRecursive(path.join(repoRoot, 'runtime', 'gws'), path.join(outDir, 'runtime', 'gws'));
  gwsStaged = true;
}
const wakeWorkerSrc = path.join(desktopRoot, 'scripts', 'wake-word-worker.mjs');
const wakeThresholdSrc = path.join(desktopRoot, 'scripts', 'wakeThreshold.mjs');
if (fs.existsSync(wakeWorkerSrc)) {
  fs.mkdirSync(path.join(outDir, 'runtime'), { recursive: true });
  fs.copyFileSync(wakeWorkerSrc, path.join(outDir, 'runtime', 'wake-word-worker.mjs'));
  if (fs.existsSync(wakeThresholdSrc)) {
    fs.copyFileSync(wakeThresholdSrc, path.join(outDir, 'runtime', 'wakeThreshold.mjs'));
  }
}
// Real native ORT for wake (never the ASR WASM shim named onnxruntime-node).
{
  const wakeMods = path.join(outDir, 'runtime', 'wake-node_modules');
  const ortSrc = path.join(repoRoot, 'node_modules', 'onnxruntime-node');
  const commonSrc = path.join(repoRoot, 'node_modules', 'onnxruntime-common');
  if (fs.existsSync(ortSrc) && fs.existsSync(commonSrc)) {
    fs.mkdirSync(wakeMods, { recursive: true });
    copyRecursive(commonSrc, path.join(wakeMods, 'onnxruntime-common'));
    const ortDest = path.join(wakeMods, 'onnxruntime-node');
    fs.mkdirSync(ortDest, { recursive: true });
    for (const name of ['package.json', 'README.md']) {
      const src = path.join(ortSrc, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ortDest, name));
    }
    for (const name of ['dist', 'lib']) {
      const src = path.join(ortSrc, name);
      if (fs.existsSync(src)) copyRecursive(src, path.join(ortDest, name));
    }
    // Win32 Desktop ships only win32/x64 native binding.
    const bindingSrc = path.join(ortSrc, 'bin', 'napi-v3', 'win32', 'x64');
    const bindingDest = path.join(ortDest, 'bin', 'napi-v3', 'win32', 'x64');
    if (fs.existsSync(bindingSrc)) {
      copyRecursive(bindingSrc, bindingDest);
    } else {
      console.warn('[package-portable] onnxruntime-node win32/x64 binding missing; wake word may be unavailable');
    }
  } else {
    console.warn('[package-portable] onnxruntime-node not installed; wake worker needs npm install');
  }
}

const runtimeDir = path.join(outDir, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(coreJs, path.join(runtimeDir, 'core.js'));
const nodeSrc = resolveNodeBinary();
const nodeDest = path.join(runtimeDir, 'node.exe');
fs.copyFileSync(nodeSrc, nodeDest);
console.log(`Bundled Node runtime from ${nodeSrc}`);

const launchCmd = `@echo off
setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
rem A Node/Electron developer machine can have ELECTRON_RUN_AS_NODE=1 set as
rem a persistent Windows user environment variable (e.g. left over from
rem debugging some other Electron app). If inherited here, electron.exe
rem silently runs as plain Node instead of launching Pandesh's window at all
rem — clear it unconditionally so Pandesh starts regardless of ambient state.
set "ELECTRON_RUN_AS_NODE="
set "KARKEDIKHA_DESKTOP_PRODUCT_ROOT=%ROOT%"
set "KARKEDIKHA_DESKTOP_CORE_PATH=%ROOT%\\runtime\\core.js"
set "KARKEDIKHA_DESKTOP_NODE=%ROOT%\\runtime\\node.exe"
set "KARKEDIKHA_MODEL_ROUTING_POLICY=local-only"
${gwsStaged ? 'set "KARKEDIKHA_GWS_BIN=%ROOT%\\runtime\\gws\\gws.exe"\n' : ''}if not defined KARKEDIKHA_DESKTOP_DATA_DIR set "KARKEDIKHA_DESKTOP_DATA_DIR=%LOCALAPPDATA%\\KarkeDikha\\desktop"
if not defined KARKEDIKHA_DESKTOP_HOST_LOG set "KARKEDIKHA_DESKTOP_HOST_LOG=%ROOT%\\.tmp\\desktop-host.log"
if not exist "%ROOT%\\.tmp" mkdir "%ROOT%\\.tmp"
start "" "%ROOT%\\electron\\electron.exe" "%ROOT%\\app"
endlocal
`;
fs.writeFileSync(path.join(outDir, 'Launch-Pandesh.cmd'), launchCmd.replace(/\n/g, '\r\n'));

fs.writeFileSync(path.join(outDir, 'README.txt'), [
  'Pandesh (portable Windows build)',
  '',
  'Launch: double-click Launch-Pandesh.cmd',
  'Requires: a running local Ollama instance with at least one installed model.',
  'Does not require Cursor, VS Code, or npm.',
  '',
  'Pandesh opens knowing what matters:',
  '  - Home shows at most three things that need you — a pending approval, a task',
  '    that failed or was interrupted, a result that just landed. Every card names',
  '    the source it came from and carries working buttons (Approve / Reject, Stop,',
  '    Resume, Open conversation, Open result).',
  '  - With nothing to show, it is simply the calm panda welcome.',
  '',
  'Ask "What is on my plate today?" and Pandesh answers from your real sources:',
  '  calendar commitments, unread mail, pending work and approvals, follow-ups.',
  '  A service that is not connected is reported as not connected — never faked.',
  '',
  'It remembers:',
  '  - Tell it to remember a preference, a decision or a promise. The fact is',
  '    stored in KarkeDikha Core with its source, and you approve each write.',
  '  - "Remind me to follow up if they do not reply" becomes a commitment that',
  '    Pandesh checks against your mail and reports back — once a day, and never',
  '    sending anything on your behalf.',
  '',
  'The daily brief routine:',
  '  - Home > Daily brief lets you set the time. It is stored in KarkeDikha Core,',
  '    so it survives restarts, runs once per occurrence, and can be switched off.',
  '    It only reads: it never sends mail and never takes a consequential action.',
  '',
  'Other things in the app:',
  '  1. Select repository (optional for conversation, required for file work)',
  '  2. Choose an installed Ollama model',
  '  3. Pick Local Core (or Autonomous Mission) and submit a task',
  '  4. Optional: push-to-talk Mic uses local Whisper (no cloud speech)',
  '',
  'OpenRouter cloud submission is not ready; Ollama/local-only is the default.',
  '',
  `Built: ${new Date().toISOString()}`,
  `Host: ${os.hostname()}`,
  '',
].join('\r\n'));

fs.writeFileSync(path.join(outDir, 'portable-manifest.json'), `${JSON.stringify({
  name: 'pandesh',
  platform: 'win32',
  arch: 'x64',
  builtAt: new Date().toISOString(),
  electron: '33.4.11',
  nodeRuntime: nodeSrc,
  coreBundle: 'runtime/core.js',
  launch: 'Launch-Pandesh.cmd',
}, null, 2)}\n`);

// The build identity is generated from the ONE authoritative source (the app
// version in apps/desktop/package.json plus the committed build number) and
// embedded in the packaged tree, so the running app can name its own build
// without Git and without a second hand-maintained version string.
const buildIdentity = composeBuildIdentity(repoRoot, {
  commit: gitSourceState(repoRoot).commit,
  builtAt: new Date().toISOString(),
  sourceState: gitSourceState(repoRoot).sourceState,
});
writeBuildIdentity(outDir, buildIdentity);
verifyBuildIdentity(outDir, repoRoot);

// Release manifest: hashes of the files actually packaged above (never a pre-build snapshot), plus the commit and
// whether the working tree was clean. Throws if a mandatory file is missing or the tree is dirty (unless allowed).
// It is built AFTER the identity was written, so the identity is hashed too.
const releaseManifest = buildReleaseManifest(outDir, repoRoot);
writeReleaseManifest(outDir, releaseManifest);

console.log(`Portable Pandesh ready: ${outDir}`);
console.log(`Build identity: v${buildIdentity.version} · b${buildIdentity.buildNumber} (${buildIdentity.releaseChannel}, ${buildIdentity.buildKind})`);
console.log('Launch: Launch-Pandesh.cmd');
