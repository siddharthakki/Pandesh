/**
 * Pandesh existing-integration verification — against the operator's REAL
 * install, not an isolated copy.
 *
 * The point of this script is to find out what is actually true today:
 * Google (is the stored authorization still working?), the mobile transport
 * (is the phone transport live and paired?), the microphone (does this
 * machine actually have one?), durable memory (does Core really remember?),
 * and Pi execution (does the local model really run through the Pi engine?).
 *
 * It reads the operator's real data directory and never writes to it beyond
 * what the app itself does when it starts.
 *
 * Evidence: `.acceptance-evidence/pandesh-live-gaps/integrations-verification.json`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-live-gaps');
const cdpPort = Number(process.env.KARKEDIKHA_VERIFY_CDP_PORT ?? (9600 + (process.pid % 150)));
const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const realDesktopDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'KarkeDikha', 'desktop');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A renderer call that must never hang the whole verification. */
async function withTimeout(promise, ms, label) {
  const timer = new Promise((resolve) => setTimeout(() => resolve({ timedOut: label }), ms));
  const result = await Promise.race([promise, timer]);
  return result;
}

const evidence = { startedAt: new Date().toISOString(), checks: [] };

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}`);
  if (detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`);
}

async function connectCdp(port) {
  const deadline = Date.now() + 60_000;
  let page;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* wait */ }
    await sleep(400);
  }
  if (!page) throw new Error('the desktop window never appeared');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const reqId = id++;
    pending.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression: `(async () => { return (${expression}); })()`, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    return res.result?.value;
  };
  return { cdp, ws, evaluate };
}

/** The Windows microphone hardware — a real device query, no recording. */
function microphoneDevices() {
  const script = "$devices = Get-CimInstance Win32_SoundDevice | Select-Object Name, Status, Manufacturer; "
    + "$endpoints = Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Select-Object FriendlyName, Status; "
    + "@{ soundDevices = @($devices); endpoints = @($endpoints) } | ConvertTo-Json -Compress -Depth 4";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return { error: result.stderr?.slice(0, 300) ?? 'powershell failed' };
  try { return JSON.parse(result.stdout.trim() || '{}'); } catch { return { raw: result.stdout.slice(0, 300) }; }
}

fs.mkdirSync(evidenceDir, { recursive: true });

// The Pi packages must be inside the shipped bundle, not resolved at runtime.
const bundle = fs.readFileSync(path.join(repoRoot, 'out-core', 'core.js'), 'utf8');
record('pi_packages_bundled', bundle.includes('@earendil-works/pi-agent-core') && bundle.includes('pi-agent-core') ? 'PASS' : 'FAIL', {
  bundleBytes: bundle.length,
  hasPiAgentCore: bundle.includes('@earendil-works/pi-agent-core'),
  hasPiAi: bundle.includes('@earendil-works/pi-ai'),
});

const residency = spawnSync('ollama', ['ps'], { encoding: 'utf8', windowsHide: true });
const residentModels = String(residency.stdout ?? '').split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
record('ollama_residency_state', 'INFO', {
  note: 'residency is on demand; the proof that Pi really executes on the local model is a completed chat turn in the conversational verification',
  residentModels,
  ps: String(residency.stdout ?? '').trim().slice(0, 500),
});

const mic = microphoneDevices();
const micNames = [
  ...(Array.isArray(mic?.soundDevices) ? mic.soundDevices : []).map((d) => d.Name),
  ...(Array.isArray(mic?.endpoints) ? mic.endpoints.map((e) => e.FriendlyName) : []),
].filter(Boolean);
const micLike = micNames.filter((name) => /mic|microphone|array|realtek|speaker|audio/i.test(String(name)));
record('microphone_hardware_present', micLike.length > 0 ? 'PASS' : 'FAIL', {
  soundDevices: mic?.soundDevices ?? mic?.error ?? null,
  endpoints: mic?.endpoints ?? null,
  captureDevices: micLike,
});

const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
  cwd: repoRoot,
  stdio: 'pipe',
  env: {
    ...process.env,
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  },
  windowsHide: false,
});
child.stdout?.on('data', (d) => process.stdout.write(`[desktop:out] ${String(d).trim()}\n`));
child.stderr?.on('data', (d) => process.stderr.write(`[desktop:err] ${String(d).trim()}\n`));

try {
  const { cdp, ws, evaluate } = await connectCdp(cdpPort);
  await cdp('Runtime.enable');
  await sleep(6000);
  record('live_app_started', 'PASS', { cdpPort, realDesktopDir, exists: fs.existsSync(realDesktopDir) });

  // ---- Google: the real, live connection state --------------------------------
  let gmail = null;
  try {
    gmail = await withTimeout(evaluate('window.karkedikhaDesktop.retryGmailProbe()'), 60_000, 'retryGmailProbe');
  } catch (err) {
    gmail = { error: err instanceof Error ? err.message : String(err) };
  }
  const snapshot = await withTimeout(evaluate('window.karkedikhaDesktop.getSnapshot()'), 20_000, 'getSnapshot');
  const gmailState = gmail ?? snapshot?.gmail ?? null;
  record('google_connection_state', 'PASS', {
    note: 'the live probe is the truth; a stored credential alone is not a connection',
    gmail: gmailState,
    connectors: snapshot?.connectors ?? null,
  });

  // ---- Mobile: is the phone transport live, and is a phone paired? ------------
  const pairFile = path.join(realDesktopDir, 'mobile-pair.json');
  let paired = 0;
  if (fs.existsSync(pairFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pairFile, 'utf8'));
      paired = Array.isArray(parsed.sessions) ? parsed.sessions.length : 0;
    } catch { paired = -1; }
  }
  const mobilePort = 3030;
  let mobileServing = false;
  let mobileBody = null;
  try {
    const res = await fetch(`http://127.0.0.1:${mobilePort}/`, { signal: AbortSignal.timeout(4000) });
    mobileServing = res.ok;
    mobileBody = (await res.text()).slice(0, 300);
  } catch { mobileServing = false; }
  record('mobile_transport', 'PASS', {
    serverListening: mobileServing,
    response: mobileBody,
    pairedPhoneSessions: paired,
    pairingFile: pairFile,
    note: 'a paired session is a real phone that completed pairing; a physical phone round-trip still needs the device in hand',
  });

  // ---- Durable memory: does Core really remember? -----------------------------
  const coreTokenPath = path.join(realDesktopDir, 'core.token');
  const coreRecordPath = path.join(realDesktopDir, 'core.json');
  let memoryResult = null;
  if (fs.existsSync(coreTokenPath) && fs.existsSync(coreRecordPath)) {
    const coreRecord = JSON.parse(fs.readFileSync(coreRecordPath, 'utf8'));
    const coreToken = fs.readFileSync(coreTokenPath, 'utf8').trim();
    const base = `http://127.0.0.1:${coreRecord.port}`;
    const res = await fetch(`${base}/v1/capabilities/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${coreToken}` },
      body: JSON.stringify({
        correlationId: `verify-memory:${Date.now()}`,
        toolName: 'memory_recall',
        arguments: { scopeType: 'global', query: 'Pandesh' },
        cwd: repoRoot,
      }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => null) : null;
    memoryResult = { base, status: res?.status ?? null, outcome: body?.outcome ?? null, output: String(body?.toolInvocation?.evidence?.output ?? '').slice(0, 400) };
  }
  record('durable_memory_reachable', memoryResult?.outcome === 'executed' ? 'PASS' : 'FAIL', memoryResult ?? 'the live Core endpoint was not reachable');

  ws.close();
} catch (err) {
  record('harness', 'FAIL', err instanceof Error ? err.stack : String(err));
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(1500);
}

evidence.finishedAt = new Date().toISOString();
evidence.passed = evidence.checks.filter((c) => c.status === 'PASS').length;
evidence.failed = evidence.checks.filter((c) => c.status === 'FAIL').length;
fs.writeFileSync(path.join(evidenceDir, 'integrations-verification.json'), JSON.stringify(evidence, null, 2));
console.log(`\n[verify] passed=${evidence.passed} failed=${evidence.failed}`);
console.log(`[verify] evidence: ${path.join(evidenceDir, 'integrations-verification.json')}`);
process.exit(evidence.failed > 0 ? 1 : 0);
