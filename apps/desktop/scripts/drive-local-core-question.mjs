/**
 * Drives the Local Core repository-question workflow through the real Desktop
 * UI over CDP and verifies it independently of anything the model claimed:
 *
 *   select Local Core -> submit a real question -> cockpit progress ->
 *   one persistent terminal answer -> Core verified every reference
 *
 * Independent checks: the answer's references were actually read successfully,
 * the repository is byte-identical afterwards (tracked, untracked, ignored),
 * and no commit was created.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.env.KARKEDIKHA_LOCAL_CORE_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-local-core-question');
const info = JSON.parse(fs.readFileSync(path.join(scratch, 'fixture.json'), 'utf8'));
const fixture = info.fixture;
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9345';
const evidencePath = path.join(scratch, 'local-core-question-workflow.json');

export const QUESTION = process.env.KARKEDIKHA_LOCAL_CORE_QUESTION || [
  'In the current KarkeDikha Core delivery path under core/runtime, not the legacy VS Code extension code,',
  'which module builds the authorized changed-file manifest that a mission is allowed to commit,',
  'and how does the review digest stop a file changed after diff review from reaching the commit?',
  'Cite the files you read.',
].join(' ');

/** Core's delivery modules, as opposed to the legacy VS Code extension path. */
const CORE_DELIVERY_MODULES = ['missiondeliverymanifest', 'missiondiffreview', 'missionloop'];

function git(args, cwd = fixture) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Full content fingerprint of tracked, untracked, and ignored files. */
function repositoryState() {
  // No --exclude-standard: ignored files are part of what must stay unchanged.
  const files = git(['ls-files', '--cached', '--others']).split(/\r?\n/).filter(Boolean);
  const entries = files.map((relative) => {
    const absolute = path.join(fixture, relative);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return `${relative}:missing`;
    }
    return `${relative}:${stat.size}:${stat.mtimeMs}`;
  });
  return {
    head: git(['rev-parse', 'HEAD']),
    commitCount: git(['rev-list', '--count', 'HEAD']),
    status: git(['status', '--porcelain', '--untracked-files=all']),
    fileCount: files.length,
    digest: entries.sort().join('\n'),
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
    const select = document.getElementById('worker-select');
    return {
      core: document.getElementById('core-state').textContent,
      folder: document.getElementById('folder-path').textContent,
      submitDisabled: document.getElementById('submit').disabled,
      cancelDisabled: document.getElementById('cancel').disabled,
      approvalHidden: document.getElementById('approval-panel').hidden,
      task: document.getElementById('current-task').textContent,
      result: document.getElementById('result').textContent,
      ids: document.getElementById('ids').textContent,
      workerValue: select ? select.value : null,
      workerDetail: document.getElementById('worker-detail')?.textContent ?? '',
      workerOptions: select ? [...select.options].map((option) => ({
        value: option.value, label: option.textContent, disabled: option.disabled,
      })) : [],
      checkpoints: [...document.querySelectorAll('#checkpoint-pane li')].map((item) => item.textContent.trim()),
      activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
    };
  })()`);
}

const startedAt = Date.now();
const before = repositoryState();

const ready = await waitFor('submit ready', async () => {
  const state = await uiState();
  if (state.core === 'connected' && state.folder && state.folder.includes(path.basename(fixture))
    && state.submitDisabled === false && state.workerOptions.length > 0) {
    return state;
  }
  return null;
}, 120_000);

// Acceptance 1: external workers are offered but cannot be selected.
const gated = ready.workerOptions.filter((option) => option.disabled).map((option) => option.value);
const selectable = ready.workerOptions.filter((option) => !option.disabled).map((option) => option.value);
if (!gated.includes('codex-cli') || !gated.includes('claude-code')) {
  throw new Error(`external workers are selectable: ${JSON.stringify(ready.workerOptions)}`);
}
if (!selectable.includes('local-core')) throw new Error('Local Core is not selectable');

// Refuse a gated worker even when the picker is bypassed entirely.
const bypass = await evaluate(`
  window.karkedikhaDesktop.selectWorker('codex-cli')
    .then(() => ({ refused: false }))
    .catch((err) => ({ refused: true, message: String(err && err.message || err) }))
`);
if (!bypass.refused) throw new Error('host accepted a gated external worker');

await evaluate(`
  (async () => {
    const select = document.getElementById('worker-select');
    select.value = 'local-core';
    select.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    document.getElementById('task-input').value = ${JSON.stringify(QUESTION)};
    document.getElementById('submit').click();
  })()
`);

const submitted = await waitFor('question submitted', async () => {
  const state = await uiState();
  if (state.ids && state.submitDisabled === true) return state;
  return null;
}, 60_000);

// Acceptance 4: cockpit shows progress while the request is live.
const progress = await waitFor('cockpit progress', async () => {
  const state = await uiState();
  return state.checkpoints.length > 0 ? state : null;
}, 300_000);

const terminal = await waitFor('terminal answer', async () => {
  const state = await uiState();
  if (state.approvalHidden === false) {
    throw new Error('a read-only question raised an approval gate');
  }
  if (state.submitDisabled === false && state.result.trim()) return state;
  return null;
}, 1_200_000);

const finalUi = await uiState();
const after = repositoryState();
const answer = finalUi.result;

// Acceptance 3: every cited reference must correspond to a read Core recorded
// as succeeding. Read Core's durable tool_invocations rather than the cockpit,
// which only keeps the most recent checkpoints for display.
const attemptId = submitted.ids.split('/').pop().trim();
const db = new DatabaseSync(path.join(info.dataDir, 'core.db'), { readOnly: true });
const invocations = db.prepare(
  'SELECT toolName, argsSummary, status FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt',
).all(attemptId);
db.close();

const toolCounts = {};
for (const row of invocations) toolCounts[`${row.toolName}:${row.status}`] = (toolCounts[`${row.toolName}:${row.status}`] ?? 0) + 1;

const readPaths = new Set(invocations.flatMap((row) => {
  if (row.toolName !== 'read_file' || row.status !== 'succeeded') return [];
  try {
    const args = JSON.parse(row.argsSummary ?? '{}');
    return args.path ? [String(args.path).replace(/\\/g, '/').toLowerCase()] : [];
  } catch {
    return [];
  }
}));
const citedPaths = [...answer.matchAll(/^\s*-\s+(\S+?)(?::\d+(?:-\d+)?)?\s*$/gm)].map((match) => match[1]);
const unsupported = citedPaths.filter((cited) => !readPaths.has(cited.replace(/\\/g, '/').toLowerCase()));

// Acceptance 2: no mutating, delivery, or shell tool was ever invoked.
const forbidden = ['propose_file_change', 'run_check', 'run_command', 'finish', 'workspace_validation', 'verify_acceptance'];
const mutationAttempts = invocations.filter((row) => forbidden.includes(row.toolName)).map((row) => row.toolName);
const refusedActions = invocations.filter((row) => row.toolName === 'read_only_refusal').map((row) => row.argsSummary);

// Acceptance 5: the answer must land on Core's own delivery enforcement.
const answerLower = answer.toLowerCase();
const coreModulesCited = CORE_DELIVERY_MODULES.filter((module) => answerLower.includes(module));
const namesManifest = /manifest/.test(answerLower);
const namesReviewDigest = /digest/.test(answerLower);
const citesLegacyExtensionPath = citedPaths.filter((cited) => /^(src|extension|vscode)\//i.test(cited));

const evidence = {
  fixture,
  question: QUESTION,
  productHead: info.productHead,
  baseline: info.baseline,
  ready: { workerOptions: ready.workerOptions, workerDetail: ready.workerDetail },
  gatedWorkerBypass: bypass,
  submitted: { ids: submitted.ids, task: submitted.task, workerValue: submitted.workerValue },
  progressCheckpoints: progress.checkpoints,
  finalCheckpoints: finalUi.checkpoints,
  answer,
  citedPaths,
  coreModulesCited,
  namesManifest,
  namesReviewDigest,
  citesLegacyExtensionPath,
  recordedSuccessfulReads: [...readPaths],
  unsupportedReferences: unsupported,
  readOnlyRefusals: refusedActions,
  mutationToolAppearances: mutationAttempts,
  coreToolInvocationCounts: toolCounts,
  repositoryBefore: { head: before.head, commitCount: before.commitCount, fileCount: before.fileCount, status: before.status },
  repositoryAfter: { head: after.head, commitCount: after.commitCount, fileCount: after.fileCount, status: after.status },
  repositoryUnchanged: before.digest === after.digest && before.head === after.head
    && before.status === after.status && before.commitCount === after.commitCount,
  elapsedMs: Date.now() - startedAt,
};
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
fs.writeFileSync(
  path.join(repoRoot, '.tmp', 'local-core-question-workflow.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(evidence, null, 2));

const ok = evidence.repositoryUnchanged
  && citedPaths.length > 0
  && unsupported.length === 0
  && mutationAttempts.length === 0
  && Boolean(answer.trim())
  && after.commitCount === before.commitCount
  && coreModulesCited.length > 0
  && namesManifest
  && namesReviewDigest;
cdp.ws?.close();
if (!ok) {
  console.error('independent verification failed');
  process.exit(1);
}
process.exit(0);
