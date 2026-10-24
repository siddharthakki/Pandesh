/**
 * Prepares the Autonomous Mission task-list proof target.
 *
 * A tiny disposable web app in Core-owned scratch, outside the product
 * repository: a page skeleton whose add / complete / filter behaviour is
 * missing, a focused `npm test` that fails against that defect, and a
 * host-owned `.karkedikha/verification-plan.json` that Core will run in a
 * real browser. The mission cannot change the plan. No git remote.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const requestedScratch = process.env.KARKEDIKHA_TASK_LIST_SCRATCH
  ?? path.join(os.tmpdir(), 'karkedikha-task-list');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function removeScratch(target) {
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isFile()) {
      try { fs.chmodSync(full, 0o666); } catch { /* best effort */ }
    }
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function freshScratch(preferred) {
  try {
    removeScratch(preferred);
    return preferred;
  } catch {
    const alternate = `${preferred}-${Date.now().toString(36)}`;
    removeScratch(alternate);
    return alternate;
  }
}

const scratch = freshScratch(requestedScratch);
const fixture = path.join(scratch, 'repo');
const dataDir = path.join(scratch, 'desktop-data');
fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
fs.mkdirSync(path.join(fixture, '.karkedikha'), { recursive: true });

const write = (relative, contents) => {
  fs.writeFileSync(path.join(fixture, relative), contents, 'utf8');
};

write('package.json', `${JSON.stringify({
  name: 'task-list-fixture',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: { test: 'node --test' },
}, null, 2)}\n`);

write('README.md', [
  '# task-list-fixture',
  '',
  'A small task-list page. Users type a title, add the task, mark it complete,',
  'and filter Active or Completed without reloading.',
  '',
  'Keep the labelled title field, the Add button, the All / Active / Completed',
  'filters, and a list of tasks. Each task is a list item with class `completed`',
  'when done, and a checkbox named after the task title.',
  '',
  'Run the focused check with `npm test`.',
  '',
].join('\n'));

write('index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task list</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="card">
    <h1>Task list</h1>
    <form id="task-form">
      <label for="task-title">Task title</label>
      <input id="task-title" name="title" autocomplete="off">
      <button type="submit">Add</button>
    </form>
    <nav aria-label="Filter tasks">
      <button type="button" id="filter-all" aria-pressed="true">All</button>
      <button type="button" id="filter-active" aria-pressed="false">Active</button>
      <button type="button" id="filter-completed" aria-pressed="false">Completed</button>
    </nav>
    <ul id="task-list"></ul>
  </main>
  <script type="module" src="src/app.js"></script>
</body>
</html>
`);

write('styles.css', `* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: Georgia, 'Times New Roman', serif;
  background: #eef2f4;
  color: #15202b;
  display: flex;
  justify-content: center;
  padding: 24px 16px;
}
.card {
  width: min(440px, 100%);
  background: #fff;
  border: 1px solid #c5d0d6;
  border-radius: 16px;
  padding: 24px;
}
h1 { margin-top: 0; font-size: 1.5rem; }
label { display: block; margin: 12px 0 6px; }
input, button {
  font: inherit;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #b7c3ca;
}
form { display: grid; gap: 8px; }
nav { display: flex; gap: 8px; margin: 16px 0; }
nav button[aria-pressed="true"] { font-weight: 700; }
#task-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
#task-list li.completed { text-decoration: line-through; opacity: 0.7; }
@media (max-width: 420px) {
  body { padding: 12px; }
  .card { padding: 16px; }
}
`);

// Defect: add does not record a task, complete is a no-op, and filter ignores
// the requested view so Active and Completed always show the same list.
write('src/tasks.js', [
  'export function createList() {',
  '  return [];',
  '}',
  '',
  'export function addTask(list, title) {',
  '  return list;',
  '}',
  '',
  'export function completeTask(list, id) {',
  '  return list;',
  '}',
  '',
  "export function visibleTasks(list, filter) {",
  '  return list;',
  '}',
  '',
].join('\n'));

write('src/app.js', [
  "import { addTask, completeTask, createList, visibleTasks } from './tasks.js';",
  '',
  "const form = document.getElementById('task-form');",
  "const titleInput = document.getElementById('task-title');",
  "const listEl = document.getElementById('task-list');",
  "const filterAll = document.getElementById('filter-all');",
  "const filterActive = document.getElementById('filter-active');",
  "const filterCompleted = document.getElementById('filter-completed');",
  '',
  'let tasks = createList();',
  "let filter = 'all';",
  '',
  "form.addEventListener('submit', (event) => {",
  '  event.preventDefault();',
  '  const title = titleInput.value.trim();',
  '  if (!title) return;',
  '  tasks = addTask(tasks, title);',
  "  titleInput.value = '';",
  '  render();',
  '});',
  '',
  'function render() {',
  '  listEl.replaceChildren();',
  '  for (const task of visibleTasks(tasks, filter)) {',
  '    const item = document.createElement(\'li\');',
  "    if (task.completed) item.className = 'completed';",
  '    const label = document.createElement(\'label\');',
  "    const box = document.createElement('input');",
  "    box.type = 'checkbox';",
  '    box.checked = Boolean(task.completed);',
  "    box.addEventListener('change', () => {",
  '      tasks = completeTask(tasks, task.id);',
  '      render();',
  '    });',
  '    const title = document.createElement(\'span\');',
  '    title.textContent = task.title;',
  '    label.append(box, title);',
  '    item.append(label);',
  '    listEl.append(item);',
  '  }',
  '}',
  '',
  'function setFilter(next) {',
  '  filter = next;',
  "  filterAll.setAttribute('aria-pressed', next === 'all' ? 'true' : 'false');",
  "  filterActive.setAttribute('aria-pressed', next === 'active' ? 'true' : 'false');",
  "  filterCompleted.setAttribute('aria-pressed', next === 'completed' ? 'true' : 'false');",
  '  render();',
  '}',
  '',
  "filterAll.addEventListener('click', () => setFilter('all'));",
  "filterActive.addEventListener('click', () => setFilter('active'));",
  "filterCompleted.addEventListener('click', () => setFilter('completed'));",
  '',
].join('\n'));

write('tests/tasks.test.js', [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { addTask, completeTask, createList, visibleTasks } from '../src/tasks.js';",
  '',
  "test('adds a task with the typed title', () => {",
  '  const list = addTask(createList(), \'Buy milk\');',
  '  assert.equal(list.length, 1);',
  "  assert.equal(list[0].title, 'Buy milk');",
  '  assert.equal(list[0].completed, false);',
  '});',
  '',
  "test('marks a task complete', () => {",
  '  const added = addTask(createList(), \'Buy milk\');',
  '  const list = completeTask(added, added[0].id);',
  '  assert.equal(list[0].completed, true);',
  '});',
  '',
  "test('filters active and completed tasks', () => {",
  '  let list = addTask(createList(), \'Buy milk\');',
  "  list = addTask(list, 'Walk dog');",
  '  list = completeTask(list, list[0].id);',
  "  const active = visibleTasks(list, 'active');",
  "  const completed = visibleTasks(list, 'completed');",
  '  assert.deepEqual(active.map((task) => task.title), [\'Walk dog\']);',
  '  assert.deepEqual(completed.map((task) => task.title), [\'Buy milk\']);',
  '});',
  '',
].join('\n'));

write('.karkedikha/verification-plan.json', `${JSON.stringify({
  version: 1,
  page: 'index.html',
  acceptanceCriteria: [
    'Typing a title and choosing Add shows that task in the list without reloading',
    'Marking a task complete records it as completed',
    'Active shows incomplete tasks and Completed shows finished tasks',
  ],
  dependsOn: ['index.html', 'src/app.js', 'src/tasks.js', 'styles.css'],
  checks: [
    {
      id: 'add-task',
      viewportWidth: 1280,
      viewportHeight: 800,
      steps: [
        { action: 'fill', locator: { label: 'Task title' }, value: 'Buy milk' },
        { action: 'click', locator: { role: 'button', name: 'Add' } },
      ],
      expect: [
        { kind: 'text', locator: { role: 'listitem', name: 'Buy milk' }, equals: 'Buy milk' },
        { kind: 'visible', locator: { role: 'listitem', name: 'Buy milk' }, visible: true },
        { kind: 'value', locator: { label: 'Task title' }, equals: '' },
        { kind: 'url', unchanged: true },
      ],
    },
    {
      id: 'complete-task',
      viewportWidth: 1280,
      viewportHeight: 800,
      steps: [
        { action: 'fill', locator: { label: 'Task title' }, value: 'Buy milk' },
        { action: 'click', locator: { role: 'button', name: 'Add' } },
        { action: 'click', locator: { role: 'checkbox', name: 'Buy milk' } },
      ],
      expect: [
        { kind: 'visible', selector: '#task-list li.completed', visible: true },
        { kind: 'text', locator: { role: 'listitem', name: 'Buy milk' }, equals: 'Buy milk' },
        { kind: 'url', unchanged: true },
      ],
    },
    {
      id: 'filter-active-completed',
      viewportWidth: 390,
      viewportHeight: 844,
      steps: [
        { action: 'fill', locator: { label: 'Task title' }, value: 'Buy milk' },
        { action: 'click', locator: { role: 'button', name: 'Add' } },
        { action: 'fill', locator: { label: 'Task title' }, value: 'Walk dog' },
        { action: 'click', locator: { role: 'button', name: 'Add' } },
        { action: 'click', locator: { role: 'checkbox', name: 'Buy milk' } },
        { action: 'click', locator: { role: 'button', name: 'Active' } },
      ],
      expect: [
        { kind: 'pressed', locator: { role: 'button', name: 'Active' }, pressed: true },
        { kind: 'visible', locator: { role: 'listitem', name: 'Walk dog' }, visible: true },
        { kind: 'visible', locator: { role: 'listitem', name: 'Buy milk' }, visible: false },
      ],
    },
    {
      id: 'filter-completed',
      viewportWidth: 390,
      viewportHeight: 844,
      steps: [
        { action: 'fill', locator: { label: 'Task title' }, value: 'Buy milk' },
        { action: 'click', locator: { role: 'button', name: 'Add' } },
        { action: 'fill', locator: { label: 'Task title' }, value: 'Walk dog' },
        { action: 'click', locator: { role: 'button', name: 'Add' } },
        { action: 'click', locator: { role: 'checkbox', name: 'Buy milk' } },
        { action: 'click', locator: { role: 'button', name: 'Completed' } },
      ],
      expect: [
        { kind: 'pressed', locator: { role: 'button', name: 'Completed' }, pressed: true },
        { kind: 'visible', locator: { role: 'listitem', name: 'Buy milk' }, visible: true },
        { kind: 'visible', locator: { role: 'listitem', name: 'Walk dog' }, visible: false },
      ],
    },
  ],
}, null, 2)}\n`);

git(['init', '--quiet', '--initial-branch=main'], fixture);
git(['config', 'user.email', 'proof@localhost'], fixture);
git(['config', 'user.name', 'Task List Mission Proof'], fixture);
git(['add', '-A'], fixture);
git(['commit', '--quiet', '-m', 'task-list fixture with failing focused check'], fixture);

const remotes = git(['remote'], fixture);
if (remotes) throw new Error(`fixture must have no remote, found: ${remotes}`);
const status = git(['status', '--porcelain', '--untracked-files=all'], fixture);
if (status) throw new Error(`fixture is not clean:\n${status}`);

const before = spawnSync('npm test', {
  cwd: fixture,
  encoding: 'utf8',
  windowsHide: true,
  shell: true,
});
if (before.error || before.status === null) {
  throw new Error(`could not run the focused check: ${before.error?.message ?? 'no exit status'}`);
}
const baselineCheckFailed = before.status !== 0;
if (!baselineCheckFailed) {
  throw new Error('the focused check passes at baseline; the fixture proves nothing');
}
if (!/ERR_ASSERTION/.test(`${before.stdout ?? ''}${before.stderr ?? ''}`)) {
  throw new Error(`the focused check failed without an assertion failure:\n${before.stdout}\n${before.stderr}`);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'last-workspace.json'),
  `${JSON.stringify({ folder: fixture, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

const info = {
  fixture,
  dataDir,
  scratch,
  baseline: git(['rev-parse', 'HEAD'], fixture),
  baselineCheckFailed,
  baselineCheckExitCode: before.status,
  intendedPaths: ['src/tasks.js'],
  focusedCheck: 'npm run test',
  verificationPlan: '.karkedikha/verification-plan.json',
  productHead: git(['rev-parse', 'HEAD'], repoRoot),
  productStatus: git(['status', '--porcelain', '--untracked-files=all'], repoRoot),
  preparedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(scratch, 'fixture.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(info, null, 2));
