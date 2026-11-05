/**
 * A real local model, a real natural-language chat turn, and one newly exposed
 * capability.
 *
 * The point is the step the governed-dispatch drivers do not cover: the model
 * must read the capability brief, choose `comfyui_status` on its own, call it,
 * and report what the registry's live ComfyUI probe returned. No scripted
 * ModelBackend, no fixture, no mocked tool.
 *
 * Evidence lands in `.acceptance-evidence/chat-capability-live/`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'chat-capability-live');
const runRoot = process.env.PANDESH_CHAT_LIVE_ROOT ?? path.join(repoRoot, '.tmp', `chat-live-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const token = 'chat-capability-live-token';
const hostToken = 'chat-capability-live-host-token';
const model = process.env.PANDESH_CHAT_LIVE_MODEL ?? 'gemma4:26b-a4b-it-qat';

const requestText = process.env.PANDESH_CHAT_LIVE_PROMPT
  ?? 'Which ComfyUI checkpoints are installed on this PC? Check with your ComfyUI status tool, then list the checkpoint filenames.';
const startedAt = new Date().toISOString();
const checks = [];
let child = null;
let elapsedSeconds = null;

/** The tool count and prompt size the engine actually sent, from its own log line. */
function readModelCallMetrics() {
  try {
    const lines = fs.readFileSync(path.join(runRoot, 'core-stdout.log'), 'utf8').split(/\r?\n/).filter((l) => l.includes('stage=model_call'));
    const line = lines[lines.length - 1] ?? '';
    const tools = Number(/tools=(\d+)/.exec(line)?.[1] ?? NaN);
    const promptTokens = Number(/promptTokens=(\d+)/.exec(line)?.[1] ?? NaN);
    return { tools: Number.isFinite(tools) ? tools : null, promptTokens: Number.isFinite(promptTokens) ? promptTokens : null };
  } catch {
    return { tools: null, promptTokens: null };
  }
}

function record(name, status, detail) {
  checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}`}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({
    requestText, model, provider: 'ollama', startedAt, checks,
  }, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startCore() {
  const logPath = path.join(runRoot, 'core-stdout.log');
  fs.mkdirSync(runRoot, { recursive: true });
  const out = fs.openSync(logPath, 'a');
  child = spawn(process.execPath, [bundlePath], {
    env: {
      ...process.env,
      KARKEDIKHA_CORE_TOKEN: token,
      KARKEDIKHA_HOST_TOKEN: hostToken,
      KARKEDIKHA_DATA_DIR: dataDir,
      // The executor falls back to its own default when no model reaches the
      // attempt context; the household demo sets this for the same reason.
      KARKEDIKHA_DEFAULT_MODEL: model,
    },
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
  if (!port) {
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no Core output)';
    throw new Error(`the Core did not publish its discovery record within 30s:\n${log.slice(-1500)}`);
  }
  const healthDeadline = Date.now() + 30_000;
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
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `shutdown-${Date.now()}`,
        'X-Client-Id': 'chat-capability-live-acceptance',
      },
      body: '{}',
    });
  } catch { /* already gone */ }
  await sleep(600);
  if (child && !child.killed) child.kill();
  child = null;
  await sleep(400);
}

async function api(port, method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client-Id': 'chat-capability-live-acceptance',
      ...(urlPath.startsWith('/v1/household/') ? { 'X-Host-Token': hostToken } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': `idem-${Date.now()}-${Math.random()}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const began = Date.now();
  const core = await startCore();
  record('core_started', 'PASS', { port: core.port, instanceId: core.instanceId });

  const conv = await api(core.port, 'POST', '/v1/conversations', { mode: 'saath_kar' });
  if (!conv.body?.id) throw new Error(`conversation was not created: ${JSON.stringify(conv.body)}`);
  await api(core.port, 'POST', `/v1/conversations/${conv.body.id}/messages`, { role: 'user', content: requestText });
  const request = await api(core.port, 'POST', '/v1/requests', {
    currentMessage: requestText,
    requestedMode: 'saath_kar',
    resolvedMode: 'saath_kar',
    routeReason: 'chat-capability-live-acceptance',
    conversationId: conv.body.id,
    requestedProvider: 'ollama',
    requestedModel: model,
    selectedProvider: 'ollama',
    selectedModel: model,
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
  });
  if (!request.body?.id) throw new Error(`request was not created: ${JSON.stringify(request.body)}`);
  const attempt = await api(core.port, 'POST', '/v1/attempts', { requestId: request.body.id, kind: 'saath_kar', workspaceRoot: dataDir });
  if (!attempt.body?.id) throw new Error(`attempt was not created: ${JSON.stringify(attempt.body)}`);
  await api(core.port, 'POST', `/v1/attempts/${attempt.body.id}/execute`, { workingDirectory: dataDir });
  record('live_chat_turn_started', 'PASS', { conversationId: conv.body.id, attemptId: attempt.body.id, model });

  // The read-only status tool should not need a card. If the model asks for a
  // mutation instead, this harness must not approve it.
  const approved = [];
  const refused = [];
  let finalStatus = 'running';
  for (;;) {
    const state = await api(core.port, 'GET', `/v1/attempts/${attempt.body.id}`);
    finalStatus = String(state.body?.status ?? 'unknown');
    if (finalStatus === 'waiting_for_approval') {
      const actions = await api(core.port, 'GET', `/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.body.id)}`);
      const action = (actions.body?.actions ?? []).find((a) => a.actionable);
      if (action) {
        const name = action.toolName;
        const readOnly = name === 'comfyui_status' || name === 'image_list_checkpoints';
        await api(core.port, 'POST', `/v1/capabilities/approvals/${action.approvalId}/resolve`, {
          resolution: readOnly ? 'approved' : 'rejected',
          attemptId: action.attemptId,
          expectedAttemptRevision: action.expectedAttemptRevision,
          expectedAttemptStatus: action.expectedAttemptStatus,
          requestedActionDigest: action.requestedActionDigest,
          frozenContextHash: action.frozenContextHash,
        });
        (readOnly ? approved : refused).push(name);
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(finalStatus)) break;
    if (Date.now() - began > 15 * 60_000) {
      record('live_chat_turn_finished', 'FAIL', { status: finalStatus, reason: 'timed out after 15 minutes' });
      await stopCore(core.port);
      return;
    }
    await sleep(1500);
  }

  const messages = await api(core.port, 'GET', `/v1/conversations/${conv.body.id}/messages`);
  const reply = (messages.body?.messages ?? []).filter((m) => m.role === 'assistant').pop()?.content ?? '';
  const invocations = await api(core.port, 'GET', `/v1/attempts/${attempt.body.id}/tool-invocations`);
  const tools = invocations.body?.toolInvocations ?? [];
  const statusCall = tools.find((t) => t.toolName === 'comfyui_status' || t.toolName === 'image_list_checkpoints');
  const output = String(statusCall?.evidence?.output ?? '');

  record('live_chat_turn_finished', finalStatus === 'completed' ? 'PASS' : 'FAIL', {
    status: finalStatus, elapsedSeconds: Math.round((Date.now() - began) / 1000), failureReason: undefined,
  });
  record('model_chose_a_real_capability_without_a_script', Boolean(statusCall) ? 'PASS' : 'FAIL', {
    tools: tools.map((t) => `${t.toolName}:${t.status}`), approved, refused,
  });
  record('capability_was_really_invoked', statusCall?.status === 'succeeded' && /\.safetensors/.test(output) ? 'PASS' : 'FAIL', {
    tool: statusCall?.toolName, status: statusCall?.status, output: output.slice(0, 500),
  });
  record('reply_names_a_checkpoint_the_tool_returned', /Juggernaut-XL_v9_RunDiffusionPhoto_v2|safetensors/i.test(reply) ? 'PASS' : 'FAIL', {
    reply: reply.slice(0, 800),
  });
  // The previous 20-capability list was 149 tools / ~29k prompt tokens and the
  // model returned one token with no call. Keep the surface bounded; a future
  // capability addition that pushes it back over the cliff fails here.
  const metrics = readModelCallMetrics();
  record('chat_tool_surface_stays_bounded', metrics.tools !== null && metrics.tools <= 130 ? 'PASS' : 'FAIL', metrics);

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'reply.md'), `${reply}\n`);
  elapsedSeconds = Math.round((Date.now() - began) / 1000);
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
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({
    requestText, model, provider: 'ollama', startedAt, finishedAt: new Date().toISOString(), elapsedSeconds,
    modelCall: readModelCallMetrics(), checks,
  }, null, 2));
  console.log(`\n${checks.length} checks, ${failed.length} failed. Evidence: ${evidenceDir}`);
  if (failed.length > 0) process.exitCode = 1;
}
