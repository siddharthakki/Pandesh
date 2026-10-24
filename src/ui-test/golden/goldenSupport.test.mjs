// Focused tests for the golden oracle's delivered-checkout isolation.
// Run: node --test src/ui-test/golden/goldenSupport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { agentWrittenPaths, deliveredCheckout, freshUserEnv } from './goldenSupport.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-oracle-test-'));
  const workspace = path.join(root, 'workspace');
  const coreData = path.join(root, 'core-data');
  fs.mkdirSync(workspace);
  fs.mkdirSync(coreData);
  fs.writeFileSync(path.join(workspace, 'expenses.js'), 'module.exports = "in-memory";\n');
  fs.writeFileSync(path.join(workspace, 'old.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# app\n');
  git(workspace, ['init', '--quiet', '-b', 'golden-main']);
  git(workspace, ['add', '-A']);
  git(workspace, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init']);
  const db = new DatabaseSync(path.join(coreData, 'core.db'));
  db.exec('CREATE TABLE tool_invocations (id TEXT, toolName TEXT, argsSummary TEXT, status TEXT, evidence TEXT)');
  const insert = db.prepare('INSERT INTO tool_invocations VALUES (?, ?, ?, ?, ?)');
  const write = (id, args, evidence, status = 'succeeded') => insert.run(id, 'propose_file_change', JSON.stringify(args), status, JSON.stringify(evidence));
  return { root, workspace, coreData, db, write };
}

test('delivered checkout carries agent writes and excludes validation residue', () => {
  const f = fixture();
  // Agent: modifies a tracked file, creates a new one, deletes one (path-corrected write too).
  fs.writeFileSync(path.join(f.workspace, 'expenses.js'), 'module.exports = "persisted";\n');
  fs.mkdirSync(path.join(f.workspace, 'lib'));
  fs.writeFileSync(path.join(f.workspace, 'lib', 'store.js'), 'module.exports = "store";\n');
  fs.rmSync(path.join(f.workspace, 'old.js'));
  f.write('1', { path: 'expenses.js' }, { resultCategory: 'write_succeeded', normalizedArguments: { path: 'expenses.js' } });
  f.write('2', { path: 'store.js' }, { resultCategory: 'path_corrected', pathRecovery: { selected: 'lib/store.js' } });
  f.write('3', { path: 'old.js' }, { resultCategory: 'write_succeeded' });
  f.write('4', { path: 'README.md' }, { resultCategory: 'write_failed' }, 'failed');
  f.write('5', { gates: ['npm test'] }, { resultCategory: 'validation_passed' });
  f.db.close();
  // Residue: the model's own validation run persisted data and touched README.
  fs.writeFileSync(path.join(f.workspace, 'expenses.json'), '{"items":[{"id":1,"description":"lunch","amount":12}]}');
  fs.appendFileSync(path.join(f.workspace, 'README.md'), 'touched by a tool\n');

  assert.deepEqual(agentWrittenPaths(f.coreData), ['expenses.js', 'lib/store.js', 'old.js']);
  const before = git(f.workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  const d = deliveredCheckout(f.workspace, f.coreData, path.join(f.root, 'delivered'));

  assert.equal(fs.readFileSync(path.join(d.checkout, 'expenses.js'), 'utf8'), 'module.exports = "persisted";\n');
  assert.equal(fs.readFileSync(path.join(d.checkout, 'lib', 'store.js'), 'utf8'), 'module.exports = "store";\n');
  assert.equal(fs.existsSync(path.join(d.checkout, 'old.js')), false, 'agent deletion is delivered');
  assert.equal(fs.existsSync(path.join(d.checkout, 'expenses.json')), false, 'validation residue is not delivered');
  assert.equal(fs.readFileSync(path.join(d.checkout, 'README.md'), 'utf8'), '# app\n', 'non-agent edit is not delivered');
  assert.equal(git(d.checkout, ['status', '--porcelain']), '', 'checkout is pristine');
  assert.notEqual(d.deliveredCommit, d.baseCommit);
  assert.deepEqual(d.residue.map(r => r.path).sort(), ['README.md', 'expenses.json']);
  assert.match(d.residue.find(r => r.path === 'expenses.json').preview, /lunch/);
  assert.equal(git(f.workspace, ['status', '--porcelain=v1', '--untracked-files=all']), before, 'task worktree is preserved untouched');
});

test('two delivered checkouts of the same delivery have the same tree, and a rebuild discards stale state', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.workspace, 'expenses.js'), 'module.exports = "persisted";\n');
  f.write('1', { path: 'expenses.js' }, { resultCategory: 'write_succeeded' });
  f.db.close();
  const a = deliveredCheckout(f.workspace, f.coreData, path.join(f.root, 'a'));
  const b = deliveredCheckout(f.workspace, f.coreData, path.join(f.root, 'b'));
  assert.equal(a.deliveredTree, b.deliveredTree);
  fs.writeFileSync(path.join(a.checkout, 'expenses.json'), '[]');
  const again = deliveredCheckout(f.workspace, f.coreData, path.join(f.root, 'a'));
  assert.equal(fs.existsSync(path.join(again.checkout, 'expenses.json')), false);
  assert.equal(again.deliveredTree, a.deliveredTree);
});

test('a committed delivery (HEAD moved, clean worktree) is checked out as-is', () => {
  const f = fixture();
  f.db.close();
  fs.writeFileSync(path.join(f.workspace, 'expenses.js'), 'module.exports = "committed";\n');
  git(f.workspace, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'deliver']);
  const d = deliveredCheckout(f.workspace, f.coreData, path.join(f.root, 'delivered'));
  assert.equal(d.deliveredCommit, git(f.workspace, ['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(d.checkout, 'expenses.js'), 'utf8'), 'module.exports = "committed";\n');
  assert.deepEqual(d.residue, []);
});

test('freshUserEnv gives a new, empty HOME each time', () => {
  const a = freshUserEnv();
  const b = freshUserEnv();
  assert.notEqual(a.HOME, b.HOME);
  assert.equal(a.USERPROFILE, a.HOME);
  assert.deepEqual(fs.readdirSync(a.HOME), []);
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) assert.ok(a[key].startsWith(a.HOME), key);
});
