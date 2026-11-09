/**
 * Gaps 1, 4, 5 (production pass): unfinished requested steps, unworkable suggested commands, packages that do not load.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importedTopModules, suggestedCommandProblems, thirdPartyImportProblems, unfinishedRequestedSteps } from '../runtime/taskCompletion';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-complete-'));
const run = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error };
};

describe('gap 1: finish what was asked', () => {
  const ask = 'Build a small dashboard, verify that it works, save it and open it for me.';
  it('F13g: written but not opened or verified, and the fix handed back to the user', () => {
    const steps = unfinishedRequestedSteps(ask, 'You should correct line 92 to read 21.2 GB.', ['write_file'], true);
    expect(steps).toHaveLength(3);
  });
  it('nothing missing when it was opened, read back and not handed back', () => {
    expect(unfinishedRequestedSteps(ask, 'Done; it is open on your screen.', ['write_file', 'read_file', 'open_local_file'], true)).toEqual([]);
  });
  it('a plain question is never "unfinished"', () => {
    expect(unfinishedRequestedSteps('How much free RAM do I have?', '35 GB free.', ['system_hardware_telemetry'], true)).toEqual([]);
  });
});

describe('gap 4: suggested commands are checked against the folder', () => {
  it('T14: "python -m board.cli" where board.py is a module', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'board.py'), '');
    fs.writeFileSync(path.join(dir, 'cli.py'), '');
    const p = suggestedCommandProblems('Try the CLI: `python -m board.cli` in that folder.', dir);
    expect(p[0]).toMatch(/board\.py is a module, not a package/);
    expect(suggestedCommandProblems('Run `python cli.py`.', dir)).toEqual([]);
    expect(suggestedCommandProblems('Run `python app.py`.', dir)[0]).toMatch(/app\.py does not exist/);
  });
  it('npm scripts must exist', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(suggestedCommandProblems('Use `npm run test` then `npm run serve`.', dir)).toEqual(['`npm run serve` will not work: package.json has no "serve" script']);
  });
});

describe('gap 5: packages a program needs must load on this PC', () => {
  it('finds third-party imports, skipping local modules and relative imports', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'board.py'), '');
    expect(importedTopModules('import os, json\nfrom flask import Flask\nfrom board import TaskBoard\nfrom .x import y\n', dir)).toEqual(['os', 'json', 'flask']);
  });
  it('reports a package that does not import, and passes the standard library', () => {
    const dir = tmp();
    const file = path.join(dir, 'app.py');
    expect(thirdPartyImportProblems(file, 'import os\nimport json\n', run)).toEqual([]);
    const missing = thirdPartyImportProblems(file, 'import pandesh_surely_not_installed_pkg\n', run);
    expect(missing[0]).toMatch(/pandesh_surely_not_installed_pkg: ModuleNotFoundError/);
  });
});

import { expectedOutputFiles } from '../runtime/taskCompletion';
describe('files a hand-off must produce (rwRun2 T07: "Node.js" taken for an output)', () => {
  it('ignores technology names and files that are only mentioned', () => {
    expect(expectedOutputFiles('Find the current stable Node.js release using official sources.')).toEqual([]);
    expect(expectedOutputFiles('Read invoices.csv and tell me the total.')).toEqual([]);
  });
  it('keeps files the brief asks to create, write or save', () => {
    expect(expectedOutputFiles('Build a single-page HTML dashboard at D:\\w\\system_dashboard.html with React.js-free code.')).toEqual(['system_dashboard.html']);
    expect(expectedOutputFiles('Write report.md and save totals.csv.')).toEqual(['report.md', 'totals.csv']);
  });
});

import { inventedDates } from '../runtime/taskCompletion';
describe('memory keeps the user\'s words (rwRun2 T09: "Monday" stored as "Monday, Nov 9")', () => {
  it('flags a date the user never gave', () => {
    expect(inventedDates('Review meeting on Thursday, Nov 12 at 3 PM.', 'The meeting moved to Thursday at 3 PM.')).toEqual(['Nov 12']);
    expect(inventedDates('Meeting on 2026-11-12', 'Move it to Thursday')).toEqual(['2026-11-12']);
  });
  it('allows dates the user said, in any common form, and values with no date', () => {
    expect(inventedDates('Meeting on November 12th at 3 PM', 'Move it to November 12th at 3 PM')).toEqual([]);
    expect(inventedDates('Review meeting on Thursday at 3 PM', 'Thursday at 3 PM')).toEqual([]);
  });
});
