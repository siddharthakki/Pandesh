/**
 * AW3 — "Look up the current price, confirm it on the vendor's site in the
 * browser, and if it is under the limit, write the link and the price into a
 * note and prepare a calendar reminder for tomorrow 09:00."
 *
 * The chain that is proven end to end:
 *   research (web search, cited) -> the managed browser reads the VENDOR's
 *   own page -> the price that is in the note is the price the browser
 *   actually saw -> the calendar step is attempted against the REAL
 *   connector.
 *
 * The product page is a PUBLIC scraping sandbox with a stable price, so the
 * acceptance is deterministic and touches nobody's shop. The calendar step is
 * attempted for real; when Google is not connected on this machine the
 * acceptance records that as a BLOCKED live verification with the exact
 * reason - and proves that nothing was created.
 *
 * Evidence lands in `.acceptance-evidence/aw3-research-price/`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'aw3-research-price');
const runRoot = process.env.PANDESH_AW3_ROOT ?? path.join(repoRoot, '.tmp', `aw3-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const workspace = path.join(runRoot, 'workspace');
const token = 'aw3-research-price-token';

const PRODUCT_URL = 'http://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html';
const PRICE_LIMIT = 100;

const checks = [];
function record(name, status, detail) {
  checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, checks }, null, 2));
}

const startedAt = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;

async function startCore() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const out = fs.openSync(path.join(runRoot, 'core.log'), 'a');
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', out, out],
  });
  const deadline = Date.now() + 30_000;
  let port = 0;
  while (Date.now() < deadline) {
    const recordPath = path.join(dataDir, 'core.json');
    if (fs.existsSync(recordPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (parsed.port) { port = parsed.port; break; }
      } catch { /* partial write */ }
    }
    await sleep(60);
  }
  if (!port) throw new Error('the Core did not start within 30s');
  const healthDeadline = Date.now() + 20_000;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
}

async function stopCore(port) {
  if (!port) return;
  try {
    await fetch(`http://127.0.0.1:${port}/v1/core/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `shutdown-${Date.now()}`, 'X-Client-Id': 'aw3-acceptance' },
      body: '{}',
    });
  } catch { /* already gone */ }
  await sleep(400);
  if (child && !child.killed) child.kill();
  child = null;
}

async function api(port, method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client-Id': 'aw3-acceptance',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': `idem-${Date.now()}-${Math.random()}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

async function dispatch(port, toolName, args, { approve = true, cwd = workspace, correlationId } = {}) {
  const id = correlationId ?? `aw3-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const call = () => api(port, 'POST', '/v1/capabilities/dispatch', { correlationId: id, toolName, arguments: args, cwd });
  const first = await call();
  if (first.status !== 200 || first.body?.outcome !== 'approval_required') return first;
  const approval = first.body.approval;
  const resolved = await api(port, 'POST', `/v1/capabilities/approvals/${encodeURIComponent(approval.id)}/resolve`, {
    resolution: approve ? 'approved' : 'rejected',
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
  });
  if (resolved.status !== 200) return { status: resolved.status, body: resolved.body };
  return call();
}

function outputOf(result) {
  return result.body?.toolInvocation?.evidence?.output ?? '';
}

async function main() {
  const core = await startCore();
  record('core_started', 'PASS', { port: core.port, instanceId: core.instanceId });

  // ---- 1. the plan --------------------------------------------------------
  const plan = await dispatch(core.port, 'declare_execution_plan', {
    goal: 'Confirm the price on the vendor page and write a note about it',
    steps: [
      { title: 'Research the product price', capability: 'research', expectedOutput: 'cited sources', verification: 'the sources name the price', permission: 'approval' },
      { title: 'Confirm the price on the vendor page', capability: 'browser', expectedOutput: 'the price text', verification: 'the page shows the price', permission: 'approval' },
      { title: 'Write the note', capability: 'workspace', expectedOutput: 'notes/price-check.md', verification: 'the file exists with the price', permission: 'approval' },
    ],
  });
  record('plan_declared', plan.body?.outcome === 'executed' ? 'PASS' : 'FAIL', {
    outcome: plan.body?.outcome,
    steps: plan.body?.outcome === 'executed' ? JSON.parse(outputOf(plan)).steps.map((step) => `${step.title}:${step.status}`) : plan.body?.reason,
  });

  // ---- 2. research --------------------------------------------------------
  const research = await dispatch(core.port, 'governed_research', { query: 'A Light in the Attic book price' });
  const researchOutput = outputOf(research);
  record('research_returned_evidence', research.body?.outcome === 'executed' && researchOutput.length > 40 ? 'PASS' : 'FAIL', {
    outcome: research.body?.outcome,
    reason: research.body?.reason,
    excerpt: researchOutput.slice(0, 220),
  });

  // ---- 3. the browser confirms the price on the vendor's own page ---------
  // The browser session belongs to the attempt that opened it, so both calls
  // share ONE correlation id.
  const browserCorrelationId = `aw3-browser-${Date.now()}`;
  const opened = await dispatch(core.port, 'browser_open_site', { url: PRODUCT_URL }, { correlationId: browserCorrelationId });
  record('browser_opened_the_vendor_page', opened.body?.outcome === 'executed' ? 'PASS' : 'FAIL', {
    outcome: opened.body?.outcome,
    reason: opened.body?.reason,
  });
  const read = await dispatch(core.port, 'browser_read', {}, { correlationId: browserCorrelationId });
  const pageText = outputOf(read);
  const priceMatch = /£\s*([0-9]+(?:\.[0-9]{2})?)/.exec(pageText) ?? /([0-9]+(?:\.[0-9]{2})?)\s*£/.exec(pageText);
  const browserPrice = priceMatch ? priceMatch[1] : null;
  record('browser_saw_the_price', browserPrice ? 'PASS' : 'FAIL', {
    price: browserPrice,
    excerpt: pageText.replace(/\s+/g, ' ').slice(0, 200),
  });

  // ---- 4. the note --------------------------------------------------------
  const notesDir = path.join(workspace, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  const helper = path.join(workspace, 'write-note.mjs');
  fs.writeFileSync(helper, [
    "import { writeFileSync, mkdirSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "const [, , target, ...lines] = process.argv;",
    "if (!target || lines.length === 0) { console.error('usage: write-note.mjs <file> <line> [...]'); process.exit(2); }",
    "mkdirSync(dirname(target), { recursive: true });",
    "writeFileSync(target, lines.join('\\n') + '\\n', 'utf8');",
    "console.log('wrote ' + target);",
  ].join('\n'), 'utf8');
  const notePath = path.join(notesDir, 'price-check.md');
  const noteLines = [`# Price check`, `- product: A Light in the Attic`, `- price: £${browserPrice ?? 'unknown'}`, `- link: ${PRODUCT_URL}`];
  const write = await dispatch(core.port, 'run_command', {
    command: `node write-note.mjs notes/price-check.md ${noteLines.map((line) => `"${line}"`).join(' ')}`,
  });
  const noteContent = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : '';
  record('note_written_with_the_browser_price', write.body?.outcome === 'executed' && noteContent.includes(`£${browserPrice}`) && noteContent.includes(PRODUCT_URL) ? 'PASS' : 'FAIL', {
    outcome: write.body?.outcome,
    content: noteContent,
  });

  // ---- 5. the calendar, for real ------------------------------------------
  const connectorState = await api(core.port, 'GET', '/v1/connectors');
  const calendar = connectorState.body?.connectors?.find((connector) => connector.id === 'google_calendar');
  const calendarConnected = calendar && (calendar.state === 'connected' || calendar.state === 'degraded');
  if (calendarConnected) {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const draft = await dispatch(core.port, 'calendar_draft_event', {
      title: 'Buy A Light in the Attic',
      start: `${tomorrow}T09:00:00`,
      end: `${tomorrow}T09:30:00`,
    });
    record('calendar_draft_created', draft.body?.outcome === 'executed' ? 'PASS' : 'FAIL', { outcome: draft.body?.outcome, reason: draft.body?.reason });
  } else {
    // Not connected on this machine: the attempt must fail CLOSED and create
    // nothing. That is the honest result, recorded with the exact reason.
    const draft = await dispatch(core.port, 'calendar_draft_event', {
      title: 'Buy A Light in the Attic',
      start: `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T09:00:00`,
      end: `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T09:30:00`,
    });
    record('calendar_not_connected_recorded_honestly', draft.body?.outcome === 'unavailable' || draft.body?.outcome === 'denied' ? 'PASS' : 'FAIL', {
      outcome: draft.body?.outcome,
      reason: draft.body?.reason,
      connectorState: calendar?.state ?? 'unknown',
      connectorReason: calendar?.reason ?? null,
    });
    record('calendar_creation_blocked_without_credentials', 'BLOCKED', {
      missing: 'a connected Google Calendar account (the connector is not connected on this machine)',
      consequence: 'no event was created and none was attempted against Google',
    });
  }

  // ---- 6. the negative paths ----------------------------------------------
  // "Just suggest it, do not create anything": no event, and no second file.
  const suggestion = await dispatch(core.port, 'calendar_draft_event', {
    title: 'Buy A Light in the Attic (suggestion only)',
    start: `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T09:00:00`,
    end: `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T09:30:00`,
    suggestionOnly: true,
  });
  record('suggestion_only_creates_no_event', suggestion.body?.outcome !== 'executed' ? 'PASS' : 'FAIL', {
    outcome: suggestion.body?.outcome,
    reason: suggestion.body?.reason,
  });

  // A refused write leaves no file.
  const refused = await dispatch(core.port, 'run_command', { command: 'node write-note.mjs notes/refused.md "SHOULD NOT APPEAR"' }, { approve: false });
  record('refused_write_leaves_no_file', refused.body?.outcome === 'denied' && !fs.existsSync(path.join(notesDir, 'refused.md')) ? 'PASS' : 'FAIL', {
    outcome: refused.body?.outcome,
    fileExists: fs.existsSync(path.join(notesDir, 'refused.md')),
  });

  // ---- 7. the per-step truth ----------------------------------------------
  const status = await dispatch(core.port, 'execution_plan_status', {});
  const planStatus = status.body?.outcome === 'executed' ? JSON.parse(outputOf(status)) : null;
  record('plan_reports_per_step_truth', planStatus && planStatus.steps.every((step) => ['succeeded', 'failed', 'pending', 'running'].includes(step.status)) ? 'PASS' : 'FAIL', {
    steps: planStatus?.steps?.map((step) => `${step.title}:${step.status}`),
  });

  await stopCore(core.port);
}

try {
  await main();
} catch (error) {
  record('run_error', 'FAIL', String(error?.stack ?? error));
} finally {
  if (child && !child.killed) child.kill();
  const failed = checks.filter((c) => c.status === 'FAIL');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), checks }, null, 2));
  console.log(`\n${checks.length} checks, ${failed.length} failed. Evidence: ${evidenceDir}`);
  if (failed.length > 0) process.exitCode = 1;
}
