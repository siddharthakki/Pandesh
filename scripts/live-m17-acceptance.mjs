#!/usr/bin/env node
// npm run test:live:m17
//
// M17 dogfood acceptance harness against a real external repository (default:
// C:\Projects\apps\khakedikha). Skip-safe by default: requires
// OLLAMA_AGENT_LIVE_M17=1 or --enabled. Drives the real M15 durable task queue,
// resource scheduler, and isolated-worktree binding/identity check
// (IsolatedWorktreeManager.assertBinding), auto-approves proposal review and
// execution approval, and stops at the waiting_for_delivery_approval boundary
// (or records a legitimate blocked failure) -- never commits, pushes, or opens
// a pull request. Requires `npm run compile` first (invoked below) because this
// is a plain Node script, not a VS Code Extension Host process.

import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// The compiled M15/M16 runtime modules transitively require('vscode') via
// src/config/Config.ts. Outside the VS Code Extension Host that module does
// not exist, so redirect it to the same test-only vscode mock vitest already
// uses (src/test/mocks/vscode.ts, compiled to CJS in scripts/acceptance/).
createRequire(import.meta.url)('./acceptance/m17-vscode-node-hook.cjs');

const enabled = process.env.OLLAMA_AGENT_LIVE_M17 === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: live M17 dogfood acceptance requires OLLAMA_AGENT_LIVE_M17=1 or --enabled.');
  console.log('M17_LIVE_ACCEPTANCE_STATUS=skipped-safe-default');
  process.exit(0);
}

function argValue(flag) {
  const prefix = `--${flag}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const targetRepo = argValue('repo') ?? process.env.OLLAMA_AGENT_LIVE_M17_REPO ?? 'C:\\Projects\\apps\\khakedikha';

const {
  resolveGitRepoRoot,
  captureRepoSnapshot,
  runBoundedM17Task,
  assertAllM17Invariants,
  buildEvidenceArtifact,
  buildEvidenceReportText,
  fingerprintText,
} = await import('../out/acceptance/M17DogfoodAcceptance.js');

async function loadDogfoodGoal(repoRoot) {
  const knownTaskId = 'm15_mrccdq9x_5edabda0';
  const candidates = [
    path.join(repoRoot, '.ollama-agent', 'autonomous-tasks', knownTaskId, 'task.json'),
    path.join(repoRoot, '.ollama-agent', 'tasks', knownTaskId, 'task.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (typeof parsed.goal === 'string' && parsed.goal.length > 0) return parsed.goal;
    } catch {
      // try next candidate
    }
  }
  return 'Implement the first bounded M17 dogfood vertical slice per docs/M17_DOGFOOD_KHAKEDIKHA.md "First Executable Vertical Slice" (backend-only, no UI, no PWA, no push, no finance domain, no commit/push).';
}

async function main() {
  const resolvedRoot = await resolveGitRepoRoot(targetRepo);
  console.log(`M17 dogfood target repository: ${resolvedRoot}`);

  const before = await captureRepoSnapshot(resolvedRoot);
  console.log(`Before: branch=${before.branch} head=${before.head} dirty=${before.dirty} (${before.dirtyLines.length} lines)`);

  const goal = await loadDogfoodGoal(resolvedRoot);
  const goalFingerprint = fingerprintText(goal);

  const run = await runBoundedM17Task(resolvedRoot, { goal, goalFingerprint });

  const after = await captureRepoSnapshot(resolvedRoot);
  console.log(`After: branch=${after.branch} head=${after.head} dirty=${after.dirty} (${after.dirtyLines.length} lines)`);

  let invariantsPassed = true;
  let invariantFailureReason;
  try {
    assertAllM17Invariants({ before, after, run });
  } catch (error) {
    invariantsPassed = false;
    invariantFailureReason = error instanceof Error ? error.message : String(error);
  }

  const evidence = buildEvidenceArtifact({
    repoRoot: resolvedRoot,
    goalFingerprint,
    before,
    after,
    run,
    invariantsPassed,
    invariantFailureReason,
  });

  const runId = `${Date.now()}-${process.pid}`;
  const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'm17-dogfood', runId);
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(evidenceDir, 'report.md'), buildEvidenceReportText(evidence), 'utf8');
  console.log(`Evidence written to ${evidenceDir}`);

  if (!invariantsPassed) {
    console.error(`FAILED: ${invariantFailureReason}`);
    process.exit(1);
  }

  console.log(`M17_LIVE_ACCEPTANCE_STATUS=passed task=${run.taskId} finalState=${run.finalState} qualityGate=${run.qualityGate.status}`);
}

main().catch(error => {
  console.error(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
