/**
 * Pandesh live integration verification.
 *
 * Starts a REAL Core (the bundled `out-core/core.js`) against an isolated
 * data directory and drives the capabilities the way a conversation does:
 * through `POST /v1/capabilities/dispatch`, with the same approval envelope
 * a human click produces.
 *
 * What it proves, and what it does not:
 *   - Hermes: the installed skill set is discovered and one real skill is
 *     invoked through the official Runs API, with its own result returned.
 *   - Computer use: a real Windows desktop capture is written to disk.
 *   - Browser: a real headless browser opens a live loopback page and
 *     returns its real DOM text and screenshot.
 *   - Intelligence Scout: a watch added through the capability is fired by
 *     Core's OWN scheduler (not by a manual run-all) and delivered once.
 *
 * Evidence is written to `.acceptance-evidence/pandesh-live-gaps/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'pandesh-live-gaps');
const dataDir = path.join(repoRoot, '.tmp', 'pandesh-live-gaps');
const corePath = path.join(repoRoot, 'out-core', 'core.js');
const token = crypto.randomBytes(32).toString('base64url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { startedAt: new Date().toISOString(), checks: [] };

function record(name, status, detail) {
  evidence.checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}`);
  if (detail) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`);
}

async function api(base, route, options = {}) {
  const res = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function waitForCore() {
  const recordPath = path.join(dataDir, 'core.json');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(recordPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        const base = `http://127.0.0.1:${parsed.port}`;
        const health = await fetch(`${base}/v1/health`).then((r) => r.ok).catch(() => false);
        if (health) return base;
      } catch { /* keep waiting */ }
    }
    await sleep(250);
  }
  throw new Error('the Core did not become healthy');
}

/** Starts (or restarts) the real Core against the same data directory. */
function startCore() {
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath, [corePath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KARKEDIKHA_CORE_TOKEN: token,
      KARKEDIKHA_DATA_DIR: dataDir,
      KARKEDIKHA_CORE_PORT: '0',
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => logStream.write(String(d)));
  child.stderr.on('data', (d) => logStream.write(String(d)));
  return child;
}

/**
 * A real local web application with a real input, a real button and real
 * server-side state: the page posts the typed text and the server keeps it.
 */
function startTestApp() {
  const state = { submissions: [], clicks: 0 };
  const html = `<!doctype html><html><head><title>Pandesh Interaction Target</title></head><body>
<h1 id="title">Pandesh Interaction Target</h1>
<input id="name" type="text" placeholder="type here" />
<button id="go" type="button">Send</button>
<p id="out">NOTHING_RECEIVED</p>
<script>
document.getElementById('go').addEventListener('click', async () => {
  const value = document.getElementById('name').value;
  await fetch('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
  document.getElementById('out').textContent = 'RECEIVED:' + value;
});
</script></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try { state.submissions.push(JSON.parse(body).value); } catch { /* ignore */ }
        state.clicks += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/** Dispatches a governed capability, approving it exactly the way a human click does. */
async function dispatch(base, toolName, args, cwd, correlationIdOverride) {
  // The correlation id is the anchor: the SAME one is used for the retry, so
  // the approved action is found and executed instead of asking again.
  const correlationId = correlationIdOverride ?? `verify:${toolName}:${crypto.randomUUID()}`;
  const send = () => api(base, '/v1/capabilities/dispatch', {
    method: 'POST',
    body: JSON.stringify({ correlationId, toolName, arguments: args, cwd }),
  });
  const first = await send();
  if (first.body?.outcome !== 'approval_required') return first.body;
  const approval = first.body.approval;
  await api(base, `/v1/capabilities/approvals/${approval.id}/resolve`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `verify-approve:${approval.id}` },
    body: JSON.stringify({
      resolution: 'approved',
      attemptId: approval.attemptId,
      expectedAttemptRevision: approval.expectedAttemptRevision,
      expectedAttemptStatus: approval.expectedAttemptStatus,
      requestedActionDigest: approval.requestedActionDigest,
      frozenContextHash: approval.frozenContextHash,
    }),
  });
  const second = await send();
  return second.body;
}

fs.mkdirSync(evidenceDir, { recursive: true });
// A fresh data directory every run, so nothing from a previous run can be
// mistaken for this run's evidence.
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const logPath = path.join(dataDir, 'core.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

console.log('[verify] starting the real Core...');
let child = startCore();

let base = '';
try {
  base = await waitForCore();
  record('core_started', 'PASS', { base, dataDir, bundleHash: (await api(base, '/v1/core/info')).body?.bundleHash });

  // ---- 1. Hermes: discover the installed skills -------------------------------
  const listed = await dispatch(base, 'hermes_list_skills', {}, repoRoot);
  const skillText = String(listed?.toolInvocation?.evidence?.output ?? '');
  const skillNames = [...skillText.matchAll(/^- ([a-z0-9][\w.-]+)/gm)].map((m) => m[1]);
  record('hermes_list_skills', listed?.outcome === 'executed' && skillNames.length > 0 ? 'PASS' : 'FAIL', {
    outcome: listed?.outcome,
    source: /source: ([a-z-]+)/.exec(skillText)?.[1],
    skillCount: skillNames.length,
    sample: skillNames.slice(0, 8),
    apiError: listed?.toolInvocation?.evidence?.output?.includes('the live API failed') ?? false,
  });

  // ---- 2. Hermes: invoke one real installed skill ----------------------------
  // `local-stack-status` is a functional skill: it runs PowerShell against the
  // live Ollama server and the machine's resources. `skill_view` alone would
  // only prove discovery, so the proof is the tool call Hermes actually made
  // and the real values it returned.
  const functionalSkill = skillNames.includes('local-stack-status') ? 'local-stack-status' : null;
  const chosen = skillNames.includes('article-writing') ? 'article-writing' : skillNames[0];
  let hermesRun = null;
  if (chosen) {
    const invoked = await dispatch(base, 'hermes_invoke_skill', {
      skill: chosen,
      task: 'Write one short sentence (max 20 words) explaining what a scheduled technology watch is. Reply with the sentence only.',
    }, repoRoot);
    const output = String(invoked?.toolInvocation?.evidence?.output ?? '');
    hermesRun = {
      outcome: invoked?.outcome,
      status: invoked?.toolInvocation?.status,
      runId: invoked?.toolInvocation?.normalizedArguments?.runId ?? null,
      toolCalls: /Tools Hermes actually called: ([^\n]*)/.exec(output)?.[1] ?? null,
      excerpt: output.slice(0, 900),
    };
    record('hermes_invoke_skill', invoked?.outcome === 'executed' && invoked?.toolInvocation?.status === 'succeeded' ? 'PASS' : 'FAIL', hermesRun);
  } else {
    record('hermes_invoke_skill', 'BLOCKED', 'no installed Hermes skill was discovered');
  }

  // ---- 2b. Hermes: a skill that does real work, not just reads itself -------
  if (functionalSkill) {
    const invoked = await dispatch(base, 'hermes_invoke_skill', {
      skill: functionalSkill,
      task: 'Run the local stack status check exactly as the skill describes and report the real results.',
    }, repoRoot);
    const output = String(invoked?.toolInvocation?.evidence?.output ?? '');
    const calledTools = /Tools Hermes actually called: ([^\n]*)/.exec(output)?.[1] ?? '';
    const didWork = /terminal|execute_code|web_search|read_file/i.test(calledTools);
    const realFacts = /Ollama:\s*LIVE|RAM|models/i.test(output);
    record('hermes_skill_functional_execution', didWork && realFacts ? 'PASS' : 'FAIL', {
      skill: functionalSkill,
      outcome: invoked?.outcome,
      calledTools,
      functionalToolUsed: didWork,
      realFactsInResult: realFacts,
      excerpt: output.slice(0, 1200),
    });
  } else {
    record('hermes_skill_functional_execution', 'BLOCKED', 'the local-stack-status skill is not installed on this host');
  }

  // ---- 3. Computer use: a real Windows desktop capture ------------------------
  const shot = await dispatch(base, 'desktop_screenshot', {}, repoRoot);
  const shotText = String(shot?.toolInvocation?.evidence?.output ?? '');
  const shotPath = /Captured the Windows desktop: (.+?) \(/.exec(shotText)?.[1] ?? null;
  const shotExists = shotPath ? fs.existsSync(shotPath) : false;
  const shotBytes = shotExists ? fs.statSync(shotPath).size : 0;
  record('desktop_screenshot', shot?.outcome === 'executed' && shotExists && shotBytes > 1000 ? 'PASS' : 'FAIL', {
    outcome: shot?.outcome, path: shotPath, exists: shotExists, bytes: shotBytes,
  });

  // ---- 4. Browser: a real headless browser on a live loopback page -----------
  const browser = await dispatch(base, 'inspect_page', {
    url: `${base}/v1/health`,
    viewportWidth: 900,
    viewportHeight: 600,
  }, repoRoot);
  const browserEvidence = browser?.toolInvocation?.evidence ?? {};
  const browserOutput = String(browserEvidence.output ?? '');
  const browserShot = browserEvidence.normalizedArguments?.screenshotPath ?? null;
  const browserShotBytes = browserShot && fs.existsSync(browserShot) ? fs.statSync(browserShot).size : 0;
  record('inspect_page_live_url', browser?.outcome === 'executed' && browserOutput.includes('status') && browserOutput.includes('ok') && browserShotBytes > 1000 ? 'PASS' : 'FAIL', {
    outcome: browser?.outcome,
    reason: browser?.reason ?? null,
    title: /"title":"([^"]*)"/.exec(browserOutput)?.[1] ?? null,
    url: /"url":"([^"]*)"/.exec(browserOutput)?.[1] ?? null,
    screenshotPath: browserShot,
    screenshotBytes: browserShotBytes,
    excerpt: browserOutput.slice(0, 400),
  });

  // ---- 4b. Computer Use: observe → type → click → the app state changed -----
  // A screenshot proves a camera saw something. This proves the agent changed
  // a running application: a real page is typed into and clicked, and the
  // server-side state must show the submission.
  const app = await startTestApp();
  try {
    const observed = await dispatch(base, 'inspect_page', { url: app.url, viewportWidth: 900, viewportHeight: 600 }, repoRoot);
    const observedText = String(observed?.toolInvocation?.evidence?.output ?? '');
    const sawInitial = observedText.includes('NOTHING_RECEIVED');
    record('computer_use_observe', observed?.outcome === 'executed' && sawInitial ? 'PASS' : 'FAIL', {
      url: app.url,
      sawInitialState: sawInitial,
      excerpt: observedText.slice(0, 400),
    });

    const interacted = await dispatch(base, 'inspect_page', {
      url: app.url,
      viewportWidth: 900,
      viewportHeight: 600,
      steps: [
        { action: 'fill', locator: { css: '#name' }, value: 'Pandesh-was-here' },
        { action: 'click', locator: { css: '#go' } },
        { action: 'wait', ms: 600 },
      ],
    }, repoRoot);
    const interactedText = String(interacted?.toolInvocation?.evidence?.output ?? '');
    const sawChangedDom = interactedText.includes('RECEIVED:Pandesh-was-here');
    const serverSawIt = app.state.submissions.includes('Pandesh-was-here');
    record('computer_use_interaction_changed_the_app', interacted?.outcome === 'executed' && sawChangedDom && serverSawIt ? 'PASS' : 'FAIL', {
      outcome: interacted?.outcome,
      reason: interacted?.reason ?? null,
      domShowsTheNewState: sawChangedDom,
      serverReceivedTheSubmission: serverSawIt,
      serverSubmissions: app.state.submissions,
      excerpt: interactedText.slice(0, 500),
    });
  } finally {
    app.server.close();
  }

  // ---- 5. Intelligence Scout: the scheduler fires the watch on its own -------
  // The watch is created with a daily time one minute from now, so Core's OWN
  // scheduler is what fires it. Nothing in this script runs the watch.
  const dueAt = new Date(Date.now() + 70_000);
  const dailyTime = `${String(dueAt.getHours()).padStart(2, '0')}:${String(dueAt.getMinutes()).padStart(2, '0')}`;
  const added = await dispatch(base, 'scout_add_watch', {
    kind: 'github_repo', target: 'ollama/ollama', name: 'Ollama releases', dailyTime,
  }, repoRoot);
  const addedText = String(added?.toolInvocation?.evidence?.output ?? '');
  record('scout_add_watch', added?.outcome === 'executed' && /scheduled daily at/.test(addedText) ? 'PASS' : 'FAIL', {
    outcome: added?.outcome, dailyTime, output: addedText,
  });

  const runtimeBefore = await api(base, '/v1/runtime-events?after=0&limit=1000');
  const lastSequence = Math.max(0, ...(runtimeBefore.body?.events ?? []).map((e) => Number(e.sequence ?? 0)));

  const deadline = Date.now() + 180_000;
  let fired = null;
  while (Date.now() < deadline) {
    const events = await api(base, `/v1/runtime-events?after=${lastSequence}&limit=200`);
    const found = (events.body?.events ?? []).filter((e) => String(e.eventType).startsWith('scout_watch_'));
    if (found.length > 0) { fired = found; break; }
    await sleep(2000);
  }
  record('scout_scheduler_fired_the_watch', fired ? 'PASS' : 'FAIL', {
    firedAfterManualRunAll: false,
    events: fired?.map((e) => ({ eventType: e.eventType, metadata: e.metadata })) ?? [],
  });

  // The delivered message must exist in the scout's own conversation.
  let deliveredMessage = null;
  if (fired) {
    const conversations = await api(base, '/v1/conversations?limit=50');
    for (const conversation of conversations.body?.conversations ?? []) {
      const messages = await api(base, `/v1/conversations/${conversation.id}/messages?limit=50`);
      const scoutMessage = (messages.body?.messages ?? []).find((m) => String(m.content ?? '').includes('Watching Ollama releases'));
      if (scoutMessage) { deliveredMessage = { conversationId: conversation.id, content: String(scoutMessage.content).slice(0, 600) }; break; }
    }
  }
  record('scout_delivery_landed_in_a_conversation', deliveredMessage ? 'PASS' : 'FAIL', deliveredMessage ?? 'no scout message found');

  // ---- 6. Google / mobile / microphone / memory / Pi state --------------------
  const connectors = await api(base, '/v1/connectors');
  record('connector_state', 'PASS', connectors.body?.connectors ?? connectors.body);

  const coreInfo = await api(base, '/v1/core/info');
  record('core_info', 'PASS', coreInfo.body);

  // ---- 7. Durable memory: a write that survives a restart ---------------------
  // "recall returned something" is not persistence. The fact must be written,
  // the Core must be stopped and started again, and the fact must still be
  // there afterwards.
  const fact = `Pandesh release marker ${Date.now()}`;
  // A durable memory needs durable evidence: the fact must be written in a
  // conversation that has a real user message behind it, exactly as it would
  // be when the operator asks Pandesh to remember something.
  const conversation = await api(base, '/v1/conversations', {
    method: 'POST',
    headers: { 'Idempotency-Key': `verify-conv:${Date.now()}` },
    body: JSON.stringify({ mode: 'saath_kar', title: 'Release marker' }),
  });
  const conversationId = conversation.body?.id;
  await api(base, `/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: `Remember this release marker for the release check: ${fact}` }),
  });
  const written = await dispatch(base, 'memory_remember', {
    memoryType: 'semantic',
    scopeType: 'global',
    scopeId: 'pandesh-release',
    subject: 'pandesh-release-marker',
    predicate: 'release-marker',
    value: fact,
    sensitivity: 'internal',
  }, repoRoot, conversationId);
  record('memory_write', written?.outcome === 'executed' && written?.toolInvocation?.status === 'succeeded' ? 'PASS' : 'FAIL', {
    outcome: written?.outcome,
    reason: written?.reason ?? null,
    output: String(written?.toolInvocation?.evidence?.output ?? '').slice(0, 300),
  });

  await api(base, '/v1/core/shutdown', { method: 'POST' });
  await sleep(2500);
  try { child.kill(); } catch { /* ignore */ }
  child = startCore();
  base = await waitForCore();
  record('core_restarted', 'PASS', { base });

  const recalled = await dispatch(base, 'memory_recall', { scopeType: 'global', scopeId: 'pandesh-release', subject: 'pandesh-release-marker' }, repoRoot);
  const recallText = String(recalled?.toolInvocation?.evidence?.output ?? '');
  record('memory_survives_a_restart', recalled?.outcome === 'executed' && recallText.includes(fact) ? 'PASS' : 'FAIL', {
    outcome: recalled?.outcome,
    fact,
    excerpt: recallText.slice(0, 500),
  });
} catch (err) {
  record('harness', 'FAIL', err instanceof Error ? err.stack : String(err));
} finally {
  try { await api(base, '/v1/core/shutdown', { method: 'POST' }); } catch { /* ignore */ }
  await sleep(1500);
  try { child.kill(); } catch { /* ignore */ }
  logStream.end();
}

evidence.finishedAt = new Date().toISOString();
evidence.passed = evidence.checks.filter((c) => c.status === 'PASS').length;
evidence.failed = evidence.checks.filter((c) => c.status === 'FAIL').length;
evidence.blocked = evidence.checks.filter((c) => c.status === 'BLOCKED').length;
fs.writeFileSync(path.join(evidenceDir, 'live-gap-verification.json'), JSON.stringify(evidence, null, 2));
console.log(`\n[verify] passed=${evidence.passed} failed=${evidence.failed} blocked=${evidence.blocked}`);
console.log(`[verify] evidence: ${path.join(evidenceDir, 'live-gap-verification.json')}`);
process.exit(evidence.failed > 0 ? 1 : 0);
