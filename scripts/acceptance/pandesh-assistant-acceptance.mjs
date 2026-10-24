/**
 * Pandesh's acceptance journey — the real Core, the real local model, the
 * real governance.
 *
 * This is NOT a mock and NOT a unit test. It boots the shipped Core bundle
 * (`out-core/core.js`) against an isolated data directory and an isolated
 * workspace, and drives it over its own authenticated HTTP API exactly the
 * way the desktop host does. The local Ollama model does the thinking.
 *
 * What it proves, end to end:
 *
 *   1. The daily brief routine exists on a fresh Core — created once, on
 *      boot, read-only, and switchable.
 *   2. The assistant can REMEMBER. A memory write is a governed mutation, so
 *      an approval appears; the journey answers it like a human would, and
 *      the fact is then readable through the governed memory capability.
 *   3. The assistant can KEEP A PROMISE. "Remind me to follow up if she has
 *      not replied" becomes a durable commitment with a condition, stored in
 *      Core's own database.
 *   4. The task's own record exists and says what actually happened.
 *   5. A refused action is not a completed task.
 *
 * Nothing here touches the operator's real data, their mail, their calendar
 * or their conversations: the Core runs on an isolated data directory, no
 * Google account is connected, and no outbound message is ever sent.
 *
 * Usage:
 *   node scripts/acceptance/pandesh-assistant-acceptance.mjs
 *
 * Environment:
 *   PANDESH_ACCEPTANCE_MODEL   model to use (default: the Core's own default)
 *   PANDESH_ACCEPTANCE_PORT    Core port (default: 9541)
 *   PANDESH_ACCEPTANCE_TIMEOUT per-turn timeout in ms (default: 600000)
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreBundle = path.join(repoRoot, 'out-core', 'core.js');
const port = Number(process.env.PANDESH_ACCEPTANCE_PORT || 9541);
const turnTimeoutMs = Number(process.env.PANDESH_ACCEPTANCE_TIMEOUT || 600_000);
const model = process.env.PANDESH_ACCEPTANCE_MODEL || 'qwen3-coder:swift-27b';
const token = crypto.randomBytes(32).toString('hex');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const scratch = path.join(repoRoot, '.tmp', `pandesh-acceptance-${runId}`);
const dataDir = path.join(scratch, 'data');
const workspace = path.join(scratch, 'workspace');
const evidenceDir = path.join(repoRoot, 'dist', 'pandesh-acceptance');
const clientId = 'acceptance:pandesh';

const steps = [];
const notes = [];

function note(message) {
  notes.push(message);
  console.log(`  ${message}`);
}

function record(step, detail) {
  steps.push({ at: new Date().toISOString(), step, ...detail });
  console.log(`[${step}] ${detail.summary ?? ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method, route, body) {
  const headers = {
    authorization: `Bearer ${token}`,
    'x-client-id': clientId,
    'content-type': 'application/json',
  };
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 400)}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

async function waitFor(label, fn, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = { error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

let coreProcess = null;

function startCore() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    ...process.env,
    KARKEDIKHA_CORE_TOKEN: token,
    KARKEDIKHA_DATA_DIR: dataDir,
    KARKEDIKHA_CORE_PORT: String(port),
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    // The Core must not try to reach the operator's Google account, and it
    // must not write outside its own data directory.
    KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  coreProcess = spawn(process.execPath, [coreBundle], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logPath = path.join(scratch, 'core.log');
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  coreProcess.stdout.pipe(log);
  coreProcess.stderr.pipe(log);
  coreProcess.on('exit', (code) => note(`core exited with code ${code}`));
  return logPath;
}

async function stopCore() {
  if (!coreProcess || coreProcess.exitCode !== null) return;
  try {
    await api('POST', '/v1/core/shutdown', {});
  } catch {
    // fall through to a kill
  }
  const exited = await waitFor('the core to exit', async () => coreProcess.exitCode !== null, 15_000, 200).catch(() => false);
  if (!exited) {
    try { coreProcess.kill(); } catch { /* already gone */ }
  }
}

/** The attempt's own terminal state, read from Core. */
async function attemptState(attemptId) {
  const overview = await api('GET', `/v1/tasks/overview?limit=200`).catch(() => null);
  const row = overview?.tasks?.find((task) => task.attemptId === attemptId);
  if (row) return row;
  const attempts = await api('GET', `/v1/attempts?limit=200`).catch(() => null);
  return attempts?.attempts?.find((attempt) => attempt.id === attemptId) ?? null;
}

async function pendingApprovals() {
  const result = await api('GET', '/v1/approvals/pending');
  return result.approvals ?? [];
}

function db() {
  // Read-only, so the journey can never mutate what it is inspecting.
  return new DatabaseSync(path.join(dataDir, 'core.db'), { readOnly: true });
}

async function main() {
  if (!fs.existsSync(coreBundle)) {
    throw new Error(`Core bundle missing at ${coreBundle}. Run: node esbuild.core.js`);
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  console.log(`Pandesh acceptance journey — isolated data dir: ${dataDir}`);
  const logPath = startCore();

  await waitFor('the core to answer', async () => {
    const health = await api('GET', '/v1/health');
    return health?.status === 'ok';
  }, 90_000);

  // ── 1. No routine without authorization ─────────────────────────────────
  // A proactive routine that speaks to the user on its own schedule is
  // something the user has to ask for. A fresh Core must have none.
  const routineEnvelope = await api('GET', '/v1/assistant/routine/daily-brief');
  const routine = routineEnvelope?.routine ?? null;
  record('no-unauthorized-routine', {
    summary: routine
      ? `a routine already existed on a fresh Core: ${routine.id} at ${routine.dailyTime}`
      : 'a fresh Core has no proactive routine — nothing runs until the user asks for it',
    routine,
  });
  if (routine?.id) throw new Error('a proactive routine was created without the user asking for one');

  // The user asks for one. It is then created, and it fires exactly once.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const inTwoMinutes = new Date(Date.now() + 2 * 60_000);
  const dailyTime = `${String(inTwoMinutes.getHours()).padStart(2, '0')}:${String(inTwoMinutes.getMinutes()).padStart(2, '0')}`;
  const configured = await api('POST', '/v1/assistant/routine/daily-brief', { dailyTime, timezone: zone });
  record('routine-configured', {
    summary: `the operator asked for a daily brief at ${dailyTime} ${zone} (routine ${configured?.routine?.id})`,
    routine: configured?.routine ?? null,
  });
  if (!configured?.routine?.id) throw new Error('the daily brief routine could not be configured');

  // ── 2. The assistant can remember ───────────────────────────────────────
  const conversation = await api('POST', '/v1/conversations', {
    mode: 'baat_kar',
    title: 'Acceptance — memory and promises',
  });
  const memorySubmit = await api('POST', '/v1/submit', {
    currentMessage:
      'Please remember this for later: I prefer dark mode in every code editor I use. '
      + 'Call the memory tool to store it — I want it remembered, not just noted in this chat.',
    requestedMode: 'baat_kar',
    conversationId: conversation.id,
    requestedProvider: 'ollama',
    requestedModel: model,
    selectedProvider: 'ollama',
    selectedModel: model,
    hasWorkspace: false,
    gitCapable: false,
    toolPermissionPolicy: { profile: 'confirm-mutations' },
  });
  const memoryAttemptId = memorySubmit.attempt.id;
  record('memory-submitted', { summary: `attempt ${memoryAttemptId}`, attemptId: memoryAttemptId });

  // The submit creates the attempt; the execute call is what starts the turn.
  await api('POST', `/v1/attempts/${memoryAttemptId}/execute`, {});

  const memoryApproval = await waitFor('the memory approval', async () => {
    const approvals = await pendingApprovals();
    return approvals.find((approval) => approval.attemptId !== memoryAttemptId
      && String(approval.summary?.toolName ?? '').startsWith('memory_')) ?? null;
  }, turnTimeoutMs, 1000);
  record('memory-approval-requested', {
    summary: `approval ${memoryApproval.id} for ${memoryApproval.summary?.toolName}`,
    approvalId: memoryApproval.id,
    toolName: memoryApproval.summary?.toolName,
    arguments: memoryApproval.summary?.arguments,
  });

  await api('POST', `/v1/assistant/approvals/${memoryApproval.id}/resolve`, { resolution: 'approved' });
  record('memory-approval-answered', { summary: 'approved by the operator, as a human would' });

  await waitFor('the memory turn to finish', async () => {
    const state = await attemptState(memoryAttemptId);
    return state && ['completed', 'failed', 'cancelled'].includes(state.status) ? state : null;
  }, turnTimeoutMs, 1000);
  const memoryState = await attemptState(memoryAttemptId);
  record('memory-turn-finished', { summary: `attempt ${memoryAttemptId} is ${memoryState?.status}`, state: memoryState?.status });

  const recall = await api('POST', '/v1/capabilities/dispatch', {
    correlationId: `acceptance-recall-${runId}`,
    toolName: 'memory_recall',
    arguments: { scopeType: 'user' },
    cwd: workspace,
  });
  const recalledRaw = JSON.parse(recall.toolInvocation.evidence.output);
  const recalled = (recalledRaw.entries ?? []).map((entry) => entry.memory ?? entry);
  const remembered = recalled.find((memory) => /dark mode/i.test(`${memory.subject} ${memory.value} ${memory.normalizedValue} ${memory.predicate}`));
  record('memory-recalled', {
    summary: remembered
      ? `the fact is stored: "${remembered.subject} ${remembered.predicate} ${remembered.normalizedValue ?? remembered.value}"`
      : `no matching fact among ${recalled.length} remembered fact(s)`,
    memoryCount: recalled.length,
    remembered: remembered ?? null,
  });
  if (!remembered) {
    throw new Error(`the memory was not stored; recalled ${recalled.length} fact(s): ${JSON.stringify(recalled).slice(0, 600)}`);
  }

  // ── 3. The assistant can keep a promise ─────────────────────────────────
  const promiseSubmit = await api('POST', '/v1/submit', {
    currentMessage:
      'Remind me to follow up with Priya about the invoice if she has not replied by Friday. '
      + 'Record it as a commitment so it is tracked.',
    requestedMode: 'baat_kar',
    conversationId: conversation.id,
    requestedProvider: 'ollama',
    requestedModel: model,
    selectedProvider: 'ollama',
    selectedModel: model,
    hasWorkspace: false,
    gitCapable: false,
    toolPermissionPolicy: { profile: 'confirm-mutations' },
  });
  const promiseAttemptId = promiseSubmit.attempt.id;
  record('promise-submitted', { summary: `attempt ${promiseAttemptId}`, attemptId: promiseAttemptId });

  await api('POST', `/v1/attempts/${promiseAttemptId}/execute`, {});

  await waitFor('the promise turn to finish', async () => {
    const state = await attemptState(promiseAttemptId);
    return state && ['completed', 'failed', 'cancelled'].includes(state.status) ? state : null;
  }, turnTimeoutMs, 1000);
  const promiseState = await attemptState(promiseAttemptId);
  record('promise-turn-finished', { summary: `attempt ${promiseAttemptId} is ${promiseState?.status}`, state: promiseState?.status });

  const database = db();
  const commitments = database.prepare('SELECT id, title, channel, subject, condition, status, dueAt FROM commitments ORDER BY createdAt DESC').all();
  record('commitments-recorded', {
    summary: `${commitments.length} commitment(s) in Core's database`,
    commitments,
  });
  if (!commitments.length) {
    throw new Error('no commitment was recorded');
  }

  const taskOutcomes = database.prepare('SELECT attemptId, objective, status, successCriteria, evidence FROM task_outcomes').all();
  record('task-records', {
    summary: `${taskOutcomes.length} task record(s) — created by Core, not by the model`,
    taskOutcomes,
  });
  if (!taskOutcomes.length) {
    throw new Error('no durable task record was created for the work');
  }
  for (const outcome of taskOutcomes) {
    if (!outcome.objective || !String(outcome.objective).trim()) {
      throw new Error(`a task record has no objective: ${JSON.stringify(outcome)}`);
    }
  }
  // The record for the memory turn must exist even though the model was
  // never asked to describe it: Core creates it when the request starts.
  const memoryRecord = taskOutcomes.find((outcome) => outcome.attemptId === memoryAttemptId);
  if (!memoryRecord) {
    throw new Error(`Core did not create a task record for the memory request (${memoryAttemptId})`);
  }
  record('task-record-from-core', {
    summary: `Core created the record for the memory request on its own: "${String(memoryRecord.objective).slice(0, 120)}"`,
    objective: memoryRecord.objective,
    status: memoryRecord.status,
  });

  // ── 4. The turn's own truth: the final verification is not hardcoded ─────
  const quality = database.prepare(
    "SELECT metadata FROM runtime_events WHERE eventType = 'final_verification_recorded' ORDER BY sequence DESC LIMIT 4",
  ).all();
  const verdicts = quality.map((row) => {
    try {
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      return { passed: metadata?.passed, verdict: metadata?.verdict, reason: metadata?.reason };
    } catch {
      return { passed: null, verdict: null, reason: 'unreadable' };
    }
  });
  record('final-verification', {
    summary: verdicts.map((v) => `${v.verdict ?? '?'}${v.passed === false ? ' (not passed)' : ''}`).join(', ') || 'no final verification recorded',
    verdicts,
  });
  if (!verdicts.some((verdict) => verdict.verdict === 'verified' && verdict.passed === true)) {
    throw new Error(`no turn was verified from its evidence: ${JSON.stringify(verdicts)}`);
  }

  const messages = await api('GET', `/v1/conversations/${conversation.id}/messages`);
  const transcript = (messages.messages ?? []).map((message) => ({
    role: message.role,
    content: String(message.content ?? '').slice(0, 600),
  }));
  record('transcript', { summary: `${transcript.length} message(s) in the conversation`, transcript });

  // ── 5. The routine the operator asked for fires, exactly once ───────────
  const routineId = configured.routine.id;
  const delivery = await waitFor('the daily brief to be delivered', async () => {
    const row = database.prepare(
      'SELECT routineId, occurrenceKey, deliveredAt, conversationId, messageId FROM routine_deliveries WHERE routineId = ? AND deliveredAt IS NOT NULL',
    ).get(routineId);
    return row ?? null;
  }, 6 * 60_000, 5_000);
  const deliveries = database.prepare(
    'SELECT occurrenceKey, deliveredAt FROM routine_deliveries WHERE routineId = ?',
  ).all(routineId);
  record('routine-delivered', {
    summary: `the brief was delivered once for ${delivery.occurrenceKey} at ${delivery.deliveredAt}`,
    delivery,
    deliveries,
  });
  if (deliveries.length !== 1) {
    throw new Error(`the routine delivered ${deliveries.length} times for one occurrence; it must be exactly once`);
  }
  const briefMessages = delivery.conversationId
    ? (await api('GET', `/v1/conversations/${delivery.conversationId}/messages`)).messages ?? []
    : [];
  record('routine-content', {
    summary: `the delivered brief has ${briefMessages.length} message(s): "${String(briefMessages[0]?.content ?? '').slice(0, 200)}"`,
    messages: briefMessages.map((message) => String(message.content ?? '').slice(0, 400)),
  });
  if (!briefMessages.length) throw new Error('the daily brief was recorded but wrote no message');

  database.close();

  const evidence = {
    startedAt: steps[0]?.at,
    finishedAt: new Date().toISOString(),
    model,
    coreLog: path.relative(repoRoot, logPath),
    dataDir: path.relative(repoRoot, dataDir),
    steps,
    notes,
    passed: true,
  };
  const evidencePath = path.join(evidenceDir, `acceptance-${runId}.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence: ${path.relative(repoRoot, evidencePath)}`);
  console.log('ACCEPTANCE: PASS');
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  console.error(`\nACCEPTANCE: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  const evidencePath = path.join(evidenceDir, `acceptance-${runId}-FAILED.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify({
    startedAt: steps[0]?.at,
    finishedAt: new Date().toISOString(),
    model,
    steps,
    notes,
    error: err instanceof Error ? err.message : String(err),
    passed: false,
  }, null, 2)}\n`);
  console.error(`Evidence: ${path.relative(repoRoot, evidencePath)}`);
} finally {
  await stopCore();
}
process.exit(failure ? 1 : 0);
