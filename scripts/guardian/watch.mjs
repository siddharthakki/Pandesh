import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
let focusedRunning = false;
let smokeRunning = false;
let focusedQueued = false;
let smokeQueued = false;

function run(command, onDone) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; start the watcher through npm run test:guardian:watch');
  const child = spawn(process.execPath, [npmCli, 'run', command], { cwd: root, stdio: 'inherit' });
  child.on('exit', code => onDone(code ?? 1));
}
function queueFocused() {
  if (focusedRunning) return void (focusedQueued = true);
  focusedRunning = true;
  run('test:guardian:focused', () => {
    focusedRunning = false;
    if (focusedQueued) {
      focusedQueued = false;
      queueFocused();
    }
  });
}
function queueSmoke() {
  if (smokeRunning) return void (smokeQueued = true);
  smokeRunning = true;
  run('test:guardian:smoke', () => {
    smokeRunning = false;
    if (smokeQueued) {
      smokeQueued = false;
      queueSmoke();
    }
  });
}

const sourceWatcher = fs.watch(path.join(root, 'src'), { recursive: true }, (_event, filename) => {
  if (filename && !filename.includes('ui-test/generated')) queueFocused();
});
const cacheRoot = path.join(root, '.guardian-cache', 'vsix');
fs.mkdirSync(cacheRoot, { recursive: true });
const packageWatcher = fs.watch(cacheRoot, { recursive: true }, (_event, filename) => {
  if (filename?.endsWith('.vsix')) queueSmoke();
});
process.on('SIGINT', () => {
  sourceWatcher.close();
  packageWatcher.close();
  process.exit(0);
});
console.log('Guardian watch active: source changes run focused checks; new frozen VSIX files queue installed-product smoke.');
