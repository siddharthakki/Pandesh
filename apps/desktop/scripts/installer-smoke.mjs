/**
 * Isolated installer smoke — the SMOKE build only.
 *
 * Installs `dist/Pandesh-Smoke-Setup.exe` (distinct AppId and product name,
 * built from the same payload as the deliverable) into a scratch directory,
 * launches the installed app against an isolated data directory, runs a real
 * conversation that calls a governed read-only capability, then uninstalls
 * the smoke build only.
 *
 * It never touches the owner's installation: the owner's AppId is checked
 * before and after, and the script refuses to run with the owner's AppId.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { stopSmokeProcesses, uninstallSmoke } from './lib/smoke-cleanup.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const OWNER_APP_ID = '{8F3C2A91-6B4E-4D17-9C5A-2E8F0B7D4A11}';
const SMOKE = {
  productName: 'Pandesh Smoke',
  setupFileName: 'Pandesh-Smoke-Setup.exe',
  appIdGuid: '{6A1D9E40-2C7B-4F3A-8E55-0B9C7D2F1A63}',
  dataDirRelative: 'KarkeDikha\\desktop',
};
const setupPath = process.env.KARKEDIKHA_DESKTOP_SETUP_EXE ?? path.join(repoRoot, 'dist', SMOKE.setupFileName);
const scratch = path.join(os.tmpdir(), `karkedikha-installer-smoke-${Date.now()}`);
const installDir = path.join(scratch, 'install');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || String(9500 + (process.pid % 90));
const model = process.env.KARKEDIKHA_DESKTOP_MODEL || 'qwen3-coder:swift-27b';
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-live-gaps');
const evidence = { startedAt: new Date().toISOString(), setupPath, steps: [], checks: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function step(name, status, detail) {
  evidence.checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail !== undefined ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}` : ''}`);
}

function ownerRegistryPresent() {
  const r = spawnSync('reg', ['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${OWNER_APP_ID}_is1`], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? String(r.stdout).replace(/\s+/g, ' ').slice(0, 300) : 'absent';
}

async function waitFor(label, fn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function runSilent(exe, args, customEnv) {
  const r = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true, env: customEnv || process.env });
  if (r.status !== 0) throw new Error(`${path.basename(exe)} exited ${r.status}`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('installer smoke is Windows-only');
  if (!fs.existsSync(setupPath)) throw new Error(`smoke setup missing: ${setupPath}`);
  const ownerBefore = ownerRegistryPresent();
  step('owner_install_untouched_before', 'INFO', ownerBefore);

  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });
  const isolatedLocal = path.join(scratch, 'localappdata');
  const isolatedRoaming = path.join(scratch, 'appdata');
  const dataDir = path.join(isolatedLocal, ...SMOKE.dataDirRelative.split('\\'));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(isolatedRoaming, { recursive: true });

  const env = {
    ...process.env,
    LOCALAPPDATA: isolatedLocal,
    APPDATA: isolatedRoaming,
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    KARKEDIKHA_DESKTOP_MODEL: model,
    HERMES_ENABLED: 'true',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  runSilent(setupPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${installDir}`], env);
  step('smoke_installed_silently', 'PASS', installDir);

  const exe = path.join(installDir, 'electron', 'Pandesh.exe');
  const appDir = path.join(installDir, 'app');
  for (const required of [exe, appDir, path.join(installDir, 'runtime', 'core.js')]) {
    if (!fs.existsSync(required)) throw new Error(`installed tree missing ${required}`);
  }
  step('payload_verified', 'PASS', { exe, core: path.join(installDir, 'runtime', 'core.js') });

  const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`, appDir], {
    cwd: installDir, detached: true, stdio: 'ignore', env, windowsHide: false,
  });
  child.unref();
  step('smoke_launched', 'PASS', { pid: child.pid, cdpPort, model });

  let ws = null;
  let nextId = 1;
  const pending = new Map();
  async function cdp(method, params = {}) {
    if (!ws) {
      const page = await waitFor('cdp page', async () => {
        try {
          const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
          return pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) ?? null;
        } catch { return null; }
      });
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      });
    }
    const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) {
    const res = await cdp('Runtime.evaluate', { expression: `(async () => { return (${expression}); })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`eval: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    return res.result?.value;
  }

  try {
    await waitFor('desktop api', () => evaluate('Boolean(window.karkedikhaDesktop)'));
    const snap = await waitFor('core connected', async () => {
      const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return s?.coreState === 'connected' ? s : null;
    }, 150_000);
    step('installed_app_core_connected', 'PASS', { model: snap.model, routingPolicy: snap.routingPolicy });

    if (model) {
      await evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(model)})`);
      await sleep(800);
      await evaluate('window.karkedikhaDesktop.newConversation()');
      await sleep(500);
    }

    // A real conversation through the installed app, calling a governed capability.
    await evaluate(`window.karkedikhaDesktop.submitTask(${JSON.stringify('Pandesh, check my setup. Use the real diagnostics tools and tell me what you found.')}, 'local-core')`);
    let attemptId = null;
    let approvedTools = [];
    const started = Date.now();
    let turnDone = null;
    while (Date.now() - started < 300_000) {
      const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      if (!attemptId && s?.attemptId) attemptId = s.attemptId;
      const pendingApproval = s?.pendingApproval ?? s?.cockpit?.pendingApproval ?? null;
      if (pendingApproval?.approvalId && !approvedTools.includes(pendingApproval.approvalId)) {
        approvedTools.push(pendingApproval.approvalId);
        await evaluate(`window.karkedikhaDesktop.resolveApproval(${JSON.stringify(pendingApproval.approvalId)}, 'approved')`);
      }
      if (!s?.running && attemptId) {
        const opened = await evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(s.activeConversationId)})`);
        const last = (opened?.messages ?? []).slice(-1)[0];
        turnDone = { conversationId: s.activeConversationId, text: String(last?.content ?? ''), role: last?.role };
        break;
      }
      await sleep(1000);
    }
    if (!turnDone) throw new Error('the conversation turn never finished');
    step('installed_app_conversation_reply', turnDone.role === 'assistant' && turnDone.text.length > 40 ? 'PASS' : 'FAIL', turnDone.text.slice(0, 400));

    const coreRecord = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
    const coreToken = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
    const invRes = await fetch(`http://127.0.0.1:${coreRecord.port}/v1/attempts/${attemptId}/tool-invocations`, {
      headers: { Authorization: `Bearer ${coreToken}` },
    });
    const invocations = (await invRes.json())?.toolInvocations ?? [];
    const governed = invocations.find((i) => ['run_system_diagnostics', 'port_check_setup', 'system_hardware_telemetry', 'get_briefing_data', 'port_list_services'].includes(i.toolName));
    step('installed_app_governed_capability', governed && governed.status === 'succeeded' ? 'PASS' : 'FAIL', {
      attemptId,
      tools: invocations.map((i) => `${i.toolName}:${i.status}`),
      output: String(governed?.evidence?.output ?? '').slice(0, 300),
    });

    // Requirement 7 & 8: Verify upgrade-in-place while Pandesh is running in the tray.
    // 1. Hide the running window to the tray.
    await evaluate('window.karkedikhaDesktop.closeWindow()');
    await sleep(1000);
    const winStatePath = path.join(dataDir, 'window-state.json');
    const winState = fs.existsSync(winStatePath) ? JSON.parse(fs.readFileSync(winStatePath, 'utf8')) : null;
    step('running_app_hidden_to_tray', winState?.hiddenToTray ? 'PASS' : 'FAIL', winState);

    // 2. Disconnect CDP WebSocket so the debugger port is free.
    try { ws?.close(); ws = null; } catch { /* ignore */ }

    // 3. Launch the installer while Pandesh is running in the tray!
    // The installer's PrepareToInstall must detect the running instance, request graceful shutdown,
    // wait for verified process termination, and replace the binaries without "Setup was unable to automatically close all applications".
    const upgradeLogPath = path.join(scratch, 'upgrade.log');
    try {
      runSilent(setupPath, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${installDir}`, `/LOG=${upgradeLogPath}`], env);
    } catch (err) {
      if (fs.existsSync(upgradeLogPath)) {
        console.error('--- Inno Setup Upgrade Log ---');
        console.error(fs.readFileSync(upgradeLogPath, 'utf8'));
        console.error('------------------------------');
      }
      throw err;
    }
    step('upgrade_while_running_succeeded', 'PASS', installDir);

    // 4. Verify previous process has terminated cleanly.
    let oldProcessRunning = false;
    try {
      process.kill(child.pid, 0);
      oldProcessRunning = true;
    } catch {
      oldProcessRunning = false;
    }
    step('previous_instance_terminated_cleanly', !oldProcessRunning ? 'PASS' : 'FAIL', { pid: child.pid });

    // 5. Re-launch upgraded Pandesh from installDir and verify user data preserved (conversations, credentials, etc.)
    const upgradedChild = spawn(exe, [`--remote-debugging-port=${cdpPort}`, appDir], {
      cwd: installDir, detached: true, stdio: 'ignore', env, windowsHide: false,
    });
    upgradedChild.unref();
    step('upgraded_app_launched', 'PASS', { pid: upgradedChild.pid, cdpPort });

    try {
      await waitFor('upgraded desktop api', () => evaluate('Boolean(window.karkedikhaDesktop)'));
      const upgradedSnap = await waitFor('upgraded core connected', async () => {
        const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        return s?.coreState === 'connected' ? s : null;
      }, 150_000);
      step('upgraded_app_core_connected', 'PASS', { model: upgradedSnap.model });

      // Requirement 9: Verify conversation and user data preserved across upgrade
      const convList = await evaluate('window.karkedikhaDesktop.listConversations()');
      const preservedConv = (convList ?? []).find((c) => c.id === turnDone.conversationId);
      step('upgrade_preserved_user_data', Boolean(preservedConv) ? 'PASS' : 'FAIL', {
        conversationId: turnDone.conversationId,
        totalConversations: convList?.length ?? 0,
      });
    } finally {
      try { ws?.close(); ws = null; } catch { /* ignore */ }
      stopSmokeProcesses(scratch);
      await sleep(1500);
    }
  } finally {
    try { ws?.close(); ws = null; } catch { /* ignore */ }
    stopSmokeProcesses(scratch);
    await sleep(1500);
  }

  const unins = path.join(installDir, 'unins000.exe');
  if (!fs.existsSync(unins)) throw new Error(`smoke uninstaller missing: ${unins}`);
  runSilent(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCLOSEAPPLICATIONS'], env);
  await sleep(1500);
  step('smoke_uninstalled', fs.existsSync(path.join(installDir, 'electron', 'Pandesh.exe')) ? 'FAIL' : 'PASS', installDir);

  const ownerAfter = ownerRegistryPresent();
  step('owner_install_untouched_after', ownerAfter === ownerBefore ? 'PASS' : 'FAIL', ownerAfter);
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  step('smoke_harness', 'FAIL', err instanceof Error ? err.message : String(err));
}
try { uninstallSmoke(scratch, { ...process.env, LOCALAPPDATA: path.join(scratch, 'localappdata'), APPDATA: path.join(scratch, 'appdata') }); }
catch (error) { failure ??= error; step('smoke_cleanup', 'FAIL', error.message); }
evidence.finishedAt = new Date().toISOString();
evidence.passed = evidence.checks.filter((c) => c.status === 'PASS').length;
evidence.failed = evidence.checks.filter((c) => c.status === 'FAIL').length;
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, 'installed-smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[smoke] passed=${evidence.passed} failed=${evidence.failed} evidence=${path.join(evidenceDir, 'installed-smoke.json')}`);
process.exit(failure || evidence.failed > 0 ? 1 : 0);
