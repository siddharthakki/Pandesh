import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { suggestedCommandProblems } from '../runtime/taskCompletion';
import { commandRunDirs } from '../runtime/piAgentEngine';

// Live demo 2026-11-09: the Coding agent built tip-calc/tip.py and `python tip.py 84.50 15 3` exited 0 in tip-calc/, but
// Core appended "tip.py does not exist in the folder" because it only checked the workspace root.
let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-cwd-'));
  fs.mkdirSync(path.join(ws, 'tip-calc'));
  fs.writeFileSync(path.join(ws, 'tip-calc', 'tip.py'), 'print(1)\n');
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('suggested-command check uses the folder the command belongs to', () => {
  const reply = 'Run it with `python tip.py 84.50 15 3`.';

  it('accepts a command that really ran in a sub-folder this turn', () => {
    const dirs = commandRunDirs([{ tool: 'run_checks', status: 'completed', args: { command: 'python tip.py 84.50 15 3', workspacePath: 'tip-calc' } }], ws);
    expect(suggestedCommandProblems(reply, ws, dirs)).toEqual([]);
  });

  it('accepts a command whose folder the reply names', () => {
    const named = `${reply} It lives in ${path.join(ws, 'tip-calc')}.`;
    expect(suggestedCommandProblems(named, ws)).toEqual([]);
  });

  it('still flags a script that exists nowhere', () => {
    expect(suggestedCommandProblems('Run `python missing.py`.', ws, [path.join(ws, 'tip-calc')])).toEqual(['`python missing.py` will not work: missing.py does not exist in the folder']);
  });

  it('ignores failed runs when deciding where a command ran', () => {
    expect(commandRunDirs([{ tool: 'run_checks', status: 'failed', args: { workspacePath: 'tip-calc' } }], ws)).toEqual([]);
  });
});
