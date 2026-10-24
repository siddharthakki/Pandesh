/**
 * Drives one small code change through Desktop's existing Autonomous Mission
 * path over CDP and verifies it independently of anything the model claimed:
 *
 *   authorize -> Core mutates -> focused validation passes ->
 *   manifest-bound diff review -> one local delivery commit ->
 *   Desktop shows the outcome and the commit SHA
 *
 * Independent checks read the fixture's git history, re-run the focused check
 * from outside Core, and read Core's own durable `tool_invocations` rather
 * than the cockpit, which only keeps the most recent checkpoints. The product
 * working checkout is fingerprinted before and after and must not move.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.env.KARKEDIKHA_MISSION_MUTATION_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-mission-mutation');
const info = JSON.parse(fs.readFileSync(path.join(scratch, 'fixture.json'), 'utf8'));
const fixture = info.fixture;
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9333';
const evidencePath = path.join(scratch, 'mission-mutation-workflow.json');

export const TASK = [
  'The focused check in this repository is failing.',
  'Read src/wordCount.js and tests/wordCount.test.js first.',
  'Change countWords in src/wordCount.js so any run of whitespace (repeated spaces, tabs, newlines)',
  'separates words, leading and trailing whitespace is ignored, and an empty or whitespace-only',
  'string has no words. Keep the existing TypeError for a non-string argument.',
  'Change only src/wordCount.js.',
  'Run the focused tests, review the git diff, then create one local git commit.',
  'Do not push. Do not change files outside this repository.',
].join(' ');

const INTENDED_PATH = info.intendedPath;

function git(args, cwd = fixture) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The product checkout must be untouched by the mission. */
function productState() {
  return {
    head: git(['rev-parse', 'HEAD'], repoRoot),
    status: git(['status', '--porcelain', '--untracked-files=all'], repoRoot),
  };
}

/** Runs the focused check from outside Core, so passing is not Core's word. */
function runFocusedCheck() {
  const result = spawnSync('npm test', { cwd: fixture, encoding: 'utf8', windowsHide: true, shell: true });
  return {
    exitCode: result.status,
    passed: result.status === 0,
    assertionFailures: /ERR_ASSERTION/.test(`${result.stdout ?? ''}${result.stderr ?? ''}`),
    tail: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-1200),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function cdp(method, params = {}) {
  const page = await waitFor('cdp list', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const pages = await res.json();
      return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
    } catch {
      return null;
    }
  }, 60_000);

  if (!cdp.ws) {
    cdp.ws = new WebSocket(page.webSocketDebuggerUrl);
    cdp.nextId = 1;
    cdp.pending = new Map();
    await new Promise((resolve, reject) => {
      cdp.ws.once('open', resolve);
      cdp.ws.once('error', reject);
    });
    cdp.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  const id = cdp.nextId++;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function uiState() {
  return evaluate(`(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? '';
    const select = document.getElementById('worker-select');
    return {
      core: read('core-state'),
      folder: read('folder-path'),
      submitDisabled: document.getElementById('submit').disabled,
      approvalHidden: document.getElementById('approval-panel').hidden,
      approvalGate: read('approval-gate'),
      approvalTool: read('approval-tool'),
      approvalScope: read('approval-scope'),
      approvalPaths: read('approval-paths'),
      approveDisabled: document.getElementById('approve')?.disabled ?? true,
      scopeRepo: read('scope-repo'),
      scopeActions: read('scope-actions'),
      scopeDelivery: read('scope-delivery'),
      scopeState: read('scope-state'),
      task: read('current-task'),
      result: read('result'),
      ids: read('ids'),
      workerValue: select ? select.value : null,
      phase: read('cockpit-phase'),
      validation: read('cockpit-validation'),
      verification: read('cockpit-verification'),
      changed: read('cockpit-changed'),
      checkpoints: [...document.querySelectorAll('#checkpoint-pane li')].map((item) => item.textContent.trim()),
    };
  })()`);
}

const startedAt = Date.now();
const productBefore = productState();
const baselineCheck = runFocusedCheck();

const ready = await waitFor('submit ready', async () => {
  const state = await uiState();
  if (state.core === 'connected' && state.folder.includes(path.basename(fixture))
    && state.submitDisabled === false) {
    return state;
  }
  return null;
}, 120_000);

// Acceptance 1: the task scope shown to the operator before authorization.
const authorization = {
  scopeRepo: ready.scopeRepo,
  scopeActions: ready.scopeActions,
  scopeDelivery: ready.scopeDelivery,
  scopeStateBefore: ready.scopeState,
};

await evaluate(`
  (async () => {
    const select = document.getElementById('worker-select');
    select.value = 'autonomous-mission';
    select.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    document.getElementById('task-input').value = ${JSON.stringify(TASK)};
    document.getElementById('submit').click();
  })()
`);

const submitted = await waitFor('mission submitted', async () => {
  const state = await uiState();
  if (state.ids && state.submitDisabled === true) return state;
  return null;
}, 60_000);
authorization.scopeStateAfter = submitted.scopeState;
authorization.workerValue = submitted.workerValue;

// Exactly one gate is approved: `authorize_mission`, the authorization for the
// intended change. In-scope mutations auto-authorize after it, so any further
// card is out of scope and is recorded and failed rather than blind-approved.
const approvals = [];
const unexpectedGates = [];
const terminal = await waitFor('mission terminal', async () => {
  const state = await uiState();
  if (state.approvalHidden === false && state.approveDisabled === false) {
    const card = {
      at: new Date().toISOString(),
      gate: state.approvalGate,
      tool: state.approvalTool,
      scope: state.approvalScope,
      paths: state.approvalPaths,
    };
    if (state.approvalTool === 'authorize_mission' && approvals.length === 0) {
      approvals.push(card);
      await evaluate(`document.getElementById('approve').click()`);
      return null;
    }
    unexpectedGates.push(card);
    throw new Error(`out-of-scope Core gate raised: ${state.approvalTool} ${state.approvalScope}`);
  }
  if (state.submitDisabled === false && state.result.trim()) return state;
  return null;
}, 1_400_000);

const finalUi = await uiState();

// Independent repository facts.
const head = git(['rev-parse', 'HEAD']);
const newCommits = git(['rev-list', '--count', `${info.baseline}..HEAD`]);
const committedFiles = head === info.baseline
  ? []
  : git(['show', '--name-only', '--pretty=format:', 'HEAD']).split(/\r?\n/).filter(Boolean);
const commitSubject = git(['log', '-1', '--format=%s']);
const worktreeStatus = git(['status', '--porcelain', '--untracked-files=all']);
const afterCheck = runFocusedCheck();
const mutatedSource = fs.readFileSync(path.join(fixture, INTENDED_PATH), 'utf8');

// Core's own durable record of what it did.
const attemptId = submitted.ids.split('/').pop().trim();
const db = new DatabaseSync(path.join(info.dataDir, 'core.db'), { readOnly: true });
const invocations = db.prepare(
  'SELECT toolName, argsSummary, status, evidence FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt',
).all(attemptId);
// Core executes an auto-authorized in-scope mutation under its own attempt, so
// the mutation is not in this attempt's tool_invocations. `mission_authorized_
// actions` is the durable record that carries the mission attempt id, the
// normalized path, the policy decision, and the frozen envelope digest.
const missionAuthorizations = db.prepare(
  'SELECT id, digest FROM mission_authorizations WHERE attemptId = ?',
).all(attemptId);
const authorizedActions = db.prepare(
  'SELECT action, normalizedPath, policyDecision, policyReason, envelopeDigest, contentBytes'
  + ' FROM mission_authorized_actions WHERE attemptId = ? ORDER BY createdAt',
).all(attemptId);
db.close();

const outputOf = (row) => {
  try {
    return String(JSON.parse(row.evidence ?? '{}').output ?? '');
  } catch {
    return '';
  }
};
const toolCounts = {};
for (const row of invocations) {
  toolCounts[`${row.toolName}:${row.status}`] = (toolCounts[`${row.toolName}:${row.status}`] ?? 0) + 1;
}

const mutations = authorizedActions.filter((row) => row.action === 'propose_file_change');
const validations = invocations.filter((row) => row.toolName === 'workspace_validation');
// A `run_check` row does not record which check it was in its arguments; the
// check identity is in the observation output Core stored.
const runChecks = invocations.filter((row) => row.toolName === 'run_check');
const diffReviews = runChecks.filter((row) => /diff review/.test(outputOf(row)));
const commits = runChecks.filter((row) => /^committed /.test(outputOf(row)));

// Acceptance 4: diff review named exactly the manifest that was committed.
const reviewOutputs = diffReviews.map(outputOf);
const passedReview = reviewOutputs.find((output) => /^diff review passed for /.test(output)) ?? '';
const reviewedManifest = passedReview
  ? passedReview.replace(/^diff review passed for /, '').split(',').map((item) => item.trim()).filter(Boolean)
  : [];

// Acceptance 5: the commit SHA Core recorded, and the SHA Desktop rendered.
const commitOutputs = commits.map(outputOf);
const coreCommitSha = (commitOutputs.map((output) => /committed ([0-9a-f]{7,40})/.exec(output)).find(Boolean) ?? [])[1] ?? null;
const desktopSurface = `${finalUi.result}\n${finalUi.checkpoints.join('\n')}`;
const shortHead = head.slice(0, 7);
const desktopShowsCommit = desktopSurface.includes(head) || desktopSurface.includes(shortHead);

const productAfter = productState();

const evidence = {
  fixture,
  task: TASK,
  baseline: info.baseline,
  baselineCheck: { exitCode: baselineCheck.exitCode, passed: baselineCheck.passed, assertionFailures: baselineCheck.assertionFailures },
  authorization,
  approvals,
  unexpectedGates,
  submitted: { ids: submitted.ids, task: submitted.task },
  finalUi: {
    result: finalUi.result,
    phase: finalUi.phase,
    validation: finalUi.validation,
    verification: finalUi.verification,
    changed: finalUi.changed,
    checkpoints: finalUi.checkpoints,
  },
  coreToolInvocationCounts: toolCounts,
  missionAuthorizations,
  authorizedActions,
  mutationPaths: mutations.map((row) => row.normalizedPath),
  validationOutputs: validations.map((row) => ({ status: row.status, output: outputOf(row).slice(0, 600) })),
  diffReviewOutputs: reviewOutputs.map((output) => output.slice(0, 400)),
  reviewedManifest,
  commitOutputs: commitOutputs.map((output) => output.slice(0, 200)),
  coreCommitSha,
  commit: { head, newCommits, committedFiles, commitSubject },
  worktreeStatusAfter: worktreeStatus,
  focusedCheckAfter: { exitCode: afterCheck.exitCode, passed: afterCheck.passed, tail: afterCheck.tail },
  mutatedSource,
  desktopShowsCommit,
  productBefore,
  productAfter,
  productUnchanged: productBefore.head === productAfter.head && productBefore.status === productAfter.status,
  elapsedMs: Date.now() - startedAt,
};

fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
fs.writeFileSync(
  path.join(repoRoot, '.tmp', 'mission-mutation-workflow.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(evidence, null, 2));

const ok = baselineCheck.passed === false
  && approvals.length === 1
  && unexpectedGates.length === 0
  && missionAuthorizations.length === 1
  // Every action Core took is bound to the one frozen envelope.
  && authorizedActions.length > 0
  && authorizedActions.every((row) => row.envelopeDigest === missionAuthorizations[0].digest)
  && mutations.length > 0
  && mutations.every((row) => row.policyDecision === 'auto_authorize')
  && evidence.mutationPaths.every((item) => item === INTENDED_PATH)
  // Desktop names the changed file rather than reporting none.
  && finalUi.changed.includes(INTENDED_PATH)
  && validations.some((row) => row.status === 'succeeded')
  && reviewedManifest.length > 0
  && Number(newCommits) === 1
  && committedFiles.length === reviewedManifest.length
  && committedFiles.every((file) => reviewedManifest.includes(file))
  && committedFiles.every((file) => file === INTENDED_PATH)
  && coreCommitSha !== null
  && head.startsWith(coreCommitSha.slice(0, 7))
  && desktopShowsCommit
  && afterCheck.passed
  && worktreeStatus === ''
  && evidence.productUnchanged;

cdp.ws?.close();
if (!ok) {
  console.error('independent verification failed');
  process.exit(1);
}
process.exit(0);
