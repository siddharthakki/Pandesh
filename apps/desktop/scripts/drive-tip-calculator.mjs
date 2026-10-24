import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9340';
const fixtureInfoPath = path.join(repoRoot, '.tmp', 'tip-calculator-fixture.json');
const fixture = process.env.KARKEDIKHA_TIP_CALCULATOR_REPO
  || (fs.existsSync(fixtureInfoPath) ? JSON.parse(fs.readFileSync(fixtureInfoPath, 'utf8')).fixture : null);
if (!fixture) throw new Error('prepare a fixture first (apps/desktop/scripts/prepare-tip-calculator.mjs)');
const evidencePath = path.join(repoRoot, '.tmp', 'desktop-tip-calculator-workflow.json');
const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
const remotes = execFileSync('git', ['remote', '-v'], { cwd: fixture, encoding: 'utf8' }).trim();

export const TIP_TASK = [
  'Inspect this existing tip-calculator web app first by reading its files.',
  'Add a "Round up per-person total" option that also shows the resulting effective tip.',
  'Keep input validation, retain entered values after Calculate, and do not reload the page on Calculate.',
  'Run the focused calculation tests and a browser-interaction check.',
  'Inspect desktop (~1280px) and mobile (~390px) layout.',
  'Review the git diff, then create a local git commit.',
  'Do not push. Do not change files outside this repository.',
].join(' ');

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
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) });
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

async function uiState() {
  return evaluate(`({
    core: document.getElementById('core-state').textContent,
    folder: document.getElementById('folder-path').textContent,
    submitDisabled: document.getElementById('submit').disabled,
    cancelDisabled: document.getElementById('cancel').disabled,
    approvalHidden: document.getElementById('approval-panel').hidden,
    gate: document.getElementById('approval-gate').textContent,
    tool: document.getElementById('approval-tool').textContent,
    scope: document.getElementById('approval-scope').textContent,
    paths: document.getElementById('approval-paths')?.textContent ?? '',
    approveDisabled: document.getElementById('approve').disabled,
    rejectDisabled: document.getElementById('reject').disabled,
    task: document.getElementById('current-task').textContent,
    result: document.getElementById('result').textContent,
    activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
    ids: document.getElementById('ids').textContent,
    scopeRepo: document.getElementById('scope-repo')?.textContent ?? '',
    scopeActions: document.getElementById('scope-actions')?.textContent ?? '',
    scopeDelivery: document.getElementById('scope-delivery')?.textContent ?? '',
    scopeState: document.getElementById('scope-state')?.textContent ?? '',
  })`);
}

const startedAt = Date.now();
const approvals = [];
const interventions = [];

const ready = await waitFor('submit ready', async () => {
  const state = await uiState();
  if (state.core === 'connected' && state.folder && state.folder.includes(path.basename(fixture)) && state.submitDisabled === false) {
    return state;
  }
  return null;
}, 90_000);

await evaluate(`
  (async () => {
    const input = document.getElementById('task-input');
    input.value = ${JSON.stringify(TIP_TASK)};
    document.getElementById('submit').click();
  })()
`);
interventions.push({ kind: 'authorize-and-submit', at: new Date().toISOString() });

const submitted = await waitFor('task submitted', async () => {
  const state = await uiState();
  if (state.ids && state.submitDisabled === true) return state;
  return null;
}, 30_000);

await waitFor('workflow terminal', async () => {
  const state = await uiState();
  if (state.approvalHidden === false && state.approveDisabled === false) {
    approvals.push({
      at: new Date().toISOString(),
      gate: state.gate,
      tool: state.tool,
      scope: state.scope,
      paths: state.paths,
      ids: state.ids,
    });
    interventions.push({ kind: 'out-of-scope-blocked', at: new Date().toISOString(), scope: state.scope, tool: state.tool });
    throw new Error(`out-of-scope Core gate left unapproved: ${state.scope}`);
  }
  if (state.submitDisabled === false && state.approvalHidden === true && (state.ids === '' || /Final answer|Attempt cancelled|execution failed/i.test(state.result))) {
    return state;
  }
  return null;
}, 2_400_000);

const finalUi = await uiState();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
const changed = execFileSync('git', ['diff', '--name-only', `${baseline}..HEAD`], { cwd: fixture, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
const log = execFileSync('git', ['log', '-1', '--format=%H%n%s'], { cwd: fixture, encoding: 'utf8' }).trim();
const calculate = fs.readFileSync(path.join(fixture, 'src', 'calculate.js'), 'utf8');
const app = fs.readFileSync(path.join(fixture, 'src', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(fixture, 'index.html'), 'utf8');
let focusedTest = { ok: false, output: '' };
try {
  focusedTest.output = execFileSync(process.execPath, ['--test', path.join(fixture, 'tests', 'calculate.test.js')], {
    cwd: fixture,
    encoding: 'utf8',
  });
  focusedTest.ok = true;
} catch (err) {
  focusedTest.output = err instanceof Error ? String(err.stdout || err.message) : String(err);
}

const evidence = {
  fixture,
  remotes: remotes || '(none)',
  baseline,
  ready,
  submitted,
  approvals,
  interventions,
  autoAuthorized: (finalUi.activity ?? []).filter((line) => /in-scope Core gate auto-authorized/i.test(line)),
  finalUi,
  elapsedMs: Date.now() - startedAt,
  commit: head,
  commitLog: log,
  changed,
  hasRoundUp: /round up per-person total/i.test(`${html}\n${app}\n${calculate}`),
  hasEffectiveTip: /effective tip/i.test(`${html}\n${app}\n${calculate}`),
  focusedTest,
  requestAttemptIds: submitted.ids,
};
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));

const ok = head !== baseline
  && evidence.hasRoundUp
  && evidence.hasEffectiveTip
  && evidence.focusedTest.ok;
cdp.ws?.close();
if (!ok) {
  console.error('independent verification failed');
  process.exit(1);
}
process.exit(0);
