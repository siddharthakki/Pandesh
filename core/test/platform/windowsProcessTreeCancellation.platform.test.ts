import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreToolRunner } from '../../runtime/toolRunner';
import { LocalAutonomySecurityKernel } from '../../security/kernel';

const platformIt = process.platform === 'win32' ? it : it.skip;
const owned = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('controlled process tree did not reach the expected state');
}

/**
 * A real grant for the command under test.
 *
 * A consequential action needs an authoritative grant; the trusted internal
 * validation exemption is the same path Core's own validation runner uses,
 * so the command really runs (with the real spawn, the real tree and the
 * real kill) instead of being refused for want of a grant.
 */
function grantFor(command: string, workspaceRoot: string) {
  const kernel = LocalAutonomySecurityKernel.getInstance();
  const request = kernel.normalizeRequest({
    attemptId: 'validation_internal',
    executor: 'core:workspace_validation',
    capability: 'process',
    workspaceRoot,
    targetResource: workspaceRoot,
    command,
    arguments: { command },
    origin: {
      actor: 'core:workspace_validation',
      isModelGenerated: false,
      provenance: 'trusted_internal_validation',
    },
    riskLevel: 'consequential',
  });
  const decision = kernel.authorize(request);
  if (decision.decision !== 'ALLOW' || !decision.grant) {
    throw new Error(`the test command could not be authorized: ${decision.reason}`);
  }
  return decision.grant;
}

afterEach(() => {
  for (const pid of owned) {
    if (isAlive(pid)) {
      try { process.kill(pid); } catch { /* platform gate reports the assertion failure */ }
    }
  }
  owned.clear();
});

describe('Windows platform: Karke kills the exact process tree it owns', () => {
  platformIt('terminates the controlled child and grandchild on abort', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-owned-tree-'));
    const pidFile = path.join(root, 'owned-pids.json');
    // The fixture is copied INTO the workspace: the command policy refuses a
    // command that targets a path outside the selected repository, and the
    // point of this test is the process tree, not the policy.
    const fixture = path.join(root, 'ownedProcessTree.cjs');
    fs.copyFileSync(path.resolve(__dirname, 'fixtures/ownedProcessTree.cjs'), fixture);
    const controller = new AbortController();
    try {
      const command = `node "${fixture}" "${pidFile}"`;
      const pending = new CoreToolRunner().run({
        name: 'run_command',
        arguments: { command },
      }, { cwd: root, signal: controller.signal, securityGrant: grantFor(command, root) });
      const pids = await waitFor(() => {
        if (!fs.existsSync(pidFile)) return undefined;
        return JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
      });
      owned.add(pids.child);
      owned.add(pids.grandchild);
      expect(isAlive(pids.child)).toBe(true);
      expect(isAlive(pids.grandchild)).toBe(true);

      const started = Date.now();
      controller.abort();
      const result = await pending;
      expect(result.status).toBe('failed');
      expect(Date.now() - started).toBeLessThan(15_000);
      await waitFor(() => !isAlive(pids.child) && !isAlive(pids.grandchild) ? true : undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
