/**
 * P1 (Build 161 audit): an agent's folder scope must hold for every path argument a reachable tool takes.
 *
 * checkPathArguments only looked at a fixed list of argument names. The real parameter names of tools specialists can
 * reach — list_directory/find_duplicate_files (dirPath), search_files (searchRoots), get_project_context (projectPath),
 * run_checks/delegate_to_opencode (workspacePath), search_recent_projects (searchRoot), print (documentPath) — were not on
 * it, and a drive-relative path ("C:secret.txt") or a bare ".." did not "look like" a path. Such calls skipped the scope
 * gate, so the agent's hard boundary (this conversation's folder only) became a read-permission card instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_AGENTS, checkPathArguments, chiefDelegationScope, deriveScope } from '../domain/agents';

let root: string;
const def = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-path-scope-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('agent folder scope covers every path argument', () => {
  const outside = path.parse(os.tmpdir()).root; // the drive root: never inside the conversation folder

  it('refuses paths outside the conversation folder under the tools\' own parameter names', () => {
    const coding = deriveScope(def('coding'), root, chiefDelegationScope(root), null);
    for (const args of [
      { dirPath: outside },
      { searchRoots: [root, outside] },
      { searchRoot: outside },
      { projectPath: path.join(root, '..') },
      { workspacePath: outside },
      { documentPath: path.join(outside, 'secret.pdf') },
      { repoPath: outside },
      { file_path: path.join(outside, 'x.txt') },
    ]) {
      expect(checkPathArguments(coding, args).allowed, JSON.stringify(args)).toBe(false);
    }
  });

  it('refuses a drive-relative path and a bare parent reference', () => {
    const coding = deriveScope(def('coding'), root, chiefDelegationScope(root), null);
    const otherDrive = /^c:/i.test(root) ? 'D:secret.txt' : 'C:secret.txt';
    expect(checkPathArguments(coding, { filePath: otherDrive }).allowed).toBe(false);
    expect(checkPathArguments(coding, { dirPath: '..' }).allowed).toBe(false);
  });

  it('still allows what is inside the folder, and does not treat a Task Scheduler folder as a file path', () => {
    const coding = deriveScope(def('coding'), root, chiefDelegationScope(root), null);
    expect(checkPathArguments(coding, { filePath: 'notes.txt' }).allowed).toBe(true);
    expect(checkPathArguments(coding, { dirPath: path.join('src', 'lib') }).allowed).toBe(true);
    expect(checkPathArguments(coding, { dirPath: '.' }).allowed).toBe(true);
    expect(checkPathArguments(coding, { searchRoots: [root, path.join(root, 'src')] }).allowed).toBe(true);
    expect(checkPathArguments(coding, { workspacePath: root }).allowed).toBe(true);
    expect(checkPathArguments(coding, { taskPath: '\\' }).allowed).toBe(true);
  });

  it('an agent without any folder (Research) is refused a document path under any parameter name', () => {
    const research = deriveScope(def('research'), root, chiefDelegationScope(root), null);
    expect(checkPathArguments(research, { documentPath: path.join(root, 'cv.pdf') }).allowed).toBe(false);
    expect(checkPathArguments(research, { dirPath: root }).allowed).toBe(false);
  });

  it.runIf(process.platform === 'win32')('holds where a path really lands: a junction inside the folder that points outside is refused; another spelling of an inside path is allowed', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-path-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'private.txt'), 'x');
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
      const coding = deriveScope(def('coding'), root, chiefDelegationScope(root), null);
      expect(checkPathArguments(coding, { filePath: path.join(root, 'link', 'private.txt') }).allowed).toBe(false);
      expect(checkPathArguments(coding, { dirPath: 'link' }).allowed).toBe(false);
      expect(checkPathArguments(coding, { filePath: path.join(root, 'link', 'not-yet-there.txt') }).allowed).toBe(false);
      fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
      expect(checkPathArguments(coding, { filePath: path.join(root, 'notes.txt').toUpperCase() }).allowed).toBe(true);
    } finally {
      fs.rmSync(path.join(root, 'link'), { force: true, recursive: false });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
