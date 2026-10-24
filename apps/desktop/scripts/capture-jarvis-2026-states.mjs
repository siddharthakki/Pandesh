import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const scriptDir = 'C:\\Projects\\ollama-agent\\apps\\desktop\\scripts';
const desktopRoot = 'C:\\Projects\\ollama-agent\\apps\\desktop';
const repoRoot = 'C:\\Projects\\ollama-agent';
const cdpPort = '9477';
const outDir = path.join(repoRoot, 'docs', 'artifacts', 'jarvis-2026-ui-states');
const scratch = path.join(os.tmpdir(), `jarvis-ui-shots-${Date.now()}`);
const dataDir = path.join(scratch, 'desktop-data');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

let wsConnection = null;
let nextCdpId = 1;
const pendingCdp = new Map();

async function cdp(method, params = {}) {
  if (!wsConnection) {
    const page = await waitFor('cdp list', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        const pages = await res.json();
        return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
      } catch {
        return null;
      }
    }, 45000);

    wsConnection = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      wsConnection.once('open', resolve);
      wsConnection.once('error', reject);
    });
    wsConnection.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const pending = pendingCdp.get(msg.id);
      if (!pending) return;
      pendingCdp.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    await cdp('Page.enable');
    await cdp('Runtime.enable');
  }

  const id = nextCdpId++;
  return new Promise((resolve, reject) => {
    pendingCdp.set(id, { resolve, reject });
    wsConnection.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function shot(name) {
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
  console.log(`Saved screenshot: ${file}`);
  return file;
}

function prepareFixture() {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = path.join(scratch, 'repo');
  fs.mkdirSync(fixture, { recursive: true });
  spawnSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
  fs.writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
    name: 'jarvis-2026-demo',
    version: '1.0.0',
    private: true,
  }, null, 2)}\n`);
  spawnSync('git', ['add', 'package.json'], { cwd: fixture, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.name=Jarvis', '-c', 'user.email=jarvis@local.agent', 'commit', '-m', 'init'], {
    cwd: fixture,
    stdio: 'ignore',
  });
  return fixture;
}

function launchElectron(fixture) {
  const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) {
    throw new Error(`Electron binary not found at ${electronBin}`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(electronBin, [
    `--remote-debugging-port=${cdpPort}`,
    `--window-size=1440,900`,
    desktopRoot,
  ], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: process.execPath,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_REPO: fixture,
      KARKEDIKHA_DESKTOP_HOST_LOG: path.join(scratch, 'desktop-host.log'),
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_DESKTOP_MODEL: 'qwen3.8:27b-mtp-q4_K_M',
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

async function main() {
  console.log('--- Generating JARVIS 2026 UI State Screenshots ---');
  const fixture = prepareFixture();
  const pid = launchElectron(fixture);
  console.log(`Spawned Electron PID: ${pid}`);

  try {
    await waitFor('snapshot ready', async () => evaluate('Boolean(window.renderSnapshot && window.karkedikhaDesktop)'));
    await waitFor('core connected', async () => {
      const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return snap?.coreState === 'connected' ? snap : null;
    }, 60000);
    console.log('Renderer and Core ready.');

    await cdp('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Helper to apply and capture
    async function renderAndCapture(filename, patchFn) {
      await evaluate(`
        (async () => {
          const base = await window.karkedikhaDesktop.getSnapshot();
          const patch = (${patchFn.toString()})(base);
          window.renderSnapshot(patch);
        })()
      `);
      await sleep(800); // Allow CSS transforms, glow bloom, and edge animations to settle
      return await shot(filename);
    }

    // State 1: IDLE
    console.log('Capturing 01_idle...');
    await renderAndCapture('01_idle', (b) => ({
      ...b,
      coreState: 'connected',
      running: false,
      awaitingApproval: false,
      pendingApproval: null,
      task: null,
      cockpit: {
        ...(b.cockpit || {}),
        running: false,
        terminal: false,
        phase: 'investigation',
        currentAction: null,
        validationStatus: 'Not run',
        verificationStatus: 'Not run',
        checkpoints: [],
        diagnostics: [],
        repairCycle: 0,
      }
    }));

    // State 2: ACTIVE MISSION (Thinking / Planning)
    console.log('Capturing 02_active_mission...');
    await renderAndCapture('02_active_mission', (b) => ({
      ...b,
      coreState: 'connected',
      running: true,
      awaitingApproval: false,
      pendingApproval: null,
      task: 'Refactor notification subsystem to support high-priority queues',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      selectedInferenceProvider: 'ollama',
      routingPolicy: 'local-only',
      cockpit: {
        ...(b.cockpit || {}),
        running: true,
        terminal: false,
        phase: 'investigation',
        currentAction: { title: 'Analyzing queue dependencies across telemetry modules' },
        validationStatus: 'Not run',
        verificationStatus: 'Not run',
        metrics: { ...(b.cockpit || {})?.metrics, promptTokens: 3840, generatedTokens: 420 },
        checkpoints: [
          { title: 'Discovered 4 source modules in telemetry engine', count: 1 },
          { title: 'Parsed interface definitions for PriorityQueue trait', count: 1 },
        ],
        diagnostics: [
          { at: '10:30:15', summary: 'Ollama local runtime selected: qwen3.8:27b-mtp-q4_K_M (Local-first sandbox)' },
        ],
        repairCycle: 0,
      }
    }));

    // State 3: TOOL EXECUTION (Executing capability)
    console.log('Capturing 03_tool_execution...');
    await renderAndCapture('03_tool_execution', (b) => ({
      ...b,
      coreState: 'connected',
      running: true,
      awaitingApproval: false,
      pendingApproval: null,
      task: 'Refactor notification subsystem to support high-priority queues',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      selectedInferenceProvider: 'ollama',
      routingPolicy: 'local-only',
      cockpit: {
        ...(b.cockpit || {}),
        running: true,
        terminal: false,
        phase: 'implementation',
        currentAction: { title: 'write_file src/engine/priority_queue.rs' },
        validationStatus: 'Not run',
        verificationStatus: 'Not run',
        filesChanged: ['src/engine/priority_queue.rs'],
        metrics: { ...(b.cockpit || {})?.metrics, promptTokens: 6200, generatedTokens: 1100 },
        checkpoints: [
          { title: 'Read src/engine/queue.rs', count: 1 },
          { title: 'write_file src/engine/priority_queue.rs', count: 1, detail: 'Wrote 184 lines with PriorityChannel dispatch' },
        ],
        diagnostics: [
          { at: '10:30:15', summary: 'Ollama local runtime selected: qwen3.8:27b-mtp-q4_K_M' },
          { at: '10:30:42', summary: 'Capability invoked: write_file [Local filesystem sandbox]' },
        ],
        repairCycle: 0,
      }
    }));

    // State 4: VALIDATION (Running test suite & checks)
    console.log('Capturing 04_validation...');
    await renderAndCapture('04_validation', (b) => ({
      ...b,
      coreState: 'connected',
      running: true,
      awaitingApproval: false,
      pendingApproval: null,
      task: 'Refactor notification subsystem to support high-priority queues',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      selectedInferenceProvider: 'ollama',
      routingPolicy: 'local-only',
      cockpit: {
        ...(b.cockpit || {}),
        running: true,
        terminal: false,
        phase: 'implementation',
        currentAction: { title: 'Validating workspace: cargo test --package telemetry-engine' },
        validationStatus: 'running',
        verificationStatus: 'Not run',
        filesChanged: ['src/engine/priority_queue.rs', 'src/engine/mod.rs'],
        metrics: { ...(b.cockpit || {})?.metrics, promptTokens: 8500, generatedTokens: 1450 },
        checkpoints: [
          { title: 'Read src/engine/queue.rs', count: 1 },
          { title: 'write_file src/engine/priority_queue.rs', count: 1 },
          { title: 'write_file src/engine/mod.rs', count: 1 },
          { title: 'cargo test --package telemetry-engine (validating)', count: 1 },
        ],
        diagnostics: [
          { at: '10:31:02', summary: 'Verification suite initiated: running 12 integration tests' },
        ],
        repairCycle: 0,
      }
    }));

    // State 5: RECOVERY (KKD Autonomous Remediation)
    console.log('Capturing 05_recovery...');
    await renderAndCapture('05_recovery', (b) => ({
      ...b,
      coreState: 'connected',
      running: true,
      awaitingApproval: false,
      pendingApproval: null,
      task: 'Refactor notification subsystem to support high-priority queues',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      selectedInferenceProvider: 'ollama',
      routingPolicy: 'local-only',
      cockpit: {
        ...(b.cockpit || {}),
        running: true,
        terminal: false,
        phase: 'repair',
        currentAction: { title: 'KKD Recovery: Compacted prompt 16K -> 32K context, reasoning disabled' },
        validationStatus: 'failed',
        verificationStatus: 'failed',
        repairCycle: 1,
        filesChanged: ['src/engine/priority_queue.rs'],
        metrics: { ...(b.cockpit || {})?.metrics, promptTokens: 15400, generatedTokens: 1850 },
        checkpoints: [
          { title: 'cargo test failed: lifetime mismatch on ChannelReader', count: 1 },
          { title: 'KKD Self-Healing: Synthesizing lifetime annotation fix', count: 1 },
        ],
        diagnostics: [
          { at: '10:31:18', summary: 'Context Pressure 94% detected: triggering KKD dynamic compaction' },
          { at: '10:31:20', summary: 'Self-healing repair cycle #1 engaged' },
        ],
      }
    }));

    // State 6: APPROVAL REQUIRED (Governance Gate)
    console.log('Capturing 06_approval_required...');
    await renderAndCapture('06_approval_required', (b) => ({
      ...b,
      coreState: 'connected',
      running: true,
      awaitingApproval: true,
      task: 'Refactor notification subsystem to support high-priority queues',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      selectedInferenceProvider: 'ollama',
      routingPolicy: 'local-only',
      pendingApproval: {
        approvalId: 'appr-gov-8821',
        attemptId: 'att-1',
        gate: 'Fenced File Mutation',
        toolName: 'replace_system_daemon',
        arguments: { service: 'telemetry-bus' },
        requestedAt: new Date().toISOString(),
        paths: ['/etc/systemd/system/telemetry.service'],
        actionDigest: 'sha256:d89a7ef204918c5e9',
        diff: '--- /etc/systemd/system/telemetry.service\\n+++ /etc/systemd/system/telemetry.service\\n-ExecStart=/usr/local/bin/telemetry-engine\\n+ExecStart=/usr/local/bin/telemetry-engine --priority-queue --workers=4',
        scope: 'System Service Configuration',
        detail: 'Mutating host system service configuration requires explicit human authorization under KKD policy.',
      },
      cockpit: {
        ...(b.cockpit || {}),
        running: true,
        terminal: false,
        phase: 'implementation',
        currentAction: { title: 'Awaiting operator approval for system service mutation' },
        validationStatus: 'passed',
        verificationStatus: 'Not run',
        repairCycle: 0,
        pendingApproval: {
          approvalId: 'appr-gov-8821',
          attemptId: 'att-1',
          gate: 'Fenced File Mutation',
          toolName: 'replace_system_daemon',
          arguments: { service: 'telemetry-bus' },
          requestedAt: new Date().toISOString(),
          paths: ['/etc/systemd/system/telemetry.service'],
          actionDigest: 'sha256:d89a7ef204918c5e9',
          diff: '+ ExecStart=/usr/local/bin/telemetry-engine --priority-queue',
          scope: 'System Service Configuration',
          detail: 'Mutating host system service configuration requires explicit human authorization under KKD policy.',
        },
        diagnostics: [
          { at: '10:32:05', summary: 'Governance gate triggered: Fenced File Mutation' },
          { at: '10:32:05', summary: 'Execution paused. Awaiting human approval.' },
        ],
      }
    }));

    // State 7: COMPLETED (Verified & Delivered)
    console.log('Capturing 07_completed...');
    await renderAndCapture('07_completed', (b) => ({
      ...b,
      coreState: 'connected',
      running: false,
      awaitingApproval: false,
      pendingApproval: null,
      lastTurnOutcome: 'completed',
      task: 'Refactor notification subsystem to support high-priority queues',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      provider: 'ollama',
      selectedInferenceProvider: 'ollama',
      routingPolicy: 'local-only',
      cockpit: {
        ...(b.cockpit || {}),
        running: false,
        terminal: true,
        phase: 'delivered',
        currentAction: null,
        finalOutcome: 'Success',
        validationStatus: 'passed',
        verificationStatus: 'passed',
        filesChanged: ['src/engine/priority_queue.rs', 'src/engine/mod.rs', 'tests/priority_test.rs'],
        metrics: {
          ...(b.cockpit || {})?.metrics,
          promptTokens: 11200,
          generatedTokens: 2150,
          cloudCostAvoidedUsd: 0.0842,
        },
        checkpoints: [
          { title: 'Read src/engine/queue.rs', count: 1 },
          { title: 'write_file src/engine/priority_queue.rs', count: 1 },
          { title: 'write_file src/engine/mod.rs', count: 1 },
          { title: 'cargo test: 14 passed; 0 failed', count: 1 },
          { title: 'git commit -m "feat(telemetry): priority dispatch queue"', count: 1 },
        ],
        diagnostics: [
          { at: '10:32:45', summary: 'All 14 unit and integration tests passed cleanly' },
          { at: '10:32:48', summary: 'Mission completed successfully. 100% local execution.' },
        ],
        repairCycle: 0,
      }
    }));

    console.log('All 7 state screenshots captured successfully!');
  } finally {
    if (wsConnection) {
      try { wsConnection.close(); } catch {}
    }
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        process.kill(pid);
      }
    } catch {}
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error('Capture failed:', err);
  process.exit(1);
});
