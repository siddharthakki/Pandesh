import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceSecurity } from '../../services/WorkspaceSecurity';

describe('WorkspaceSecurity', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-workspace-security-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('accepts a workspace-relative path for a new file in a new subdirectory', async () => {
    const resolved = await WorkspaceSecurity.resolveInsideWorkspace(
      'docs/agent-smoke-test.md',
      root,
      false,
    );

    expect(path.relative(root, resolved)).toBe(path.join('docs', 'agent-smoke-test.md'));
  });

  it('rejects a path outside the workspace', async () => {
    await expect(
      WorkspaceSecurity.resolveInsideWorkspace('../outside.md', root, false),
    ).rejects.toThrow('resolves outside workspace root');
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('accepts Windows drive-letter casing differences for a new file', async () => {
    const alternateCaseRoot = root.replace(/^([a-zA-Z]):/, (_match, drive: string) => {
      const alternate = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
      return `${alternate}:`;
    });

    const resolved = await WorkspaceSecurity.resolveInsideWorkspace(
      'docs/agent-smoke-test.md',
      alternateCaseRoot,
      false,
    );

    expect(path.relative(root, resolved)).toBe(path.join('docs', 'agent-smoke-test.md'));
  });
});
