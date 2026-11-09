#!/usr/bin/env node
/**
 * Build 161 audit — model-to-tool orchestration benchmark on the REAL Core path.
 *
 *   node scripts/audit/orchestration-bench.mjs --models gemma4:12b,qwen2.5-coder:3b --modes selected,all --out <dir>
 *
 * Each run: an isolated Core (throwaway data dir, never the user's profile), a fresh synthetic workspace, one request
 * submitted and executed exactly like the desktop does (/v1/submit + /v1/attempts/:id/execute, local Ollama only).
 * Approvals are answered by a fixed policy: harmless synthetic-workspace actions are approved; anything that could act
 * outside the throwaway workspace (install, print, system change, external coding agent, phone, mail, publish) is
 * REJECTED — the model's choice of tool is still recorded, which is what is measured.
 *
 * Every outcome is attributed to a stage from Core's own records (runtime events, tool invocations, approvals):
 *   D exposure (expected tool never offered) · A model (offered, not chosen) · B schema/args (chosen, arguments rejected)
 *   E parsing (unknown tool / text tool call) · F approval/security (refused or blocked) · G execution (tool failed)
 *   I final classification (attempt status contradicts what happened) · OK.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const MODELS = String(args.models ?? 'gemma4:12b').split(',').filter(Boolean);
const MODES = String(args.modes ?? 'selected').split(',').filter(Boolean);
const TASK_FILTER = args.tasks ? new Set(String(args.tasks).split(',')) : null;
const OUT = path.resolve(args.out ?? path.join(os.tmpdir(), `pandesh-orch-bench-${Date.now()}`));
const RUN_TIMEOUT_MS = Number(args.timeout ?? 240_000);
fs.mkdirSync(OUT, { recursive: true });

const TASKS = [
  { id: 'T1-list', text: 'List the files in this folder.', expect: ['list_directory', 'search_files'] },
  { id: 'T2-read', text: 'Read notes.md and tell me the three action items in it.', expect: ['read_file'] },
  { id: 'T3-reminder', text: 'Remind me tomorrow at 9:00 to call the flour supplier.', expect: ['create_reminder'] },
  { id: 'T4-tests', text: 'Run the tests in this project and tell me which test fails.', expect: ['run_checks'] },
  { id: 'T5-fix', text: 'Fix the bug in calculator.py so that the failing test passes, then run the tests.', expect: ['write_file', 'delegate_to_coding_agent', 'delegate_to_opencode'] },
  { id: 'T6-lead', text: 'Record a new catering lead: Café Lumen in Bonn, found on their public website cafe-lumen.example, interested in breakfast catering for 40 people.', expect: ['revenue_record_lead'] },
  { id: 'T7-printers', text: 'Which printers are installed on this PC?', expect: ['list_printers'] },
  { id: 'T8-aider', text: 'Use Aider to add type hints to utils.py.', expect: ['delegate_to_coding_agent'] },
  { id: 'T9-calc', text: 'What is 17 percent of 2340 euros?', expect: ['calculate', '(answer)'] },
].filter((t) => !TASK_FILTER || TASK_FILTER.has(t.id));

/** Approvals the harness may grant: they stay inside the throwaway workspace and data dir. */
const APPROVE = /^(?:write_file|run_checks|request_search_permission|memory_remember|create_reminder|revenue_record_lead|revenue_[a-z_]+|create_note|propose_file_change|authorize_mission)$/;

function workspaceTemplate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Bakery notes\n\nAction items:\n1. Order 500 kg of flour from Mühle Krause.\n2. Call the oven technician about the steam valve.\n3. Update the breakfast price list.\n');
  fs.writeFileSync(path.join(dir, 'calculator.py'), 'def add(a, b):\n    return a - b\n\n\ndef multiply(a, b):\n    return a * b\n');
  fs.writeFileSync(path.join(dir, 'test_calculator.py'), 'import unittest\nfrom calculator import add, multiply\n\n\nclass CalculatorTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n    def test_multiply(self):\n        self.assertEqual(multiply(2, 3), 6)\n\n\nif __name__ == "__main__":\n    unittest.main()\n');
  fs.writeFileSync(path.join(dir, 'utils.py'), 'def slugify(text):\n    return "-".join(text.lower().split())\n\n\ndef total(prices):\n    return sum(prices)\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let core = null;

async function startCore(mode) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pandesh-bench-core-${mode}-`));
  const token = `bench-${Math.random().toString(36).slice(2)}`;
  const env = { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir, KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only', PANDESH_TOOL_SELECTION: mode === 'all' ? 'all' : '' };
  const child = spawn(process.execPath, [path.join(repoRoot, 'out-core', 'core.js')], { env, stdio: ['ignore', fs.openSync(path.join(OUT, `core-${mode}.log`), 'a'), fs.openSync(path.join(OUT, `core-${mode}.log`), 'a')] });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
      const res = await fetch(`http://127.0.0.1:${rec.port}/v1/core/info`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return { child, dataDir, token, base: `http://127.0.0.1:${rec.port}`, info: await res.json() };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  child.kill();
  throw new Error('isolated Core did not start');
}

async function stopCore() {
  if (!core) return;
  try {
    await call('POST', '/v1/core/shutdown', { expectedInstanceId: core.info.instanceId, expectedDataDir: core.dataDir });
  } catch { /* gone */ }
  await sleep(1500);
  try { core.child.kill(); } catch { /* gone */ }
  core = null;
}

let keyN = 0;
async function call(method, route, body) {
  const res = await fetch(`${core.base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${core.token}`, 'Content-Type': 'application/json', 'X-Client-Id': 'orchestration-bench', 'Idempotency-Key': `bench-${Date.now()}-${keyN += 1}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`), { status: res.status, body: json });
  return json;
}

async function runTask(model, mode, task) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `pandesh-bench-ws-${task.id}-`));
  workspaceTemplate(ws);
  const t0 = Date.now();
  const conversation = await call('POST', '/v1/conversations', { mode: 'baat_kar', title: `${task.id} ${model}` });
  const submitted = await call('POST', '/v1/submit', {
    currentMessage: task.text, requestedMode: 'saath_kar', conversationId: conversation.id,
    requestedProvider: 'ollama', requestedModel: model, workspaceRoot: ws, hasWorkspace: true, gitCapable: false,
    toolPermissionPolicy: { profile: 'autonomous-mission', worker: 'pi' },
    modelSelection: {
      requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'medium', vision: false, validationAndRepair: true },
      selectedProvider: 'ollama', selectedModel: model, routingPolicy: 'local-only', selectionReason: 'orchestration benchmark', suitabilitySummary: 'orchestration benchmark',
      userOverrode: true, candidates: [{ provider: 'ollama', model, available: true, capable: true, costRank: 1, rejectionReasons: [] }], escalationCandidates: [],
    },
  });
  const attemptId = submitted.attempt.id;
  await call('POST', `/v1/attempts/${attemptId}/execute`, { workingDirectory: ws });
  const approvals = [];
  let attempt = null;
  let timedOut = false;
  for (;;) {
    attempt = await call('GET', `/v1/attempts/${attemptId}`);
    if (['completed', 'failed', 'cancelled'].includes(attempt.status)) break;
    if (Date.now() - t0 > RUN_TIMEOUT_MS) {
      timedOut = true;
      await call('POST', `/v1/attempts/${attemptId}/cancel`, {}).catch(() => undefined);
      await sleep(3000);
      attempt = await call('GET', `/v1/attempts/${attemptId}`);
      break;
    }
    const pending = (await call('GET', '/v1/approvals/pending')).approvals ?? [];
    for (const a of pending) {
      if (approvals.some((x) => x.id === a.id)) continue;
      const tool = String(a.summary?.toolName ?? a.summary?.tool ?? a.presentation?.toolName ?? 'unknown');
      const decision = APPROVE.test(tool) ? 'approved' : 'rejected';
      const owner = await call('GET', `/v1/attempts/${a.attemptId}`);
      try {
        await call('POST', `/v1/approvals/${a.id}/resolve`, {
          resolution: decision, attemptId: a.attemptId, gate: a.kind,
          expectedAttemptRevision: owner.revision, expectedAttemptStatus: owner.status,
          requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision,
        });
        approvals.push({ id: a.id, tool, decision });
      } catch (err) {
        approvals.push({ id: a.id, tool, decision: `resolve_failed: ${err.message.slice(0, 120)}` });
      }
    }
    await sleep(700);
  }
  const elapsedMs = Date.now() - t0;
  const invocations = (await call('GET', `/v1/attempts/${attemptId}/tool-invocations`)).toolInvocations ?? [];
  const events = [];
  // The route caps a page (200); read until a page comes back empty.
  for (let after = 0; ;) {
    const page = (await call('GET', `/v1/runtime-events?after=${after}&limit=200`)).events ?? [];
    for (const e of page) if (e.entityId === attemptId || e.metadata?.attemptId === attemptId) events.push(e);
    if (page.length === 0) break;
    after = page[page.length - 1].sequence;
  }
  const messages = (await call('GET', `/v1/conversations/${conversation.id}/messages`)).messages ?? [];
  const reply = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
  const meta = (e) => (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata ?? e.payload ?? {});
  const selection = events.filter((e) => e.eventType === 'tool_selection').map(meta)[0] ?? {};
  const added = events.filter((e) => e.eventType === 'tool_groups_added').flatMap((e) => meta(e).added ?? []);
  const offered = new Set([...(selection.offeredTools ?? []), ...added]);
  const modelCalls = events.filter((e) => e.eventType === 'model_call').map(meta);
  const called = invocations.map((i) => i.toolName);
  const unknownTool = events.some((e) => e.eventType === 'unknown_tool_loop_stopped') || /not found|unknown tool/i.test(invocations.filter((i) => i.status === 'failed').map((i) => JSON.stringify(i.evidence ?? '')).join(' '));
  const scopeRefusals = events.filter((e) => e.eventType === 'agent_scope_refused' || e.eventType === 'web_research_query_refused').length;
  const expected = task.expect.filter((t) => t !== '(answer)');
  const usedExpected = called.find((t) => expected.includes(t)) ?? null;
  const expectedOffered = expected.some((t) => offered.has(t)) || selection.offeredTools === undefined;
  const expectedInv = invocations.filter((i) => expected.includes(i.toolName));
  let stage;
  if (task.expect.includes('(answer)') && called.length === 0 && attempt.status === 'completed') stage = 'OK';
  else if (!usedExpected && !expectedOffered) stage = 'D_exposure';
  else if (!usedExpected && unknownTool) stage = 'E_parsing';
  else if (!usedExpected) stage = 'A_model';
  else if (approvals.some((a) => expected.includes(a.tool) && a.decision === 'rejected')) stage = 'F_approval_policy';
  else if (expectedInv.length && expectedInv.every((i) => i.status === 'failed') && /invalid|required|argument|schema|missing/i.test(JSON.stringify(expectedInv.map((i) => i.evidence)))) stage = 'B_arguments';
  else if (expectedInv.length && expectedInv.every((i) => i.status === 'failed')) stage = 'G_execution';
  else if (attempt.status !== 'completed') stage = timedOut ? 'H_timeout' : 'I_final_classification';
  else stage = 'OK';
  const sum = (k) => modelCalls.reduce((n, m) => n + (Number(m[k]) || 0), 0);
  const result = {
    model, mode, task: task.id, status: attempt.status, failureReason: attempt.failureReason ?? null, timedOut, elapsedMs, stage,
    expected: task.expect, called, usedExpected, offeredCount: selection.offered ?? null, totalTools: selection.total ?? null,
    expectedOffered, groups: selection.groups ?? null, approvals, scopeRefusals,
    modelCalls: modelCalls.length, loadMs: sum('loadMs'), promptMs: sum('promptMs'), generationMs: sum('generationMs'),
    promptTokens: sum('promptTokens'), outputTokens: sum('outputTokens'), firstTokenMs: modelCalls[0]?.firstTokenMs ?? null,
    reply: String(reply).slice(0, 600),
  };
  fs.appendFileSync(path.join(OUT, 'results.jsonl'), `${JSON.stringify(result)}\n`);
  console.log(`[bench] ${mode} ${model} ${task.id}: ${result.status} ${result.stage} called=[${called.join(',')}] ${Math.round(elapsedMs / 1000)}s`);
  fs.rmSync(ws, { recursive: true, force: true });
  return result;
}

const results = [];
try {
  for (const mode of MODES) {
    core = await startCore(mode);
    console.log(`[bench] isolated Core ${core.info.instanceId} dataDir=${core.dataDir} mode=${mode}`);
    for (const model of MODELS) {
      for (const task of TASKS) {
        try { results.push(await runTask(model, mode, task)); } catch (err) {
          console.log(`[bench] ${mode} ${model} ${task.id}: HARNESS ERROR ${err.message}`);
          fs.appendFileSync(path.join(OUT, 'results.jsonl'), `${JSON.stringify({ model, mode, task: task.id, harnessError: err.message })}\n`);
        }
      }
    }
    await stopCore();
  }
} finally {
  await stopCore();
}
console.log(`[bench] done: ${results.length} runs -> ${path.join(OUT, 'results.jsonl')}`);
