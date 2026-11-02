#!/usr/bin/env node
/**
 * Pandesh Panda bridge — Chrome Native Messaging host.
 *
 * Chrome starts this process for the paired extension only (the native-host manifest's allowed_origins names the extension),
 * speaks length-prefixed JSON over stdio, and expects one reply per message. This host is deliberately thin:
 *  - it holds no state and no secrets of its own; it reads Core's loopback port and bearer token from the Pandesh data
 *    directory (owner-only files) and never returns either to the browser;
 *  - it forwards an allow-list of operations to Core's /v1/bridge API and nothing else;
 *  - the browser's pairing token travels with each message and is checked by Core on every request, so revoking a pairing
 *    in Pandesh cuts the browser off immediately.
 * No dependencies: it must run from a plain `node` with nothing installed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_MESSAGE_BYTES = 1024 * 1024;
const ID = /^[\w-]{1,80}$/;

function loadConfig() {
  const file = process.env.PANDA_BRIDGE_CONFIG || path.join(HERE, 'host-config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.dataDir) throw new Error('host-config.json has no dataDir');
  return cfg;
}

function core(cfg) {
  const record = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'core.json'), 'utf8'));
  const token = fs.readFileSync(path.join(cfg.dataDir, 'core.token'), 'utf8').trim();
  if (!record.port || !token) throw new Error('Pandesh is not running');
  return { base: `http://127.0.0.1:${record.port}`, token };
}

async function call(cfg, method, route, { pairing, body } = {}) {
  let c;
  try { c = core(cfg); } catch { return { ok: false, code: 'core_unavailable', message: 'Pandesh is not running. Start Pandesh and try again.' }; }
  const headers = { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', 'X-Client-Id': 'panda-bridge-host' };
  if (pairing) headers['X-Panda-Pairing'] = pairing;
  let res;
  try {
    res = await fetch(`${c.base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  } catch {
    return { ok: false, code: 'core_unavailable', message: 'Pandesh did not answer. Start Pandesh and try again.' };
  }
  const json = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data: json };
  const err = json?.error ?? {};
  return { ok: false, status: res.status, code: err.code ?? 'error', reason: err.details?.reason, message: err.message ?? `HTTP ${res.status}` };
}

const need = (cond, what) => { if (!cond) throw Object.assign(new Error(`${what} is required`), { code: 'invalid_request' }); };

/** The only operations the browser can ask for. */
const OPERATIONS = {
  hello: async () => ({ ok: true, data: { host: 'pandesh-panda-bridge', version: 1 } }),
  pair: (cfg, m) => { need(m.code, 'code'); return call(cfg, 'POST', '/v1/bridge/pair', { body: { code: m.code, label: m.label, extensionId: m.extensionId } }); },
  status: (cfg, m) => call(cfg, 'GET', '/v1/bridge/status', { pairing: m.token }),
  executors: (cfg, m) => call(cfg, 'GET', '/v1/bridge/executors', { pairing: m.token }),
  submit: (cfg, m) => {
    need(typeof m.instruction === 'string', 'instruction');
    return call(cfg, 'POST', '/v1/bridge/tasks', {
      pairing: m.token,
      body: { clientRequestId: m.clientRequestId, instruction: m.instruction, sourceRef: m.sourceRef, context: m.context, markedConfidential: m.markedConfidential === true },
    });
  },
  tasks: (cfg, m) => call(cfg, 'GET', '/v1/bridge/tasks?limit=30', { pairing: m.token }),
  task: (cfg, m) => { need(ID.test(String(m.taskId)), 'taskId'); return call(cfg, 'GET', `/v1/bridge/tasks/${m.taskId}`, { pairing: m.token }); },
  // Only the executor and model are forwarded: the browser has no way to pass consent for an external transfer.
  dispatch: (cfg, m) => { need(ID.test(String(m.taskId)), 'taskId'); need(m.executor, 'executor'); return call(cfg, 'POST', `/v1/bridge/tasks/${m.taskId}/dispatch`, { pairing: m.token, body: { executor: m.executor, model: m.model } }); },
  pause: (cfg, m) => { need(ID.test(String(m.taskId)), 'taskId'); return call(cfg, 'POST', `/v1/bridge/tasks/${m.taskId}/pause`, { pairing: m.token, body: {} }); },
  resume: (cfg, m) => { need(ID.test(String(m.taskId)), 'taskId'); return call(cfg, 'POST', `/v1/bridge/tasks/${m.taskId}/resume`, { pairing: m.token, body: {} }); },
  cancel: (cfg, m) => { need(ID.test(String(m.taskId)), 'taskId'); return call(cfg, 'POST', `/v1/bridge/tasks/${m.taskId}/cancel`, { pairing: m.token, body: {} }); },
  unpair: (cfg, m) => call(cfg, 'DELETE', '/v1/bridge/pairing', { pairing: m.token }),
  // Brings the Pandesh window to the task. Pandesh is single-instance, so a second launch with this argument is handed to the running app.
  open: async (cfg, m) => {
    need(ID.test(String(m.conversationId)), 'conversationId');
    if (!cfg.pandeshExe || !fs.existsSync(cfg.pandeshExe)) return { ok: false, code: 'app_not_found', message: 'The Pandesh application path is not configured for the browser bridge.' };
    spawn(cfg.pandeshExe, [`--panda-open=${m.conversationId}`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, data: { opened: true } };
  },
};

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let want = null;
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause(); };
    const onData = (buf) => {
      chunks.push(buf);
      const all = Buffer.concat(chunks);
      if (want === null && all.length >= 4) {
        want = all.readUInt32LE(0);
        if (want > MAX_MESSAGE_BYTES) { cleanup(); reject(new Error('message too large')); return; }
      }
      if (want !== null && all.length >= 4 + want) {
        cleanup();
        // Anything beyond this message belongs to the next read.
        const rest = all.subarray(4 + want);
        if (rest.length) process.stdin.unshift(rest);
        try { resolve(JSON.parse(all.subarray(4, 4 + want).toString('utf8'))); } catch (e) { reject(e); }
      }
    };
    const onEnd = () => { cleanup(); resolve(null); };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return new Promise((resolve) => process.stdout.write(Buffer.concat([header, body]), () => resolve()));
}

async function handle(cfg, message) {
  const op = OPERATIONS[message?.op];
  if (!op) return { ok: false, code: 'unknown_operation', message: `unknown operation '${message?.op}'` };
  try { return await op(cfg, message); } catch (e) { return { ok: false, code: e.code ?? 'error', message: String(e.message ?? e) }; }
}

async function main() {
  let cfg;
  try { cfg = loadConfig(); } catch (e) {
    const m = await readMessage().catch(() => null);
    if (m) await writeMessage({ id: m.id, ok: false, code: 'host_misconfigured', message: String(e.message) });
    return;
  }
  // sendNativeMessage sends exactly one request; connectNative may send many. Serve until the browser closes the pipe.
  for (;;) {
    const message = await readMessage().catch(() => null);
    if (message === null) return;
    await writeMessage({ id: message.id, ...(await handle(cfg, message)) });
  }
}

main().then(() => process.exit(0));
