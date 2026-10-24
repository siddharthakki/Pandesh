import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const trackedStatus = git(['status', '--porcelain=v1', '--untracked-files=no']);
if (trackedStatus) throw new Error('Refusing to freeze a VSIX from a dirty tracked worktree. Commit the guardian source first.');

const head = git(['rev-parse', 'HEAD']);
const branch = git(['branch', '--show-current']);
const rootVsix = path.join(root, 'karkedikha-win32-x64.vsix');
if (fs.existsSync(rootVsix)) throw new Error(`Refusing to overwrite existing ${rootVsix}`);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this through npm run test:guardian:build-vsix');
execFileSync(process.execPath, [npmCli, 'run', 'package:win32-x64'], { cwd: root, stdio: 'inherit' });
if (git(['rev-parse', 'HEAD']) !== head) throw new Error('Repository HEAD changed while the VSIX was being built');
if (!fs.existsSync(rootVsix)) throw new Error('package:win32-x64 did not produce karkedikha-win32-x64.vsix');

const bytes = fs.readFileSync(rootVsix);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const outputDir = path.join(root, '.guardian-cache', 'vsix', head);
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, 'karkedikha-win32-x64.vsix');
fs.renameSync(rootVsix, output);
const provenance = {
  schemaVersion: 1,
  sourceHead: head,
  sourceBranch: branch,
  path: output,
  bytes: bytes.length,
  sha256,
  target: 'win32-x64',
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outputDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify(provenance, null, 2));
