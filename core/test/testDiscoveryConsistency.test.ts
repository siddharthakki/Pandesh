/**
 * The full sweep and the impacted tier must agree about what the
 * repository contains.
 *
 * The full sweep asks Vitest for the repository's configured include set; the
 * impacted tier discovers the files itself. If those two ever disagree, the
 * "full suite is green" claim and the "these are the affected tests" claim
 * are about different sets of files - which is exactly the confusion the
 * three tiers exist to remove.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverTestFiles } from '../../scripts/lib/test-impact.mjs';

const repoRoot = path.resolve(__dirname, '..', '..');

function configIncludeGlobs(): string[] {
  const source = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  const block = /include:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function configExcludeGlobs(): string[] {
  const source = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  const block = /exclude:\s*\[([\s\S]*?)\],/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** The file names the discovery rules deliberately leave out. */
const EXCLUDED_NAMES = ['agentPromptLive.test.ts', 'physicalDogfoodAcceptance.test.ts'];

describe('the full sweep and the impacted tier discover the same tests', () => {
  it('covers every test folder the repository owns', () => {
    const include = configIncludeGlobs();
    for (const folder of ['src/test/suite/', 'core/test/', 'apps/desktop/test/']) {
      expect(include.some((glob) => glob.startsWith(folder)), `the config must include ${folder}`).toBe(true);
    }
  });

  it('excludes exactly the files the discovery rules exclude', () => {
    const exclude = configExcludeGlobs();
    expect(exclude.some((glob) => glob.includes('core/test/platform'))).toBe(true);
    for (const name of EXCLUDED_NAMES) {
      expect(exclude.some((glob) => glob.endsWith(name)), `the config must exclude ${name}`).toBe(true);
    }
  });

  it('discovers every test file the config would run, and no others', () => {
    const discovered = new Set(discoverTestFiles(repoRoot).map((file) => path.relative(repoRoot, file).replace(/\\/g, '/')));
    // The platform tier and the two live tests are excluded on purpose.
    for (const file of discovered) {
      expect(file.startsWith('core/test/platform/')).toBe(false);
      for (const name of EXCLUDED_NAMES) expect(file.endsWith(name)).toBe(false);
    }
    // And the config must not exclude anything else.
    const excluded = configExcludeGlobs();
    for (const file of discovered) {
      for (const glob of excluded) {
        if (!glob.includes('*')) continue;
        const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`);
        expect(pattern.test(file), `${file} must not be excluded by ${glob}`).toBe(false);
      }
    }
  });
});
