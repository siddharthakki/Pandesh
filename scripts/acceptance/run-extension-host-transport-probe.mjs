#!/usr/bin/env node

import { runTests } from '@vscode/test-electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const runStamp = `${Date.now()}-${process.pid}`;
const workDir = path.join(os.tmpdir(), `oa-extension-host-transport-probe-${runStamp}`);
const workspaceDir = path.join(workDir, 'workspace');
const userDataDir = path.join(workDir, 'user-data');
const extensionsDir = path.join(workDir, 'extensions');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'extension-host-transport-probe');

function log(message) {
  console.log(`[extension-host-transport-probe] ${message}`);
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Extension Host transport probe workspace\n');

  try {
    log('Starting focused VS Code Extension Host transport probe.');
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'extensionHostTransportProbe.js'),
      launchArgs: [
        workspaceDir,
        '--disable-workspace-trust',
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
      ],
      extensionTestsEnv: {
        ...process.env,
        OLLAMA_AGENT_TRANSPORT_PROBE_EVIDENCE_DIR: evidenceDir,
      },
    });
    log(`PASSED. Evidence written to ${evidenceDir}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    log('Cleaned up temporary Extension Host probe directories.');
  }
}

main().catch(error => {
  console.error('[extension-host-transport-probe] FAILED');
  console.error(error);
  process.exitCode = 1;
});
