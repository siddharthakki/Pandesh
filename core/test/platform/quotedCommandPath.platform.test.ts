/**
 * M-benchmark P1 — the quoted path reaches the shell intact.
 *
 * Node's default Windows argv quoting escapes the quotes inside a single
 * command string, so `cmd.exe` receives a mangled path and a quoted path
 * simply does not run. Both Windows command paths therefore pass the command
 * VERBATIM (`windowsVerbatimArguments`), which means the command the policy
 * layer authorized is the command the shell receives — byte for byte.
 *
 * This file proves that on the real platform, through both paths, with a
 * directory whose name contains a SPACE (the case that used to fail).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommandService } from '../../../src/services/CommandService';
import { CoreToolRunner } from '../../runtime/toolRunner';
import { LocalAutonomySecurityKernel } from '../../security/kernel';

const platformIt = process.platform === 'win32' ? it : it.skip;

/** A script that reports the path it was given, so a mangled path is visible. */
const MARKER = 'QUOTED-PATH-OK';
const SCRIPT = `console.log(${JSON.stringify(MARKER)}, process.argv[1]);\n`;

/** A real grant for the command under test (the trusted internal validation exemption). */
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

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A workspace whose path contains a space, with a script inside it. */
function workspaceWithASpace(): { root: string; script: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-quoted-'));
  const root = path.join(base, 'a folder with spaces');
  fs.mkdirSync(root, { recursive: true });
  const script = path.join(root, 'my script.js');
  fs.writeFileSync(script, SCRIPT, 'utf8');
  created.push(base);
  return { root, script };
}

describe('Windows platform: a quoted path is not mangled', () => {
  platformIt('runs the quoted path through the extension command service', async () => {
    const { root, script } = workspaceWithASpace();
    const command = `node "${script}"`;
    const result = await CommandService.run(command, root, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(MARKER);
    expect(result.stdout).toContain(script);
    expect(result.stderr).not.toContain('Cannot find module');
  }, 30_000);

  platformIt('runs the quoted path through the Core tool runner', async () => {
    const { root, script } = workspaceWithASpace();
    const command = `node "${script}"`;
    const result = await new CoreToolRunner().run(
      { name: 'run_command', arguments: { command } },
      { cwd: root, securityGrant: grantFor(command, root) },
    );
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain(MARKER);
    expect(result.output).toContain(script);
    expect(result.output).not.toContain('Cannot find module');
  }, 30_000);

  platformIt('keeps the authorized command as ONE shell program', async () => {
    // The command string is authorized as a whole and reaches cmd.exe as a
    // whole: the shell operator still separates the two programs, exactly as
    // it would for the string the policy layer inspected.
    const { root } = workspaceWithASpace();
    const result = await CommandService.run('echo one && echo two', root, 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('one');
    expect(result.stdout).toContain('two');
  }, 30_000);
});
