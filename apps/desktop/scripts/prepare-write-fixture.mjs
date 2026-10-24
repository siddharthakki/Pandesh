import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const stamp = process.env.KARKEDIKHA_FIXTURE_NAME
  ?? `desktop-write-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const fixture = path.resolve(process.env.KARKEDIKHA_DESKTOP_REPO || path.join(repoRoot, '.tmp', stamp));

fs.mkdirSync(path.join(fixture, 'src', 'generated'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
  name: 'desktop-write-fixture',
  private: true,
  version: '0.0.1',
  type: 'module',
  scripts: {
    test: 'node --test src/index.test.js',
  },
}, null, 2)}\n`);
fs.writeFileSync(path.join(fixture, 'src', 'index.js'), 'export const fixtureReady = true;\n');
fs.writeFileSync(path.join(fixture, 'src', 'index.test.js'), `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureReady } from './index.js';

test('fixture production export stays true', () => {
  assert.equal(fixtureReady, true);
});
`);
fs.writeFileSync(path.join(fixture, 'src', 'generated', '.gitkeep'), '');
fs.writeFileSync(path.join(fixture, 'README.md'), 'Disposable KarkeDikha Desktop write-workflow fixture.\n');

execFileSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'desktop@karkedikha.local'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'KarkeDikha Desktop'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['add', '-A'], { cwd: fixture, stdio: 'ignore' });
execFileSync('git', ['commit', '-m', 'fixture baseline'], { cwd: fixture, stdio: 'ignore' });

const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();
const info = { fixture, baseline, createdAt: new Date().toISOString() };
fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, '.tmp', 'desktop-write-fixture.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
