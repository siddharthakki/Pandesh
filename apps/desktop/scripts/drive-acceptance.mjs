import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9333';
const evidencePath = path.join(repoRoot, '.tmp', 'desktop-slice-workflow.json');

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

async function cdp(method, params = {}, sessionId) {
  const list = await waitFor('cdp list', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (!res.ok) return null;
      const pages = await res.json();
      return pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl) ?? null;
    } catch {
      return null;
    }
  }, 60_000);

  if (!cdp.ws) {
    cdp.ws = new WebSocket(list.webSocketDebuggerUrl);
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
    cdp.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

const firstTask = 'Read package.json and explain the available run and test commands. Do not modify files.';
const cancelTask = 'Keep inspecting this repository until you have quoted every scripts entry. Do not modify files.';

const first = await waitFor('submit ready', async () => {
  const ready = await evaluate(`({
    core: document.getElementById('core-state').textContent,
    folder: document.getElementById('folder-path').textContent,
    disabled: document.getElementById('submit').disabled,
    model: document.getElementById('model-label').textContent,
  })`);
  if (ready.core === 'connected' && ready.folder && ready.folder !== 'No folder selected' && ready.disabled === false) {
    return ready;
  }
  return null;
}, 90_000);

await evaluate(`
  (async () => {
    const input = document.getElementById('task-input');
    input.value = ${JSON.stringify(firstTask)};
    document.getElementById('submit').click();
    return document.getElementById('folder-path').textContent;
  })()
`);

const firstDone = await waitFor('first result', async () => {
  const state = await evaluate(`({
    result: document.getElementById('result').textContent,
    activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
    ids: document.getElementById('ids').textContent,
    model: document.getElementById('model-label').textContent,
    core: document.getElementById('core-state').textContent,
  })`);
  if (state.result && state.result !== 'Running…' && state.result !== 'Waiting for a Core-owned answer.') return state;
  return null;
}, 300_000);

const cancelStarted = await waitFor('cancel enabled', async () => {
  await evaluate(`
    (() => {
      const input = document.getElementById('task-input');
      if (document.getElementById('submit').disabled === false) {
        input.value = ${JSON.stringify(cancelTask)};
        document.getElementById('submit').click();
      }
      return {
        cancelDisabled: document.getElementById('cancel').disabled,
        ids: document.getElementById('ids').textContent,
      };
    })()
  `);
  const state = await evaluate(`({
    cancelDisabled: document.getElementById('cancel').disabled,
    ids: document.getElementById('ids').textContent,
    activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
  })`);
  if (state.cancelDisabled === false) {
    await evaluate(`document.getElementById('cancel').click()`);
    return state;
  }
  return null;
}, 60_000);

const cancelDone = await waitFor('cancel result', async () => {
  const state = await evaluate(`({
    result: document.getElementById('result').textContent,
    activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
    ids: document.getElementById('ids').textContent,
  })`);
  const text = `${state.result}\n${state.activity.join('\n')}`.toLowerCase();
  if (text.includes('cancel')) return state;
  return null;
}, 120_000);

const evidence = {
  folderShown: first,
  firstResult: firstDone,
  cancelStarted,
  cancelDone,
  evidenceLog: path.join(repoRoot, '.tmp', 'desktop-slice-evidence.jsonl'),
};
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
cdp.ws?.close();
process.exit(0);
