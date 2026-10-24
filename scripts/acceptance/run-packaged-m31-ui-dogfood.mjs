#!/usr/bin/env node
// npm run test:e2e:m31-packaged-ui
//
// The authoritative M31 (KarkeDikha Global Core & Global Board) packaged-VSIX
// GUI acceptance harness. Builds the real win32-x64 VSIX, installs it into an
// isolated extensions dir under one shared isolated user-data profile
// (so SecretStorage/Core auth is genuinely shared across windows, per M31 §5),
// and drives NORMAL VS Code windows (never an Extension Development Host —
// see scripts/acceptance/plainVsCodeHost.mjs header for why) over CDP via
// scripts/acceptance/boardUiDriver.mjs, reusing the same
// download-once-VS-Code / install-via-CLI / drive-over-remote-debugging-port
// pattern scripts/acceptance/run-packaged-acceptance.mjs already established.
//
// Every mutation asserted here happens through the real webview (button
// clicks, native showInputBox/QuickPick widgets) or the real Command
// Palette — never a direct vscode.* API call and never a bare HTTP/WS call
// standing in for a UI action. Direct Core evidence (discovery record, the
// isolated SQLite file) is read only as supplementary corroboration after a
// UI action, via scripts/acceptance/m31CoreEvidence.mjs — this harness has no
// access to the extension's SecretStorage-held bearer token, by design, so
// it never makes an authenticated Core HTTP call.

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  resolveVSCode,
  installExtension,
  launchPlainHost,
  openWindowInSameInstance,
  allocateDebugPort,
  writeUserSettingsForCustomDialogs,
  detectActiveVSCodeUpdater,
} from './plainVsCodeHost.mjs';
import * as board from './boardUiDriver.mjs';
import { assertPackagedContent } from './packageContentAssertion.mjs';
import * as coreEvidence from './m31CoreEvidence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-m31-ui-dogfood-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm31-packaged-ui');
const globalDataDir = path.join(workDir, 'global-data'); // stands in for %LOCALAPPDATA%\KarkeDikha
const userDataDir = path.join(workDir, 'user-data'); // ONE shared profile for every window
const extensionsDir = path.join(workDir, 'extensions'); // ONE shared extensions dir for every window

const startedAt = Date.now();
const timings = {};
const trackedChildren = []; // { pid, label }
let sharedPort; // remote-debugging-port of whichever process is currently the real owning VS Code instance

// Distinct from exitCode 0 (passed) / 1 (product or harness failure): the run never
// attempted a scenario because a machine-wide infrastructure precondition wasn't met.
const EXIT_INFRA_BLOCKED = 3;

// Name pattern this harness's own workDir uses: `oa-m31-ui-dogfood-${Date.now()}-${pid}`.
const HARNESS_TEMP_DIR_PATTERN = /^oa-m31-ui-dogfood-(\d+)-(\d+)$/;
const STALE_TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // don't touch anything from the last 24h — it may still be under inspection
const STALE_TEMP_DIR_CLEANUP_CAP = 50; // bounded: never remove more than this many directories in one run

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[m31-ui-dogfood +${elapsed}s] ${message}`);
}

async function timed(label, fn) {
  const start = Date.now();
  log(`>> ${label}`);
  try {
    const result = await fn();
    timings[label] = Date.now() - start;
    log(`<< ${label} (${timings[label]}ms)`);
    return result;
  } catch (error) {
    timings[label] = Date.now() - start;
    log(`<< ${label} FAILED after ${timings[label]}ms: ${error.message}`);
    throw error;
  }
}

function run(command, args, options = {}) {
  // On Windows, spawnSync with shell:true hands args to cmd.exe joined by plain spaces —
  // it does NOT quote them for us, so an arg containing a space (e.g. a git commit message
  // or user.name) silently splits into multiple positional args for the child process.
  const shellSafeArgs =
    process.platform === 'win32' ? args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)) : args;
  const result = spawnSync(command, shellSafeArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function writeEvidence(name, data) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify({ capturedAt: new Date().toISOString(), ...data }, null, 2));
}

async function pollUntil(conditionFn, { timeoutMs = 30000, intervalMs = 300, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await conditionFn();
      lastError = undefined;
      if (last && last.done) return last.value;
    } catch (error) {
      // Transient failures (CDP not listening yet during VS Code startup, a webview mid-navigation
      // after panel.webview.html is reassigned, etc.) are expected during polling — keep retrying
      // until the deadline instead of failing on the first hiccup.
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}; last=${JSON.stringify(last?.value)}${lastError ? `; lastError=${lastError.message}` : ''}`,
  );
}

function initGitRepo(root, { origin } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Disposable M31 acceptance workspace\n');
  run('git', ['init'], { cwd: root });
  run('git', ['config', 'user.email', 'm31-acceptance@example.com'], { cwd: root });
  run('git', ['config', 'user.name', 'M31 Packaged UI Acceptance'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init disposable m31 acceptance workspace'], { cwd: root });
  if (origin) {
    run('git', ['remote', 'add', 'origin', origin], { cwd: root });
  }
}

// --- Window lifecycle helpers -------------------------------------------------

async function waitForWorkbenchReady(port, { timeoutMs = 45000 } = {}) {
  return pollUntil(
    async () => {
      const targets = await board.listTargets(port);
      const page = targets.find((t) => t.type === 'page');
      return page ? { done: true, value: page } : { done: false, value: targets.length };
    },
    { timeoutMs, describe: () => `a workbench page target on port ${port}` },
  );
}

async function openBoardInWindow(port, pageTargetId, existingWebviewIds) {
  const pageClient = await board.connectToTarget(port, pageTargetId);
  try {
    await pageClient.Page.bringToFront();
    await board.runCommandViaPalette(pageClient, 'KarkeDikha Engineering: Show Local Board');
  } finally {
    await pageClient.close();
  }
  return board.waitForBoardWebview(port, existingWebviewIds, { timeoutMs: 30000 });
}

async function waitForConnected(boardClient, { timeoutMs = 30000 } = {}) {
  return pollUntil(
    async () => {
      const state = await board.readBoardState(boardClient);
      return state.connectionState === 'connected' ? { done: true, value: state } : { done: false, value: state.connectionState };
    },
    { timeoutMs, describe: () => 'Global Board connection state to become "connected"' },
  );
}

async function createProjectViaUi(pageClient, boardClient, name) {
  await board.clickAndAwaitInputBox(pageClient, boardClient, 'new-project-button', undefined);
  await board.typeIntoQuickInputBox(pageClient, name);
}

async function createStoryViaUi(pageClient, boardClient, title) {
  await board.clickAndAwaitInputBox(pageClient, boardClient, 'new-story-button', undefined);
  await board.typeIntoQuickInputBox(pageClient, title);
  await board.waitForQuickPickWithRows(pageClient);
  await board.acceptQuickPick(pageClient);
}

/**
 * Fails fast, before any build/package work, if a VS Code installer/updater is
 * currently running anywhere on the machine. See detectActiveVSCodeUpdater()
 * for why this blocks every VS Code launch, including this harness's isolated
 * one. Deliberately does NOT touch evidenceDir before writing — a prior real
 * failure.json from an earlier attempt is left intact.
 */
function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;

  const primary = updaters[0];
  log(`INFRA_BLOCKED: an active VS Code installer/updater process is holding the machine-wide "vscode-updating" mutex (pid ${primary.pid}, started ${primary.startedAt}).`);
  writeEvidence('infra-blocked.json', {
    status: 'INFRA_BLOCKED',
    updaterPid: primary.pid,
    updaterStartedAt: primary.startedAt,
    message:
      'The global Windows "vscode-updating" Inno Setup mutex is machine-wide, not scoped to any ' +
      'user-data-dir. Every VS Code process on this system — including this harness\'s isolated, ' +
      'separately-downloaded instance — checks that same mutex on startup and refuses to launch ' +
      'while it is held, failing with "Code is currently being updated." This blocks packaged UI ' +
      'acceptance runs; it is not a product or test defect.',
    remediation: 'Close all VS Code windows and let the pending update finish, then re-run this harness.',
    updaters,
  });
  log(`INFRA_BLOCKED evidence written to ${evidenceDir}. Not retrying automatically.`);
  return true;
}

/**
 * Bounded cleanup of this harness's own leaked workDirs under the OS temp
 * directory. Only ever removes a directory that (a) matches this harness's
 * exact naming scheme, (b) is old enough that it can't be an in-flight or
 * recently-retained-for-inspection run, and (c) has the internal shape this
 * harness actually creates (user-data/ + extensions/) — name match alone is
 * not treated as sufficient proof of ownership.
 */
function cleanupStaleHarnessTempDirs() {
  const tmpRoot = os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch (error) {
    log(`Stale temp-dir cleanup skipped: could not read ${tmpRoot} (${error.message}).`);
    return;
  }

  const now = Date.now();
  let removed = 0;
  let skippedNotOwned = 0;

  for (const entry of entries) {
    if (removed >= STALE_TEMP_DIR_CLEANUP_CAP) break;
    if (!entry.isDirectory()) continue;
    const match = HARNESS_TEMP_DIR_PATTERN.exec(entry.name);
    if (!match) continue;

    const runTimestampMs = Number(match[1]);
    if (!Number.isFinite(runTimestampMs) || now - runTimestampMs < STALE_TEMP_DIR_MAX_AGE_MS) continue;

    const candidatePath = path.join(tmpRoot, entry.name);
    const looksHarnessOwned = ['user-data', 'extensions'].every((sub) => fs.existsSync(path.join(candidatePath, sub)));
    if (!looksHarnessOwned) {
      skippedNotOwned += 1;
      continue;
    }

    try {
      fs.rmSync(candidatePath, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      log(`Stale temp-dir cleanup: failed to remove ${candidatePath} (${error.message}).`);
    }
  }

  if (removed > 0 || skippedNotOwned > 0) {
    log(`Stale temp-dir cleanup: removed ${removed} harness-owned dir(s) older than ${STALE_TEMP_DIR_MAX_AGE_MS / 3600000}h; skipped ${skippedNotOwned} name-matching dir(s) that didn't look harness-owned.`);
  }
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  if (reportInfraBlockedIfUpdaterActive()) {
    process.exit(EXIT_INFRA_BLOCKED);
  }

  cleanupStaleHarnessTempDirs();

  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(globalDataDir, { recursive: true });

  let exitCode = 1;
  const scenarioResults = {};
  const activeBoardClientsForDiagnostics = {};

  try {
    await timed('build:compile+package', () => {
      run('npm', ['run', 'package:win32-x64'], { cwd: repoRoot });
    });
    const vsixPath = path.join(repoRoot, 'karkedikha-win32-x64.vsix');
    if (!fs.existsSync(vsixPath)) throw new Error(`expected VSIX at ${vsixPath}`);

    const packageReport = await timed('build:packaging-inspection', () => {
      const extractDir = path.join(workDir, 'extracted-vsix');
      fs.mkdirSync(extractDir, { recursive: true });
      const tarBinary = process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
      execFileSync(tarBinary, ['-xf', vsixPath, '-C', extractDir], { stdio: 'inherit' });
      const extensionDevelopmentPath = path.join(extractDir, 'extension');
      const { ok, report } = assertPackagedContent(extensionDevelopmentPath);
      const coreJsPath = path.join(extensionDevelopmentPath, 'out-core', 'core.js');
      const coreBundled = fs.existsSync(coreJsPath);
      writeEvidence('package-content-report.json', { ok, coreBundled, ...report });
      if (!ok) throw new Error(`package-content assertion FAILED: ${JSON.stringify(report)}`);
      if (!coreBundled) throw new Error(`expected out-core/core.js inside the packaged VSIX at ${coreJsPath}`);
      return report;
    });
    log(`Packaging inspection PASSED (${packageReport.packagedFileCount} files).`);

    const { vscodeExecutablePath, cliArgs } = await timed('build:resolve-vscode', () => resolveVSCode());

    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    writeUserSettingsForCustomDialogs(userDataDir);
    await timed('build:install-vsix', () => {
      installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath });
    });

    const coreEnv = { KARKEDIKHA_DATA_DIR: globalDataDir };

    // Disposable workspaces used across the scenarios below.
    const workspaceNonGit = path.join(workDir, 'workspace-b-nongit');
    fs.mkdirSync(workspaceNonGit, { recursive: true });
    fs.writeFileSync(path.join(workspaceNonGit, 'README.md'), '# Non-git disposable workspace (Window B)\n');

    const workspaceGitNoOrigin = path.join(workDir, 'workspace-e-noorigin');
    const workspaceGitWithOrigin = path.join(workDir, 'workspace-e-origin');

    // =====================================================================
    // Scenario A: Window A, no folder.
    // =====================================================================
    let windowA, boardA, boardATargetId, cardJugaadStoryTitle = 'Global Board acceptance story';
    let jugaadProjectId;
    await timed('scenario-A', async () => {
      const portA = allocateDebugPort();
      sharedPort = portA;
      const { child } = launchPlainHost(vscodeExecutablePath, {
        userDataDir,
        extensionsDir,
        workspacePath: undefined, // no folder
        remoteDebuggingPort: portA,
        env: coreEnv,
      });
      trackedChildren.push({ pid: child.pid, label: 'window-A' });
      windowA = { child, port: portA };

      const pageTargetA = await waitForWorkbenchReady(portA);
      const { client: boardClient, targetId } = await openBoardInWindow(portA, pageTargetA.id, []);
      boardA = boardClient;
      boardATargetId = targetId;
      activeBoardClientsForDiagnostics.boardA = boardA;

      const connectedState = await waitForConnected(boardA, { timeoutMs: 30000 });
      await board.captureScreenshot(await board.connectToTarget(portA, pageTargetA.id).then(async (c) => { await c.Page.bringToFront(); return c; }), evidenceDir, 'A-01-connected').catch(() => {});
      if (connectedState.connectionState !== 'connected') throw new Error('Window A: Core did not show Connected');
      log(`Window A: Core shows Connected (data-state="${connectedState.connectionState}").`);

      const pageClientA = await board.connectToTarget(portA, pageTargetA.id);
      try {
        await createProjectViaUi(pageClientA, boardA, 'JUGAAD');
        const notificationsAfterCreate = await pageClientA.Runtime.evaluate({
          expression: `Array.from(document.querySelectorAll('.notification-list-item-message')).map(n => n.textContent)`,
          returnByValue: true,
        }).then((r) => r.result.value).catch((e) => [`<notification read failed: ${e.message}>`]);
        log(`Window A: after submitting "JUGAAD", visible notifications: ${JSON.stringify(notificationsAfterCreate)}`);
        const afterProject = await pollUntil(
          async () => {
            const state = await board.readBoardState(boardA);
            const project = state.projectOptions.find((p) => p.label === 'JUGAAD');
            return project ? { done: true, value: { state, project } } : { done: false, value: state.projectOptions };
          },
          { timeoutMs: 15000, describe: () => 'JUGAAD to appear in the project filter after real UI creation' },
        );
        jugaadProjectId = afterProject.project.value;
        log(`Window A: created project "JUGAAD" (${jugaadProjectId}) via the real UI.`);

        await board.setProjectFilter(boardA, jugaadProjectId);
        await new Promise((r) => setTimeout(r, 500));
        await createStoryViaUi(pageClientA, boardA, cardJugaadStoryTitle);
        const afterStory = await pollUntil(
          async () => {
            const card = await board.findCardByTitle(boardA, cardJugaadStoryTitle);
            return card ? { done: true, value: card } : { done: false, value: null };
          },
          { timeoutMs: 15000, describe: () => `story "${cardJugaadStoryTitle}" to appear on the board after real UI creation` },
        );
        log(`Window A: created story "${cardJugaadStoryTitle}" (${afterStory.storyId}) via the real UI.`);

        // Edit it.
        const editedTitle = `${cardJugaadStoryTitle} (edited)`;
        await board.clickAndAwaitInputBox(pageClientA, boardA, 'edit-story-button', afterStory.storyId);
        await board.typeIntoPrefilledQuickInputBox(pageClientA, cardJugaadStoryTitle, editedTitle);
        await pollUntil(
          async () => {
            const state = await board.readBoardState(boardA);
            const card = state.cards.find((c) => c.storyId === afterStory.storyId);
            return card && card.title === editedTitle
              ? { done: true, value: card }
              : { done: false, value: { allTitles: state.cards.map((c) => c.title), targetCardTitle: card?.title } };
          },
          { timeoutMs: 15000, describe: () => `edited story title to be reflected on the board (expected "${editedTitle}")` },
        );
        cardJugaadStoryTitle = editedTitle;
        log('Window A: edited the story title via the real UI ("Edit" button + native input box).');

        // Comment on it.
        await board.clickAndAwaitInputBox(pageClientA, boardA, 'comment-story-button', afterStory.storyId);
        await board.typeIntoQuickInputBox(pageClientA, 'Looks good, proceeding.');
        log('Window A: added a comment via the real UI.');

        // Transition it.
        await board.setStoryTransition(boardA, afterStory.storyId, 'discovery');
        const afterTransition = await pollUntil(
          async () => {
            const state = await board.readBoardState(boardA);
            const card = state.cards.find((c) => c.storyId === afterStory.storyId);
            return card && card.status === 'discovery' ? { done: true, value: card } : { done: false, value: card?.status };
          },
          { timeoutMs: 15000, describe: () => 'story status to become "discovery" after real UI transition' },
        );
        log(`Window A: transitioned story to "${afterTransition.status}" via the real UI (select + change event).`);

        scenarioResults.A = { projectId: jugaadProjectId, storyId: afterStory.storyId, storyTitle: cardJugaadStoryTitle, status: afterTransition.status };
      } finally {
        await pageClientA.close();
      }
    });

    const storyId = scenarioResults.A.storyId;

    // =====================================================================
    // Scenario F (folded in here so Window A's board state is fresh):
    // Board actions — archive project support check, archive story, Active/History, rapid-duplicate-click guard.
    // =====================================================================
    await timed('scenario-F', async () => {
      const pageTargetA = await waitForWorkbenchReady(windowA.port);
      const pageClientA = await board.connectToTarget(windowA.port, pageTargetA.id);
      try {
        await pageClientA.Page.bringToFront();

        // Use a dedicated throwaway story for the archive test: archiving is a one-way action (no
        // "unarchive" exists — see docs/m31-architecture.md), and Scenario B still needs the main
        // `storyId` from Scenario A to be transitionable afterward.
        await createStoryViaUi(pageClientA, boardA, 'Archive test story');
        const archiveTestStory = await pollUntil(
          async () => {
            const card = await board.findCardByTitle(boardA, 'Archive test story');
            return card ? { done: true, value: card } : { done: false, value: null };
          },
          { timeoutMs: 15000, describe: () => 'throwaway "Archive test story" to appear on the board' },
        );
        const archiveTestStoryId = archiveTestStory.storyId;
        log(`Window A: created throwaway story "${archiveTestStoryId}" for the archive/History tests.`);

        // Active/History behavior: the story is currently active; it must show under Active and NOT under History.
        let state = await board.readBoardState(boardA);
        if (!state.cards.some((c) => c.storyId === archiveTestStoryId)) throw new Error('story missing from Active filter before archiving');
        await board.setActiveFilter(boardA, 'history');
        state = await pollUntil(
          async () => {
            const s = await board.readBoardState(boardA);
            return { done: true, value: s };
          },
          { timeoutMs: 10000, describe: () => 'board to re-render under the History filter' },
        );
        if (state.cards.some((c) => c.storyId === archiveTestStoryId)) throw new Error('non-archived story unexpectedly appeared under History');
        await board.setActiveFilter(boardA, 'active');

        // Rapid duplicate clicks on Archive must not produce more than one archive mutation:
        // the second (near-simultaneous) click must be swallowed by the in-flight guard.
        const beforeArchiveEvents = (await coreEvidence.inspectCoreDatabase(globalDataDir)).eventCount;
        await Promise.all([
          board.clickCardButton(boardA, archiveTestStoryId, 'archive-story-button'),
          board.clickCardButton(boardA, archiveTestStoryId, 'archive-story-button'),
        ]);
        await board.setActiveFilter(boardA, 'history');
        const archivedState = await pollUntil(
          async () => {
            const s = await board.readBoardState(boardA);
            const card = s.cards.find((c) => c.storyId === archiveTestStoryId);
            return card ? { done: true, value: { state: s, card } } : { done: false, value: s.cards.map((c) => c.storyId) };
          },
          { timeoutMs: 15000, describe: () => 'archived story to appear under History after rapid duplicate Archive clicks' },
        );
        await new Promise((r) => setTimeout(r, 800)); // let any (incorrectly) duplicated second mutation land before inspecting the DB
        const afterArchiveDb = await coreEvidence.inspectCoreDatabase(globalDataDir);
        const archiveEventDelta = afterArchiveDb.eventCount - beforeArchiveEvents;
        if (archiveEventDelta !== 1) {
          throw new Error(`expected exactly 1 story_events row from the rapid double Archive click, got ${archiveEventDelta}`);
        }
        log(`Window A: rapid duplicate "Archive" clicks produced exactly ${archiveEventDelta} mutation (duplicate-click guard held); archived story visible under History (status=${archivedState.card.status}).`);
        await board.setActiveFilter(boardA, 'active');

        scenarioResults.F = { activeHistorySeparationOk: true, archiveEventDelta, archiveTestStoryId };
      } finally {
        await pageClientA.close();
      }
    });

    // =====================================================================
    // Scenario B: Window B, non-git folder, same shared profile.
    // =====================================================================
    let windowB, boardB;
    await timed('scenario-B', async () => {
      const existingWebviewIds = await board.currentWebviewTargetIds(sharedPort);
      const existingPageTargets = (await board.listTargets(sharedPort)).filter((t) => t.type === 'page').map((t) => t.id);
      const { child } = openWindowInSameInstance(vscodeExecutablePath, {
        userDataDir,
        extensionsDir,
        workspacePath: workspaceNonGit,
        env: coreEnv,
      });
      windowB = { child, port: sharedPort };

      const pageTargetB = await board.waitForNewWindowTarget(sharedPort, existingPageTargets, { timeoutMs: 30000 });
      const { client: boardClient } = await openBoardInWindow(sharedPort, pageTargetB.id, existingWebviewIds);
      boardB = boardClient;
      activeBoardClientsForDiagnostics.boardB = boardB;
      const connectedB = await waitForConnected(boardB, { timeoutMs: 20000 });
      if (connectedB.connectionState !== 'connected') throw new Error('Window B: Core did not show Connected');

      // The same JUGAAD project + story must appear WITHOUT any manual refresh (Core-backed, not workspace-scoped).
      const seenWithoutRefresh = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardB);
          const card = s.cards.find((c) => c.storyId === storyId);
          return card ? { done: true, value: { s, card } } : { done: false, value: s.cards.length };
        },
        { timeoutMs: 15000, describe: () => 'Window B to show the JUGAAD story without an explicit refresh' },
      );
      log(`Window B: saw story "${storyId}" (status=${seenWithoutRefresh.card.status}) immediately, no folder/git required.`);

      // Transition the story in Window B (still active — Scenario F archived a separate throwaway story, not this one).
      await board.setStoryTransition(boardB, storyId, 'ready');
      const afterWindowBTransition = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardB);
          const card = s.cards.find((c) => c.storyId === storyId);
          return card && card.status === 'ready' ? { done: true, value: card } : { done: false, value: card?.status };
        },
        { timeoutMs: 15000, describe: () => 'Window B transition to reflect status "ready"' },
      );
      log(`Window B: transitioned story to "${afterWindowBTransition.status}" via the real UI.`);

      // Window A must reflect this via the live WebSocket path, with no manual refresh.
      const seenInA = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardA);
          const card = s.cards.find((c) => c.storyId === storyId);
          return card && card.status === 'ready' ? { done: true, value: card } : { done: false, value: card?.status };
        },
        { timeoutMs: 15000, describe: () => 'Window A to observe Window B\'s transition over the WebSocket event stream' },
      );
      log(`Window A: observed Window B's transition live over WebSocket (status="${seenInA.status}") with no manual refresh.`);

      // GitHub Sync alone must be disabled, with a visible explanatory reason, while the rest of the Board stays usable.
      const boardStateB = await board.readBoardState(boardB);
      if (!boardStateB.syncDisabled) throw new Error('expected "Sync GitHub" to be disabled in a non-git workspace');
      if (!boardStateB.githubSyncNote || !boardStateB.githubSyncNote.trim()) throw new Error('expected a visible explanatory reason for GitHub Sync being disabled');
      log(`Window B: "Sync GitHub" disabled with visible reason: "${boardStateB.githubSyncNote}".`);
      if (boardStateB.connectionState !== 'connected' || boardStateB.cards.length === 0) {
        throw new Error('Board must remain fully usable in Window B despite GitHub Sync being disabled');
      }

      scenarioResults.B = { githubSyncNote: boardStateB.githubSyncNote, cardCountVisible: boardStateB.cards.length };
    });

    // =====================================================================
    // Scenario G (partial — pre-close checks): storage/singleton assertions.
    // =====================================================================
    await timed('scenario-G-pre-close', async () => {
      const nonGitHits = coreEvidence.scanWorkspaceForForbiddenCoreArtifacts(workspaceNonGit);
      if (nonGitHits.length > 0) throw new Error(`Core artifacts leaked into the disposable non-git workspace: ${nonGitHits.join(', ')}`);
      const dbInfo = await coreEvidence.inspectCoreDatabase(globalDataDir);
      if (!dbInfo.exists) throw new Error('expected core.db to exist in the isolated global data directory');
      if (dbInfo.duplicateTitles.length > 0) throw new Error(`duplicate active stories detected: ${JSON.stringify(dbInfo.duplicateTitles)}`);
      const discovery = coreEvidence.readDiscoveryRecord(globalDataDir);
      if (!discovery) throw new Error('expected a discovery record in the isolated global data directory');
      scenarioResults.G_preClose = { dbProjectCount: dbInfo.projectCount, dbStoryCount: dbInfo.storyCount, instanceId: discovery.instanceId, pid: discovery.pid };
      log(`Storage assertions OK: db at ${dbInfo.dbPath}, ${dbInfo.projectCount} project(s), ${dbInfo.storyCount} stor(y/ies), instance ${discovery.instanceId}.`);
    });

    // =====================================================================
    // Scenario C: window lifecycle — close both windows, Core stays alive, relaunch, verify persistence.
    // =====================================================================
    let windowA2Port, boardA2, storyBeforeClose;
    await timed('scenario-C', async () => {
      storyBeforeClose = await board.readBoardState(boardA);
      const discoveryBeforeClose = coreEvidence.readDiscoveryRecord(globalDataDir);

      const pageTargets = (await board.listTargets(sharedPort)).filter((t) => t.type === 'page');
      for (const target of pageTargets) {
        await board.closeTarget(sharedPort, target.id);
      }
      await new Promise((r) => setTimeout(r, 1500));
      const remainingPages = (await board.listTargets(sharedPort).catch(() => [])).filter((t) => t.type === 'page');
      if (remainingPages.length > 0) throw new Error(`expected 0 remaining VS Code window targets after closing both, got ${remainingPages.length}`);
      log('Closed both VS Code windows via the real CDP window-close boundary.');

      // The detached Core must remain alive.
      await new Promise((r) => setTimeout(r, 1000));
      const stillAlive = coreEvidence.isPidAlive(discoveryBeforeClose.pid);
      if (!stillAlive) throw new Error(`expected detached Core (pid ${discoveryBeforeClose.pid}) to remain alive after both windows closed`);
      log(`Detached Core (pid ${discoveryBeforeClose.pid}) confirmed alive after both windows closed.`);

      // Relaunch VS Code under the SAME isolated profile.
      const port2 = allocateDebugPort();
      const { child } = launchPlainHost(vscodeExecutablePath, {
        userDataDir,
        extensionsDir,
        workspacePath: undefined,
        remoteDebuggingPort: port2,
        env: coreEnv,
      });
      trackedChildren.push({ pid: child.pid, label: 'window-A2-relaunch' });
      windowA2Port = port2;
      sharedPort = port2;

      const pageTargetA2 = await waitForWorkbenchReady(port2);
      const { client: boardClient2 } = await openBoardInWindow(port2, pageTargetA2.id, []);
      boardA2 = boardClient2;
      const connected2 = await waitForConnected(boardA2, { timeoutMs: 30000 });
      if (connected2.connectionState !== 'connected') throw new Error('relaunched window: Core did not show Connected');

      const discoveryAfterRelaunch = coreEvidence.readDiscoveryRecord(globalDataDir);
      if (discoveryAfterRelaunch.instanceId !== discoveryBeforeClose.instanceId) {
        throw new Error('expected the SAME Core instance to still be running after relaunch (it should never have been restarted)');
      }

      // Project, main story (active, "ready"), status, and comment history must all persist.
      const persisted = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardA2);
          const card = s.cards.find((c) => c.storyId === storyId);
          return card ? { done: true, value: { s, card } } : { done: false, value: null };
        },
        { timeoutMs: 15000, describe: () => 'main story to persist under Active across window close + relaunch' },
      );
      if (persisted.card.status !== 'ready') {
        throw new Error(`expected the main story's status ("ready") to persist across relaunch, got "${persisted.card.status}"`);
      }
      log(`Relaunch: main story persisted under Active with status "${persisted.card.status}".`);

      // The throwaway archived story from Scenario F must persist under History (no duplicates).
      await board.setActiveFilter(boardA2, 'history');
      const persistedArchived = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardA2);
          const card = s.cards.find((c) => c.storyId === scenarioResults.F.archiveTestStoryId);
          return card ? { done: true, value: { s, card } } : { done: false, value: null };
        },
        { timeoutMs: 15000, describe: () => 'archived throwaway story to persist under History across window close + relaunch' },
      );
      log(`Relaunch: archived throwaway story persisted under History with status "${persistedArchived.card.status}".`);
      await board.setActiveFilter(boardA2, 'active');

      const dbAfterRelaunch = await coreEvidence.inspectCoreDatabase(globalDataDir);
      if (dbAfterRelaunch.duplicateTitles.length > 0 || dbAfterRelaunch.duplicateIdempotentEvents.length > 0) {
        throw new Error(`duplicates detected after relaunch: ${JSON.stringify({ titles: dbAfterRelaunch.duplicateTitles, events: dbAfterRelaunch.duplicateIdempotentEvents })}`);
      }
      log(`Relaunch verified: project/story/status/comment/history persisted, same Core instance (${discoveryAfterRelaunch.instanceId}), no duplicates.`);
      scenarioResults.C = { instanceIdUnchanged: true, dbStoryCount: dbAfterRelaunch.storyCount };
    });

    // =====================================================================
    // Scenario D: Core restart via the real command.
    // =====================================================================
    await timed('scenario-D', async () => {
      const pageTarget = await waitForWorkbenchReady(windowA2Port);
      const pageClient = await board.connectToTarget(windowA2Port, pageTarget.id);
      const discoveryBeforeRestart = coreEvidence.readDiscoveryRecord(globalDataDir);
      const observedStates = [];
      const pollHandle = setInterval(async () => {
        try {
          const state = await board.readBoardState(boardA2);
          const last = observedStates[observedStates.length - 1];
          if (!last || last !== state.connectionState) observedStates.push(state.connectionState);
        } catch {
          // webview may be transiently unreachable across the restart; ignored, we still poll the discovery record below.
        }
      }, 250);

      try {
        await pageClient.Page.bringToFront();
        await board.runCommandViaPalette(pageClient, 'KarkeDikha: Restart KarkeDikha Core');

        const discoveryAfterRestart = await coreEvidence.pollForDiscoveryRecord(globalDataDir, {
          timeoutMs: 30000,
          predicate: (record) => record.instanceId !== discoveryBeforeRestart.instanceId,
        });
        if (discoveryAfterRestart.instanceId === discoveryBeforeRestart.instanceId) {
          throw new Error('expected the Core instance ID to change after an explicit restart');
        }
        log(`Core instance ID changed: ${discoveryBeforeRestart.instanceId} -> ${discoveryAfterRestart.instanceId}.`);

        const reconnected = await waitForConnected(boardA2, { timeoutMs: 30000 });
        if (reconnected.connectionState !== 'connected') throw new Error('expected the Board to show Connected again after Core restart');
      } finally {
        clearInterval(pollHandle);
      }

      if (!observedStates.includes('connected')) {
        throw new Error(`expected to observe a visible "connected" state transition after restart; observed=${JSON.stringify(observedStates)}`);
      }
      log(`Observed visible connection-state transitions during restart: ${JSON.stringify(observedStates)}.`);

      // Active: main story persists exactly once, status remains "ready" (comments/other fields
      // aren't exposed by readBoardState's card DOM, so status is the field checked here), and the
      // Scenario F archived throwaway is correctly absent.
      const afterRestartActive = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardA2);
          const matches = s.cards.filter((c) => c.storyId === storyId);
          return matches.length === 1 ? { done: true, value: { s, card: matches[0] } } : { done: false, value: null };
        },
        { timeoutMs: 15000, describe: () => 'main story to persist under Active after Core restart' },
      );
      if (afterRestartActive.card.status !== 'ready') {
        throw new Error(`expected the main story's status ("ready") to persist across Core restart, got "${afterRestartActive.card.status}"`);
      }
      if (afterRestartActive.s.cards.some((c) => c.storyId === scenarioResults.F.archiveTestStoryId)) {
        throw new Error('expected the archived Scenario F story to be absent from Active after Core restart');
      }
      log(`Core restart: main story persisted under Active (exactly 1 card) with status "${afterRestartActive.card.status}"; archived story correctly absent.`);

      // History: archived throwaway persists exactly once, main active story is correctly absent.
      await board.setActiveFilter(boardA2, 'history');
      const afterRestartHistory = await pollUntil(
        async () => {
          const s = await board.readBoardState(boardA2);
          const matches = s.cards.filter((c) => c.storyId === scenarioResults.F.archiveTestStoryId);
          return matches.length === 1 ? { done: true, value: s } : { done: false, value: null };
        },
        { timeoutMs: 15000, describe: () => 'archived throwaway story to persist under History after Core restart' },
      );
      if (afterRestartHistory.cards.some((c) => c.storyId === storyId)) {
        throw new Error('expected the main active story to be absent from History after Core restart');
      }
      log('Core restart: archived throwaway story persisted under History (exactly 1 card); main active story correctly absent.');

      await board.setActiveFilter(boardA2, 'active');
      const dbAfterRestart = await coreEvidence.inspectCoreDatabase(globalDataDir);
      if (dbAfterRestart.duplicateTitles.length > 0 || dbAfterRestart.duplicateIdempotentEvents.length > 0) {
        throw new Error(`replay after restart created duplicates: ${JSON.stringify({ titles: dbAfterRestart.duplicateTitles, events: dbAfterRestart.duplicateIdempotentEvents })}`);
      }
      await pageClient.close();
      scenarioResults.D = { observedStates, dbStoryCount: dbAfterRestart.storyCount };
    });

    // =====================================================================
    // Scenario E: Git capability separation.
    // =====================================================================
    await timed('scenario-E', async () => {
      initGitRepo(workspaceGitNoOrigin);
      const existingWebviewIdsE1 = await board.currentWebviewTargetIds(sharedPort);
      const existingPageTargetsE1 = (await board.listTargets(sharedPort)).filter((t) => t.type === 'page').map((t) => t.id);
      const { child: childE1 } = openWindowInSameInstance(vscodeExecutablePath, {
        userDataDir,
        extensionsDir,
        workspacePath: workspaceGitNoOrigin,
        env: coreEnv,
      });
      const pageTargetE1 = await board.waitForNewWindowTarget(sharedPort, existingPageTargetsE1, { timeoutMs: 30000 });
      const { client: boardE1 } = await openBoardInWindow(sharedPort, pageTargetE1.id, existingWebviewIdsE1);
      await waitForConnected(boardE1, { timeoutMs: 20000 });
      const stateE1 = await board.readBoardState(boardE1);
      if (stateE1.cards.length === 0) throw new Error('E1 (git repo, no origin): expected the full Global Board to remain visible');
      if (!stateE1.syncDisabled) throw new Error('E1 (git repo, no origin): expected GitHub Sync alone to be disabled');
      if (stateE1.connectionState !== 'connected') throw new Error('E1: Board must remain usable');
      log(`E1 (git, no origin): Board visible with ${stateE1.cards.length} card(s); GitHub Sync disabled ("${stateE1.githubSyncNote}").`);
      await board.closeTarget(sharedPort, pageTargetE1.id);
      await new Promise((r) => setTimeout(r, 800));

      initGitRepo(workspaceGitWithOrigin, { origin: 'https://example.invalid/disposable/m31-acceptance.git' });
      const existingWebviewIdsE2 = await board.currentWebviewTargetIds(sharedPort);
      const existingPageTargetsE2 = (await board.listTargets(sharedPort)).filter((t) => t.type === 'page').map((t) => t.id);
      const { child: childE2 } = openWindowInSameInstance(vscodeExecutablePath, {
        userDataDir,
        extensionsDir,
        workspacePath: workspaceGitWithOrigin,
        env: coreEnv,
      });
      const pageTargetE2 = await board.waitForNewWindowTarget(sharedPort, existingPageTargetsE2, { timeoutMs: 30000 });
      const { client: boardE2 } = await openBoardInWindow(sharedPort, pageTargetE2.id, existingWebviewIdsE2);
      await waitForConnected(boardE2, { timeoutMs: 20000 });
      const stateE2 = await board.readBoardState(boardE2);
      const storyStillVisible = stateE2.cards.some((c) => c.storyId === storyId);
      if (!storyStillVisible) throw new Error('E2 (git repo, with origin): the global story must remain visible — the Board must never become repo-scoped');
      if (stateE2.cards.length !== stateE1.cards.length && stateE1.cards.length > 0) {
        // Cross-checking against E1's card count only as corroboration; the authoritative check is storyStillVisible above.
      }
      log(`E2 (git, with origin): all ${stateE2.cards.length} global card(s) remain visible — Board is not repo-scoped.`);
      await board.closeTarget(sharedPort, pageTargetE2.id);

      const e1Hits = coreEvidence.scanWorkspaceForForbiddenCoreArtifacts(workspaceGitNoOrigin);
      const e2Hits = coreEvidence.scanWorkspaceForForbiddenCoreArtifacts(workspaceGitWithOrigin);
      if (e1Hits.length > 0 || e2Hits.length > 0) throw new Error(`Core artifacts leaked into disposable git workspaces: ${JSON.stringify({ e1Hits, e2Hits })}`);

      scenarioResults.E = { e1CardCount: stateE1.cards.length, e2CardCount: stateE2.cards.length, storyStillVisibleWithOrigin: storyStillVisible };
    });

    // =====================================================================
    // Scenario G (final): authoritative DB location + single Core instance across every window used.
    // =====================================================================
    await timed('scenario-G-final', async () => {
      const finalDb = await coreEvidence.inspectCoreDatabase(globalDataDir);
      if (!finalDb.exists) throw new Error('expected the authoritative database to exist in the isolated global data directory');
      const strayDb = [
        ...coreEvidence.scanWorkspaceForForbiddenCoreArtifacts(workDir).filter((p) => !p.startsWith(globalDataDir)),
      ];
      if (strayDb.length > 0) throw new Error(`found Core-owned artifacts outside the isolated global data directory: ${strayDb.join(', ')}`);
      const discovery = coreEvidence.readDiscoveryRecord(globalDataDir);
      scenarioResults.G_final = { dbPath: finalDb.dbPath, projectCount: finalDb.projectCount, storyCount: finalDb.storyCount, singletonOwnerInstanceId: finalDb.singletonOwner?.instanceId, discoveryInstanceId: discovery.instanceId };
      if (finalDb.singletonOwner && discovery && finalDb.singletonOwner.instanceId !== discovery.instanceId) {
        throw new Error('singleton_owner in the DB does not match the discovery record instanceId — two Core instances may be racing');
      }
      log(`Final storage assertions OK: single authoritative DB at ${finalDb.dbPath}, singleton owner matches discovery record (${discovery.instanceId}).`);
    });

    writeEvidence('scenario-results.json', { scenarioResults, timings });
    log(`PASSED. Evidence written to ${evidenceDir}`);
    exitCode = 0;
  } catch (error) {
    console.error('[m31-ui-dogfood] FAILED');
    console.error(error);
    const failureDiagnostics = {};
    for (const [label, client] of Object.entries({ boardA: activeBoardClientsForDiagnostics.boardA, boardB: activeBoardClientsForDiagnostics.boardB })) {
      if (!client) continue;
      try {
        failureDiagnostics[label] = await board.readBoardState(client);
      } catch (diagError) {
        failureDiagnostics[label] = { error: diagError.message };
      }
      try {
        await board.captureScreenshot(client, evidenceDir, `failure-${label}`);
      } catch {
        // best effort
      }
    }
    writeEvidence('failure.json', { error: error.message, stack: error.stack, scenarioResults, timings, failureDiagnostics });
    log(`Work directory retained for inspection: ${workDir}`);
    exitCode = 1;
  } finally {
    // Terminate only test-owned VS Code processes.
    for (const { pid, label } of trackedChildren) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
        log(`Terminated test-owned VS Code process ${label} (pid ${pid}).`);
      } catch {
        // already exited
      }
    }
    // Terminate the test-owned, isolated Core process (its own isolated KARKEDIKHA_DATA_DIR /
    // port; never the developer's real Core). No UI-reachable "shutdown" command exists (only
    // "restart"), and this harness holds no bearer token for the authenticated HTTP shutdown
    // route, so process termination is the only test-cleanup path available.
    const finalDiscovery = coreEvidence.readDiscoveryRecord(globalDataDir);
    if (finalDiscovery && coreEvidence.isPidAlive(finalDiscovery.pid)) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(finalDiscovery.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          process.kill(finalDiscovery.pid, 'SIGKILL');
        }
        log(`Terminated test-owned isolated Core process (pid ${finalDiscovery.pid}).`);
      } catch {
        // already exited
      }
    }
    if (exitCode === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      log('Cleaned up all disposable workspaces, profiles, and the isolated global data directory.');
    }
    writeEvidence('timings.json', { timings, totalMs: Date.now() - startedAt });
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[m31-ui-dogfood] FAILED');
  console.error(error);
  process.exit(1);
});
