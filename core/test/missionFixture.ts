import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MISSING_HELPER_FIXTURE = path.join(process.cwd(), 'core', 'test', 'fixtures', 'missing-helper');

export const MISSING_HELPER_TASK =
  'The checkout function returns the wrong total for a two-item cart. Make the existing unit tests pass and create a local git commit. Do not push. Search the repository for the existing money helper instead of inventing a new formatter.';

export const FIXED_APP_JS = [
  "const { formatMoney } = require('./money');",
  '',
  'function checkout(items) {',
  '  let cents = 0;',
  '  for (const item of items) {',
  '    cents += item.priceCents;',
  '  }',
  '  return formatMoney(cents);',
  '}',
  '',
  'module.exports = { checkout };',
  '',
].join('\n');

export function copyMissingHelperFixture(dest: string): void {
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'tests'), { recursive: true });
  for (const relative of ['package.json', 'src/app.js', 'src/money.js', 'tests/app.test.js']) {
    fs.copyFileSync(path.join(MISSING_HELPER_FIXTURE, relative), path.join(dest, relative));
  }
}

export const CROSSFILE_VALIDATOR_FIXTURE = path.join(process.cwd(), 'core', 'test', 'fixtures', 'crossfile-validator');

export const CROSSFILE_VALIDATOR_TASK =
  'Investigate why the validator returns the wrong result for ordinary input. Find the relevant helper and caller, make the smallest correct fix, add or update a focused test, run the focused test, review the diff, and commit locally. Do not install packages, use the network, access files outside the fixture, or push.';

export const FIXED_INDEX_JS = [
  "const { isOrdinary } = require('./lib/ordinary');",
  '',
  'function validate(input) {',
  '  return isOrdinary(input);',
  '}',
  '',
  'module.exports = { validate };',
  '',
].join('\n');

const CROSSFILE_VALIDATOR_FILES = [
  'package.json',
  'index.js',
  'lib/ordinary.js',
  'lib/special.js',
  'lib/README.md',
  'decoys/format.js',
  'decoys/sanitize.js',
  'decoys/legacy-validator.js',
  'notes/checklist.md',
  'tests/validator.test.js',
];

export function copyCrossfileValidatorFixture(dest: string): void {
  for (const relative of CROSSFILE_VALIDATOR_FILES) {
    const target = path.join(dest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(CROSSFILE_VALIDATOR_FIXTURE, relative), target);
  }
}

export function gitInitFixture(repo: string, message = 'initial missing-helper fixture'): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@local',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@local',
  };
  execFileSync('git', ['init'], { cwd: repo, env });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'add', '-A'], { cwd: repo, env });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-m', message], { cwd: repo, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

export function boundedCrossfileContext(repo: string) {
  const caller = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
  const tests = fs.readFileSync(path.join(repo, 'tests', 'validator.test.js'), 'utf8');
  const pkg = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
  const decoy = fs.readFileSync(path.join(repo, 'decoys', 'legacy-validator.js'), 'utf8');
  const prompt = `### index.js\n${caller}\n\n### tests/validator.test.js\n${tests}\n\n### package.json\n${pkg}\n\n### decoys/legacy-validator.js\n${decoy}`;
  return {
    prompt,
    selectedFiles: [
      { path: 'index.js', estimatedTokens: 30 },
      { path: 'tests/validator.test.js', estimatedTokens: 60 },
      { path: 'package.json', estimatedTokens: 20 },
      { path: 'decoys/legacy-validator.js', estimatedTokens: 30 },
    ],
    estimatedTokens: 140,
  };
}

export function boundedRepositoryContext(repo: string) {
  const app = fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8');
  const tests = fs.readFileSync(path.join(repo, 'tests', 'app.test.js'), 'utf8');
  const pkg = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
  const prompt = `### src/app.js\n${app}\n\n### tests/app.test.js\n${tests}\n\n### package.json\n${pkg}`;
  return {
    prompt,
    selectedFiles: [
      { path: 'src/app.js', estimatedTokens: 40 },
      { path: 'tests/app.test.js', estimatedTokens: 50 },
      { path: 'package.json', estimatedTokens: 20 },
    ],
    estimatedTokens: 110,
  };
}

export const VALIDATION_REPAIR_FIXTURE = path.join(process.cwd(), 'core', 'test', 'fixtures', 'validation-repair');

export const VALIDATION_REPAIR_TASK =
  'Implement normalizeHandle so a public handle is lowercase. Make the existing unit tests pass, review the diff, and commit locally. Do not install packages, use the network, access files outside the fixture, or push.';

export const NAIVE_HANDLE_JS = [
  'function normalizeHandle(input) {',
  '  return String(input).toLowerCase();',
  '}',
  '',
  'module.exports = { normalizeHandle };',
  '',
].join('\n');

export const FIXED_HANDLE_JS = [
  'function normalizeHandle(input) {',
  '  return String(input).trim().toLowerCase();',
  '}',
  '',
  'module.exports = { normalizeHandle };',
  '',
].join('\n');

const VALIDATION_REPAIR_FILES = [
  'package.json',
  'index.js',
  'tests/visible.test.js',
  'tests/regression.test.js',
];

export function copyValidationRepairFixture(dest: string): void {
  for (const relative of VALIDATION_REPAIR_FILES) {
    const target = path.join(dest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(VALIDATION_REPAIR_FIXTURE, relative), target);
  }
}

export function boundedValidationRepairContext(repo: string) {
  const caller = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
  const visible = fs.readFileSync(path.join(repo, 'tests', 'visible.test.js'), 'utf8');
  const pkg = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
  const prompt = `### index.js\n${caller}\n\n### tests/visible.test.js\n${visible}\n\n### package.json\n${pkg}`;
  return {
    prompt,
    selectedFiles: [
      { path: 'index.js', estimatedTokens: 30 },
      { path: 'tests/visible.test.js', estimatedTokens: 40 },
      { path: 'package.json', estimatedTokens: 20 },
    ],
    estimatedTokens: 90,
  };
}
