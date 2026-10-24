import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * Qualification worktree hygiene. Permanent rule: a qualification worktree owns its node_modules. Sharing the
 * development checkout's node_modules (junction/symlink) makes package inspection depend on the development tree.
 * The helper must plan the deterministic flow and refuse a shared node_modules.
 */
interface Qualify {
  planQualification(options?: { skipTests?: boolean; noPackage?: boolean }): Array<{ id: string; label: string }>;
  nodeModulesIsShared(worktreeRoot: string): boolean;
  parseArgs(argv: string[]): Record<string, unknown>;
  main(argv: string[]): Promise<number>;
}

async function loadHelper(): Promise<Qualify> {
  const file = path.resolve(__dirname, '..', '..', '..', 'scripts', 'qualify-worktree.mjs');
  return import(pathToFileURL(file).href) as Promise<Qualify>;
}

describe('qualification worktree flow', () => {
  it('is the deterministic sequence: install, three typechecks, tests, package, inspect', async () => {
    const { planQualification } = await loadHelper();
    expect(planQualification().map(stage => stage.id)).toEqual([
      'install', 'typecheck-extension', 'typecheck-core', 'typecheck-webview', 'tests', 'package', 'inspect',
    ]);
    expect(planQualification({ skipTests: true }).map(stage => stage.id)).not.toContain('tests');
    expect(planQualification({ noPackage: true }).map(stage => stage.id)).toEqual([
      'install', 'typecheck-extension', 'typecheck-core', 'typecheck-webview', 'tests',
    ]);
    // npm ci always comes first: nothing runs against dependencies the worktree did not install itself.
    expect(planQualification()[0].id).toBe('install');
  });

  it('parses its arguments and rejects unknown ones', async () => {
    const { parseArgs } = await loadHelper();
    expect(parseArgs(['--ref', 'abc123', '--skip-tests', '--cleanup'])).toMatchObject({ ref: 'abc123', skipTests: true, cleanup: true });
    expect(() => parseArgs(['--junction-node-modules'])).toThrow('Unknown argument');
  });

  it('a dry run prints the plan and creates nothing', async () => {
    const { main } = await loadHelper();
    const created = path.join(os.tmpdir(), `kkd-qual-dryrun-${Date.now()}`);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      expect(await main(['--dry-run', '--dir', created])).toBe(0);
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines.join('\n')).stages).toContain('npm ci');
    expect(fs.existsSync(created)).toBe(false);
  });
});

describe('node_modules ownership check', () => {
  let root: string;
  let elsewhere: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-qual-wt-'));
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-dev-modules-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('accepts a worktree with no node_modules yet and one with its own real directory', async () => {
    const { nodeModulesIsShared } = await loadHelper();
    expect(nodeModulesIsShared(root)).toBe(false);
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    expect(nodeModulesIsShared(root)).toBe(false);
  });

  it('refuses a node_modules that is a junction/symlink to another tree', async () => {
    const { nodeModulesIsShared } = await loadHelper();
    fs.symlinkSync(elsewhere, path.join(root, 'node_modules'), 'junction');
    expect(nodeModulesIsShared(root)).toBe(true);
  });
});
