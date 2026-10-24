// Repetition isolation: every model-bench repetition must start from the pristine fixture, whatever an earlier
// repetition did. Drives the same code the runner uses (pendingTuples -> one Golden run root per repetition ->
// prepareAttempt) and deliberately corrupts everything repetition 1 owns, on disk and in memory.
// Run: node --test scripts/model-bench/repetitionIsolation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspace, expenseFiles, fixtureFiles, goldenRunRoot, prepareAttempt } from '../../src/ui-test/golden/fixtures.mjs';
import { buildCohortSummary, buildResultRecord, parseSampling, pendingTuples, runsToCsv, samplingEnv, samplingMode, samplingResumeConflict, uniqueStamp } from './lib.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const settingsFor = model => ({ 'ollama-agent.providerType': 'ollama', 'ollama-agent.model': model, 'ollama-agent.agentModel': model });
const listAll = dir => fs.readdirSync(dir, { recursive: true });

/** Everything repetition 1 could leave behind: workspace edits, a commit, untracked files, Core state, profile state. */
function corrupt(env) {
  fs.writeFileSync(path.join(env.workspace, 'expenses.js'), "module.exports = { createStore: () => 'mutated by rep 1' };\n");
  fs.writeFileSync(path.join(env.workspace, 'untracked-by-rep-1.txt'), 'residue\n');
  fs.mkdirSync(path.join(env.workspace, '.ollama-agent', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(env.workspace, '.ollama-agent', 'tasks', 'task.json'), '{"state":"waiting_for_approval"}\n');
  fs.writeFileSync(path.join(env.workspace, 'cli.js'), '// committed by rep 1\n');
  git(env.workspace, ['commit', '-qam', 'rep 1 commit']);
  const db = new DatabaseSync(path.join(env.coreData, 'core.db'));
  db.exec(`CREATE TABLE approvals (id TEXT, status TEXT); INSERT INTO approvals VALUES ('appr_1', 'pending');
    CREATE TABLE runtime_events (sequence INTEGER, eventType TEXT); INSERT INTO runtime_events VALUES (1, 'validation_failed');
    CREATE TABLE attempt_loop_continuations (attemptId TEXT, corrections INTEGER); INSERT INTO attempt_loop_continuations VALUES ('att_1', 2);`);
  db.close();
  fs.writeFileSync(path.join(env.coreData, 'golden-model-evidence.jsonl'), '{"turn":0,"rawReply":"rep 1"}\n');
  fs.writeFileSync(path.join(env.evidence, 'd1-small-bug-result.json'), '{"status":"failed"}\n');
  fs.mkdirSync(path.join(env.extensions, 'karkedikha-0.0.0'), { recursive: true });
  fs.mkdirSync(path.join(env.sessionStorage, 'settings', 'User', 'globalStorage'), { recursive: true });
  fs.writeFileSync(path.join(env.sessionStorage, 'settings', 'User', 'globalStorage', 'state.json'), '{"conversation":"conv_rep1"}\n');
}

test('repetition 2 and 3 start from the pristine fixture after repetition 1 mutates its workspace, Core data and profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rep-isolation-'));
  try {
    const model = 'qwen2.5-coder:3b';
    const scenario = 'd1-small-bug';
    const settings = settingsFor(model);
    const reference = createWorkspace(path.join(root, 'reference'), expenseFiles(), settings);
    const pristineTree = git(reference, ['rev-parse', 'HEAD^{tree}']);
    const pristineFiles = Object.fromEntries(Object.entries(expenseFiles()).map(([file, text]) => [file, text]));

    const tuples = pendingTuples([model], [scenario], 3, []);
    assert.deepEqual(tuples.map(item => item.repetition), [1, 2, 3]);
    const seen = [];
    for (const tuple of tuples) {
      // Each repetition is a separate Golden process with its own clock-stamped run root.
      const runRoot = goldenRunRoot(root, new Date(Date.UTC(2026, 9, 5, 6, 17, tuple.repetition * 20)));
      assert.equal(fs.existsSync(runRoot), false, `rep ${tuple.repetition} run root must not pre-exist`);
      const env = prepareAttempt({ runRoot, name: scenario, attempt: 1, fixture: 'expense', settings: settingsFor(model) });

      // Before the first inference: pristine fixture, single commit, clean tree, empty Core/evidence/profile dirs.
      assert.equal(git(env.workspace, ['rev-parse', 'HEAD^{tree}']), pristineTree, `rep ${tuple.repetition} fixture tree`);
      assert.equal(git(env.workspace, ['rev-list', '--count', 'HEAD']), '1', `rep ${tuple.repetition} has only the fixture commit`);
      assert.equal(git(env.workspace, ['status', '--porcelain', '--untracked-files=all']), '', `rep ${tuple.repetition} worktree clean`);
      for (const [file, text] of Object.entries(pristineFiles)) assert.equal(fs.readFileSync(path.join(env.workspace, file), 'utf8'), text, `rep ${tuple.repetition} ${file}`);
      assert.equal(fs.existsSync(path.join(env.workspace, '.ollama-agent')), false, `rep ${tuple.repetition} has no workspace agent state`);
      for (const dir of [env.coreData, env.evidence, env.extensions, env.sessionStorage]) assert.deepEqual(listAll(dir), [], `rep ${tuple.repetition} ${dir} empty`);

      // Unique, non-nested directories per repetition.
      for (const previous of seen) {
        for (const key of ['base', 'workspace', 'coreData', 'evidence', 'extensions', 'sessionStorage']) {
          assert.notEqual(env[key], previous[key]);
          assert.equal(path.relative(previous.base, env[key]).startsWith('..'), true, `rep ${tuple.repetition} ${key} outside earlier rep`);
        }
      }
      seen.push(env);

      if (tuple.repetition === 1) {
        corrupt(env);
        // An in-memory fixture map handed out once must not be what the next repetition receives.
        const handedOut = fixtureFiles('expense');
        handedOut['expenses.js'] = 'mutated in memory by rep 1';
        delete handedOut['package.json'];
      }
    }
    // Repetition 1's corruption is still there: isolation came from fresh directories, not from cleanup.
    assert.match(fs.readFileSync(path.join(seen[0].workspace, 'expenses.js'), 'utf8'), /mutated by rep 1/);
    assert.equal(git(seen[0].workspace, ['rev-list', '--count', 'HEAD']), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixtureFiles returns a fresh map on every call', () => {
  const first = fixtureFiles('expense');
  first['expenses.js'] = 'mutated';
  assert.deepEqual(fixtureFiles('expense'), expenseFiles());
  assert.notEqual(fixtureFiles('blank'), fixtureFiles('blank'));
});

test('each Golden invocation gets a distinct run root under the evidence root, even within one millisecond', () => {
  const evidenceRoot = path.join('/ext', 'golden-evidence');
  const a = goldenRunRoot(evidenceRoot, new Date('2026-10-05T06:17:02.721Z'), 'aaaa1111');
  const b = goldenRunRoot(evidenceRoot, new Date('2026-10-05T06:17:27.612Z'));
  assert.equal(path.basename(a), '2026-10-05T06-17-02-721Z-aaaa1111');
  assert.equal(path.dirname(a), evidenceRoot);
  assert.notEqual(a, b);
  const same = new Date('2026-10-05T06:17:02.721Z');
  const roots = new Set(Array.from({ length: 200 }, () => goldenRunRoot(evidenceRoot, same)));
  assert.equal(roots.size, 200, 'random suffix must disambiguate same-millisecond starts');
  for (const root of roots) assert.match(path.basename(root), /^2026-10-05T06-17-02-721Z-[0-9a-f]{8}$/);
});

test('bench run ids are collision-proof and still sort by start time', () => {
  const early = uniqueStamp(new Date('2026-10-05T06:17:02.721Z'), 'ffffffff');
  const late = uniqueStamp(new Date('2026-10-05T06:17:02.722Z'), '00000000');
  assert.ok(early < late);
  const same = new Date('2026-10-05T06:17:02.721Z');
  assert.equal(new Set(Array.from({ length: 200 }, () => uniqueStamp(same))).size, 200);
});

test('sampling controls: absent by default, validated, and part of resume identity', () => {
  assert.deepEqual(parseSampling({}), { seed: null, temperature: null });
  assert.deepEqual(samplingEnv(parseSampling({})), {});
  assert.equal(samplingMode(parseSampling({})), 'stochastic-qualification');
  const fixed = parseSampling({ seed: '42', temperature: '0' });
  assert.deepEqual(fixed, { seed: 42, temperature: 0 });
  assert.deepEqual(samplingEnv(fixed), { KKD_BENCHMARK_SEED: '42', KKD_BENCHMARK_TEMPERATURE: '0' });
  assert.deepEqual(samplingEnv(parseSampling({ seed: '-7' })), { KKD_BENCHMARK_SEED: '-7' });
  assert.equal(samplingMode(fixed), 'deterministic-regression');
  for (const bad of [{ seed: '1.5' }, { seed: 'abc' }, { temperature: 'hot' }, { temperature: '-1' }, { temperature: '' }]) assert.throws(() => parseSampling(bad));
  // Resume: omitted flags inherit the manifest; explicit differing flags are refused.
  assert.equal(samplingResumeConflict(fixed, { seed: null, temperature: null }), null);
  assert.equal(samplingResumeConflict(fixed, { seed: 42, temperature: 0 }), null);
  assert.match(samplingResumeConflict(fixed, { seed: 43, temperature: null }), /seed 43 conflicts/);
  assert.match(samplingResumeConflict({ seed: null, temperature: null }, { seed: null, temperature: 0.2 }), /temperature 0\.2 conflicts/);
  assert.match(samplingResumeConflict(undefined, { seed: 1, temperature: null }), /conflicts/);
});

test('sampling and per-run load state are persisted in the result record, RUNS.csv and SUMMARY.md', () => {
  const sampling = parseSampling({ seed: 7, temperature: 0.2 });
  const rep1 = buildResultRecord({ model: 'm', scenario: 's', repetition: 1, outcome: { passed: true }, durationMs: 10, loadMs: 9000, coldLoad: true, sampling });
  const rep2 = buildResultRecord({ model: 'm', scenario: 's', repetition: 2, outcome: { passed: true }, durationMs: 10, loadMs: 40, coldLoad: false, sampling });
  assert.deepEqual([rep1.seed, rep1.temperature, rep1.samplingMode], [7, 0.2, 'deterministic-regression']);
  const stochastic = buildResultRecord({ model: 'm', scenario: 's', outcome: { passed: true }, durationMs: 1 });
  assert.deepEqual([stochastic.seed, stochastic.temperature, stochastic.samplingMode], [null, null, 'stochastic-qualification']);
  const [header, ...rows] = runsToCsv([rep1, rep2]).trim().split('\n').map(line => line.split(','));
  const col = name => header.indexOf(name);
  assert.deepEqual(rows.map(row => [row[col('loadMs')], row[col('coldLoad')], row[col('seed')], row[col('temperature')]]), [['9000', 'true', '7', '0.2'], ['40', 'false', '7', '0.2']]);
  assert.match(buildCohortSummary({ manifest: { cohort: 'c', sampling }, results: [rep1, rep2] }), /Sampling: deterministic-regression - seed 7, temperature 0\.2/);
  assert.match(buildCohortSummary({ manifest: { cohort: 'c', sampling: { seed: null, temperature: null } }, results: [] }), /Sampling: stochastic-qualification - stochastic \(no seed/);
});
