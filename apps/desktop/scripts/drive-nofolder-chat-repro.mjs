/**
 * Typed no-folder chat repro against an already-running Desktop CDP target,
 * or launches portable Desktop when needed.
 *
 *   node apps/desktop/scripts/drive-nofolder-chat-repro.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9520';
const scratch = path.join(os.tmpdir(), `karkedikha-nofolder-chat-${Date.now()}`);
const dataDir = path.join(scratch, 'desktop-data');
const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
const appDir = path.join(portableRoot, 'app');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function ensureDesktop() {
  const existing = await listPages();
  if (existing?.some((p) => p.type === 'page' && p.webSocketDebuggerUrl)) {
    return { launched: false };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, appDir], {
    cwd: portableRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      KARKEDIKHA_DESKTOP_MODEL: process.env.KARKEDIKHA_DESKTOP_MODEL || 'qwen2.5-coder:1.5b',
    },
    windowsHide: false,
  });
  child.stderr.on('data', (d) => process.stderr.write(String(d)));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const pages = await listPages();
    if (pages?.some((p) => p.type === 'page' && p.webSocketDebuggerUrl)) {
      return { launched: true, pid: child.pid };
    }
    await sleep(400);
  }
  throw new Error('Desktop CDP did not become ready');
}

async function main() {
  await ensureDesktop();

  let id = 1;
  const pending = new Map();
  const pages = await listPages();
  const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
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
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await cdp('Runtime.enable');

  await waitConnected(evaluate);

  await evaluate(`(async () => {
    await window.karkedikhaDesktop.setVoiceMode(true);
    await window.karkedikhaDesktop.selectWorker('local-core');
    const input = document.getElementById('task-input');
    if (input) input.value = 'Hello, what can you help me with?';
    return window.karkedikhaDesktop.submitTask('Hello, what can you help me with?');
  })()`);

  const hello = await waitTurn(evaluate, 'hello');
  console.log('HELLO', JSON.stringify(hello, null, 2));
  assertChatOk(hello, 'hello');

  await evaluate(`window.karkedikhaDesktop.submitTask('And what is one example of that?')`);
  const follow = await waitTurn(evaluate, 'follow-up');
  console.log('FOLLOW', JSON.stringify(follow, null, 2));
  assertChatOk(follow, 'follow-up');

  const blocked = await evaluate(`(async () => {
    try {
      await window.karkedikhaDesktop.selectWorker('autonomous-mission');
      await window.karkedikhaDesktop.submitTask('Implement a hello world change');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  })()`);
  console.log('MISSION_BLOCK', JSON.stringify(blocked, null, 2));
  if (blocked.ok || !/select a repository/i.test(blocked.error || '')) {
    throw new Error(`expected mission without folder to ask for repository, got ${JSON.stringify(blocked)}`);
  }

  // Restore chat worker for human voice retest.
  await evaluate(`window.karkedikhaDesktop.selectWorker('local-core')`);

  console.log(JSON.stringify({ ok: true, hello, follow, blocked }, null, 2));
  ws.close();
}

async function waitConnected(evaluate) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    if (s?.coreState === 'connected') return s;
    await sleep(400);
  }
  throw new Error('core not connected');
}

async function waitTurn(evaluate, label) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    if (s?.running) {
      await sleep(500);
      continue;
    }
    if (!s?.lastTurnOutcome && !s?.cockpit?.terminal) {
      await sleep(400);
      continue;
    }
    const result = await evaluate(`document.getElementById('result')?.textContent || ''`);
    const resultState = await evaluate(`document.getElementById('result-state')?.textContent || ''`);
    const phaseHidden = await evaluate(
      `Boolean(document.getElementById('mission-phase-brief')?.closest('div')?.hidden)`,
    );
    return {
      label,
      lastTurnOutcome: s.lastTurnOutcome,
      interactionMode: s.interactionMode,
      folder: s.folder,
      result: String(result).slice(0, 500),
      resultState,
      phaseHidden,
      speaking: s.speaking,
    };
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assertChatOk(turn, label) {
  if (turn.lastTurnOutcome !== 'completed') {
    throw new Error(`${label}: expected completed, got ${turn.lastTurnOutcome}: ${turn.result}`);
  }
  if (turn.interactionMode !== 'chat') {
    throw new Error(`${label}: expected interactionMode chat, got ${turn.interactionMode}`);
  }
  if (/requires a selected repository/i.test(turn.result)) {
    throw new Error(`${label}: Local Core folder refusal still present`);
  }
  if (turn.resultState === 'Failed') {
    throw new Error(`${label}: UI shows Failed for a completed chat`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
