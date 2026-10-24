#!/usr/bin/env node
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const enabled = process.env.OLLAMA_AGENT_LIVE_M13 === '1' || process.argv.includes('--enabled');
const approve = process.env.OLLAMA_AGENT_LIVE_M13_APPROVE === '1' || process.argv.includes('--approve');

if (!enabled) {
  console.log('SKIPPED: live M13 acceptance requires OLLAMA_AGENT_LIVE_M13=1 or --enabled.');
  process.exit(0);
}

if (!approve) {
  console.log('SKIPPED: live M13 mutation requires OLLAMA_AGENT_LIVE_M13_APPROVE=1 or --approve.');
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-live-m13-'));
try {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      verify: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  await run('git', ['init'], root);
  await run('git', ['config', 'user.email', 'live-m13@example.invalid'], root);
  await run('git', ['config', 'user.name', 'Live M13 Harness'], root);
  await run('git', ['add', '.'], root);
  await run('git', ['commit', '-m', 'init'], root);

  console.log(`LIVE_M13_WORKSPACE=${root}`);
  console.log('READY: open the extension host against this disposable workspace and run ollama-agent.runForgeCodingTask.');
  console.log('TASK: create src/live-m13-acceptance.ts exporting const liveM13Acceptance = true, then run npm verify.');
  console.log('This harness never touches the real repository, and no commit or push is performed after the initial disposable baseline.');
} finally {
  if (process.env.OLLAMA_AGENT_LIVE_M13_KEEP !== '1') {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    console.log('CLEANED: disposable live M13 workspace removed.');
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with ${code}`)));
  });
}
