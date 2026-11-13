/**
 * M1: the deliverable ledger decides what is missing from the request and the file system, never from the model's reply.
 * The cases are the audit's S21 (six analyses + index that links to the missing ones) and its neighbours.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deliverableLedger, localLinkTargets, namedOutputFiles, perInputRequirement } from '../runtime/deliverableLedger';

let ws: string; let start: number;
const put = (rel: string, text = 'x') => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-ledger-')); start = Date.now(); });
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

const S21 = 'Analyze each of the six files in the inbox folder. For every source file write analysis/<source name>.analysis.md (3 to 5 lines), and also write analysis/index.md that lists and links all six analyses.';

describe('named output files', () => {
  it('takes files after an output verb and ignores inputs', () => {
    expect(namedOutputFiles('Read the three invoice files in the invoices folder and create invoices-summary.md in this folder')).toEqual(['invoices-summary.md']);
    expect(namedOutputFiles('Create notes/hello.txt containing exactly: hi')).toEqual(['notes/hello.txt']);
    expect(namedOutputFiles('Summarize meeting-note.txt for me.')).toEqual([]);
    expect(namedOutputFiles('Write a summary of report.pdf into summary.md')).toEqual(['summary.md']);
    expect(namedOutputFiles('Generate a file from data.csv using template.html')).toEqual([]);
    expect(namedOutputFiles('Save it as https://example.com/a.txt')).toEqual([]);
  });
  it('skips templated names and finds the index in the S21 prompt', () => {
    expect(namedOutputFiles(S21)).toEqual(['analysis/index.md']);
  });
});

describe('one output per input', () => {
  it('counts the files of the named folder', () => {
    put('inbox/a.txt'); put('inbox/b.txt'); put('inbox/c.txt');
    expect(perInputRequirement(S21, ws)).toEqual({ folder: 'inbox', count: 3 });
    expect(perInputRequirement('Write one summary for every file in inbox', ws)).toEqual({ folder: 'inbox', count: 3 });
    expect(perInputRequirement('Write a summary', ws)).toBeNull();
    expect(perInputRequirement('Write a summary for each file in ../elsewhere', ws)).toBeNull();
  });
});

describe('links', () => {
  it('finds local link targets only', () => {
    expect(localLinkTargets('[a](a.md) [b](https://x.y/b) [c](#top) <a href="d.html">d</a> [e](sub/e.md#h)')).toEqual(['a.md', 'd.html', 'sub/e.md']);
  });
});

describe('ledger on the S21 shape', () => {
  const setup = (analyses: string[]) => {
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) put(`inbox/${n}.txt`);
    const written = analyses.map((n) => put(`analysis/${n}.analysis.md`, `analysis of ${n}`));
    written.push(put('analysis/index.md', analyses.map((n) => `- [${n}](${n}.analysis.md)`).concat(['- [f](f.analysis.md)']).join('\n')));
    return written;
  };
  it('reports the missing sixth analysis: the count and the dangling index link', () => {
    const written = setup(['a', 'b', 'c', 'd', 'e']);
    const r = deliverableLedger({ requestText: S21, workspace: ws, writtenFiles: written, turnStartMs: start });
    expect(r.missing).toEqual(['analysis/index.md links to f.analysis.md']);
    expect(r.present).toContain('analysis/index.md');
  });
  it('flags too few outputs even when nothing links to them', () => {
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) put(`inbox/${n}.txt`);
    const w = ['a', 'b', 'c'].map((n) => put(`analysis/${n}.analysis.md`)); w.push(put('analysis/index.md', 'no links'));
    const r = deliverableLedger({ requestText: S21, workspace: ws, writtenFiles: w, turnStartMs: start });
    expect(r.missing).toEqual(['6 output files, one for each file in inbox']);
  });
  it('is satisfied when everything exists', () => {
    const written = setup(['a', 'b', 'c', 'd', 'e', 'f']);
    const r = deliverableLedger({ requestText: S21, workspace: ws, writtenFiles: written, turnStartMs: start });
    expect(r.missing).toEqual([]);
    expect(r.expected.length).toBeGreaterThanOrEqual(3);
  });
});

describe('presence rules', () => {
  it('an empty or stale file is not a deliverable', () => {
    put('empty.md', '');
    const stale = put('old.md', 'old'); fs.utimesSync(stale, new Date(start - 3_600_000), new Date(start - 3_600_000));
    expect(deliverableLedger({ requestText: 'Create empty.md', workspace: ws, writtenFiles: [], turnStartMs: start }).missing).toEqual(['empty.md']);
    expect(deliverableLedger({ requestText: 'Create old.md', workspace: ws, writtenFiles: [], turnStartMs: start }).missing).toEqual(['old.md']);
  });
  it('a bare name may be satisfied in a folder the model chose, a path may not', () => {
    const f = put('invoices/invoices-summary.md', 'x');
    expect(deliverableLedger({ requestText: 'Create invoices-summary.md', workspace: ws, writtenFiles: [f], turnStartMs: start }).missing).toEqual([]);
    expect(deliverableLedger({ requestText: 'Create out/invoices-summary.md', workspace: ws, writtenFiles: [f], turnStartMs: start }).missing).toEqual(['out/invoices-summary.md']);
  });
  it('a request that names no output has an empty ledger', () => {
    const r = deliverableLedger({ requestText: 'What is in notes.txt?', workspace: ws, writtenFiles: [], turnStartMs: start });
    expect(r).toEqual({ expected: [], missing: [], present: [] });
  });
});

import { unbackedWorkingClaim } from '../runtime/deliverableLedger';
describe('verification claims (audit S16)', () => {
  const failed = { tool: 'run_checks', status: 'completed', result: { isError: true, content: [{ text: 'Error: Working directory "undefined" is outside the authorized scope.' }] } };
  const ok = { tool: 'run_checks', status: 'completed', result: { content: [{ text: 'git version 2.45.1' }] } };
  it('flags "works" after the only check failed', () => {
    expect(unbackedWorkingClaim('Git 2.45.1 is installed and works correctly.', [failed])).toMatch(/successful check .*the check failed: Error: Working directory/);
  });
  it('does not flag an honest report, a later success, or no check at all', () => {
    expect(unbackedWorkingClaim('Git is installed, but I could not verify that it works.', [failed])).toBeNull();
    expect(unbackedWorkingClaim('Git works.', [failed, ok])).toBeNull();
    expect(unbackedWorkingClaim('Git works.', [])).toBeNull();
    expect(unbackedWorkingClaim('Git works.', [ok])).toBeNull();
  });
});
