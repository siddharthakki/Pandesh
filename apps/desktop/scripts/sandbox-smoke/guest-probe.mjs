/**
 * Guest-side probe. Runs INSIDE Windows Sandbox using the node.exe that ships in the installed Pandesh runtime
 * (the guest has no other Node). Every command prints exactly one JSON document to stdout.
 *
 *   node guest-probe.mjs pi-import <runtimeDir>
 *   node guest-probe.mjs scan <installDir>
 *   node guest-probe.mjs runtime <dataDir> <cdpPort> [timeoutSeconds]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// ---------------------------------------------------------------- pi-import
function piImport(runtimeDir) {
  const packages = ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai'];
  const results = [];
  for (const name of packages) {
    // A real dynamic import, resolved from the installed runtime directory exactly as core.js would resolve it.
    const probe = path.join(runtimeDir, `pi-import-probe-${process.pid}.mjs`);
    fs.writeFileSync(probe, [
      `const mod = await import(${JSON.stringify(name)});`,
      'const keys = Object.keys(mod);',
      'process.stdout.write(JSON.stringify({ keyCount: keys.length, sample: keys.slice(0, 8) }));',
    ].join('\n'));
    try {
      const run = spawnSync(process.execPath, [probe], { cwd: runtimeDir, encoding: 'utf8', timeout: 60_000 });
      let parsed = null;
      try { parsed = JSON.parse(run.stdout); } catch { /* reported below */ }
      const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      results.push({
        name, version: pkg.version, imported: run.status === 0 && Boolean(parsed) && parsed.keyCount > 0,
        keyCount: parsed?.keyCount ?? 0, sample: parsed?.sample ?? [], stderr: String(run.stderr).slice(0, 600),
      });
    } finally {
      fs.rmSync(probe, { force: true });
    }
  }
  // Core inlines Pi; a leftover bare external specifier would need the node_modules copy proven above.
  const core = fs.readFileSync(path.join(runtimeDir, 'core.js'), 'utf8');
  const externalPiSpecifiers = (core.match(/(?:import|require)\(\s*["']@earendil-works\//g) ?? []).length;
  out({ ok: results.every((r) => r.imported), node: process.version, results, coreExternalPiSpecifiers: externalPiSpecifiers });
}

// --------------------------------------------------------------------- scan
const PROHIBITED_FILE_NAMES = [
  /^\.env(\..*)?$/i, /^\.npmrc$/i, /^core\.token$/i, /^core\.json$/i, /^credentials?\.json$/i, /^token\.json$/i,
  /^client_secret.*\.json$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i, /\.(pem|pfx|p12|key|kdbx)$/i, /\.(sqlite3?|db)$/i,
];
const PROHIBITED_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg']);
// Real credential material, anchored on provider-specific formats. Words such as "token" or "password" are not evidence.
const CREDENTIAL_PATTERNS = [
  ['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{40,}?-----END/],
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['openrouter-or-openai-key', /\bsk-(?:or-v1-[a-f0-9]{48,}|proj-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{48,})\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['google-oauth-client-secret', /\bGOCSPX-[0-9A-Za-z_-]{24,}\b/],
  ['google-oauth-token', /\bya29\.[0-9A-Za-z_-]{60,}\b/],
  ['slack-token', /\bxox[abprs]-[0-9A-Za-z-]{20,}\b/],
  ['bearer-literal', /\bBearer\s+[A-Za-z0-9._~+/-]{40,}={0,2}(?![A-Za-z0-9._~+/-])/],
];
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.txt', '.cmd', '.bat', '.ps1', '.yml', '.yaml', '.config', '.ini', '.html', '.md', '.map', '.env']);

function scan(root) {
  const prohibited = [];
  const credentials = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PROHIBITED_DIRS.has(entry.name.toLowerCase())) prohibited.push(full);
        else walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (PROHIBITED_FILE_NAMES.some((re) => re.test(entry.name))) { prohibited.push(full); continue; }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const size = fs.statSync(full).size;
      if (size > 64 * 1024 * 1024) continue;
      const text = fs.readFileSync(full, 'latin1');
      filesScanned += 1;
      bytesScanned += size;
      for (const [kind, pattern] of CREDENTIAL_PATTERNS) {
        const match = pattern.exec(text);
        // Report the kind and location only. The matched value is never written to the report.
        if (match) credentials.push({ file: full, kind, offset: match.index, length: match[0].length });
      }
    }
  };
  walk(root);
  out({ ok: prohibited.length === 0 && credentials.length === 0, filesScanned, bytesScanned, prohibited, credentials });
}


// -------------------------------------------------------- unauthorized-kills
async function unauthorizedKillsProbe(dataDir, decoyPid) {
  const pid = Number(decoyPid);
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
  const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
  const base = `http://127.0.0.1:${record.port}`;

  const isAlive = (target = pid) => {
    try {
      process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  };

  const dispatch = async (toolName, args, clientId = 'desktop') => {
    try {
      const res = await fetch(`${base}/v1/capabilities/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Client-Id': clientId,
        },
        body: JSON.stringify({
          correlationId: `probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          toolName,
          arguments: args,
          cwd: dataDir,
        }),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    } catch (err) {
      return { status: 0, body: null, error: String(err?.message ?? err) };
    }
  };

  const probes = {};

  // 1. system_kill_process (unattended) -> outcome 'denied', reason states machine control not authorized for unattended
  const killUnattended = await dispatch('system_kill_process', { pid }, 'core:scheduler');
  const killUnattendedOk = killUnattended.status === 200 &&
    killUnattended.body?.outcome === 'denied' &&
    typeof killUnattended.body?.reason === 'string' &&
    /not authorized|arbitrary process termination/i.test(killUnattended.body.reason) &&
    isAlive();

  // 2. system_kill_process (attended, unapproved) -> outcome 'approval_required', approval record bound to target PID
  const killAttended = await dispatch('system_kill_process', { pid }, 'desktop');
  const killAttendedOk = killAttended.status === 200 &&
    (killAttended.body?.outcome === 'approval_required' || killAttended.body?.outcome === 'requires_approval') &&
    Boolean(killAttended.body?.approval?.id) &&
    isAlive();

  // 2b. PID-reuse / unknown PID check: targeting a non-existent or unidentifiable PID is denied before approval
  const killNonExistent = await dispatch('system_kill_process', { pid: 999999 }, 'desktop');
  const killNonExistentOk = killNonExistent.status === 200 &&
    killNonExistent.body?.outcome === 'denied' &&
    /could not be identified|does not exist|not running/i.test(killNonExistent.body?.reason ?? '') &&
    isAlive();

  probes.unauthorizedKillProcess = {
    pass: killUnattendedOk && killAttendedOk && killNonExistentOk,
    killUnattendedOutcome: killUnattended.body?.outcome,
    killUnattendedReason: killUnattended.body?.reason,
    killAttendedOutcome: killAttended.body?.outcome,
    killAttendedApprovalId: killAttended.body?.approval?.id,
    killNonExistentOutcome: killNonExistent.body?.outcome,
    killNonExistentReason: killNonExistent.body?.reason,
    targetAlive: isAlive(),
  };

  // 3. port_stop_service (unowned service) -> unattended is denied; attended requires approval or refuses unowned service
  const portStopUnattended = await dispatch('port_stop_service', { serviceName: 'unrelated-decoy-service' }, 'core:scheduler');
  const portStopAttended = await dispatch('port_stop_service', { serviceName: 'unrelated-decoy-service' }, 'desktop');
  const portStopOk = isAlive() &&
    portStopUnattended.status === 200 &&
    portStopUnattended.body?.outcome === 'denied' &&
    portStopAttended.status === 200 &&
    (portStopAttended.body?.outcome === 'approval_required' ||
     portStopAttended.body?.outcome === 'requires_approval' ||
     (portStopAttended.body?.outcome === 'executed' && !String(portStopAttended.body?.result?.output).includes('successfully stopped')) ||
     portStopAttended.body?.outcome === 'denied');

  probes.unauthorizedPortControl = {
    pass: portStopOk,
    unattendedOutcome: portStopUnattended.body?.outcome,
    unattendedReason: portStopUnattended.body?.reason,
    attendedOutcome: portStopAttended.body?.outcome,
    targetAlive: isAlive(),
  };

  // 4. port_cleanup_orphans (killOrphans: true)
  // unattended -> outcome 'denied'
  const cleanupUnattended = await dispatch('port_cleanup_orphans', { killOrphans: true }, 'core:scheduler');
  const cleanupUnattendedOk = cleanupUnattended.status === 200 &&
    cleanupUnattended.body?.outcome === 'denied' &&
    isAlive();
  // attended -> unowned process refused or requires approval
  const cleanupAttended = await dispatch('port_cleanup_orphans', { killOrphans: true }, 'desktop');
  const cleanupAttendedOk = isAlive() &&
    cleanupAttended.status === 200 &&
    (cleanupAttended.body?.outcome === 'approval_required' ||
     cleanupAttended.body?.outcome === 'requires_approval' ||
     (cleanupAttended.body?.outcome === 'executed' && !String(cleanupAttended.body?.result?.output).includes(String(pid))));

  probes.unauthorizedPortCleanup = {
    pass: cleanupUnattendedOk && cleanupAttendedOk,
    unattendedOutcome: cleanupUnattended.body?.outcome,
    attendedOutcome: cleanupAttended.body?.outcome,
    targetAlive: isAlive(),
  };

  // 5. Unattended agent execution attempting machine control
  const stopServiceUnattended = await dispatch('system_stop_service', { serviceName: 'Spooler' }, 'core:scheduler');
  probes.unattendedMachineControl = {
    pass: stopServiceUnattended.status === 200 &&
      stopServiceUnattended.body?.outcome === 'denied' &&
      isAlive(),
    outcome: stopServiceUnattended.body?.outcome,
    reason: stopServiceUnattended.body?.reason,
    targetAlive: isAlive(),
  };

  // 6. Shell bypass attempt (run_command taskkill)
  const shellBypass = await dispatch('run_command', { command: `taskkill /F /PID ${pid}` }, 'desktop');
  const shellBypassOk = shellBypass.status === 200 &&
    (shellBypass.body?.outcome === 'approval_required' ||
     shellBypass.body?.outcome === 'requires_approval' ||
     shellBypass.body?.outcome === 'denied') &&
    isAlive();

  probes.unauthorizedShellBypass = {
    pass: shellBypassOk,
    outcome: shellBypass.body?.outcome,
    targetAlive: isAlive(),
  };

  const allPassed = isAlive() && Object.values(probes).every((p) => p.pass);

  out({
    ok: allPassed,
    targetPid: pid,
    targetAlive: isAlive(),
    probes,
  });
}

// ------------------------------------------------------------------ runtime
async function waitFor(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (err) { last = String(err?.message ?? err); }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function runtimeProbe(dataDir, cdpPort, timeoutSeconds) {
  const timeoutMs = timeoutSeconds * 1000;
  const report = { ok: false, steps: [] };
  const step = (name, detail) => report.steps.push({ name, at: new Date().toISOString(), detail });
  try {
    // 1) Core publishes its discovery record, then answers its real health endpoint.
    const record = await waitFor('core.json', () => {
      const file = path.join(dataDir, 'core.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    }, timeoutMs);
    step('core_record', { port: record.port, pid: record.pid ?? null });
    const base = `http://127.0.0.1:${record.port}`;
    const health = await waitFor('GET /v1/health', async () => {
      const res = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      return res.status === 200 && body?.status === 'ok' ? { httpStatus: res.status, body } : null;
    }, timeoutMs);
    report.health = health;
    step('core_health', health);

    // 2) The authenticated API accepts the stored token.
    const token = fs.readFileSync(path.join(dataDir, 'core.token'), 'utf8').trim();
    const infoRes = await fetch(`${base}/v1/core/info`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    report.coreInfo = { httpStatus: infoRes.status, body: await infoRes.json().catch(() => null) };
    step('core_info', { httpStatus: report.coreInfo.httpStatus });
    if (report.coreInfo.httpStatus !== 200) throw new Error(`/v1/core/info answered ${report.coreInfo.httpStatus}`);

    // 3) The desktop host, through the real renderer bridge over the Chrome DevTools protocol.
    const page = await waitFor('cdp page', async () => {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
      return pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl) ?? null;
    }, timeoutMs);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('cdp socket error')), { once: true }); });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    });
    const evaluate = async (expression) => {
      const id = nextId++;
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => { return (${expression}); })()`, awaitPromise: true, returnByValue: true } }));
      });
      if (result.exceptionDetails) throw new Error(`eval: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
      return result.result?.value;
    };
    try {
      await waitFor('desktop bridge', () => evaluate('Boolean(window.karkedikhaDesktop)'), timeoutMs);
      const snapshot = await waitFor('core connected in the desktop host', async () => {
        const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        return s?.coreState === 'connected' ? s : null;
      }, timeoutMs);
      report.snapshot = {
        coreState: snapshot.coreState, model: snapshot.model ?? null, modelAvailable: snapshot.modelAvailable ?? null,
        installedModels: snapshot.installedModels ?? null, running: snapshot.running ?? null,
      };
      step('desktop_core_connected', report.snapshot);

      // 4) With no Ollama and no model, the UI and the submit path must say so rather than pretend.
      await waitFor('models badge', async () => {
        const text = await evaluate("document.getElementById('integ-models-badge')?.textContent ?? ''");
        return text && !/^Checking/i.test(text) ? text : null;
      }, 60_000).then((text) => { report.modelsBadge = text; });
      step('models_badge', report.modelsBadge);
      report.submit = await evaluate(
        "window.karkedikhaDesktop.submitTask('Hello Pandesh, are you there?', 'local-core').then((r) => ({ accepted: true, result: r }), (e) => ({ accepted: false, message: String((e && e.message) || e) }))",
      );
      step('submit_without_ollama', report.submit);
      report.snapshotAfterSubmit = await evaluate('window.karkedikhaDesktop.getSnapshot().then((s) => ({ running: s.running, coreState: s.coreState }))');
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
    report.ok = true;
  } catch (err) {
    report.error = String(err?.message ?? err);
  }
  out(report);
}

try {
  if (command === 'pi-import') piImport(args[0]);
  else if (command === 'scan') scan(args[0]);
  else if (command === 'runtime') await runtimeProbe(args[0], args[1], Number(args[2] ?? 150));
  else if (command === 'unauthorized-kills') await unauthorizedKillsProbe(args[0], args[1]);
  else { out({ ok: false, error: `unknown command ${command}` }); process.exitCode = 2; }
} catch (err) {
  out({ ok: false, error: String(err?.message ?? err) });
  process.exitCode = 1;
}
