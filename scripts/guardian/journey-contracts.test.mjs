import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { discoverJourneyFiles, loadJourney } from '../../src/ui-test/support/contract.mjs';
import { validateJourney } from '../../src/ui-test/support/contract.mjs';

const valid = {
  schemaVersion: 2,
  id: 'valid',
  title: 'Valid visible journey',
  priority: 'P0',
  suites: ['p0'],
  driver: 'test',
  profilePolicy: 'fresh',
  requiresApprovals: true,
  prompt: 'create a.txt containing A',
  lifecycle: ['submit', 'approve', 'complete'],
  steps: [
    'type into the visible unified composer',
    'click the visible Send control',
    'approve through visible controls',
  ],
  assertions: ['file exists'],
  evidence: ['screenshot'],
  result: { file: 'a.txt', content: 'A', terminalState: 'completed' },
  checks: {
    visibleUi: true,
    route: true,
    durableState: true,
    filesystem: true,
    git: true,
  },
};

test('accepts a journey that uses visible composer and approval controls', () => {
  assert.doesNotThrow(() => validateJourney(valid));
});

test('rejects a journey that bypasses visible approval controls', () => {
  assert.throws(
    () => validateJourney({ ...valid, steps: valid.steps.slice(0, 2) }),
    /visible approval controls/,
  );
});

test('rejects a journey that bypasses the visible composer', () => {
  assert.throws(
    () => validateJourney({ ...valid, steps: ['invoke a helper', 'click visible Send', 'approve through visible controls'] }),
    /visible unified composer/,
  );
});

test('rejects lifecycle contracts without filesystem and Git postconditions', () => {
  assert.throws(
    () => validateJourney({ ...valid, checks: { ...valid.checks, filesystem: false } }),
    /checks\.filesystem must be true/,
  );
});

test('rejects close and reopen coverage that silently uses a fresh profile', () => {
  assert.throws(
    () => validateJourney({
      ...valid,
      lifecycle: ['close VS Code', 'reopen same workspace'],
      checks: { ...valid.checks, restartResult: true },
    }),
    /reuse the same profile/,
  );
});

test('negative control is an explicit expected-failure product contract', () => {
  const source = fs.readFileSync(path.resolve(
    'tests/user-journeys/07-session-workspace-isolation/cross-workspace-leakage-negative.yaml',
  ), 'utf8');
  assert.match(source, /negativeControl: expected-failure/);
  assert.match(source, /CROSS_WORKSPACE_LEAKAGE_DETECTED/);
});

test('guardian runtime and evidence directories can never enter the VSIX', () => {
  const ignore = fs.readFileSync(path.resolve('.vscodeignore'), 'utf8');
  for (const entry of ['.guardian-cache/', '.guardian-evidence/', '.guardian-build/', 'tests/']) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('catalogue and generated tests preserve the lifecycle hierarchy', () => {
  const required = [
    '00-installation-first-launch',
    '01-baat-kar-lifecycle',
    '02-saath-kar-lifecycle',
    '03-karke-dikha-lifecycle',
    '04-approval-steering',
    '05-stop-interruption',
    '06-close-reopen-recovery',
    '07-session-workspace-isolation',
    '08-multiple-windows',
    '09-upgrade-migration',
    '10-uninstall-reinstall',
    '11-provider-model-failures',
    '12-git-worktree-failures',
    '13-security-input-boundaries',
  ];
  for (const directory of required) {
    assert.equal(fs.existsSync(path.resolve('tests/user-journeys', directory)), true, `${directory} contract directory is required`);
    assert.equal(fs.existsSync(path.resolve('src/ui-test/generated', directory)), true, `${directory} generated directory is required`);
  }
  const nested = fs.readFileSync(path.resolve(
    'src/ui-test/generated/00-installation-first-launch/p0-lifecycle-smoke.test.mjs',
  ), 'utf8');
  assert.match(nested, /from "\.\.\/\.\.\/journeys\/runJourney\.mjs"/);
});

test('package commands and Windows CI expose every lifecycle gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  for (const name of ['p0', 'p1', 'lifecycle', 'workspace', 'windows', 'installation', 'recovery', 'full', 'negative', 'report']) {
    assert.ok(pkg.scripts[`test:guardian:${name}`], `test:guardian:${name} is required`);
  }
  const workflow = fs.readFileSync(path.resolve('.github/workflows/installed-product-guardian.yml'), 'utf8');
  for (const job of [
    'Guardian P0 smoke',
    'Guardian P1 lifecycle',
    'Guardian workspace isolation',
    'Guardian installation lifecycle',
    'Guardian full/nightly',
    'Guardian negative controls',
  ]) {
    assert.match(workflow, new RegExp(job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('P1 is exactly the reviewed sixteen-journey lifecycle driver pack', () => {
  const p1 = discoverJourneyFiles()
    .map(file => loadJourney(path.basename(file, '.yaml')))
    .filter(journey => journey.suites.includes('p1'))
    .sort((left, right) => left.p1Index - right.p1Index);
  assert.equal(p1.length, 16);
  assert.deepEqual(p1.map(journey => journey.p1Index), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.ok(p1.every(journey => journey.driver === 'p1-lifecycle'));
  assert.ok(p1.every(journey => fs.existsSync(path.resolve(
    'src/ui-test/generated',
    journey.generatedRelativePath,
  ))));
});

test('runner records persistent phases and confirms test-owned VS Code exits', () => {
  const source = fs.readFileSync(path.resolve('scripts/guardian/run-guardian.mjs'), 'utf8');
  assert.match(source, /lifecyclePhases/);
  assert.match(source, /runPhaseProcess/);
  assert.match(source, /run-guardian-phase\.mjs/);
  assert.match(source, /testOwnedCodeProcesses/);
  assert.match(source, /confirmTestOwnedCodeExited/);
  assert.match(source, /allTestOwnedCodeProcessesTerminated/);
  assert.match(source, /GUARDIAN_INFRASTRUCTURE_FAILURE/);
});

test('backend resolvedMode assertions never use the webview engine-mode vocabulary', () => {
  // Core's durable ResolvedMode is 'baat_kar' | 'saath_kar' | 'karke_dikha'
  // (core/shared/wireTypes.ts). The webview's #mode-select DOM vocabulary is
  // 'chat' | 'agent' | 'autonomous' | 'ask' | 'plan' | 'auto' and is a
  // separate concept (asserted via selectedMode). Regression coverage: the
  // two vocabularies were confused once already (turn.request.resolvedMode
  // was compared against 'chat').
  const source = fs.readFileSync(path.resolve('src/ui-test/journeys/lifecycleDriver.mjs'), 'utf8');
  const resolvedModeAssertions = source.match(/resolvedMode,\s*'[^']+'/g) ?? [];
  assert.ok(resolvedModeAssertions.length > 0, 'expected at least one resolvedMode assertion to guard');
  for (const assertion of resolvedModeAssertions) {
    assert.doesNotMatch(
      assertion,
      /resolvedMode,\s*'(chat|agent|autonomous|ask|plan|auto)'/,
      `${assertion} compares Core's backend resolvedMode against the webview engine-mode vocabulary`,
    );
  }
});

test('cross-boundary lifecycle state keeps local and Core conversation identity explicit and separate', () => {
  // selectConversation() (KarkeDikhaView.mjs) drives .conversation-item
  // [data-conv-id], which only ever carries the webview's local conversation
  // id (AgentPanel.ts DEFAULT_CONVERSATION_ID / generated taskIds) — never
  // Core's durable conversationId. A prior version of this file persisted
  // Core's durable id into cross-boundary (primary -> restore) lifecycle
  // state under the ambiguous key `conversationId` and fed it straight into
  // selectConversation(), which cannot find it in the DOM. Regression
  // coverage: local/Core identity must stay separately named end to end, and
  // their correspondence must be proven via the durable ledger rather than
  // assumed by using one value for both.
  const source = fs.readFileSync(path.resolve('src/ui-test/journeys/lifecycleDriver.mjs'), 'utf8');

  assert.match(source, /conversationLedgerEntry/, 'must prove local/Core correspondence via the durable workspace_conversations ledger');
  assert.match(source, /function assertConversationIdentity/, 'must centralize the local/Core identity proof');

  const writeStateBlocks = source.match(/writeState\(ctx\.evidenceDir,\s*\{[^}]*\}/gs) ?? [];
  const conversationBearingBlocks = writeStateBlocks.filter(block => /conversationId/.test(block));
  assert.ok(conversationBearingBlocks.length > 0, 'expected at least one writeState call carrying conversation identity to guard');
  for (const block of conversationBearingBlocks) {
    assert.doesNotMatch(
      block,
      /(?<!local|core)conversationId:/,
      `${block} writes an ambiguous bare conversationId into cross-boundary lifecycle state`,
    );
  }

  const selectConversationCalls = source.match(/selectConversation\(state\.\w+\)/g) ?? [];
  assert.ok(selectConversationCalls.length > 0, 'expected at least one restore-phase selectConversation(state....) call to guard');
  for (const call of selectConversationCalls) {
    assert.match(call, /selectConversation\(state\.localConversationId\)/, `${call} must select by the webview-local id, which is what the DOM exposes`);
  }
});

test('Saath Kar approval/tool-invocation assertions resolve the M38 capability dispatch anchor attempt, not the visible chat attempt', () => {
  // ensureCapabilityAttempt() (core/domain/capabilityDispatch.ts) attaches
  // every Saath Kar approval/tool_invocation to a synthetic per-conversation
  // anchor attempt, not to the user-visible chat attempt latestCoreTurn()
  // returns. A prior version of this file queried
  // `latestCoreTurn(...).approvals` for Saath Kar identity, which reads zero
  // rows under the visible attemptId forever — not a race, the wrong key.
  // Regression coverage: every Saath Kar approval/tool-invocation assertion
  // must resolve through capabilityAnchorAttempt() instead.
  const runtimeEvidenceSource = fs.readFileSync(path.resolve('src/ui-test/support/runtimeEvidence.mjs'), 'utf8');
  assert.match(runtimeEvidenceSource, /export function capabilityAnchorAttempt/, 'must export the anchor-attempt lookup');
  assert.match(runtimeEvidenceSource, /M38 governed capability dispatch anchor for/, 'must resolve the anchor by its known request signature');

  const driverSource = fs.readFileSync(path.resolve('src/ui-test/journeys/lifecycleDriver.mjs'), 'utf8');
  assert.match(driverSource, /capabilityAnchorAttempt/, 'lifecycleDriver.mjs must import and use the anchor-attempt lookup');

  const saathRejectedBody = driverSource.slice(driverSource.indexOf('async function runSaathRejected'), driverSource.indexOf('async function runSaathApproved'));
  const saathApprovedBody = driverSource.slice(driverSource.indexOf('async function runSaathApproved'), driverSource.indexOf('async function runDeterministicComplete'));
  for (const [name, body] of [['runSaathRejected', saathRejectedBody], ['runSaathApproved', saathApprovedBody]]) {
    assert.doesNotMatch(
      body,
      /\b(?:pending|rejected|fresh|approved|durable)\.approvals\b/,
      `${name} must not read .approvals directly off a visible-attempt latestCoreTurn() result`,
    );
    assert.doesNotMatch(
      body,
      /\b(?:pending|rejected|fresh|approved|durable)\.toolInvocations\b/,
      `${name} must not read .toolInvocations directly off a visible-attempt latestCoreTurn() result`,
    );
  }
});

test('Guardian caches and evidence are ignored and untracked', () => {
  const trackedCache = execFileSync('git', ['ls-files', '.guardian-cache'], { encoding: 'utf8' }).trim();
  const trackedEvidence = execFileSync('git', ['ls-files', '.guardian-evidence'], { encoding: 'utf8' }).trim();
  assert.equal(trackedCache, '');
  assert.equal(trackedEvidence, '');
  const ignore = fs.readFileSync(path.resolve('.gitignore'), 'utf8');
  for (const entry of ['.guardian-cache/', '.guardian-evidence/', '.guardian-build/']) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});
