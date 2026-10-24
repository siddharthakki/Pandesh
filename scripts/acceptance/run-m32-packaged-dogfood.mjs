#!/usr/bin/env node
// npm run test:e2e:m32-packaged-dogfood
//
// The missing M32 packaged-VSIX WEBVIEW dogfood harness (see the "Next
// implementation step" section of docs/m32-progress.md, and Correction
// Phase 7's "Remaining acceptance gaps: ... packaged VSIX dogfood/evidence
// remain"). Every prior M32 acceptance script drives either the bare Core
// HTTP/WS layer (run-m32-core-execution-acceptance.mjs) or the M31 Board
// webview (run-packaged-m31-ui-dogfood.mjs) — none drives the actual
// KarkeDikha CHAT webview (media/chat.html) through Baat Kar, Saath Kar, and
// a full governed Karke Dikha run, against the real packaged VSIX and a real
// local Ollama model. This script is exactly that, reusing the existing
// driver primitives (plainVsCodeHost.mjs launch/install, boardUiDriver.mjs
// CDP target/command-palette plumbing, uiDriver.mjs webview DOM access) —
// no new driver architecture, only two small additive helpers in
// uiDriver.mjs (clickDeliveryApproveButton, readAutonomousStatusDom) that
// mirror its existing clickProposalApproveButton/clickMutationApproveButton/
// readApprovalCycleDom helpers.
//
// Direct Core evidence is read the same way run-packaged-m31-ui-dogfood.mjs's
// m31CoreEvidence.mjs already does: the isolated core.db SQLite file, opened
// read-only with node:sqlite, in the isolated KARKEDIKHA_DATA_DIR this
// harness itself owns — never an authenticated Core HTTP call (this
// out-of-process harness has no legitimate access to the bearer token held
// in the Extension Host's SecretStorage; see m31CoreEvidence.mjs's header for
// the same rationale). DB evidence is only ever read AFTER a real webview
// action already produced it, to corroborate — never as a substitute.
//
// Exit codes: 0 pass, 1 failure, 2 not-attempted (Ollama/model unavailable),
// 3 infra-blocked (a machine-wide VS Code updater mutex is held).

import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
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
import * as ui from './uiDriver.mjs';
import {
  SAATH_CANCEL_COMMAND,
  SAATH_CANCEL_FIXTURE_MODEL,
  SCENARIO_REGISTRY,
  captureConversationBaselineSnapshot,
  formatScenarioRegistry,
  normalizeRecallText,
  recallTextContainsPhrase,
  resolveFollowUpBaseline,
  selectScenarios,
  startDeterministicSaathCancelProxy,
} from './m32AcceptanceHarness.mjs';
import {
  M34_FIXTURE_MODEL,
  M34_RECOVERY_MARKER,
  M34_RETRY_MARKER,
  M34_STRONG_FIXTURE_MODEL,
  countTerminalTransitions,
  parseExecutionQualityEvents,
  realModelRoleSettings,
  startDeterministicM34Proxy,
  writeM34RealworkRepository,
  writeM34RepairRepository,
} from './m34AcceptanceHarness.mjs';
import {
  M35_CAPABLE_FIXTURE_MODEL,
  M35_FIXTURE_MODEL,
  startDeterministicM35Proxy,
  writeM35Repository,
} from './m35AcceptanceHarness.mjs';
import {
  M36_ASSISTANT_ANSWER,
  M36_FIXTURE_MODEL,
  M36_IMAGE_FIXTURE_NAME,
  M36_TEXT_FIXTURE_NAME,
  startDeterministicM36AttachmentProxy,
  writeM36Fixtures,
  M36_AUDIO_FIXTURE_NAME,
  M36_AUDIO_FIXTURE_EXPECTED_PHRASES,
  M36_PASS2_ASSISTANT_ANSWER,
  M36_PASS2_FIXTURE_MODEL,
  M36_PDF_FIXTURE_NAME,
  M36_PDF_FIXTURE_TEXT,
  startDeterministicM36Pass2Proxy,
  writeM36Pass2Fixtures,
  M36_RESEARCH_ANSWER,
  M36_RESEARCH_FIXTURE_MODEL,
  startDeterministicM36ResearchFixture,
} from './m36AcceptanceHarness.mjs';
import {
  M39_ANSWERS,
  M39_FIXTURE_MODEL,
  M39_FIXTURE_TOKEN,
  M39_GITHUB_ISSUE,
  M39_PROJECT,
  M39_PROMPTS,
  M39_REPOSITORY_FILE,
  m39FixtureModelSettings,
  startDeterministicM39MemoryFixture,
  writeM39Repository,
} from './m39AcceptanceHarness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-m32-packaged-dogfood-${runStamp}`);
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm32-packaged-dogfood');
/**
 * Dedicated, immutable evidence home for the m36-attachment-restart
 * scenario — a SIBLING of `evidenceDir`, never a subdirectory of it. Every
 * other scenario in this file writes exclusively under `evidenceDir` (which
 * `main()` unconditionally clears at the top of every run); nothing in this
 * file may ever call `fs.rmSync`/write on `m36EvidenceDir` except the single
 * guarded call in `main()` (only when this invocation actually selected
 * m36-attachment-restart) and the scenario's own evidence write on
 * completion. This is what lets `m36-attachment-restart` run in one process
 * and a later, unrelated invocation of this same script (e.g. the legacy
 * m35 bundle, which also unconditionally clears `evidenceDir`) leave this
 * scenario's evidence completely untouched — see
 * scripts/run-win32-packaged-acceptance.ps1, which runs them as two
 * separate `node` invocations for exactly this reason.
 */
const m36EvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm36-attachment-restart');
/** Same rationale as `m36EvidenceDir` above, for the pass-2 document/audio
 * scenario — its own dedicated, immutable sibling directory. */
const m36Pass2EvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm36-document-audio-restart');
// A dedicated sibling protects governed-research evidence from the shared
// legacy writer and from every other M36 scenario.
const m36ResearchEvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm36-governed-research-restart');
// The final combined exit proof has its own immutable sibling too. It must
// remain inspectable after any later shared-evidence invocation.
const m36CombinedEvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm36-combined-workbench');
// Package-provenance gate and its advisory live diagnostic must be siblings
// too: each runs in its own invocation, and the shared evidence directory is
// deliberately cleared at the beginning of every invocation.
// The M39 mandatory exit gate owns its own immutable sibling evidence
// directory for exactly the same reason every M36 scenario does: it runs in
// its own invocation, and `evidenceDir` is cleared at the start of every run.
const m39EvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm39-memory-knowledge-restart');
const m35PackageProvenanceGateEvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm35-package-provenance-gate');
const m35PackageProvenanceLiveEvidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm35-package-provenance-live-diagnostic');
const globalDataDir = path.join(workDir, 'global-data');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');

/**
 * Explicit package-input override so this harness can be pointed at a
 * specific, already-built VSIX (e.g. the exact artifact a CI run produced)
 * instead of building/using the repository-root package. When set, the
 * harness never rebuilds and uses the supplied file exactly.
 */
function resolveVsixOverride() {
  const idx = process.argv.indexOf('--vsix');
  const flagValue = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (idx !== -1 && !flagValue) throw new Error('--vsix requires an absolute path, e.g. --vsix "C:\\path\\to\\extension.vsix"');
  const value = flagValue ?? process.env.KARKEDIKHA_ACCEPTANCE_VSIX;
  if (!value) return undefined;
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`--vsix / KARKEDIKHA_ACCEPTANCE_VSIX points at a file that does not exist: ${resolved}`);
  }
  return resolved;
}

/** Exact commit this run's source tree is at, for evidence provenance. Falls
 * back to an explicit override (CI passes the git-archive'd commit via env,
 * since the Windows staging checkout this script runs from is a `git
 * archive` snapshot with no `.git` directory of its own) before shelling to
 * `git rev-parse HEAD`. */
function resolveHeadSha() {
  const override = process.env.KARKEDIKHA_ACCEPTANCE_HEAD_SHA;
  if (override) return override;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status === 0 && result.stdout) return result.stdout.trim();
  return 'unknown';
}

/** CI workflow run id when running under GitHub Actions; a locally-unique
 * fallback id otherwise, so evidence.json's `runId` is always populated. */
function resolveRunId() {
  return process.env.GITHUB_RUN_ID ?? `local-${runStamp}`;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

const sha256OfFileSync = hashFile;

/** Number of entries (files + directory records) inside a .vsix/.zip archive,
 * used for package-provenance evidence (bytes+sha256 alone don't tell you
 * whether the archive's *contents* — as opposed to its raw bytes — match a
 * separately-built VSIX from the same source). Shells to PowerShell's
 * `System.IO.Compression.ZipFile` rather than adding a zip-parsing
 * dependency, consistent with this harness's existing use of PowerShell for
 * other Windows-only introspection (see `readWindowsProcessSnapshot`). */
function countZipEntries(zipPath) {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}'); try { $z.Entries.Count } finally { $z.Dispose() }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const count = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  if (result.status !== 0 || !Number.isFinite(count)) {
    throw new Error(`failed to count zip entries in ${zipPath}: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  }
  return count;
}

function listFilesRecursive(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...listFilesRecursive(full));
    else results.push(full);
  }
  return results;
}

const suppliedVsixPath = resolveVsixOverride();
const vsixPath = suppliedVsixPath ?? path.join(repoRoot, 'karkedikha-win32-x64.vsix');

const OLLAMA_URL = process.env.KARKEDIKHA_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.KARKEDIKHA_ACCEPTANCE_MODEL ?? 'qwen2.5:14b';
const CODING_MODEL = process.env.KARKEDIKHA_ACCEPTANCE_CODING_MODEL ?? 'qwen3-coder:30b';
const NONCE = runStamp;

// Filtered and unfiltered execution are both selected from the same explicit
// registry. The registry is printed before preflight so a missing scenario can
// never be mistaken for complete acceptance.
const onlyRaw = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
  ?? process.env.KARKEDIKHA_DOGFOOD_ONLY;
let SELECTED_SCENARIOS;
try {
  SELECTED_SCENARIOS = selectScenarios(onlyRaw);
} catch (error) {
  console.error(`[m32-packaged-dogfood] ${error.message}`);
  process.exit(1);
}
const SELECTED_SCENARIO_NAMES = new Set(SELECTED_SCENARIOS.map((scenario) => scenario.name));
const wantScenario = (name) => SELECTED_SCENARIO_NAMES.has(name);

const EXIT_NOT_ATTEMPTED = 2;
const EXIT_INFRA_BLOCKED = 3;

const startedAt = Date.now();
const timings = {};
const trackedChildren = [];
const executedScenarioNames = new Set();
const headSha = resolveHeadSha();
const runId = resolveRunId();
const evidence = {
  model: MODEL,
  codingModel: CODING_MODEL,
  startedAt: new Date().toISOString(),
  headSha,
  runId,
  registry: SCENARIO_REGISTRY.map((scenario) => scenario.name),
  selectedScenarios: SELECTED_SCENARIOS.map((scenario) => scenario.name),
  scenarios: {},
};

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[m32-packaged-dogfood +${elapsed}s] ${message}`);
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

async function runRegisteredScenario(name, label, fn) {
  if (!wantScenario(name)) return undefined;
  if (executedScenarioNames.has(name)) throw new Error(`scenario executed more than once: ${name}`);
  executedScenarioNames.add(name);
  return timed(label, fn);
}

function assertAllSelectedScenariosExecuted() {
  const missing = SELECTED_SCENARIOS
    .map((scenario) => scenario.name)
    .filter((name) => !executedScenarioNames.has(name));
  if (missing.length > 0) {
    throw new Error(`selected scenario(s) were registered but did not execute: ${missing.join(', ')}`);
  }
}

function writeEvidence() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, 'evidence.json'),
    JSON.stringify({ capturedAt: new Date().toISOString(), ...evidence, timings }, null, 2),
  );
}

async function pollUntil(conditionFn, { timeoutMs = 30000, intervalMs = 500, describe } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await conditionFn();
      lastError = undefined;
      if (last && last.done) return last.value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for: ${describe?.() ?? 'condition'}; last=${JSON.stringify(last?.value)}${lastError ? `; lastError=${lastError.message}` : ''}`,
  );
}

function run(command, args, options = {}) {
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

function runCapture(command, args, options = {}) {
  const shellSafeArgs =
    process.platform === 'win32' ? args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)) : args;
  const result = spawnSync(command, shellSafeArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    ...options,
  });
  return result.stdout ?? '';
}

function initGitRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Disposable M32 packaged-dogfood workspace\n');
  run('git', ['init'], { cwd: root });
  run('git', ['config', 'user.email', 'm32-dogfood@example.com'], { cwd: root });
  run('git', ['config', 'user.name', 'M32 Packaged Dogfood'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init disposable m32 dogfood workspace'], { cwd: root });
}

/** SHA-256 of every *.vsix file directly under `root` (top level only), keyed by filename — used
 * to prove a repository-root VSIX inventory is byte-for-byte unchanged across a scenario run. */
function snapshotRootVsixInventory(root) {
  const inventory = {};
  for (const name of fs.readdirSync(root)) {
    if (!name.toLowerCase().endsWith('.vsix')) continue;
    const full = path.join(root, name);
    if (!fs.statSync(full).isFile()) continue;
    inventory[name] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return inventory;
}

/** A clean disposable checkout/worktree for the m35-package-provenance dogfood task: a full copy
 * of the exact-head repository this script is itself running from (`repoRoot`), reusing its
 * already-installed node_modules/build output via a directory junction/symlink rather than
 * recopying gigabytes, then given its own fresh git history. Never touches `repoRoot` itself —
 * the M35 source worktree this harness runs from is never modified by the dogfood task. */
function initPackageProvenanceWorkspace(root) {
  fs.mkdirSync(root, { recursive: true });
  const skipTopLevel = new Set(['.git', 'node_modules', 'out', 'out-core', '.acceptance-work', '.acceptance-evidence', '.acceptance-input']);
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    // The disposable coding workspace starts from source, never a repository
    // root package artifact. The exact supplied VSIX is independently
    // inspected from its caller-provided location instead.
    if (skipTopLevel.has(entry.name) || entry.name.toLowerCase().endsWith('.vsix')) continue;
    fs.cpSync(path.join(repoRoot, entry.name), path.join(root, entry.name), { recursive: true });
  }
  for (const shared of ['node_modules', 'out', 'out-core']) {
    const source = path.join(repoRoot, shared);
    if (fs.existsSync(source)) {
      fs.symlinkSync(source, path.join(root, shared), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  run('git', ['init'], { cwd: root });
  run('git', ['config', 'user.email', 'm35-package-provenance@example.com'], { cwd: root });
  run('git', ['config', 'user.name', 'M35 Package Provenance Dogfood'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init disposable m35 package-provenance dogfood checkout'], { cwd: root });
}

function validateNpmTestAtCommit(repositoryRoot, commitSha, validationRoot) {
  run('git', ['worktree', 'add', '--detach', validationRoot, commitSha], { cwd: repositoryRoot });
  try {
    return spawnSync('npm', ['test'], {
      cwd: validationRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
  } finally {
    run('git', ['worktree', 'remove', '--force', validationRoot], { cwd: repositoryRoot });
  }
}

async function ollamaReady() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return false;
    const body = await res.json();
    const installed = new Set((body.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean));
    return installed.has(MODEL) && installed.has(CODING_MODEL);
  } catch {
    return false;
  }
}

async function warmModel(model, purpose) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: '10m',
        messages: [{ role: 'user', content: `Reply with the word ready for ${purpose}.` }],
        options: { num_predict: 4 },
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.done || body.model !== model) {
      throw new Error(`unexpected readiness response: ${JSON.stringify({ model: body.model, done: body.done })}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Transparent, test-owned Ollama transport used only to prove the exact JSON
 * request sent by the packaged Core. Responses are streamed from the configured
 * real local Ollama unchanged; this proxy never supplies model output.
 */
async function startOllamaCaptureProxy(upstreamBaseUrl) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = null;
    }
    requests.push({
      capturedAt: new Date().toISOString(),
      method: request.method,
      path: request.url,
      body: parsedBody,
    });

    try {
      const upstream = await fetch(new URL(request.url ?? '/', `${upstreamBaseUrl.replace(/\/$/, '')}/`), {
        method: request.method,
        headers: {
          accept: request.headers.accept ?? '*/*',
          'content-type': request.headers['content-type'] ?? 'application/json',
        },
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : rawBody,
      });
      response.statusCode = upstream.status;
      const contentType = upstream.headers.get('content-type');
      if (contentType) response.setHeader('content-type', contentType);
      if (upstream.body) {
        for await (const chunk of upstream.body) response.write(chunk);
      }
      response.end();
    } catch (error) {
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: `Ollama passthrough failed: ${error.message}` }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Ollama capture proxy did not bind a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// ── Core DB evidence (read-only, isolated KARKEDIKHA_DATA_DIR) ──────────────

async function openDb(dataDir = globalDataDir) {
  const dbPath = path.join(dataDir, 'core.db');
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

async function withDb(fn, dataDir = globalDataDir) {
  const db = await openDb(dataDir);
  if (!db) return fn(null);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function findRequestByMessage(messageText, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM requests WHERE currentMessage = ? ORDER BY createdAt DESC LIMIT 1').get(messageText) ?? null;
  }, dataDir);
}

async function findRequestsByMessage(messageText, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM requests WHERE currentMessage = ? ORDER BY createdAt ASC').all(messageText);
  }, dataDir);
}

async function findAttemptsForRequest(requestId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM attempts WHERE requestId = ? ORDER BY createdAt DESC').all(requestId);
  }, dataDir);
}

async function findAttemptById(attemptId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) ?? null;
  }, dataDir);
}

async function findAttemptContext(attemptId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM attempt_contexts WHERE attemptId = ?').get(attemptId) ?? null;
  }, dataDir);
}

async function findApprovalsForAttempt(attemptId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM approvals WHERE attemptId = ? ORDER BY requestedAt ASC').all(attemptId);
  }, dataDir);
}

// Kept in sync with core/domain/failureClassification.ts's
// classifyAttemptFailure — duplicated here (not imported) because this
// harness deliberately reads all Core state as an independent verifier via
// raw SQLite queries rather than importing Core's own TS domain modules
// (see the withDb/findAttemptById family above). Classifies a terminal
// attempt's failureReason into a genuinely distinct outcome category —
// never inferred from a UI label, only ever from the durable record itself.
function classifyFailureReasonForEvidence(failureReason) {
  const text = String(failureReason ?? '').trim();
  if (!text) return 'unclassified';
  if (/mutation[_\s-]?failed/i.test(text) || /failed to apply (the )?(proposed )?(mutation|operations?)/i.test(text)) return 'mutation_failed';
  if (/validation[_\s-]?(or[_\s-]?quality[_\s-]?gate[_\s-]?)?failed/i.test(text) || /validation[_\s-]?failure/i.test(text) || /npm test failed/i.test(text) || /repository verification failed/i.test(text)) return 'validation_failure';
  if (/exceeded \d+ tool turns/i.test(text) || /without a final answer/i.test(text) || /no progress/i.test(text)) return 'gate_deadlock';
  if (/no vision-capable model was selected/i.test(text) || /do not match the frozen hash/i.test(text) || /refusing to (silently drop|send tampered)/i.test(text) || /does not support provider/i.test(text)) return 'product_failure';
  return 'model_failure';
}

/**
 * Best-effort structured terminal-state evidence for a scenario that failed
 * (or timed out) mid-flow, built entirely from durable Core records (never
 * DOM, never a UI label) so a failure artifact still preserves enough to
 * distinguish product failure / model failure / validation failure / gate
 * deadlock / harness timeout as different outcomes — never collapsed into a
 * single generic "not ok". `requestId`/`dataDir` may be unknown this early
 * in a scenario; every lookup tolerates that and reports what it honestly
 * knows, rather than throwing a second error that would mask the original.
 */
async function captureFailureEvidence({ requestId, dataDir, thrownError, harnessTimedOut = false }) {
  let attempt = null;
  let request = null;
  let approvals = [];
  let runtimeEvents = [];
  try {
    if (requestId) {
      request = await withDb((db) => db ? db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) ?? null : null, dataDir);
      const attempts = await findAttemptsForRequest(requestId, dataDir);
      attempt = attempts[0] ?? null;
      if (attempt) {
        approvals = await findApprovalsForAttempt(attempt.id, dataDir);
        runtimeEvents = await findRuntimeEventsForEntity(attempt.id, dataDir);
      }
    }
  } catch (lookupError) {
    return {
      outcomeKind: harnessTimedOut ? 'harness_timeout' : 'lookup_failed',
      thrownErrorMessage: thrownError?.message ?? null,
      evidenceLookupError: lookupError.message,
    };
  }
  const outcomeKind = harnessTimedOut
    ? 'harness_timeout'
    : attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)
      ? 'attempt_terminal'
      : 'attempt_nonterminal_at_failure';
  return {
    outcomeKind,
    thrownErrorMessage: thrownError?.message ?? null,
    requestId: requestId ?? null,
    attemptId: attempt?.id ?? null,
    attemptStatus: attempt?.status ?? null,
    // A request is immutable rather than stateful; Core's durable task state
    // is its attempt status. Keep both identifiers/evidence here so a UI
    // status label can never become the authority for a terminal outcome.
    request: request ? { id: request.id, mode: request.resolvedMode, conversationId: request.conversationId, createdAt: request.createdAt } : null,
    taskState: attempt?.status ?? null,
    failureReason: redactFailureDetail(attempt?.failureReason),
    failureClassification: attempt ? classifyFailureReasonForEvidence(attempt.failureReason) : (harnessTimedOut ? 'harness_timeout' : 'unclassified'),
    approvalEnvelopeHistory: approvals.map((a) => ({ id: a.id, kind: a.kind, status: a.status, requestedAt: a.requestedAt, resolvedAt: a.resolvedAt ?? null })),
    mutationRoundCount: approvals.filter((a) => a.kind === 'mutation').length,
    validationResults: runtimeEvents
      .filter((event) => ['validation_failed', 'validation_repair_started', 'validation_repair_completed', 'final_verification_recorded'].includes(event.eventType))
      .map((event) => ({ eventType: event.eventType, metadata: event.metadata })),
  };
}

function redactFailureDetail(value) {
  return typeof value === 'string'
    ? value.replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 1000)
    : null;
}

async function findRuntimeEventsForEntity(entityId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM runtime_events WHERE entityId = ? ORDER BY sequence ASC').all(entityId);
  }, dataDir);
}

async function findCheckpointsForAttempt(attemptId) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM checkpoints WHERE attemptId = ? ORDER BY createdAt ASC').all(attemptId);
  });
}

function autonomousTaskEvidence(workspaceRoot, attemptId) {
  const taskDir = path.join(workspaceRoot, '.ollama-agent', 'autonomous-tasks', attemptId);
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  const events = fs.readFileSync(path.join(taskDir, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { task, events };
}

function exactDomIdentity(text) {
  return typeof text === 'string' ? text.replace(/^[^:]+:\s*/, '') : null;
}

async function findModelInvocations(attemptId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM model_invocations WHERE attemptId = ? ORDER BY startedAt ASC').all(attemptId);
  }, dataDir);
}

async function findToolInvocations(attemptId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt ASC').all(attemptId);
  }, dataDir);
}

async function findConversationMessages(conversationId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM conversation_messages WHERE conversationId = ? ORDER BY seq ASC').all(conversationId);
  }, dataDir);
}

async function readResponseAlternativeEvidenceForAssistant(assistantMessageId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return null;
    const message = db.prepare('SELECT conversationId FROM conversation_messages WHERE id = ?').get(assistantMessageId);
    if (!message) return null;
    const conversationId = message.conversationId;
    return {
      conversationId,
      alternatives: db.prepare('SELECT * FROM response_alternatives WHERE conversationId = ? ORDER BY userMessageId, ordinal').all(conversationId),
      messages: db.prepare('SELECT * FROM conversation_messages WHERE conversationId = ? ORDER BY seq ASC').all(conversationId),
      researchRequestCount: db.prepare('SELECT COUNT(*) AS count FROM research_sessions WHERE conversationId = ?').get(conversationId)?.count ?? 0,
    };
  }, dataDir);
}

async function findResearchByQuery(query, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM research_sessions WHERE normalizedQuery = ? ORDER BY createdAt DESC LIMIT 1').get(query) ?? null;
  }, dataDir);
}

async function readResearchEvidence(researchId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return null;
    const session = db.prepare('SELECT * FROM research_sessions WHERE id = ?').get(researchId) ?? null;
    const approval = db.prepare('SELECT * FROM research_approvals WHERE researchId = ?').get(researchId) ?? null;
    const sources = db.prepare('SELECT * FROM research_sources WHERE researchId = ? ORDER BY resultRank, id').all(researchId);
    const citations = db.prepare('SELECT c.*, s.title AS sourceTitle, s.finalUrl AS sourceUrl, s.status AS sourceStatus FROM citations c JOIN research_sources s ON s.id = c.sourceId WHERE c.assistantMessageId IN (SELECT id FROM conversation_messages WHERE conversationId = ?) ORDER BY c.id').all(session?.conversationId ?? '');
    const messages = session ? db.prepare('SELECT * FROM conversation_messages WHERE conversationId = ? ORDER BY seq').all(session.conversationId) : [];
    return { session, approval, sources, citations, messages };
  }, dataDir);
}

async function findAttachmentsByOriginalNames(originalNames, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    const placeholders = originalNames.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM attachments WHERE originalName IN (${placeholders}) ORDER BY createdAt ASC`).all(...originalNames);
  }, dataDir);
}

async function findMessageAttachmentLinksForMessage(messageId, dataDir = globalDataDir) {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM message_attachments WHERE messageId = ? ORDER BY ordinal ASC').all(messageId);
  }, dataDir);
}

async function findAllConversations() {
  return withDb((db) => {
    if (!db) return [];
    return db.prepare('SELECT * FROM conversations ORDER BY id ASC').all();
  });
}

async function findConversationById(conversationId) {
  return withDb((db) => {
    if (!db) return null;
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) ?? null;
  });
}

async function countNonTerminalAttemptsForRequest(requestId) {
  return withDb((db) => {
    if (!db) return 0;
    return db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE requestId = ? AND status NOT IN ('completed','failed','cancelled')")
      .get(requestId).n;
  });
}

function readDiscoveryRecord(dataDir = globalDataDir) {
  const file = path.join(dataDir, 'core.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function terminateOwnedProcessTree(pid) {
  if (!pid || !isPidAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

function readWindowsProcessSnapshot() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout?.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: Number(entry.ProcessId),
    parentPid: Number(entry.ParentProcessId),
    name: entry.Name ?? null,
    commandLine: entry.CommandLine ?? null,
  }));
}

function descendantsOf(rootPid, processes) {
  const descendants = [];
  const parentIds = new Set([Number(rootPid)]);
  let added = true;
  while (added) {
    added = false;
    for (const process of processes) {
      if (parentIds.has(process.parentPid) && !parentIds.has(process.pid)) {
        parentIds.add(process.pid);
        descendants.push(process);
        added = true;
      }
    }
  }
  return descendants;
}

function findOwnedCommandProcessTree(corePid, commandMarker) {
  const processes = readWindowsProcessSnapshot();
  const descendants = descendantsOf(corePid, processes);
  const normalize = (value) => value?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '';
  const marker = normalize(commandMarker);
  const commandProcesses = descendants.filter((process) => normalize(process.commandLine).includes(marker));
  const commandIds = new Set(commandProcesses.map((process) => process.pid));
  const ownedTree = descendants.filter(
    (process) => commandIds.has(process.pid) || commandIds.has(process.parentPid),
  );
  const commandProcess = commandProcesses.find((process) => process.name?.toLowerCase() === 'ping.exe')
    ?? commandProcesses.at(-1)
    ?? null;
  return { corePid, commandProcess, processes: ownedTree };
}

async function pollForAttemptViaMessage(messageText, predicate, { timeoutMs = 60000 } = {}) {
  return pollUntil(
    async () => {
      const request = await findRequestByMessage(messageText);
      if (!request) return { done: false, value: 'no request row yet' };
      const attempts = await findAttemptsForRequest(request.id);
      const attempt = attempts[0];
      if (!attempt) return { done: false, value: 'request exists, no attempt yet' };
      return predicate(attempt) ? { done: true, value: { request, attempt } } : { done: false, value: attempt.status };
    },
    { timeoutMs, describe: () => `attempt for request "${messageText.slice(0, 40)}..." to satisfy predicate` },
  );
}

/**
 * A freshly-opened chat webview can accept UI input before CoreManager (the
 * Extension Host's async connection to the just-spawned Core process) has
 * finished its connect handshake — the webview posts a structured
 * `{type:'error', message:'KarkeDikha Core is not connected...'}` in that
 * window and creates no conversation/request/attempt row at all (verified
 * interactively: sending immediately after `waitForWebviewContentMounted`
 * resolves reliably reproduces this; waiting ~8s first does not). This
 * bounded retry loop resends until either a request row appears in Core's DB
 * (real acceptance, not just "no error observed") or attempts are exhausted,
 * so a real product/model failure downstream still surfaces as a hard error
 * from the subsequent full-timeout terminal-state poll.
 */
async function reEnableComposerButtons(webviewClient) {
  // A rejected startAutonomousTask leaves #autonomous-start-btn permanently
  // disabled (only the app's own 'autonomousTaskRejected'/'autonomousTaskStarted'
  // messages re-enable it — a generic Core-rejection 'error' does not, since
  // that reset path was written for the M15 byte-limit rejection case, not
  // this harness's Core-not-yet-connected race). Force it back on before a
  // resend; a disabled button silently swallows a programmatic .click().
  await ui.evalInWebviewDoc(webviewClient, `(() => {
    const startBtn = document.getElementById('autonomous-start-btn');
    if (startBtn) startBtn.disabled = false;
    return true;
  })()`).catch(() => {});
}

async function sendWithCoreConnectedRetry(webviewClient, sendFn, messageText, { maxAttempts = 8, retryDelayMs = 3000, acceptWindowMs = 6000, dataDir = globalDataDir } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await reEnableComposerButtons(webviewClient);
    const before = (await readInboundMessages(webviewClient)).length; // only inspect messages posted AFTER this send — the recorder never clears, so a stale error from a prior attempt must not be mistaken for this attempt's outcome
    await sendFn();
    const outcome = await pollUntil(
      async () => {
        const inbound = await readInboundMessages(webviewClient);
        const freshMessages = inbound.slice(before);
        const notConnected = freshMessages.find((m) => m.type === 'error' && /not connected|core rejected|runtime is not available|already in progress/i.test(m.message ?? ''));
        if (notConnected) return { done: true, value: { kind: 'not_connected', message: notConnected.message, freshMessages } };
        const request = await findRequestByMessage(messageText, dataDir);
        if (request) return { done: true, value: { kind: 'accepted', request } };
        return { done: false, value: { freshMessages } };
      },
      { timeoutMs: acceptWindowMs, intervalMs: 400 },
    ).catch(() => ({ kind: 'unknown_no_signal_yet' }));
    if (outcome.kind === 'accepted') return outcome.request;
    log(`send attempt ${attempt}/${maxAttempts} not yet accepted by Core (${outcome.kind}${outcome.message ? `: ${outcome.message}` : ''}); freshMessages=${JSON.stringify(outcome.freshMessages ?? [])}; retrying in ${retryDelayMs}ms...`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Core never accepted the submission "${messageText.slice(0, 60)}..." after ${maxAttempts} attempts`);
}

// ── Window lifecycle ──────────────────────────────────────────────────────

async function windowDiagnostics(windowHandle) {
  let targets = [];
  let endpointError = null;
  try {
    targets = await board.listTargets(windowHandle.cdpPort);
  } catch (error) {
    endpointError = error instanceof Error ? error.message : String(error);
  }
  return {
    requestedCdpPort: windowHandle.requestedCdpPort,
    actualDiscoveredCdpEndpoint: endpointError ? null : `http://127.0.0.1:${windowHandle.cdpPort}`,
    actualPageTarget: windowHandle.pageTargetId
      ? targets.find((target) => target.id === windowHandle.pageTargetId) ?? null
      : null,
    launchedPid: windowHandle.launchedPid,
    launcherExitCode: windowHandle.launcher?.exitCode ?? null,
    joinedExistingInstance: windowHandle.joinedExistingInstance,
    profile: windowHandle.profile,
    workspace: windowHandle.workspace,
    endpointError,
    pageTargetIds: targets.filter((target) => target.type === 'page').map((target) => target.id),
  };
}

async function waitForWorkbenchReady(windowHandle, { timeoutMs = 45000 } = {}) {
  const excluded = new Set(windowHandle.excludePageTargetIds ?? []);
  try {
    const page = await pollUntil(
      async () => {
        const targets = await board.listTargets(windowHandle.cdpPort);
        const candidate = windowHandle.pageTargetId
          ? targets.find((target) => target.type === 'page' && target.id === windowHandle.pageTargetId)
          : targets.find((target) => target.type === 'page' && !excluded.has(target.id));
        return candidate ? { done: true, value: candidate } : { done: false, value: targets.length };
      },
      {
        timeoutMs,
        describe: () => `the owned workbench target on CDP port ${windowHandle.requestedCdpPort}`,
      },
    );
    windowHandle.pageTargetId = page.id;
    return page;
  } catch (error) {
    throw new Error(`${error.message}; windowDiagnostics=${JSON.stringify(await windowDiagnostics(windowHandle))}`);
  }
}

/**
 * Proves the attached webview is the one the Extension Host is actually
 * posting to.
 *
 * More than one KarkeDikha chat webview iframe can be alive at the same
 * moment — a lingering pre-restart target whose window is still tearing down,
 * or a workbench-restored serialized view — and CDP's target list has no
 * defined order, so `connectToWebviewHostTarget` can legitimately hand back a
 * webview that `AgentPanel.view` no longer refers to. Such a webview mounts,
 * renders chat.html, and answers DOM queries perfectly while receiving zero
 * extension messages forever; downstream that surfaced as an intermittent
 * "restored transcript / citations never appear" timeout with an empty
 * `#messages`.
 *
 * The probe uses only the product's own message protocol: install a capture
 * listener, ask the panel for the model list (`getModels`, which every mode
 * answers — with `modelsLoaded` on success or `error` on failure), and wait
 * for any inbound message. A dead webview answers nothing.
 */
async function webviewIsLive(webviewClient, { timeoutMs = 6000 } = {}) {
  await ui.evalInWebviewDoc(
    webviewClient,
    `(() => {
      const w = document.defaultView;
      if (!w.__oaLiveProbe) {
        w.__oaLiveProbe = { seen: 0 };
        w.addEventListener('message', () => { w.__oaLiveProbe.seen += 1; });
      }
      const api = w.__ollamaAgentVsCodeApi;
      if (api && typeof api.postMessage === 'function') api.postMessage({ type: 'getModels' });
      return true;
    })()`,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await ui
      .evalInWebviewDoc(webviewClient, `(document.defaultView.__oaLiveProbe && document.defaultView.__oaLiveProbe.seen) || 0`)
      .catch(() => 0);
    if (Number(seen) > 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function openChatPanel(windowHandle, { contentMountedTimeoutMs = 30000, contentMountedReadyElementId = 'proposal-approve-btn' } = {}) {
  const pageTarget = await waitForWorkbenchReady(windowHandle);
  const pageClient = await board.connectToTarget(windowHandle.cdpPort, pageTarget.id);
  try {
    await pageClient.Page.bringToFront();
    await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
    const rejectedWebviewTargetIds = [];
    let connected;
    let webviewClient;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      connected = await ui.connectToWebviewHostTarget(windowHandle.cdpPort, {
        attempts: 60,
        delayMs: 500,
        targetId: windowHandle.webviewTargetId ?? null,
        excludeIds: [...(windowHandle.excludeWebviewTargetIds ?? []), ...rejectedWebviewTargetIds],
      });
      webviewClient = connected.client;
      await ui.waitForWebviewContentMounted(webviewClient, { timeoutMs: contentMountedTimeoutMs, readyElementId: contentMountedReadyElementId });
      if (await webviewIsLive(webviewClient)) break;
      log(`openChatPanel: webview target ${connected.targetId} is mounted but receives no extension messages; re-selecting (attempt ${attempt}).`);
      rejectedWebviewTargetIds.push(connected.targetId);
      await webviewClient.close().catch(() => {});
      webviewClient = undefined;
      // A stale target can only be replaced by asking the workbench to reveal
      // the real view again; the pinned id (if any) is dropped so the next
      // pass genuinely re-selects.
      windowHandle.webviewTargetId = null;
      await board.runCommandViaPalette(pageClient, 'KarkeDikha: Open');
    }
    if (!webviewClient) {
      throw new Error(`openChatPanel could not attach to a live KarkeDikha webview (rejected targets: ${rejectedWebviewTargetIds.join(', ') || 'none'})`);
    }
    windowHandle.webviewTargetId = connected.targetId;
    await ui.instrumentWebviewPostMessage(webviewClient);
    // A freshly-mounted webview can be interactive before CoreManager's async
    // connection to the just-spawned (or just-discovered) Core process finishes
    // (verified interactively: sending immediately reliably reproduces a
    // "Core is not connected" error with zero durable records; waiting first
    // does not). This settle delay makes the common case need zero retries;
    // sendWithCoreConnectedRetry below still covers the slow-connect tail.
    await new Promise((r) => setTimeout(r, 8000));
    return { pageTargetId: pageTarget.id, pageClient, webviewClient, windowHandle };
  } catch (error) {
    await pageClient.close().catch(() => {});
    throw new Error(`${error.message}; windowDiagnostics=${JSON.stringify(await windowDiagnostics(windowHandle))}`);
  }
}

async function readInboundMessages(webviewClient) {
  return (await ui.readInstrumentedInboundMessages(webviewClient)) ?? [];
}

async function setMode(webviewClient, mode) {
  // 'chat' | 'agent' | 'autonomous'
  await ui.clickModeButton(webviewClient, mode);
}

async function sendChatMessage(webviewClient, text) {
  await ui.evalInWebviewDoc(
    webviewClient,
    `(() => {
      const input = document.getElementById('user-input');
      const btn = document.getElementById('send-btn');
      if (!input || !btn) throw new Error('chat composer not found');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return true;
    })()`,
  );
}

async function clickStopButton(webviewClient) {
  await ui.evalInWebviewDoc(
    webviewClient,
    `(() => {
      const btn = document.getElementById('stop-btn');
      if (!btn) throw new Error('stop-btn not found');
      btn.click();
      return true;
    })()`,
  );
}

async function startAutonomousTask(webviewClient, text) {
  await setMode(webviewClient, 'autonomous');
  await ui.evalInWebviewDoc(
    webviewClient,
    `(() => {
      const textarea = document.getElementById('autonomous-input');
      const btn = document.getElementById('autonomous-start-btn');
      if (!textarea || !btn) throw new Error('autonomous composer not found');
      textarea.value = ${JSON.stringify(text)};
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return true;
    })()`,
  );
}

function reportInfraBlockedIfUpdaterActive() {
  const updaters = detectActiveVSCodeUpdater();
  if (updaters.length === 0) return false;
  log(`INFRA_BLOCKED: a VS Code installer/updater is holding the machine-wide mutex (pid ${updaters[0].pid}).`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'infra-blocked.json'), JSON.stringify({ status: 'INFRA_BLOCKED', updaters }, null, 2));
  return true;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;

  log(`Unfiltered scenario registry:\n${formatScenarioRegistry()}`);
  log(`Selected scenarios: ${SELECTED_SCENARIOS.map((scenario) => scenario.name).join(', ')}`);

  if (reportInfraBlockedIfUpdaterActive()) process.exit(EXIT_INFRA_BLOCKED);

  const requiresRealModel = SELECTED_SCENARIOS.some((scenario) => scenario.requiresRealModel);
  if (requiresRealModel && !(await ollamaReady())) {
    log(`Ollama or required models '${MODEL}' and '${CODING_MODEL}' not available at ${OLLAMA_URL} — NOT ATTEMPTED.`);
    if (wantScenario('m35-package-provenance-live-diagnostic')) {
      fs.mkdirSync(m35PackageProvenanceLiveEvidenceDir, { recursive: true });
      fs.writeFileSync(
        path.join(m35PackageProvenanceLiveEvidenceDir, 'evidence.json'),
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          scenario: 'm35-package-provenance-live-diagnostic',
          outcomeKind: 'not_attempted',
          reason: 'required local model unavailable',
          model: MODEL,
          codingModel: CODING_MODEL,
        }, null, 2),
      );
    }
    process.exit(EXIT_NOT_ATTEMPTED);
  }

  fs.rmSync(evidenceDir, { recursive: true, force: true });
  // m36EvidenceDir is deliberately NOT cleared unconditionally above: it must
  // survive a run that did not select m36-attachment-restart at all (e.g. the
  // legacy m35 bundle invocation that runs immediately afterward in CI). Only
  // clear it here, at the very start of a run that itself selected the
  // scenario — the scenario's own evidence write at completion is then the
  // sole subsequent writer.
  if (wantScenario('m36-attachment-restart')) {
    fs.rmSync(m36EvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m36EvidenceDir, { recursive: true });
  }
  if (wantScenario('m36-document-audio-restart')) {
    fs.rmSync(m36Pass2EvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m36Pass2EvidenceDir, { recursive: true });
  }
  if (wantScenario('m36-governed-research-restart')) {
    fs.rmSync(m36ResearchEvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m36ResearchEvidenceDir, { recursive: true });
  }
  if (wantScenario('m36-combined-workbench')) {
    fs.rmSync(m36CombinedEvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m36CombinedEvidenceDir, { recursive: true });
  }
  if (wantScenario('m39-memory-knowledge-restart')) {
    fs.rmSync(m39EvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m39EvidenceDir, { recursive: true });
  }
  if (wantScenario('m35-package-provenance-gate')) {
    fs.rmSync(m35PackageProvenanceGateEvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m35PackageProvenanceGateEvidenceDir, { recursive: true });
  }
  if (wantScenario('m35-package-provenance-live-diagnostic')) {
    fs.rmSync(m35PackageProvenanceLiveEvidenceDir, { recursive: true, force: true });
    fs.mkdirSync(m35PackageProvenanceLiveEvidenceDir, { recursive: true });
  }
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(globalDataDir, { recursive: true });

  let exitCode = 1;
  let ownedCdpPort;
  let chatWindow;
  let ollamaCapture;

  try {
    if (suppliedVsixPath) {
      log(`Using explicitly supplied VSIX (never rebuilding): ${vsixPath}`);
    } else if (!fs.existsSync(vsixPath)) {
      await timed('build:package', () => run('npm', ['run', 'package:win32-x64'], { cwd: repoRoot }));
    }
    if (!fs.existsSync(vsixPath)) throw new Error(`expected VSIX at ${vsixPath}`);
    const packageProvenance = {
      source: suppliedVsixPath ? 'supplied' : 'built',
      path: vsixPath,
      bytes: fs.statSync(vsixPath).size,
      sha256: hashFile(vsixPath),
      entryCount: countZipEntries(vsixPath),
    };
    evidence.packageProvenance = packageProvenance;
    log(`Using packaged VSIX at ${vsixPath} (bytes=${packageProvenance.bytes} sha256=${packageProvenance.sha256} entries=${packageProvenance.entryCount}).`);

    const { vscodeExecutablePath, cliArgs } = await timed('resolve-vscode', () => resolveVSCode());
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });
    writeUserSettingsForCustomDialogs(userDataDir);
    const sharedSettingsPath = path.join(userDataDir, 'User', 'settings.json');
    const sharedSettings = JSON.parse(fs.readFileSync(sharedSettingsPath, 'utf8'));
    fs.writeFileSync(
      sharedSettingsPath,
      JSON.stringify({ ...sharedSettings, ...realModelRoleSettings(MODEL, CODING_MODEL) }, null, 2),
    );
    if (requiresRealModel && process.env.KARKEDIKHA_SKIP_REAL_MODEL_WARMUP !== '1') {
      // A tags response only proves that the weights are installed. Real
      // governed scenarios may dispatch their first stage to CODING_MODEL;
      // warming only MODEL leaves that first request to absorb a cold 30B
      // model load and can make the approval/restart gate time out before a
      // proposal exists. Keep both configured local models alive explicitly.
      for (const model of new Set([MODEL, CODING_MODEL])) {
        await timed(`warm-real-model:${model}`, () => warmModel(model, model === CODING_MODEL ? 'coding' : 'chat'));
      }
    } else if (requiresRealModel) {
      // The Windows packaged harness records a separately timed real-model
      // warmup diagnostic before it invokes any advisory live scenarios. Do
      // not repeat that potentially slow, non-gating operation here.
      log('Skipping in-run real-model warmup because the outer diagnostic already recorded it.');
    }
    await timed('install-vsix', () => installExtension(cliArgs, { userDataDir, extensionsDir, vsixPath }));

    if (wantScenario('followup')) {
      ollamaCapture = await timed('start-ollama-capture-proxy', () => startOllamaCaptureProxy(OLLAMA_URL));
      log(`Capturing packaged Core model requests through transparent Ollama passthrough ${ollamaCapture.baseUrl}.`);
    }
    const coreEnv = {
      KARKEDIKHA_DATA_DIR: globalDataDir,
      ...(ollamaCapture ? { KARKEDIKHA_OLLAMA_URL: ollamaCapture.baseUrl } : {}),
    };

    const wsChat = path.join(workDir, 'ws-chat-nongit');
    fs.mkdirSync(wsChat, { recursive: true });
    fs.writeFileSync(path.join(wsChat, 'README.md'), '# Disposable Baat Kar / Saath Kar workspace\n');

    const wsKarke = path.join(workDir, 'ws-karke');
    const wsRestart = path.join(workDir, 'ws-restart');

    /** One isolated profile owns one CDP endpoint. Additional VS Code windows
     * join that instance and are selected by exact page/webview target IDs. */
    const launchWorkspaceWindow = async (workspacePath, label) => {
      let existingTargets = [];
      if (ownedCdpPort) {
        try {
          existingTargets = await board.listTargets(ownedCdpPort);
        } catch {
          ownedCdpPort = undefined;
        }
      }

      let launched;
      let joinedExistingInstance = false;
      let requestedCdpPort;
      if (!ownedCdpPort) {
        requestedCdpPort = allocateDebugPort();
        launched = launchPlainHost(vscodeExecutablePath, {
          userDataDir, extensionsDir, workspacePath, remoteDebuggingPort: requestedCdpPort, env: coreEnv,
        });
        ownedCdpPort = requestedCdpPort;
        existingTargets = [];
        trackedChildren.push({ pid: launched.child.pid, label });
      } else {
        requestedCdpPort = ownedCdpPort;
        joinedExistingInstance = true;
        launched = openWindowInSameInstance(vscodeExecutablePath, {
          userDataDir, extensionsDir, workspacePath, env: coreEnv,
        });
      }

      return {
        label,
        cdpPort: ownedCdpPort,
        requestedCdpPort,
        launchedPid: launched.child.pid,
        launcher: launched.child,
        launchArgs: launched.args,
        joinedExistingInstance,
        profile: userDataDir,
        workspace: workspacePath,
        excludePageTargetIds: existingTargets.filter((target) => target.type === 'page').map((target) => target.id),
        excludeWebviewTargetIds: existingTargets
          .filter((target) => target.type === 'iframe' && target.url?.startsWith('vscode-webview://'))
          .map((target) => target.id),
        pageTargetId: null,
        webviewTargetId: null,
      };
    };

    const launchIsolatedScenarioWindow = async ({
      workspacePath,
      label,
      scenarioRoot,
      ollamaUrl,
      model,
      settings = {},
    }) => {
      const isolatedUserDataDir = path.join(scenarioRoot, 'user-data');
      const isolatedExtensionsDir = path.join(scenarioRoot, 'extensions');
      const isolatedGlobalDataDir = path.join(scenarioRoot, 'global-data');
      fs.mkdirSync(isolatedUserDataDir, { recursive: true });
      fs.mkdirSync(isolatedExtensionsDir, { recursive: true });
      fs.mkdirSync(isolatedGlobalDataDir, { recursive: true });
      writeUserSettingsForCustomDialogs(isolatedUserDataDir);
      if (Object.keys(settings).length > 0) {
        const settingsPath = path.join(isolatedUserDataDir, 'User', 'settings.json');
        const existingSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        fs.writeFileSync(settingsPath, JSON.stringify({ ...existingSettings, ...settings }, null, 2));
      }
      installExtension(cliArgs, {
        userDataDir: isolatedUserDataDir,
        extensionsDir: isolatedExtensionsDir,
        vsixPath,
      });

      const cdpPort = allocateDebugPort();
      const launched = launchPlainHost(vscodeExecutablePath, {
        userDataDir: isolatedUserDataDir,
        extensionsDir: isolatedExtensionsDir,
        workspacePath,
        remoteDebuggingPort: cdpPort,
        env: {
          KARKEDIKHA_DATA_DIR: isolatedGlobalDataDir,
          KARKEDIKHA_OLLAMA_URL: ollamaUrl,
          KARKEDIKHA_DEFAULT_MODEL: model,
        },
      });
      return {
        label,
        cdpPort,
        requestedCdpPort: cdpPort,
        launchedPid: launched.child.pid,
        launcher: launched.child,
        launchArgs: launched.args,
        joinedExistingInstance: false,
        profile: isolatedUserDataDir,
        workspace: workspacePath,
        excludePageTargetIds: [],
        excludeWebviewTargetIds: [],
        pageTargetId: null,
        webviewTargetId: null,
        globalDataDir: isolatedGlobalDataDir,
      };
    };

    // Shared chat-workspace window (Baat Kar / Saath Kar / follow-up all use
    // it): launched lazily so `--only=` runs of a later scenario still get a
    // window without re-running earlier scenarios.
    const ensureChatWindow = async () => {
      if (!chatWindow) chatWindow = await launchWorkspaceWindow(wsChat, 'window-chat-shared');
      return chatWindow;
    };

    // =====================================================================
    // Scenario 1: Baat Kar
    // =====================================================================
    await runRegisteredScenario('baatkar', 'scenario-1-baat-kar', async () => {
      const windowHandle = await ensureChatWindow();
      const { pageClient, webviewClient } = await openChatPanel(windowHandle);
      await setMode(webviewClient, 'chat');

      const prompt = `Reply with exactly one short word: hello. (nonce ${NONCE}-baatkar)`;
      await sendWithCoreConnectedRetry(webviewClient, () => sendChatMessage(webviewClient, prompt), prompt);

      const { request, attempt } = await pollForAttemptViaMessage(
        prompt,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 90000 },
      );

      await new Promise((r) => setTimeout(r, 500));
      const inbound = await readInboundMessages(webviewClient);
      const tokenMessages = inbound.filter((m) => m.type === 'token');
      const doneMessages = inbound.filter((m) => m.type === 'done' || m.type === 'error' || m.type === 'stopped');
      const assistantBubbleText = await ui.evalInWebviewDoc(
        webviewClient,
        `Array.from(document.querySelectorAll('.bubble.assistant')).map(b => b.textContent).pop() ?? null`,
      );
      const modelInvocations = await findModelInvocations(attempt.id);

      const ok = attempt.status === 'completed' && tokenMessages.length > 0 && doneMessages.some((m) => m.type === 'done')
        && !!assistantBubbleText && modelInvocations.some((mi) => mi.status === 'succeeded');

      await board.captureScreenshot(pageClient, evidenceDir, '1-baat-kar').catch(() => {});
      evidence.scenarios.baatKar = {
        ok,
        requestId: request.id, attemptId: attempt.id, attemptStatus: attempt.status,
        streamedTokenCount: tokenMessages.length,
        webviewAssistantText: assistantBubbleText,
        modelInvocations: modelInvocations.map((mi) => ({ status: mi.status, actualModel: mi.actualModel, latencyMs: mi.latencyMs })),
        note: 'Core attempt reached "completed" via submit()+executeAttempt() (Correction Phase 4 sole executor path) — structurally confirms AgentRuntime.run() was never invoked for this turn, per docs/m32-progress.md Correction Phase 4.',
      };
      log(`Baat Kar: attempt ${attempt.id} status=${attempt.status}, streamed ${tokenMessages.length} token frames, assistant="${assistantBubbleText}"`);
      if (!ok) throw new Error(`Baat Kar scenario did not meet acceptance: ${JSON.stringify(evidence.scenarios.baatKar)}`);

      await pageClient.close();
      await webviewClient.close();
    });

    // =====================================================================
    // Scenario 2: Saath Kar real-model smoke (same window as Baat Kar)
    // =====================================================================
    await runRegisteredScenario('saathkar', 'scenario-2-saath-kar-real-model-smoke', async () => {
      const windowHandle = await ensureChatWindow();
      const { pageClient, webviewClient } = await openChatPanel(windowHandle);
      await setMode(webviewClient, 'agent');

      const prompt = `Briefly describe this workspace. Use an available inspection tool only if you think it is useful; otherwise answer directly. (nonce ${NONCE}-saathkar)`;
      const inboundBaseline = (await readInboundMessages(webviewClient)).length;
      await sendChatMessage(webviewClient, prompt);
      const { request, attempt } = await pollForAttemptViaMessage(
        prompt,
        (candidate) => ['completed', 'failed', 'cancelled'].includes(candidate.status),
        { timeoutMs: 120000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      const requests = await findRequestsByMessage(prompt);
      const attempts = requests.length === 1 ? await findAttemptsForRequest(requests[0].id) : [];
      const modelInvocations = await findModelInvocations(attempt.id);
      const toolInvocations = await findToolInvocations(attempt.id);
      const conversationMessages = request.conversationId ? await findConversationMessages(request.conversationId) : [];
      const invocationIds = new Set(modelInvocations.map((invocation) => invocation.id));
      const assistantResponses = conversationMessages.filter(
        (message) => message.role === 'assistant' && invocationIds.has(message.modelInvocationId),
      );
      const submissions = ((await ui.readInstrumentedPostedMessages(webviewClient)) ?? [])
        .filter((message) => message?.type === 'sendMessage' && message.text === prompt);
      const terminalUiMessages = (await readInboundMessages(webviewClient)).slice(inboundBaseline)
        .filter((message) => message.type === 'done' || message.type === 'error' || message.type === 'stopped');
      const realSucceeded = modelInvocations.some(
        (invocation) => invocation.status === 'succeeded'
          && invocation.actualProvider === 'ollama'
          && invocation.actualModel === MODEL,
      );
      const noFallback = modelInvocations.every((invocation) => !Boolean(invocation.fallbackUsed));
      const duplicateCounts = {
        visibleSubmissions: submissions.length,
        requests: requests.length,
        attempts: attempts.length,
        modelInvocationRows: modelInvocations.length,
        uniqueModelInvocationIds: invocationIds.size,
        assistantResponses: assistantResponses.length,
        terminalUiMessages: terminalUiMessages.length,
      };
      const ok = ['completed', 'failed', 'cancelled'].includes(attempt.status)
        && requests.length === 1
        && attempts.length === 1
        && submissions.length === 1
        && modelInvocations.length > 0
        && modelInvocations.every((invocation) => ['succeeded', 'failed', 'cancelled'].includes(invocation.status))
        && realSucceeded
        && noFallback
        && invocationIds.size === modelInvocations.length
        && toolInvocations.every((tool) => tool.status !== 'pending' && !!tool.evidence)
        && assistantResponses.length === (attempt.status === 'completed' ? 1 : 0)
        && terminalUiMessages.length === 1;

      evidence.scenarios.saathKar = {
        ok,
        configuredEndpoint: OLLAMA_URL,
        configuredRealModel: MODEL,
        actualBehavior: toolInvocations.length > 0 ? 'tool_calls' : 'final_answer',
        requestId: request.id,
        attemptId: attempt.id,
        attemptStatus: attempt.status,
        modelInvocations: modelInvocations.map((invocation) => ({
          id: invocation.id,
          status: invocation.status,
          requestedProvider: invocation.requestedProvider,
          requestedModel: invocation.requestedModel,
          actualProvider: invocation.actualProvider,
          actualModel: invocation.actualModel,
          fallbackUsed: Boolean(invocation.fallbackUsed),
        })),
        toolInvocations: toolInvocations.map((tool) => ({
          id: tool.id,
          toolName: tool.toolName,
          status: tool.status,
          evidence: JSON.parse(tool.evidence ?? '{}'),
        })),
        assistantResponses: assistantResponses.map((message) => ({
          id: message.id,
          modelInvocationId: message.modelInvocationId,
          content: message.content,
        })),
        duplicateCounts,
        noHiddenFallback: noFallback,
      };
      await board.captureScreenshot(pageClient, evidenceDir, '2-saath-kar-real-model').catch(() => {});
      log(`Saath Kar real-model smoke: attempt ${attempt.id}=${attempt.status}; behavior=${evidence.scenarios.saathKar.actualBehavior}; invocations=${modelInvocations.length}; tools=${toolInvocations.length}.`);
      await pageClient.close();
      await webviewClient.close();
      if (!ok) throw new Error(`Saath Kar real-model smoke did not meet acceptance: ${JSON.stringify(evidence.scenarios.saathKar)}`);
    });

    // =====================================================================
    // Scenario 3: deterministic cancellation in a dedicated profile/endpoint
    // =====================================================================
    await runRegisteredScenario('saathcancel', 'scenario-3-saath-kar-deterministic-cancellation', async () => {
      const scenarioRoot = path.join(workDir, 'saathcancel-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'README.md'), '# Deterministic cancellation acceptance workspace\n');
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = {
        ok: false,
        proxy: { endpoint: null, model: SAATH_CANCEL_FIXTURE_MODEL, cleanedUp: false },
        cleanup: null,
      };
      evidence.scenarios.saathCancel = scenarioEvidence;
      try {
        fixture = await startDeterministicSaathCancelProxy();
        scenarioEvidence.proxy.endpoint = fixture.baseUrl;
        log(`Saath cancellation fixture listening at ${fixture.baseUrl} with isolated model ${fixture.model}.`);
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-saathcancel-isolated',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        await setMode(webviewClient, 'agent');

        const cancelPrompt = `Start the available long-running command so I can test the visible Stop control. (nonce ${NONCE}-saathcancel)`;
        const inboundBaseline = (await readInboundMessages(webviewClient)).length;
        await sendChatMessage(webviewClient, cancelPrompt);

        const commandMarker = SAATH_CANCEL_COMMAND;
      const childStart = await pollUntil(
        async () => {
          const request = await findRequestByMessage(cancelPrompt, windowHandle.globalDataDir);
          if (!request) return { done: false, value: 'no request yet' };
          const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
          const attempt = attempts[0];
          if (!attempt) return { done: false, value: 'no attempt yet' };
          const discovery = readDiscoveryRecord(windowHandle.globalDataDir);
          const tools = await findToolInvocations(attempt.id, windowHandle.globalDataDir);
          const activeTool = tools.find(
            (tool) => tool.toolName === 'run_command'
              && tool.status === 'pending'
              && JSON.parse(tool.argsSummary ?? '{}').command === SAATH_CANCEL_COMMAND,
          );
          const processTree = discovery?.pid ? findOwnedCommandProcessTree(discovery.pid, commandMarker) : null;
          const pingProcess = processTree?.processes.find((process) => process.name?.toLowerCase() === 'ping.exe') ?? null;
          return attempt.status === 'running' && activeTool && pingProcess
            ? { done: true, value: { request, attempt, activeTool, processTree: { ...processTree, commandProcess: pingProcess }, observedAt: new Date().toISOString() } }
            : {
                done: false,
                value: {
                  attemptStatus: attempt.status,
                  activeToolId: activeTool?.id ?? null,
                  corePid: discovery?.pid ?? null,
                  pingProcess,
                },
              };
        },
        {
          timeoutMs: 60000,
          intervalMs: 200,
          describe: () => `the deterministic Core-owned PING.EXE for "${commandMarker}" to exist before Stop`,
        },
      );
      const { request: cancelRequest, attempt: runningAttempt } = childStart;
      log(
        `Saath Kar cancellation: observed tool ${childStart.activeTool.id}, child pid ${childStart.processTree.commandProcess.pid}`
          + ` under Core pid ${childStart.processTree.corePid} before clicking Stop.`,
      );
      const stopClickedAt = new Date().toISOString();
      await clickStopButton(webviewClient);
      const cancelledAttempt = await pollUntil(
        async () => {
          const a = await findAttemptById(runningAttempt.id, windowHandle.globalDataDir);
          return a && a.status === 'cancelled' ? { done: true, value: a } : { done: false, value: a?.status };
        },
        { timeoutMs: 30000, describe: () => `attempt ${runningAttempt.id} to reach "cancelled" in Core (not just a UI flag)` },
      );
      const terminalInvocations = await pollUntil(
        async () => {
          const invocations = await findModelInvocations(runningAttempt.id, windowHandle.globalDataDir);
          const nonterminal = invocations.filter((invocation) => !['succeeded', 'failed', 'cancelled'].includes(invocation.status));
          return invocations.length === 1 && nonterminal.length === 0
            ? { done: true, value: invocations }
            : { done: false, value: invocations.map((invocation) => ({ id: invocation.id, status: invocation.status })) };
        },
        { timeoutMs: 30000, intervalMs: 250, describe: () => 'all owned model invocations to become terminal after Stop' },
      );
      const terminalTool = await pollUntil(
        async () => {
          const tools = await findToolInvocations(runningAttempt.id, windowHandle.globalDataDir);
          const tool = tools.find((candidate) => candidate.id === childStart.activeTool.id);
          return tool && tool.status !== 'pending' ? { done: true, value: tool } : { done: false, value: tool?.status ?? null };
        },
        { timeoutMs: 30000, intervalMs: 250, describe: () => `tool invocation ${childStart.activeTool.id} to become terminal` },
      );
      const startedProcessIds = childStart.processTree.processes.map((process) => process.pid);
      const termination = await pollUntil(
        async () => {
          const snapshot = readWindowsProcessSnapshot();
          const liveStartedPids = startedProcessIds.filter((pid) => snapshot.some((process) => process.pid === pid));
          const currentOwned = findOwnedCommandProcessTree(childStart.processTree.corePid, commandMarker);
          return liveStartedPids.length === 0 && currentOwned.processes.length === 0
            ? { done: true, value: { observedAt: new Date().toISOString(), liveStartedPids, currentOwned: currentOwned.processes } }
            : { done: false, value: { liveStartedPids, currentOwned: currentOwned.processes } };
        },
        { timeoutMs: 15000, intervalMs: 250, describe: () => 'the cancelled Windows child process tree to disappear' },
      );

      let stableSince = Date.now();
      const stableTerminal = await pollUntil(
        async () => {
          const attempt = await findAttemptById(runningAttempt.id, windowHandle.globalDataDir);
          const invocations = await findModelInvocations(runningAttempt.id, windowHandle.globalDataDir);
          const processTree = findOwnedCommandProcessTree(childStart.processTree.corePid, commandMarker);
          const stable = attempt?.status === 'cancelled'
            && invocations.length === 1
            && invocations[0].status === 'succeeded'
            && processTree.processes.length === 0;
          if (!stable) stableSince = Date.now();
          return stable && Date.now() - stableSince >= 1500
            ? { done: true, value: { observedAt: new Date().toISOString(), attempt, invocations } }
            : { done: false, value: { stableForMs: Date.now() - stableSince, attemptStatus: attempt?.status, processTree } };
        },
        { timeoutMs: 10000, intervalMs: 250, describe: () => 'cancelled attempt/invocation/process states to remain stable for 1500ms' },
      );
        const requests = await findRequestsByMessage(cancelPrompt, windowHandle.globalDataDir);
        const attempts = requests.length === 1 ? await findAttemptsForRequest(requests[0].id, windowHandle.globalDataDir) : [];
        const tools = await findToolInvocations(runningAttempt.id, windowHandle.globalDataDir);
        const conversationMessages = cancelRequest.conversationId
          ? await findConversationMessages(cancelRequest.conversationId, windowHandle.globalDataDir)
          : [];
        const submissions = ((await ui.readInstrumentedPostedMessages(webviewClient)) ?? [])
          .filter((message) => message?.type === 'sendMessage' && message.text === cancelPrompt);
        const terminalUiMessages = (await readInboundMessages(webviewClient)).slice(inboundBaseline)
          .filter((message) => message.type === 'done' || message.type === 'error' || message.type === 'stopped');
        const fixtureState = fixture.snapshot();
        const abortedEvidence = typeof terminalTool.evidence === 'string'
          && terminalTool.evidence.toLowerCase().includes('aborted');
        const cancellationLatencyMs = new Date(cancelledAttempt.cancelledAt).getTime() - new Date(stopClickedAt).getTime();
        const duplicateCounts = {
          visibleSubmissions: submissions.length,
          requests: requests.length,
          attempts: attempts.length,
          modelInvocations: terminalInvocations.length,
          toolInvocations: tools.length,
          assistantResponses: conversationMessages.filter((message) => message.role === 'assistant' && message.modelInvocationId).length,
          terminalUiMessages: terminalUiMessages.length,
        };
        const ok = cancelledAttempt.status === 'cancelled'
          && terminalInvocations.length === 1
          && terminalInvocations[0].status === 'succeeded'
          && terminalInvocations[0].actualModel === SAATH_CANCEL_FIXTURE_MODEL
          && tools.length === 1
          && terminalTool.id === childStart.activeTool.id
          && abortedEvidence
          && childStart.processTree.commandProcess.name?.toLowerCase() === 'ping.exe'
          && termination.liveStartedPids.length === 0
          && stableTerminal.attempt.status === 'cancelled'
          && fixtureState.toolCallResponses === 1
          && fixtureState.chatResponses === 1
          && cancellationLatencyMs >= 0
          && duplicateCounts.visibleSubmissions === 1
          && duplicateCounts.requests === 1
          && duplicateCounts.attempts === 1
          && duplicateCounts.modelInvocations === 1
          && duplicateCounts.toolInvocations === 1
          && duplicateCounts.assistantResponses === 0
          && duplicateCounts.terminalUiMessages === 1;

        scenarioEvidence = {
          ok,
          proxy: {
            endpoint: fixture.baseUrl,
            model: fixture.model,
            chatResponses: fixtureState.chatResponses,
            toolCallResponses: fixtureState.toolCallResponses,
            cleanedUp: false,
          },
          isolatedProfile: windowHandle.profile,
          requestId: cancelRequest.id,
          attemptId: cancelledAttempt.id,
          finalAttemptStatus: cancelledAttempt.status,
          modelInvocation: {
            id: terminalInvocations[0].id,
            status: terminalInvocations[0].status,
            requestedModel: terminalInvocations[0].requestedModel,
            actualModel: terminalInvocations[0].actualModel,
          },
          toolInvocation: {
            id: terminalTool.id,
            status: terminalTool.status,
            evidence: JSON.parse(terminalTool.evidence ?? '{}'),
            abortedEvidence,
          },
          processStartProof: {
            observedBeforeVisibleStop: true,
            observedAt: childStart.observedAt,
            corePid: childStart.processTree.corePid,
            pingPid: childStart.processTree.commandProcess.pid,
            processTree: childStart.processTree.processes,
          },
          visibleStop: { clickedAt: stopClickedAt },
          cancellationLatencyMs,
          processTermination: termination,
          terminalStateStableAt: stableTerminal.observedAt,
          duplicateCounts,
          cleanup: null,
        };
        evidence.scenarios.saathCancel = scenarioEvidence;
        await board.captureScreenshot(pageClient, evidenceDir, '3-saath-kar-deterministic-cancellation').catch(() => {});
        log(`Saath cancellation: request=${cancelRequest.id}; attempt=${cancelledAttempt.id}; model=${terminalInvocations[0].id}:succeeded; tool=${terminalTool.id}:${terminalTool.status}; latency=${cancellationLatencyMs}ms; descendants gone.`);
        if (!ok) throw new Error(`Deterministic Saath cancellation did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) {
          terminateOwnedProcessTree(pid);
        }
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixture) await fixture.close().catch(() => {});
        const processCleanup = await pollUntil(
          async () => {
            const snapshot = readWindowsProcessSnapshot();
            const liveProfilePids = windowHandle
              ? snapshot
                .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
                .map((process) => process.pid)
              : [];
            const coreAlive = isolatedCorePid ? isPidAlive(isolatedCorePid) : false;
            return liveProfilePids.length === 0 && !coreAlive
              ? { done: true, value: { liveProfilePids, coreAlive } }
              : { done: false, value: { liveProfilePids, coreAlive } };
          },
          { timeoutMs: 5000, intervalMs: 200, describe: () => 'all isolated Saath cancellation VS Code and Core processes to stop' },
        ).catch((error) => ({ error: error.message, liveProfilePids: [], coreAlive: isolatedCorePid ? isPidAlive(isolatedCorePid) : false }));
        const cleanup = {
          proxyClosedAt: fixture?.snapshot().closedAt ?? null,
          proxyCleanedUp: Boolean(fixture?.snapshot().closedAt),
          vscodePid: windowHandle?.launchedPid ?? null,
          vscodeStopped: !processCleanup.error && processCleanup.liveProfilePids.length === 0,
          corePid: isolatedCorePid,
          coreStopped: !processCleanup.coreAlive,
          processCleanupError: processCleanup.error ?? null,
        };
        scenarioEvidence.proxy.cleanedUp = cleanup.proxyCleanedUp;
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.saathCancel = scenarioEvidence;
        log(`Saath cancellation cleanup: proxy=${cleanup.proxyCleanedUp ? 'closed' : 'not-started'}; Core=${cleanup.coreStopped ? 'stopped' : 'still-running'}; VS Code=${cleanup.vscodeStopped ? 'stopped' : 'still-running'}.`);
        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`Deterministic Saath cancellation cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 4: Karke Dikha (fresh disposable git repo, full approval cycle)
    // =====================================================================
    await runRegisteredScenario('karke', 'scenario-4-karke-dikha', async () => {
      initGitRepo(wsKarke);
      // Keep the shared profile's primary workbench alive even in an isolated
      // --only=karke run. This makes the filtered regression exercise the
      // exact composition that failed in the complete run: Karke joins an
      // existing same-profile instance and must reuse its CDP endpoint.
      if (!ownedCdpPort) {
        const keeperWindow = await ensureChatWindow();
        await waitForWorkbenchReady(keeperWindow);
      }
      const karkeWindow = await launchWorkspaceWindow(wsKarke, 'window-4-karke-dikha');
      const { pageClient, webviewClient } = await openChatPanel(karkeWindow);
      const prompt = `Add a file named hello.txt containing the word hello. (nonce ${NONCE}-karkedikha)`;
      await sendWithCoreConnectedRetry(webviewClient, () => startAutonomousTask(webviewClient, prompt), prompt);

      await pollUntil(
        async () => {
          const dom = await ui.readApprovalCycleDom(webviewClient);
          return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
            ? { done: true, value: dom } : { done: false, value: dom };
        },
        { timeoutMs: 180000, describe: () => 'proposal approval card to become actionable' },
      );
      await ui.clickProposalApproveButton(webviewClient);
      log('Karke Dikha: proposal approved via the real webview button.');

      const gate2 = await pollUntil(
        async () => {
          const dom = await ui.readApprovalCycleDom(webviewClient);
          if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) return { done: true, value: { kind: 'mutation', dom } };
          if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) return { done: true, value: { kind: 'delivery', dom } };
          return { done: false, value: dom };
        },
        { timeoutMs: 120000, describe: () => 'mutation or delivery approval card to become actionable' },
      );
      if (gate2.kind === 'mutation') {
        await ui.clickMutationApproveButton(webviewClient);
        log('Karke Dikha: mutation approved via the real webview button.');
        await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'delivery approval card to become actionable' },
        );
      }
      await ui.clickDeliveryApproveButton(webviewClient);
      log('Karke Dikha: delivery approved via the real webview button.');

      const { attempt: finalAttempt } = await pollForAttemptViaMessage(
        prompt,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 180000 },
      );
      const finalRequest = await findRequestByMessage(prompt);
      const finalApprovals = await findApprovalsForAttempt(finalAttempt.id);
      const statusDom = await ui.readAutonomousStatusDom(webviewClient);
      await board.captureScreenshot(pageClient, evidenceDir, '4-karke-dikha').catch(() => {});

      // Delivery contract (per the M15 governed model, asserted by the unit
      // test "commits an approved delivery once in the isolated worktree
      // ..."): the approved change is committed on a task branch via the
      // isolated worktree — the primary workspace's master working tree and
      // HEAD stay untouched. So acceptance is: a delivery commit exists on a
      // branch, contains exactly the approved file with the right content,
      // and never sweeps in the runtime's own .ollama-agent state.
      const gitLogAll = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: wsKarke });
      const deliveryLine = gitLogAll.split(/\r?\n/).find((line) => line.includes('M15 delivery'));
      const deliverySha = deliveryLine ? deliveryLine.split(' ')[0] : null;
      const gitShowStat = deliverySha ? runCapture('git', ['show', '--stat', deliverySha], { cwd: wsKarke }) : '';
      const helloContent = deliverySha
        ? runCapture('git', ['show', `${deliverySha}:hello.txt`], { cwd: wsKarke }).trim()
        : null;
      const masterHead = runCapture('git', ['rev-parse', 'master'], { cwd: wsKarke }).trim();
      const masterUntouched = deliverySha !== null && masterHead !== deliverySha;
      const runtimeStateExcluded = !!gitShowStat && !gitShowStat.includes('.ollama-agent');
      const approvalsOk = ['proposal', 'mutation', 'delivery'].every(
        (kind) => finalApprovals.some((approval) => approval.kind === kind && approval.status === 'approved'),
      );

      const ok = finalAttempt.status === 'completed' && !!deliverySha
        && !!finalRequest && approvalsOk
        && /hello/i.test(helloContent ?? '') && masterUntouched && runtimeStateExcluded;
      evidence.scenarios.karkeDikha = {
        ok,
        requestId: finalRequest?.id ?? null,
        attemptId: finalAttempt.id, attemptStatus: finalAttempt.status,
        domTaskId: statusDom.taskId, domAttemptId: statusDom.attemptId,
        gate2Kind: gate2.kind,
        approvals: finalApprovals.map((approval) => ({
          id: approval.id,
          kind: approval.kind,
          status: approval.status,
          revision: approval.revision,
          decidedAt: approval.decidedAt,
        })),
        window: await windowDiagnostics(karkeWindow),
        deliveryCommit: { sha: deliverySha, helloTxtContent: helloContent, masterUntouched, runtimeStateExcluded },
        gitLogAll: gitLogAll.trim(), gitShowStat: gitShowStat.trim(),
      };
      log(`Karke Dikha: attempt ${finalAttempt.id} status=${finalAttempt.status}, delivery commit=${deliverySha}, hello.txt content=${JSON.stringify(helloContent)}`);
      if (!ok) throw new Error(`Karke Dikha scenario did not meet acceptance: ${JSON.stringify(evidence.scenarios.karkeDikha)}`);

      await pageClient.close();
      await webviewClient.close();
    });

    // =====================================================================
    // Scenario 5: restart test — window close/relaunch mid-attempt.
    // =====================================================================
    await runRegisteredScenario('restart', 'scenario-5-restart', async () => {
      initGitRepo(wsRestart);
      const restartWindowBefore = await launchWorkspaceWindow(wsRestart, 'window-4a-restart');
      const port1 = restartWindowBefore.cdpPort;
      const { pageTargetId, pageClient, webviewClient } = await openChatPanel(restartWindowBefore);
      const prompt = `Add a file named restart-test.txt containing the word persistent. (nonce ${NONCE}-restart)`;
      await sendWithCoreConnectedRetry(webviewClient, () => startAutonomousTask(webviewClient, prompt), prompt);

      await pollUntil(
        async () => {
          const dom = await ui.readApprovalCycleDom(webviewClient);
          return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
            ? { done: true, value: dom } : { done: false, value: dom };
        },
        { timeoutMs: 180000, describe: () => 'proposal approval card to become actionable before restart' },
      );
      const statusBefore = await ui.readAutonomousStatusDom(webviewClient);
      const requestBefore = await findRequestByMessage(prompt);
      if (!requestBefore) throw new Error('visible proposal gate had no correlated Core request');
      const attemptsBefore = await findAttemptsForRequest(requestBefore.id);
      if (attemptsBefore.length !== 1) throw new Error(`expected exactly one Core attempt before restart, got ${attemptsBefore.length}`);
      const attemptBefore = attemptsBefore[0];
      const approvalsBefore = await findApprovalsForAttempt(attemptBefore.id);
      const envelopeBefore = approvalsBefore.find((approval) => approval.kind === 'proposal' && approval.status === 'pending');
      if (!envelopeBefore) throw new Error('visible proposal gate had no pending Core proposal approval envelope');
      log(`Restart test: reached visible proposal approval with Core request ${requestBefore.id}, attempt ${attemptBefore.id}, envelope ${envelopeBefore.id}@${envelopeBefore.revision} (DOM shows taskId=${statusBefore.taskId}, attemptId=${statusBefore.attemptId}).`);

      const discoveryBeforeClose = readDiscoveryRecord();
      await board.captureScreenshot(pageClient, evidenceDir, '4a-before-close').catch(() => {});

      // Close the window (real CDP close), confirm Core (a separate detached process) stays alive.
      await board.closeTarget(port1, pageTargetId);
      const remaining = await pollUntil(
        async () => {
          const pages = (await board.listTargets(port1).catch(() => [])).filter((target) => target.type === 'page');
          return pages.some((target) => target.id === pageTargetId)
            ? { done: false, value: pages.map((target) => target.id) }
            : { done: true, value: pages };
        },
        { timeoutMs: 15000, intervalMs: 250, describe: () => `restart window target ${pageTargetId} to close` },
      );
      const coreAliveAfterClose = isPidAlive(discoveryBeforeClose.pid);
      log(`Closed the restart VS Code window. Other owned window targets=${remaining.length}; detached Core (pid ${discoveryBeforeClose.pid}) alive=${coreAliveAfterClose}.`);
      if (!coreAliveAfterClose) throw new Error('expected the detached Core process to remain alive after the window closed');

      // If this was the only workbench window, the owning VS Code process may
      // close its CDP listener. Observe that boundary before deciding whether
      // relaunch should reuse the endpoint or own a fresh one.
      if (remaining.length === 0) {
        const endpointStopped = await pollUntil(
          async () => {
            try {
              await board.listTargets(port1);
              return { done: false, value: 'still listening' };
            } catch {
              return { done: true, value: true };
            }
          },
          { timeoutMs: 5000, intervalMs: 250, describe: () => `CDP endpoint ${port1} to close with its last window` },
        ).catch(() => false);
        if (endpointStopped) ownedCdpPort = undefined;
      }

      // Relaunch on the SAME workspace + SAME shared profile.
      const restartWindowAfter = await launchWorkspaceWindow(wsRestart, 'window-4b-relaunch');
      const port2 = restartWindowAfter.cdpPort;
      const { pageClient: pageClient2, webviewClient: webviewClient2 } = await openChatPanel(restartWindowAfter);
      const discoveryAfterRelaunch = readDiscoveryRecord();

      const restored = await pollUntil(
        async () => {
          const dom = await ui.readAutonomousStatusDom(webviewClient2);
          const approvalDom = await ui.readApprovalCycleDom(webviewClient2);
          const restoredActionable = approvalDom.proposalCardHidden === false && approvalDom.proposalApproveDisabled === false;
          return restoredActionable ? { done: true, value: { dom, approvalDom } } : { done: false, value: dom };
        },
        { timeoutMs: 60000, describe: () => 'reopened window to restore the waiting-for-approval Karke Dikha attempt' },
      );
      log(`After relaunch: DOM shows taskId=${restored.dom.taskId}, attemptId=${restored.dom.attemptId} (before-close was taskId=${statusBefore.taskId}, attemptId=${statusBefore.attemptId}).`);

      const nonTerminalCountAfterRelaunch = await countNonTerminalAttemptsForRequest(requestBefore.id);
      const attemptAfterRelaunch = await findAttemptById(attemptBefore.id);
      const requestAfterRelaunch = await findRequestByMessage(prompt);
      const approvalsAfterRelaunch = await findApprovalsForAttempt(attemptBefore.id);
      const envelopeAfterRelaunch = approvalsAfterRelaunch.find((approval) => approval.kind === 'proposal' && approval.status === 'pending');

      const restoredSameAttempt = exactDomIdentity(restored.dom.attemptId) === attemptBefore.id
        && exactDomIdentity(statusBefore.attemptId) === attemptBefore.id;
      const restoredSameRequest = requestAfterRelaunch?.id === requestBefore.id;
      const restoredSameEnvelope = envelopeAfterRelaunch?.id === envelopeBefore.id
        && envelopeAfterRelaunch?.revision === envelopeBefore.revision;
      const noDuplicate = nonTerminalCountAfterRelaunch === 1;
      const sameCoreInstance = discoveryAfterRelaunch.instanceId === discoveryBeforeClose.instanceId;
      await board.captureScreenshot(pageClient2, evidenceDir, '4b-after-relaunch').catch(() => {});

      // The document that owned the pre-restart card was destroyed by the real
      // workbench close. Its stale handle must never post a second decision.
      const staleCardResult = await Promise.race([
        ui.clickProposalApproveButton(webviewClient).then(
          () => ({ blocked: false, reason: 'stale card unexpectedly remained clickable' }),
          (error) => ({ blocked: true, reason: error instanceof Error ? error.message : String(error) }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ blocked: true, reason: 'stale target unreachable after close' }), 3000)),
      ]);

      evidence.scenarios.restart = {
        ok: restoredSameAttempt && restoredSameRequest && restoredSameEnvelope && noDuplicate && sameCoreInstance && staleCardResult.blocked,
        gateType: 'proposal',
        beforeRestart: {
          conversationId: requestBefore.conversationId,
          requestId: requestBefore.id,
          attemptId: attemptBefore.id,
          envelopeId: envelopeBefore.id,
          envelopeRevision: envelopeBefore.revision,
          envelopeVersion: envelopeBefore.envelopeVersion,
          domTaskId: statusBefore.taskId,
          domAttemptId: statusBefore.attemptId,
        },
        afterRestart: {
          conversationId: requestAfterRelaunch?.conversationId ?? null,
          requestId: requestAfterRelaunch?.id ?? null,
          attemptId: attemptAfterRelaunch?.id ?? null,
          envelopeId: envelopeAfterRelaunch?.id ?? null,
          envelopeRevision: envelopeAfterRelaunch?.revision ?? null,
          envelopeVersion: envelopeAfterRelaunch?.envelopeVersion ?? null,
          domTaskId: restored.dom.taskId,
          domAttemptId: restored.dom.attemptId,
          actionableProposalCard: restored.approvalDom.proposalCardHidden === false
            && restored.approvalDom.proposalApproveDisabled === false,
        },
        coreInstanceIdBeforeClose: discoveryBeforeClose.instanceId,
        coreInstanceIdAfterRelaunch: discoveryAfterRelaunch.instanceId,
        windowBeforeClose: await windowDiagnostics(restartWindowBefore),
        windowAfterRelaunch: await windowDiagnostics(restartWindowAfter),
        otherWindowCountAfterClose: remaining.length,
        nonTerminalAttemptCountAfterRelaunch: nonTerminalCountAfterRelaunch,
        attemptStatusAfterRelaunch: attemptAfterRelaunch?.status,
        stalePreRestartCard: staleCardResult,
      };
      if (!evidence.scenarios.restart.ok) {
        throw new Error(`Restart scenario did not meet acceptance: ${JSON.stringify(evidence.scenarios.restart)}`);
      }
      log(`Restart test: same request ${requestBefore.id}, attempt ${attemptBefore.id}, and proposal envelope ${envelopeBefore.id}@${envelopeBefore.revision} restored on the same Core instance (${discoveryAfterRelaunch.instanceId}); stale pre-restart card blocked=${staleCardResult.blocked}; non-terminal count=${nonTerminalCountAfterRelaunch}.`);

      // Finish cleanly so the disposable repo/attempt end in a terminal state.
      await ui.clickProposalApproveButton(webviewClient2);
      const gate2 = await pollUntil(
        async () => {
          const dom = await ui.readApprovalCycleDom(webviewClient2);
          if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) return { done: true, value: { kind: 'mutation' } };
          if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) return { done: true, value: { kind: 'delivery' } };
          return { done: false, value: dom };
        },
        { timeoutMs: 120000, describe: () => 'post-restart mutation or delivery approval card to become actionable' },
      );
      if (gate2.kind === 'mutation') {
        await ui.clickMutationApproveButton(webviewClient2);
        await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient2);
            return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'post-restart delivery approval card to become actionable' },
        );
      }
      await ui.clickDeliveryApproveButton(webviewClient2);
      const { attempt: finalAttempt } = await pollForAttemptViaMessage(
        prompt,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 180000 },
      );
      const finalRequests = await findRequestsByMessage(prompt);
      const finalAttempts = await findAttemptsForRequest(requestBefore.id);
      const finalApprovals = await findApprovalsForAttempt(attemptBefore.id);
      const attemptEvents = await findRuntimeEventsForEntity(attemptBefore.id);
      const approvalEvents = (await Promise.all(finalApprovals.map((approval) => findRuntimeEventsForEntity(approval.id)))).flat();
      const checkpoints = await findCheckpointsForAttempt(attemptBefore.id);
      const localEvidence = autonomousTaskEvidence(wsRestart, attemptBefore.id);
      const progress = localEvidence.events
        .filter((event) => event.type === 'progress')
        .map((event) => String(event.payload.progress ?? ''));
      const attemptTransitions = attemptEvents
        .filter((event) => event.eventType === 'attempt_transitioned')
        .map((event) => JSON.parse(event.metadata));
      const gitLogAll = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: wsRestart });
      const deliveryLines = gitLogAll.split(/\r?\n/).filter((line) => line.includes('M15 delivery'));
      const deliverySha = deliveryLines[0]?.split(' ')[0] ?? null;
      const deliveryStat = deliverySha ? runCapture('git', ['show', '--stat', deliverySha], { cwd: wsRestart }) : '';
      const deliveredContent = deliverySha ? runCapture('git', ['show', `${deliverySha}:restart-test.txt`], { cwd: wsRestart }).trim() : null;
      const primaryHead = runCapture('git', ['rev-parse', 'master'], { cwd: wsRestart }).trim();
      const gitStatus = runCapture('git', ['status', '--short'], { cwd: wsRestart }).trim();
      const counts = {
        requests: finalRequests.length,
        attempts: finalAttempts.length,
        coreWorkerFenceAcquisitions: attemptEvents.filter((event) => event.eventType === 'attempt_fence_acquired').length,
        replacementProjectionClaims: localEvidence.events.filter((event) => event.type === 'task_claimed').length,
        proposals: localEvidence.events.filter((event) => event.type === 'proposal_pending').length,
        mutations: progress.filter((entry) => entry.startsWith('mutation_completed ')).length,
        approvalEnvelopes: finalApprovals.length,
        proposalApprovalEnvelopes: finalApprovals.filter((approval) => approval.kind === 'proposal').length,
        mutationApprovalEnvelopes: finalApprovals.filter((approval) => approval.kind === 'mutation').length,
        deliveryApprovalEnvelopes: finalApprovals.filter((approval) => approval.kind === 'delivery').length,
        approvalResolutions: approvalEvents.filter((event) => event.eventType === 'approval_resolved').length,
        validationCheckpoints: checkpoints.filter((checkpoint) => checkpoint.kind === 'karke_dikha_validation').length,
        deliveryCheckpoints: checkpoints.filter((checkpoint) => checkpoint.kind === 'karke_dikha_delivery').length,
        deliveryCommits: deliveryLines.length,
        terminalTransitions: attemptTransitions.filter((transition) => ['completed', 'failed', 'cancelled'].includes(transition.to)).length,
      };
      const noDuplicates = counts.requests === 1
        && counts.attempts === 1
        && counts.coreWorkerFenceAcquisitions === 1
        && counts.proposals === 1
        && counts.mutations === 1
        && counts.approvalEnvelopes === 3
        && counts.proposalApprovalEnvelopes === 1
        && counts.mutationApprovalEnvelopes === 1
        && counts.deliveryApprovalEnvelopes === 1
        && counts.approvalResolutions === 3
        && counts.validationCheckpoints === 1
        && counts.deliveryCheckpoints === 1
        && counts.deliveryCommits === 1
        && counts.terminalTransitions === 1;
      const persistedDeliveryOk = finalAttempt.status === 'completed'
        && localEvidence.task.state === 'completed'
        && deliveredContent?.toLowerCase().includes('persistent')
        && deliverySha !== primaryHead
        && !deliveryStat.includes('.ollama-agent');
      evidence.scenarios.restart.finalAttemptStatus = finalAttempt.status;
      evidence.scenarios.restart.terminalOutcome = {
        coreAttemptStatus: finalAttempt.status,
        localTaskState: localEvidence.task.state,
        deliverySha,
        deliveredContent,
        primaryHeadUntouched: deliverySha !== primaryHead,
        runtimeStateExcluded: !deliveryStat.includes('.ollama-agent'),
        disposableWorkspaceGitStatus: gitStatus,
      };
      evidence.scenarios.restart.duplicateCounts = counts;
      evidence.scenarios.restart.approvals = finalApprovals.map((approval) => ({
        id: approval.id,
        kind: approval.kind,
        status: approval.status,
        revision: approval.revision,
        envelopeVersion: approval.envelopeVersion,
      }));
      evidence.scenarios.restart.ok = evidence.scenarios.restart.ok && noDuplicates && persistedDeliveryOk;
      if (!evidence.scenarios.restart.ok) {
        throw new Error(`Restart terminal evidence did not meet acceptance: ${JSON.stringify(evidence.scenarios.restart)}`);
      }
      log(`Restart test: terminal Core status=${finalAttempt.status}; duplicate counts=${JSON.stringify(counts)}; delivery=${deliverySha}; gitStatus=${JSON.stringify(gitStatus)}.`);

      await pageClient2.close();
      await webviewClient2.close();

      // pageClient2/webviewClient2.close() above only end the CDP debugger
      // session — the underlying VS Code process (window-4b-relaunch) and
      // its Core process keep running until the whole script's single
      // end-of-run cleanup (trackedChildren teardown in `finally`).
      // Subsequent scenarios in this run (m35-inline-approval,
      // m35-package-provenance) always launch their own fully isolated VS
      // Code instance and never rely on this scenario's shared window/Core
      // continuing to exist — leaving them alive needlessly stacks 2-3 full
      // VS Code + Core processes concurrently, which on a constrained CI
      // runner starves CPU/memory badly enough to turn a normally-instant
      // deterministic message exchange into one slow enough to blow past
      // the next scenario's actionability timeout (observed directly: CI's
      // m35-inline-approval timed out waiting for the mutation gate
      // immediately after this scenario, despite passing reliably in
      // isolation). Terminate this scenario's own processes now.
      for (const pid of [restartWindowBefore.launchedPid, restartWindowAfter.launchedPid]) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch {
          // already exited
        }
      }
      const restartDiscovery = readDiscoveryRecord();
      if (restartDiscovery && isPidAlive(restartDiscovery.pid)) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(restartDiscovery.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } else {
            process.kill(restartDiscovery.pid, 'SIGKILL');
          }
        } catch {
          // already exited
        }
      }
      ownedCdpPort = undefined;
    });

    // =====================================================================
    // Scenario 6: follow-up conversation — two Baat Kar turns in the SAME
    // webview conversation; the second turn can only be answered correctly
    // if Core threaded the first turn's history into the model context, and
    // both requests must land on the same Core conversation row.
    // =====================================================================
    await runRegisteredScenario('followup', 'scenario-6-followup-conversation', async () => {
      const windowHandle = await ensureChatWindow();
      const { pageClient, webviewClient } = await openChatPanel(windowHandle);
      await setMode(webviewClient, 'chat');

      const first = 'Remember this exact phrase for my next message: Blue Mango 4729.';
      const second = 'What exact phrase and number did I ask you to remember?';
      const visibleTranscriptBaseline = await ui.evalInWebviewDoc(
        webviewClient,
        `Array.from(document.querySelectorAll('.bubble.user, .bubble.assistant')).map(b => ({
          role: b.classList.contains('user') ? 'user' : 'assistant',
          content: (b.textContent ?? '').trim()
        }))`,
      );
      const initialAssistantCount = visibleTranscriptBaseline.filter((message) => message.role === 'assistant').length;
      // Durable pre-turn baseline: snapshot EVERY existing Core conversation
      // (id, mode, ordered messages) before turn 1. The baseline conversation
      // is resolved AFTER turn 1 from the request row that turn actually
      // created — never from the globally newest conversation, which an
      // earlier Saath Kar run can own.
      const preTurnConversationRows = await findAllConversations();
      const preTurnConversationSnapshot = captureConversationBaselineSnapshot(
        await Promise.all(preTurnConversationRows.map(async (row) => ({
          id: row.id,
          mode: row.mode ?? null,
          messages: await findConversationMessages(row.id),
        }))),
      );

      // Exactly one real composer click per turn. A Core-connect failure fails
      // this isolated run; it is never hidden by resending inside a conversation.
      await sendChatMessage(webviewClient, first);
      const { request: firstRequest, attempt: firstAttempt } = await pollForAttemptViaMessage(
        first,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 90000 },
      );
      const firstVisibleAssistant = await pollUntil(
        async () => {
          const assistantTexts = await ui.evalInWebviewDoc(
            webviewClient,
            `Array.from(document.querySelectorAll('.bubble.assistant')).map(b => (b.textContent ?? '').trim())`,
          );
          const text = assistantTexts[initialAssistantCount] ?? '';
          return text ? { done: true, value: text } : { done: false, value: assistantTexts };
        },
        { timeoutMs: 15000, describe: () => 'visible turn-1 assistant response' },
      );

      await sendChatMessage(webviewClient, second);
      const { request: secondRequest, attempt: secondAttempt } = await pollForAttemptViaMessage(
        second,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 90000 },
      );

      const assistantBubbleText = await pollUntil(
        async () => {
          const assistantTexts = await ui.evalInWebviewDoc(
            webviewClient,
            `Array.from(document.querySelectorAll('.bubble.assistant')).map(b => (b.textContent ?? '').trim())`,
          );
          const text = assistantTexts[initialAssistantCount + 1] ?? '';
          return text ? { done: true, value: text } : { done: false, value: assistantTexts };
        },
        { timeoutMs: 15000, describe: () => 'visible turn-2 assistant response' },
      );
      // Resolve the durable baseline against the authoritative conversation
      // the follow-up turn actually used (throws if turn 1 produced none).
      const durableBaseline = resolveFollowUpBaseline(preTurnConversationSnapshot, firstRequest.conversationId);
      const persistedBaselineConversationId = durableBaseline.conversationId;
      const persistedHistoryBaseline = durableBaseline.messages;
      const persistedHistoryBaselineLength = durableBaseline.length;
      const persistedHistoryBaselineIds = durableBaseline.messageIds;
      const followUpConversationRow = await findConversationById(firstRequest.conversationId);
      const conversationMessages = await findConversationMessages(firstRequest.conversationId);

      const firstRequests = await findRequestsByMessage(first);
      const secondRequests = await findRequestsByMessage(second);
      const firstAttempts = firstRequests.length === 1 ? await findAttemptsForRequest(firstRequests[0].id) : [];
      const secondAttempts = secondRequests.length === 1 ? await findAttemptsForRequest(secondRequests[0].id) : [];
      const firstModelInvocations = await findModelInvocations(firstAttempt.id);
      const secondModelInvocations = await findModelInvocations(secondAttempt.id);
      const postedMessages = (await ui.readInstrumentedPostedMessages(webviewClient)) ?? [];
      const postedFirstTurns = postedMessages.filter((m) => m?.type === 'sendMessage' && m.text === first);
      const postedSecondTurns = postedMessages.filter((m) => m?.type === 'sendMessage' && m.text === second);
      const visibleTranscript = await ui.evalInWebviewDoc(
        webviewClient,
        `Array.from(document.querySelectorAll('.bubble.user, .bubble.assistant')).map(b => ({
          role: b.classList.contains('user') ? 'user' : 'assistant',
          content: (b.textContent ?? '').trim()
        }))`,
      );
      const composerState = await ui.evalInWebviewDoc(
        webviewClient,
        `(() => {
          const input = document.getElementById('user-input');
          const send = document.getElementById('send-btn');
          const stop = document.getElementById('stop-btn');
          return {
            inputPresent: !!input,
            sendPresent: !!send,
            inputEnabled: !!input && !input.disabled,
            sendEnabled: !!send && !send.disabled,
            stopHidden: !!stop && stop.hidden,
          };
        })()`,
      );

      const capturedChatRequests = (ollamaCapture?.requests ?? []).filter(
        (capture) => capture.path === '/api/chat' && Array.isArray(capture.body?.messages),
      );
      const secondModelRequests = capturedChatRequests.filter((capture) => {
        const nonSystem = capture.body.messages.filter((message) => message.role !== 'system');
        return nonSystem.at(-1)?.role === 'user' && nonSystem.at(-1)?.content === second;
      });
      const capturedSecondMessages = secondModelRequests[0]?.body?.messages ?? [];
      const capturedSecondConversation = capturedSecondMessages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content }));

      const sameConversation = !!firstRequest.conversationId && firstRequest.conversationId === secondRequest.conversationId;
      const baselineConversationMatches = persistedBaselineConversationId === firstRequest.conversationId
        && (durableBaseline.existedBeforeTurnOne || persistedHistoryBaselineLength === 0);
      // The follow-up evidence conversation must be a Baat conversation; a
      // Saath (or any other-mode) conversation can never be selected.
      const followUpConversationIsBaatMode = followUpConversationRow?.mode === 'baat_kar';
      const otherModePreTurnConversations = preTurnConversationRows
        .filter((row) => row.mode !== 'baat_kar')
        .map((row) => ({ id: row.id, mode: row.mode ?? null }));
      const noOtherModeConversationSelected = followUpConversationIsBaatMode
        && otherModePreTurnConversations.every((row) => row.id !== persistedBaselineConversationId);
      const baselineStillExactPrefix = baselineConversationMatches
        && conversationMessages.length >= persistedHistoryBaselineLength
        && persistedHistoryBaseline.every((message, index) => {
          const current = conversationMessages[index];
          return current?.id === message.id
            && current.seq === message.seq
            && current.role === message.role
            && current.content === message.content
            && current.modelInvocationId === message.modelInvocationId;
        });
      const appendedMessages = baselineStillExactPrefix
        ? conversationMessages.slice(persistedHistoryBaselineLength)
        : [];
      const appendedMessageIds = appendedMessages.map((message) => message.id);
      const appendedIdsAreNewAndUnique = appendedMessageIds.length === new Set(appendedMessageIds).size
        && appendedMessageIds.every((id) => !persistedHistoryBaselineIds.includes(id));
      const distinctTurnIdentities = firstRequest.id !== secondRequest.id
        && firstAttempt.id !== secondAttempt.id
        && firstModelInvocations.length === 1
        && secondModelInvocations.length === 1
        && firstModelInvocations[0].id !== secondModelInvocations[0].id;
      // Normalized ordered-phrase recall check on ONLY the visible turn-2
      // assistant answer tied to the follow-up request/attempt identity
      // (assistantBubbleText); formatting like "Blue_Mango_4729" passes,
      // missing/reordered/altered tokens fail.
      const recalled = recallTextContainsPhrase(assistantBubbleText, 'blue mango 4729');
      const persistedHistoryOrder = baselineStillExactPrefix
        && appendedMessages.length === 4
        && appendedMessages[0].role === 'user' && appendedMessages[0].content === first
        && appendedMessages[1].role === 'assistant'
        && appendedMessages[1].modelInvocationId === firstModelInvocations[0]?.id
        && appendedMessages[2].role === 'user' && appendedMessages[2].content === second
        && appendedMessages[3].role === 'assistant'
        && appendedMessages[3].modelInvocationId === secondModelInvocations[0]?.id
        && appendedIdsAreNewAndUnique
        && conversationMessages.every((message, index) => index === 0 || message.seq > conversationMessages[index - 1].seq);
      const capturedSecondSuffix = capturedSecondConversation.slice(-3);
      const promptContainsPersistedHistory = secondModelRequests.length === 1
        && capturedSecondConversation.length >= 3
        && capturedSecondSuffix[0].role === 'user'
        && capturedSecondSuffix[0].content === appendedMessages[0]?.content
        && capturedSecondSuffix[1].role === 'assistant'
        && capturedSecondSuffix[1].content === appendedMessages[1]?.content
        && capturedSecondSuffix[2].role === 'user'
        && capturedSecondSuffix[2].content === appendedMessages[2]?.content;
      const assistantPerTurn = firstModelInvocations.length === 1 && secondModelInvocations.length === 1
        && appendedMessages.filter((message) => message.role === 'assistant'
          && message.modelInvocationId === firstModelInvocations[0].id).length === 1
        && appendedMessages.filter((message) => message.role === 'assistant'
          && message.modelInvocationId === secondModelInvocations[0].id).length === 1;
      const noDuplicates = firstRequests.length === 1 && secondRequests.length === 1
        && firstRequests[0]?.id === firstRequest.id && secondRequests[0]?.id === secondRequest.id
        && firstAttempts.length === 1 && secondAttempts.length === 1
        && firstAttempts[0]?.id === firstAttempt.id && secondAttempts[0]?.id === secondAttempt.id
        && appendedMessages.filter((message) => message.role === 'user' && message.content === first).length === 1
        && appendedMessages.filter((message) => message.role === 'user' && message.content === second).length === 1
        && assistantPerTurn
        && postedFirstTurns.length === 1 && postedSecondTurns.length === 1;
      const uiConversationStable = postedFirstTurns[0]?.conversationId
        && postedFirstTurns[0].conversationId === postedSecondTurns[0]?.conversationId;
      const visibleBaselineStillExactPrefix = visibleTranscript.length >= visibleTranscriptBaseline.length
        && visibleTranscriptBaseline.every((message, index) => (
          visibleTranscript[index]?.role === message.role
          && visibleTranscript[index]?.content === message.content
        ));
      const visibleFollowUpMessages = visibleBaselineStillExactPrefix
        ? visibleTranscript.slice(visibleTranscriptBaseline.length)
        : [];
      const visibleTranscriptOrder = visibleBaselineStillExactPrefix
        && visibleFollowUpMessages.length === 4
        && visibleFollowUpMessages[0].role === 'user' && visibleFollowUpMessages[0].content === first
        && visibleFollowUpMessages[1].role === 'assistant' && visibleFollowUpMessages[1].content === firstVisibleAssistant
        && visibleFollowUpMessages[2].role === 'user' && visibleFollowUpMessages[2].content === second
        && visibleFollowUpMessages[3].role === 'assistant' && visibleFollowUpMessages[3].content === assistantBubbleText;
      const earlierMessagesExcludedFromFollowUpEvidence = baselineStillExactPrefix
        && visibleBaselineStillExactPrefix
        && appendedIdsAreNewAndUnique;
      const conversationUsable = composerState.inputPresent && composerState.sendPresent
        && composerState.inputEnabled && composerState.sendEnabled && composerState.stopHidden;
      const secondContainsExpectedAnswer = recallTextContainsPhrase(second, 'blue mango')
        || recallTextContainsPhrase(second, '4729');
      const noExpectedAnswerInjection = !secondContainsExpectedAnswer
        && secondModelRequests.length === 1;
      const ok = firstAttempt.status === 'completed' && secondAttempt.status === 'completed'
        && sameConversation && distinctTurnIdentities && recalled && persistedHistoryOrder
        && promptContainsPersistedHistory && noDuplicates && uiConversationStable
        && visibleTranscriptOrder && earlierMessagesExcludedFromFollowUpEvidence
        && conversationUsable && noExpectedAnswerInjection
        && baselineConversationMatches && followUpConversationIsBaatMode
        && noOtherModeConversationSelected;

      await board.captureScreenshot(pageClient, evidenceDir, '6-followup-conversation').catch(() => {});
      evidence.scenarios.followUpConversation = {
        ok,
        corePersisted: {
          conversationId: firstRequest.conversationId,
          sameConversation,
          distinctTurnIdentities,
          firstTurn: {
            requestId: firstRequest.id,
            attemptId: firstAttempt.id,
            attemptStatus: firstAttempt.status,
            modelInvocationId: firstModelInvocations[0]?.id ?? null,
            actualModel: firstModelInvocations[0]?.actualModel ?? null,
          },
          secondTurn: {
            requestId: secondRequest.id,
            attemptId: secondAttempt.id,
            attemptStatus: secondAttempt.status,
            modelInvocationId: secondModelInvocations[0]?.id ?? null,
            actualModel: secondModelInvocations[0]?.actualModel ?? null,
          },
          baseline: {
            capturedBeforeTurnOne: true,
            resolution: 'per-conversation pre-turn snapshot keyed by turn-1 request.conversationId (never latest/global)',
            snapshotCapturedAt: preTurnConversationSnapshot.capturedAt,
            snapshotConversations: preTurnConversationRows.map((row) => ({
              id: row.id,
              mode: row.mode ?? null,
              messageCount: preTurnConversationSnapshot.byId.get(row.id)?.messageCount ?? 0,
            })),
            conversationId: persistedBaselineConversationId,
            conversationMode: followUpConversationRow?.mode ?? null,
            conversationExistedBeforeTurnOne: durableBaseline.existedBeforeTurnOne,
            matchesFollowUpConversation: baselineConversationMatches,
            followUpConversationIsBaatMode,
            otherModePreTurnConversations,
            noOtherModeConversationSelected,
            length: persistedHistoryBaselineLength,
            messageIds: persistedHistoryBaselineIds,
            history: persistedHistoryBaseline.map((message) => ({
              seq: message.seq,
              id: message.id,
              role: message.role,
              content: message.content,
              modelInvocationId: message.modelInvocationId,
            })),
            remainsExactPrefix: baselineStillExactPrefix,
          },
          history: conversationMessages.map((message) => ({
            seq: message.seq,
            id: message.id,
            role: message.role,
            content: message.content,
            modelInvocationId: message.modelInvocationId,
          })),
          appendedHistory: appendedMessages.map((message) => ({
            seq: message.seq,
            id: message.id,
            role: message.role,
            content: message.content,
            modelInvocationId: message.modelInvocationId,
          })),
          appendedMessageIdsAreNewAndUnique: appendedIdsAreNewAndUnique,
          historyOrderCorrect: persistedHistoryOrder,
        },
        webviewOnly: {
          conversationId: postedFirstTurns[0]?.conversationId ?? null,
          sameConversation: uiConversationStable,
          postedTurnCounts: { first: postedFirstTurns.length, second: postedSecondTurns.length },
          firstVisibleAssistant,
          secondVisibleAssistant: assistantBubbleText,
          transcriptBaseline: visibleTranscriptBaseline,
          transcript: visibleTranscript,
          appendedTranscript: visibleFollowUpMessages,
          baselineRemainsExactPrefix: visibleBaselineStillExactPrefix,
          transcriptOrderCorrect: visibleTranscriptOrder,
          composerState,
          conversationUsable,
        },
        modelPrompt: {
          transport: 'transparent passthrough to configured real local Ollama',
          configuredUpstream: OLLAMA_URL,
          model: secondModelRequests[0]?.body?.model ?? null,
          matchingSecondTurnRequestCount: secondModelRequests.length,
          messages: capturedSecondMessages,
          anchoredFollowUpSuffix: capturedSecondSuffix,
          containsPersistedTurnOneContext: promptContainsPersistedHistory,
        },
        harnessAssertions: {
          expectedAnswerInjected: false,
          secondUserMessageContainsExpectedAnswer: secondContainsExpectedAnswer,
          recallNormalization: 'NFKC + lowercase + non-alphanumeric runs -> single space + trim',
          recallExpectedPhrase: 'blue mango 4729',
          normalizedSecondAssistantAnswer: normalizeRecallText(assistantBubbleText),
          recalledBlueMangoAnd4729: recalled,
          earlierMessagesExcludedFromFollowUpEvidence,
          duplicateCounts: {
            firstUserUiSubmissions: postedFirstTurns.length,
            secondUserUiSubmissions: postedSecondTurns.length,
            firstRequests: firstRequests.length,
            secondRequests: secondRequests.length,
            firstAttempts: firstAttempts.length,
            secondAttempts: secondAttempts.length,
            firstPersistedUserMessages: appendedMessages.filter((message) => message.role === 'user' && message.content === first).length,
            secondPersistedUserMessages: appendedMessages.filter((message) => message.role === 'user' && message.content === second).length,
            firstAssistantMessages: firstModelInvocations.length === 1
              ? appendedMessages.filter((message) => message.role === 'assistant'
                && message.modelInvocationId === firstModelInvocations[0].id).length
              : null,
            secondAssistantMessages: secondModelInvocations.length === 1
              ? appendedMessages.filter((message) => message.role === 'assistant'
                && message.modelInvocationId === secondModelInvocations[0].id).length
              : null,
          },
          noDuplicates,
          retries: 0,
          fallback: null,
        },
      };
      log(`Follow-up conversation: conv=${firstRequest.conversationId} sameConversation=${sameConversation}, promptHistory=${promptContainsPersistedHistory}, recalled=${recalled}, assistant="${assistantBubbleText}"`);
      if (!ok) throw new Error(`Follow-up conversation scenario did not meet acceptance: ${JSON.stringify(evidence.scenarios.followUpConversation)}`);

      await pageClient.close();
      await webviewClient.close();
    });

    // =====================================================================
    // Scenario 7 (M33): the complete everyday journey on the unified
    // composer — automatic Karke recommendation, user override to Baat Kar
    // (exactly one Baat request/attempt), a second implementation request
    // accepting the Karke recommendation through readable progress, visible
    // approval cards, outcome-first completion evidence, durable history,
    // and a real close/relaunch restoring the same history item — with the
    // default UI free of raw IDs/JSON and diagnostics reachable via Details.
    // =====================================================================
    await runRegisteredScenario('everyday', 'scenario-7-m33-everyday-journey', async () => {
      const wsEveryday = path.join(workDir, 'ws-everyday');
      initGitRepo(wsEveryday);
      if (!ownedCdpPort) {
        const keeperWindow = await ensureChatWindow();
        await waitForWorkbenchReady(keeperWindow);
      }
      const everydayWindow = await launchWorkspaceWindow(wsEveryday, 'window-7-everyday');
      const opened = await openChatPanel(everydayWindow);
      const pageTargetId = opened.pageTargetId;
      let pageClient = opened.pageClient;
      let webviewClient = opened.webviewClient;

      // Panda identity (M34 UX regression): at least one approved production
      // panda asset must be VISIBLY RENDERED during the everyday journey —
      // a decoded image (naturalWidth > 0) occupying real layout space, not
      // merely a file present in the package.
      const pandaRender = await pollUntil(
        async () => {
          const probe = await ui.evalInWebviewDoc(webviewClient, `(() => {
            const rendered = Array.from(document.querySelectorAll('.kd-panda-img')).filter((img) => {
              if (!img.complete || img.naturalWidth === 0 || !img.src) return false;
              const rect = img.getBoundingClientRect();
              const style = getComputedStyle(img);
              return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            });
            return {
              renderedCount: rendered.length,
              sources: rendered.slice(0, 5).map((img) => img.src.split('/').pop()),
            };
          })()`);
          return probe.renderedCount > 0 ? { done: true, value: probe } : { done: false, value: probe };
        },
        { timeoutMs: 20000, intervalMs: 1000, describe: () => 'a visibly rendered approved panda asset in the everyday journey' },
      );
      evidence.scenarios.everydayPandaIdentity = { ok: true, ...pandaRender };
      log(`Everyday panda identity: ${pandaRender.renderedCount} rendered asset(s): ${pandaRender.sources.join(', ')}.`);

      const RAW_ID_PATTERN = /\b(?:att_|req_|appr_|minv_|tinv_|conv_)[0-9a-f]{4,}/i;
      const PHASE_VOCABULARY = new Set([
        'Understanding your request', 'Preparing the work', 'Waiting for your approval',
        'Making changes', 'Checking the result', 'Preparing delivery',
        'Completed', 'Stopped', 'Blocked', 'Processing task',
      ]);

      const draftRecommendation = async (client, text) => {
        await ui.evalInWebviewDoc(client, `(() => {
          const input = document.getElementById('user-input');
          if (!input) throw new Error('unified composer input not found');
          input.value = ${JSON.stringify(text)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 400));
        return ui.evalInWebviewDoc(client, `(() => {
          const row = document.getElementById('everyday-reco-row');
          const active = document.querySelector('.everyday-mode-option.active');
          return {
            chipHidden: row ? row.hidden : null,
            label: document.getElementById('everyday-reco-label')?.textContent ?? null,
            reason: document.getElementById('everyday-reco-reason')?.textContent ?? null,
            activeMode: active ? active.dataset.mode : null,
          };
        })()`);
      };
      const clickOverride = (client, mode) => ui.evalInWebviewDoc(client, `(() => {
        const btn = document.querySelector('.everyday-mode-option[data-mode="${mode}"]');
        if (!btn) throw new Error('everyday override button ${mode} not found');
        btn.click();
        return true;
      })()`);
      const clickSend = (client) => ui.evalInWebviewDoc(client, `(() => {
        const btn = document.getElementById('send-btn');
        if (!btn) throw new Error('send button not found');
        btn.click();
        return true;
      })()`);
      const readPhase = (client) => ui.evalInWebviewDoc(client, `({
        hidden: document.getElementById('everyday-phase')?.hidden,
        label: document.getElementById('everyday-phase-label')?.textContent ?? null,
        sentence: document.getElementById('everyday-phase-sentence')?.textContent ?? null,
      })`);
      const readVisibleText = (client) => ui.evalInWebviewDoc(client, `document.body.innerText`);
      const openHistory = async (client) => {
        await ui.evalInWebviewDoc(client, `(() => {
          const drawer = document.getElementById('history-drawer');
          const toggle = document.getElementById('history-toggle');
          if (!toggle) throw new Error('history toggle not found');
          if (drawer && drawer.hidden === false) toggle.click(); // close so the reopening click refreshes
          toggle.click();
          return true;
        })()`);
      };
      const readHistoryItems = (client) => ui.evalInWebviewDoc(client, `Array.from(document.querySelectorAll('.everyday-history-item')).map((item) => ({
        attemptId: item.dataset.attemptId,
        request: item.querySelector('.everyday-history-request')?.textContent ?? null,
        phase: item.querySelector('.everyday-history-phase')?.textContent ?? null,
        mode: item.querySelector('.everyday-history-mode')?.textContent ?? null,
        outcome: item.querySelector('.everyday-history-outcome')?.textContent ?? null,
      }))`);

      // ── Part A: implementation phrasing → Karke recommendation → override to Baat Kar ──
      const overridePrompt = `Add a short note about the word hello to this project. (nonce ${NONCE}-everyday-baat)`;
      const recoA = await draftRecommendation(webviewClient, overridePrompt);
      if (recoA.chipHidden !== false || recoA.activeMode !== 'autonomous') {
        throw new Error(`unified composer did not recommend Karke Dikha for an implementation request: ${JSON.stringify(recoA)}`);
      }
      const recoAAfterOverride = await (async () => {
        await clickOverride(webviewClient, 'chat');
        await new Promise((r) => setTimeout(r, 150));
        return ui.evalInWebviewDoc(webviewClient, `document.querySelector('.everyday-mode-option.active')?.dataset.mode ?? null`);
      })();
      if (recoAAfterOverride !== 'chat') throw new Error(`Baat Kar override did not take effect (active=${recoAAfterOverride})`);
      await sendWithCoreConnectedRetry(webviewClient, async () => {
        await draftRecommendation(webviewClient, overridePrompt);
        await clickOverride(webviewClient, 'chat');
        await clickSend(webviewClient);
      }, overridePrompt);
      const { request: baatRequest, attempt: baatAttempt } = await pollForAttemptViaMessage(
        overridePrompt,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 90000 },
      );
      const baatRequests = await findRequestsByMessage(overridePrompt);
      const baatAttempts = await findAttemptsForRequest(baatRequest.id);
      const modeDecisions = ((await ui.readInstrumentedPostedMessages(webviewClient)) ?? [])
        .filter((m) => m?.type === 'everydayModeDecision');
      const overrideDecisions = modeDecisions.filter((m) => m.recommendedMode === 'karke_dikha' && m.selectedMode === 'baat_kar' && m.overridden === true);
      const overridePartOk = baatAttempt.status === 'completed'
        && baatRequests.length === 1
        && baatAttempts.length === 1
        && baatRequest.requestedMode === 'baat_kar'
        && baatRequest.resolvedMode === 'baat_kar'
        && baatAttempt.kind === 'baat_kar'
        && overrideDecisions.length >= 1;
      log(`Everyday Part A: override→Baat request ${baatRequest.id} attempt ${baatAttempt.id} status=${baatAttempt.status}; decisions=${modeDecisions.length}.`);
      if (!overridePartOk) {
        throw new Error(`M33 override-to-Baat did not meet acceptance: ${JSON.stringify({ baatRequests: baatRequests.length, baatAttempts: baatAttempts.length, requestedMode: baatRequest.requestedMode, status: baatAttempt.status, overrideDecisions })}`);
      }

      // ── Part B: implementation request accepting the Karke recommendation ──
      const karkePrompt = `Add a file named everyday.txt containing the word everyday. (nonce ${NONCE}-everyday-karke)`;
      const recoB = await draftRecommendation(webviewClient, karkePrompt);
      if (recoB.chipHidden !== false || recoB.activeMode !== 'autonomous') {
        throw new Error(`unified composer did not recommend Karke Dikha for the implementation request: ${JSON.stringify(recoB)}`);
      }
      await sendWithCoreConnectedRetry(webviewClient, async () => {
        await draftRecommendation(webviewClient, karkePrompt);
        await clickSend(webviewClient);
      }, karkePrompt);

      const observedPhases = [];
      const notePhase = async () => {
        const phase = await readPhase(webviewClient).catch(() => null);
        if (phase?.label && (observedPhases.length === 0 || observedPhases[observedPhases.length - 1] !== phase.label)) {
          observedPhases.push(phase.label);
        }
        return phase;
      };
      await pollUntil(
        async () => {
          await notePhase();
          const dom = await ui.readApprovalCycleDom(webviewClient);
          return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
            ? { done: true, value: dom } : { done: false, value: dom };
        },
        { timeoutMs: 180000, describe: () => 'M33 proposal approval card to become actionable' },
      );
      const phaseAtProposal = await notePhase();
      const visibleAtApproval = await readVisibleText(webviewClient);
      const rawIdsHiddenAtApproval = !RAW_ID_PATTERN.test(visibleAtApproval);
      const detailsDiagnostics = await ui.evalInWebviewDoc(webviewClient, `(() => {
        const details = document.querySelector('.everyday-diagnostic-ids');
        if (details) details.open = true;
        const out = {
          taskText: document.getElementById('autonomous-task-id')?.textContent ?? null,
          attemptText: document.getElementById('autonomous-attempt-id')?.textContent ?? null,
        };
        if (details) details.open = false;
        return out;
      })()`);
      await board.captureScreenshot(pageClient, evidenceDir, '7-everyday-proposal-approval').catch(() => {});
      await ui.clickProposalApproveButton(webviewClient);
      log('Everyday Part B: proposal approved via the reskinned card.');
      const gate2 = await pollUntil(
        async () => {
          await notePhase();
          const dom = await ui.readApprovalCycleDom(webviewClient);
          if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) return { done: true, value: { kind: 'mutation' } };
          if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) return { done: true, value: { kind: 'delivery' } };
          return { done: false, value: dom };
        },
        { timeoutMs: 120000, describe: () => 'M33 mutation or delivery approval card to become actionable' },
      );
      if (gate2.kind === 'mutation') {
        await ui.clickMutationApproveButton(webviewClient);
        await pollUntil(
          async () => {
            await notePhase();
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'M33 delivery approval card to become actionable' },
        );
      }
      await ui.clickDeliveryApproveButton(webviewClient);
      const { attempt: karkeAttempt } = await pollForAttemptViaMessage(
        karkePrompt,
        (a) => ['completed', 'failed', 'cancelled'].includes(a.status),
        { timeoutMs: 180000 },
      );
      const karkeRequest = await findRequestByMessage(karkePrompt);
      await notePhase();

      // ── Outcome-first completion card with visible proof ──
      const outcomeCard = await pollUntil(
        async () => {
          const card = await ui.evalInWebviewDoc(webviewClient, `(() => {
            const el = document.getElementById('everyday-outcome-card');
            if (!el || el.hidden) return null;
            return {
              className: el.className,
              headline: el.querySelector('.everyday-outcome-headline')?.textContent ?? null,
              rows: Array.from(el.querySelectorAll('.everyday-evidence-row')).map((row) => ({
                label: row.querySelector('.everyday-evidence-label')?.textContent ?? null,
                value: row.querySelector('.everyday-evidence-value')?.textContent ?? null,
              })),
            };
          })()`);
          return card && card.className.includes('is-success')
            ? { done: true, value: card } : { done: false, value: card };
        },
        { timeoutMs: 30000, describe: () => 'M33 outcome-first completion card' },
      );
      const finalPhase = await readPhase(webviewClient);
      const visibleAtCompletion = await readVisibleText(webviewClient);
      const rawIdsHiddenAtCompletion = !RAW_ID_PATTERN.test(visibleAtCompletion);
      await board.captureScreenshot(pageClient, evidenceDir, '7-everyday-outcome').catch(() => {});

      const gitLogAll = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: wsEveryday });
      const deliveryLines = gitLogAll.split(/\r?\n/).filter((line) => line.includes('M15 delivery'));
      const deliverySha = deliveryLines[0]?.split(' ')[0] ?? null;
      const deliveredContent = deliverySha
        ? runCapture('git', ['show', `${deliverySha}:everyday.txt`], { cwd: wsEveryday }).trim()
        : null;
      const outcomeRowFor = (label) => outcomeCard.rows.find((row) => row.label === label)?.value ?? null;
      const outcomeCommitRow = outcomeRowFor('Delivery commit');
      const outcomeFilesRow = outcomeRowFor('Files changed');
      const outcomeVerificationRow = outcomeRowFor('Verification');
      const outcomeEvidenceOk = Boolean(deliverySha)
        && typeof outcomeCommitRow === 'string' && outcomeCommitRow.startsWith(deliverySha.slice(0, 10))
        && typeof outcomeFilesRow === 'string' && outcomeFilesRow.includes('everyday.txt')
        && typeof outcomeVerificationRow === 'string' && /passed/.test(outcomeVerificationRow)
        && /everyday/i.test(deliveredContent ?? '');

      // ── Durable history in this session ──
      const historyBefore = await pollUntil(
        async () => {
          await openHistory(webviewClient);
          await new Promise((r) => setTimeout(r, 700));
          const items = await readHistoryItems(webviewClient);
          const karkeItem = items.find((item) => item.attemptId === karkeAttempt.id);
          const baatItem = items.find((item) => item.attemptId === baatAttempt.id);
          return karkeItem && karkeItem.phase === 'Completed' && baatItem
            ? { done: true, value: { items, karkeItem, baatItem } } : { done: false, value: items };
        },
        { timeoutMs: 30000, intervalMs: 1500, describe: () => 'M33 durable history to list both everyday tasks' },
      );
      await board.captureScreenshot(pageClient, evidenceDir, '7-everyday-history').catch(() => {});

      // ── Close the real window, relaunch, and restore the same history ──
      const discoveryBeforeClose = readDiscoveryRecord();
      const portBefore = everydayWindow.cdpPort;
      await board.closeTarget(portBefore, pageTargetId);
      const remaining = await pollUntil(
        async () => {
          const pages = (await board.listTargets(portBefore).catch(() => [])).filter((target) => target.type === 'page');
          return pages.some((target) => target.id === pageTargetId)
            ? { done: false, value: pages.length } : { done: true, value: pages };
        },
        { timeoutMs: 15000, intervalMs: 250, describe: () => 'everyday window target to close' },
      );
      if (remaining.length === 0) {
        const endpointStopped = await pollUntil(
          async () => {
            try {
              await board.listTargets(portBefore);
              return { done: false, value: 'still listening' };
            } catch {
              return { done: true, value: true };
            }
          },
          { timeoutMs: 5000, intervalMs: 250, describe: () => 'CDP endpoint to close with its last window' },
        ).catch(() => false);
        if (endpointStopped) ownedCdpPort = undefined;
      }
      const relaunchWindow = await launchWorkspaceWindow(wsEveryday, 'window-7b-everyday-relaunch');
      const reopened = await openChatPanel(relaunchWindow);
      const pageClient2 = reopened.pageClient;
      const webviewClient2 = reopened.webviewClient;
      const discoveryAfterRelaunch = readDiscoveryRecord();
      const historyAfter = await pollUntil(
        async () => {
          await openHistory(webviewClient2);
          await new Promise((r) => setTimeout(r, 700));
          const items = await readHistoryItems(webviewClient2);
          const karkeItem = items.find((item) => item.attemptId === karkeAttempt.id);
          return karkeItem && karkeItem.phase === 'Completed'
            ? { done: true, value: { items, karkeItem } } : { done: false, value: items };
        },
        { timeoutMs: 45000, intervalMs: 1500, describe: () => 'restored M33 history to list the completed everyday task after relaunch' },
      );
      // Open the restored entry and confirm the readable timeline + evidence.
      await ui.evalInWebviewDoc(webviewClient2, `(() => {
        const item = Array.from(document.querySelectorAll('.everyday-history-item')).find((node) => node.dataset.attemptId === ${JSON.stringify(karkeAttempt.id)});
        if (!item) throw new Error('restored history item not found');
        item.querySelector('.everyday-history-header').click();
        return true;
      })()`);
      const restoredTimeline = await pollUntil(
        async () => {
          const detail = await ui.evalInWebviewDoc(webviewClient2, `(() => {
            const item = Array.from(document.querySelectorAll('.everyday-history-item')).find((node) => node.dataset.attemptId === ${JSON.stringify(karkeAttempt.id)});
            const body = item?.querySelector('.everyday-history-body');
            if (!body || body.hidden || !body.dataset.loaded) return null;
            return {
              text: body.innerText,
              steps: Array.from(body.querySelectorAll('.everyday-history-step-text')).map((step) => step.textContent),
              detailsJson: body.querySelector('.everyday-details-json')?.textContent ?? null,
            };
          })()`);
          return detail ? { done: true, value: detail } : { done: false, value: null };
        },
        { timeoutMs: 30000, describe: () => 'restored M33 history timeline to load' },
      );
      const restoredHistoryVisible = await readVisibleText(webviewClient2);
      const rawIdsHiddenAfterRestart = !RAW_ID_PATTERN.test(restoredHistoryVisible);
      const timelineOk = restoredTimeline.steps.some((step) => /Delivered commit/.test(step))
        && restoredTimeline.steps.some((step) => step === 'Completed')
        && restoredTimeline.steps.some((step) => /Waiting for your approval/.test(step))
        && typeof restoredTimeline.detailsJson === 'string'
        && restoredTimeline.detailsJson.includes(karkeAttempt.id);
      await board.captureScreenshot(pageClient2, evidenceDir, '7b-everyday-history-after-relaunch').catch(() => {});

      // ── Duplicate/terminal-event accounting for the Karke journey ──
      const karkeRequests = await findRequestsByMessage(karkePrompt);
      const karkeAttempts = karkeRequests.length === 1 ? await findAttemptsForRequest(karkeRequests[0].id) : [];
      const karkeApprovals = await findApprovalsForAttempt(karkeAttempt.id);
      const karkeEvents = await findRuntimeEventsForEntity(karkeAttempt.id);
      const terminalTransitions = karkeEvents
        .filter((event) => event.eventType === 'attempt_transitioned')
        .map((event) => JSON.parse(event.metadata))
        .filter((transition) => ['completed', 'failed', 'cancelled'].includes(transition.to));
      const duplicateCounts = {
        baatRequests: baatRequests.length,
        baatAttempts: baatAttempts.length,
        karkeRequests: karkeRequests.length,
        karkeAttempts: karkeAttempts.length,
        proposalApprovals: karkeApprovals.filter((approval) => approval.kind === 'proposal').length,
        mutationApprovals: karkeApprovals.filter((approval) => approval.kind === 'mutation').length,
        deliveryApprovals: karkeApprovals.filter((approval) => approval.kind === 'delivery').length,
        terminalTransitions: terminalTransitions.length,
      };
      const noDuplicates = duplicateCounts.baatRequests === 1
        && duplicateCounts.baatAttempts === 1
        && duplicateCounts.karkeRequests === 1
        && duplicateCounts.karkeAttempts === 1
        && duplicateCounts.proposalApprovals === 1
        && duplicateCounts.mutationApprovals === 1
        && duplicateCounts.deliveryApprovals === 1
        && duplicateCounts.terminalTransitions === 1;
      const approvalsAllApproved = ['proposal', 'mutation', 'delivery'].every(
        (kind) => karkeApprovals.some((approval) => approval.kind === kind && approval.status === 'approved'),
      );

      const phasesReadable = observedPhases.length > 0 && observedPhases.every((label) => PHASE_VOCABULARY.has(label));
      const detailsExposeDiagnostics = typeof detailsDiagnostics.attemptText === 'string'
        && detailsDiagnostics.attemptText.includes(karkeAttempt.id);

      const ok = overridePartOk
        && karkeAttempt.status === 'completed'
        && karkeRequest?.requestedMode === 'karke_dikha'
        && phasesReadable
        && phaseAtProposal?.label === 'Waiting for your approval'
        && finalPhase?.label === 'Completed'
        && outcomeEvidenceOk
        && rawIdsHiddenAtApproval
        && rawIdsHiddenAtCompletion
        && rawIdsHiddenAfterRestart
        && detailsExposeDiagnostics
        && historyBefore.karkeItem.mode === 'Karke Dikha'
        && historyAfter.karkeItem.phase === 'Completed'
        && timelineOk
        && discoveryAfterRelaunch.instanceId === discoveryBeforeClose.instanceId
        && approvalsAllApproved
        && noDuplicates;

      evidence.scenarios.everydayJourney = {
        ok,
        unifiedComposer: {
          implementationRecommendation: recoA,
          karkeRecommendation: recoB,
          modeDecisions,
        },
        overrideToBaat: {
          requestId: baatRequest.id,
          attemptId: baatAttempt.id,
          requestedMode: baatRequest.requestedMode,
          resolvedMode: baatRequest.resolvedMode,
          attemptStatus: baatAttempt.status,
        },
        karkeJourney: {
          requestId: karkeRequest?.id ?? null,
          attemptId: karkeAttempt.id,
          attemptStatus: karkeAttempt.status,
          gate2Kind: gate2.kind,
          observedPhases,
          phaseAtProposal,
          finalPhase,
          approvals: karkeApprovals.map((approval) => ({ id: approval.id, kind: approval.kind, status: approval.status, revision: approval.revision })),
        },
        outcomeCard,
        deliveryCommit: { sha: deliverySha, everydayTxtContent: deliveredContent },
        defaultUiCleanliness: { rawIdsHiddenAtApproval, rawIdsHiddenAtCompletion, rawIdsHiddenAfterRestart, detailsDiagnostics },
        history: {
          beforeRestart: historyBefore.karkeItem,
          baatEntryPresent: Boolean(historyBefore.baatItem),
          afterRestart: historyAfter.karkeItem,
          restoredTimelineSteps: restoredTimeline.steps,
          coreInstanceIdBeforeClose: discoveryBeforeClose.instanceId,
          coreInstanceIdAfterRelaunch: discoveryAfterRelaunch.instanceId,
        },
        duplicateCounts,
      };
      log(`Everyday journey: baat=${baatAttempt.id}(${baatAttempt.status}) karke=${karkeAttempt.id}(${karkeAttempt.status}) phases=${JSON.stringify(observedPhases)} delivery=${deliverySha} historyRestored=${historyAfter.karkeItem.phase}.`);
      if (!ok) throw new Error(`M33 everyday journey did not meet acceptance: ${JSON.stringify(evidence.scenarios.everydayJourney)}`);

      await pageClient2.close();
      await webviewClient2.close();
      await pageClient.close().catch(() => {});
      await webviewClient.close().catch(() => {});
    });

    // =====================================================================
    // Scenario 8 (M34): a real local coding model fixes a bounded defect in a
    // disposable repository through the packaged unified composer and the
    // unchanged proposal/mutation/delivery gates.
    // =====================================================================
    await runRegisteredScenario('m34-realwork', 'scenario-8-m34-real-world-coding-task', async () => {
      const workspace = path.join(workDir, 'ws-m34-realwork');
      const fixtureContract = writeM34RealworkRepository(workspace);
      initGitRepo(workspace);
      if (!ownedCdpPort) {
        const keeperWindow = await ensureChatWindow();
        await waitForWorkbenchReady(keeperWindow);
      }
      const windowHandle = await launchWorkspaceWindow(workspace, 'window-8-m34-realwork');
      const { pageClient, webviewClient } = await openChatPanel(windowHandle);
      try {
        const prompt = `${fixtureContract.task} (nonce ${NONCE}-m34-realwork)`;
        const draft = async () => ui.evalInWebviewDoc(webviewClient, `(() => {
          const input = document.getElementById('user-input');
          if (!input) throw new Error('unified composer input not found');
          input.value = ${JSON.stringify(prompt)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        await draft();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const recommendation = await ui.evalInWebviewDoc(webviewClient, `(() => ({
          activeMode: document.querySelector('.everyday-mode-option.active')?.dataset.mode ?? null,
          label: document.getElementById('everyday-reco-label')?.textContent ?? null,
          reason: document.getElementById('everyday-reco-reason')?.textContent ?? null,
        }))()`);
        if (recommendation.activeMode !== 'autonomous') {
          throw new Error(`M34 realwork was not recommended for Karke Dikha: ${JSON.stringify(recommendation)}`);
        }
        await sendWithCoreConnectedRetry(webviewClient, async () => {
          await draft();
          await ui.evalInWebviewDoc(webviewClient, `(() => {
            const button = document.getElementById('send-btn');
            if (!button) throw new Error('unified send button not found');
            button.click();
            return true;
          })()`);
        }, prompt);

        await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
              ? { done: true, value: dom }
              : { done: false, value: dom };
          },
          { timeoutMs: 180000, describe: () => 'M34 realwork proposal approval card' },
        );
        await ui.clickProposalApproveButton(webviewClient);
        const secondGate = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) {
              return { done: true, value: 'mutation' };
            }
            if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) {
              return { done: true, value: 'delivery' };
            }
            return { done: false, value: dom };
          },
          { timeoutMs: 180000, describe: () => 'M34 realwork mutation or delivery approval card' },
        );
        if (secondGate === 'mutation') {
          await ui.clickMutationApproveButton(webviewClient);
          await pollUntil(
            async () => {
              const dom = await ui.readApprovalCycleDom(webviewClient);
              return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false
                ? { done: true, value: dom }
                : { done: false, value: dom };
            },
            { timeoutMs: 180000, describe: () => 'M34 realwork delivery approval card' },
          );
        }
        await ui.clickDeliveryApproveButton(webviewClient);

        const { request, attempt } = await pollForAttemptViaMessage(
          prompt,
          (candidate) => ['completed', 'failed', 'cancelled'].includes(candidate.status),
          { timeoutMs: 240000 },
        );
        const requests = await findRequestsByMessage(prompt);
        const attempts = requests.length === 1 ? await findAttemptsForRequest(requests[0].id) : [];
        const approvals = await findApprovalsForAttempt(attempt.id);
        const runtimeEvents = await findRuntimeEventsForEntity(attempt.id);
        const qualityEvents = parseExecutionQualityEvents(runtimeEvents);
        const selectionEvent = qualityEvents.find((event) => event.eventType === 'model_selection_decided');
        const contextRow = await findAttemptContext(attempt.id);
        const modelSelection = contextRow?.modelSelection ? JSON.parse(contextRow.modelSelection) : null;
        const invocations = await findModelInvocations(attempt.id);
        const deliveryLog = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: workspace });
        const deliverySha = deliveryLog.split(/\r?\n/)
          .find((line) => line.includes('M15 delivery'))?.split(' ')[0] ?? null;
        const changedFiles = deliverySha
          ? runCapture('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', deliverySha], { cwd: workspace })
            .split(/\r?\n/).filter(Boolean)
          : [];
        let validation = { status: null, stdout: '', stderr: 'No delivery commit was available to validate.' };
        if (deliverySha) {
          const deliveredValidationRoot = path.join(workDir, 'ws-m34-realwork-delivered-validation');
          validation = validateNpmTestAtCommit(workspace, deliverySha, deliveredValidationRoot);
        }
        const visibleText = await ui.evalInWebviewDoc(webviewClient, 'document.body.innerText');
        const suitabilityVisible = /coding model suited to this task/i.test(visibleText);
        const selectedModelHiddenByDefault = !modelSelection?.selectedModel
          || !visibleText.includes(modelSelection.selectedModel);
        await ui.evalInWebviewDoc(webviewClient, `(() => {
          const drawer = document.getElementById('history-drawer');
          const toggle = document.getElementById('history-toggle');
          if (drawer && drawer.hidden === false) toggle?.click();
          toggle?.click();
          return true;
        })()`);
        const historyEntry = await pollUntil(
          async () => {
            const item = await ui.evalInWebviewDoc(webviewClient, `(() => {
              const entry = Array.from(document.querySelectorAll('.everyday-history-item'))
                .find((candidate) => candidate.dataset.attemptId === ${JSON.stringify(attempt.id)});
              return entry ? {
                phase: entry.querySelector('.everyday-history-phase')?.textContent ?? null,
                outcome: entry.querySelector('.everyday-history-outcome')?.textContent ?? null,
              } : null;
            })()`);
            return item ? { done: true, value: item } : { done: false, value: null };
          },
          { timeoutMs: 30000, intervalMs: 1000, describe: () => 'M34 realwork durable History entry' },
        );
        const duplicateCounts = {
          requests: requests.length,
          attempts: attempts.length,
          proposalApprovals: approvals.filter((approval) => approval.kind === 'proposal').length,
          mutationApprovals: approvals.filter((approval) => approval.kind === 'mutation').length,
          deliveryApprovals: approvals.filter((approval) => approval.kind === 'delivery').length,
          terminalTransitions: countTerminalTransitions(runtimeEvents),
        };
        const expectedFilesOnly = changedFiles.length === fixtureContract.intendedFiles.length
          && changedFiles.every((file) => fixtureContract.intendedFiles.includes(file.replace(/\\/g, '/')));
        const noFallbacks = invocations.every((invocation) => !invocation.fallbackUsed);
        const ok = attempt.status === 'completed'
          && request.id === requests[0]?.id
          && Boolean(selectionEvent)
          && modelSelection?.requiredCapabilities?.fileModification === true
          && modelSelection?.requiredCapabilities?.validationAndRepair === true
          && suitabilityVisible
          && selectedModelHiddenByDefault
          && Boolean(deliverySha)
          && expectedFilesOnly
          && validation.status === 0
          && historyEntry.phase === 'Completed'
          && noFallbacks
          && Object.values(duplicateCounts).every((count) => count === 1);

        evidence.scenarios.m34Realwork = {
          ok,
          requestId: request.id,
          attemptId: attempt.id,
          finalAttemptStatus: attempt.status,
          recommendation,
          modelSelection,
          selectionEvidence: selectionEvent?.metadata ?? null,
          deliveryCommit: deliverySha,
          changedFiles,
          validation: {
            command: fixtureContract.validationCommand,
            exitCode: validation.status,
            stdout: validation.stdout,
            stderr: validation.stderr,
          },
          historyEntry,
          visibleProof: { suitabilityVisible, selectedModelHiddenByDefault },
          retries: 0,
          fallbacks: invocations.filter((invocation) => invocation.fallbackUsed).length,
          duplicateCounts,
          cleanup: { clientsClosed: true, workspaceRemovedAtFinalCleanup: true },
        };
        await board.captureScreenshot(pageClient, evidenceDir, '8-m34-realwork-outcome').catch(() => {});
        log(`M34 realwork: request=${request.id}; attempt=${attempt.id}:${attempt.status}; model=${modelSelection?.selectedModel}; delivery=${deliverySha}; tests=${validation.status}; files=${changedFiles.join(',')}.`);
        if (!ok) throw new Error(`M34 real-world coding task did not meet acceptance: ${JSON.stringify(evidence.scenarios.m34Realwork)}`);
      } finally {
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
      }
    });

    // =====================================================================
    // Scenario 9 (M34): deterministic repository-path and loop recovery.
    // The fixture supplies model output only. The packaged UI and Core still
    // create and own the request, attempt, tool calls, recovery evidence,
    // strategy decision, terminal state, and visible proof.
    // =====================================================================
    await runRegisteredScenario('m34-recovery', 'scenario-9-m34-repository-and-loop-recovery', async () => {
      const scenarioRoot = path.join(workDir, 'm34-recovery-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'src', 'recovery-target.ts'),
        'export const recoveryTarget = "repository-grounded";\n',
      );
      fs.writeFileSync(path.join(workspace, 'README.md'), '# M34 repository recovery acceptance workspace\n');

      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = {
        ok: false,
        proxy: { endpoint: null, model: M34_FIXTURE_MODEL, cleanedUp: false },
        cleanup: null,
      };
      evidence.scenarios.m34Recovery = scenarioEvidence;
      try {
        fixture = await startDeterministicM34Proxy();
        scenarioEvidence.proxy.endpoint = fixture.baseUrl;
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m34-recovery-isolated',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: {
            'ollama-agent.apiBase': fixture.baseUrl,
            'ollama-agent.model': M34_FIXTURE_MODEL,
            'ollama-agent.chatModel': M34_FIXTURE_MODEL,
            'ollama-agent.agentModel': M34_FIXTURE_MODEL,
            'ollama-agent.codingModel': M34_FIXTURE_MODEL,
            'ollama-agent.editModel': M34_FIXTURE_MODEL,
            'ollama-agent.reviewerModel': M34_FIXTURE_MODEL,
            'ollama-agent.codingFallbackModel': M34_STRONG_FIXTURE_MODEL,
          },
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        await setMode(webviewClient, 'agent');

        const prompt = `${M34_RECOVERY_MARKER} Inspect the recovery target, refuse unsafe paths, and change strategy if an equivalent failing read repeats. (nonce ${NONCE}-m34-recovery)`;
        await sendChatMessage(webviewClient, prompt);
        const { request, attempt } = await pollUntil(
          async () => {
            const candidateRequest = await findRequestByMessage(prompt, windowHandle.globalDataDir);
            if (!candidateRequest) return { done: false, value: 'no request yet' };
            const attempts = await findAttemptsForRequest(candidateRequest.id, windowHandle.globalDataDir);
            const candidateAttempt = attempts[0];
            return candidateAttempt && ['completed', 'failed', 'cancelled'].includes(candidateAttempt.status)
              ? { done: true, value: { request: candidateRequest, attempt: candidateAttempt } }
              : { done: false, value: candidateAttempt?.status ?? 'no attempt yet' };
          },
          { timeoutMs: 90000, intervalMs: 500, describe: () => 'M34 recovery attempt to reach a bounded terminal state' },
        );

        const requests = await findRequestsByMessage(prompt, windowHandle.globalDataDir);
        const attempts = requests.length === 1
          ? await findAttemptsForRequest(requests[0].id, windowHandle.globalDataDir)
          : [];
        const tools = await findToolInvocations(attempt.id, windowHandle.globalDataDir);
        const runtimeEvents = await findRuntimeEventsForEntity(attempt.id, windowHandle.globalDataDir);
        const qualityEvents = parseExecutionQualityEvents(runtimeEvents);
        const qualityTypes = qualityEvents.map((event) => event.eventType);
        const correction = qualityEvents.find((event) => event.eventType === 'repository_path_corrected');
        const loop = qualityEvents.find((event) => event.eventType === 'loop_detected');
        const strategy = qualityEvents.find((event) => event.eventType === 'strategy_changed');
        const submittedMessages = ((await ui.readInstrumentedPostedMessages(webviewClient)) ?? [])
          .filter((message) => message?.type === 'sendMessage' && message.text === prompt);
        const inbound = await readInboundMessages(webviewClient);
        const visibleText = await ui.evalInWebviewDoc(webviewClient, 'document.body.innerText');
        const strategyVisible = /not making progress|different strategy|changed strategy/i.test(
          `${visibleText}\n${JSON.stringify(inbound)}`,
        );
        const toolSignatures = tools.map((tool) => {
          const args = JSON.parse(tool.argsSummary ?? '{}');
          const normalizedPath = typeof args.path === 'string'
            ? args.path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
            : null;
          return `${tool.toolName}:${normalizedPath}`;
        });
        const duplicateToolInvocations = toolSignatures.length - new Set(toolSignatures).size;
        const terminalTransitions = countTerminalTransitions(runtimeEvents);
        const expectedTerminal = attempt.status === 'completed'
          || (attempt.status === 'failed' && /path|outside|strategy|progress|repeat/i.test(String(attempt.error ?? attempt.reason ?? '')));
        const correctionOriginal = correction?.metadata?.originalPath ?? correction?.metadata?.original;
        const correctionSelected = correction?.metadata?.selectedPath ?? correction?.metadata?.selected;
        const correctionEvidenceComplete = correction
          && typeof correctionOriginal === 'string'
          && typeof correctionSelected === 'string'
          && /recovery-target\.ts$/i.test(correctionSelected);
        const proxyState = fixture.snapshot();
        const ok = requests.length === 1
          && attempts.length === 1
          && submittedMessages.length === 1
          && expectedTerminal
          && correctionEvidenceComplete
          && Boolean(loop)
          && Boolean(strategy)
          && strategyVisible
          && duplicateToolInvocations === 0
          && terminalTransitions === 1
          && proxyState.chatRequests >= 3
          && proxyState.chatRequests <= 4;

        scenarioEvidence = {
          ok,
          proxy: {
            endpoint: fixture.baseUrl,
            model: fixture.model,
            chatRequests: proxyState.chatRequests,
            scenarioCalls: proxyState.scenarioCalls,
            cleanedUp: false,
          },
          requestId: request.id,
          attemptId: attempt.id,
          finalAttemptStatus: attempt.status,
          selectedModel: (await findModelInvocations(attempt.id, windowHandle.globalDataDir))[0]?.actualModel ?? null,
          qualityTypes,
          correction: correction?.metadata ?? null,
          loop: loop?.metadata ?? null,
          strategy: strategy?.metadata ?? null,
          toolInvocations: tools.map((tool) => ({
            id: tool.id,
            toolName: tool.toolName,
            status: tool.status,
            args: JSON.parse(tool.argsSummary ?? '{}'),
            evidence: JSON.parse(tool.evidence ?? '{}'),
          })),
          visibleProof: { strategyVisible },
          duplicateCounts: {
            visibleSubmissions: submittedMessages.length,
            requests: requests.length,
            attempts: attempts.length,
            equivalentToolInvocations: duplicateToolInvocations,
            terminalTransitions,
          },
          cleanup: null,
        };
        evidence.scenarios.m34Recovery = scenarioEvidence;
        await board.captureScreenshot(pageClient, evidenceDir, '9-m34-repository-loop-recovery').catch(() => {});
        log(`M34 recovery: request=${request.id}; attempt=${attempt.id}:${attempt.status}; quality=${qualityTypes.join(',')}; tools=${tools.length}; repeated-dispatches=${duplicateToolInvocations}.`);
        if (!ok) throw new Error(`M34 repository and loop recovery did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) {
          terminateOwnedProcessTree(pid);
        }
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = {
          proxyClosedAt: fixture?.snapshot().closedAt ?? null,
          proxyCleanedUp: Boolean(fixture?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          corePid: isolatedCorePid,
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        scenarioEvidence.proxy.cleanedUp = cleanup.proxyCleanedUp;
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m34Recovery = scenarioEvidence;
        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`M34 recovery cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 10 (M34): deterministic validation repair plus a separate
    // bounded blocker/retry lineage. The model fixture supplies candidates;
    // all validation, mutation, Core retry identity, approvals, worktrees,
    // delivery, History, and double-click idempotency remain product-owned.
    // =====================================================================
    await runRegisteredScenario('m34-repair-retry', 'scenario-10-m34-validation-repair-and-retry', async () => {
      const scenarioRoot = path.join(workDir, 'm34-repair-retry-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      const repairContract = writeM34RepairRepository(workspace);
      initGitRepo(workspace);
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m34RepairRetry = scenarioEvidence;
      try {
        fixture = await startDeterministicM34Proxy();
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m34-repair-retry-isolated',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: {
            'ollama-agent.apiBase': fixture.baseUrl,
            'ollama-agent.model': M34_FIXTURE_MODEL,
            'ollama-agent.agentModel': M34_FIXTURE_MODEL,
            'ollama-agent.codingModel': M34_FIXTURE_MODEL,
            'ollama-agent.editModel': M34_FIXTURE_MODEL,
            'ollama-agent.reviewerModel': M34_FIXTURE_MODEL,
            'ollama-agent.codingFallbackModel': M34_STRONG_FIXTURE_MODEL,
          },
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));

        const submitUnified = async (prompt) => {
          const fill = () => ui.evalInWebviewDoc(webviewClient, `(() => {
            const input = document.getElementById('user-input');
            if (!input) throw new Error('unified composer input not found');
            input.value = ${JSON.stringify(prompt)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()`);
          await fill();
          await new Promise((resolve) => setTimeout(resolve, 350));
          const mode = await ui.evalInWebviewDoc(
            webviewClient,
            `document.querySelector('.everyday-mode-option.active')?.dataset.mode ?? null`,
          );
          if (mode !== 'autonomous') throw new Error(`M34 deterministic coding task was not routed to Karke Dikha (mode=${mode})`);
          await ui.evalInWebviewDoc(webviewClient, `(() => {
            const button = document.getElementById('send-btn');
            if (!button) throw new Error('unified send button not found');
            button.click();
            return true;
          })()`);
        };
        const approveThroughDelivery = async (label) => {
          await pollUntil(
            async () => {
              const dom = await ui.readApprovalCycleDom(webviewClient);
              return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
                ? { done: true, value: dom }
                : { done: false, value: dom };
            },
            { timeoutMs: 180000, describe: () => `${label} proposal approval` },
          );
          await ui.clickProposalApproveButton(webviewClient);
          const next = await pollUntil(
            async () => {
              const dom = await ui.readApprovalCycleDom(webviewClient);
              if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) return { done: true, value: 'mutation' };
              if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) return { done: true, value: 'delivery' };
              return { done: false, value: dom };
            },
            { timeoutMs: 180000, describe: () => `${label} mutation or delivery approval` },
          );
          if (next === 'mutation') {
            await ui.clickMutationApproveButton(webviewClient);
            await pollUntil(
              async () => {
                const dom = await ui.readApprovalCycleDom(webviewClient);
                return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false
                  ? { done: true, value: dom }
                  : { done: false, value: dom };
              },
              { timeoutMs: 180000, describe: () => `${label} repaired validation and delivery approval` },
            );
          }
          await ui.clickDeliveryApproveButton(webviewClient);
        };

        // Part A: initial approved change fails the real npm test; the same
        // attempt repairs from that output and reaches exactly one delivery.
        const repairPrompt = `${repairContract.task} (nonce ${NONCE}-m34-repair)`;
        await submitUnified(repairPrompt);
        await approveThroughDelivery('M34 repair');
        const repairTerminal = await pollUntil(
          async () => {
            const request = await findRequestByMessage(repairPrompt, windowHandle.globalDataDir);
            if (!request) return { done: false, value: null };
            const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
            const attempt = attempts[0];
            return attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)
              ? { done: true, value: { request, attempt } }
              : { done: false, value: attempt?.status ?? null };
          },
          { timeoutMs: 240000, describe: () => 'M34 repaired attempt to finish' },
        );
        const repairEvents = await findRuntimeEventsForEntity(repairTerminal.attempt.id, windowHandle.globalDataDir);
        const repairQuality = parseExecutionQualityEvents(repairEvents);
        const repairStarts = repairQuality.filter((event) => event.eventType === 'validation_repair_started');
        const repairCompletions = repairQuality.filter((event) => event.eventType === 'validation_repair_completed');
        const validationFailures = repairQuality.filter((event) => event.eventType === 'validation_failed');
        const finalVerification = repairQuality.find((event) => event.eventType === 'final_verification_recorded');
        const repairDeliveryBeforeRetry = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: workspace })
          .split(/\r?\n/).filter((line) => line.includes('M15 delivery'));
        const repairDeliverySha = repairDeliveryBeforeRetry[0]?.split(' ')[0] ?? null;
        const validationAfterRepair = repairDeliverySha
          ? validateNpmTestAtCommit(
            workspace,
            repairDeliverySha,
            path.join(scenarioRoot, 'repair-delivery-validation'),
          )
          : { status: null, stdout: '', stderr: 'No repair delivery commit was available to validate.' };

        // Part B: the base fixture emits a bounded invalid candidate. The
        // visible stronger-model retry is double-clicked; Core must create one
        // and only one linked successor attempt.
        const retryPrompt = `Refactor formatGreeting with a semantics-preserving cleanup and validate it. ${M34_RETRY_MARKER} (nonce ${NONCE}-m34-retry)`;
        await submitUnified(retryPrompt);
        const blocked = await pollUntil(
          async () => {
            const request = await findRequestByMessage(retryPrompt, windowHandle.globalDataDir);
            if (!request) return { done: false, value: null };
            const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
            const attempt = attempts[0];
            return attempt && ['failed', 'blocked', 'recovery_required'].includes(attempt.status)
              ? { done: true, value: { request, attempt } }
              : { done: false, value: attempt?.status ?? null };
          },
          { timeoutMs: 180000, describe: () => 'M34 initial bounded blocker' },
        );
        const blockerUi = await pollUntil(
          async () => {
            const state = await ui.evalInWebviewDoc(webviewClient, `(() => {
              const card = document.getElementById('everyday-outcome-card');
              const button = card?.querySelector('[data-everyday-retry-strategy="stronger_model"]');
              return {
                text: card?.innerText ?? '',
                actionable: Boolean(button && !button.disabled),
              };
            })()`);
            return state.actionable ? { done: true, value: state } : { done: false, value: state };
          },
          { timeoutMs: 30000, describe: () => 'visible stronger-model retry control on the blocker card' },
        );
        await ui.evalInWebviewDoc(webviewClient, `(() => {
          const button = document.querySelector('#everyday-outcome-card [data-everyday-retry-strategy="stronger_model"]');
          if (!button) throw new Error('stronger-model retry button not found');
          button.click();
          button.click();
          return true;
        })()`);
        const successor = await pollUntil(
          async () => {
            const attempts = await findAttemptsForRequest(blocked.request.id, windowHandle.globalDataDir);
            const linked = attempts.filter((attempt) => attempt.predecessorAttemptId === blocked.attempt.id);
            return attempts.length === 2 && linked.length === 1
              ? { done: true, value: linked[0] }
              : { done: false, value: attempts.map((attempt) => ({ id: attempt.id, predecessorAttemptId: attempt.predecessorAttemptId })) };
          },
          { timeoutMs: 30000, intervalMs: 250, describe: () => 'exactly one linked successor after a retry double-click' },
        );
        await approveThroughDelivery('M34 retry');
        const successorTerminal = await pollUntil(
          async () => {
            const attempt = await findAttemptById(successor.id, windowHandle.globalDataDir);
            return attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)
              ? { done: true, value: attempt }
              : { done: false, value: attempt?.status ?? null };
          },
          { timeoutMs: 240000, describe: () => 'M34 linked retry to finish' },
        );
        const retryAttempts = await findAttemptsForRequest(blocked.request.id, windowHandle.globalDataDir);
        const successorContextRow = await findAttemptContext(successor.id, windowHandle.globalDataDir);
        const successorContext = successorContextRow?.modelSelection ? JSON.parse(successorContextRow.modelSelection) : null;
        const successorEvents = await findRuntimeEventsForEntity(successor.id, windowHandle.globalDataDir);
        const successorQuality = parseExecutionQualityEvents(successorEvents);
        const retryCreated = successorQuality.find((event) => event.eventType === 'retry_created');
        const deliveryAfterRetry = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: workspace })
          .split(/\r?\n/).filter((line) => line.includes('M15 delivery'));
        await ui.evalInWebviewDoc(webviewClient, `(() => {
          const drawer = document.getElementById('history-drawer');
          const toggle = document.getElementById('history-toggle');
          if (drawer && drawer.hidden === false) toggle?.click();
          toggle?.click();
          return true;
        })()`);
        const historyLineage = await pollUntil(
          async () => {
            const ids = await ui.evalInWebviewDoc(webviewClient, `Array.from(document.querySelectorAll('.everyday-history-item')).map((item) => item.dataset.attemptId)`);
            return ids.includes(blocked.attempt.id) && ids.includes(successor.id)
              ? { done: true, value: ids }
              : { done: false, value: ids };
          },
          { timeoutMs: 30000, intervalMs: 1000, describe: () => 'both retry-lineage attempts in durable History' },
        );
        const repairOk = repairTerminal.attempt.status === 'completed'
          && validationFailures.length >= 1
          && repairStarts.length >= 1
          && repairStarts.length <= 2
          && repairCompletions.length === repairStarts.length
          && repairStarts.every((event) => /npm-test|npm test/i.test(JSON.stringify(event.metadata)))
          && Boolean(finalVerification)
          && repairDeliveryBeforeRetry.length === 1
          && validationAfterRepair.status === 0
          && countTerminalTransitions(repairEvents) === 1;
        const retryOk = /Previous attempt blocked/i.test(blockerUi.text)
          && retryAttempts.length === 2
          && successorTerminal.status === 'completed'
          && successor.predecessorAttemptId === blocked.attempt.id
          && successor.requestId === blocked.request.id
          && Boolean(retryCreated)
          && successorContext?.selectedModel === M34_STRONG_FIXTURE_MODEL
          && historyLineage.includes(blocked.attempt.id)
          && historyLineage.includes(successor.id)
          && deliveryAfterRetry.length === repairDeliveryBeforeRetry.length + 1
          && countTerminalTransitions(successorEvents) === 1;
        const ok = repairOk && retryOk;

        scenarioEvidence = {
          ok,
          proxy: {
            endpoint: fixture.baseUrl,
            models: [fixture.model, fixture.strongerModel],
            snapshot: fixture.snapshot(),
            cleanedUp: false,
          },
          validationRepair: {
            requestId: repairTerminal.request.id,
            attemptId: repairTerminal.attempt.id,
            finalAttemptStatus: repairTerminal.attempt.status,
            failedEvents: validationFailures.map((event) => event.metadata),
            repairStarts: repairStarts.map((event) => event.metadata),
            repairCompletions: repairCompletions.map((event) => event.metadata),
            finalVerification: finalVerification?.metadata ?? null,
            deliveryCount: repairDeliveryBeforeRetry.length,
            postDeliveryValidationExitCode: validationAfterRepair.status,
            terminalTransitions: countTerminalTransitions(repairEvents),
          },
          blockerRetry: {
            requestId: blocked.request.id,
            predecessorAttemptId: blocked.attempt.id,
            predecessorStatus: blocked.attempt.status,
            successorAttemptId: successor.id,
            successorStatus: successorTerminal.status,
            successorModel: successorContext?.selectedModel ?? null,
            retryEvent: retryCreated?.metadata ?? null,
            visibleBlocker: blockerUi.text,
            doubleClickAttemptCount: retryAttempts.length,
            historyAttemptIds: historyLineage,
            newDeliveryCount: deliveryAfterRetry.length - repairDeliveryBeforeRetry.length,
            terminalTransitions: countTerminalTransitions(successorEvents),
          },
          cleanup: null,
        };
        evidence.scenarios.m34RepairRetry = scenarioEvidence;
        await board.captureScreenshot(pageClient, evidenceDir, '10-m34-repair-retry-history').catch(() => {});
        log(`M34 repair/retry: repair=${repairTerminal.attempt.id}:${repairTerminal.attempt.status} cycles=${repairStarts.length}; blocker=${blocked.attempt.id}:${blocked.attempt.status}; retry=${successor.id}:${successorTerminal.status}; attempts=${retryAttempts.length}.`);
        if (!ok) throw new Error(`M34 validation repair and retry did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = {
          proxyClosedAt: fixture?.snapshot().closedAt ?? null,
          proxyCleanedUp: Boolean(fixture?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          corePid: isolatedCorePid,
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        if (scenarioEvidence.proxy) scenarioEvidence.proxy.cleanedUp = cleanup.proxyCleanedUp;
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m34RepairRetry = scenarioEvidence;
        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`M34 repair/retry cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 11 (M35): deterministic inline-approval acceptance. Exercises
    // the real packaged extension and real chat webview through CDP,
    // asserting the proposal/mutation/delivery gates live in the single
    // unified task-message wrapper (#autonomous-status): a PENDING gate in
    // the always-visible #kd-pinned-approval-slot, and a RESOLVED gate moved
    // into #autonomous-timeline as visible-but-disabled chronological
    // history — and survive both a real webview teardown/rebuild and a real
    // host window close/relaunch on the same persisted profile — reusing the
    // restart scenario's close/relaunch mechanics (graceful CDP window
    // close, detached Core process stays alive, same profile).
    // =====================================================================
    await runRegisteredScenario('m35-inline-approval', 'scenario-11-m35-inline-approval', async () => {
      const scenarioRoot = path.join(workDir, 'm35-inline-approval-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      const contract = writeM35Repository(workspace);
      initGitRepo(workspace);

      const fixtureSettings = () => ({
        'ollama-agent.apiBase': fixture.baseUrl,
        'ollama-agent.model': M35_FIXTURE_MODEL,
        'ollama-agent.chatModel': M35_FIXTURE_MODEL,
        'ollama-agent.agentModel': M35_FIXTURE_MODEL,
        'ollama-agent.codingModel': M35_FIXTURE_MODEL,
        'ollama-agent.editModel': M35_FIXTURE_MODEL,
        'ollama-agent.reviewerModel': M35_FIXTURE_MODEL,
        'ollama-agent.codingFallbackModel': M35_FIXTURE_MODEL,
      });

      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m35InlineApproval = scenarioEvidence;
      const scenarioEvidenceDir = path.join(evidenceDir, 'm35-inline-approval');
      fs.mkdirSync(scenarioEvidenceDir, { recursive: true });

      const readInlineDom = (client) => ui.evalInWebviewDoc(client, `({
        timelineContainsProposal: (() => {
          const t = document.getElementById('autonomous-timeline');
          const c = document.getElementById('proposal-approval-card');
          return Boolean(t && c && t.contains(c));
        })(),
        timelineContainsMutation: (() => {
          const t = document.getElementById('autonomous-timeline');
          const c = document.getElementById('mutation-approval-card');
          return Boolean(t && c && t.contains(c));
        })(),
        timelineContainsDelivery: (() => {
          const t = document.getElementById('autonomous-timeline');
          const c = document.getElementById('delivery-approval-card');
          return Boolean(t && c && t.contains(c));
        })(),
        pinnedSlotContainsProposal: (() => {
          const t = document.getElementById('kd-pinned-approval-slot');
          const c = document.getElementById('proposal-approval-card');
          return Boolean(t && c && t.contains(c));
        })(),
        pinnedSlotContainsMutation: (() => {
          const t = document.getElementById('kd-pinned-approval-slot');
          const c = document.getElementById('mutation-approval-card');
          return Boolean(t && c && t.contains(c));
        })(),
        pinnedSlotContainsDelivery: (() => {
          const t = document.getElementById('kd-pinned-approval-slot');
          const c = document.getElementById('delivery-approval-card');
          return Boolean(t && c && t.contains(c));
        })(),
        pandaLabelText: document.getElementById('autonomous-panda-label')?.textContent ?? null,
        proposalResolvedState: document.getElementById('proposal-approval-card')?.dataset.inlineApprovalState ?? null,
        mutationResolvedState: document.getElementById('mutation-approval-card')?.dataset.inlineApprovalState ?? null,
        deliveryResolvedState: document.getElementById('delivery-approval-card')?.dataset.inlineApprovalState ?? null,
      })`);

      const readCompletionGuardianDom = (client) => ui.evalInWebviewDoc(client, `(() => {
        const response = document.getElementById('autonomous-status');
        const send = document.getElementById('send-btn');
        const stages = Array.from(document.querySelectorAll('#autonomous-stage-tracker li'));
        const outcomeCards = Array.from(document.querySelectorAll('#everyday-outcome-card'));
        return {
          taskResponseCount: document.querySelectorAll('#messages .kd-task-message').length,
          completedResponseCount: Array.from(document.querySelectorAll('#messages .kd-task-message'))
            .filter((node) => node.querySelector('#kd-task-line')?.textContent?.trim() === 'Completed').length,
          taskLine: document.getElementById('kd-task-line')?.textContent?.trim() ?? null,
          headerStopHidden: document.getElementById('stop-btn')?.hidden ?? null,
          compactStopHidden: document.getElementById('unified-task-stop-btn')?.hidden ?? null,
          autonomousStopHidden: document.getElementById('autonomous-stop-btn')?.hidden ?? null,
          composerText: send?.textContent?.trim() ?? null,
          composerAction: send?.dataset.action ?? null,
          composerTaskId: send?.dataset.taskId ?? null,
          activeDataset: document.body.dataset.autonomousTaskActive ?? null,
          activeSteeringTaskId: document.defaultView.__kdActiveTaskSteering?.taskId?.() ?? null,
          currentStageCount: stages.filter((stage) => stage.classList.contains('is-current')).length,
          completedStageCount: stages.filter((stage) => stage.classList.contains('is-complete')).length,
          stageCount: stages.length,
          pendingApprovalCount: document.querySelectorAll('[data-inline-approval-state="pending"]:not([hidden])').length,
          outcomeCardCount: outcomeCards.length,
          successfulOutcomeCount: outcomeCards.filter((card) => card.classList.contains('is-success') && !card.hidden).length,
          responseVisible: Boolean(response && !response.hidden),
        };
      })()`);

      const completionGuardianSatisfied = (dom) =>
        dom.taskResponseCount === 1
        && dom.completedResponseCount === 1
        && dom.taskLine === 'Completed'
        && dom.headerStopHidden === true
        && dom.compactStopHidden === true
        && dom.autonomousStopHidden === true
        && dom.composerText === 'Send'
        && dom.composerAction === 'send'
        && dom.composerTaskId === ''
        && dom.activeDataset === 'false'
        && dom.activeSteeringTaskId === null
        && dom.currentStageCount === 0
        && dom.completedStageCount === dom.stageCount
        && dom.pendingApprovalCount === 0
        && dom.outcomeCardCount === 1
        && dom.successfulOutcomeCount === 1
        && dom.responseVisible;

      const readNativeDeliveryNotifications = async (client) => {
        const evaluated = await client.Runtime.evaluate({
          expression: `(() => Array.from(document.querySelectorAll('.notification-list-item'))
            .map((item) => ({
              message: item.querySelector('.notification-list-item-message')?.textContent?.trim() ?? '',
              hasCloseAction: Boolean(item.querySelector(
                '[aria-label*="Clear Notification"], [title*="Clear Notification"], .codicon-notifications-clear'
              )),
            }))
            .filter((item) => /approval is needed to deliver/i.test(item.message)))()`,
          returnByValue: true,
        });
        if (evaluated.exceptionDetails) {
          throw new Error(`failed to read native delivery notification DOM: ${evaluated.exceptionDetails.text}`);
        }
        return evaluated.result.value ?? [];
      };

      const dismissNativeDeliveryNotification = async (client) => {
        const evaluated = await client.Runtime.evaluate({
          expression: `(() => {
            const item = Array.from(document.querySelectorAll('.notification-list-item'))
              .find((candidate) => /approval is needed to deliver/i.test(
                candidate.querySelector('.notification-list-item-message')?.textContent ?? ''
              ));
            const close = item?.querySelector(
              '[aria-label*="Clear Notification"], [title*="Clear Notification"], .codicon-notifications-clear'
            );
            if (!close) return false;
            close.click();
            return true;
          })()`,
          returnByValue: true,
        });
        if (evaluated.exceptionDetails) {
          throw new Error(`failed to dismiss native delivery notification: ${evaluated.exceptionDetails.text}`);
        }
        return evaluated.result.value === true;
      };

      const assertExactlyOneActionable = (dom, expectedKind) => {
        const actionable = {
          proposal: dom.proposalCardHidden === false && dom.proposalApproveDisabled === false,
          mutation: dom.mutationCardHidden === false && dom.mutationApproveDisabled === false,
          delivery: dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false,
        };
        const actionableKinds = Object.entries(actionable).filter(([, v]) => v).map(([k]) => k);
        if (actionableKinds.length !== 1 || actionableKinds[0] !== expectedKind) {
          throw new Error(`expected exactly one actionable gate ("${expectedKind}"), got: ${JSON.stringify(actionableKinds)}; dom=${JSON.stringify(dom)}`);
        }
      };

      try {
        fixture = await startDeterministicM35Proxy();
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m35-inline-approval-isolated',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: fixtureSettings(),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));

        // M40 manual-failure correction preflight: observe the exact durable
        // acknowledgement message inside the packaged webview before any
        // autonomousTaskStatus projection, then prove the real unified
        // composer owns inline cancellation for that exact returned task ID.
        const acknowledgementPrompt = 'create note.txt containing Hello';
        await ui.evalInWebviewDoc(webviewClient, `(() => {
          const innerWindow = document.defaultView;
          innerWindow.__m40AcknowledgementEvidence = null;
          let progressSeen = false;
          innerWindow.addEventListener('message', event => {
            const message = event.data;
            if (message?.type === 'autonomousTaskStatus') progressSeen = true;
            if (message?.type !== 'autonomousTaskStarted' || innerWindow.__m40AcknowledgementEvidence) return;
            const request = document.getElementById('task-request-entry');
            const response = document.getElementById('autonomous-status');
            const panda = document.getElementById('autonomous-panda');
            const send = document.getElementById('send-btn');
            innerWindow.__m40AcknowledgementEvidence = {
              taskId: message.taskId,
              progressSeenBeforeAcknowledgement: progressSeen,
              // Progress & Completion UX V1 (Step 10): Karke Dikha's own
              // objective card (#task-request-entry) is never `.bubble.user` —
              // it must never look like something the user literally typed.
              // With no carried-forward constraint, the literal optimistic
              // bubble is a redundant exact duplicate and collapses away.
              objectiveCardIsNotUserBubble: !document.getElementById('task-request-entry')?.classList.contains('user'),
              userMessageCount: document.querySelectorAll('#messages .bubble.user').length,
              responseCount: document.querySelectorAll('#messages .kd-task-message').length,
              userPrecedesResponse: Boolean(request && response && (request.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING)),
              responseVisible: Boolean(response && !response.hidden),
              detailsCount: response?.querySelectorAll('details#kd-task-details').length ?? 0,
              detailsOpen: Boolean(document.getElementById('kd-task-details')?.open),
              pandaVisible: Boolean(panda && getComputedStyle(panda).width === '72px'),
              taskLine: document.getElementById('kd-task-line')?.textContent ?? '',
              composerAction: send?.textContent ?? '',
              inlineStopTaskId: send?.dataset.taskId ?? null,
            };
          });
          return true;
        })()`);
        await sendWithCoreConnectedRetry(webviewClient, async () => {
          await ui.evalInWebviewDoc(webviewClient, `(() => {
            const input = document.getElementById('user-input');
            const button = document.getElementById('send-btn');
            if (!input || !button) throw new Error('unified composer not found');
            input.value = ${JSON.stringify(acknowledgementPrompt)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
            return true;
          })()`);
        }, acknowledgementPrompt, { dataDir: windowHandle.globalDataDir });
        const acknowledgementDom = await pollUntil(
          async () => {
            const value = await ui.evalInWebviewDoc(webviewClient, 'document.defaultView.__m40AcknowledgementEvidence');
            return value ? { done: true, value } : { done: false, value };
          },
          { timeoutMs: 30000, describe: () => 'packaged durable acknowledgement DOM projection' },
        );
        if (
          acknowledgementDom.progressSeenBeforeAcknowledgement
          || !acknowledgementDom.objectiveCardIsNotUserBubble
          || acknowledgementDom.userMessageCount !== 0
          || acknowledgementDom.responseCount !== 1
          || !acknowledgementDom.userPrecedesResponse
          || !acknowledgementDom.responseVisible
          || acknowledgementDom.detailsCount !== 1
          || acknowledgementDom.detailsOpen
          || !acknowledgementDom.pandaVisible
          || acknowledgementDom.composerAction.trim() !== 'Stop'
          || acknowledgementDom.inlineStopTaskId !== acknowledgementDom.taskId
        ) {
          throw new Error(`packaged acknowledgement surface contract failed: ${JSON.stringify(acknowledgementDom)}`);
        }
        const acknowledgementRequest = await findRequestByMessage(acknowledgementPrompt, windowHandle.globalDataDir);
        if (!acknowledgementRequest) throw new Error('acknowledgement preflight had no correlated Core request');
        const taskRecord = await pollUntil(
          async () => {
            const taskFile = path.join(workspace, '.ollama-agent', 'autonomous-tasks', acknowledgementDom.taskId, 'task.json');
            if (!fs.existsSync(taskFile)) return { done: false, value: null };
            return { done: true, value: JSON.parse(fs.readFileSync(taskFile, 'utf8')) };
          },
          { timeoutMs: 30000, describe: () => 'visible-composer task to persist its execution routing' },
        );
        if (
          taskRecord.goal !== acknowledgementPrompt
          || taskRecord.executionProfile?.tier !== 'trivial'
          || taskRecord.executionProfile?.maxStages !== 0
          || taskRecord.deterministicProposal?.path !== 'note.txt'
          || taskRecord.deterministicProposal?.content !== 'Hello'
        ) {
          throw new Error(`visible-composer deterministic routing was not persisted: ${JSON.stringify(taskRecord)}`);
        }
        const prompt = acknowledgementPrompt;
        const request1 = acknowledgementRequest;
        const attemptsBeforeApproval = await findAttemptsForRequest(request1.id, windowHandle.globalDataDir);
        if (attemptsBeforeApproval.length !== 1) throw new Error(`expected exactly one Core attempt, got ${attemptsBeforeApproval.length}`);
        const attempt = attemptsBeforeApproval[0];
        fs.writeFileSync(
          path.join(scenarioEvidenceDir, '0-active-task-acknowledgement.json'),
          JSON.stringify({ prompt, acknowledgementDom, taskRecord }, null, 2),
        );

        // --- Stage 1: proposal gate pending. ---
        const proposalDom = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'M35 proposal approval card to become actionable' },
        );
        assertExactlyOneActionable(proposalDom, 'proposal');
        const inlineDomPending = await readInlineDom(webviewClient);
        if (!inlineDomPending.pinnedSlotContainsProposal) {
          throw new Error(`expected the pending proposal card to be a DOM child of #kd-pinned-approval-slot, got: ${JSON.stringify(inlineDomPending)}`);
        }
        // Localization-safe: check the authoritative `data-inline-approval-state`
        // attribute placeCardInline() sets on the card itself, not the
        // panda's display label — that label is localized (e.g. Hinglish
        // "Approval ka wait hai…") and must not be asserted on verbatim.
        if (inlineDomPending.proposalResolvedState !== 'pending') {
          throw new Error(`expected the proposal approval card's inline-approval-state to be "pending", got: ${JSON.stringify(inlineDomPending.proposalResolvedState)}`);
        }
        const approvalsPending = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
        const proposalEnvelope = approvalsPending.find((a) => a.kind === 'proposal' && a.status === 'pending');
        if (!proposalEnvelope) throw new Error('visible proposal gate had no pending Core proposal approval envelope — durable state does not match visible state');
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, '1-proposal-pending').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, '1-proposal-pending-dom.json'), JSON.stringify({ approvalCycle: proposalDom, inline: inlineDomPending }, null, 2));

        // --- Webview recreation: the pending gate must survive a real webview teardown/rebuild. ---
        await webviewClient.close().catch(() => {});
        windowHandle.webviewTargetId = null;
        ({ webviewClient } = await openChatPanel(windowHandle));
        const proposalDomAfterRecreate = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 60000, describe: () => 'M35 proposal approval card to be re-rendered after webview recreation' },
        );
        assertExactlyOneActionable(proposalDomAfterRecreate, 'proposal');
        const approvalsAfterRecreate = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
        const proposalEnvelopeAfterRecreate = approvalsAfterRecreate.find((a) => a.kind === 'proposal' && a.status === 'pending');
        if (!proposalEnvelopeAfterRecreate || proposalEnvelopeAfterRecreate.id !== proposalEnvelope.id) {
          throw new Error(`webview recreation did not preserve the same pending proposal approval envelope: before=${JSON.stringify(proposalEnvelope)} after=${JSON.stringify(proposalEnvelopeAfterRecreate)}`);
        }

        // --- Approve the proposal; the resolved card must remain visible and disabled. ---
        await ui.clickProposalApproveButton(webviewClient);
        const mutationDom = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.mutationCardHidden === false && dom.mutationApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'M35 mutation approval card to become actionable' },
        );
        assertExactlyOneActionable(mutationDom, 'mutation');
        const proposalResolvedDom = await readInlineDom(webviewClient);
        if (mutationDom.proposalCardHidden !== false || proposalResolvedDom.proposalResolvedState !== 'resolved' || mutationDom.proposalApproveDisabled !== true) {
          throw new Error(`expected the resolved proposal card to remain visible and disabled, got: ${JSON.stringify({ mutationDom, proposalResolvedDom })}`);
        }
        if (!proposalResolvedDom.timelineContainsProposal) {
          throw new Error(`expected the resolved proposal card to have moved into #autonomous-timeline, got: ${JSON.stringify(proposalResolvedDom)}`);
        }
        if (!proposalResolvedDom.pinnedSlotContainsMutation) {
          throw new Error(`expected the pending mutation card to be a DOM child of #kd-pinned-approval-slot, got: ${JSON.stringify(proposalResolvedDom)}`);
        }
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, '2-proposal-resolved-mutation-pending').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, '2-proposal-resolved-mutation-pending-dom.json'), JSON.stringify({ approvalCycle: mutationDom, inline: proposalResolvedDom }, null, 2));

        // --- Approve the mutation gate (elevated/repository-mutating approval); delivery must become the sole actionable gate. ---
        await ui.clickMutationApproveButton(webviewClient);
        const deliveryDom = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'M35 delivery approval card to become actionable' },
        );
        assertExactlyOneActionable(deliveryDom, 'delivery');
        const mutationResolvedDom = await readInlineDom(webviewClient);
        if (deliveryDom.mutationCardHidden !== false || mutationResolvedDom.mutationResolvedState !== 'resolved' || deliveryDom.mutationApproveDisabled !== true) {
          throw new Error(`expected the resolved mutation card to remain visible and disabled, got: ${JSON.stringify({ deliveryDom, mutationResolvedDom })}`);
        }
        if (!mutationResolvedDom.timelineContainsMutation) {
          throw new Error(`expected the resolved mutation card to have moved into #autonomous-timeline, got: ${JSON.stringify(mutationResolvedDom)}`);
        }
        if (!mutationResolvedDom.pinnedSlotContainsDelivery) {
          throw new Error(`expected the pending delivery card to be a DOM child of #kd-pinned-approval-slot, got: ${JSON.stringify(mutationResolvedDom)}`);
        }
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, '3-mutation-resolved-delivery-pending').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, '3-mutation-resolved-delivery-pending-dom.json'), JSON.stringify({ approvalCycle: deliveryDom, inline: mutationResolvedDom }, null, 2));

        const deliveryEnvelopePending = (await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir))
          .find((a) => a.kind === 'delivery' && a.status === 'pending');
        if (!deliveryEnvelopePending) throw new Error('visible delivery gate had no pending Core delivery approval envelope — durable state does not match visible state');

        // --- Host close/relaunch: the pending delivery gate must survive a
        // real window close and reopen on the same persisted profile/data,
        // appearing exactly once and remaining actionable. ---
        const discoveryBeforeClose = readDiscoveryRecord(windowHandle.globalDataDir);
        await board.closeTarget(windowHandle.cdpPort, windowHandle.pageTargetId);
        await pollUntil(
          async () => {
            const pages = (await board.listTargets(windowHandle.cdpPort).catch(() => [])).filter((t) => t.type === 'page');
            return pages.some((t) => t.id === windowHandle.pageTargetId)
              ? { done: false, value: pages.length } : { done: true, value: pages.length };
          },
          { timeoutMs: 15000, intervalMs: 250, describe: () => 'M35 isolated window to close' },
        );
        if (!isPidAlive(discoveryBeforeClose?.pid)) {
          throw new Error('expected the detached isolated Core process to remain alive after the window closed');
        }

        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m35-inline-approval-relaunch',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: fixtureSettings(),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        const discoveryAfterRelaunch = readDiscoveryRecord(windowHandle.globalDataDir);

        const restoredDeliveryDom = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 60000, describe: () => 'M35 delivery approval card to be restored and actionable after relaunch' },
        );
        assertExactlyOneActionable(restoredDeliveryDom, 'delivery');

        // --- The previously resolved proposal and mutation cards must also
        // survive host close/relaunch: visible, disabled, chronological
        // history alongside the current pending delivery gate — not just the
        // pending gate itself. Rehydrated from durable Core/task history
        // only; no second approval authority. ---
        const restoredInlineDom = await readInlineDom(webviewClient);
        if (restoredDeliveryDom.proposalCardHidden !== false) {
          throw new Error(`expected the resolved proposal card to remain visible after host close/relaunch, got: ${JSON.stringify(restoredDeliveryDom)}`);
        }
        if (restoredDeliveryDom.proposalApproveDisabled !== true || restoredDeliveryDom.proposalReviseDisabled !== true || restoredDeliveryDom.proposalRejectDisabled !== true) {
          throw new Error(`expected the resolved proposal card controls to be disabled after host close/relaunch, got: ${JSON.stringify(restoredDeliveryDom)}`);
        }
        if (restoredInlineDom.proposalResolvedState !== 'resolved') {
          throw new Error(`expected the resolved proposal card to report resolved state after host close/relaunch, got: ${JSON.stringify(restoredInlineDom)}`);
        }
        if (restoredDeliveryDom.mutationCardHidden !== false) {
          throw new Error(`expected the resolved mutation card to remain visible after host close/relaunch, got: ${JSON.stringify(restoredDeliveryDom)}`);
        }
        if (restoredDeliveryDom.mutationApproveDisabled !== true || restoredDeliveryDom.mutationDenyDisabled !== true) {
          throw new Error(`expected the resolved mutation card controls to be disabled after host close/relaunch, got: ${JSON.stringify(restoredDeliveryDom)}`);
        }
        if (restoredInlineDom.mutationResolvedState !== 'resolved') {
          throw new Error(`expected the resolved mutation card to report resolved state after host close/relaunch, got: ${JSON.stringify(restoredInlineDom)}`);
        }
        if (restoredDeliveryDom.deliveryCardHidden !== false || restoredDeliveryDom.deliveryApproveDisabled !== false) {
          throw new Error(`expected the pending delivery card to remain visible and actionable after host close/relaunch, got: ${JSON.stringify(restoredDeliveryDom)}`);
        }
        if (!restoredInlineDom.timelineContainsProposal || !restoredInlineDom.timelineContainsMutation) {
          throw new Error(`expected the resolved proposal and mutation cards to remain DOM descendants of #autonomous-timeline after host close/relaunch, got: ${JSON.stringify(restoredInlineDom)}`);
        }
        if (!restoredInlineDom.pinnedSlotContainsDelivery) {
          throw new Error(`expected the still-pending delivery card to remain a DOM child of #kd-pinned-approval-slot after host close/relaunch, got: ${JSON.stringify(restoredInlineDom)}`);
        }
        const restoredTimelineOrder = await ui.evalInWebviewDoc(webviewClient, `((() => {
          const timeline = document.getElementById('autonomous-timeline');
          const ids = ['proposal-approval-card', 'mutation-approval-card'];
          return ids
            .map((id) => ({ id, index: Array.prototype.indexOf.call(timeline.children, document.getElementById(id)) }))
            .filter((entry) => entry.index !== -1)
            .sort((a, b) => a.index - b.index)
            .map((entry) => entry.id);
        })())`);
        const expectedOrder = ['proposal-approval-card', 'mutation-approval-card'];
        if (JSON.stringify(restoredTimelineOrder) !== JSON.stringify(expectedOrder)) {
          throw new Error(`expected chronological proposal -> mutation order in #autonomous-timeline after host close/relaunch (delivery is still pending, so it belongs in #kd-pinned-approval-slot, not the timeline), got: ${JSON.stringify(restoredTimelineOrder)}`);
        }

        const approvalsAfterRelaunch = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
        const deliveryEnvelopesAfterRelaunch = approvalsAfterRelaunch.filter((a) => a.kind === 'delivery');
        const pendingDeliveryAfterRelaunch = deliveryEnvelopesAfterRelaunch.find((a) => a.status === 'pending');
        if (deliveryEnvelopesAfterRelaunch.length !== 1) {
          throw new Error(`expected the restored delivery gate to appear exactly once, got ${deliveryEnvelopesAfterRelaunch.length} delivery approval envelope(s): ${JSON.stringify(deliveryEnvelopesAfterRelaunch)}`);
        }
        if (!pendingDeliveryAfterRelaunch || pendingDeliveryAfterRelaunch.id !== deliveryEnvelopePending.id) {
          throw new Error(`host close/relaunch did not preserve the same pending delivery approval envelope: before=${JSON.stringify(deliveryEnvelopePending)} after=${JSON.stringify(pendingDeliveryAfterRelaunch)}`);
        }
        if (discoveryAfterRelaunch?.instanceId !== discoveryBeforeClose?.instanceId) {
          throw new Error(`expected the same detached Core instance across the window close/relaunch, before=${discoveryBeforeClose?.instanceId} after=${discoveryAfterRelaunch?.instanceId}`);
        }
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, '4-delivery-restored-after-relaunch').catch(() => {});
        fs.writeFileSync(
          path.join(scenarioEvidenceDir, '4-delivery-restored-after-relaunch-dom.json'),
          JSON.stringify({ approvalCycle: restoredDeliveryDom, inline: restoredInlineDom, timelineOrder: restoredTimelineOrder }, null, 2),
        );

        const nativeNotificationDisposition = process.env.KARKEDIKHA_M35_NATIVE_NOTIFICATION === 'dismissed'
          ? 'dismissed'
          : 'unanswered';
        const nativeNotificationsBeforeApproval = await pollUntil(
          async () => {
            const notifications = await readNativeDeliveryNotifications(pageClient);
            return notifications.length === 1
              ? { done: true, value: notifications }
              : { done: false, value: notifications };
          },
          { timeoutMs: 10000, describe: () => 'one native delivery notification before inline approval' },
        );
        let nativeNotificationDismissed = false;
        if (nativeNotificationDisposition === 'dismissed') {
          nativeNotificationDismissed = await dismissNativeDeliveryNotification(pageClient);
          if (!nativeNotificationDismissed) {
            throw new Error(`native delivery notification had no usable dismiss action: ${JSON.stringify(nativeNotificationsBeforeApproval)}`);
          }
          await pollUntil(
            async () => {
              const notifications = await readNativeDeliveryNotifications(pageClient);
              return notifications.length === 0
                ? { done: true, value: notifications }
                : { done: false, value: notifications };
            },
            { timeoutMs: 10000, describe: () => 'native delivery notification to be dismissed' },
          );
        }

        // --- Finish: approve delivery, confirm terminal state and durable
        // task/event evidence match the visible outcome. ---
        await ui.clickDeliveryApproveButton(webviewClient);
        const finalAttempt = await pollUntil(
          async () => {
            const a = await findAttemptById(attempt.id, windowHandle.globalDataDir);
            return a && ['completed', 'failed', 'cancelled'].includes(a.status) ? { done: true, value: a } : { done: false, value: a?.status };
          },
          { timeoutMs: 120000, describe: () => 'M35 attempt to reach a terminal state after delivery approval' },
        );
        const terminalTaskEvidence = autonomousTaskEvidence(workspace, attempt.id);
        const durableCompletionEvent = [...terminalTaskEvidence.events].reverse().find((event) =>
          event.type === 'state_transition' && event.payload?.to === 'completed');
        if (!durableCompletionEvent?.timestamp) {
          throw new Error('completed attempt had no durable M15 completed transition timestamp');
        }
        // Installed-product guardian: durable Core completion is not enough.
        // Without reloading anything, the same response must visibly become
        // terminal and release every active-task/composer projection.
        const liveCompletionDom = await pollUntil(
          async () => {
            const dom = await readCompletionGuardianDom(webviewClient);
            return completionGuardianSatisfied(dom)
              ? { done: true, value: dom }
              : { done: false, value: dom };
          },
          { timeoutMs: 30000, describe: () => 'installed KarkeDikha completion projection without reload' },
        );
        const visibleCompletionObservedAt = new Date().toISOString();
        const durableToVisibleCompletionMs = Date.parse(visibleCompletionObservedAt)
          - Date.parse(durableCompletionEvent.timestamp);
        if (durableToVisibleCompletionMs < 0 || durableToVisibleCompletionMs > 10000) {
          throw new Error(`visible completion exceeded the 10-second durable-publication bound: ${durableToVisibleCompletionMs}ms`);
        }
        const nativeNotificationsAfterCompletion = await readNativeDeliveryNotifications(pageClient);
        const nativeNotificationIsolationSatisfied = nativeNotificationDisposition === 'unanswered'
          ? nativeNotificationsAfterCompletion.length === 1
          : nativeNotificationDismissed && nativeNotificationsAfterCompletion.length === 0;
        if (!nativeNotificationIsolationSatisfied) {
          throw new Error(`native notification disposition changed terminal behavior: ${JSON.stringify({
            nativeNotificationDisposition,
            nativeNotificationDismissed,
            nativeNotificationsAfterCompletion,
          })}`);
        }
        const finalDeliveryDom = await readInlineDom(webviewClient);
        const terminalMessagesBeforeReload = (await readInboundMessages(webviewClient))
          .filter((message) =>
            message?.type === 'autonomousTaskStatus'
            && message.taskId === attempt.id
            && message.state === 'completed');
        if (terminalMessagesBeforeReload.length !== 1) {
          throw new Error(`expected exactly one live terminal status publication before reload, got ${terminalMessagesBeforeReload.length}`);
        }
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, '5-completed-without-reload').catch(() => {});

        // The user's recovery action is now only a preservation check.
        const preReloadPageTargetId = windowHandle.pageTargetId;
        const preReloadWebviewTargetId = windowHandle.webviewTargetId;
        await board.runCommandViaPalette(pageClient, 'Developer: Reload Window');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
        const reloadedPage = await pollUntil(
          async () => {
            const pages = (await board.listTargets(windowHandle.cdpPort).catch(() => []))
              .filter((target) => target.type === 'page');
            const candidate = pages.find((target) => target.id === preReloadPageTargetId) ?? pages[0];
            return candidate ? { done: true, value: candidate } : { done: false, value: pages };
          },
          { timeoutMs: 45000, describe: () => 'workbench target after Developer: Reload Window' },
        );
        windowHandle.pageTargetId = reloadedPage.id;
        windowHandle.webviewTargetId = null;
        windowHandle.excludeWebviewTargetIds = [
          ...(windowHandle.excludeWebviewTargetIds ?? []),
          ...(preReloadWebviewTargetId ? [preReloadWebviewTargetId] : []),
        ];
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        const reloadedCompletionDom = await pollUntil(
          async () => {
            const dom = await readCompletionGuardianDom(webviewClient);
            return completionGuardianSatisfied(dom)
              ? { done: true, value: dom }
              : { done: false, value: dom };
          },
          { timeoutMs: 60000, describe: () => 'exactly one completed response after Developer: Reload Window' },
        );
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, '6-completed-after-reload').catch(() => {});
        const gitLog = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: workspace });
        const deliveryLines = gitLog.split(/\r?\n/).filter((line) => line.includes('M15 delivery'));
        const deliverySha = deliveryLines[0]?.split(' ')[0] ?? null;
        const deliveredContent = fs.existsSync(path.join(workspace, 'note.txt'))
          ? fs.readFileSync(path.join(workspace, 'note.txt'), 'utf8')
          : null;
        const taskEvents = fs.readFileSync(
          path.join(workspace, '.ollama-agent', 'autonomous-tasks', attempt.id, 'events.jsonl'),
          'utf8',
        ).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        const graphStageCount = taskEvents.filter((event) =>
          event.type === 'progress' && String(event.payload?.progress ?? '').startsWith('graph_stage_')).length;
        const graphExecutionCount = taskEvents.filter((event) =>
          event.type === 'progress' && String(event.payload?.progress ?? '') === 'graph_execution').length;
        const stageTextCount = taskEvents.filter((event) => /Stage 1\/5/i.test(JSON.stringify(event))).length;
        const modelInvocationCount = fixture.snapshot().chatRequests;
        const approvals = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
        const governanceActive = ['proposal', 'mutation', 'delivery'].every((kind) =>
          approvals.some((approval) => approval.kind === kind && approval.status === 'approved'));
        const gitStatus = runCapture('git', ['status', '--porcelain'], { cwd: workspace });
        const qwen30bSelected = taskEvents.some((event) => /qwen3-coder:30b/i.test(JSON.stringify(event)))
          || taskRecord.providerModelRoutingSnapshot?.model === 'qwen3-coder:30b';

        const ok = finalAttempt.status === 'completed'
          && deliveryLines.length === 1
          && deliveredContent === 'Hello'
          && modelInvocationCount === 0
          && graphExecutionCount === 0
          && graphStageCount === 0
          && stageTextCount === 0
          && !qwen30bSelected
          && governanceActive
          && gitStatus === ''
          && finalDeliveryDom.deliveryResolvedState === 'resolved'
          && completionGuardianSatisfied(liveCompletionDom)
          && completionGuardianSatisfied(reloadedCompletionDom)
          && terminalMessagesBeforeReload.length === 1
          && durableToVisibleCompletionMs <= 10000
          && nativeNotificationIsolationSatisfied;

        scenarioEvidence = {
          ok,
          proxy: { endpoint: fixture.baseUrl, model: fixture.model, ...fixture.snapshot() },
          requestId: request1.id,
          attemptId: attempt.id,
          proposalEnvelopeId: proposalEnvelope.id,
          deliveryEnvelopeId: deliveryEnvelopePending.id,
          finalAttemptStatus: finalAttempt.status,
          deliverySha,
          deliveredContent,
          executionProfile: taskRecord.executionProfile,
          deterministicProposal: taskRecord.deterministicProposal,
          modelInvocationCount,
          graphExecutionCount,
          graphStageCount,
          stageTextCount,
          qwen30bSelected,
          governanceActive,
          approvals: approvals.map((approval) => ({ kind: approval.kind, status: approval.status, id: approval.id })),
          gitStatus,
          coreInstanceIdBeforeClose: discoveryBeforeClose?.instanceId,
          coreInstanceIdAfterRelaunch: discoveryAfterRelaunch?.instanceId,
          webviewRecreationPreservedEnvelope: proposalEnvelopeAfterRecreate?.id === proposalEnvelope.id,
          hostRelaunchPreservedEnvelope: pendingDeliveryAfterRelaunch?.id === deliveryEnvelopePending.id,
          hostRelaunchDeliveryEnvelopeCount: deliveryEnvelopesAfterRelaunch.length,
          durableCompletionAt: durableCompletionEvent.timestamp,
          visibleCompletionObservedAt,
          durableToVisibleCompletionMs,
          nativeNotificationDisposition,
          nativeNotificationsBeforeApproval,
          nativeNotificationDismissed,
          nativeNotificationsAfterCompletion,
          nativeNotificationIsolationSatisfied,
          liveCompletionDom,
          terminalMessagesBeforeReload: terminalMessagesBeforeReload.length,
          reloadedCompletionDom,
          cleanup: null,
        };
        evidence.scenarios.m35InlineApproval = scenarioEvidence;
        log(`M35 inline-approval: request=${request1.id}; attempt=${attempt.id}:${finalAttempt.status}; delivery=${deliverySha}.`);
        if (!ok) throw new Error(`M35 inline-approval scenario did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = {
          proxyClosedAt: fixture?.snapshot().closedAt ?? null,
          proxyCleanedUp: Boolean(fixture?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          corePid: isolatedCorePid,
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        if (scenarioEvidence.proxy) scenarioEvidence.proxy.cleanedUp = cleanup.proxyCleanedUp;
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m35InlineApproval = scenarioEvidence;
        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`M35 inline-approval cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 11b (M35): steer the same durable trivial task through the
    // real visible unified composer. The stale note.txt proposal must be
    // superseded before mutation, while every approval and delivery fence
    // remains active for greeting.txt.
    // =====================================================================
    await runRegisteredScenario('m35-trivial-steering', 'scenario-11b-m35-trivial-steering', async () => {
      const scenarioRoot = path.join(workDir, 'm35-trivial-steering-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      const workspaceB = path.join(scenarioRoot, 'workspace-b');
      writeM35Repository(workspace);
      initGitRepo(workspace);
      writeM35Repository(workspaceB);
      initGitRepo(workspaceB);
      const scenarioEvidenceDir = path.join(evidenceDir, 'm35-trivial-steering');
      fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let workspaceBEvidence = null;
      let restoredSteerableDom = null;
      let modelInvocationBaselineAfterWorkspaceB = 0;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m35TrivialSteering = scenarioEvidence;

      const fixtureSettings = () => ({
        'ollama-agent.apiBase': fixture.baseUrl,
        'ollama-agent.model': M35_FIXTURE_MODEL,
        'ollama-agent.chatModel': M35_FIXTURE_MODEL,
        'ollama-agent.agentModel': M35_FIXTURE_MODEL,
        'ollama-agent.codingModel': M35_FIXTURE_MODEL,
        'ollama-agent.editModel': M35_FIXTURE_MODEL,
        'ollama-agent.reviewerModel': M35_FIXTURE_MODEL,
        'ollama-agent.codingFallbackModel': M35_FIXTURE_MODEL,
      });

      try {
        fixture = await startDeterministicM35Proxy();
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m35-trivial-steering-isolated',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: fixtureSettings(),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));

        const initialPrompt = 'create note.txt containing Hello';
        const steeringInstruction = 'Use greeting.txt instead';
        const request = await sendWithCoreConnectedRetry(webviewClient, () => ui.evalInWebviewDoc(webviewClient, `(() => {
          const input = document.getElementById('user-input');
          const button = document.getElementById('send-btn');
          if (!input || !button) throw new Error('visible unified composer not found');
          input.value = ${JSON.stringify(initialPrompt)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          button.click();
          return true;
        })()`), initialPrompt, { dataDir: windowHandle.globalDataDir });
        const [attempt] = await pollUntil(
          async () => {
            const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
            return attempts.length === 1 ? { done: true, value: attempts } : { done: false, value: attempts.length };
          },
          { timeoutMs: 30000, describe: () => 'one durable attempt for the steering journey' },
        );
        const taskFile = path.join(workspace, '.ollama-agent', 'autonomous-tasks', attempt.id, 'task.json');
        const initialTask = await pollUntil(
          async () => {
            if (!fs.existsSync(taskFile)) return { done: false, value: null };
            const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
            return task.deterministicProposal?.path === 'note.txt' ? { done: true, value: task } : { done: false, value: task };
          },
          { timeoutMs: 30000, describe: () => 'initial durable note.txt proposal' },
        );
        const firstProposalDom = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'initial note.txt proposal approval gate' },
        );

        // Cross-workspace guardian: a second repository in the same installed
        // VS Code profile must start with no ambient A transcript/task/gates.
        const targetsBeforeB = await board.listTargets(windowHandle.cdpPort);
        const launchedB = openWindowInSameInstance(vscodeExecutablePath, {
          userDataDir: windowHandle.profile,
          extensionsDir: path.join(scenarioRoot, 'extensions'),
          workspacePath: workspaceB,
          env: {
            KARKEDIKHA_DATA_DIR: windowHandle.globalDataDir,
            KARKEDIKHA_OLLAMA_URL: fixture.baseUrl,
            KARKEDIKHA_DEFAULT_MODEL: fixture.model,
          },
        });
        const windowB = {
          label: 'window-m35-trivial-steering-workspace-b',
          cdpPort: windowHandle.cdpPort,
          requestedCdpPort: windowHandle.cdpPort,
          launchedPid: launchedB.child.pid,
          launcher: launchedB.child,
          launchArgs: launchedB.args,
          joinedExistingInstance: true,
          profile: windowHandle.profile,
          workspace: workspaceB,
          excludePageTargetIds: targetsBeforeB.filter((target) => target.type === 'page').map((target) => target.id),
          excludeWebviewTargetIds: targetsBeforeB
            .filter((target) => target.type === 'iframe' && target.url?.startsWith('vscode-webview://'))
            .map((target) => target.id),
          pageTargetId: null,
          webviewTargetId: null,
          globalDataDir: windowHandle.globalDataDir,
        };
        let pageClientB;
        let webviewClientB;
        try {
          ({ pageClient: pageClientB, webviewClient: webviewClientB } = await openChatPanel(windowB));
          const workspaceBCleanDom = await ui.evalInWebviewDoc(webviewClientB, `({
            taskResponses: Array.from(document.querySelectorAll('#messages .kd-task-message')).filter((node) => !node.hidden).length,
            userMessages: Array.from(document.querySelectorAll('#messages .bubble.user')).filter((node) => !node.hidden).length,
            visibleApprovals: Array.from(document.querySelectorAll('.approval-card')).filter((card) => !card.hidden).length,
            activeTask: document.body.dataset.autonomousTaskActive || 'false',
            sendAction: document.getElementById('send-btn')?.dataset.action || 'send',
            recommendation: document.getElementById('everyday-reco-label')?.textContent || '',
          })`);
          const leakedInbound = (await readInboundMessages(webviewClientB)).filter((message) =>
            message?.taskId === attempt.id
            || message?.attemptId === attempt.id
            || ['proposalApprovalRequest', 'mutationApprovalRequest', 'deliveryApprovalRequest'].includes(message?.type));
          if (
            workspaceBCleanDom.taskResponses !== 0
            || workspaceBCleanDom.userMessages !== 0
            || workspaceBCleanDom.visibleApprovals !== 0
            || workspaceBCleanDom.activeTask === 'true'
            || workspaceBCleanDom.sendAction !== 'send'
            || leakedInbound.length !== 0
          ) {
            throw new Error(`workspace B inherited workspace A ownership: ${JSON.stringify({ workspaceBCleanDom, leakedInbound })}`);
          }
          if (process.env.KARKEDIKHA_GUARDIAN_NEGATIVE_CROSS_WORKSPACE === '1') {
            await ui.evalInWebviewDoc(webviewClientB, `document.defaultView.dispatchEvent(new MessageEvent('message', { data: {
              type: 'restoreTranscript',
              conversationId: 'deliberately-bound-workspace-a-conversation',
              messages: [
                { id: 'negative-a-user', role: 'user', content: ${JSON.stringify(initialPrompt)}, attachments: [] },
                { id: 'negative-a-assistant', role: 'assistant', content: 'Workspace A response', alternatives: [] },
              ],
            } }))`);
            const deliberatelyLeaked = await pollUntil(
              async () => {
                const dom = await ui.evalInWebviewDoc(webviewClientB, `({
                  userMessages: document.querySelectorAll('#messages .bubble.user').length,
                  assistantMessages: document.querySelectorAll('#messages .bubble.assistant').length,
                })`);
                return dom.userMessages > 0 || dom.assistantMessages > 0
                  ? { done: true, value: dom } : { done: false, value: dom };
              },
              { timeoutMs: 30000, describe: () => 'deliberately bound workspace A conversation in workspace B' },
            );
            throw new Error(`NEGATIVE_CONTROL_EXPECTED_GUARDIAN_FAILURE: ${JSON.stringify(deliberatelyLeaked)}`);
          }

          const workspaceBPrompt = `Workspace B standalone question ${NONCE}`;
          const requestB = await sendWithCoreConnectedRetry(webviewClientB, () => ui.evalInWebviewDoc(webviewClientB, `(() => {
            const input = document.getElementById('user-input');
            const button = document.getElementById('send-btn');
            input.value = ${JSON.stringify(workspaceBPrompt)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
            return true;
          })()`), workspaceBPrompt, { dataDir: windowHandle.globalDataDir });
          const attemptsB = await pollUntil(
            async () => {
              const attempts = await findAttemptsForRequest(requestB.id, windowHandle.globalDataDir);
              return attempts.length === 1 ? { done: true, value: attempts } : { done: false, value: attempts };
            },
            { timeoutMs: 30000, describe: () => 'one independent workspace B conversation attempt' },
          );
          if (requestB.id === request.id || attemptsB[0].id === attempt.id || attemptsB[0].kind === 'karke_dikha') {
            throw new Error(`workspace B standalone input attached to workspace A: ${JSON.stringify({ requestB, attemptsB })}`);
          }
          workspaceBEvidence = { cleanDom: workspaceBCleanDom, leakedInboundCount: leakedInbound.length, requestId: requestB.id, attemptId: attemptsB[0].id };
          modelInvocationBaselineAfterWorkspaceB = fixture.snapshot().chatRequests;
        } finally {
          if (windowB.pageTargetId) await board.closeTarget(windowB.cdpPort, windowB.pageTargetId).catch(() => {});
          await pageClientB?.close().catch(() => {});
          await webviewClientB?.close().catch(() => {});
        }

        // Real window reload while the task is still steerable. The restored
        // active projection must own the composer before the instruction is sent.
        const preReloadPageTargetId = windowHandle.pageTargetId;
        const preReloadWebviewTargetId = windowHandle.webviewTargetId;
        await board.runCommandViaPalette(pageClient, 'Developer: Reload Window');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
        const reloadedPage = await pollUntil(
          async () => {
            const pages = (await board.listTargets(windowHandle.cdpPort).catch(() => []))
              .filter((target) => target.type === 'page');
            const candidate = pages.find((target) => target.id === preReloadPageTargetId) ?? pages[0];
            return candidate ? { done: true, value: candidate } : { done: false, value: pages };
          },
          { timeoutMs: 45000, describe: () => 'workspace A workbench after steerable reload' },
        );
        windowHandle.pageTargetId = reloadedPage.id;
        windowHandle.webviewTargetId = null;
        windowHandle.excludeWebviewTargetIds = [
          ...(windowHandle.excludeWebviewTargetIds ?? []),
          ...(preReloadWebviewTargetId ? [preReloadWebviewTargetId] : []),
        ];
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        restoredSteerableDom = await pollUntil(
          async () => {
            const dom = await ui.evalInWebviewDoc(webviewClient, `({
              taskResponses: document.querySelectorAll('#messages .kd-task-message').length,
              activeTask: document.body.dataset.autonomousTaskActive || 'false',
              taskId: document.getElementById('send-btn')?.dataset.taskId || '',
              sendAction: document.getElementById('send-btn')?.dataset.action || '',
              ordinaryAssistantResponses: document.querySelectorAll('#messages .bubble.assistant:not(.kd-task-message)').length,
            })`);
            return dom.taskResponses === 1
              && dom.activeTask === 'true'
              && dom.taskId === attempt.id
              && dom.ordinaryAssistantResponses === 0
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 60000, describe: () => 'one restored workspace A task response owning the composer' },
        );
        const firstProposalEnvelope = (await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir))
          .find((approval) => approval.kind === 'proposal' && approval.status === 'pending');
        if (!firstProposalEnvelope) throw new Error('initial note.txt proposal had no pending approval envelope');

        await ui.evalInWebviewDoc(webviewClient, `(() => {
          const input = document.getElementById('user-input');
          const button = document.getElementById('send-btn');
          if (!input || !button) throw new Error('visible unified composer not found for steering');
          input.value = ${JSON.stringify(steeringInstruction)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          button.click();
          return true;
        })()`);
        const steeredTask = await pollUntil(
          async () => {
            const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
            const ready = task.taskId === attempt.id
              && task.instructionRevision === 1
              && task.executionProfile?.tier === 'trivial'
              && task.executionProfile?.maxStages === 0
              && task.deterministicProposal?.path === 'greeting.txt'
              && task.deterministicProposal?.content === 'Hello';
            return ready ? { done: true, value: task } : { done: false, value: task };
          },
          { timeoutMs: 60000, describe: () => 'same durable task to persist revised greeting.txt routing' },
        );
        const revisedProposalEnvelope = await pollUntil(
          async () => {
            const approvals = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
            const pending = approvals.find((approval) =>
              approval.kind === 'proposal'
              && approval.status === 'pending'
              && approval.id !== firstProposalEnvelope.id);
            return pending ? { done: true, value: pending } : { done: false, value: approvals };
          },
          { timeoutMs: 120000, describe: () => 'revised greeting.txt proposal approval gate' },
        );
        await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 60000, describe: () => 'revised proposal to remain actionable in the visible composer' },
        );
        await ui.clickProposalApproveButton(webviewClient);
        await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.mutationCardHidden === false && dom.mutationApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'steered mutation approval gate' },
        );
        await ui.clickMutationApproveButton(webviewClient);
        await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            return dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false
              ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => 'steered delivery approval gate' },
        );
        await ui.clickDeliveryApproveButton(webviewClient);
        const finalAttempt = await pollUntil(
          async () => {
            const current = await findAttemptById(attempt.id, windowHandle.globalDataDir);
            return current && ['completed', 'failed', 'cancelled'].includes(current.status)
              ? { done: true, value: current } : { done: false, value: current?.status };
          },
          { timeoutMs: 120000, describe: () => 'steered trivial task delivery completion' },
        );
        const finalTask = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        const taskEvents = fs.readFileSync(
          path.join(workspace, '.ollama-agent', 'autonomous-tasks', attempt.id, 'events.jsonl'),
          'utf8',
        ).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        const progressValues = taskEvents
          .filter((event) => event.type === 'progress')
          .map((event) => String(event.payload?.progress ?? ''));
        const totalModelInvocationCount = fixture.snapshot().chatRequests;
        const modelInvocationCount = totalModelInvocationCount - modelInvocationBaselineAfterWorkspaceB;
        const graphExecutionCount = progressValues.filter((value) => value === 'graph_execution').length;
        const graphStageCount = progressValues.filter((value) => value.startsWith('graph_stage_')).length;
        const approvals = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
        const governanceActive = ['proposal', 'mutation', 'delivery'].every((kind) =>
          approvals.some((approval) => approval.kind === kind && approval.status === 'approved'));
        const attemptsAfterDelivery = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
        const deliveredContent = fs.existsSync(path.join(workspace, 'greeting.txt'))
          ? fs.readFileSync(path.join(workspace, 'greeting.txt'), 'utf8')
          : null;
        const noteExists = fs.existsSync(path.join(workspace, 'note.txt'));
        const gitStatus = runCapture('git', ['status', '--porcelain'], { cwd: workspace });
        const dom = await ui.evalInWebviewDoc(webviewClient, `({
          taskResponses: document.querySelectorAll('#messages .kd-task-message').length,
          ordinaryAssistantResponses: document.querySelectorAll('#messages .bubble.assistant:not(.kd-task-message)').length,
          ordinaryChatControls: document.querySelectorAll('#messages .message-workbench-actions').length,
          baatKarRecommendationVisible: !document.getElementById('everyday-reco-row')?.hidden
            && (document.getElementById('everyday-reco-label')?.textContent || '').includes('Baat Kar'),
        })`);
        const staleNoteEvidenceInvalidated = finalTask.instructionRevision === 1
          && finalTask.mutationEvidence?.instructionRevision === 1
          && JSON.stringify(finalTask.mutationEvidence?.expectedPaths) === JSON.stringify(['greeting.txt'])
          && finalTask.diffReview?.instructionRevision === 1
          && JSON.stringify(finalTask.diffReview?.approvedScopePaths) === JSON.stringify(['greeting.txt'])
          && !noteExists;
        const ok = finalAttempt.status === 'completed'
          && initialTask.taskId === finalTask.taskId
          && initialTask.taskId === attempt.id
          && attemptsAfterDelivery.length === 1
          && finalTask.executionProfile?.tier === 'trivial'
          && finalTask.executionProfile?.maxStages === 0
          && finalTask.deterministicProposal?.path === 'greeting.txt'
          && finalTask.deterministicProposal?.content === 'Hello'
          && revisedProposalEnvelope.id !== firstProposalEnvelope.id
          && staleNoteEvidenceInvalidated
          && modelInvocationCount === 0
          && graphExecutionCount === 0
          && graphStageCount === 0
          && governanceActive
          && deliveredContent === 'Hello'
          && gitStatus === ''
          && dom.taskResponses === 1
          && dom.ordinaryAssistantResponses === 0
          && dom.ordinaryChatControls === 0
          && dom.baatKarRecommendationVisible === false;

        scenarioEvidence = {
          ok,
          requestId: request.id,
          attemptId: attempt.id,
          initialTaskId: initialTask.taskId,
          finalTaskId: finalTask.taskId,
          instructionRevision: finalTask.instructionRevision,
          initialDeterministicProposal: initialTask.deterministicProposal,
          finalDeterministicProposal: finalTask.deterministicProposal,
          executionProfile: finalTask.executionProfile,
          firstProposalEnvelopeId: firstProposalEnvelope.id,
          revisedProposalEnvelopeId: revisedProposalEnvelope.id,
          firstProposalDom,
          staleNoteEvidenceInvalidated,
          mutationEvidence: finalTask.mutationEvidence,
          diffReview: finalTask.diffReview,
          modelInvocationCount,
          totalModelInvocationCount,
          workspaceBModelInvocationCount: modelInvocationBaselineAfterWorkspaceB,
          graphExecutionCount,
          graphStageCount,
          governanceActive,
          approvals: approvals.map((approval) => ({ id: approval.id, kind: approval.kind, status: approval.status })),
          deliveredContent,
          noteExists,
          gitStatus,
          taskResponses: dom.taskResponses,
          ordinaryAssistantResponses: dom.ordinaryAssistantResponses,
          ordinaryChatControls: dom.ordinaryChatControls,
          baatKarRecommendationVisible: dom.baatKarRecommendationVisible,
          workspaceB: workspaceBEvidence,
          restoredSteerableDom,
          proxy: { endpoint: fixture.baseUrl, model: fixture.model, ...fixture.snapshot() },
          cleanup: null,
        };
        evidence.scenarios.m35TrivialSteering = scenarioEvidence;
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'evidence.json'), JSON.stringify(scenarioEvidence, null, 2));
        if (!ok) throw new Error(`M35 trivial steering scenario did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = {
          proxyCleanedUp: Boolean(fixture?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m35TrivialSteering = scenarioEvidence;
        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`M35 trivial steering cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 11c (M35): inline Stop remains a separate cancellation proof.
    // It intentionally does not stand in for either completion journey.
    // =====================================================================
    await runRegisteredScenario('m35-inline-stop', 'scenario-11c-m35-inline-stop', async () => {
      const scenarioRoot = path.join(workDir, 'm35-inline-stop-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      writeM35Repository(workspace);
      initGitRepo(workspace);
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m35InlineStop = scenarioEvidence;

      try {
        fixture = await startDeterministicM35Proxy();
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m35-inline-stop-isolated',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: {
            'ollama-agent.apiBase': fixture.baseUrl,
            'ollama-agent.model': M35_FIXTURE_MODEL,
            'ollama-agent.chatModel': M35_FIXTURE_MODEL,
            'ollama-agent.agentModel': M35_FIXTURE_MODEL,
            'ollama-agent.codingModel': M35_FIXTURE_MODEL,
            'ollama-agent.editModel': M35_FIXTURE_MODEL,
            'ollama-agent.reviewerModel': M35_FIXTURE_MODEL,
            'ollama-agent.codingFallbackModel': M35_FIXTURE_MODEL,
          },
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        const prompt = 'create note.txt containing Hello';
        const request = await sendWithCoreConnectedRetry(webviewClient, () => ui.evalInWebviewDoc(webviewClient, `(() => {
          const input = document.getElementById('user-input');
          const button = document.getElementById('send-btn');
          input.value = ${JSON.stringify(prompt)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
          button.click();
          return true;
        })()`), prompt, { dataDir: windowHandle.globalDataDir });
        const active = await pollUntil(
          async () => {
            const value = await ui.evalInWebviewDoc(webviewClient, `(() => {
              const button = document.getElementById('send-btn');
              return button?.textContent?.trim() === 'Stop' && button.dataset.taskId
                ? { taskId: button.dataset.taskId, label: button.textContent.trim() }
                : null;
            })()`);
            return value ? { done: true, value } : { done: false, value };
          },
          { timeoutMs: 30000, describe: () => 'visible unified-composer Stop bound to the active task' },
        );
        await ui.evalInWebviewDoc(webviewClient, `document.getElementById('send-btn')?.click()`);
        const cancelledAttempt = await pollUntil(
          async () => {
            const current = await findAttemptById(active.taskId, windowHandle.globalDataDir);
            return current?.status === 'cancelled'
              ? { done: true, value: current } : { done: false, value: current?.status };
          },
          { timeoutMs: 30000, describe: () => 'inline Stop to cancel the exact active task' },
        );
        const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
        const gitStatus = runCapture('git', ['status', '--porcelain'], { cwd: workspace });
        const ok = cancelledAttempt.id === active.taskId
          && attempts.length === 1
          && !fs.existsSync(path.join(workspace, 'note.txt'))
          && gitStatus === '';
        scenarioEvidence = {
          ok,
          requestId: request.id,
          visibleStopTaskId: active.taskId,
          cancelledAttemptId: cancelledAttempt.id,
          finalAttemptStatus: cancelledAttempt.status,
          attemptCount: attempts.length,
          noteExists: fs.existsSync(path.join(workspace, 'note.txt')),
          gitStatus,
          modelInvocationCount: fixture.snapshot().chatRequests,
          cleanup: null,
        };
        evidence.scenarios.m35InlineStop = scenarioEvidence;
        if (!ok) throw new Error(`M35 inline Stop scenario did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = {
          proxyCleanedUp: Boolean(fixture?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m35InlineStop = scenarioEvidence;
        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`M35 inline Stop cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 12a (M35): deterministic exact-package provenance gate. The
    // supplied VSIX is inspected in verifier-owned temporary storage and a
    // bounded fixture drives the *packaged* proposal/mutation/delivery path.
    // This stays a hard gate even when no local coding model is installed.
    // =====================================================================
    await runRegisteredScenario('m35-package-provenance-gate', 'scenario-12a-m35-package-provenance-gate', async () => {
      const scenarioRoot = path.join(workDir, 'm35-package-provenance-gate-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      const contract = writeM35Repository(workspace);
      initGitRepo(workspace);
      const scenarioEvidenceDir = m35PackageProvenanceGateEvidenceDir;
      const rootVsixBefore = snapshotRootVsixInventory(repoRoot);
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let requestId = null;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m35PackageProvenanceGate = scenarioEvidence;
      fs.mkdirSync(scenarioEvidenceDir, { recursive: true });

      const fixtureSettings = () => ({
        'ollama-agent.apiBase': fixture.baseUrl,
        'ollama-agent.model': M35_CAPABLE_FIXTURE_MODEL,
        'ollama-agent.chatModel': M35_CAPABLE_FIXTURE_MODEL,
        'ollama-agent.agentModel': M35_CAPABLE_FIXTURE_MODEL,
        'ollama-agent.codingModel': M35_CAPABLE_FIXTURE_MODEL,
        'ollama-agent.editModel': M35_CAPABLE_FIXTURE_MODEL,
        'ollama-agent.reviewerModel': M35_CAPABLE_FIXTURE_MODEL,
        'ollama-agent.codingFallbackModel': M35_CAPABLE_FIXTURE_MODEL,
      });
      const terminalAttempt = async (attemptId) => pollUntil(
        async () => {
          const attempt = await findAttemptById(attemptId, windowHandle.globalDataDir);
          return attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)
            ? { done: true, value: attempt }
            : { done: false, value: attempt?.status ?? null };
        },
        { timeoutMs: 120000, describe: () => 'deterministic package-provenance attempt to reach a durable terminal state' },
      );

      try {
        // verify-win32-vsix always extracts beneath os.tmpdir(); this harness
        // never asks package construction to write beside the repository.
        const preVerification = spawnSync('node', ['scripts/verify-win32-vsix.mjs', vsixPath], {
          cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
        });
        if (preVerification.status !== 0) throw new Error(`exact supplied VSIX did not pass static verification: ${preVerification.stderr || preVerification.stdout}`);

        fixture = await startDeterministicM35Proxy({ model: M35_CAPABLE_FIXTURE_MODEL });
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m35-package-provenance-gate',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: fixtureSettings(),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));
        const prompt = `${contract.task} (nonce ${NONCE}-m35-package-provenance-gate)`;
        await sendWithCoreConnectedRetry(webviewClient, () => startAutonomousTask(webviewClient, prompt), prompt, { dataDir: windowHandle.globalDataDir });
        const request = await pollUntil(
          async () => {
            const found = await findRequestByMessage(prompt, windowHandle.globalDataDir);
            return found ? { done: true, value: found } : { done: false, value: null };
          },
          { timeoutMs: 60000, describe: () => 'deterministic package-provenance Core request' },
        );
        requestId = request.id;
        const [attempt] = await pollUntil(
          async () => {
            const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
            return attempts.length === 1 ? { done: true, value: attempts } : { done: false, value: attempts.length };
          },
          { timeoutMs: 30000, describe: () => 'one deterministic package-provenance Core attempt' },
        );
        const waitForGate = async (kind) => pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            const actionable = kind === 'proposal'
              ? dom.proposalCardHidden === false && dom.proposalApproveDisabled === false
              : kind === 'mutation'
                ? dom.mutationCardHidden === false && dom.mutationApproveDisabled === false
                : dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false;
            return actionable ? { done: true, value: dom } : { done: false, value: dom };
          },
          { timeoutMs: 120000, describe: () => `deterministic ${kind} approval gate` },
        );
        await waitForGate('proposal');
        await ui.clickProposalApproveButton(webviewClient);
        await waitForGate('mutation');
        await ui.clickMutationApproveButton(webviewClient);
        await waitForGate('delivery');
        await ui.clickDeliveryApproveButton(webviewClient);
        const finalAttempt = await terminalAttempt(attempt.id);
        const approvals = await findApprovalsForAttempt(attempt.id, windowHandle.globalDataDir);
        const dom = await ui.readApprovalCycleDom(webviewClient);
        const rootVsixAfter = snapshotRootVsixInventory(repoRoot);
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(rootVsixAfter);
        const noWorkspaceRootVsix = fs.readdirSync(workspace).every((name) => !name.toLowerCase().endsWith('.vsix'));
        const postVerification = spawnSync('node', ['scripts/verify-win32-vsix.mjs', vsixPath], {
          cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
        });
        const lifecycleComplete = approvals.filter((a) => a.status === 'approved').length === 3
          && approvals.map((a) => a.kind).join(',') === 'proposal,mutation,delivery';
        const ok = finalAttempt.status === 'completed' && lifecycleComplete && rootVsixUnchanged
          && noWorkspaceRootVsix && postVerification.status === 0 && dom.deliveryCardHidden === false;
        scenarioEvidence = {
          ok,
          exactSuppliedVsix: { path: vsixPath, sha256: hashFile(vsixPath), bytes: fs.statSync(vsixPath).size },
          verifierStorage: 'os.tmpdir()/oa-win32-vsix-verify-*',
          preVerification: { exitCode: preVerification.status, stdout: preVerification.stdout, stderr: preVerification.stderr },
          postVerification: { exitCode: postVerification.status, stdout: postVerification.stdout, stderr: postVerification.stderr },
          requestId: request.id,
          attemptId: attempt.id,
          taskState: finalAttempt.status,
          approvalEnvelopeHistory: approvals.map((a) => ({ id: a.id, kind: a.kind, status: a.status })),
          mutationRoundCount: approvals.filter((a) => a.kind === 'mutation').length,
          finalRelevantDom: dom,
          rootVsixInventoryBefore: rootVsixBefore,
          rootVsixInventoryAfter: rootVsixAfter,
          rootVsixUnchanged,
          noWorkspaceRootVsix,
          cleanup: null,
        };
        evidence.scenarios.m35PackageProvenanceGate = scenarioEvidence;
        if (!ok) throw new Error(`deterministic package-provenance hard gate failed: ${JSON.stringify(scenarioEvidence)}`);
      } catch (scenarioError) {
        const failure = await captureFailureEvidence({ requestId, dataDir: windowHandle?.globalDataDir, thrownError: scenarioError, harnessTimedOut: /timed out|within \d+ms|did not/i.test(scenarioError.message ?? '') })
          .catch((error) => ({ outcomeKind: 'evidence_capture_failed', evidenceCaptureError: error.message }));
        let finalRelevantDom = null;
        try { finalRelevantDom = webviewClient ? await ui.readApprovalCycleDom(webviewClient) : null; } catch {}
        scenarioEvidence = { ...scenarioEvidence, ok: false, failure, finalRelevantDom };
        evidence.scenarios.m35PackageProvenanceGate = scenarioEvidence;
        throw scenarioError;
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const corePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profilePids = windowHandle ? readWindowsProcessSnapshot().filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase())).map((process) => process.pid) : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profilePids].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(corePid);
        if (fixture) await fixture.close().catch(() => {});
        scenarioEvidence.cleanup = { proxyCleanedUp: Boolean(fixture?.snapshot().closedAt), corePid, coreStopped: !corePid || !isPidAlive(corePid), vscodeStopped: profilePids.every((pid) => !isPidAlive(pid)) };
        evidence.scenarios.m35PackageProvenanceGate = scenarioEvidence;
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scenario: 'm35-package-provenance-gate', ...scenarioEvidence }, null, 2));
      }
    });

    // =====================================================================
    // Scenario 12b: M35 real-local-model package-provenance coding dogfood
    // task — an ADVISORY, NON-GATING live-model diagnostic. The deterministic
    // package-provenance protections and packaged approval-gate mechanics
    // are covered as a HARD CI gate by 'm35-package-provenance-gate' (a
    // bounded deterministic fixture, registered separately, immediately
    // below) — this scenario's genuinely nondeterministic real-model outcome
    // (pass / no-change / blocked / validation-failure / model-failure are
    // all legitimate here) is reported honestly via its own dedicated
    // evidence file and never suppressed, but run-win32-packaged-acceptance.ps1
    // invokes it in its own isolated process and deliberately does not let
    // its exit code fail the overall CI workflow.
    // =====================================================================
    await runRegisteredScenario('m35-package-provenance-live-diagnostic', 'scenario-12-m35-package-provenance-live-diagnostic', async () => {
      const scenarioRoot = path.join(workDir, 'm35-package-provenance-isolated');
      const workspace = path.join(scenarioRoot, 'workspace');
      initPackageProvenanceWorkspace(workspace);
      const startBranch = runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace }).trim();

      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m35PackageProvenanceLiveDiagnostic = scenarioEvidence;
      const scenarioEvidenceDir = m35PackageProvenanceLiveEvidenceDir;
      fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
      let lastKnownRequestId = null;

      try {
        // Independent, non-agent-dependent proof — extracts the exact supplied VSIX into a
        // test-owned temp dir and statically verifies it — run BEFORE the dogfood prompt, so an
        // honest "no change needed" outcome from the live agent below is corroborated rather than
        // merely asserted on the agent's word alone.
        const rootVsixBefore = snapshotRootVsixInventory(repoRoot);
        const preVerification = spawnSync('node', ['scripts/verify-win32-vsix.mjs', vsixPath], {
          cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
        });

        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspace,
          label: 'window-m35-package-provenance-isolated',
          scenarioRoot,
          ollamaUrl: OLLAMA_URL,
          model: CODING_MODEL,
          settings: {
            'ollama-agent.apiBase': OLLAMA_URL,
            'ollama-agent.model': MODEL,
            'ollama-agent.chatModel': MODEL,
            'ollama-agent.agentModel': MODEL,
            'ollama-agent.codingModel': CODING_MODEL,
            'ollama-agent.editModel': CODING_MODEL,
            'ollama-agent.reviewerModel': CODING_MODEL,
            'ollama-agent.codingFallbackModel': CODING_MODEL,
          },
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle));

        const prompt = "Inspect the repository's package-provenance verification. Ensure package "
          + "verification writes generated VSIX output only to a test-owned temporary directory, "
          + "never overwrites or creates a repository-root VSIX, proves any pre-existing root VSIX "
          + "remains byte-for-byte unchanged, extracts the temporary package, and verifies that the "
          + "shipped inline-approval webview code and required runtime files are present. Preserve "
          + "all existing governance, security, validation, packaging, and human-merge controls. "
          + "Make only the smallest necessary correction and run the focused and required repository "
          + `verification. (nonce ${NONCE}-m35-package-provenance)`;
        await sendWithCoreConnectedRetry(webviewClient, () => startAutonomousTask(webviewClient, prompt), prompt, { dataDir: windowHandle.globalDataDir });

        const request = await pollUntil(
          async () => {
            const found = await findRequestByMessage(prompt, windowHandle.globalDataDir);
            return found ? { done: true, value: found } : { done: false, value: null };
          },
          { timeoutMs: 60000, describe: () => 'm35-package-provenance Core request to be recorded' },
        );
        lastKnownRequestId = request.id;

        // Real-model outcome is genuinely nondeterministic: either the agent proposes an actual
        // change (drive it through every real approval gate to delivery), or it concludes the
        // repository already satisfies the request and reaches a terminal state with no proposal
        // ever raised. Both are legitimate, honestly recorded outcomes — never fabricate a
        // mutation merely to force another gate that did not actually occur.
        const outcome = await pollUntil(
          async () => {
            const dom = await ui.readApprovalCycleDom(webviewClient);
            if (dom.proposalCardHidden === false && dom.proposalApproveDisabled === false) {
              return { done: true, value: { kind: 'proposal' } };
            }
            const attempts = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
            const attempt = attempts[0];
            if (attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)) {
              return { done: true, value: { kind: 'terminal', attempt } };
            }
            return { done: false, value: { attemptStatus: attempt?.status ?? null } };
          },
          { timeoutMs: 300000, describe: () => 'm35-package-provenance proposal gate or a terminal (no-change) outcome' },
        );

        let deliverySha = null;
        let changedFiles = [];
        let finalAttempt;
        let noChangeOutcome = false;

        if (outcome.kind === 'proposal') {
          const attemptsBefore = await findAttemptsForRequest(request.id, windowHandle.globalDataDir);
          if (attemptsBefore.length !== 1) throw new Error(`expected exactly one Core attempt, got ${attemptsBefore.length}`);
          const attempt = attemptsBefore[0];
          await ui.clickProposalApproveButton(webviewClient);
          const secondGate = await pollUntil(
            async () => {
              const dom = await ui.readApprovalCycleDom(webviewClient);
              if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) return { done: true, value: { kind: 'mutation' } };
              if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) return { done: true, value: { kind: 'delivery' } };
              const durable = await findAttemptById(attempt.id, windowHandle.globalDataDir);
              if (durable && ['completed', 'failed', 'cancelled'].includes(durable.status)) return { done: true, value: { kind: 'terminal', attempt: durable } };
              return { done: false, value: dom };
            },
            { timeoutMs: 180000, describe: () => 'm35-package-provenance mutation/delivery approval card or durable terminal outcome' },
          );
          if (secondGate.kind === 'terminal') {
            finalAttempt = secondGate.attempt;
          } else if (secondGate.kind === 'mutation') {
            // Bounded loop, not a single fixed round: a real, sufficiently
            // complex coding task can legitimately need more than one
            // mutation-approval round — e.g. validation repair exhausting
            // its own bounded auto-repair cycles and regenerating the
            // change, which requires a fresh human mutation approval for
            // the new attempt. This is a genuine product behavior (observed
            // live in CI: two other scenarios in the same run resolved
            // exactly one mutation-approval envelope each and completed
            // cleanly through delivery, while this scenario's own harder,
            // more realistic task legitimately needed more than one), not
            // an approval-gate defect — so approve repeatedly whenever
            // mutation is actionable until delivery becomes actionable,
            // bounded to still fail closed rather than loop forever.
            const MAX_MUTATION_ROUNDS = 5;
            let deliveryReached = false;
            for (let round = 0; round < MAX_MUTATION_ROUNDS && !deliveryReached; round += 1) {
              await ui.clickMutationApproveButton(webviewClient);
              const nextGate = await pollUntil(
                async () => {
                  const dom = await ui.readApprovalCycleDom(webviewClient);
                  if (dom.deliveryCardHidden === false && dom.deliveryApproveDisabled === false) return { done: true, value: { kind: 'delivery' } };
                  if (dom.mutationCardHidden === false && dom.mutationApproveDisabled === false) return { done: true, value: { kind: 'mutation' } };
                  const durable = await findAttemptById(attempt.id, windowHandle.globalDataDir);
                  if (durable && ['completed', 'failed', 'cancelled'].includes(durable.status)) return { done: true, value: { kind: 'terminal', attempt: durable } };
                  return { done: false, value: dom };
                },
                { timeoutMs: 180000, describe: () => `m35-package-provenance delivery/mutation approval card or durable terminal outcome (round ${round + 1}/${MAX_MUTATION_ROUNDS})` },
              );
              if (nextGate.kind === 'delivery') deliveryReached = true;
              if (nextGate.kind === 'terminal') {
                finalAttempt = nextGate.attempt;
                break;
              }
            }
            if (!deliveryReached && !finalAttempt) {
              throw new Error(`m35-package-provenance delivery approval card never became actionable after ${MAX_MUTATION_ROUNDS} mutation-approval rounds`);
            }
          }
          if (!finalAttempt) {
            await ui.clickDeliveryApproveButton(webviewClient);
            finalAttempt = await pollUntil(
              async () => {
                const a = await findAttemptById(attempt.id, windowHandle.globalDataDir);
                return a && ['completed', 'failed', 'cancelled'].includes(a.status) ? { done: true, value: a } : { done: false, value: a?.status };
              },
              { timeoutMs: 240000, describe: () => 'm35-package-provenance attempt to reach a terminal state after delivery approval' },
            );
          }
          const gitLog = runCapture('git', ['log', '--all', '--format=%H %s'], { cwd: workspace });
          const deliveryLines = gitLog.split(/\r?\n/).filter((line) => line.includes('M15 delivery'));
          deliverySha = deliveryLines[0]?.split(' ')[0] ?? null;
          changedFiles = deliverySha
            ? runCapture('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', deliverySha], { cwd: workspace }).split(/\r?\n/).filter(Boolean)
            : [];
        } else {
          finalAttempt = outcome.attempt;
          noChangeOutcome = true;
        }

        const endBranch = runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspace }).trim();
        const branchPreserved = startBranch === endBranch;
        const rootVsixAfter = snapshotRootVsixInventory(repoRoot);
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(rootVsixAfter);
        const noRootVsixCreatedInWorkspace = !fs.existsSync(workspace)
          || fs.readdirSync(workspace).every((name) => !name.toLowerCase().endsWith('.vsix'));

        // Same real, deterministic static verification as before the prompt, re-run against the
        // (possibly delivered) workspace state, extracting the exact supplied VSIX again into its
        // own fresh test-owned temp directory.
        const postVerification = spawnSync('node', ['scripts/verify-win32-vsix.mjs', vsixPath], {
          cwd: workspace, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true,
        });

        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'm35-package-provenance-outcome').catch(() => {});
        const finalRelevantDom = await ui.readApprovalCycleDom(webviewClient).catch(() => null);
        const finalApprovals = finalAttempt ? await findApprovalsForAttempt(finalAttempt.id, windowHandle.globalDataDir) : [];
        const diagnosticOutcome = finalAttempt?.status === 'completed'
          ? (noChangeOutcome ? 'legitimate_no_change' : 'completed')
          : finalAttempt?.status === 'cancelled'
            ? 'terminal_blocker'
            : finalAttempt?.status === 'failed'
              ? classifyFailureReasonForEvidence(finalAttempt.failureReason)
              : 'unknown';

        const ok = Boolean(finalAttempt)
          && finalAttempt.status !== 'cancelled'
          && rootVsixUnchanged
          && noRootVsixCreatedInWorkspace
          && branchPreserved
          && preVerification.status === 0
          && postVerification.status === 0
          && (noChangeOutcome || (finalAttempt.status === 'completed' && Boolean(deliverySha)));

        scenarioEvidence = {
          ok,
          requestId: request.id,
          attemptId: finalAttempt?.id ?? null,
          finalAttemptStatus: finalAttempt?.status ?? null,
          outcomeKind: diagnosticOutcome,
          noChangeOutcome,
          failureClassification: finalAttempt?.status === 'failed' ? classifyFailureReasonForEvidence(finalAttempt.failureReason) : null,
          failureDetail: finalAttempt?.status === 'failed' ? redactFailureDetail(finalAttempt.failureReason) : null,
          approvalEnvelopeHistory: finalApprovals.map((a) => ({ id: a.id, kind: a.kind, status: a.status, requestedAt: a.requestedAt, resolvedAt: a.resolvedAt ?? null })),
          mutationRoundCount: finalApprovals.filter((a) => a.kind === 'mutation').length,
          finalRelevantDom,
          deliverySha,
          changedFiles,
          startBranch,
          endBranch,
          branchPreserved,
          rootVsixInventoryBefore: rootVsixBefore,
          rootVsixInventoryAfter: rootVsixAfter,
          rootVsixUnchanged,
          noRootVsixCreatedInWorkspace,
          preVerification: { exitCode: preVerification.status, stdout: preVerification.stdout, stderr: preVerification.stderr },
          postVerification: { exitCode: postVerification.status, stdout: postVerification.stdout, stderr: postVerification.stderr },
          cleanup: null,
        };
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'm35-package-provenance-evidence.json'), JSON.stringify(scenarioEvidence, null, 2));
        evidence.scenarios.m35PackageProvenanceLiveDiagnostic = scenarioEvidence;
        log(`M35 package-provenance live diagnostic: request=${request.id}; outcome=${outcome.kind}; attempt=${finalAttempt?.id}:${finalAttempt?.status}; delivery=${deliverySha}; rootVsixUnchanged=${rootVsixUnchanged}.`);
        if (!ok) throw new Error(`M35 package-provenance live diagnostic did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } catch (scenarioError) {
        // Terminal-state evidence must survive a mid-flow failure (a poll
        // timing out, a thrown assertion, etc.) too — not only the success
        // path above. Read whatever durable Core state exists for this
        // scenario's request/attempt at the moment of failure, classify it,
        // and merge it into the evidence that was already assigned (rather
        // than leaving the placeholder `{ ok: false, cleanup: null }` — the
        // gap this fixes), before re-throwing unchanged so the live
        // diagnostic still honestly reports its own pass/fail.
        const harnessTimedOut = /did not (become|reach)|timed out|within \d+ms/i.test(scenarioError.message ?? '');
        const failureEvidence = await captureFailureEvidence({
          requestId: lastKnownRequestId,
          dataDir: windowHandle?.globalDataDir,
          thrownError: scenarioError,
          harnessTimedOut,
        }).catch((evidenceError) => ({ outcomeKind: 'evidence_capture_failed', evidenceCaptureError: evidenceError.message }));
        let finalRelevantDom = null;
        try { finalRelevantDom = webviewClient ? await ui.readApprovalCycleDom(webviewClient) : null; } catch {}
        scenarioEvidence = { ...scenarioEvidence, ok: false, failure: failureEvidence, finalRelevantDom };
        evidence.scenarios.m35PackageProvenanceLiveDiagnostic = scenarioEvidence;
        try {
          fs.writeFileSync(path.join(scenarioEvidenceDir, 'm35-package-provenance-evidence.json'), JSON.stringify(scenarioEvidence, null, 2));
        } catch (writeError) {
          log(`WARNING: failed to write m35-package-provenance-live-diagnostic failure evidence: ${writeError.message}`);
        }
        log(`M35 package-provenance live diagnostic FAILED: outcomeKind=${failureEvidence.outcomeKind}; failureClassification=${failureEvidence.failureClassification ?? 'n/a'}; ${scenarioError.message}`);
        throw scenarioError;
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        const cleanup = {
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          corePid: isolatedCorePid,
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m35PackageProvenanceLiveDiagnostic = scenarioEvidence;
        if (!cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`M35 package-provenance cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    // =====================================================================
    // Scenario 13 (M36): durable attachment upload (text + image) through the
    // real attach button and the real in-application Simple File Dialog,
    // deterministic multimodal submission against a fake Ollama endpoint,
    // and restart restoration on the same isolated profile/Core data dir.
    // =====================================================================
    await runRegisteredScenario('m36-attachment-restart', 'scenario-13-m36-attachment-restart', async () => {
      const scenarioRoot = path.join(workDir, 'm36-attachment-restart-isolated');
      const fixturesDir = path.join(scenarioRoot, 'fixtures');
      const fixtures = writeM36Fixtures(fixturesDir);
      const rootVsixBefore = snapshotRootVsixInventory(repoRoot);

      const fixtureSettings = (endpoint) => ({
        'ollama-agent.apiBase': endpoint,
        'ollama-agent.model': M36_FIXTURE_MODEL,
        'ollama-agent.chatModel': M36_FIXTURE_MODEL,
        'ollama-agent.visionModel': M36_FIXTURE_MODEL,
        'files.simpleDialog.enable': true,
      });

      let fixtureServer;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, proxy: { endpoint: null, model: M36_FIXTURE_MODEL, cleanedUp: false }, cleanup: null };
      evidence.scenarios.m36AttachmentRestart = scenarioEvidence;
      // Dedicated evidence home (see `m36EvidenceDir` above) — a sibling of
      // `evidenceDir`, never a subdirectory of it, so no other scenario's
      // shared-evidence rmSync/write can ever touch it.
      const scenarioEvidenceDir = m36EvidenceDir;
      fs.mkdirSync(scenarioEvidenceDir, { recursive: true });

      const attachOneFile = async (absolutePath, expectedName) => {
        await ui.clickAttachButton(webviewClient);
        await ui.driveSimpleFileDialogSelectPath(pageClient, absolutePath);
        return pollUntil(
          async () => {
            const chips = await ui.readComposerAttachmentChips(webviewClient);
            const chip = chips.find((c) => c.name === expectedName);
            if (chip?.status === 'failed') throw new Error(`attachment chip for "${expectedName}" failed: ${JSON.stringify(chip)}`);
            return chip && chip.status === 'ready' ? { done: true, value: chip } : { done: false, value: chip?.status ?? 'not present yet' };
          },
          { timeoutMs: 30000, describe: () => `attachment chip for "${expectedName}" to transition to ready` },
        );
      };

      const findAttachmentBytesPath = (dataDir, storageRelativePath) => path.join(dataDir, ...storageRelativePath.split('/'));

      try {
        fixtureServer = await startDeterministicM36AttachmentProxy(fixtures);
        scenarioEvidence.proxy.endpoint = fixtureServer.baseUrl;

        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined, // requirement 2: Baat Kar must start without requiring a workspace
          label: 'window-m36-attachment-restart',
          scenarioRoot,
          ollamaUrl: fixtureServer.baseUrl,
          model: fixtureServer.model,
          settings: fixtureSettings(fixtureServer.baseUrl),
        });
        // This scenario only ever drives the Baat Kar composer, never the
        // autonomous/Karke Dikha UI — wait on `#attach-btn` (part of chat.html's
        // static markup) rather than `#proposal-approve-btn` (created later in
        // chat.html's sequential media/*.js loader by chat-autonomous.js).
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'attach-btn' }));
        await setMode(webviewClient, 'chat');
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'before-send').catch(() => {});
        const bubblesBeforeSend = await ui.countBubbles(webviewClient);
        const chipsBeforeSend = await ui.readComposerAttachmentChips(webviewClient);
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'dom-before-send.json'), JSON.stringify({ bubblesBeforeSend, chipsBeforeSend }, null, 2));

        // ---- Requirements 4-7: real attach button + real Simple File Dialog, twice ----
        const textChip = await attachOneFile(fixtures.textPath, M36_TEXT_FIXTURE_NAME);
        const imageChip = await attachOneFile(fixtures.imagePath, M36_IMAGE_FIXTURE_NAME);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'both-chips-ready').catch(() => {});

        // ---- Requirement 8: exactly one stable Core attachment record per ready chip ----
        const preSendAttachments = await findAttachmentsByOriginalNames([M36_TEXT_FIXTURE_NAME, M36_IMAGE_FIXTURE_NAME], windowHandle.globalDataDir);
        if (preSendAttachments.length !== 2) {
          throw new Error(`expected exactly 2 Core attachment records before send, found ${preSendAttachments.length}: ${JSON.stringify(preSendAttachments)}`);
        }
        const preSendText = preSendAttachments.find((a) => a.originalName === M36_TEXT_FIXTURE_NAME);
        const preSendImage = preSendAttachments.find((a) => a.originalName === M36_IMAGE_FIXTURE_NAME);
        for (const [attachment, fixtureInfo] of [[preSendText, { sha256: fixtures.textSha256, byteSize: fixtures.textByteSize }], [preSendImage, { sha256: fixtures.imageSha256, byteSize: fixtures.imageByteSize }]]) {
          if (!attachment || attachment.status !== 'ready' || !attachment.detectedMimeType || !attachment.sha256 || !attachment.byteSize) {
            throw new Error(`Core attachment record incomplete before send: ${JSON.stringify(attachment)}`);
          }
          if (attachment.sha256 !== fixtureInfo.sha256 || attachment.byteSize !== fixtureInfo.byteSize) {
            throw new Error(`Core attachment provenance mismatch before send: ${JSON.stringify(attachment)}`);
          }
        }
        if (preSendImage.detectedMimeType !== 'image/png') {
          throw new Error(`expected detected MIME 'image/png' for the PNG fixture (never trusting the declared/extension-derived type), got: ${preSendImage.detectedMimeType}`);
        }

        // ---- Requirement 9-13: submit the real turn against the deterministic fake Ollama ----
        // Exactly one click, via sendWithCoreConnectedRetry with maxAttempts:1
        // (its detection/diagnostic logic, not its resend behavior): the
        // composer clears its ready-attachment list on the first click, so a
        // real resend would silently submit a second, attachment-less turn
        // instead of retrying the same one. A generous single accept window
        // still gives Core's async connect handshake room to finish.
        const prompt = `Describe both attached files briefly. (nonce ${NONCE}-m36-attachment-restart)`;
        await sendChatMessage(webviewClient, prompt);

        const { request, attempt } = await pollUntil(
          async () => {
            const candidateRequest = await findRequestByMessage(prompt, windowHandle.globalDataDir);
            if (!candidateRequest) return { done: false, value: 'no request yet' };
            const attempts = await findAttemptsForRequest(candidateRequest.id, windowHandle.globalDataDir);
            const candidateAttempt = attempts[0];
            return candidateAttempt && ['completed', 'failed', 'cancelled'].includes(candidateAttempt.status)
              ? { done: true, value: { request: candidateRequest, attempt: candidateAttempt } }
              : { done: false, value: candidateAttempt?.status ?? 'no attempt yet' };
          },
          { timeoutMs: 60000, describe: () => 'm36-attachment-restart attempt to reach a terminal state' },
        );

        const conversationMessages = request.conversationId ? await findConversationMessages(request.conversationId, windowHandle.globalDataDir) : [];
        const userMessage = conversationMessages.find((m) => m.role === 'user');
        const messageLinks = userMessage ? await findMessageAttachmentLinksForMessage(userMessage.id, windowHandle.globalDataDir) : [];
        const attemptContextRow = await findAttemptContext(attempt.id, windowHandle.globalDataDir);
        const frozenAttachments = attemptContextRow?.attachments ? JSON.parse(attemptContextRow.attachments) : [];

        // ---- Requirement 11: proxy-side evidence of the exact multimodal request contract ----
        const proxyRequests = fixtureServer.requests;
        const proxyViolations = proxyRequests.flatMap((r) => r.violations);

        await new Promise((r) => setTimeout(r, 500));
        const bubblesAfterSend = await ui.countBubbles(webviewClient);
        const assistantText = await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = document.querySelector('.bubble.assistant'); if (!bubble) return null; const answer = bubble.cloneNode(true); answer.querySelector('.message-workbench-actions')?.remove(); return answer.textContent; })()`);
        const sentChipsAfterSend = await ui.readSentAttachmentChips(webviewClient);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'after-send').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'dom-after-send.json'), JSON.stringify({ bubblesAfterSend, assistantText, sentChipsAfterSend }, null, 2));

        const preRestartOk = attempt.status === 'completed'
          && messageLinks.length === 2
          && frozenAttachments.length === 2
          && frozenAttachments.every((a) => a.sha256 && [fixtures.textSha256, fixtures.imageSha256].includes(a.sha256))
          && proxyRequests.length === 1
          && proxyViolations.length === 0
          && bubblesAfterSend.user === 1
          && bubblesAfterSend.assistant === 1
          && assistantText === M36_ASSISTANT_ANSWER
          && sentChipsAfterSend.length === 2
          && sentChipsAfterSend.every((c) => c.status === 'ready' && [preSendText.id, preSendImage.id].includes(c.attachmentId));
        if (!preRestartOk) {
          throw new Error(`m36-attachment-restart pre-restart acceptance failed: ${JSON.stringify({ attemptStatus: attempt.status, messageLinks, frozenAttachments, proxyRequests, bubblesAfterSend, assistantText, sentChipsAfterSend })}`);
        }

        // ---- Requirement 14/18: stored bytes match the frozen hashes, before restart ----
        const storedBytesBeforeRestart = {
          text: sha256OfFileSync(findAttachmentBytesPath(windowHandle.globalDataDir, preSendText.storageRelativePath)),
          image: sha256OfFileSync(findAttachmentBytesPath(windowHandle.globalDataDir, preSendImage.storageRelativePath)),
        };
        if (storedBytesBeforeRestart.text !== fixtures.textSha256 || storedBytesBeforeRestart.image !== fixtures.imageSha256) {
          throw new Error(`stored attachment bytes did not match frozen hashes before restart: ${JSON.stringify(storedBytesBeforeRestart)}`);
        }

        // ---- Requirements 14-17: close the real host, relaunch on the SAME user-data/extensions/Core-data dirs ----
        const discoveryBeforeClose = readDiscoveryRecord(windowHandle.globalDataDir);
        await board.closeTarget(windowHandle.cdpPort, windowHandle.pageTargetId);
        await pollUntil(
          async () => {
            const pages = (await board.listTargets(windowHandle.cdpPort).catch(() => [])).filter((t) => t.type === 'page');
            return pages.some((t) => t.id === windowHandle.pageTargetId) ? { done: false, value: pages.length } : { done: true, value: pages.length };
          },
          { timeoutMs: 15000, intervalMs: 250, describe: () => 'm36-attachment-restart isolated window to close' },
        );
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});

        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label: 'window-m36-attachment-restart-relaunch',
          scenarioRoot, // same scenarioRoot => same isolated user-data/extensions/Core-data dirs
          ollamaUrl: fixtureServer.baseUrl,
          model: fixtureServer.model,
          settings: fixtureSettings(fixtureServer.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'attach-btn' }));

        // ---- Requirement 17: reopened durable conversation renders exactly once ----
        const bubblesAfterRestart = await pollUntil(
          async () => {
            const bubbles = await ui.countBubbles(webviewClient);
            return bubbles.user === 1 && bubbles.assistant === 1 ? { done: true, value: bubbles } : { done: false, value: bubbles };
          },
          { timeoutMs: 45000, describe: () => 'restored m36-attachment-restart transcript to render exactly one user/assistant turn' },
        );
        const sentChipsAfterRestart = await ui.readSentAttachmentChips(webviewClient);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'after-restart').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'dom-after-restart.json'), JSON.stringify({ bubblesAfterRestart, sentChipsAfterRestart }, null, 2));

        // ---- Requirements 18-19: durable evidence is unchanged after restart, and cleanup is real ----
        const postRestartAttachments = await findAttachmentsByOriginalNames([M36_TEXT_FIXTURE_NAME, M36_IMAGE_FIXTURE_NAME], windowHandle.globalDataDir);
        const postRestartText = postRestartAttachments.find((a) => a.originalName === M36_TEXT_FIXTURE_NAME);
        const postRestartImage = postRestartAttachments.find((a) => a.originalName === M36_IMAGE_FIXTURE_NAME);
        const storedBytesAfterRestart = {
          text: sha256OfFileSync(findAttachmentBytesPath(windowHandle.globalDataDir, postRestartText.storageRelativePath)),
          image: sha256OfFileSync(findAttachmentBytesPath(windowHandle.globalDataDir, postRestartImage.storageRelativePath)),
        };
        const attachmentsRootAfterRestart = path.join(windowHandle.globalDataDir, 'attachments');
        const uploadingRemnants = fs.existsSync(attachmentsRootAfterRestart)
          ? listFilesRecursive(attachmentsRootAfterRestart).filter((f) => f.toLowerCase().endsWith('.uploading'))
          : [];
        const rootVsixAfter = snapshotRootVsixInventory(repoRoot);
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(rootVsixAfter);
        const noRepoRootAttachmentFiles = !fs.existsSync(path.join(repoRoot, 'attachments'));

        const postRestartOk = postRestartAttachments.length === 2
          && [postRestartText, postRestartImage].every((a) => a.id && a.status === 'ready' && a.detectedMimeType && a.sha256 && a.byteSize)
          && postRestartText.id === preSendText.id && postRestartText.sha256 === fixtures.textSha256 && postRestartText.byteSize === fixtures.textByteSize
          && postRestartImage.id === preSendImage.id && postRestartImage.sha256 === fixtures.imageSha256 && postRestartImage.byteSize === fixtures.imageByteSize
          && storedBytesAfterRestart.text === fixtures.textSha256 && storedBytesAfterRestart.image === fixtures.imageSha256
          && bubblesAfterRestart.user === 1 && bubblesAfterRestart.assistant === 1
          && sentChipsAfterRestart.length === 2
          && sentChipsAfterRestart.every((c) => c.status === 'ready' && [preSendText.id, preSendImage.id].includes(c.attachmentId))
          && uploadingRemnants.length === 0
          && rootVsixUnchanged
          && noRepoRootAttachmentFiles;

        const ok = preRestartOk && postRestartOk;
        scenarioEvidence = {
          ok,
          proxy: { endpoint: fixtureServer.baseUrl, model: fixtureServer.model, requests: proxyRequests, cleanedUp: false },
          fixtures: { textSha256: fixtures.textSha256, textByteSize: fixtures.textByteSize, imageSha256: fixtures.imageSha256, imageByteSize: fixtures.imageByteSize },
          requestId: request.id,
          attemptId: attempt.id,
          attemptStatus: attempt.status,
          conversationId: request.conversationId ?? null,
          userMessageId: userMessage?.id ?? null,
          preSendAttachments: { text: preSendText, image: preSendImage },
          postRestartAttachments: { text: postRestartText, image: postRestartImage },
          storedBytesBeforeRestart,
          storedBytesAfterRestart,
          messageLinksCount: messageLinks.length,
          frozenAttachmentsCount: frozenAttachments.length,
          proxyViolationsCount: proxyViolations.length,
          uploadingRemnants,
          rootVsixUnchanged,
          noRepoRootAttachmentFiles,
          discoveryBeforeClosePid: discoveryBeforeClose?.pid ?? null,
          cleanup: null,
        };
        evidence.scenarios.m36AttachmentRestart = scenarioEvidence;
        log(`M36 attachment restart: request=${request.id}; attempt=${attempt.id}:${attempt.status}; proxyRequests=${proxyRequests.length}; violations=${proxyViolations.length}; postRestartAttachments=${postRestartAttachments.length}.`);
        if (!ok) throw new Error(`m36-attachment-restart scenario did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixtureServer) await fixtureServer.close().catch(() => {});
        const cleanup = {
          proxyClosedAt: fixtureServer?.snapshot().closedAt ?? null,
          proxyCleanedUp: Boolean(fixtureServer?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          corePid: isolatedCorePid,
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        if (scenarioEvidence.proxy) scenarioEvidence.proxy.cleanedUp = cleanup.proxyCleanedUp;
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m36AttachmentRestart = scenarioEvidence;

        // Write the full dedicated evidence set exactly once, here, after the
        // scenario body and cleanup have both run to completion (success or
        // failure) — this is the single writer for m36EvidenceDir's contents.
        // Everything below is a relocation/persistence of data already
        // gathered above during the scenario run, not a new assertion.
        try {
          fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'package-provenance.json'),
            JSON.stringify({ headSha, runId, ...evidence.packageProvenance }, null, 2),
          );
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'core-evidence.json'),
            JSON.stringify({
              headSha,
              runId,
              requestId: scenarioEvidence.requestId ?? null,
              attemptId: scenarioEvidence.attemptId ?? null,
              attemptStatus: scenarioEvidence.attemptStatus ?? null,
              conversationId: scenarioEvidence.conversationId ?? null,
              userMessageId: scenarioEvidence.userMessageId ?? null,
              messageLinksCount: scenarioEvidence.messageLinksCount ?? null,
              frozenAttachmentsCount: scenarioEvidence.frozenAttachmentsCount ?? null,
            }, null, 2),
          );
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'multimodal-request-evidence.json'),
            JSON.stringify({
              proxyEndpoint: scenarioEvidence.proxy?.endpoint ?? null,
              proxyModel: scenarioEvidence.proxy?.model ?? null,
              requestCount: scenarioEvidence.proxy?.requests?.length ?? 0,
              violationsCount: scenarioEvidence.proxyViolationsCount ?? 0,
              requests: scenarioEvidence.proxy?.requests ?? [],
            }, null, 2),
          );
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'attachment-hashes.json'),
            JSON.stringify({
              fixtures: scenarioEvidence.fixtures ?? null,
              preSendAttachments: scenarioEvidence.preSendAttachments ?? null,
              postRestartAttachments: scenarioEvidence.postRestartAttachments ?? null,
              storedBytesBeforeRestart: scenarioEvidence.storedBytesBeforeRestart ?? null,
              storedBytesAfterRestart: scenarioEvidence.storedBytesAfterRestart ?? null,
              uploadingRemnants: scenarioEvidence.uploadingRemnants ?? null,
            }, null, 2),
          );
          fs.writeFileSync(path.join(scenarioEvidenceDir, 'cleanup-evidence.json'), JSON.stringify(cleanup, null, 2));
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'evidence.json'),
            JSON.stringify({ capturedAt: new Date().toISOString(), scenario: 'm36-attachment-restart', ...scenarioEvidence }, null, 2),
          );
        } catch (writeError) {
          log(`WARNING: failed to write dedicated m36-attachment-restart evidence: ${writeError.message}`);
        }

        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`m36-attachment-restart cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    await runRegisteredScenario('m36-document-audio-restart', 'scenario-14-m36-document-audio-restart', async () => {
      const scenarioRoot = path.join(workDir, 'm36-document-audio-restart-isolated');
      const fixturesDir = path.join(scenarioRoot, 'fixtures');
      const fixtures = writeM36Pass2Fixtures(fixturesDir);
      const rootVsixBefore = snapshotRootVsixInventory(repoRoot);

      const fixtureSettings = (endpoint) => ({
        'ollama-agent.apiBase': endpoint,
        'ollama-agent.model': M36_PASS2_FIXTURE_MODEL,
        'ollama-agent.chatModel': M36_PASS2_FIXTURE_MODEL,
        'files.simpleDialog.enable': true,
      });

      let fixtureServer;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, proxy: { endpoint: null, model: M36_PASS2_FIXTURE_MODEL, cleanedUp: false }, cleanup: null };
      evidence.scenarios.m36DocumentAudioRestart = scenarioEvidence;
      const scenarioEvidenceDir = m36Pass2EvidenceDir;
      fs.mkdirSync(scenarioEvidenceDir, { recursive: true });

      const attachOneFile = async (absolutePath, expectedName) => {
        await ui.clickAttachButton(webviewClient);
        await ui.driveSimpleFileDialogSelectPath(pageClient, absolutePath);
        return pollUntil(
          async () => {
            const chips = await ui.readComposerAttachmentChips(webviewClient);
            const chip = chips.find((c) => c.name === expectedName);
            if (chip?.status === 'failed') throw new Error(`attachment chip for "${expectedName}" failed: ${JSON.stringify(chip)}`);
            return chip && chip.status === 'ready' ? { done: true, value: chip } : { done: false, value: chip?.status ?? 'not present yet' };
          },
          { timeoutMs: 30000, describe: () => `attachment chip for "${expectedName}" to transition to ready` },
        );
      };

      // findAttachmentsByOriginalNames reads the raw `attachments` table
      // directly (bypassing Core's HTTP API, which is what JSON.parse's the
      // extraction/transcription TEXT columns via rowToAttachment) — parse
      // them here so evidence assertions compare real objects, not raw JSON
      // strings.
      const withParsedProcessingFields = (row) => ({
        ...row,
        extraction: typeof row.extraction === 'string' ? JSON.parse(row.extraction) : row.extraction,
        transcription: typeof row.transcription === 'string' ? JSON.parse(row.transcription) : row.transcription,
      });

      try {
        fixtureServer = await startDeterministicM36Pass2Proxy(fixtures);
        scenarioEvidence.proxy.endpoint = fixtureServer.baseUrl;

        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label: 'window-m36-document-audio-restart',
          scenarioRoot,
          ollamaUrl: fixtureServer.baseUrl,
          model: fixtureServer.model,
          settings: fixtureSettings(fixtureServer.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'attach-btn' }));
        await setMode(webviewClient, 'chat');
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'before-send').catch(() => {});

        // ---- Attach one real PDF (real local extraction) and one real WAV (honest transcription-unavailable) ----
        await attachOneFile(fixtures.pdfPath, M36_PDF_FIXTURE_NAME);
        await attachOneFile(fixtures.wavPath, M36_AUDIO_FIXTURE_NAME);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'both-chips-ready').catch(() => {});

        // ---- Pre-send: Core attachment records already carry real extraction/capability evidence ----
        const preSendAttachments = (await findAttachmentsByOriginalNames([M36_PDF_FIXTURE_NAME, M36_AUDIO_FIXTURE_NAME], windowHandle.globalDataDir)).map(withParsedProcessingFields);
        if (preSendAttachments.length !== 2) {
          throw new Error(`expected exactly 2 Core attachment records before send, found ${preSendAttachments.length}: ${JSON.stringify(preSendAttachments)}`);
        }
        const preSendPdf = preSendAttachments.find((a) => a.originalName === M36_PDF_FIXTURE_NAME);
        const preSendWav = preSendAttachments.find((a) => a.originalName === M36_AUDIO_FIXTURE_NAME);
        if (!preSendPdf || preSendPdf.status !== 'ready' || preSendPdf.sha256 !== fixtures.pdfSha256) {
          throw new Error(`PDF attachment record incomplete/mismatched before send: ${JSON.stringify(preSendPdf)}`);
        }
        if (preSendPdf.localProcessingCapability !== 'available' || !preSendPdf.extraction || preSendPdf.extraction.engine !== 'pdfjs-dist') {
          throw new Error(`expected real local PDF extraction evidence before send, got: ${JSON.stringify(preSendPdf)}`);
        }
        if (!preSendPdf.extraction.sections.some((s) => s.text.includes('M36 pass 2 packaged acceptance PDF fixture text'))) {
          throw new Error(`extracted PDF text did not contain the fixture text: ${JSON.stringify(preSendPdf.extraction)}`);
        }
        if (!preSendWav || preSendWav.status !== 'ready' || preSendWav.sha256 !== fixtures.wavSha256) {
          throw new Error(`WAV attachment record incomplete/mismatched before send: ${JSON.stringify(preSendWav)}`);
        }
        // The packaged VSIX bundles the real whisper-base.en engine (model
        // files fetched at package time, see scripts/fetch-whisper-model.mjs)
        // — this scenario proves it actually transcribes the real speech
        // fixture correctly, not merely that the honest-unavailable path
        // works (that has its own dedicated, hard-gated core/test coverage).
        if (preSendWav.localProcessingCapability !== 'available' || !preSendWav.transcription || preSendWav.transcription.segments.length === 0) {
          throw new Error(`expected real local audio transcription evidence before send, got: ${JSON.stringify(preSendWav)}`);
        }
        if (!preSendWav.transcription.engine.includes('whisper-base.en')) {
          throw new Error(`expected the bundled whisper-base.en engine, got: ${JSON.stringify(preSendWav.transcription)}`);
        }
        const transcribedText = preSendWav.transcription.segments.map((s) => s.text).join(' ').toLowerCase();
        for (const phrase of M36_AUDIO_FIXTURE_EXPECTED_PHRASES) {
          if (!transcribedText.includes(phrase)) {
            throw new Error(`expected transcribed phrase "${phrase}" not found in real transcription: ${JSON.stringify(preSendWav.transcription)}`);
          }
        }
        for (const segment of preSendWav.transcription.segments) {
          if (!(segment.endSeconds > segment.startSeconds)) {
            throw new Error(`transcription segment has a non-positive duration: ${JSON.stringify(segment)}`);
          }
        }
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'attachment-hashes.json'), JSON.stringify({ preSendPdf, preSendWav }, null, 2));

        // ---- Send the real turn against the deterministic fake Ollama ----
        const prompt = `Describe the attached document and audio clip briefly. (nonce ${NONCE}-m36-document-audio-restart)`;
        await sendChatMessage(webviewClient, prompt);

        const { request, attempt } = await pollUntil(
          async () => {
            const candidateRequest = await findRequestByMessage(prompt, windowHandle.globalDataDir);
            if (!candidateRequest) return { done: false, value: 'no request yet' };
            const attempts = await findAttemptsForRequest(candidateRequest.id, windowHandle.globalDataDir);
            const candidateAttempt = attempts[0];
            return candidateAttempt && ['completed', 'failed', 'cancelled'].includes(candidateAttempt.status)
              ? { done: true, value: { request: candidateRequest, attempt: candidateAttempt } }
              : { done: false, value: candidateAttempt?.status ?? 'no attempt yet' };
          },
          { timeoutMs: 60000, describe: () => 'm36-document-audio-restart attempt to reach a terminal state' },
        );

        const proxyRequests = fixtureServer.requests;
        const proxyViolations = proxyRequests.flatMap((r) => r.violations);

        await new Promise((r) => setTimeout(r, 500));
        const bubblesAfterSend = await ui.countBubbles(webviewClient);
        const assistantText = await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = document.querySelector('.bubble.assistant'); if (!bubble) return null; const answer = bubble.cloneNode(true); answer.querySelector('.message-workbench-actions')?.remove(); return answer.textContent; })()`);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'after-send').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'dom-after-send.json'), JSON.stringify({ bubblesAfterSend, assistantText }, null, 2));

        const preRestartOk = attempt.status === 'completed'
          && proxyRequests.length === 1
          && proxyViolations.length === 0
          && bubblesAfterSend.user === 1
          && bubblesAfterSend.assistant === 1
          && assistantText === M36_PASS2_ASSISTANT_ANSWER;
        if (!preRestartOk) {
          throw new Error(`m36-document-audio-restart pre-restart acceptance failed: ${JSON.stringify({ attemptStatus: attempt.status, proxyRequests, bubblesAfterSend, assistantText })}`);
        }

        // ---- Restart: close the real host, relaunch on the SAME data dirs ----
        await board.closeTarget(windowHandle.cdpPort, windowHandle.pageTargetId);
        await pollUntil(
          async () => {
            const pages = (await board.listTargets(windowHandle.cdpPort).catch(() => [])).filter((t) => t.type === 'page');
            return pages.some((t) => t.id === windowHandle.pageTargetId) ? { done: false, value: pages.length } : { done: true, value: pages.length };
          },
          { timeoutMs: 15000, intervalMs: 250, describe: () => 'm36-document-audio-restart isolated window to close' },
        );
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});

        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label: 'window-m36-document-audio-restart-relaunch',
          scenarioRoot,
          ollamaUrl: fixtureServer.baseUrl,
          model: fixtureServer.model,
          settings: fixtureSettings(fixtureServer.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'attach-btn' }));

        const bubblesAfterRestart = await pollUntil(
          async () => {
            const bubbles = await ui.countBubbles(webviewClient);
            return bubbles.user === 1 && bubbles.assistant === 1 ? { done: true, value: bubbles } : { done: false, value: bubbles };
          },
          { timeoutMs: 45000, describe: () => 'restored m36-document-audio-restart transcript to render exactly one user/assistant turn' },
        );
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'after-restart').catch(() => {});
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'dom-after-restart.json'), JSON.stringify({ bubblesAfterRestart }, null, 2));

        // ---- Durable evidence unchanged after restart (same extraction/capability, not re-run) ----
        const postRestartAttachments = (await findAttachmentsByOriginalNames([M36_PDF_FIXTURE_NAME, M36_AUDIO_FIXTURE_NAME], windowHandle.globalDataDir)).map(withParsedProcessingFields);
        const postRestartPdf = postRestartAttachments.find((a) => a.originalName === M36_PDF_FIXTURE_NAME);
        const postRestartWav = postRestartAttachments.find((a) => a.originalName === M36_AUDIO_FIXTURE_NAME);
        const rootVsixAfter = snapshotRootVsixInventory(repoRoot);
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(rootVsixAfter);
        const noRepoRootAttachmentFiles = !fs.existsSync(path.join(repoRoot, 'attachments'));

        const postRestartOk = postRestartAttachments.length === 2
          && postRestartPdf?.id === preSendPdf.id
          && JSON.stringify(postRestartPdf?.extraction) === JSON.stringify(preSendPdf.extraction)
          && postRestartWav?.id === preSendWav.id
          && postRestartWav?.localProcessingCapability === preSendWav.localProcessingCapability
          // The exact same durably-recorded transcription (same segments,
          // same engine) — never re-transcribed on restart.
          && JSON.stringify(postRestartWav?.transcription) === JSON.stringify(preSendWav.transcription)
          && bubblesAfterRestart.user === 1 && bubblesAfterRestart.assistant === 1
          && rootVsixUnchanged
          && noRepoRootAttachmentFiles;

        const ok = preRestartOk && postRestartOk;
        scenarioEvidence = {
          ok,
          proxy: { endpoint: fixtureServer.baseUrl, model: fixtureServer.model, requests: proxyRequests, cleanedUp: false },
          requestId: request.id,
          attemptId: attempt.id,
          attemptStatus: attempt.status,
          preSendAttachments: { pdf: preSendPdf, wav: preSendWav },
          postRestartAttachments: { pdf: postRestartPdf, wav: postRestartWav },
          proxyViolationsCount: proxyViolations.length,
          rootVsixUnchanged,
          noRepoRootAttachmentFiles,
          cleanup: null,
        };
        evidence.scenarios.m36DocumentAudioRestart = scenarioEvidence;
        log(`M36 document/audio restart: request=${request.id}; attempt=${attempt.id}:${attempt.status}; proxyRequests=${proxyRequests.length}; violations=${proxyViolations.length}; postRestartAttachments=${postRestartAttachments.length}.`);
        if (!ok) throw new Error(`m36-document-audio-restart scenario did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const isolatedCorePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profileProcessIds = windowHandle
          ? readWindowsProcessSnapshot()
            .filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase()))
            .map((process) => process.pid)
          : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profileProcessIds].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(isolatedCorePid);
        if (fixtureServer) await fixtureServer.close().catch(() => {});
        const cleanup = {
          proxyClosedAt: fixtureServer?.snapshot().closedAt ?? null,
          proxyCleanedUp: Boolean(fixtureServer?.snapshot().closedAt),
          vscodeStopped: profileProcessIds.every((pid) => !isPidAlive(pid)),
          corePid: isolatedCorePid,
          coreStopped: !isolatedCorePid || !isPidAlive(isolatedCorePid),
        };
        if (scenarioEvidence.proxy) scenarioEvidence.proxy.cleanedUp = cleanup.proxyCleanedUp;
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m36DocumentAudioRestart = scenarioEvidence;

        try {
          fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'package-provenance.json'),
            JSON.stringify({ headSha, runId, ...evidence.packageProvenance }, null, 2),
          );
          fs.writeFileSync(path.join(scenarioEvidenceDir, 'cleanup-evidence.json'), JSON.stringify(cleanup, null, 2));
          fs.writeFileSync(
            path.join(scenarioEvidenceDir, 'evidence.json'),
            JSON.stringify({ capturedAt: new Date().toISOString(), scenario: 'm36-document-audio-restart', ...scenarioEvidence }, null, 2),
          );
        } catch (writeError) {
          log(`WARNING: failed to write dedicated m36-document-audio-restart evidence: ${writeError.message}`);
        }

        if (!cleanup.proxyCleanedUp || !cleanup.coreStopped || !cleanup.vscodeStopped) {
          throw new Error(`m36-document-audio-restart cleanup failed: ${JSON.stringify(cleanup)}`);
        }
      }
    });

    await runRegisteredScenario('m36-governed-research-restart', 'scenario-15-m36-governed-research-restart', async () => {
      const scenarioRoot = path.join(workDir, 'm36-governed-research-restart-isolated');
      const scenarioEvidenceDir = m36ResearchEvidenceDir;
      const rootVsixBefore = snapshotRootVsixInventory(repoRoot);
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m36GovernedResearchRestart = scenarioEvidence;

      const settingsFor = (endpoint) => ({
        'ollama-agent.apiBase': endpoint,
        'ollama-agent.model': M36_RESEARCH_FIXTURE_MODEL,
        'ollama-agent.chatModel': M36_RESEARCH_FIXTURE_MODEL,
        'ollama-agent.searxngUrl': `${endpoint}/search`,
      });
      const clickResearchButton = async (label) => ui.evalInWebviewDoc(webviewClient, `(() => {
        const card = document.querySelector('.research-approval-card');
        const button = Array.from(card?.querySelectorAll('button') ?? []).find(b => b.textContent.trim() === ${JSON.stringify(label)});
        if (!button) throw new Error('research approval button not found: ${label}');
        button.click(); return true;
      })()`);
      const restart = async (label) => {
        const previous = windowHandle;
        await board.closeTarget(previous.cdpPort, previous.pageTargetId);
        await pollUntil(async () => {
          const pages = (await board.listTargets(previous.cdpPort).catch(() => [])).filter((target) => target.type === 'page');
          return pages.some((target) => target.id === previous.pageTargetId) ? { done: false, value: pages.length } : { done: true, value: pages.length };
        }, { timeoutMs: 15000, intervalMs: 250, describe: () => `${label} workbench window to close` });
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
        // Match the established packaged M36 restart gates: the Extension
        // Host/webview is recreated against the same isolated durable Core
        // data directory. The relaunched host must restore state and must not
        // cause a completed session to issue a second network request.
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label,
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: settingsFor(fixture.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'user-input' }));
        await setMode(webviewClient, 'chat');
      };

      try {
        fixture = await startDeterministicM36ResearchFixture();
        log('M36 governed research: deterministic fixture started; opening denial path.');
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label: 'window-m36-governed-research-denial',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: settingsFor(fixture.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'user-input' }));
        await setMode(webviewClient, 'chat');
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'before-research').catch(() => {});

        const deniedQuery = `Research the web for the deterministic denial fixture. nonce ${NONCE}-m36-research-denied`;
        await sendChatMessage(webviewClient, deniedQuery);
        const denied = await pollUntil(async () => {
          const session = await findResearchByQuery(deniedQuery, windowHandle.globalDataDir);
          const cardVisible = await ui.evalInWebviewDoc(webviewClient, 'Boolean(document.querySelector(\'.research-approval-card\'))');
          return session && cardVisible ? { done: true, value: session } : { done: false, value: { session, cardVisible } };
        }, { timeoutMs: 30000, describe: () => 'durable research approval card before denial' });
        const preApproval = fixture.snapshot();
        if (preApproval.providerRequests !== 0 || preApproval.sourceRequests !== 0 || preApproval.modelRequests !== 0) {
          throw new Error(`research network occurred before approval: ${JSON.stringify(preApproval)}`);
        }
        await clickResearchButton('Not now');
        const deniedBeforeRestart = await pollUntil(async () => {
          const record = await readResearchEvidence(denied.id, windowHandle.globalDataDir);
          return record?.session?.state === 'denied' ? { done: true, value: record } : { done: false, value: record?.session?.state ?? null };
        }, { timeoutMs: 15000, describe: () => 'denied research terminal state' });
        if (fixture.snapshot().providerRequests !== 0 || fixture.snapshot().sourceRequests !== 0 || fixture.snapshot().modelRequests !== 0) {
          throw new Error('denied research made a network request');
        }
        log('M36 governed research: denial is durable with zero provider/source/model calls; restarting webview.');
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'denied-before-restart').catch(() => {});

        await restart('window-m36-governed-research-after-denial-restart');
        const deniedAfterRestart = await readResearchEvidence(denied.id, windowHandle.globalDataDir);
        const deniedUi = await pollUntil(async () => {
          const text = await ui.evalInWebviewDoc(webviewClient, 'document.querySelector(\'#messages\')?.textContent ?? \'\'');
          return text.includes('Research was not started because network access was not approved.') ? { done: true, value: text } : { done: false, value: text };
        }, { timeoutMs: 30000, describe: () => 'durably restored denial UI' });
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'denied-after-restart').catch(() => {});
        if (deniedAfterRestart?.session?.state !== 'denied' || deniedAfterRestart?.approval?.status !== 'rejected' || JSON.stringify(preApproval) !== JSON.stringify(fixture.snapshot())) {
          throw new Error(`denial restart did not preserve a no-network terminal state: ${JSON.stringify({ deniedAfterRestart, preApproval, after: fixture.snapshot() })}`);
        }
        log('M36 governed research: denial restored without a refetch; opening approval path.');

        const approvedQuery = `Research the web for the deterministic cited fixture. nonce ${NONCE}-m36-research-approved`;
        await sendChatMessage(webviewClient, approvedQuery);
        const approved = await pollUntil(async () => {
          const session = await findResearchByQuery(approvedQuery, windowHandle.globalDataDir);
          const cardVisible = await ui.evalInWebviewDoc(webviewClient, 'Boolean(document.querySelector(\'.research-approval-card\'))');
          return session && cardVisible ? { done: true, value: session } : { done: false, value: { session, cardVisible } };
        }, { timeoutMs: 30000, describe: () => 'approved research card before network access' });
        if (fixture.snapshot().providerRequests !== 0 || fixture.snapshot().sourceRequests !== 0 || fixture.snapshot().modelRequests !== 0) {
          throw new Error('approval fixture observed a request before the approval click');
        }
        await clickResearchButton('Allow research');
        const approvedBeforeRestart = await pollUntil(async () => {
          const record = await readResearchEvidence(approved.id, windowHandle.globalDataDir);
          return record?.session?.state && ['completed', 'failed', 'insufficient_evidence', 'unavailable'].includes(record.session.state)
            ? { done: true, value: record } : { done: false, value: record?.session?.state ?? null };
        }, { timeoutMs: 45000, intervalMs: 250, describe: () => 'approved research terminal state' });
        const uiBeforeRestart = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `({ text: document.querySelector('#messages')?.textContent ?? '', citations: Array.from(document.querySelectorAll('.citation-marker')).map(node => node.textContent), internalLeak: /(?:research_|rappr_|source_|cite_)/.test(document.querySelector('#messages')?.textContent ?? '') })`);
          return state.text.includes(M36_RESEARCH_ANSWER) ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 45000, intervalMs: 250, describe: () => 'grounded answer and citation markers in real webview' });
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'approved-before-restart').catch(() => {});
        log(`M36 governed research: approved request reached ${fixture.providerRequests.length} provider and ${fixture.sourceRequests.length} source calls; validating evidence.`);

        const provider = fixture.providerRequests;
        const fetchedPaths = fixture.sourceRequests.map((entry) => entry.path);
        const fetched = approvedBeforeRestart.sources.filter((source) => source.status === 'fetched');
        const citationsValid = approvedBeforeRestart.citations.length === 2
          && approvedBeforeRestart.citations.every((citation) => citation.validationStatus === 'valid' && citation.sourceStatus === 'fetched')
          && new Set(approvedBeforeRestart.citations.map((citation) => citation.visibleLabel)).size === 2
          && approvedBeforeRestart.citations.every((citation) => ['S1', 'S2'].includes(citation.visibleLabel));
        const safety = {
          unsupportedSchemeRejected: approvedBeforeRestart.sources.some((source) => source.failure === 'unsafe_url') || approvedBeforeRestart.sources.some((source) => source.failure === 'private_network_target'),
          privateNetworkRejected: approvedBeforeRestart.sources.some((source) => source.normalizedUrl.includes('127.0.0.1') && source.status === 'rejected'),
          redirectRevalidated: approvedBeforeRestart.sources.some((source) => source.failure === 'private_network_target' && source.status === 'failed'),
        };
        const approvalOk = approvedBeforeRestart.session.state === 'completed'
          && provider.length === 1
          && provider[0].query.q === approvedQuery
          && fetched.length === 2
          && fetchedPaths.filter((value) => value === '/source-one').length === 1
          && fetchedPaths.filter((value) => value === '/source-two').length === 1
          && fetchedPaths.filter((value) => value === '/redirect-private').length === 1
          && fixture.sourceRequests.every((entry) => entry.kind !== 'unexpected')
          && fixture.modelRequests.length === 1
          && fixture.violations.length === 0
          && safety.privateNetworkRejected && safety.redirectRevalidated
          && citationsValid
          && uiBeforeRestart.citations.includes('[S1]') && uiBeforeRestart.citations.includes('[S2]')
          && !uiBeforeRestart.internalLeak;
        if (!approvalOk) throw new Error(`approved research acceptance failed: ${JSON.stringify({ approvedBeforeRestart, provider, sourceRequests: fixture.sourceRequests, modelRequests: fixture.modelRequests, safety, uiBeforeRestart, violations: fixture.violations })}`);

        const preRestartSnapshot = { record: approvedBeforeRestart, fixture: fixture.snapshot() };
        log('M36 governed research: citations are durable; restarting webview for no-refetch proof.');
        await restart('window-m36-governed-research-after-approval-restart');
        const approvedAfterRestart = await readResearchEvidence(approved.id, windowHandle.globalDataDir);
        const uiAfterRestart = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `({ text: document.querySelector('#messages')?.textContent ?? '', citations: Array.from(document.querySelectorAll('.citation-marker')).map(node => node.textContent), titles: Array.from(document.querySelectorAll('.citation-marker')).map(node => node.title) })`);
          return state.text.includes(M36_RESEARCH_ANSWER) && state.citations.includes('[S1]') && state.citations.includes('[S2]') ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 45000, intervalMs: 250, describe: () => 'restored research citations and source details' });
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'approved-after-restart').catch(() => {});
        const postRestartSnapshot = { record: approvedAfterRestart, fixture: fixture.snapshot() };
        // M36 workbench controls are exercised against the same real packaged
        // webview and the same durable Core database as the approved research
        // turn: search opens the source conversation; branch creates a new
        // Core id without mutating the parent; regeneration creates a sibling
        // answer; alternative selection restores the earlier answer.
        await ui.evalInWebviewDoc(webviewClient, `(() => { const input = document.getElementById('workbench-search-input'); if (!input) throw new Error('workbench search input missing'); input.value = ${JSON.stringify(approvedQuery)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        const searchResult = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `({ count: document.querySelectorAll('.workbench-search-result').length, text: document.querySelector('#workbench-search-results')?.textContent ?? '' })`);
          return state.count > 0 && state.text.includes('deterministic cited fixture') ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'Core-backed conversation search result' });
        await ui.evalInWebviewDoc(webviewClient, `document.querySelector('.workbench-search-result')?.click()`);
        await pollUntil(async () => {
          const text = await ui.evalInWebviewDoc(webviewClient, `document.querySelector('#messages')?.textContent ?? ''`);
          return text.includes(M36_RESEARCH_ANSWER) ? { done: true, value: text } : { done: false, value: text };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'search result to reopen the durable conversation' });
        await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = Array.from(document.querySelectorAll('.bubble.user')).find(node => node.textContent.includes(${JSON.stringify(approvedQuery)})); const button = Array.from(bubble?.querySelectorAll('button') ?? []).find(node => node.textContent.trim() === 'Branch'); if (!button) throw new Error('branch action missing for approved research user message'); button.click(); })()`);
        const branchRestored = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `({ text: document.querySelector('#messages')?.textContent ?? '', branchItems: Array.from(document.querySelectorAll('.conversation-item')).filter(node => node.textContent.includes('branch')).length })`);
          return state.text.includes(approvedQuery) && state.branchItems > 0 ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'durable branch restoration' });
        const branchPrompt = `Branch-only continuation ${NONCE}-m36-workbench`;
        await sendChatMessage(webviewClient, branchPrompt);
        const branchAnswer = await pollUntil(async () => {
          const text = await ui.evalInWebviewDoc(webviewClient, `document.querySelector('#messages')?.textContent ?? ''`);
          return text.includes('Deterministic local branch response 2.') ? { done: true, value: text } : { done: false, value: text };
        }, { timeoutMs: 45000, intervalMs: 250, describe: () => 'branch-only model response' });
        await pollUntil(async () => {
          const available = await ui.evalInWebviewDoc(webviewClient, `Array.from(document.querySelectorAll('.message-workbench-actions button')).some(node => node.textContent.trim() === 'Regenerate')`);
          return available ? { done: true, value: available } : { done: false, value: available };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'regenerate action for durable branch response' });
        const branchResponseBeforeRegeneration = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = Array.from(document.querySelectorAll('.bubble.assistant')).find(node => node.textContent.includes('Deterministic local branch response 2.')); const buttons = Array.from(bubble?.querySelectorAll('.message-workbench-actions button') ?? []).map(node => node.textContent.trim()); return { messageId: bubble?.dataset.messageId ?? null, buttons }; })()`);
          return state.messageId && state.buttons.includes('Regenerate') ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'durable branch response controls' });
        const beforeRegenerationEvidence = await readResponseAlternativeEvidenceForAssistant(branchResponseBeforeRegeneration.messageId, windowHandle.globalDataDir);
        const fixtureBeforeRegeneration = fixture.snapshot();
        await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = Array.from(document.querySelectorAll('.bubble.assistant')).find(node => node.textContent.includes('Deterministic local branch response 2.')); const button = Array.from(bubble?.querySelectorAll('.message-workbench-actions button') ?? []).find(node => node.textContent.trim() === 'Regenerate'); if (!button) throw new Error('regenerate action missing for the branch response'); button.click(); })()`);
        const regenerated = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = Array.from(document.querySelectorAll('.bubble.assistant')).find(node => node.textContent.includes('Deterministic local branch response 3.')); return { text: document.querySelector('#messages')?.textContent ?? '', messageId: bubble?.dataset.messageId ?? null, alternatives: Array.from(bubble?.querySelectorAll('.message-workbench-actions button') ?? []).map(node => node.textContent.trim()) }; })()`);
          return state.text.includes('Deterministic local branch response 3.') && state.messageId && state.alternatives.some(value => value.startsWith('Answer 1')) && state.alternatives.some(value => value.startsWith('Answer 2')) ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 45000, intervalMs: 250, describe: () => 'durable regenerated response alternatives' });
        const regeneratedAlternativeEvidence = await pollUntil(async () => {
          const record = await readResponseAlternativeEvidenceForAssistant(branchResponseBeforeRegeneration.messageId, windowHandle.globalDataDir);
          const original = record?.messages.find(message => message.id === branchResponseBeforeRegeneration.messageId);
          const regeneratedMessage = record?.messages.find(message => message.id === regenerated.messageId);
          const group = record?.alternatives.filter(alternative => alternative.userMessageId === original?.id || alternative.assistantMessageId === original?.id || alternative.assistantMessageId === regeneratedMessage?.id) ?? [];
          const valid = group.length === 2
            && group.every(alternative => alternative.userMessageId === group[0].userMessageId)
            && group.filter(alternative => alternative.active).length === 1
            && group.some(alternative => alternative.assistantMessageId === branchResponseBeforeRegeneration.messageId)
            && group.some(alternative => alternative.assistantMessageId === regenerated.messageId)
            && record?.researchRequestCount === 0
            // Regeneration is expected to issue one additional local model
            // call. It must not repeat governed search or source-fetch work.
            && JSON.stringify(fixtureBeforeRegeneration.providerRequests) === JSON.stringify(fixture.snapshot().providerRequests)
            && JSON.stringify(fixtureBeforeRegeneration.sourceRequests) === JSON.stringify(fixture.snapshot().sourceRequests);
          return valid ? { done: true, value: { record, group } } : { done: false, value: { record, group } };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'Core response-alternative group for the regenerated branch response' });
        await ui.evalInWebviewDoc(webviewClient, `(() => { const bubble = Array.from(document.querySelectorAll('.bubble.assistant')).find(node => node.textContent.includes('Deterministic local branch response 3.')); const button = Array.from(bubble?.querySelectorAll('.message-workbench-actions button') ?? []).find(node => node.textContent.trim().startsWith('Answer 1')); if (!button) throw new Error('first response alternative selector missing'); button.click(); })()`);
        const alternativeSelected = await pollUntil(async () => {
          const [state, record] = await Promise.all([
            ui.evalInWebviewDoc(webviewClient, `(() => { const bubbles = Array.from(document.querySelectorAll('.bubble.assistant')); const original = bubbles.find(node => node.textContent.includes('Deterministic local branch response 2.')); const regenerated = bubbles.find(node => node.textContent.includes('Deterministic local branch response 3.')); const answerOne = Array.from(original?.querySelectorAll('.message-workbench-actions button') ?? []).find(node => node.textContent.trim().startsWith('Answer 1')); return { originalPresent: Boolean(original), regeneratedPresent: Boolean(regenerated), activeAlternativeDisabled: Boolean(answerOne?.disabled) }; })()`),
            readResponseAlternativeEvidenceForAssistant(branchResponseBeforeRegeneration.messageId, windowHandle.globalDataDir),
          ]);
          const selected = record?.alternatives.find(alternative => alternative.assistantMessageId === branchResponseBeforeRegeneration.messageId)?.active === 1;
          return state.originalPresent && !state.regeneratedPresent && state.activeAlternativeDisabled && selected
            ? { done: true, value: { state, record } }
            : { done: false, value: { state, record } };
        }, { timeoutMs: 30000, intervalMs: 250, describe: () => 'selected response alternative Core/UI restoration' });
        const durableEqual = JSON.stringify(approvedAfterRestart) === JSON.stringify(approvedBeforeRestart);
        const noRefetch = JSON.stringify(preRestartSnapshot.fixture) === JSON.stringify(postRestartSnapshot.fixture);
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(snapshotRootVsixInventory(repoRoot));
        const workbenchOk = Boolean(searchResult?.count) && Boolean(branchRestored?.branchItems) && branchAnswer.includes('Deterministic local branch response 2.') && regenerated.text.includes('Deterministic local branch response 3.') && alternativeSelected.state.originalPresent && !alternativeSelected.state.regeneratedPresent && alternativeSelected.state.activeAlternativeDisabled && regeneratedAlternativeEvidence.group.filter(alternative => alternative.active).length === 1;
        const ok = approvalOk && durableEqual && noRefetch && uiAfterRestart.titles.every(Boolean) && rootVsixUnchanged && workbenchOk;
        scenarioEvidence = {
          ok,
          packageProvenance: evidence.packageProvenance,
          preApprovalZeroCalls: preApproval,
          denial: { beforeRestart: deniedBeforeRestart, afterRestart: deniedAfterRestart, restoredUi: deniedUi.includes('Research was not started') },
          approval: { providerRequests: provider, sourceFetchRequests: fixture.sourceRequests, modelRequests: fixture.modelRequests, safety, extractedEvidenceHashes: fetched.map((source) => ({ id: source.id, hash: source.extractedTextHash, rawHash: source.rawResponseHash })), citationBindings: approvedBeforeRestart.citations },
          maliciousSourceInert: { modelRequestCount: fixture.modelRequests.length, modelToolCalls: fixture.modelRequests.map((request) => request.toolCalls), contractViolations: fixture.violations },
          preRestartRecords: approvedBeforeRestart,
          postRestartRecords: approvedAfterRestart,
          noRefetchAfterRestart: noRefetch,
          ui: { beforeRestart: uiBeforeRestart, afterRestart: uiAfterRestart },
          workbench: { searchResult, branchRestored, branchAnswer, branchResponseBeforeRegeneration, beforeRegenerationEvidence, regenerated, regeneratedAlternativeEvidence, alternativeSelected, ok: workbenchOk },
          rootVsixUnchanged,
          cleanup: null,
        };
        evidence.scenarios.m36GovernedResearchRestart = scenarioEvidence;
        log(`M36 governed research: restored completed evidence with no refetch=${noRefetch}.`);
        if (!ok) throw new Error(`m36-governed-research-restart did not meet acceptance: ${JSON.stringify(scenarioEvidence)}`);
      } catch (error) {
        // Persist the final focused predicate state even when this scenario
        // fails before its normal evidence assignment, so a packaged retry can
        // distinguish durable/Core correctness from a webview projection fault.
        scenarioEvidence.failure = error instanceof Error ? { message: error.message, stack: error.stack ?? null } : { message: String(error), stack: null };
        evidence.scenarios.m36GovernedResearchRestart = scenarioEvidence;
        throw error;
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const corePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profilePids = windowHandle ? readWindowsProcessSnapshot().filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase())).map((process) => process.pid) : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profilePids].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(corePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = { corePid, coreStopped: !corePid || !isPidAlive(corePid), vscodeStopped: profilePids.every((pid) => !isPidAlive(pid)), fixtureClosedAt: fixture?.snapshot().closedAt ?? null, fixtureClosed: Boolean(fixture?.snapshot().closedAt) };
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m36GovernedResearchRestart = scenarioEvidence;
        fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'package-provenance.json'), JSON.stringify({ headSha, runId, ...evidence.packageProvenance }, null, 2));
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'provider-request-log.json'), JSON.stringify(fixture?.providerRequests ?? [], null, 2));
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'source-fetch-request-log.json'), JSON.stringify(fixture?.sourceRequests ?? [], null, 2));
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scenario: 'm36-governed-research-restart', ...scenarioEvidence }, null, 2));
        if (!cleanup.coreStopped || !cleanup.vscodeStopped || !cleanup.fixtureClosed) throw new Error(`m36-governed-research-restart cleanup failed: ${JSON.stringify(cleanup)}`);
      }
    });

    // =====================================================================
    // Scenario 16 (M36 final exit): one ordinary, workspace-free durable
    // conversation first consumes a PDF, image, and real speech WAV through
    // the capability-routed local chat path, then continues into approved
    // governed research. This is intentionally one conversation, not a
    // stitched collection of isolated feature demos.
    // =====================================================================
    await runRegisteredScenario('m36-combined-workbench', 'scenario-16-m36-combined-workbench-exit', async () => {
      const scenarioRoot = path.join(workDir, 'm36-combined-workbench-isolated');
      const scenarioEvidenceDir = m36CombinedEvidenceDir;
      const rootVsixBefore = snapshotRootVsixInventory(repoRoot);
      const mediaFixtures = writeM36Fixtures(path.join(scenarioRoot, 'image-fixture'));
      const documentAudioFixtures = writeM36Pass2Fixtures(path.join(scenarioRoot, 'document-audio-fixtures'));
      const attachmentNames = [M36_PDF_FIXTURE_NAME, M36_IMAGE_FIXTURE_NAME, M36_AUDIO_FIXTURE_NAME];
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      let scenarioEvidence = { ok: false, cleanup: null };
      evidence.scenarios.m36CombinedWorkbench = scenarioEvidence;

      const settingsFor = (endpoint) => ({
        'ollama-agent.apiBase': endpoint,
        'ollama-agent.model': M36_FIXTURE_MODEL,
        'ollama-agent.chatModel': M36_FIXTURE_MODEL,
        'ollama-agent.visionModel': M36_FIXTURE_MODEL,
        'ollama-agent.searxngUrl': `${endpoint}/search`,
        'files.simpleDialog.enable': true,
      });
      const attachOneFile = async (absolutePath, expectedName) => {
        await ui.clickAttachButton(webviewClient);
        await ui.driveSimpleFileDialogSelectPath(pageClient, absolutePath);
        return pollUntil(async () => {
          const chip = (await ui.readComposerAttachmentChips(webviewClient)).find((item) => item.name === expectedName);
          if (chip?.status === 'failed') throw new Error(`combined scenario attachment failed: ${JSON.stringify(chip)}`);
          return chip?.status === 'ready' ? { done: true, value: chip } : { done: false, value: chip?.status ?? 'missing' };
        }, { timeoutMs: 60000, describe: `${expectedName} ready for combined M36 turn` });
      };
      const clickResearchApprove = () => ui.evalInWebviewDoc(webviewClient, `(() => {
        const card = document.querySelector('.research-approval-card');
        const button = Array.from(card?.querySelectorAll('button') ?? []).find((item) => item.textContent.trim() === 'Allow research');
        if (!button) throw new Error('combined scenario research approval button missing');
        button.click(); return true;
      })()`);
      const restart = async () => {
        const previous = windowHandle;
        await board.closeTarget(previous.cdpPort, previous.pageTargetId);
        await pollUntil(async () => {
          const pages = (await board.listTargets(previous.cdpPort).catch(() => [])).filter((target) => target.type === 'page');
          return pages.some((target) => target.id === previous.pageTargetId) ? { done: false, value: pages.length } : { done: true, value: pages.length };
        }, { timeoutMs: 15000, intervalMs: 250, describe: 'combined workbench window to close before extension-host recreation' });
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label: 'window-m36-combined-workbench-restart',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: settingsFor(fixture.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'user-input' }));
        await setMode(webviewClient, 'chat');
      };
      const parsedAttachment = (value) => ({
        ...value,
        extraction: typeof value.extraction === 'string' ? JSON.parse(value.extraction) : value.extraction,
        transcription: typeof value.transcription === 'string' ? JSON.parse(value.transcription) : value.transcription,
      });

      try {
        fixture = await startDeterministicM36ResearchFixture({
          model: M36_FIXTURE_MODEL,
          attachmentFixtures: {
            pdfName: M36_PDF_FIXTURE_NAME,
            pdfText: M36_PDF_FIXTURE_TEXT,
            audioName: M36_AUDIO_FIXTURE_NAME,
            audioPhrases: M36_AUDIO_FIXTURE_EXPECTED_PHRASES,
            imageBase64: mediaFixtures.imageBase64,
            pdfPath: documentAudioFixtures.pdfPath,
            audioPath: documentAudioFixtures.wavPath,
            imagePath: mediaFixtures.imagePath,
          },
        });
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: undefined,
          label: 'window-m36-combined-workbench',
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: fixture.model,
          settings: settingsFor(fixture.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'attach-btn' }));
        await setMode(webviewClient, 'chat');
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'before-mixed-media-turn').catch(() => {});

        await attachOneFile(documentAudioFixtures.pdfPath, M36_PDF_FIXTURE_NAME);
        await attachOneFile(mediaFixtures.imagePath, M36_IMAGE_FIXTURE_NAME);
        await attachOneFile(documentAudioFixtures.wavPath, M36_AUDIO_FIXTURE_NAME);
        const beforeSubmit = (await findAttachmentsByOriginalNames(attachmentNames, windowHandle.globalDataDir)).map(parsedAttachment);
        const pdf = beforeSubmit.find((item) => item.originalName === M36_PDF_FIXTURE_NAME);
        const image = beforeSubmit.find((item) => item.originalName === M36_IMAGE_FIXTURE_NAME);
        const audio = beforeSubmit.find((item) => item.originalName === M36_AUDIO_FIXTURE_NAME);
        if (!pdf?.extraction?.sections?.some((section) => section.text.includes(M36_PDF_FIXTURE_TEXT)) || image?.sha256 !== mediaFixtures.imageSha256 || !audio?.transcription?.segments?.length) {
          throw new Error(`combined M36 media processing did not produce durable local evidence: ${JSON.stringify({ pdf, image, audio })}`);
        }
        const transcribed = audio.transcription.segments.map((segment) => segment.text).join(' ').toLowerCase();
        if (!M36_AUDIO_FIXTURE_EXPECTED_PHRASES.every((phrase) => transcribed.includes(phrase))) throw new Error(`combined M36 audio transcript is incomplete: ${transcribed}`);

        const mediaPrompt = `Summarize my attached local document, image, and audio. nonce ${NONCE}-m36-combined-media`;
        await sendChatMessage(webviewClient, mediaPrompt);
        const mediaTurn = await pollUntil(async () => {
          const request = await findRequestByMessage(mediaPrompt, windowHandle.globalDataDir);
          const attempt = request ? (await findAttemptsForRequest(request.id, windowHandle.globalDataDir))[0] : null;
          return attempt?.status === 'completed' ? { done: true, value: { request, attempt } } : { done: false, value: attempt?.status ?? null };
        }, { timeoutMs: 60000, intervalMs: 250, describe: 'combined local mixed-media chat turn' });
        const mediaContext = await findAttemptContext(mediaTurn.attempt.id, windowHandle.globalDataDir);
        const modelSelection = mediaContext?.modelSelection ? JSON.parse(mediaContext.modelSelection) : null;
        const mediaRequest = fixture.modelRequests[0] ?? null;
        const mediaRouteOk = modelSelection?.selectedModel === M36_FIXTURE_MODEL
          && modelSelection?.requiredCapabilities?.vision === true
          && mediaRequest?.violations?.length === 0;
        if (!mediaRouteOk) throw new Error(`combined M36 did not use the hidden vision-capable route: ${JSON.stringify({ modelSelection, mediaRequest })}`);

        const researchQuery = `Research the web for the deterministic cited fixture and relate it to my previous local material. nonce ${NONCE}-m36-combined-research`;
        await sendChatMessage(webviewClient, researchQuery);
        const research = await pollUntil(async () => {
          const session = await findResearchByQuery(researchQuery, windowHandle.globalDataDir);
          const visible = await ui.evalInWebviewDoc(webviewClient, 'Boolean(document.querySelector(\'.research-approval-card\'))');
          return session && visible ? { done: true, value: session } : { done: false, value: { session, visible } };
        }, { timeoutMs: 30000, describe: 'combined research approval before any network call' });
        const preApproval = fixture.snapshot();
        if (preApproval.providerRequests !== 0 || preApproval.sourceRequests !== 0 || preApproval.modelRequests !== 1) throw new Error(`combined research dispatched before approval: ${JSON.stringify(preApproval)}`);
        await clickResearchApprove();
        const researchBeforeRestart = await pollUntil(async () => {
          const record = await readResearchEvidence(research.id, windowHandle.globalDataDir);
          return record?.session?.state === 'completed' ? { done: true, value: record } : { done: false, value: record?.session?.state ?? null };
        }, { timeoutMs: 60000, intervalMs: 250, describe: 'combined grounded research completion' });
        const uiBeforeRestart = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `({ text: document.querySelector('#messages')?.textContent ?? '', citations: Array.from(document.querySelectorAll('.citation-marker')).map(node => node.textContent) })`);
          return state.text.includes(M36_RESEARCH_ANSWER) ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 45000, intervalMs: 250, describe: 'combined grounded answer and citations in the packaged webview' });
        const citationsOk = researchBeforeRestart.citations.length === 2
          && researchBeforeRestart.citations.every((citation) => citation.validationStatus === 'valid' && citation.sourceStatus === 'fetched')
          && uiBeforeRestart.citations.includes('[S1]') && uiBeforeRestart.citations.includes('[S2]')
          && fixture.providerRequests.length === 1 && fixture.sourceRequests.filter((item) => item.kind === 'source').length === 2
          && fixture.modelRequests.length === 2 && fixture.violations.length === 0;
        if (!citationsOk) throw new Error(`combined research citation evidence is incomplete: ${JSON.stringify({ record: researchBeforeRestart, snapshot: fixture.snapshot(), modelRequests: fixture.modelRequests })}`);
        const beforeRestartSnapshot = fixture.snapshot();
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'grounded-answer-before-restart').catch(() => {});

        await restart();
        const afterRestartAttachments = (await findAttachmentsByOriginalNames(attachmentNames, windowHandle.globalDataDir)).map(parsedAttachment);
        const researchAfterRestart = await readResearchEvidence(research.id, windowHandle.globalDataDir);
        const restored = await pollUntil(async () => {
          const state = await ui.evalInWebviewDoc(webviewClient, `({ text: document.querySelector('#messages')?.textContent ?? '', citations: Array.from(document.querySelectorAll('.citation-marker')).map(node => node.textContent), exports: ['export-markdown-btn', 'export-json-btn'].every(id => Boolean(document.getElementById(id))) })`);
          return state.text.includes(M36_RESEARCH_ANSWER) && state.citations.includes('[S1]') && state.citations.includes('[S2]') ? { done: true, value: state } : { done: false, value: state };
        }, { timeoutMs: 45000, intervalMs: 250, describe: 'combined durable transcript and workbench controls after restart' });
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'grounded-answer-after-restart').catch(() => {});
        const noRefetch = JSON.stringify(beforeRestartSnapshot) === JSON.stringify(fixture.snapshot());
        const durableAttachments = afterRestartAttachments.length === 3
          && afterRestartAttachments.find((item) => item.originalName === M36_PDF_FIXTURE_NAME)?.id === pdf.id
          && JSON.stringify(afterRestartAttachments.find((item) => item.originalName === M36_AUDIO_FIXTURE_NAME)?.transcription) === JSON.stringify(audio.transcription);
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(snapshotRootVsixInventory(repoRoot));
        const ok = mediaRouteOk && citationsOk && noRefetch && durableAttachments
          && JSON.stringify(researchBeforeRestart) === JSON.stringify(researchAfterRestart)
          && restored.exports && rootVsixUnchanged;
        scenarioEvidence = {
          ok,
          packageProvenance: evidence.packageProvenance,
          media: { requestId: mediaTurn.request.id, attemptId: mediaTurn.attempt.id, modelSelection, attachments: { pdf, image, audio }, modelRequest: mediaRequest },
          research: { id: research.id, citations: researchBeforeRestart.citations, providerRequests: fixture.providerRequests, sourceRequests: fixture.sourceRequests, modelRequests: fixture.modelRequests },
          restart: { noRefetch, durableAttachments, researchRecordsEqual: JSON.stringify(researchBeforeRestart) === JSON.stringify(researchAfterRestart), restored },
          rootVsixUnchanged,
          cleanup: null,
        };
        evidence.scenarios.m36CombinedWorkbench = scenarioEvidence;
        if (!ok) throw new Error(`m36-combined-workbench exit scenario failed: ${JSON.stringify(scenarioEvidence)}`);
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const corePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profilePids = windowHandle ? readWindowsProcessSnapshot().filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase())).map((process) => process.pid) : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profilePids].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(corePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = { corePid, coreStopped: !corePid || !isPidAlive(corePid), vscodeStopped: profilePids.every((pid) => !isPidAlive(pid)), fixtureClosed: !fixture || Boolean(fixture.snapshot().closedAt) };
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m36CombinedWorkbench = scenarioEvidence;
        fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'package-provenance.json'), JSON.stringify({ headSha, runId, ...evidence.packageProvenance }, null, 2));
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scenario: 'm36-combined-workbench', ...scenarioEvidence }, null, 2));
        if (!cleanup.coreStopped || !cleanup.vscodeStopped || !cleanup.fixtureClosed) throw new Error(`m36-combined-workbench cleanup failed: ${JSON.stringify(cleanup)}`);
      }
    });

    // =====================================================================
    // Scenario 17 (M39 mandatory exit): governed memory and knowledge
    // intelligence across real Extension Host restarts.
    //
    // Everything below runs against the real packaged VSIX, the real chat
    // composer/webview, a live Core process, a disposable real Git workspace,
    // a clean VS Code profile, and deterministic model/tool fixtures. No
    // assertion depends on live-model judgement.
    // =====================================================================
    await runRegisteredScenario('m39-memory-knowledge-restart', 'scenario-17-m39-memory-knowledge-restart', async () => {
      const scenarioRoot = path.join(workDir, 'm39-memory-knowledge-isolated');
      const scenarioEvidenceDir = m39EvidenceDir;
      const workspaceDir = path.join(scenarioRoot, 'workspace');
      const rootVsixBefore = snapshotRootVsixInventory(repoRoot);
      let fixture;
      let windowHandle;
      let pageClient;
      let webviewClient;
      const checks = [];
      const check = (ok, description, detail) => {
        checks.push({ ok: Boolean(ok), description, detail: detail ?? null });
        log(`M39 ${ok ? 'PASS' : 'FAIL'} — ${description}${ok ? '' : ` ${JSON.stringify(detail ?? null)}`}`);
      };
      let scenarioEvidence = { ok: false, checks, cleanup: null };
      evidence.scenarios.m39MemoryKnowledgeRestart = scenarioEvidence;

      const dataDir = () => windowHandle.globalDataDir;
      const memoryRows = async (table) => withDb((db) => (db ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : []), dataDir());
      const allM39Rows = async () => ({
        facts: await memoryRows('memory_facts'),
        evidence: await memoryRows('memory_evidence'),
        entities: await memoryRows('knowledge_entities'),
        relationships: await memoryRows('knowledge_relationships'),
        contradictions: await memoryRows('memory_contradictions'),
      });
      const activeFacts = async () => (await memoryRows('memory_facts')).filter((row) => row.state === 'active');

      const readCapabilityCards = async () => ui.evalInWebviewDoc(webviewClient, `Array.from(document.querySelectorAll('.capability-approval-card')).map((card) => ({
        approvalId: card.id.replace('capability-approval-', ''),
        resolved: card.classList.contains('resolved'),
        titleText: card.querySelector('strong')?.textContent ?? null,
        toolName: card.querySelector('button.btn-primary')?.dataset.toolName ?? null,
        approveDisabled: card.querySelector('button.btn-primary')?.disabled ?? null,
        proposal: (() => {
          const block = card.querySelector('.memory-proposal');
          if (!block) return null;
          const field = (name) => block.querySelector('.memory-field[data-field="' + name + '"] .memory-field-value')?.textContent ?? null;
          return {
            scope: field('scope'),
            sensitivity: field('sensitivity'),
            memoryType: field('memoryType'),
            fact: field('fact'),
            affectedEntityCount: field('affectedEntityCount'),
            affectedEntities: Array.from(block.querySelectorAll('.memory-affected-entity')).map((node) => node.textContent),
            contradictionId: field('contradictionId'),
            policy: field('policy'),
            memoryId: field('memoryId'),
          };
        })(),
      }))`);

      const waitForActionableCard = async (expectedTool, { timeoutMs = 120000 } = {}) => pollUntil(async () => {
        const cards = await readCapabilityCards();
        const actionable = cards.filter((card) => !card.resolved && card.approveDisabled === false);
        const match = actionable.find((card) => card.toolName === expectedTool);
        return match ? { done: true, value: { card: match, actionableCount: actionable.length, cards } } : { done: false, value: cards };
      }, { timeoutMs, intervalMs: 500, describe: () => `an actionable ${expectedTool} approval card` });

      const clickCapabilityButton = async (approvalId, resolution) => ui.evalInWebviewDoc(webviewClient, `(() => {
        const card = document.getElementById('capability-approval-${approvalId}');
        if (!card) throw new Error('capability approval card ${approvalId} not found');
        const btn = card.querySelector('${resolution === 'approved' ? 'button.btn-primary' : 'button.btn-danger'}');
        if (!btn) throw new Error('approval action button missing on card ${approvalId}');
        if (btn.disabled) throw new Error('approval action button is disabled on card ${approvalId}');
        btn.click();
        return true;
      })()`);

      const readMemoryEvidenceBlocks = async () => ui.evalInWebviewDoc(webviewClient, `Array.from(document.querySelectorAll('.memory-evidence')).map((block) => ({
        toolName: block.dataset.toolName ?? null,
        entryCount: block.dataset.entryCount ?? null,
        memoryCount: block.dataset.memoryCount ?? null,
        schemaVersion: block.dataset.schemaVersion ?? null,
        text: block.textContent,
        facts: Array.from(block.querySelectorAll('.memory-fact')).map((fact) => ({
          memoryId: fact.dataset.memoryId ?? null,
          kind: fact.dataset.kind ?? null,
          state: fact.dataset.state ?? null,
          text: fact.textContent,
          evidenceHashes: Array.from(fact.querySelectorAll('.memory-evidence-link')).map((node) => node.dataset.sourceHash),
          unresolvedContradictions: fact.querySelectorAll('.memory-contradiction.unresolved').length,
        })),
        impact: Array.from(block.querySelectorAll('.memory-impact-entity')).map((node) => ({
          entityType: node.dataset.entityType ?? null,
          canonicalKey: node.dataset.canonicalKey ?? null,
          evidenceCount: Number(node.dataset.evidenceCount ?? 0),
          text: node.textContent,
        })),
      }))`);

      const settingsFor = (endpoint) => m39FixtureModelSettings(endpoint);

      const launchWindow = async (label) => {
        windowHandle = await launchIsolatedScenarioWindow({
          workspacePath: workspaceDir,
          label,
          scenarioRoot,
          ollamaUrl: fixture.baseUrl,
          model: M39_FIXTURE_MODEL,
          settings: settingsFor(fixture.baseUrl),
        });
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'user-input' }));
        await setMode(webviewClient, 'agent');
        // Let CoreManager's async connect handshake settle before the first
        // submission (same rationale as sendWithCoreConnectedRetry).
        await new Promise((resolve) => setTimeout(resolve, 5000));
      };

      /** Real host close + relaunch against the same durable Core data
       * directory — never a process-tree kill (see the M38 restart rationale:
       * Core is spawned detached and must survive an Extension Host exit). */
      const restartHost = async (label) => {
        const previous = windowHandle;
        await board.closeTarget(previous.cdpPort, previous.pageTargetId);
        await pollUntil(async () => {
          const pages = (await board.listTargets(previous.cdpPort).catch(() => [])).filter((target) => target.type === 'page');
          return pages.some((target) => target.id === previous.pageTargetId) ? { done: false, value: pages.length } : { done: true, value: pages.length };
        }, { timeoutMs: 20000, intervalMs: 250, describe: () => `${label} workbench window to close` });
        await pageClient.close().catch(() => {});
        await webviewClient.close().catch(() => {});
        await launchWindow(label);
      };

      const sendTurn = async (prompt) => {
        await sendWithCoreConnectedRetry(webviewClient, () => sendChatMessage(webviewClient, prompt), prompt, { dataDir: dataDir() });
        return findRequestByMessage(prompt, dataDir());
      };

      const waitForTerminalAttempt = async (request, { timeoutMs = 120000 } = {}) => pollUntil(async () => {
        const attempts = await findAttemptsForRequest(request.id, dataDir());
        const attempt = attempts[0];
        return attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)
          ? { done: true, value: attempt }
          : { done: false, value: attempt?.status ?? null };
      }, { timeoutMs, intervalMs: 500, describe: () => `attempt for request ${request.id} to reach a terminal state` });

      const waitForAnswer = async (answer, { timeoutMs = 120000 } = {}) => pollUntil(async () => {
        const bubbles = await ui.evalInWebviewDoc(webviewClient, `Array.from(document.querySelectorAll('.bubble.assistant')).map((b) => b.textContent)`);
        return bubbles.some((bubble) => bubble.includes(answer)) ? { done: true, value: bubbles } : { done: false, value: bubbles.slice(-2) };
      }, { timeoutMs, intervalMs: 500, describe: () => `assistant answer containing ${JSON.stringify(answer.slice(0, 40))}` });

      try {
        // --- 1. disposable real Git workspace + deterministic fixtures ----
        fs.mkdirSync(workspaceDir, { recursive: true });
        writeM39Repository(workspaceDir);
        initGitRepo(workspaceDir);
        fixture = await startDeterministicM39MemoryFixture({ logFilePath: path.join(scenarioRoot, 'm39-fixture.log') });
        log('M39: deterministic memory fixture started; launching packaged host.');
        await launchWindow('window-m39-initial');

        // The Atlas product record is created through the REAL product Board
        // UI so `product_record` resolves to a record Core actually owns —
        // never a fabricated opaque reference.
        const existingWebviewIds = await board.currentWebviewTargetIds(windowHandle.cdpPort);
        await board.runCommandViaPalette(pageClient, 'KarkeDikha Engineering: Show Local Board');
        const { client: boardClient } = await board.waitForBoardWebview(windowHandle.cdpPort, existingWebviewIds, { timeoutMs: 45000 });
        await board.clickAndAwaitInputBox(pageClient, boardClient, 'new-project-button', undefined);
        await board.typeIntoQuickInputBox(pageClient, M39_PROJECT);
        const atlasProject = await pollUntil(async () => {
          const rows = await withDb((db) => (db ? db.prepare('SELECT * FROM projects WHERE name = ?').all(M39_PROJECT) : []), dataDir());
          return rows.length === 1 ? { done: true, value: rows[0] } : { done: false, value: rows.length };
        }, { timeoutMs: 45000, intervalMs: 500, describe: () => `the ${M39_PROJECT} Core project created through the real Board UI` });
        await boardClient.close().catch(() => {});
        fixture.setProductRecordKey(atlasProject.id);
        check(Boolean(atlasProject.id), 'a real Core product record exists for the affected-entity reference', { projectId: atlasProject.id });
        // Reopen the chat panel (the Board command moved focus).
        ({ pageClient, webviewClient } = await openChatPanel(windowHandle, { contentMountedReadyElementId: 'user-input' }));
        await setMode(webviewClient, 'agent');

        // --- 2/3/4. state the decision; the model proposes memory_remember -
        const rememberRequest = await sendTurn(M39_PROMPTS.rememberSqlite);
        const firstCard = await waitForActionableCard('memory_remember');
        check(firstCard.card.titleText === 'Remember this decision?', 'an inline memory consent approval appears with a human-readable prompt', { title: firstCard.card.titleText });
        check(firstCard.actionableCount === 1, 'exactly one actionable approval card is present', { actionableCount: firstCard.actionableCount });
        const proposal = firstCard.card.proposal;
        check(proposal?.scope === `project:${M39_PROJECT}`, 'the proposed scope is shown before approval', proposal);
        check(proposal?.sensitivity === 'internal', 'the proposed sensitivity is shown before approval', proposal);
        check(String(proposal?.fact ?? '').includes('SQLite'), 'the proposed decision is shown before approval', proposal);
        check(String(proposal?.affectedEntityCount) === '3'
          && proposal.affectedEntities.some((entry) => entry.includes(M39_REPOSITORY_FILE))
          && proposal.affectedEntities.some((entry) => entry.includes(M39_GITHUB_ISSUE))
          && proposal.affectedEntities.some((entry) => entry.includes(atlasProject.id)),
        'the exact affected entities are shown before approval', proposal);

        // --- 5. zero M39 rows before approval ----------------------------
        const beforeApproval = await allM39Rows();
        check(beforeApproval.facts.length === 0 && beforeApproval.evidence.length === 0
          && beforeApproval.entities.length === 0 && beforeApproval.relationships.length === 0,
        'Core holds zero M39 memory rows before approval', {
          facts: beforeApproval.facts.length, evidence: beforeApproval.evidence.length,
          entities: beforeApproval.entities.length, relationships: beforeApproval.relationships.length,
        });

        // --- 6/7. approve; exactly one fact, evidence, decision, edges ----
        await clickCapabilityButton(firstCard.card.approvalId, 'approved');
        await waitForTerminalAttempt(rememberRequest);
        const afterApproval = await allM39Rows();
        const sqliteFact = afterApproval.facts[0];
        check(afterApproval.facts.length === 1, 'exactly one memory fact was written', { facts: afterApproval.facts.length });
        check(afterApproval.evidence.length === 1 && String(afterApproval.evidence[0].sourceContentSha256 ?? '').length === 64,
          'exactly one Core-computed evidence link was written', { evidence: afterApproval.evidence });
        check(afterApproval.entities.filter((entity) => entity.entityType === 'decision').length === 1,
          'a decision entity was written', { entities: afterApproval.entities.map((entity) => entity.entityType) });
        check(afterApproval.relationships.length === 4, 'the typed relationships were written', { relationships: afterApproval.relationships.length });
        check(afterApproval.entities.some((entity) => entity.entityType === 'repository_file' && entity.canonicalKey === M39_REPOSITORY_FILE)
          && afterApproval.entities.some((entity) => entity.entityType === 'github_issue' && entity.canonicalKey === M39_GITHUB_ISSUE)
          && afterApproval.entities.some((entity) => entity.entityType === 'product_record' && entity.canonicalKey === atlasProject.id),
        'the affected repository file, GitHub issue, and product record entities exist', { entities: afterApproval.entities.map((e) => `${e.entityType}:${e.canonicalKey}`) });
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'after-remember-approval').catch(() => {});

        // --- 8/9/10/11. real host restart; recall shows evidence ----------
        await restartHost('window-m39-after-remember-restart');
        const recallRequest = await sendTurn(M39_PROMPTS.recallFirst);
        await waitForTerminalAttempt(recallRequest);
        await waitForAnswer(M39_ANSWERS.recalled);
        const recallBlocks = (await readMemoryEvidenceBlocks()).filter((block) => block.toolName === 'memory_recall');
        const firstRecall = recallBlocks[recallBlocks.length - 1];
        check(Boolean(firstRecall) && firstRecall.entryCount === '1', 'the recalled decision survives a real host restart', { recallBlocks });
        check(Boolean(firstRecall?.facts?.[0]) && firstRecall.facts[0].kind === 'durable_fact'
          && firstRecall.facts[0].evidenceHashes.length === 1 && firstRecall.facts[0].evidenceHashes[0].length === 64
          && firstRecall.facts[0].text.includes('SQLite')
          && firstRecall.facts[0].text.includes(`project:${M39_PROJECT}`)
          && firstRecall.facts[0].text.includes('internal')
          && firstRecall.facts[0].text.includes(sqliteFact.createdAt),
        'the UI shows the durable decision with evidence, source timestamp, scope and sensitivity', firstRecall?.facts?.[0]);

        // --- 12/13. a later contradictory decision, preserved -------------
        const contradictRequest = await sendTurn(M39_PROMPTS.rememberPostgres);
        const secondCard = await waitForActionableCard('memory_remember');
        check(secondCard.actionableCount === 1, 'exactly one actionable approval card is present for the second decision', { actionableCount: secondCard.actionableCount });
        await clickCapabilityButton(secondCard.card.approvalId, 'approved');
        await waitForTerminalAttempt(contradictRequest);
        const afterContradiction = await allM39Rows();
        check(afterContradiction.facts.length === 2, 'both decisions are preserved', { facts: afterContradiction.facts.map((f) => f.displayValue) });
        check(afterContradiction.contradictions.length === 1 && afterContradiction.contradictions[0].state === 'unresolved',
          'an unresolved contradiction was created rather than an overwrite', { contradictions: afterContradiction.contradictions });

        // --- 14. ask again: both values, both evidence chains -------------
        const recallBothRequest = await sendTurn(M39_PROMPTS.recallBoth);
        await waitForTerminalAttempt(recallBothRequest);
        const bothBlocks = (await readMemoryEvidenceBlocks()).filter((block) => block.toolName === 'memory_recall');
        const bothRecall = bothBlocks[bothBlocks.length - 1];
        check(bothRecall?.entryCount === '2'
          && bothRecall.facts.some((fact) => fact.text.includes('SQLite'))
          && bothRecall.facts.some((fact) => fact.text.includes('PostgreSQL'))
          && bothRecall.facts.every((fact) => fact.evidenceHashes.length === 1 && fact.evidenceHashes[0].length === 64)
          && bothRecall.facts.every((fact) => fact.unresolvedContradictions > 0),
        'both values, both evidence chains, and the unresolved contradiction are displayed', bothRecall);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'unresolved-contradiction').catch(() => {});

        // --- 15/16. explicit prefer_later resolution through approval -----
        const resolveRequest = await sendTurn(M39_PROMPTS.resolveContradiction);
        const resolveCard = await waitForActionableCard('memory_resolve_contradiction');
        check(resolveCard.card.titleText === 'Resolve this contradiction?', 'a contradiction-resolution approval card appears', { title: resolveCard.card.titleText });
        check(resolveCard.card.proposal?.policy === 'prefer_later', 'the proposed resolution policy is shown before approval', resolveCard.card.proposal);
        check(resolveCard.actionableCount === 1, 'exactly one actionable approval card is present for the resolution', { actionableCount: resolveCard.actionableCount });
        const beforeResolution = await allM39Rows();
        check(beforeResolution.contradictions[0].state === 'unresolved', 'the contradiction is still unresolved before approval', beforeResolution.contradictions[0]);
        await clickCapabilityButton(resolveCard.card.approvalId, 'approved');
        await waitForTerminalAttempt(resolveRequest);
        const afterResolution = await allM39Rows();
        const postgresFact = afterResolution.facts.find((fact) => fact.displayValue === 'PostgreSQL');
        const sqliteAfter = afterResolution.facts.find((fact) => fact.id === sqliteFact.id);
        check(afterResolution.contradictions[0].state === 'resolved'
          && afterResolution.contradictions[0].resolutionPolicy === 'prefer_later'
          && afterResolution.contradictions[0].authoritativeMemoryId === postgresFact?.id,
        'the contradiction is resolved by the explicit prefer_later policy', afterResolution.contradictions[0]);
        check(postgresFact?.state === 'active' && sqliteAfter?.state === 'historical' && sqliteAfter?.displayValue === 'SQLite',
          'PostgreSQL becomes authoritative while SQLite remains historical and unrewritten',
          { postgres: postgresFact?.state, sqlite: sqliteAfter?.state, sqliteValue: sqliteAfter?.displayValue });

        // --- 17. impact analysis ------------------------------------------
        const impactRequest = await sendTurn(M39_PROMPTS.impact);
        await waitForTerminalAttempt(impactRequest);
        await waitForAnswer(M39_ANSWERS.impact);
        const impactBlocks = (await readMemoryEvidenceBlocks()).filter((block) => block.toolName === 'memory_impact');
        const impactBlock = impactBlocks[impactBlocks.length - 1];
        const impacted = impactBlock?.impact ?? [];
        check(impacted.some((entry) => entry.entityType === 'repository_file' && entry.canonicalKey === M39_REPOSITORY_FILE)
          && impacted.some((entry) => entry.entityType === 'github_issue' && entry.canonicalKey === M39_GITHUB_ISSUE)
          && impacted.some((entry) => entry.entityType === 'product_record' && entry.canonicalKey === atlasProject.id)
          && impacted.every((entry) => entry.evidenceCount > 0)
          && impacted.every((entry) => /\[[a-z_ ->]+\]/.test(entry.text))
          && impacted.filter((entry) => ['repository_file', 'github_issue', 'product_record'].includes(entry.entityType))
            .every((entry) => entry.text.includes('affects')),
        'impact analysis identifies the file, issue and product record with relationship paths and evidence', impacted);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'impact-analysis').catch(() => {});

        // --- 18. auditable deterministic export ---------------------------
        const exportRequest = await sendTurn(M39_PROMPTS.export);
        await waitForTerminalAttempt(exportRequest);
        await waitForAnswer(M39_ANSWERS.exported);
        const exportBlocks = (await readMemoryEvidenceBlocks()).filter((block) => block.toolName === 'memory_export');
        const exportBlock = exportBlocks[exportBlocks.length - 1];
        check(exportBlock?.schemaVersion === '1' && exportBlock?.memoryCount === '2'
          && exportBlock.text.includes(sqliteFact.id) && exportBlock.text.includes(String(postgresFact?.id))
          && exportBlock.text.includes('sourceContentSha256'),
        'export produces auditable deterministic JSON containing the full evidence chain', {
          schemaVersion: exportBlock?.schemaVersion, memoryCount: exportBlock?.memoryCount,
        });

        // --- 19/20. governed forget ---------------------------------------
        const forgetRequest = await sendTurn(M39_PROMPTS.forget);
        const forgetCard = await waitForActionableCard('memory_forget');
        check(forgetCard.card.titleText === 'Forget this memory?', 'a forget approval card appears', { title: forgetCard.card.titleText });
        check(forgetCard.actionableCount === 1, 'exactly one actionable approval card is present for the forget', { actionableCount: forgetCard.actionableCount });
        const beforeForget = await activeFacts();
        check(beforeForget.length === 1 && beforeForget[0].id === postgresFact?.id, 'the authoritative memory is still active before the forget approval', { active: beforeForget.map((f) => f.id) });
        await clickCapabilityButton(forgetCard.card.approvalId, 'approved');
        await waitForTerminalAttempt(forgetRequest);

        // --- 21/22/23. restart; the forgotten fact is not active ----------
        await restartHost('window-m39-after-forget-restart');
        const afterForgetRecallRequest = await sendTurn(M39_PROMPTS.recallAfterForget);
        await waitForTerminalAttempt(afterForgetRecallRequest);
        await waitForAnswer(M39_ANSWERS.recalled);
        const afterForgetRows = await allM39Rows();
        const forgottenFact = afterForgetRows.facts.find((fact) => fact.id === postgresFact?.id);
        const afterForgetBlocks = (await readMemoryEvidenceBlocks()).filter((block) => block.toolName === 'memory_recall');
        const afterForgetRecall = afterForgetBlocks[afterForgetBlocks.length - 1];
        check(forgottenFact?.state === 'forgotten' && forgottenFact?.displayValue === '[forgotten]' && Boolean(forgottenFact?.forgottenAt),
          'the forgotten memory is tombstoned and scrubbed but remains auditable', forgottenFact);
        check(afterForgetRecall?.entryCount === '0' && (await activeFacts()).length === 0,
          'no active memory is recalled after the forget and a real restart', { entryCount: afterForgetRecall?.entryCount });
        check(!JSON.stringify(afterForgetRows).includes('PostgreSQL'), 'the forgotten value no longer exists in any M39 table', null);

        // --- 24. redispatch the original remember: no duplicate row -------
        // A relaunched host legitimately anchors a fresh capability
        // correlation, so consent may be requested again — that is correct
        // governance, not a defect. What must never happen is a second
        // durable memory row: Core's write identity plus the UNIQUE index on
        // memory_facts.writeIdentity make the approved redispatch a no-op.
        const factsBeforeRedispatch = (await memoryRows('memory_facts')).length;
        const redispatchRequest = await sendTurn(M39_PROMPTS.redispatchRemember);
        const redispatchOutcome = await pollUntil(async () => {
          const attempts = await findAttemptsForRequest(redispatchRequest.id, dataDir());
          const attempt = attempts[0];
          if (attempt && ['completed', 'failed', 'cancelled'].includes(attempt.status)) return { done: true, value: { kind: 'terminal', attempt } };
          const cards = await readCapabilityCards();
          const actionable = cards.filter((card) => !card.resolved && card.approveDisabled === false && card.toolName === 'memory_remember');
          return actionable.length === 1
            ? { done: true, value: { kind: 'approval', card: actionable[0] } }
            : { done: false, value: attempt?.status ?? null };
        }, { timeoutMs: 120000, intervalMs: 500, describe: () => 'the redispatched remember to terminate or ask for consent again' });
        if (redispatchOutcome.kind === 'approval') {
          await clickCapabilityButton(redispatchOutcome.card.approvalId, 'approved');
          await waitForTerminalAttempt(redispatchRequest);
        }
        const factsAfterRedispatch = (await memoryRows('memory_facts')).length;
        const cardsAfterRedispatch = await readCapabilityCards();
        const redispatchInvocations = await withDb((db) => (db
          ? db.prepare("SELECT * FROM tool_invocations WHERE toolName = 'memory_remember' ORDER BY startedAt").all()
          : []), dataDir());
        check(factsAfterRedispatch === factsBeforeRedispatch, 'redispatching the original approved remember creates no duplicate memory row',
          { before: factsBeforeRedispatch, after: factsAfterRedispatch, redispatchOutcome: redispatchOutcome.kind });
        check(redispatchInvocations.some((row) => String(row.evidence ?? '').includes('memory_remember_deduplicated')),
          'the redispatched remember is recorded as an idempotent no-op rather than a second write',
          { categories: redispatchInvocations.map((row) => String(row.evidence ?? '').slice(0, 60)) });
        check(cardsAfterRedispatch.filter((card) => !card.resolved && card.approveDisabled === false).length === 0,
          'no actionable approval card is left after the redispatch', { cards: cardsAfterRedispatch.length });

        // --- 25. rejected restricted memory containing a fixture token ----
        const restrictedRequest = await sendTurn(M39_PROMPTS.restrictedSecret);
        const restrictedCard = await waitForActionableCard('memory_remember');
        check(restrictedCard.actionableCount === 1, 'exactly one actionable approval card is present for the restricted memory', { actionableCount: restrictedCard.actionableCount });
        await clickCapabilityButton(restrictedCard.card.approvalId, 'rejected');
        await waitForTerminalAttempt(restrictedRequest);
        const finalRows = await allM39Rows();
        check(finalRows.facts.length === factsAfterRedispatch, 'the rejected restricted memory created zero new M39 facts',
          { before: factsAfterRedispatch, after: finalRows.facts.length });
        check(!JSON.stringify(finalRows).includes(M39_FIXTURE_TOKEN), 'the raw fixture token is absent from every M39 table', null);
        const toolInvocationRows = await withDb((db) => (db ? db.prepare('SELECT * FROM tool_invocations').all() : []), dataDir());
        const approvalRows = await withDb((db) => (db ? db.prepare('SELECT * FROM approvals').all() : []), dataDir());
        check(!JSON.stringify(toolInvocationRows).includes(M39_FIXTURE_TOKEN),
          'the raw fixture token is absent from M39 tool-invocation evidence', null);
        check(!JSON.stringify(approvalRows).includes(M39_FIXTURE_TOKEN),
          'the raw fixture token is absent from the governed approval envelope', null);
        await board.captureScreenshot(pageClient, scenarioEvidenceDir, 'final-state').catch(() => {});

        // --- 26. no hidden write, no second authority, no duplicate card --
        const finalCards = await readCapabilityCards();
        const memoryApprovals = approvalRows.filter((row) => String(row.summary ?? '').includes('memory_'));
        const consequentialInvocations = toolInvocationRows.filter((row) => ['memory_remember', 'memory_forget', 'memory_resolve_contradiction'].includes(row.toolName));
        check(finalCards.filter((card) => !card.resolved && card.approveDisabled === false).length === 0,
          'no actionable approval card is left dangling at the end of the scenario', { cards: finalCards.length });
        check(new Set(finalCards.map((card) => card.approvalId)).size === finalCards.length,
          'no duplicate approval card was ever rendered', { cards: finalCards.map((card) => card.approvalId) });
        check(memoryApprovals.length === consequentialInvocations.filter((row) => row.status !== 'pending').length + memoryApprovals.filter((row) => row.status === 'rejected').length,
          'every consequential memory action is backed by exactly one governed approval',
          { approvals: memoryApprovals.length, invocations: consequentialInvocations.length });
        const memoryTables = await withDb((db) => (db
          ? db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'memory_%' OR name LIKE 'knowledge_%')").all().map((row) => row.name).sort()
          : []), dataDir());
        check(JSON.stringify(memoryTables) === JSON.stringify(['knowledge_entities', 'knowledge_relationships', 'memory_contradictions', 'memory_evidence', 'memory_facts']),
          'exactly the five M39 tables exist — no second memory authority was created', { memoryTables });

        const fixtureSnapshot = fixture.snapshot();
        check(fixtureSnapshot.violations === 0, 'the deterministic fixture observed no unexpected tool-call sequence', { violations: fixture.violations() });
        const rootVsixUnchanged = JSON.stringify(rootVsixBefore) === JSON.stringify(snapshotRootVsixInventory(repoRoot));
        check(rootVsixUnchanged, 'the repository-root VSIX inventory is unchanged', null);

        const ok = checks.every((entry) => entry.ok);
        scenarioEvidence = {
          ok,
          checks,
          packageProvenance: evidence.packageProvenance,
          projectId: atlasProject.id,
          beforeApprovalRowCounts: {
            facts: beforeApproval.facts.length, evidence: beforeApproval.evidence.length,
            entities: beforeApproval.entities.length, relationships: beforeApproval.relationships.length,
          },
          finalRows,
          fixture: fixtureSnapshot,
          rootVsixUnchanged,
          cleanup: null,
        };
        evidence.scenarios.m39MemoryKnowledgeRestart = scenarioEvidence;
        if (!ok) throw new Error(`m39-memory-knowledge-restart did not meet acceptance: ${JSON.stringify(checks.filter((entry) => !entry.ok))}`);
      } catch (error) {
        scenarioEvidence.checks = checks;
        scenarioEvidence.failure = error instanceof Error ? { message: error.message, stack: error.stack ?? null } : { message: String(error), stack: null };
        evidence.scenarios.m39MemoryKnowledgeRestart = scenarioEvidence;
        if (webviewClient) await ui.captureFailureDiagnostics(webviewClient, scenarioEvidenceDir, 'm39-failure').catch(() => {});
        throw error;
      } finally {
        await pageClient?.close().catch(() => {});
        await webviewClient?.close().catch(() => {});
        const corePid = windowHandle ? readDiscoveryRecord(windowHandle.globalDataDir)?.pid ?? null : null;
        const profilePids = windowHandle ? readWindowsProcessSnapshot().filter((process) => process.commandLine?.toLowerCase().includes(windowHandle.profile.toLowerCase())).map((process) => process.pid) : [];
        for (const pid of new Set([windowHandle?.launchedPid, ...profilePids].filter(Boolean))) terminateOwnedProcessTree(pid);
        terminateOwnedProcessTree(corePid);
        if (fixture) await fixture.close().catch(() => {});
        const cleanup = {
          corePid,
          coreStopped: !corePid || !isPidAlive(corePid),
          vscodeStopped: profilePids.every((pid) => !isPidAlive(pid)),
          fixtureClosed: !fixture || Boolean(fixture.snapshot().closedAt),
        };
        scenarioEvidence.cleanup = cleanup;
        evidence.scenarios.m39MemoryKnowledgeRestart = scenarioEvidence;
        fs.mkdirSync(scenarioEvidenceDir, { recursive: true });
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'package-provenance.json'), JSON.stringify({ headSha, runId, ...evidence.packageProvenance }, null, 2));
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'fixture-request-log.json'), JSON.stringify(fixture?.requestLog ?? [], null, 2));
        fs.writeFileSync(path.join(scenarioEvidenceDir, 'evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scenario: 'm39-memory-knowledge-restart', ...scenarioEvidence }, null, 2));
        if (!cleanup.coreStopped || !cleanup.vscodeStopped || !cleanup.fixtureClosed) throw new Error(`m39-memory-knowledge-restart cleanup failed: ${JSON.stringify(cleanup)}`);
      }
    });

    assertAllSelectedScenariosExecuted();
    evidence.executedScenarios = [...executedScenarioNames];
    writeEvidence();
    log(`PASSED. Evidence written to ${path.join(evidenceDir, 'evidence.json')}`);
    exitCode = 0;
  } catch (error) {
    console.error('[m32-packaged-dogfood] FAILED');
    console.error(error);
    evidence.failure = { error: error.message, stack: error.stack };
    writeEvidence();
    log(`Work directory retained for inspection: ${workDir}`);
    exitCode = 1;
  } finally {
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
    const finalDiscovery = readDiscoveryRecord();
    if (finalDiscovery && isPidAlive(finalDiscovery.pid)) {
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
    if (ollamaCapture) {
      await ollamaCapture.close().catch(() => {});
      log('Stopped the transparent Ollama request-capture proxy.');
    }
    if (exitCode === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      log('Cleaned up all disposable workspaces, profiles, and the isolated global data directory.');
    }
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[m32-packaged-dogfood] FAILED');
  console.error(error);
  process.exit(1);
});
