#!/usr/bin/env node
/**
 * Pandesh local MCP server (STDIO transport).
 *
 * Exposes Pandesh Core capabilities to any MCP client (ChatGPT desktop, Codex,
 * Claude Desktop, etc.) running on the same PC. No public network listener;
 * all traffic is loopback HTTP to Core.
 *
 * Tools:
 *   list_agents        - list configured Pandesh agents
 *   submit_task        - submit an objective to Pandesh (runs locally)
 *   get_task_status    - status of a submitted task
 *   get_task_report    - consolidated report of a completed task
 *   cancel_task        - cancel a running task
 *
 * Environment:
 *   KARKEDIKHA_DATA_DIR   - Pandesh data directory (default: %LOCALAPPDATA%/KarkeDikha/desktop)
 *   KARKEDIKHA_CORE_PORT  - Core's HTTP port (default: read from core.log)
 *   KARKEDIKHA_CORE_TOKEN - Core bearer token (optional; host token is read from data dir)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');

const DATA_DIR = process.env.KARKEDIKHA_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || '', 'AppData', 'Local'), 'KarkeDikha', 'desktop');

function readHostToken() {
  try { return fs.readFileSync(path.join(DATA_DIR, 'host.token'), 'utf8').trim(); } catch { return null; }
}

function discoverCorePort() {
  if (process.env.KARKEDIKHA_CORE_PORT) return Number(process.env.KARKEDIKHA_CORE_PORT);
  // Read from core.log
  const logPath = path.join(DATA_DIR, 'logs', 'core.log');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch {}
  return 0;
}

const HOST_TOKEN = process.env.KARKEDIKHA_HOST_TOKEN || readHostToken();
let corePort = discoverCorePort();
const PAIRING_FILE = path.join(DATA_DIR, 'mcp-pairing.json');

function readPairing() {
  try { return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf8')); } catch { return null; }
}
function writePairing(p) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PAIRING_FILE, JSON.stringify(p, null, 2), { mode: 0o600 });
}

async function coreRequest(method, urlPath, body, headers = {}, useHostAuth = true) {
  if (!corePort) corePort = discoverCorePort();
  if (!corePort) throw new Error('Core port not found. Is Pandesh running? Set KARKEDIKHA_CORE_PORT.');
  const h = { 'Content-Type': 'application/json', ...headers };
  if (useHostAuth && HOST_TOKEN) h['X-Host-Token'] = HOST_TOKEN;
  if (process.env.KARKEDIKHA_CORE_TOKEN) h['Authorization'] = 'Bearer ' + process.env.KARKEDIKHA_CORE_TOKEN;
  const options = { hostname: '127.0.0.1', port: corePort, path: urlPath, method, headers: h };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Self-pairing: create a pairing code (host), redeem it (no auth needed), store token.
async function ensurePairing() {
  let p = readPairing();
  if (p && p.token) {
    // Verify it still works
    const r = await coreRequest('GET', '/v1/bridge/status', null, { 'X-Panda-Pairing': p.token }, false);
    if (r.status === 200) return p.token;
  }
  // Create pairing code (host)
  const codeRes = await coreRequest('POST', '/v1/bridge/pairing-codes', {});
  if (codeRes.status !== 201 && codeRes.status !== 200) throw new Error('Failed to create pairing code: ' + JSON.stringify(codeRes.body));
  const code = codeRes.body.code;
  if (!code) throw new Error('No pairing code returned: ' + JSON.stringify(codeRes.body));
  // Redeem it
  const redeemRes = await coreRequest('POST', '/v1/bridge/pair', { code, label: 'MCP server', extensionId: null }, {}, false);
  if (redeemRes.status !== 201 && redeemRes.status !== 200) throw new Error('Failed to redeem pairing code: ' + JSON.stringify(redeemRes.body));
  const token = redeemRes.body.token;
  if (!token) throw new Error('No pairing token returned: ' + JSON.stringify(redeemRes.body));
  p = { pairingId: redeemRes.body.pairingId, token };
  writePairing(p);
  return token;
}

let pairingToken = null;

async function getPairingToken() {
  if (!pairingToken) pairingToken = await ensurePairing();
  return pairingToken;
}

// Tool implementations
async function listAgents() {
  const r = await coreRequest('GET', '/v1/agents', null);
  if (r.status !== 200) throw new Error('list_agents failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function submitTask(args) {
  const token = await getPairingToken();
  const instruction = String(args.instruction || args.objective || '');
  if (!instruction) throw new Error('instruction is required');
  // Submit bridge task
  const submitRes = await coreRequest('POST', '/v1/bridge/tasks', {
    clientRequestId: 'mcp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    instruction,
    sourceRef: { kind: 'chatgpt', title: 'MCP submission', via: 'send_button' },
  }, { 'X-Panda-Pairing': token }, false);
  if (submitRes.status !== 201 && submitRes.status !== 200) throw new Error('submit_task failed: ' + JSON.stringify(submitRes.body));
  const taskId = submitRes.body.taskId;
  // Dispatch with auto executor (local only)
  const dispatchRes = await coreRequest('POST', `/v1/bridge/tasks/${taskId}/dispatch`, {
    executor: args.executor || 'auto',
    model: args.model || null,
  }, { 'X-Panda-Pairing': token });
  return { taskId, submitted: true, dispatch: dispatchRes.body };
}

async function getTaskStatus(args) {
  const token = await getPairingToken();
  const r = await coreRequest('GET', `/v1/bridge/tasks/${args.taskId}`, null, { 'X-Panda-Pairing': token }, false);
  if (r.status !== 200) throw new Error('get_task_status failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function getTaskReport(args) {
  const token = await getPairingToken();
  const r = await coreRequest('GET', `/v1/bridge/tasks/${args.taskId}`, null, { 'X-Panda-Pairing': token }, false);
  if (r.status !== 200) throw new Error('get_task_report failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function cancelTask(args) {
  const token = await getPairingToken();
  const r = await coreRequest('POST', `/v1/bridge/tasks/${args.taskId}/cancel`, {}, { 'X-Panda-Pairing': token }, false);
  if (r.status !== 200) throw new Error('cancel_task failed: ' + JSON.stringify(r.body));
  return r.body;
}

// MCP protocol (JSON-RPC 2.0 over STDIO)
const TOOLS = [
  { name: 'list_agents', description: 'List configured Pandesh agents and their capabilities.', inputSchema: { type: 'object', properties: {} } },
  { name: 'submit_task', description: 'Submit an objective to Pandesh for local execution. Returns a task id.', inputSchema: { type: 'object', properties: { instruction: { type: 'string', description: 'The task objective.' }, executor: { type: 'string', description: 'Executor: auto, opencode, claude, hermes, native. Default: auto (local only).' }, model: { type: 'string', description: 'Model override (optional).' } }, required: ['instruction'] } },
  { name: 'get_task_status', description: 'Get the current status of a submitted task.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'The task id returned by submit_task.' } }, required: ['taskId'] } },
  { name: 'get_task_report', description: 'Get the consolidated report of a completed task, including verification and evidence.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'The task id.' } }, required: ['taskId'] } },
  { name: 'cancel_task', description: 'Cancel a running task.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'The task id.' } }, required: ['taskId'] } },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pandesh', version: '0.1.8' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};
      let result;
      if (toolName === 'list_agents') result = await listAgents();
      else if (toolName === 'submit_task') result = await submitTask(args);
      else if (toolName === 'get_task_status') result = await getTaskStatus(args);
      else if (toolName === 'get_task_report') result = await getTaskReport(args);
      else if (toolName === 'cancel_task') result = await cancelTask(args);
      else throw new Error('Unknown tool: ' + toolName);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } else if (method === 'notifications/initialized') {
      // no response needed
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message || String(err) } });
  }
});

process.stderr.write('Pandesh MCP server started (dataDir=' + DATA_DIR + ', corePort=' + corePort + ')\n');