import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { censusProjects, computeRepositoryFacts, planRepositoryFacts, renderFactsPacket, ProjectAssigner } from '../../repository/RepositoryFacts';
import { clarificationPacket, hasFileDeixis, hasProjectDeixis, matchNamedProject } from '../../repository/ReferentResolution';
import { RepoFastPath } from '../../repository/RepoFastPath';

function makeTree(root: string): void {
  const write = (rel: string, content = 'x\n') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  // big: a Node project with a nested package that is its own project; small: a Python project; plus loose root files.
  write('big/package.json', JSON.stringify({ name: 'big' }));
  for (let i = 0; i < 12; i++) write(`big/src/f${i}.ts`, 'export const a = 1;\n'.repeat(50));
  write('big/src/f0.test.ts', 'test\n');
  write('big/tests/t1.ts');
  write('big/packages/inner/package.json', JSON.stringify({ name: 'inner' }));
  write('big/packages/inner/index.ts');
  write('big/packages/inner/lib.ts');
  write('small/pyproject.toml', '[project]\nname = "small"\n');
  write('small/a.py');
  write('small/b.py');
  write('small/c.py');
  write('small/test_a.py');
  write('big/node_modules/dep/index.js', 'ignored');
  write('notes.txt');
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
}

describe('planRepositoryFacts', () => {
  it('recognises the live-UAT questions and the spec examples', () => {
    expect(planRepositoryFacts('Which is the largest project?')?.kind).toBe('project_size_comparison');
    expect(planRepositoryFacts('Now count files in each project separately and report')?.kind).toBe('project_file_counts');
    expect(planRepositoryFacts('count files in each project')?.kind).toBe('project_file_counts');
    expect(planRepositoryFacts('which project is largest')?.kind).toBe('project_size_comparison');
    expect(planRepositoryFacts('which project has the most files')?.kind).toBe('project_size_comparison');
    expect(planRepositoryFacts('how many tests are there in this repo')?.kind).toBe('test_file_counts');
    expect(planRepositoryFacts('how many tests?')?.kind).toBe('test_file_counts');
    expect(planRepositoryFacts('what changed')?.kind).toBe('git_change_summary');
    expect(planRepositoryFacts('how many files changed?')?.kind).toBe('git_change_summary');
  });

  it('extracts the language for extension counts', () => {
    expect(planRepositoryFacts('which project has most Python files')).toMatchObject({ kind: 'project_extension_counts', extensions: ['py'] });
    expect(planRepositoryFacts('how many TypeScript files in each project')).toMatchObject({ kind: 'project_extension_counts', extensions: ['ts', 'tsx'] });
    expect(planRepositoryFacts('count .md files per project')).toMatchObject({ kind: 'project_extension_counts', extensions: ['md'] });
  });

  it('leaves ordinary questions alone', () => {
    for (const q of [
      'explain this project', 'what does the router do?', 'how many tests should I write for a login form?', 'how many tests passed?',
      'what changed in src/foo.ts', 'what is the largest project in the world', 'list the projects in this folder', 'fix the bug in api.py',
      'is the readme up to date?', 'what is 2 + 2',
    ]) expect(planRepositoryFacts(q), q).toBeUndefined();
  });
});

describe('ProjectAssigner', () => {
  it('assigns each file to the deepest matching project root, in one pass', () => {
    const assigner = new ProjectAssigner([
      { path: 'big', kinds: ['Node'], confidence: 'manifest' },
      { path: 'big/packages/inner', kinds: ['Node'], confidence: 'manifest' },
    ]);
    for (const file of ['big/a.ts', 'big/src/b.ts', 'big/packages/inner/c.ts', 'big/packages/other/d.ts', 'loose.txt']) assigner.add(file);
    const by = Object.fromEntries(assigner.projects.map(p => [p.path, p.files]));
    expect(by).toEqual({ big: 3, 'big/packages/inner': 1 });
    expect(assigner.outside.files).toBe(1);
  });

  it('puts everything under a root project when the workspace root is itself a project', () => {
    const assigner = new ProjectAssigner([{ path: '.', kinds: ['Node'], confidence: 'manifest' }, { path: 'sub', kinds: ['Node'], confidence: 'manifest' }]);
    assigner.add('a.ts');
    assigner.add('sub/b.ts');
    expect(Object.fromEntries(assigner.projects.map(p => [p.path, p.files]))).toEqual({ '.': 1, sub: 1 });
    expect(assigner.outside.files).toBe(0);
  });
});

describe('repository facts in a Git workspace', () => {
  let root = '';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-git-'));
    makeTree(root);
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('counts tracked files per project, nesting honoured, generated trees excluded', async () => {
    const facts = await computeRepositoryFacts(root, { kind: 'project_file_counts' }, { maxChars: 20_000 });
    expect(facts!.source).toBe('git');
    const by = Object.fromEntries(facts!.projects.map(p => [p.path, p.files]));
    // big: package.json + 12 src + f0.test + t1 = 15 (its nested package is NOT double counted); inner: 3; small: 6
    expect(by['big']).toBe(15);
    expect(by['big/packages/inner']).toBe(3);
    expect(by['small']).toBe(5);
    expect(facts!.outside.files).toBe(2); // notes.txt, .gitignore
    expect(facts!.answer).toContain('| `big` | 15 |');
    expect(facts!.summary.outcome).toBe('completed');
    expect(facts!.summary.recognised).toBe(3);
  });

  it('defines "largest": states the metric and reports all three, and establishes the winner', async () => {
    const facts = await computeRepositoryFacts(root, { kind: 'project_size_comparison' }, { maxChars: 20_000 });
    expect(facts!.headline).toMatch(/By tracked file count, `big` is the largest project \(15 files/);
    expect(facts!.bytesKnown).toBe(true);
    expect(facts!.answer).toMatch(/Files \| Source files \| Tracked bytes|\| Project \| Files \| Source files \| Tracked bytes \|/);
    expect(facts!.answer).toContain('"Largest" has no single meaning');
    expect(facts!.summary.established).toEqual({ path: 'big', reason: 'largest project by tracked file count' });
  });

  it('counts a language per project and names the leader', async () => {
    const facts = await computeRepositoryFacts(root, { kind: 'project_extension_counts', extensions: ['py'], label: 'Python' }, { maxChars: 20_000 });
    expect(facts!.headline).toMatch(/`small` has the most Python files \(4\)/);
  });

  it('counts test files by name and location', async () => {
    const facts = await computeRepositoryFacts(root, { kind: 'test_file_counts' }, { maxChars: 20_000 });
    const by = Object.fromEntries(facts!.projects.map(p => [p.path, p.testFiles]));
    expect(by['big']).toBe(2);
    expect(by['small']).toBe(1);
    expect(facts!.headline).toContain('test FILES');
  });

  it('summarises the working tree: modified, untracked, deleted, per project', async () => {
    fs.appendFileSync(path.join(root, 'small/a.py'), 'more\n');
    fs.writeFileSync(path.join(root, 'small/new.py'), 'n\n');
    fs.rmSync(path.join(root, 'notes.txt'));
    const facts = await computeRepositoryFacts(root, { kind: 'git_change_summary' }, { maxChars: 20_000 });
    expect(facts!.changes!.total).toBe(3);
    expect(facts!.changes!.byStatus).toEqual({ modified: 1, untracked: 1, deleted: 1 });
    expect(facts!.answer).toContain('| `small` | 2 |');
    git(root, 'checkout', '-q', '--', 'notes.txt', 'small/a.py');
    fs.rmSync(path.join(root, 'small/new.py'));
  });

  it('truncates a long table honestly instead of dropping rows silently', async () => {
    const wide = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-wide-'));
    try {
      for (let i = 0; i < 80; i++) {
        fs.mkdirSync(path.join(wide, `proj${String(i).padStart(3, '0')}`), { recursive: true });
        fs.writeFileSync(path.join(wide, `proj${String(i).padStart(3, '0')}`, 'package.json'), '{}');
        fs.writeFileSync(path.join(wide, `proj${String(i).padStart(3, '0')}`, 'a.ts'), 'x');
      }
      const facts = await computeRepositoryFacts(wide, { kind: 'project_file_counts' }, { maxChars: 2_500 });
      expect(facts!.answer).toMatch(/…and \d+ smaller projects? \(\d+ files? in total\) not listed here/);
    } finally { fs.rmSync(wide, { recursive: true, force: true }); }
  });

  it('builds a packet that forbids "no tools" refusals and manual commands', async () => {
    const facts = await computeRepositoryFacts(root, { kind: 'project_file_counts' }, { maxChars: 20_000 });
    const packet = renderFactsPacket(facts!, 'demo');
    expect(packet).toMatch(/Do NOT say you lack tools/);
    expect(packet).toMatch(/do NOT tell the user to run any command/);
    expect(packet).toContain('--- computed answer ---');
  });
});

describe('repository facts without Git (bounded filesystem enumeration)', () => {
  let root = '';
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-fs-')); makeTree(root); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('counts by walking, skipping node_modules, and omits bytes it cannot cheaply know', async () => {
    const census = await censusProjects(root, true);
    expect(census!.source).toBe('filesystem');
    expect(census!.bytesKnown).toBe(false);
    const facts = await computeRepositoryFacts(root, { kind: 'project_size_comparison' }, { maxChars: 20_000 }, census);
    expect(facts!.headline).toMatch(/By tracked file count, `big`/);
    expect(facts!.answer).not.toContain('Tracked bytes |');
    expect(facts!.projects.find(p => p.path === 'big')!.files).toBe(15);
  });

  it('reports a non-Git workspace for change summaries instead of inventing one', async () => {
    const facts = await computeRepositoryFacts(root, { kind: 'git_change_summary' }, { maxChars: 20_000 });
    expect(facts!.summary.outcome).toBe('blocked');
    expect(facts!.answer).toMatch(/not a Git repository/);
  });
});

describe('referent safety', () => {
  it('detects deictic project and file references', () => {
    expect(hasProjectDeixis('explain for this project')).toBe(true);
    expect(hasProjectDeixis('summarise that app')).toBe(true);
    expect(hasProjectDeixis('explain the router')).toBe(false);
    expect(hasFileDeixis('what does that file do')).toBe(true);
    expect(hasFileDeixis('what does the router do')).toBe(false);
  });

  it('matches only a project the message itself names', () => {
    const paths = ['apps/jarvis', 'apps/expenses', 'work/jarvis', 'utils/scraper', '.'];
    expect(matchNamedProject('explain apps/jarvis', paths)).toBe('apps/jarvis');
    expect(matchNamedProject('explain the scraper project', paths)).toBe('utils/scraper');
    expect(matchNamedProject('explain jarvis', paths)).toBeUndefined(); // two projects share the name: ambiguous
    expect(matchNamedProject('explain this project', paths)).toBeUndefined();
  });

  it('writes a clarification that forbids guessing', () => {
    const packet = clarificationPacket({ what: 'project', workspaceName: 'Projects', projectCount: 139, candidates: ['apps/a', 'apps/b'] });
    expect(packet).toMatch(/Do NOT choose a project/);
    expect(packet).toContain('139 recognised projects');
    expect(packet).toContain('`apps/a`');
  });
});

describe('RepoFastPath: facts first, referents grounded', () => {
  let root = '';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-fast-'));
    makeTree(root);
    fs.writeFileSync(path.join(root, 'small/README.md'), '# Small\n\nA small Python utility for tallying things.\n');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('answers "which is the largest project" from host facts, with no files read', async () => {
    const result = await new RepoFastPath(root).repoQuery('Which is the largest project?', { maxChars: 18_000 });
    expect(result!.type).toBe('facts');
    expect(result!.files).toEqual([]);
    expect(result!.hostFacts).toMatchObject({ kind: 'project_size_comparison', outcome: 'completed', computing: 'Counting tracked files by project' });
    expect(result!.hostFacts!.measured).toMatch(/projects? measured/);
    expect(result!.referent?.path).toBe('big');
    expect(result!.prompt).toContain('By tracked file count, `big`');
  });

  it('does not invent a referent: "explain this project" with nothing established asks which one', async () => {
    const result = await new RepoFastPath(root).repoQuery('explain for this project', { maxChars: 18_000 });
    expect(result!.type).toBe('clarify');
    expect(result!.hostFacts).toMatchObject({ kind: 'clarify_referent', outcome: 'needs_input' });
    expect(result!.files).toEqual([]);
    expect(result!.prompt).toMatch(/Do NOT choose a project/);
  });

  it('uses only a project the conversation established, and covers only that project', async () => {
    const result = await new RepoFastPath(root).repoQuery('explain for this project', { maxChars: 18_000, establishedProject: 'small' });
    expect(result!.type).toBe('overview');
    expect(result!.referent).toEqual({ path: 'small', reason: 'established earlier in this conversation' });
    expect(result!.files.map(f => f.path)).toEqual(expect.arrayContaining(['small/README.md']));
    expect(result!.files.every(f => f.path.startsWith('small/'))).toBe(true);
    expect(result!.prompt).not.toContain('export const a');
  });

  it('accepts a project the user names in the same message', async () => {
    const result = await new RepoFastPath(root).repoQuery('explain this project, small', { maxChars: 18_000 });
    expect(result!.referent).toEqual({ path: 'small', reason: 'named by the user' });
  });

  it('keeps ordinary retrieval for questions that are not facts and not deictic', async () => {
    const result = await new RepoFastPath(root).repoQuery('Is the readme up to date?', { maxChars: 18_000 });
    expect(result?.type).not.toBe('facts');
    expect(result?.type).not.toBe('clarify');
  });
});
