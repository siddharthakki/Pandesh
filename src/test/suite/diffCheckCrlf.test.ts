import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodingValidationRunner, diffCheckWhitespaceRules } from '../../coding/ValidationRunner';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('git-diff-check in a repository that commits CRLF', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diffcheck-crlf-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'core.autocrlf', 'false']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'test']);
    await fs.writeFile(path.join(root, 'app.html'), 'one();\r\ntwo();\r\nthree();\r\n', 'utf8');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'crlf baseline']);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const check = async () => (await new CodingValidationRunner(root, 30_000).runAll([{ kind: 'git-diff-check' }]))[0];

  it('passes an edit that keeps the file\'s CRLF line endings', async () => {
    await fs.writeFile(path.join(root, 'app.html'), 'one();\r\ntwo(); dup();\r\nthree();\r\n', 'utf8');
    const result = await check();
    expect(result.command).toBe('git diff --check');
    expect(result.exitCode).toBe(0);
  });

  it('still reports real trailing whitespace', async () => {
    await fs.writeFile(path.join(root, 'app.html'), 'one();\r\ntwo();  \r\nthree();\r\n', 'utf8');
    const result = await check();
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('trailing whitespace');
  });

  it('keeps the repository\'s own whitespace rules', () => {
    expect(diffCheckWhitespaceRules(root)).toBe('cr-at-eol');
    git(root, ['config', 'core.whitespace', 'tab-in-indent,-cr-at-eol']);
    expect(diffCheckWhitespaceRules(root)).toBe('tab-in-indent,cr-at-eol');
  });
});
