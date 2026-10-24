#!/usr/bin/env node
// npm run test:e2e:m38-core-only-smoke  (script not yet wired into package.json —
// run directly: node scripts/acceptance/run-m38-core-only-smoke.mjs)
//
// M38 — Core-only deterministic Saath Kar smoke for the governed
// external-tool fabric (repository inspection + governed research + GitHub
// comment). Modeled on scripts/acceptance/run-m32-core-execution-acceptance.mjs:
// drives the REAL esbuild-bundled Core (out-core/core.js, the same artifact
// the packaged VSIX ships) spawned as a separate process, pointed at the
// three deterministic M38 fixtures purely via environment variables/PATH —
// no Electron, no webview, no VSIX. This is preparation for a later packaged
// acceptance run, NOT packaged acceptance itself: it proves the Core-owned
// governed-capability loop (suspend/resume, continuation persistence,
// mutation gating) end to end against real Core HTTP, nothing about the
// Extension Host, AgentPanel, or webview restoration.
//
// Exit codes: 0 pass, 1 failure.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScriptedOllamaFixture } from './fixtures/m38ScriptedOllamaFixture.mjs';
import { startResearchFixture } from './fixtures/m38ResearchFixture.mjs';
import {
  M38_FIXTURE_MODEL,
  M38_REPO_FIXTURE_FILE_NAME,
  M38_REPO_FIXTURE_FILE_CONTENT,
  M38_GITHUB_REPOSITORY,
  M38_GITHUB_COMMENT_MARKER,
  m38FinalAnswer,
} from './fixtures/m38FixtureConstants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const ghFakeScript = path.join(__dirname, 'fixtures', 'fakeGh', 'ghFake.mjs');
const TOKEN = 'm38-core-only-smoke-token';
const CLIENT_ID = 'm38-smoke-client';
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm38-core-only-smoke');

const evidence = { startedAt: new Date().toISOString(), preparationOnly: true, note: 'This is a Core-only preparation smoke, NOT packaged acceptance.', steps: [] };
let child;
let dataDir;
let fakeGhDataDir;
let workDir;
let ollamaFixture;
let researchFixture;

function log(msg) { process.stdout.write(`[m38-core-only-smoke] ${msg}\n`); }
function record(name, ok, detail) {
  evidence.steps.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

function buildBundle() {
  log('building Core bundle (esbuild.core.js)…');
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
}

function spawnCore() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-smoke-core-'));
  child = spawn(process.execPath, [bundlePath], {
    env: {
      ...process.env,
      KARKEDIKHA_CORE_TOKEN: TOKEN,
      KARKEDIKHA_DATA_DIR: dataDir,
      KARKEDIKHA_OLLAMA_URL: ollamaFixture.baseUrl,
      KARKEDIKHA_DEFAULT_MODEL: M38_FIXTURE_MODEL,
      KARKEDIKHA_SEARXNG_URL: researchFixture.providerUrl,
      KARKEDIKHA_GITHUB_REPOSITORY: M38_GITHUB_REPOSITORY,
      KARKEDIKHA_TEST_GH_EXECUTOR_SCRIPT: ghFakeScript,
      KARKEDIKHA_FAKE_GH_DATA_DIR: fakeGhDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[core] ${d}`));
}

async function waitForPort(timeoutMs = 10000) {
  const discoveryPath = path.join(dataDir, 'core.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(discoveryPath)) {
      try { return JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).port; } catch { /* partial write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Core discovery record did not appear');
}

let base;
const H = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...extra });
let keyN = 0;
const key = () => `m38-smoke-${Date.now()}-${keyN++}`;
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: H({ 'Idempotency-Key': key() }), body: JSON.stringify(body ?? {}) });
const get = (p) => fetch(`${base}${p}`, { headers: H() });

async function postJson(p, body) { const r = await post(p, body); if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`); return r.json(); }
async function getJson(p) { const r = await get(p); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json(); }

async function pollAttempt(id, pred, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await getJson(`/v1/attempts/${id}`);
    if (pred(a)) return a;
    if (Date.now() > deadline) throw new Error(`attempt ${id} timed out; last status=${a.status} failureReason=${a.failureReason}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function readMutationCount() {
  try { return JSON.parse(fs.readFileSync(path.join(fakeGhDataDir, 'mutationCount.json'), 'utf8')).count ?? 0; } catch { return 0; }
}

async function resolvePendingAction(conversationId, resolution) {
  const actions = await getJson(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`);
  const action = actions.actions.find((a) => a.actionable);
  if (!action) throw new Error(`no actionable capability action found for correlationId=${conversationId}: ${JSON.stringify(actions)}`);
  const resolved = await postJson(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    resolution,
    attemptId: action.attemptId,
    expectedAttemptRevision: action.expectedAttemptRevision,
    expectedAttemptStatus: action.expectedAttemptStatus,
    requestedActionDigest: action.requestedActionDigest,
    frozenContextHash: action.frozenContextHash,
  });
  return { action, resolved };
}

async function runSmoke() {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-smoke-work-'));
  fs.writeFileSync(path.join(workDir, M38_REPO_FIXTURE_FILE_NAME), M38_REPO_FIXTURE_FILE_CONTENT, 'utf8');

  const conv = await postJson('/v1/conversations', { mode: 'saath_kar' });
  await postJson(`/v1/conversations/${conv.id}/messages`, { role: 'user', content: 'Inspect the repository note, research the topic, and comment on the tracking issue.' });
  const req = await postJson('/v1/requests', {
    currentMessage: 'Inspect the repository note, research the topic, and comment on the tracking issue.',
    requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'm38-smoke', conversationId: conv.id,
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false },
  });
  const attempt = await postJson('/v1/attempts', { requestId: req.id, kind: 'saath_kar', workspaceRoot: workDir });

  const execRes = await fetch(`${base}/v1/attempts/${attempt.id}/execute`, {
    method: 'POST', headers: H({ 'Idempotency-Key': key() }), body: JSON.stringify({ workingDirectory: workDir }),
  });
  if (execRes.status !== 202) throw new Error(`execute returned ${execRes.status}: ${await execRes.text()}`);

  // Step 1: the governed research call is the first consequential capability
  // the model reaches (after the ungoverned, immediate read_file inspection),
  // so the attempt suspends here first.
  const waitingForResearch = await pollAttempt(attempt.id, (a) => a.status === 'waiting_for_approval');
  record('attempt suspends waiting_for_approval for the first consequential capability (governed_research)', waitingForResearch.status === 'waiting_for_approval', { status: waitingForResearch.status });

  const continuationRow = fs.existsSync(path.join(dataDir, 'core.db'));
  record('a durable Core database exists to hold the attempt_loop_continuations checkpoint', continuationRow, { dbPath: path.join(dataDir, 'core.db') });

  const mutationsBeforeResearchApproval = readMutationCount();
  record('mutation count is 0 before any approval', mutationsBeforeResearchApproval === 0, { mutationsBeforeResearchApproval });

  const { action: researchAction, resolved: researchResolved } = await resolvePendingAction(conv.id, 'approved');
  record('the pending action is the governed_research capability', researchAction.toolName === 'governed_research', { toolName: researchAction.toolName });
  record('approving research resumes the same Saath Kar attempt', researchResolved.resumedAttemptId === attempt.id, { resumedAttemptId: researchResolved.resumedAttemptId, attemptId: attempt.id });

  // Step 2: research now executes (no mutation — it is consequential only
  // because network egress is gated, per ADR-7), and the model then reaches
  // the second consequential capability, github_comment_on_issue.
  const waitingForGithub = await pollAttempt(attempt.id, (a) => a.status === 'waiting_for_approval');
  record('research capability executed and the attempt suspends again for github_comment_on_issue', waitingForGithub.status === 'waiting_for_approval', { status: waitingForGithub.status });

  const mutationsBeforeGithubApproval = readMutationCount();
  record('mutation count is still 0 before the github approval', mutationsBeforeGithubApproval === 0, { mutationsBeforeGithubApproval });

  const { action: githubAction, resolved: githubResolved } = await resolvePendingAction(conv.id, 'approved');
  record('the pending action is github_comment_on_issue', githubAction.toolName === 'github_comment_on_issue', { toolName: githubAction.toolName });
  record('approving the github comment resumes the same Saath Kar attempt', githubResolved.resumedAttemptId === attempt.id, { resumedAttemptId: githubResolved.resumedAttemptId, attemptId: attempt.id });

  const done = await pollAttempt(attempt.id, (a) => ['completed', 'failed'].includes(a.status));
  record('the attempt reaches a terminal completed state', done.status === 'completed', { status: done.status, failureReason: done.failureReason });

  const mutationsAfter = readMutationCount();
  record('exactly one mutation occurred (the github comment)', mutationsAfter === 1, { mutationsAfter });

  const messages = (await getJson(`/v1/conversations/${conv.id}/messages`)).messages;
  const assistant = messages.filter((m) => m.role === 'assistant').pop();
  const expectedAnswer = m38FinalAnswer();
  record('a final grounded answer is produced, referencing all three tool results', Boolean(assistant?.content?.includes(expectedAnswer)), {
    assistant: assistant?.content, expectedAnswer,
  });

  const ollamaViolations = ollamaFixture.violations();
  record('the scripted model fixture recorded zero unexpected/out-of-order tool-call sequences', ollamaViolations.length === 0, { ollamaViolations });

  const okAll = evidence.steps.every((s) => s.ok);
  if (!okAll) throw new Error('one or more Core-only smoke assertions failed — see evidence.json');
}

async function shutdownCore(port) {
  try { await fetch(`http://127.0.0.1:${port}/v1/core/shutdown`, { method: 'POST', headers: H({ 'Idempotency-Key': key() }), body: '{}' }); } catch { /* ignore */ }
}

async function main() {
  fakeGhDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-smoke-fakegh-'));
  ollamaFixture = await startScriptedOllamaFixture({ logFilePath: path.join(os.tmpdir(), 'm38-smoke-ollama-fixture.log') });
  researchFixture = await startResearchFixture();

  buildBundle();
  spawnCore();
  const port = await waitForPort();
  base = `http://127.0.0.1:${port}`;
  log(`Core up on port ${port}, fixture model ${M38_FIXTURE_MODEL}`);

  let failed = false;
  try {
    await runSmoke();
  } catch (err) {
    failed = true;
    record('run', false, err.stack ?? err.message);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await shutdownCore(port);
    if (child && !child.killed) child.kill();
    await ollamaFixture?.close();
    await researchFixture?.close();
    for (const dir of [dataDir, workDir, fakeGhDataDir]) {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }
  log(`This is a Core-only preparation smoke, NOT packaged acceptance. Evidence written to ${path.join(evidenceDir, 'evidence.json')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  log(`fatal: ${err.stack ?? err}`);
  if (child && !child.killed) child.kill();
  process.exit(1);
});
