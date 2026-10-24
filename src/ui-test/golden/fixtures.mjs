import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { goldenRunRootUnder, resolveGoldenEvidenceRoot } from './goldenEvidenceRoot.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (root, file, content) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

/** Tiny expense tracker: in-memory only (so "they vanish when I reopen it" is
 * the real, natural bug for workflow 2). Deterministic; no dependencies. */
export function expenseFiles() {
  return {
    'package.json': `${JSON.stringify({ name: 'expense-tracker', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': '# Expense tracker\n\nA tiny command-line expense tracker. Run `node cli.js`, then type commands:\n\n- `add <description> <amount>`\n- `list`\n- `total`\n- `exit`\n',
    'expenses.js': `'use strict';
// In-memory expense store.
function createStore() {
  const items = [];
  let nextId = 1;
  return {
    add(description, amount) {
      const value = Number(amount);
      if (!description || !Number.isFinite(value)) throw new Error('invalid expense');
      const item = { id: nextId++, description, amount: value };
      items.push(item);
      return item;
    },
    list() { return items.slice(); },
    total() { return items.reduce((sum, item) => sum + item.amount, 0); },
  };
}
module.exports = { createStore };
`,
    'cli.js': `'use strict';
const readline = require('node:readline');
const { createStore } = require('./expenses');

const store = createStore();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const [command, ...rest] = line.trim().split(/\\s+/);
  try {
    if (command === 'add') {
      const amount = rest.pop();
      const item = store.add(rest.join(' '), amount);
      console.log(\`Added #\${item.id}: \${item.description} - \${item.amount.toFixed(2)}\`);
    } else if (command === 'list') {
      for (const item of store.list()) console.log(\`\${item.id}. \${item.description} - \${item.amount.toFixed(2)}\`);
    } else if (command === 'total') {
      console.log(\`Total: \${store.total().toFixed(2)}\`);
    } else if (command === 'exit') {
      rl.close();
    } else if (command) {
      console.log(\`Unknown command: \${command}\`);
    }
  } catch (error) {
    console.log(\`Error: \${error.message}\`);
  }
});
`,
    'test/expenses.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../expenses');

test('adds expenses and totals them', () => {
  const store = createStore();
  store.add('lunch', 12);
  store.add('coffee', 4.5);
  assert.equal(store.list().length, 2);
  assert.equal(store.total(), 16.5);
});
`,
  };
}

/** The expense tracker plus an ordinary project convention enforced by its own test: README.md must document every
 * CLI command. A natural "add a command" change that only touches cli.js fails `npm test` for a real, explained
 * reason, which gives the bounded validation-repair path something genuine to recover from (nothing is sabotaged). */
export function expenseDocumentedFiles() {
  return {
    ...expenseFiles(),
    'test/readme.test.js': `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('README documents every CLI command', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const commands = [...cli.matchAll(/command === '(\\w+)'/g)].map(match => match[1]);
  assert.ok(commands.length >= 4, 'expected to find the CLI commands');
  for (const command of commands) {
    assert.ok(readme.includes(\`\\\`\${command}\`), \`README.md does not document the "\${command}" command\`);
  }
});
`,
  };
}

/** Empty-ish starter for the from-scratch Karke Dikha build. */
export function blankFiles() {
  return {
    'README.md': '# Scratch project\n\nEmpty starter.\n',
    'package.json': `${JSON.stringify({ name: 'scratch', version: '1.0.0', private: true }, null, 2)}\n`,
  };
}

/** UAT fixture: the user's real, existing Turnout Event Form Studio (read from UAT_EVENT_FORMS or the default path). */
export function eventFormsFiles() {
  const source = process.env.UAT_EVENT_FORMS ?? 'C:\\Projects\\Events_Forms\\event_forms.html';
  return { 'event_forms.html': fs.readFileSync(source, 'utf8') };
}

/** A brand-new file map for a scenario's `fixture` name; never a shared object. */
export function fixtureFiles(fixture) {
  return fixture === 'blank' ? blankFiles() : fixture === 'eventforms' ? eventFormsFiles() : fixture === 'expense-documented' ? expenseDocumentedFiles() : expenseFiles();
}

/** One Golden runner invocation's evidence root (one per model-bench repetition), under the authoritative
 * evidence root (goldenEvidenceRoot.mjs; external to the repo). `evidenceRoot` is injectable for tests. */
export function goldenRunRoot(evidenceRoot = resolveGoldenEvidenceRoot(), now = new Date(), unique = randomBytes(4).toString('hex')) {
  return goldenRunRootUnder(evidenceRoot, now, unique);
}

/** The disposable per-attempt environment: evidence, extensions, Core data, VS Code
 * profile/session storage and a freshly committed fixture workspace, all under
 * <runRoot>/<scenario>/attempt-<n>. Nothing is shared between attempts or runs. */
export function prepareAttempt({ runRoot, name, attempt, fixture, settings }) {
  const base = path.join(runRoot, name, `attempt-${attempt}`);
  const dirs = {
    base,
    evidence: path.join(base, 'evidence'),
    extensions: path.join(base, 'extensions'),
    coreData: path.join(base, 'core-data'),
    sessionStorage: path.join(base, 'extest'),
  };
  for (const dir of [dirs.evidence, dirs.extensions, dirs.coreData, dirs.sessionStorage]) fs.mkdirSync(dir, { recursive: true });
  return { ...dirs, workspace: createWorkspace(path.join(base, 'workspace'), fixtureFiles(fixture), settings) };
}

/** Creates a fresh committed Git workspace. `settings` is committed so the tree
 * is clean at rest (same convention as the guardian harness). */
export function createWorkspace(root, files, settings) {
  fs.mkdirSync(root, { recursive: true });
  const all = { ...files, '.vscode/settings.json': `${JSON.stringify(settings, null, 2)}\n` };
  for (const [file, content] of Object.entries(all)) write(root, file, content);
  git(root, ['init', '-b', 'golden-main']);
  git(root, ['config', 'user.name', 'KKD Golden']);
  git(root, ['config', 'user.email', 'golden@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize golden fixture']);
  return root;
}
