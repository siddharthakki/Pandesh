import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { VSBrowser } from 'vscode-extension-tester';
import { EvidenceCollector } from '../evidence/EvidenceCollector.mjs';
import { KarkeDikhaView } from '../page-objects/KarkeDikhaView.mjs';
import { latestCoreTurn, taskEvidence, conversationLedgerEntry } from '../support/runtimeEvidence.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TASK_TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const ATTEMPT_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const envPath = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing golden environment variable ${name}`);
  return path.resolve(value);
};

export function gitState(workspace) {
  // The fingerprint must move for tracked modifications, deletions, renames AND
  // untracked files (a brand-new file is invisible to `git diff HEAD`), so it
  // covers the full porcelain status plus the bytes of every untracked file.
  const status = git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  const diff = git(workspace, ['diff', 'HEAD', '-M']);
  const hash = crypto.createHash('sha256').update(status).update('\0').update(diff);
  const untracked = git(workspace, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).sort();
  for (const file of untracked) {
    hash.update('\0').update(file).update('\0');
    try { hash.update(fs.readFileSync(path.join(workspace, file))); } catch { /* vanished mid-read: the status already changed */ }
  }
  return {
    head: git(workspace, ['rev-parse', 'HEAD']),
    branch: git(workspace, ['branch', '--show-current']),
    status,
    diffStat: git(workspace, ['diff', 'HEAD', '--stat']),
    diffHash: hash.digest('hex').slice(0, 16),
  };
}

/** Runs the fixture app (`node cli.js`) as a user would: lines typed one at a
 * time, with a small delay so prompt/answer flows behave like real typing. */
export function runApp(workspace, lines, { delay = 250, timeout = 20_000, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['cli.js'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    (async () => {
      for (const line of lines) {
        if (child.exitCode !== null) break;
        child.stdin.write(`${line}\n`);
        await sleep(delay);
      }
      child.stdin.end();
    })().catch(() => child.kill());
  });
}

export function npmTest(workspace, { env = {} } = {}) {
  const result = spawnSync('npm', ['test'], { cwd: workspace, shell: true, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, ...env } });
  return { exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-4000) };
}

/** A brand-new, empty user environment (HOME and the Windows equivalents), so
 * nothing persisted by an earlier run — the model's or ours — is visible. */
export function freshUserEnv(prefix = 'golden-home-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  };
}

const WRITE_CATEGORIES = new Set(['write_succeeded', 'path_corrected']);

/** Workspace-relative paths the agent itself wrote, per Core's durable
 * tool-invocation evidence (not inferred from the worktree, which also holds
 * whatever the model's validation commands left behind). */
export function agentWrittenPaths(coreDataDir) {
  const db = new DatabaseSync(path.join(coreDataDir, 'core.db'), { readOnly: true });
  try {
    const paths = new Set();
    for (const row of db.prepare(`SELECT argsSummary, evidence FROM tool_invocations WHERE status = 'succeeded'`).all()) {
      let evidence = {};
      let args = {};
      try { evidence = JSON.parse(row.evidence ?? '{}'); } catch { /* unparseable evidence is not write evidence */ }
      if (!WRITE_CATEGORIES.has(evidence.resultCategory)) continue;
      try { args = JSON.parse(row.argsSummary ?? '{}'); } catch { /* fall back to evidence */ }
      const written = evidence.pathRecovery?.selected ?? evidence.normalizedArguments?.path ?? args.path;
      if (typeof written === 'string' && written) paths.add(path.posix.normalize(written.replace(/\\/g, '/')).replace(/^\.\//, ''));
    }
    return [...paths].sort();
  } finally {
    db.close();
  }
}

/** Every worktree path git reports as changed (tracked or untracked). */
function changedPaths(workspace) {
  // Not via git(): trimming would eat the first line's leading status column.
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspace, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    .map(line => line.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, ''));
}

/** Materialises exactly what was delivered — the workspace's HEAD commit plus
 * the files the agent wrote (from Core evidence) — as a commit in a pristine
 * clone at `target`. Behavioural acceptance runs there, so task-worktree
 * residue (data files created by the model's own validation runs, caches)
 * can neither help nor hurt the verdict. That residue is returned separately
 * so it is reported, never judged. */
export function deliveredCheckout(workspace, coreDataDir, target) {
  const head = git(workspace, ['rev-parse', 'HEAD']);
  const agentPaths = agentWrittenPaths(coreDataDir);
  fs.rmSync(target, { recursive: true, force: true });
  // autocrlf off: the checkout must hold the committed bytes, not the host's EOL rewrite.
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--config', 'core.autocrlf=false', workspace, target], { encoding: 'utf8' });
  git(target, ['checkout', '--quiet', '--detach', head]);
  for (const rel of agentPaths) {
    const source = path.join(workspace, rel);
    const dest = path.join(target, rel);
    if (fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
    } else {
      fs.rmSync(dest, { force: true });
    }
  }
  git(target, ['add', '-A']);
  const hasOverlay = git(target, ['status', '--porcelain']) !== '';
  if (hasOverlay) git(target, ['-c', 'user.name=golden', '-c', 'user.email=golden@localhost', 'commit', '--quiet', '--no-verify', '-m', 'golden: delivered agent changes']);
  const agentSet = new Set(agentPaths);
  const residue = changedPaths(workspace).filter(rel => !agentSet.has(rel)).map(rel => {
    const full = path.join(workspace, rel);
    const stat = fs.existsSync(full) ? fs.statSync(full) : null;
    return { path: rel, bytes: stat?.size ?? null, preview: stat && stat.size <= 2048 ? fs.readFileSync(full, 'utf8') : null };
  });
  return {
    checkout: target,
    baseCommit: head,
    deliveredCommit: git(target, ['rev-parse', 'HEAD']),
    deliveredTree: git(target, ['rev-parse', 'HEAD^{tree}']),
    agentPaths,
    residue,
  };
}

const listedLines = output => output.match(/^\s*\d+\.\s.*$/gm) ?? [];

/** Implementation-agnostic delete probe: tries the natural command spellings a
 * model might choose; success = the targeted expense is gone, the other stays,
 * and the total reflects it. `answers` feeds a confirmation prompt if present. */
export async function probeDelete(workspace, { answers = [] } = {}) {
  const attempts = [];
  for (const command of ['delete 1', 'remove 1', 'del 1', 'delete #1', 'rm 1']) {
    const lines = ['add lunch 12', 'add coffee 4', command, ...answers, 'list', 'total', 'exit'];
    const output = await runApp(workspace, lines);
    const listed = listedLines(output);
    const lunchListed = listed.some(line => /lunch/i.test(line));
    const coffeeListed = listed.some(line => /coffee/i.test(line));
    const totalMatch = /Total:\s*([\d.]+)/i.exec(output);
    const ok = !lunchListed && coffeeListed && totalMatch !== null && Number(totalMatch[1]) === 4;
    attempts.push({ command, ok, output: output.slice(-800) });
    if (ok) return { ok: true, command, attempts };
  }
  return { ok: false, command: null, attempts };
}

/** With a confirmation gate: answering "n" must keep the expense, "y" must delete.
 * Discovers the command itself (does not depend on an earlier probe succeeding). */
export async function probeDeleteConfirmation(workspace, knownCommand) {
  const commands = knownCommand ? [knownCommand] : ['remove 1', 'delete 1', 'del 1', 'delete #1', 'rm 1'];
  const tried = [];
  for (const command of commands) {
    const declined = await runApp(workspace, ['add lunch 12', 'add coffee 4', command, 'n', 'list', 'total', 'exit']);
    const listed = listedLines(declined);
    const declineKeepsExpense = listed.some(line => /lunch/i.test(line)) && listed.some(line => /coffee/i.test(line));
    const accepted = await runApp(workspace, ['add lunch 12', 'add coffee 4', command, 'y', 'list', 'total', 'exit']);
    const acceptedList = listedLines(accepted);
    const acceptDeletes = !acceptedList.some(line => /lunch/i.test(line)) && acceptedList.some(line => /coffee/i.test(line));
    const promptedBeforeDeleting = /(sure|confirm|y\/n|yes\/no|\(y|\[y)/i.test(declined);
    const result = { command, promptedBeforeDeleting, declineKeepsExpense, acceptDeletes, declinedOutput: declined.slice(-600), acceptedOutput: accepted.slice(-600) };
    tried.push(result);
    if (acceptDeletes) return { ...result, tried };
  }
  return { ...tried.at(-1), tried };
}

/** Non-builtin, non-relative requires/imports in the workspace's JS files. */
export function externalDependencies(workspace) {
  const builtins = new Set(['assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'os', 'path', 'readline', 'stream', 'test', 'url', 'util', 'zlib', 'http', 'https']);
  const found = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.ollama-agent', '.vscode'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(c|m)?js$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.matchAll(/(?:require\(\s*|from\s+|import\s+)['"]([^'"]+)['"]/g)) {
        const spec = match[1].replace(/^node:/, '');
        if (!spec.startsWith('.') && !builtins.has(spec.split('/')[0])) found.add(spec);
      }
    }
  };
  walk(workspace);
  let declared = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  } catch { /* no package.json */ }
  return { imported: [...found], declared, nodeModulesPresent: fs.existsSync(path.join(workspace, 'node_modules')) };
}

export class GoldenSession {
  constructor(scenario) {
    this.scenario = scenario;
    this.workspace = envPath('GUARDIAN_WORKSPACE');
    this.coreData = envPath('GUARDIAN_CORE_DATA');
    this.evidenceDir = envPath('GUARDIAN_JOURNEY_EVIDENCE');
    this.view = new KarkeDikhaView();
    this.evidence = new EvidenceCollector(VSBrowser.instance.driver, this.evidenceDir);
    this.turns = [];
    this.checks = [];
    this.startedAt = Date.now();
  }

  async open() {
    await this.view.open();
    // Capture webview script errors so a silently-aborted handler is diagnosable.
    await this.view.driver.executeScript(`
      window.__goldenErrors = [];
      window.addEventListener('error', e => window.__goldenErrors.push(String(e.message) + ' @' + String(e.filename).split('/').pop() + ':' + e.lineno));
      window.addEventListener('unhandledrejection', e => window.__goldenErrors.push('rejection: ' + String(e.reason)));
    `).catch(() => undefined);
    await this.shot('00-initial');
  }

  async shot(name) {
    try { await this.evidence.screenshot(`${this.scenario}-${name}`); } catch { /* screenshots are supplementary */ }
  }

  /** Records a named assertion in the evidence file, then enforces it. */
  check(name, condition, detail) {
    this.checks.push({ name, pass: Boolean(condition), detail: detail ?? null });
  }

  /** Throws one summary error listing every failed check (called at scenario end,
   * so a failing early check never hides what later turns did). */
  assertAll() {
    const failed = this.checks.filter(item => !item.pass);
    assert.ok(failed.length === 0, `${failed.length} check(s) failed: ${failed.map(item => item.name).join('; ')}`);
  }

  /** Submits a natural prompt through the real composer (Auto routing unless
   * `mode` is given) and drives visible approvals until the turn is terminal. */
  async turn(prompt, options = {}) {
    const gitBefore = gitState(this.workspace);
    const before = await this.view.snapshot();
    const startedAt = Date.now();
    // A real user waits for the panel to finish restoring; record how long that took.
    const restoreWaitStarted = Date.now();
    await this.view.driver.wait(() => this.view.driver.executeScript('return window.__kdWorkspaceRestored === true'), 90_000, 'workspace restoration did not complete').catch(() => undefined);
    this.restoreWaitMs = Date.now() - restoreWaitStarted;
    await this.view.submitInMode(options.mode ?? 'auto', prompt);
    // Detect a silent no-op Send (text still in the composer, no user bubble) and record it.
    await sleep(4000);
    const afterSend = await this.view.snapshot();
    const remaining = await this.view.driver.executeScript("return document.getElementById('user-input').value");
    if (afterSend.userCount <= before.userCount && remaining && remaining.trim() === prompt.trim()) {
      this.silentSendNoops = (this.silentSendNoops ?? 0) + 1;
      this.evidence.json(`turn-${this.turns.length + 1}-silent-send-noop.json`, { prompt, restoreWaitMs: this.restoreWaitMs, body: afterSend.bodyText.slice(0, 800) });
      await this.shot(`silent-send-noop-${this.turns.length + 1}`);
      await this.view.clickPrimary();
    }
    return this.drive(prompt, { ...options, before, gitBefore, startedAt });
  }

  async drive(prompt, options = {}) {
    const { timeout = 20 * 60_000, onRunning, approve = true, mode, label } = options;
    const gitBefore = options.gitBefore ?? gitState(this.workspace);
    const before = options.before ?? await this.view.snapshot();
    const startedAt = options.startedAt ?? Date.now();
    const approvals = [];
    const clicked = new Set();
    let ranRunning = false;
    const deadline = Date.now() + timeout;
    let core = null;
    let terminal = false;
    let taskState = null;
    while (Date.now() < deadline) {
      let snap;
      core = latestCoreTurn(this.coreData, prompt);
      {
        // Fail fast (with evidence) on product dead-ends rather than idling to the timeout.
        let text = '';
        try { text = (await this.view.snapshot()).bodyText; } catch { /* frame lost; handled below */ }
        const deadEnd = /Should I treat it as a new task\?/.exec(text)?.[0] ?? /⚠ [^\r\n]{0,200}/.exec(text)?.[0];
        if (deadEnd) {
          await this.shot(`dead-end-${this.turns.length + 1}`);
          this.evidence.json(`turn-${this.turns.length + 1}-dead-end.json`, { prompt, deadEnd, core, approvals });
          throw new Error(`PRODUCT_DEAD_END on "${prompt}": ${deadEnd}`);
        }
      }
      try { snap = await this.view.snapshot(); } catch (snapshotError) {
        if (!this.snapshotErrorLogged) { this.snapshotErrorLogged = true; this.evidence.text('snapshot-error.txt', String(snapshotError.stack ?? snapshotError)); }
        // The webview frame can be lost (e.g. sidebar re-render). Re-enter the
        // real view like a user would, and record that it happened.
        this.frameRecoveries = (this.frameRecoveries ?? 0) + 1;
                if (this.frameRecoveries > 40) throw new Error('GOLDEN_WEBVIEW_UNRECOVERABLE: KarkeDikha webview frame could not be re-entered');
        try { await this.view.switchIntoView(); } catch { await sleep(1000); }
        continue;
      }
      if (core?.request && !ranRunning && onRunning) {
        ranRunning = true;
        await onRunning({ snap, core, session: this });
      }
      if (approve) {
        // Tool/capability approval buttons carry data-approval-id themselves. approve: 'tools' answers only these
        // (e.g. a reviewed read-only command in a read-only turn) and never a mutation/proposal card below.
        for (let guard = 0; guard < 5; guard += 1) {
          const button = await this.view.actionableToolApproval('approved').catch(() => null);
          if (!button) break;
          const approvalId = await button.getAttribute('data-approval-id').catch(() => null);
          const tool = await button.getAttribute('data-tool-name').catch(() => null);
          const key = `tool:${approvalId}`;
          if (clicked.has(key)) break;
          clicked.add(key);
          approvals.push({ kind: 'tool', approvalId, tool, at: new Date().toISOString() });
          await button.click().catch(() => undefined);
          await sleep(500);
        }
        for (const card of snap.approvalCards.filter(item => approve === true && item.visible && item.actionable)) {
          // A re-plan (e.g. after steering) raises a NEW approval of the same kind on the
          // same task, so dedupe by time, not forever.
          const key = `${card.kind}:${card.taskId}:${card.inlineState}`;
          if (Date.now() - (this.lastApprovalClick?.get(key) ?? 0) < 8_000) continue;
          (this.lastApprovalClick ??= new Map()).set(key, Date.now());
          approvals.push({ kind: card.kind, taskId: card.taskId, attemptId: card.attemptId, state: card.inlineState, at: new Date().toISOString() });
          await this.view.resolveVisibleApproval(card.kind, 'approved', 10_000).catch(() => undefined);
        }
      }
      const resolved = core?.request?.resolvedMode;
      if (core?.attempt) {
        if (resolved === 'karke_dikha') {
          const taskId = snap.taskId && snap.taskId !== '—' ? snap.taskId : core.attempt.id;
          try { taskState = taskEvidence(this.workspace, taskId).task.state; } catch { taskState = null; }
          if (taskState && TASK_TERMINAL.has(taskState)) terminal = true;
        } else if (ATTEMPT_TERMINAL.has(core.attempt.status)) {
          terminal = true;
        }
      }
      if (terminal) break;
      if (!core?.request && Date.now() - startedAt > 180_000) {
        // Submitted but Core never saw it: capture the webview's send gate state.
        const gate = await this.view.driver.executeScript(`
          return {
            restored: window.__kdWorkspaceRestored,
            readiness: window.__kdReadiness,
            composer: document.getElementById('user-input')?.value,
            sendLabel: document.getElementById('send-btn')?.textContent,
            sendDisabled: document.getElementById('send-btn')?.disabled,
            modeSelect: document.getElementById('mode-select')?.value,
            queueStrip: document.getElementById('next-turn-queue')?.innerText || null,
            userBubbles: document.querySelectorAll('#messages .bubble.user').length,
            errors: window.__goldenErrors || null,
            messagesHtml: document.getElementById('messages')?.innerHTML.slice(0, 600),
          };`).catch(error => String(error));
        await this.shot(`never-reached-core-${this.turns.length + 1}`);
        this.evidence.json(`turn-${this.turns.length + 1}-never-reached-core.json`, { prompt, gate, restoreWaitMs: this.restoreWaitMs ?? null });
        throw new Error(`PRODUCT_SUBMISSION_LOST on "${prompt}": Core never received the request (gate=${JSON.stringify(gate)})`);
      }
      // Diagnostics: an approval-waiting turn that nothing can click is a finding.
      if (!this.stuckDumped && taskState && /waiting_for/.test(taskState)) {
        this.waitingSince ??= Date.now();
        if (Date.now() - this.waitingSince > 45_000) {
          this.stuckDumped = true;
          await this.shot('stuck-waiting-for-approval');
          this.evidence.json('stuck-approval-dom.json', await this.view.driver.executeScript(`
            return {
              buttons: Array.from(document.querySelectorAll('button')).map(b => ({ id: b.id, text: b.textContent.trim().slice(0, 40), hidden: b.hidden, disabled: b.disabled, rects: b.getClientRects().length, approval: b.dataset.approvalResponse || null })).filter(b => /approv|reject|deny|allow/i.test(b.id + b.text)),
              cards: ['proposal','mutation','delivery'].map(k => { const c = document.getElementById(k + '-approval-card'); return { k, exists: !!c, hidden: c?.hidden, rects: c?.getClientRects().length, state: c?.dataset?.inlineApprovalState }; }),
              body: document.body.innerText.slice(0, 1500),
            };`).catch(error => String(error)));
        }
      }
      await sleep(1000);
    }
    if (!terminal) {
      await this.shot(`timeout-${this.turns.length + 1}`);
      this.evidence.json(`turn-${this.turns.length + 1}-timeout.json`, { prompt, core, approvals });
      throw new Error(`Turn did not reach a terminal state within ${timeout}ms: "${prompt}"`);
    }
    await sleep(1500);
    const after = await this.view.snapshot();
    const gitAfter = gitState(this.workspace);
    core = latestCoreTurn(this.coreData, prompt) ?? core;
    const ledger = after.conversationId ? conversationLedgerEntry(this.coreData, after.conversationId) : null;
    const record = {
      index: this.turns.length + 1,
      label: label ?? null,
      prompt,
      requestedUiMode: mode ?? 'auto (default composer)',
      route: { requested: core?.request?.requestedMode ?? null, resolved: core?.request?.resolvedMode ?? null },
      localConversationId: after.conversationId,
      coreConversationId: core?.request?.conversationId ?? null,
      ledgerCoreConversationId: ledger?.conversationId ?? null,
      requestId: core?.request?.id ?? null,
      attemptId: core?.attempt?.id ?? null,
      attemptStatus: core?.attempt?.status ?? null,
      taskId: after.taskId && after.taskId !== '—' ? after.taskId : null,
      taskState,
      approvals,
      coreApprovals: (core?.approvals ?? []).map(item => ({ id: item.id, kind: item.kind, status: item.status })),
      tools: (core?.toolInvocations ?? []).map(item => ({ tool: item.toolName ?? item.name, status: item.status })),
      assistantText: after.assistantTexts.at(-1) ?? '',
      gitBefore,
      gitAfter,
      changedWorkspace: gitBefore.diffHash !== gitAfter.diffHash || gitBefore.head !== gitAfter.head,
      durationMs: Date.now() - startedAt,
      webviewFrameRecoveries: this.frameRecoveries ?? 0,
      silentSendNoops: this.silentSendNoops ?? 0,
      restoreWaitMs: this.restoreWaitMs ?? null,
    };
    this.turns.push(record);
    this.evidence.json(`turn-${record.index}.json`, record);
    await this.shot(`turn-${record.index}-done`);
    return record;
  }

  finish(status, error) {
    this.evidence.json(`${this.scenario}-result.json`, {
      scenario: this.scenario,
      status,
      error: error ? String(error.stack ?? error) : null,
      durationMs: Date.now() - this.startedAt,
      checks: this.checks,
      turns: this.turns,
    });
  }
}
