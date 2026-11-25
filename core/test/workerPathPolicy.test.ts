import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workerPrompt, permissionDecision, type DevStorySpec } from '../runtime/kandev/devStories';
import type { KandevPermission } from '../runtime/kandev/kandevClient';

// Live b188g 2026-11-23: a mission worker built five Read paths from its Claude memory folder's name
// (D:\PandeshB188cAccept-profile-panda-workspaces-…-code\src\add.js), all outside its worktree; each one interrupted the owner.
let dir: string; let worktree: string; let outsideFile: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpath-'));
  worktree = path.join(dir, 'kandev-tasks', 'calcdemo-3-3', 'repo'); fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'add.js'), 'x');
  outsideFile = path.join(dir, 'private-copy', 'src', 'add.js'); fs.mkdirSync(path.dirname(outsideFile), { recursive: true }); fs.writeFileSync(outsideFile, 'x');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const perm = (action: KandevPermission['action']): KandevPermission => ({ pending_id: 'p', request_id: 'r', session_id: 's', task_id: 't', action });
const base: DevStorySpec = { kind: 'kkd-dev-story', repoPath: 'x', baseBranch: 'main', integrationBranch: 'panda/mission-x', verify: ['git', 'status', '--porcelain'], agent: 'claude' };
const codeCopy: DevStorySpec = { ...base, codeCopy: { projectName: 'CalcDemo', sourcePath: 'D:\\owner\\calc', ref: 'main', sourceHead: 'h', sourceStatusSha: 's', step: 3 } };
const mangled = () => path.join(path.parse(dir).root, 'PandeshB188cAccept-profile-panda-workspaces-ptask-3b30d620-code', 'src', 'add.js');

describe('worker paths outside the worktree', () => {
  it('a code-change worker\'s read of a non-existent outside path is refused at once, with directions, not put to the owner', () => {
    const d = permissionDecision(perm({ type: 'file_read', path: mangled() }), worktree, codeCopy);
    expect(d).toMatchObject({ allow: false, reject: true });
    expect(d.reason).toContain(`Your working directory is ${worktree}`);
    expect(d.reason).toMatch(/does not exist.*Use paths relative to it.*memory or settings instructions is not the project/s);
  });

  it('in a private copy, any outside path is refused (existing or not; read, write, edit or delete), the worktree itself is not', () => {
    for (const type of ['file_read', 'file_write', 'file_edit', 'file_delete'] as const) {
      expect(permissionDecision(perm({ type, path: outsideFile }), worktree, codeCopy), type).toMatchObject({ allow: false, reject: true });
    }
    expect(permissionDecision(perm({ type: 'file_write', path: path.join(worktree, 'src', 'index.js') }), worktree, codeCopy)).toMatchObject({ allow: true });
    expect(permissionDecision(perm({ type: 'file_edit', path: 'src/add.js' }), worktree, codeCopy).reject).toBeFalsy(); // relative = inside
    expect(permissionDecision(perm({ type: 'file_read', path: path.join(worktree, '..', '..', 'escape.js') }), worktree, codeCopy)).toMatchObject({ reject: true });
  });

  it('outside a private copy, only a path that does not exist is refused automatically; a real outside path still goes to the owner', () => {
    expect(permissionDecision(perm({ type: 'file_read', path: mangled() }), worktree, base)).toMatchObject({ allow: false, reject: true });
    const real = permissionDecision(perm({ type: 'file_write', path: outsideFile }), worktree, base);
    expect(real.allow).toBe(false); expect(real.reject).toBeFalsy();
  });

  it('the code-change prompt tells the worker to use its working directory, not its memory folder', () => {
    const prompt = workerPrompt({ title: 'CalcDemo 3/3: Add src/index.js', description: 'x' } as never, codeCopy);
    expect(prompt).toMatch(/RELATIVE to your working directory/);
    expect(prompt).toMatch(/memory or settings instructions is NOT this project/);
  });
});
