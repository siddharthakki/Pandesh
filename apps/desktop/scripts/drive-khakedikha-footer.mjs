/**
 * Kha Ke Dikha footer year smoke: packaged Jarvis → Core (local model).
 * Creates/uses an isolated git worktree; does not touch the original checkout files.
 *
 * Usage:
 *   node apps/desktop/scripts/drive-khakedikha-footer.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const portableRoot = process.env.KARKEDIKHA_DESKTOP_PORTABLE_OUT
  ?? path.join(repoRoot, 'dist', 'pandesh-win32-x64');
const sourceRepo = process.env.KARKEDIKHA_KHA_SOURCE
  ?? 'C:\\Projects\\apps\\khakedikha';
const baseBranch = process.env.KARKEDIKHA_KHA_BASE_BRANCH ?? 'm17-khakedikha-dogfood';
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9488';
const scratch = process.env.KARKEDIKHA_KHA_PROOF_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-footer-jarvis-smoke');
const worktree = process.env.KARKEDIKHA_KHA_WORKTREE
  ?? path.join(scratch, 'worktree');
const branchName = process.env.KARKEDIKHA_KHA_BRANCH
  ?? `jarvis/footer-year-2026-${Date.now().toString(36)}`;
const dataDir = path.join(scratch, 'desktop-data');
const evidencePath = path.join(scratch, 'khakedikha-footer-evidence.json');
const preferredModel = (process.env.KARKEDIKHA_DESKTOP_MODEL || '').trim();

const TASK = [
  'You are editing the Kha Ke Dikha Django app in this repository only.',
  'Goal: change templates/base.html footer copyright year from 2025 to 2026.',
  'Exact intended line currently contains: &copy; 2025 Kha Ke Dikha',
  'Replace only the digits 2025 with 2026 on that footer line. Keep &copy;, Kha Ke Dikha, and the rest of the line unchanged.',
  'Do not replace the footer with unrelated text. Do not invent a different copyright owner.',
  'Do not edit any other file. After the edit, create one local git commit. Do not push or merge.',
].join(' ');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(400);
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
  }, 120_000);

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
      const pending = cdp.pending.get(msg.id);
      if (!pending) return;
      cdp.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    await cdp('Runtime.enable');
  }

  const id = cdp.nextId++;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return result.result?.value;
}

function killPid(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // ignore
  }
}

function prepareWorktree() {
  if (!fs.existsSync(sourceRepo)) throw new Error(`source repo missing: ${sourceRepo}`);
  fs.mkdirSync(scratch, { recursive: true });
  // Remove a stale worktree/branch left ONLY by a prior crashed run reusing this
  // exact KARKEDIKHA_KHA_PROOF_SCRATCH/branch. Matched by exact resolved path and
  // exact branch name, never by prefix or substring: earlier runs' proof
  // directories and branches (e.g. smoke-4, smoke-5) are evidence and must
  // never be swept just because they share the "karkedikha-footer-jarvis-smoke"
  // or "jarvis/footer-year-2026-" naming convention.
  try {
    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: sourceRepo, encoding: 'utf8' });
    for (const block of listed.split('\n\n')) {
      const m = block.match(/^worktree (.+)$/m);
      if (m && path.resolve(m[1]) === path.resolve(worktree)) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', m[1]], { cwd: sourceRepo, stdio: 'ignore' });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  if (fs.existsSync(worktree)) {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  try {
    execFileSync('git', ['branch', '-D', branchName], { cwd: sourceRepo, stdio: 'ignore' });
  } catch {
    // ignore: branch did not exist, which is the normal case
  }
  execFileSync(
    'git',
    ['worktree', 'add', '-b', branchName, worktree, baseBranch],
    { cwd: sourceRepo, stdio: 'inherit' },
  );
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  const baseHtml = fs.readFileSync(path.join(worktree, 'templates', 'base.html'), 'utf8');
  if (!baseHtml.includes('© 2025') && !baseHtml.includes('&copy; 2025')) {
    throw new Error('worktree base.html does not contain 2025 copyright as expected');
  }
  // Confirm original checkout unchanged at start.
  const original = fs.readFileSync(path.join(sourceRepo, 'templates', 'base.html'), 'utf8');
  if (!original.includes('2025')) {
    throw new Error('original checkout base.html unexpected');
  }
  return { head, branchName, baseHtml };
}

/**
 * The one intended edit for this task, expressed the same way Core's
 * mission-authorization frozen-edit match works: an anchor that must occur
 * exactly once, and its exact replacement. Used both to judge the approval
 * card's rendered diff before clicking approve, and to independently verify
 * the committed file afterward — never inferred from the tool name, the
 * path, or how small the diff looks (that heuristic is what let the Run D
 * truncation pass as `ok: true` even though it deleted unrelated content).
 */
function footerYearAnchor(baseline) {
  const match = /(&copy;|©)(\s*)2025/.exec(baseline);
  if (!match) return null;
  return { find: match[0], replace: `${match[1]}${match[2]}2026` };
}

function expectedAfterIntendedEdit(baseline) {
  const anchor = footerYearAnchor(baseline);
  if (!anchor) return null;
  if (baseline.split(anchor.find).length - 1 !== 1) return null;
  return baseline.replace(anchor.find, anchor.replace);
}

/**
 * Does the approval card's rendered unified diff show ONLY the intended
 * anchored replacement — exactly one removed line and one added line, and
 * those two lines differ by nothing but the year? A truncated rewrite or an
 * unrelated deletion shows extra +/- lines and fails this check, so it is
 * never approved by filename or tool-name alone.
 */
function diffShowsOnlyIntendedEdit(detailText, baseline) {
  const anchor = footerYearAnchor(baseline);
  if (!anchor || typeof detailText !== 'string' || !detailText.trim()) return false;
  const lines = detailText.split(/\r?\n/);
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  if (removed.length !== 1 || added.length !== 1) return false;
  const removedLine = removed[0].slice(1);
  const addedLine = added[0].slice(1);
  return removedLine.includes(anchor.find)
    && addedLine === removedLine.replace(anchor.find, anchor.replace);
}

function launchPortable() {
  const electronExe = path.join(portableRoot, 'electron', 'electron.exe');
  const appDir = path.join(portableRoot, 'app');
  const nodeExe = path.join(portableRoot, 'runtime', 'node.exe');
  const coreJs = path.join(portableRoot, 'runtime', 'core.js');
  for (const required of [electronExe, appDir, nodeExe, coreJs]) {
    if (!fs.existsSync(required)) throw new Error(`portable artifact missing: ${required}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(scratch, 'desktop-host.log');
  // ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node (no window,
  // no CDP port) instead of launching the app; strip it even if the calling
  // shell has it set, or the CDP wait below hangs and times out with no clue
  // why (observed: smoke-6 first attempt, "timed out waiting for cdp list").
  const { ELECTRON_RUN_AS_NODE: _dropRunAsNode, ...cleanEnv } = process.env;
  const child = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, appDir], {
    cwd: portableRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      // Core (`core/runtime/ollamaChatControls.ts`) omits num_ctx by default,
      // so Ollama loads this model at its Modelfile default (65536) unless
      // told otherwise — observed live to force a partial GPU/CPU split and
      // collapse generation to well under 1 tok/s (same shape as the "Run B"
      // failure in AI_OS_STATE.md). 8192 plus thinking on is the config every
      // successful run (C, D, and this session's clean acceptance) has used.
      // Set as defaults here, not unconditionally, so an operator's explicit
      // env override for a deliberate experiment still wins.
      KARKEDIKHA_OLLAMA_NUM_CTX: '8192',
      KARKEDIKHA_OLLAMA_THINK: '1',
      ...cleanEnv,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: portableRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: coreJs,
      KARKEDIKHA_DESKTOP_NODE: nodeExe,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_REPO: worktree,
      KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      KARKEDIKHA_DESKTOP_MODEL: preferredModel,
    },
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

async function uiState() {
  return evaluate(`({
    core: document.getElementById('core-state')?.textContent ?? '',
    folder: document.getElementById('folder-path')?.textContent ?? '',
    model: document.getElementById('model-select')?.value
      || document.getElementById('model-label')?.textContent
      || '',
    submitDisabled: document.getElementById('submit')?.disabled ?? true,
    approvalHidden: document.getElementById('approval-panel')?.hidden ?? true,
    gate: document.getElementById('approval-gate')?.textContent ?? '',
    tool: document.getElementById('approval-tool')?.textContent ?? '',
    scope: document.getElementById('approval-scope')?.textContent ?? '',
    paths: document.getElementById('approval-paths')?.textContent ?? '',
    detail: document.getElementById('approval-detail')?.textContent ?? '',
    approveDisabled: document.getElementById('approve')?.disabled ?? true,
    result: document.getElementById('result')?.textContent ?? '',
    activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
    ids: document.getElementById('ids')?.textContent ?? '',
    worker: document.getElementById('worker-select')?.value ?? '',
    lastTurn: null,
  })`);
}

async function main() {
  if (!fs.existsSync(path.join(portableRoot, 'Launch-Pandesh.cmd'))) {
    throw new Error(`Portable build missing at ${portableRoot}`);
  }

  const startedAt = Date.now();
  const interventions = [];
  const approvals = [];
  const prepared = prepareWorktree();
  const baseline = prepared.head;
  const baselineHtml = prepared.baseHtml;
  const evidence = {
    startedAt: new Date().toISOString(),
    sourceRepo,
    worktree,
    branch: prepared.branchName,
    baseline,
    portableRoot,
    preferredModel,
    task: TASK,
    interventions,
    approvals,
    ok: false,
  };

  let pid;
  try {
    const launch = launchPortable();
    pid = launch.pid;
    evidence.pid = pid;
    evidence.logPath = launch.logPath;

    await waitFor('desktop api', async () => evaluate('Boolean(window.karkedikhaDesktop)'));
    const connected = await waitFor('core connected', async () => {
      const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
      return snap?.coreState === 'connected' ? snap : null;
    }, 120_000);
    evidence.modelFromSnapshot = connected.model;
    evidence.apiBase = connected.apiBase;

    const models = await evaluate('window.karkedikhaDesktop.listModels()');
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('No Ollama models installed; cannot run local coding model');
    }
    evidence.availableModels = models;
    const preferenceOrder = [
      preferredModel,
      'qwen3.8:27b-mtp-q4_K_M',
      'qwen3.6:27b',
      'qwen2.5-coder:7b',
      'qwen2.5-coder:3b',
      'qwen2.5-coder:1.5b',
      connected.model,
      models[0],
    ].filter(Boolean);
    const selectedModel = preferenceOrder.find((m) => models.includes(m)) || models[0];
    await evaluate(`window.karkedikhaDesktop.selectModel(${JSON.stringify(selectedModel)})`);
    evidence.model = selectedModel;
    interventions.push({ kind: 'select-model', at: new Date().toISOString(), model: selectedModel });

    // Prefer a mutation-capable worker for file edit.
    const snap = await evaluate('window.karkedikhaDesktop.getSnapshot()');
    const workers = snap?.workers || [];
    const mutation = workers.find((w) => w.selectable && w.mode === 'mutation');
    if (mutation?.id) {
      await evaluate(`window.karkedikhaDesktop.selectWorker(${JSON.stringify(mutation.id)})`);
      interventions.push({ kind: 'select-worker', at: new Date().toISOString(), worker: mutation.id });
      evidence.worker = mutation.id;
    } else {
      evidence.worker = snap?.selectedWorker || 'local-core';
    }

    const ready = await waitFor('folder+submit ready', async () => {
      const state = await uiState();
      const folderOk = state.folder && (
        state.folder.toLowerCase().includes('worktree')
        || state.folder.toLowerCase().includes('khakedikha')
        || state.folder.replace(/\\/g, '/').includes(worktree.replace(/\\/g, '/').split('/').pop())
      );
      if (state.core === 'connected' && folderOk && state.submitDisabled === false) return state;
      return null;
    }, 90_000);
    evidence.ready = ready;

    await evaluate(`
      (async () => {
        const input = document.getElementById('task-input');
        if (!input) throw new Error('task-input missing');
        input.value = ${JSON.stringify(TASK)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('submit').click();
      })()
    `);
    interventions.push({ kind: 'submit-task', at: new Date().toISOString() });

    await waitFor('task running', async () => {
      const state = await uiState();
      return state.submitDisabled === true || (state.ids && state.ids.length > 0) ? state : null;
    }, 60_000);

    const terminal = await waitFor('workflow terminal', async () => {
      const state = await uiState();
      if (state.approvalHidden === false && state.approveDisabled === false) {
        const tool = String(state.tool || '');
        // The human-in-the-loop decision is made from the actual rendered
        // diff (Core's frozen proposal-time presentation), never from the
        // tool name, the path, or how small the change looks — that is
        // exactly the heuristic that let Run D's truncated rewrite through.
        // Mission authorization has no content to diff yet, so it is judged
        // on its envelope card alone; every content mutation must show
        // exactly the one intended anchored replacement to be approved.
        let allowed;
        if (tool === 'authorize_mission') {
          allowed = true;
        } else if (tool === 'propose_file_change' || tool === 'propose_text_edit') {
          // Both tools render the same kind of approval-card diff
          // (`core/runtime/writeProposal.ts`'s `write_file_diff` shape) —
          // `propose_text_edit` never shows the model's own content, only
          // the diff Core computed itself from the anchor, so the same
          // content-blind judging rule applies to both.
          allowed = diffShowsOnlyIntendedEdit(state.detail, baselineHtml);
        } else {
          allowed = false;
        }
        approvals.push({
          at: new Date().toISOString(),
          gate: state.gate,
          tool,
          scope: state.scope,
          paths: state.paths,
          detail: state.detail,
          allowed,
        });
        if (!allowed) {
          interventions.push({ kind: 'reject-unexpected-approval', at: new Date().toISOString(), tool, paths: state.paths, detail: state.detail });
          await evaluate('document.getElementById("reject").click()');
          return null;
        }
        interventions.push({ kind: 'approve-in-scope', at: new Date().toISOString(), tool, paths: state.paths });
        await evaluate('document.getElementById("approve").click()');
        return null;
      }
      if (state.submitDisabled === false && state.approvalHidden === true) {
        // Only treat as terminal once Core reported an outcome (success or failure).
        const blob = `${state.result}\n${(state.activity || []).join('\n')}`;
        if (/Mission failed|mission authorization was rejected|Final answer|local commit|Attempt cancelled|execution failed|repair was exhausted|Mission complete|completed successfully/i.test(blob)
          || (state.ids && /att_/.test(state.ids) && /Mission submitted/.test(blob) && /AI response/.test(blob))) {
          // Prefer explicit end markers when present.
          if (/Mission failed|mission authorization was rejected|Final answer|Attempt cancelled|execution failed|repair was exhausted|Mission complete|commit created|local commit/i.test(blob)) {
            return state;
          }
        }
      }
      return null;
    }, 2_400_000);

    evidence.finalUi = terminal;
    evidence.elapsedMs = Date.now() - startedAt;

    // Independent verification — do not salvage.
    const baseAfter = fs.readFileSync(path.join(worktree, 'templates', 'base.html'), 'utf8');
    const originalStill = fs.readFileSync(path.join(sourceRepo, 'templates', 'base.html'), 'utf8');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' });
    const diffNames = execFileSync('git', ['diff', '--name-only', `${baseline}..HEAD`], {
      cwd: worktree,
      encoding: 'utf8',
    }).split(/\r?\n/).filter(Boolean);
    const unstaged = execFileSync('git', ['diff', '--name-only'], { cwd: worktree, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: worktree, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);

    evidence.deliverySha = head;
    evidence.gitStatus = status.trim();
    evidence.diffNames = diffNames;
    evidence.unstaged = unstaged;
    evidence.staged = staged;
    evidence.footerHas2026 = /© 2026|&copy; 2026/.test(baseAfter);
    evidence.footerStillHas2025 = /© 2025|&copy; 2025/.test(baseAfter);
    evidence.originalCheckoutPreserved = /© 2025|&copy; 2025/.test(originalStill)
      && !/© 2026|&copy; 2026/.test(originalStill);
    evidence.onlyBaseHtml = [...new Set([...diffNames, ...unstaged, ...staged])]
      .every((f) => f === 'templates/base.html' || f === 'templates\\base.html');

    const committed = head !== baseline;
    // The decisive check: the committed file must be byte-for-byte the
    // baseline with ONLY the intended anchored edit applied — not merely
    // "contains 2026 and some familiar strings". This is what a shallow
    // substring/regex check (the prior `fileOk`) missed in Run D: a
    // truncated rewrite still contained "Kha Ke Dikha" and "All rights
    // reserved" even after silently deleting the cookie-consent banner and
    // the closing tags, so it reported `ok: true` for a corrupted file.
    const expectedAfter = expectedAfterIntendedEdit(baselineHtml);
    evidence.expectedAfterIntendedEdit = expectedAfter;
    evidence.exactEditMatch = expectedAfter !== null && baseAfter === expectedAfter;
    const fileOk = evidence.exactEditMatch;
    const missionFailed = /mission failed|execution failed|was rejected|repair was exhausted/i.test(String(terminal?.result || '')
      + '\n'
      + (terminal?.activity || []).join('\n'));
    const scopeOk = evidence.onlyBaseHtml
      && (diffNames.length === 0 || (diffNames.length === 1 && /templates[/\\]base\.html/.test(diffNames[0])));
    evidence.missionFailed = missionFailed;
    evidence.ok = Boolean(fileOk && evidence.originalCheckoutPreserved && committed && scopeOk && !missionFailed);

    // Rendered-footer check: the template line is the render source for Django base.
    evidence.renderedFooterLine = (baseAfter.split(/\r?\n/).find((l) => /copy;|©/.test(l)) || '').trim();

    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: evidence.ok,
      evidencePath,
      model: evidence.model,
      elapsedMs: evidence.elapsedMs,
      interventions: interventions.map((i) => i.kind),
      deliverySha: evidence.deliverySha,
      baseline,
      footer: evidence.renderedFooterLine,
      originalPreserved: evidence.originalCheckoutPreserved,
      diffNames,
    }, null, 2));

    if (!evidence.ok) {
      console.error('Jarvis Kha Ke Dikha footer smoke FAILED — no manual salvage.');
      process.exitCode = 1;
    }
  } catch (err) {
    evidence.ok = false;
    evidence.error = err instanceof Error ? err.message : String(err);
    evidence.elapsedMs = Date.now() - startedAt;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(evidence.error);
    console.error('Jarvis Kha Ke Dikha footer smoke FAILED — no manual salvage.');
    process.exitCode = 1;
  } finally {
    try { cdp.ws?.close(); } catch { /* ignore */ }
    killPid(pid);
  }
}

await main();
