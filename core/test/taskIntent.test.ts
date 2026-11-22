import { describe, expect, it } from 'vitest';
import { deriveTaskIntent, parseDeclaredIntent, resolveTaskIntent, withoutScopedProhibitions } from '../domain/taskIntent';

/** The exact instruction of the failed live task ptask_c00d7741-8100-4de4-a25d-ff092135e10e (2026-11-22). */
const LIVE_FAILURE = "In the REGISTERED CalcDemo source code project (D:\\PandeshP0Dev\\a5-calc), implement a small divide(a,b) function in its own module with tests for normal division and explicit division-by-zero error, preserving existing add/multiply features. This is an isolated development CODING task. Resolve the named registered CalcDemo project, and FAIL CLOSED if it cannot be found; never use an empty starter repo or any other project. Use the authorized isolated private copy/worktree; do not edit the owner checkout, push, merge, deploy or install. Run focused tests and provide a real diff for review. Require the standard owner approval before Claude Code receives any task details, and the owner-only review approval before delivering changes. This is also an acceptance test of the V2 approval card: do not bypass it; if approval cannot be displayed or expires, report that failure instead of proceeding.";

describe('task intent', () => {
  it('the live failure is a code change, not an inspection', () => {
    expect(deriveTaskIntent(LIVE_FAILURE)).toMatchObject({ kind: 'code', conflict: null });
  });

  it('a prohibition aimed at the owner checkout, push or merge does not make the work read-only', () => {
    expect(deriveTaskIntent('Add a multiply function to src/math.js. Do not edit the owner checkout.').kind).toBe('code');
    expect(deriveTaskIntent('Fix the bug in add(). Do not push or merge anything.').kind).toBe('code');
    expect(deriveTaskIntent('Implement divide; never touch the main branch or the original repository').kind).toBe('code');
    expect(withoutScopedProhibitions('Implement it; do not edit the owner checkout, push or merge')).not.toMatch(/edit/);
  });

  it('a prohibition that covers the work itself stays read-only', () => {
    expect(deriveTaskIntent('Explain how add() works. Do not modify any files.').kind).toBe('inspect');
    expect(deriveTaskIntent('Inspect the Calc repo read-only and run its tests; report defects, do not fix them.').kind).toBe('inspect');
    expect(deriveTaskIntent('Review the code; do not change any files or push.')).toMatchObject({ kind: 'inspect', conflict: null });
  });

  it('a change AND read-only is a contradiction to resolve, never a silent inspection', () => {
    const i = deriveTaskIntent('Implement divide(a, b) with tests. This is read-only.');
    expect(i.conflict).toMatch(/both asks for a code change and says/);
  });

  it('answers, research and operations', () => {
    expect(deriveTaskIntent('Say hello and name the agent you are.').kind).toBe('answer');
    expect(deriveTaskIntent('Research the best SQLite backup options for Windows.').kind).toBe('research');
    expect(deriveTaskIntent('Restart the Ollama service.').kind).toBe('operation');
  });

  it('a declaration narrows but never widens, and code + read-only text is a conflict', () => {
    expect(resolveTaskIntent('Fix the bug in add()', 'inspect')).toMatchObject({ kind: 'inspect', source: 'declared', conflict: null });
    expect(resolveTaskIntent('Add divide(a,b) with tests', 'code')).toMatchObject({ kind: 'code', source: 'declared' });
    expect(resolveTaskIntent('Look at add.js, read-only please', 'code').conflict).toMatch(/sent as a code change/);
    expect(resolveTaskIntent(LIVE_FAILURE, 'code')).toMatchObject({ kind: 'code', conflict: null });
  });

  it('declared names', () => {
    expect(parseDeclaredIntent('code_change')).toBe('code');
    expect(parseDeclaredIntent('read-only')).toBe('inspect');
    expect(parseDeclaredIntent('whatever')).toBeNull();
    expect(parseDeclaredIntent(undefined)).toBeNull();
  });
});
