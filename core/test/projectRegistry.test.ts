import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjects, projectAllows, registerProject, removeProject, resolveProject } from '../domain/projectRegistry';

function repo(dir: string, name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: p, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(p, 'README.md'), name); g('add', '-A'); g('commit', '-q', '-m', `init ${name}`);
  return p;
}

describe('project registry', () => {
  let dir: string; let data: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projreg-')); data = path.join(dir, 'data'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('registers with canonical path and repository identity, and persists', () => {
    const p = registerProject(data, { name: 'Pandesh', path: repo(dir, 'pandesh'), capabilities: ['node', 'vitest'], preferredAgents: ['claude'], access: 'read', authorizedBy: 'owner' });
    expect(p.repo.identity).toMatch(/^[0-9a-f]{40}$/);
    expect(p.repo.defaultBranch).toBe('main');
    expect(p.paths[0]!.toLowerCase()).toContain('pandesh');
    expect(loadProjects(data)).toHaveLength(1);
    expect(loadProjects(data)[0]).toMatchObject({ name: 'Pandesh', preferredAgents: ['claude'], capabilities: ['node', 'vitest'], access: 'read' });
  });

  it('refuses duplicates, overlaps, missing folders, drive roots and bad names', () => {
    const a = repo(dir, 'a');
    registerProject(data, { name: 'Alpha', path: a, authorizedBy: 'o' });
    expect(() => registerProject(data, { name: 'Alpha2', path: a, authorizedBy: 'o' })).toThrow(/already authorized/);
    const nested = path.join(a, 'sub'); fs.mkdirSync(nested);
    expect(() => registerProject(data, { name: 'Nested', path: nested, authorizedBy: 'o' })).toThrow(/overlaps/);
    expect(() => registerProject(data, { name: 'Ghost', path: path.join(dir, 'nope'), authorizedBy: 'o' })).toThrow(/does not exist/);
    expect(() => registerProject(data, { name: 'x', path: a, authorizedBy: 'o' })).toThrow(/name/);
    expect(() => registerProject(data, { name: 'Root', path: path.parse(dir).root, authorizedBy: 'o' })).toThrow(/drive root/);
  });

  it('a second checkout of the same repository is only added when the owner says so', () => {
    const a = repo(dir, 'a');
    registerProject(data, { name: 'Alpha', path: a, authorizedBy: 'o' });
    const clone = path.join(dir, 'a-clone');
    spawnSync('git', ['clone', '-q', a, clone]);
    expect(() => registerProject(data, { name: 'AlphaClone', path: clone, authorizedBy: 'o' })).toThrow(/already project 'Alpha'/);
    const p = registerProject(data, { name: 'Alpha', path: clone, asAdditionalPath: true, authorizedBy: 'o' });
    expect(p.paths).toHaveLength(2);
    expect(loadProjects(data)).toHaveLength(1);
  });

  it('removal works and unknown ids are reported', () => {
    const p = registerProject(data, { name: 'Alpha', path: repo(dir, 'a'), authorizedBy: 'o' });
    expect(removeProject(data, 'nope')).toBe(false);
    expect(removeProject(data, p.id)).toBe(true);
    expect(loadProjects(data)).toEqual([]);
  });
});

describe('project resolution', () => {
  let dir: string; let data: string; let pandesh: string; let novo: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projres-')); data = path.join(dir, 'data');
    pandesh = repo(dir, 'Pandesh'); novo = repo(dir, 'Novocomedy');
    registerProject(data, { name: 'Pandesh', path: pandesh, aliases: ['the assistant'], access: 'read', authorizedBy: 'o' });
    registerProject(data, { name: 'Novocomedy', path: novo, access: 'read-write', authorizedBy: 'o' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resolve = (t: string) => resolveProject(loadProjects(data), t);

  it('the acceptance task resolves to Pandesh by path, with branch and read-only intent', () => {
    const r = resolve(`Inspect the deterministic router implementation in ${pandesh} on feat/stage-c-vertical-slice. Run its existing tests and report defects. Do not modify files.`);
    expect(r).toMatchObject({ status: 'resolved', via: 'path', ref: 'feat/stage-c-vertical-slice', readOnlyRequested: true });
    if (r.status === 'resolved') expect(r.project.name).toBe('Pandesh');
  });

  it('a Windows short (8.3) spelling of a registered path resolves to the same project, also for a file inside it', () => {
    // CI 2026-11-23: GitHub's Windows runner temp folder is C:\Users\RUNNER~1\...; the registry stores the long real path.
    if (process.platform !== 'win32') return;
    const longDir = path.join(os.tmpdir(), `PandeshShortNameCheck-${process.pid}`, 'LongProjectFolderName');
    fs.mkdirSync(longDir, { recursive: true });
    try {
      const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${longDir}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
      if (!short || short.toLowerCase() === longDir.toLowerCase()) return; // this volume makes no short names: nothing to check
      const data2 = path.join(dir, 'data-short');
      registerProject(data2, { name: 'ShortCheck', path: repo(path.dirname(longDir), path.basename(longDir)), access: 'read', authorizedBy: 'owner' });
      for (const named of [short, path.join(short, 'README.md'), path.join(short, 'src', 'not-yet.js')]) {
        const r = resolveProject(loadProjects(data2), `Inspect ${named} and report.`);
        expect(r, named).toMatchObject({ status: 'resolved', via: 'path' });
      }
    } finally { fs.rmSync(path.dirname(longDir), { recursive: true, force: true }); }
  });

  it('a name resolves to the project it names, never to another open workspace', () => {
    const r = resolve("Check Pandesh's deterministic router");
    expect(r).toMatchObject({ status: 'resolved', via: 'name' });
    if (r.status === 'resolved') expect(r.project.name).toBe('Pandesh');
    expect(resolve('look at the assistant code')).toMatchObject({ status: 'resolved' });
  });

  it('two projects named in one task is ambiguous and asks', () => {
    const r = resolve('Compare Pandesh and Novocomedy routers');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.question).toMatch(/Which project/);
    expect(resolve(`diff ${pandesh}\\README.md against ${novo}\\README.md`).status).toBe('ambiguous');
  });

  it('a path outside every authorized project is refused with a question, not searched or registered', () => {
    const r = resolve('Inspect C:\\Somewhere\\Else\\thing and run tests');
    expect(r).toMatchObject({ status: 'unauthorized' });
    expect(loadProjects(data)).toHaveLength(2);
  });

  it('a task that names no project resolves to none (caller keeps its isolated behaviour)', () => {
    expect(resolve('summarize my day')).toEqual({ status: 'none' });
    expect(resolve('PandeshXYZ is not Pandesh-like')).toEqual({ status: 'none' });
  });

  describe('a project named outright (live failure ptask_9902d8ad, 2026-11-23)', () => {
    /** The opening of the live instruction, on a PC where "Pandesh" was not registered and "CalcDemo" was. */
    const LIVE = 'CODE CHANGE IN THE REGISTERED PROJECT NAMED "Pandesh" (not CalcDemo). Implement the approved UI-only navigation simplification in a NEW ISOLATED WORKTREE AND FEATURE BRANCH CREATED OFF main.';
    let only: string;
    beforeEach(() => {
      only = path.join(dir, 'data-calc');
      registerProject(only, { name: 'CalcDemo', path: repo(dir, 'CalcDemo'), access: 'read-write', authorizedBy: 'o' });
    });

    it('the live task is not registered here: it never resolves to CalcDemo', () => {
      const r = resolveProject(loadProjects(only), LIVE);
      expect(r).toMatchObject({ status: 'unregistered', name: 'Pandesh' });
      if (r.status === 'unregistered') expect(r.question).toMatch(/no other project was used in its place/);
      // An empty registry gives the same answer, not "none".
      expect(resolveProject([], LIVE)).toMatchObject({ status: 'unregistered', name: 'Pandesh' });
    });

    it('with Pandesh registered, the same task resolves to exactly Pandesh, on main', () => {
      registerProject(only, { name: 'Pandesh', path: pandesh, access: 'read-write', authorizedBy: 'o' });
      const r = resolveProject(loadProjects(only), LIVE);
      expect(r).toMatchObject({ status: 'resolved', via: 'name', ref: 'main' });
      if (r.status === 'resolved') expect(r.project.name).toBe('Pandesh');
    });

    it('the explicit name wins over other names mentioned, in every declared form, also by alias', () => {
      for (const t of [
        'In the project named "Novocomedy", port the router we wrote for Pandesh.',
        'project called Novocomedy: port the Pandesh router',
        "Use the registered project 'novocomedy' and compare with Pandesh later.",
        'Port the Pandesh router.\nProject: Novocomedy\nKeep the tests green.',
      ]) {
        const r = resolve(t);
        expect(r, t).toMatchObject({ status: 'resolved' });
        if (r.status === 'resolved') expect(r.project.name, t).toBe('Novocomedy');
      }
      const a = resolve('Fix the router in the project named "the assistant"');
      if (a.status === 'resolved') expect(a.project.name).toBe('Pandesh'); else throw new Error(a.status);
    });

    it('a name the task rules out is not a reference to that project', () => {
      for (const t of ['Fix the router in Pandesh, not Novocomedy', 'Fix the router in Pandesh rather than the Novocomedy project', 'Fix the Pandesh router instead of "Novocomedy"']) {
        const r = resolve(t);
        expect(r, t).toMatchObject({ status: 'resolved' });
        if (r.status === 'resolved') expect(r.project.name, t).toBe('Pandesh');
      }
      // Ruled out and nothing else named: no project, never the ruled-out one.
      expect(resolve('Fix the router, but not Novocomedy')).toEqual({ status: 'none' });
      // "do not modify X" is a read-only request about X, not a ruling out.
      expect(resolve('Check the router; do not modify Pandesh')).toMatchObject({ status: 'resolved', readOnlyRequested: true });
    });

    it('an explicit name that disagrees with a path asks; an unregistered path is still refused', () => {
      expect(resolve(`In the project named "Pandesh", fix ${novo}\\README.md`).status).toBe('ambiguous');
      expect(resolve('In the project named "Pandesh", fix C:\\Somewhere\\Else\\x.ts').status).toBe('unauthorized');
      expect(resolve(`In the project named "Pandesh", fix ${pandesh}\\README.md`)).toMatchObject({ status: 'resolved', via: 'path' });
    });

    it('passing uses of the word project declare nothing', () => {
      expect(resolve('Start a project named after my grandmother').status).toBe('none');
      expect(resolve('Resolve the named registered Pandesh project and fail closed')).toMatchObject({ status: 'resolved', via: 'name' });
    });
  });

  it('read-only projects only allow read-only work', () => {
    const [p] = loadProjects(data);
    expect(projectAllows(p!, true)).toEqual({ ok: true });
    expect(projectAllows(p!, false)).toMatchObject({ ok: false });
    expect(projectAllows(loadProjects(data)[1]!, false)).toEqual({ ok: true });
  });
});
