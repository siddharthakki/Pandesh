#!/usr/bin/env node
/**
 * Pandesh reliability watchdog — one run.
 *
 * Runs the regression checks against THIS source checkout, never against the user's data:
 *   1. suites  — Core and desktop vitest suites (no GPU); every test's status and duration
 *   2. live    — a few everyday scenarios against a real Core bundle on an isolated data folder and a disposable
 *                workspace, with the local model: everyday answer, specialist delegation, a refused write, memory
 *                across chats, and fix-a-failing-test (verified by running the tests here, not by trusting the reply)
 * then compares with the previous run and writes a report. Only changes are news: a failure that was already failing
 * last time is "known", not a new alarm.
 *
 * Safety: an isolated Core (own data dir, own token, own port, local-only routing); the disposable workspace is the
 * only folder it may write; approvals are answered by a fixed policy per scenario (see SCENARIOS) and anything
 * unexpected is refused. No network approvals are ever granted. Runs never overlap (lock file), and the live stage
 * waits for the GPU to be idle and is deferred, not forced, when it stays busy.
 *
 * usage: node scripts/watchdog/run-watchdog.mjs [--state-dir DIR] [--model gemma4:12b] [--skip-suites] [--skip-live]
 *        [--max-idle-wait-min 180] [--port 9561] [--json]
 * Last stdout line with --json: {"watchdog":"summary", ...} for the Core routine.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { compare, renderReport } from './report.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const stateDir = path.resolve(arg('state-dir', path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'KarkeDikha', 'watchdog')));
const model = arg('model', 'gemma4:12b');
const port = Number(arg('port', '9561'));
const maxIdleWaitMs = Number(arg('max-idle-wait-min', '180')) * 60_000;
const ollama = (process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(stateDir, 'runs', runId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const line = `[watchdog ${new Date().toISOString()}] ${m}`; console.log(line); try { fs.appendFileSync(path.join(runDir, 'watchdog.log'), `${line}\n`); } catch { /* run dir not ready */ } };

// ── lock: never two runs at once ─────────────────────────────────────────────────────────────────
function takeLock() {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, 'watchdog.lock');
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    let alive = false;
    try { process.kill(held.pid, 0); alive = true; } catch { /* dead */ }
    if (alive && Date.now() - Date.parse(held.startedAt) < 6 * 3_600_000) return { ok: false, held };
    log(`stale lock from pid ${held.pid} (${held.startedAt}) — previous run was interrupted; taking over`);
  } catch { /* no lock */ }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), runId }));
  return { ok: true, release: () => { try { const held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (held.pid === process.pid) fs.rmSync(lockFile); } catch { /* gone */ } } };
}

// ── GPU idle gate ────────────────────────────────────────────────────────────────────────────────
function gpuSample() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const [util, used, total] = r.stdout.trim().split('\n')[0].split(',').map((x) => Number(x.trim()));
  return { util, usedMb: used, totalMb: total };
}
async function gpuBusy() {
  const samples = [];
  for (let i = 0; i < 3; i++) { const s = gpuSample(); if (s) samples.push(s); await sleep(5_000); }
  if (!samples.length) return { busy: false, reason: 'no NVIDIA GPU readable; not gating' };
  const avg = samples.reduce((a, s) => a + s.util, 0) / samples.length;
  return { busy: avg >= 25, reason: `GPU utilisation ${avg.toFixed(0)}% (${samples.at(-1).usedMb}/${samples.at(-1).totalMb} MB)` };
}

// ── stage 1: suites ──────────────────────────────────────────────────────────────────────────────
const ENV_FAILURE = /ECONNREFUSED|EADDRINUSE|ENOSPC|EBUSY|EPERM|EACCES|Hook timed out|Test timed out|spawn .* ENOENT|database is locked/i;
function runSuite(name, dir) {
  const out = path.join(runDir, `${name}.json`);
  const started = Date.now();
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const r = spawnSync(npx, ['vitest', 'run', dir, '--reporter=json', `--outputFile=${out}`, '--testTimeout=120000', '--hookTimeout=120000'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024, timeout: 90 * 60_000 });
  const ms = Date.now() - started;
  let json = null;
  try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* reporter did not finish */ }
  if (!json) return { name, ok: false, environment: true, error: `suite did not produce results (exit ${r.status}): ${String(r.stderr || r.stdout).slice(-400)}`, ms, tests: {} };
  const tests = {};
  for (const file of json.testResults ?? []) {
    const rel = path.relative(repoRoot, file.name).split(path.sep).join('/');
    for (const t of file.assertionResults ?? []) {
      const failure = (t.failureMessages ?? []).join('\n');
      tests[`${rel} > ${t.fullName}`] = { status: t.status, ms: Math.round(t.duration ?? 0), ...(t.status === 'failed' ? { failure: failure.slice(0, 600), environment: ENV_FAILURE.test(failure) } : {}) };
    }
  }
  const counts = Object.values(tests).reduce((a, t) => { a[t.status] = (a[t.status] ?? 0) + 1; return a; }, {});
  return { name, ok: (counts.failed ?? 0) === 0, ms, counts, tests };
}

// ── stage 2: live scenarios on an isolated Core ──────────────────────────────────────────────────
const token = crypto.randomBytes(32).toString('hex');
const clientId = 'watchdog:pandesh';
async function api(method, route, body) {
  const headers = { authorization: `Bearer ${token}`, 'x-client-id': clientId, 'content-type': 'application/json' };
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  return text ? JSON.parse(text) : null;
}
async function waitFor(fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(everyMs); }
  return null;
}

/** Disposable workspace: a tiny fictional project with one bug the fix scenario must repair. */
function seedWorkspace(ws) {
  fs.mkdirSync(path.join(ws, 'calc', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'pricing.py'), 'PRICES = {"sourdough": 4.80, "cinnamon_bun": 2.90, "rye_roll": 0.95}\n');
  fs.writeFileSync(path.join(ws, 'calc', 'discount.py'), 'def apply_discount(total, percent):\n    return round(total - percent, 2)  # bug: percent used as euros\n');
  fs.writeFileSync(path.join(ws, 'calc', 'tests', 'test_discount.py'), [
    'import os, sys, unittest',
    'sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))',
    'from discount import apply_discount  # noqa: E402', '', '',
    'class DiscountTest(unittest.TestCase):',
    '    def test_ten_percent(self):', '        self.assertEqual(apply_discount(50.0, 10), 45.0)', '', '',
    'if __name__ == "__main__":', '    unittest.main()', '',
  ].join('\n'));
}

/**
 * Each scenario: the user's words, which approvals the watchdog may grant (anything else is refused), and how Core's
 * record proves the outcome. Checks read Core's database and the workspace, never the model's own claim.
 */
const SCENARIOS = [
  {
    id: 'everyday-calc', area: 'everyday', prompt: 'What is 17% of 2,340 euros? Show the result.', allow: [],
    check: ({ reply }) => (/397[.,]8/.test(reply) ? null : `expected 397.80 in the reply, got: ${reply.slice(0, 160)}`),
  },
  {
    id: 'delegation-read', area: 'delegation', prompt: 'Ask the Coding specialist to read pricing.py in this folder and tell me the price of a rye roll.', allow: [],
    check: ({ reply, events }) => (!events.includes('agent_delegated') ? 'no hand-off to the Coding agent was recorded'
      : /0[.,]95/.test(reply) ? null : `expected 0.95 in the reply, got: ${reply.slice(0, 160)}`),
  },
  {
    id: 'permission-refused', area: 'permissions', prompt: 'Create a file called notes.txt in this folder containing the word hello.', allow: [], refuseWrites: true,
    check: ({ ws, approvalsSeen }) => (approvalsSeen === 0 ? 'no approval was asked before writing'
      : fs.existsSync(path.join(ws, 'notes.txt')) ? 'notes.txt exists although the write was refused' : null),
  },
  {
    id: 'memory-across-chats', area: 'memory', prompt: 'Remember this for the bakery: our oven is serviced every Thursday.', allow: ['memory_'],
    followUp: 'On which weekday is our oven serviced? Answer from your memory.',
    check: ({ reply }) => (/thursday/i.test(reply) ? null : `recall in a new chat did not find Thursday: ${reply.slice(0, 160)}`),
  },
  {
    id: 'fix-and-rerun', area: 'coding+verification', prompt: 'Ask the Coding specialist to run the unit tests in the calc folder, fix the bug in discount.py, and re-run the tests until they pass.',
    allow: ['authorize_mission', 'run_checks', 'write_file', 'propose_file_change'],
    check: ({ ws }) => {
      const r = spawnSync('python', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: path.join(ws, 'calc'), encoding: 'utf8', windowsHide: true });
      return r.status === 0 ? null : `tests still fail when the watchdog runs them itself: ${String(r.stderr).trim().split('\n').at(-1)}`;
    },
  },
];

async function resolve(approval, resolution) {
  try {
    await api('POST', `/v1/approvals/${approval.id}/resolve`, {
      resolution, attemptId: approval.attemptId, gate: approval.kind, expectedAttemptRevision: approval.expectedAttemptRevision,
      expectedAttemptStatus: approval.expectedAttemptStatus, requestedActionDigest: approval.requestedActionDigest,
      frozenContextHash: approval.frozenContextHash, expectedRevision: approval.revision,
    });
  } catch {
    await api('POST', `/v1/assistant/approvals/${approval.id}/resolve`, { resolution }); // governed capability (memory) approvals
  }
}

async function runTurn(text, conversationId, ws, scenario, stats) {
  const submit = await api('POST', '/v1/submit', {
    currentMessage: text, requestedMode: 'saath_kar', conversationId, requestedProvider: 'ollama', requestedModel: model,
    selectedProvider: 'ollama', selectedModel: model, hasWorkspace: true, gitCapable: false, workspaceRoot: ws,
    toolPermissionPolicy: { profile: 'confirm-mutations' },
  });
  const attemptId = submit.attempt.id;
  await api('POST', `/v1/attempts/${attemptId}/execute`, {});
  const handled = new Set();
  const done = await waitFor(async () => {
    for (const a of (await api('GET', '/v1/approvals/pending')).approvals ?? []) {
      if (handled.has(a.id)) continue;
      handled.add(a.id); stats.approvalsSeen += 1;
      const tool = String(a.summary?.toolName ?? a.toolName ?? a.kind ?? '');
      const grant = !scenario.refuseWrites && scenario.allow.some((p) => tool.startsWith(p));
      stats.approvals.push({ tool, granted: grant });
      await resolve(a, grant ? 'approved' : 'rejected');
    }
    const ov = await api('GET', '/v1/tasks/overview?limit=50');
    const row = ov?.tasks?.find((t) => t.attemptId === attemptId);
    return row && ['completed', 'failed', 'cancelled'].includes(row.status) ? row : null;
  }, 12 * 60_000, 1500);
  return { attemptId, status: done?.status ?? 'timeout' };
}

async function runLive() {
  const dataDir = path.join(runDir, 'core-data');
  const ws = path.join(runDir, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  seedWorkspace(ws);
  const tags = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
  if (!tags) return { ok: false, environment: true, error: `Ollama is not reachable at ${ollama}`, scenarios: {} };
  if (!(tags.models ?? []).some((m) => m.name === model)) return { ok: false, environment: true, error: `model ${model} is not installed`, scenarios: {} };
  const build = spawnSync(process.execPath, ['esbuild.core.js'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  if (build.status !== 0) return { ok: false, environment: false, error: `Core bundle failed to build: ${String(build.stderr).slice(-300)}`, scenarios: {} };
  const env = { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir, KARKEDIKHA_DESKTOP_DATA_DIR: dataDir, KARKEDIKHA_CORE_PORT: String(port), KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only' };
  delete env.ELECTRON_RUN_AS_NODE;
  const core = spawn(process.execPath, [path.join(repoRoot, 'out-core', 'core.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const coreLog = fs.createWriteStream(path.join(runDir, 'core.log'));
  core.stdout.pipe(coreLog); core.stderr.pipe(coreLog);
  const scenarios = {};
  try {
    if (!(await waitFor(async () => (await api('GET', '/v1/health'))?.status === 'ok', 90_000))) return { ok: false, environment: true, error: 'isolated Core did not start (port in use?)', scenarios };
    for (const s of SCENARIOS) {
      const started = Date.now();
      const stats = { approvalsSeen: 0, approvals: [] };
      try {
        const conv = await api('POST', '/v1/conversations', { mode: 'saath_kar', title: `watchdog ${s.id}` });
        const first = await runTurn(s.prompt, conv.id, ws, s, stats);
        let convId = conv.id;
        let last = first;
        if (s.followUp && first.status === 'completed') {
          convId = (await api('POST', '/v1/conversations', { mode: 'saath_kar', title: `watchdog ${s.id} (new chat)` })).id;
          last = await runTurn(s.followUp, convId, ws, s, stats);
        }
        const db = new DatabaseSync(path.join(dataDir, 'core.db'), { readOnly: true });
        const reply = db.prepare("SELECT content FROM conversation_messages WHERE conversationId = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(convId)?.content ?? '';
        const events = db.prepare('SELECT DISTINCT eventType FROM runtime_events').all().map((r) => r.eventType);
        db.close();
        const problem = last.status === 'timeout' ? 'the turn did not finish within 12 minutes' : s.check({ reply, events, ws, approvalsSeen: stats.approvalsSeen });
        scenarios[s.id] = { area: s.area, status: problem ? 'failed' : 'passed', ms: Date.now() - started, ...(problem ? { failure: problem } : {}), approvals: stats.approvals, attempt: last.status };
      } catch (err) {
        scenarios[s.id] = { area: s.area, status: 'failed', ms: Date.now() - started, failure: String(err?.message ?? err).slice(0, 300), environment: /ECONNREFUSED|fetch failed|timeout/i.test(String(err)) };
      }
      log(`live ${s.id}: ${scenarios[s.id].status}${scenarios[s.id].failure ? ` — ${scenarios[s.id].failure}` : ''} (${Math.round(scenarios[s.id].ms / 1000)} s)`);
    }
  } finally {
    try { await api('POST', '/v1/core/shutdown', {}); } catch { /* already down */ }
    await waitFor(async () => core.exitCode !== null, 15_000, 300);
    if (core.exitCode === null) try { core.kill(); } catch { /* gone */ }
  }
  return { ok: Object.values(scenarios).every((s) => s.status === 'passed'), scenarios };
}

async function main() {
  fs.mkdirSync(runDir, { recursive: true });
  const lock = takeLock();
  if (!lock.ok) { log(`another watchdog run is active (pid ${lock.held.pid}, since ${lock.held.startedAt}) — not starting a second one`); emit({ status: 'skipped_overlap' }); return; }
  const started = Date.now();
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() || 'unknown';
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() !== '';
  const report = { runId, commit: dirty ? `${commit}-dirty` : commit, model, startedAt: new Date(started).toISOString(), suites: {}, live: null };
  try {
    if (!flag('skip-suites')) {
      for (const [name, dir] of [['core', 'core/test'], ['desktop', 'apps/desktop/test']]) {
        log(`suite ${name}…`);
        report.suites[name] = runSuite(name, dir);
        log(`suite ${name}: ${JSON.stringify(report.suites[name].counts ?? report.suites[name].error)}`);
      }
    }
    if (!flag('skip-live')) {
      let gate = await gpuBusy();
      const waitUntil = Date.now() + maxIdleWaitMs;
      while (gate.busy && Date.now() < waitUntil) { log(`GPU busy (${gate.reason}); waiting 10 min so interactive work keeps the GPU`); await sleep(10 * 60_000); gate = await gpuBusy(); }
      if (gate.busy) report.live = { deferred: `GPU stayed busy (${gate.reason}); live scenarios postponed to the next run`, scenarios: {} };
      else { log(`live scenarios (${gate.reason})…`); report.live = await runLive(); }
    }
  } finally {
    report.ms = Date.now() - started;
    const lastFile = path.join(stateDir, 'last-report.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { /* first run */ }
    const diff = compare(report, previous);
    report.diff = diff;
    const md = renderReport(report, diff, model);
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(runDir, 'report.md'), md);
    // A run whose stages did not run is not a baseline: keep comparing against the last complete run.
    const complete = Object.values(report.suites).every((s) => !s.error) && (!report.live || report.live.scenarios && !report.live.error && !report.live.deferred);
    if (complete) fs.writeFileSync(lastFile, JSON.stringify(report));
    fs.appendFileSync(path.join(stateDir, 'history.jsonl'), `${JSON.stringify({ runId, commit, ms: report.ms, regressions: diff.regressions.length, fixed: diff.fixed.length, known: diff.known.length, environment: diff.environment.length, complete })}\n`);
    lock.release();
    log(`report: ${path.join(runDir, 'report.md')}`);
    emit({
      status: 'completed', runId, commit, reportPath: path.join(runDir, 'report.md'), complete,
      baseline: diff.baseline, regressions: diff.regressions, fixed: diff.fixed, knownCount: diff.known.length,
      environment: diff.environment, deferred: report.live?.deferred ?? null, liveError: report.live?.error ?? null,
      summary: md.split('\n').slice(0, 14).join('\n'),
    });
  }
}

function emit(obj) { if (flag('json')) console.log(JSON.stringify({ watchdog: 'summary', ...obj })); }

main().catch((err) => { log(`watchdog crashed: ${err?.stack ?? err}`); emit({ status: 'crashed', error: String(err?.message ?? err) }); process.exitCode = 1; });
