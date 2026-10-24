/**
 * Proves cancellation for a Local Core repository question: cancelling a live
 * request makes the attempt terminally cancelled, and output that arrives
 * afterwards cannot replace that outcome with an answer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = path.join(os.tmpdir(), 'karkedikha-local-core-question');
const info = JSON.parse(fs.readFileSync(path.join(scratch, 'fixture.json'), 'utf8'));
const fixture = info.fixture;
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9351';

const QUESTION = 'Explain in depth how this repository enforces mission delivery, reading every relevant module. Cite the files you read.';

function git(args) {
  return execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
}

function repositoryState() {
  const files = git(['ls-files', '--cached', '--others']).split(/\r?\n/).filter(Boolean);
  return {
    head: git(['rev-parse', 'HEAD']),
    commitCount: git(['rev-list', '--count', 'HEAD']),
    status: git(['status', '--porcelain', '--untracked-files=all']),
    fileCount: files.length,
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
  return evaluate(`(() => ({
    core: document.getElementById('core-state').textContent,
    folder: document.getElementById('folder-path').textContent,
    submitDisabled: document.getElementById('submit').disabled,
    cancelDisabled: document.getElementById('cancel').disabled,
    result: document.getElementById('result').textContent,
    ids: document.getElementById('ids').textContent,
    checkpoints: [...document.querySelectorAll('#checkpoint-pane li')].map((item) => item.textContent.trim()),
  }))()`);
}

function attemptRow(attemptId) {
  const db = new DatabaseSync(path.join(info.dataDir, 'core.db'), { readOnly: true });
  const attempt = db.prepare('SELECT status, cancelRequestedAt, failureReason FROM attempts WHERE id = ?').get(attemptId);
  const invocations = db.prepare(
    'SELECT toolName, status FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt',
  ).all(attemptId);
  db.close();
  return { attempt, invocations };
}

const before = repositoryState();

await waitFor('submit ready', async () => {
  const state = await uiState();
  return state.core === 'connected' && state.folder.includes(path.basename(fixture)) && state.submitDisabled === false
    ? state : null;
}, 120_000);

await evaluate(`
  (async () => {
    const select = document.getElementById('worker-select');
    select.value = 'local-core';
    select.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    document.getElementById('task-input').value = ${JSON.stringify(QUESTION)};
    document.getElementById('submit').click();
  })()
`);

const submitted = await waitFor('question submitted', async () => {
  const state = await uiState();
  return state.ids && state.submitDisabled === true ? state : null;
}, 60_000);
const attemptId = submitted.ids.split('/').pop().trim();

// Cancel only once the request is demonstrably live and doing work.
const live = await waitFor('live progress', async () => {
  const state = await uiState();
  return state.checkpoints.length >= 2 && state.cancelDisabled === false ? state : null;
}, 300_000);

const cancelledAt = new Date().toISOString();
await evaluate('window.karkedikhaDesktop.cancel()');

const terminal = await waitFor('terminal after cancel', async () => {
  const state = await uiState();
  return state.submitDisabled === false ? state : null;
}, 180_000);

const immediately = attemptRow(attemptId);

// Late output must not replace the cancelled outcome: keep watching well past
// the point where the in-flight model turn would have produced an answer.
await sleep(45_000);
const settled = attemptRow(attemptId);
const finalUi = await uiState();
const after = repositoryState();

const evidence = {
  fixture,
  question: QUESTION,
  attemptId,
  cancelledAt,
  liveCheckpointsAtCancel: live.checkpoints,
  attemptImmediatelyAfterCancel: immediately.attempt,
  attemptAfterWaiting: settled.attempt,
  toolInvocations: settled.invocations.map((row) => `${row.toolName}:${row.status}`),
  answerToolPresent: settled.invocations.some((row) => row.toolName === 'answer' && row.status === 'succeeded'),
  finalResultText: finalUi.result,
  finalCheckpoints: finalUi.checkpoints,
  repositoryBefore: before,
  repositoryAfter: after,
  repositoryUnchanged: before.head === after.head && before.status === after.status
    && before.fileCount === after.fileCount && before.commitCount === after.commitCount,
};

const evidencePath = path.join(scratch, 'local-core-cancel-workflow.json');
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
fs.writeFileSync(
  path.join(repoRoot, '.tmp', 'local-core-cancel-workflow.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(evidence, null, 2));

const cancelledTerminal = settled.attempt?.status === 'cancelled';
const stayedCancelled = immediately.attempt?.status === settled.attempt?.status;
const noAnswerDelivered = !evidence.answerToolPresent && !/References:/.test(finalUi.result);
const ok = cancelledTerminal && stayedCancelled && noAnswerDelivered && evidence.repositoryUnchanged;
cdp.ws?.close();
if (!ok) {
  console.error('cancellation verification failed');
  process.exit(1);
}
process.exit(0);
