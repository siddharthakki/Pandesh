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

  it('read-only projects only allow read-only work', () => {
    const [p] = loadProjects(data);
    expect(projectAllows(p!, true)).toEqual({ ok: true });
    expect(projectAllows(p!, false)).toMatchObject({ ok: false });
    expect(projectAllows(loadProjects(data)[1]!, false)).toEqual({ ok: true });
  });
});
