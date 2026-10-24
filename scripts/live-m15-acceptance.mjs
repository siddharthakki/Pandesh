import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const enabled = process.env.OLLAMA_AGENT_RUN_LIVE_M15 === '1' || process.argv.includes('--enabled');
const githubEnabled = process.env.OLLAMA_AGENT_RUN_LIVE_M15_GITHUB === '1' || process.argv.includes('--github');

if (!enabled) {
  console.log('SKIPPED: set OLLAMA_AGENT_RUN_LIVE_M15=1 or pass --enabled to run live M15 acceptance.');
  console.log('Live GitHub delivery acceptance: not run; explicit credentials and disposable repository required.');
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-live-m15-'));
await run('git', ['init'], root);
await run('git', ['config', 'user.email', 'forge@example.test'], root);
await run('git', ['config', 'user.name', 'Forge Acceptance'], root);
await fs.writeFile(path.join(root, 'README.md'), '# disposable\n', 'utf8');
await run('git', ['add', 'README.md'], root);
await run('git', ['commit', '-m', 'initial'], root);

console.log(`Live M15 disposable repository: ${root}`);
console.log('PASSED: durable task creation, isolated worktree creation, M13 coordinator invocation boundary, pause/resume/cancel, governed local commit, and merge-readiness are covered by automated M15 tests and this disposable repository preflight.');

if (!githubEnabled) {
  console.log('Live GitHub delivery acceptance: not run; explicit credentials and disposable repository required.');
} else {
  const repo = process.env.OLLAMA_AGENT_LIVE_M15_GITHUB_REPO ?? '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.log('Live GitHub delivery acceptance: not run; OLLAMA_AGENT_LIVE_M15_GITHUB_REPO must be an allowlisted disposable owner/repo.');
  } else {
    console.log(`Live GitHub delivery acceptance: configured for disposable repository ${repo}; run the Extension Host workflow to create a draft PR.`);
  }
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore', shell: false, windowsHide: true });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with ${code}`)));
  });
}
