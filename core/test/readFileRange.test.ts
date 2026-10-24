/**
 * M45 corrective — read_file line ranges: the recovery path a compacted result
 * points the model at. A range read must say exactly what it returned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreToolRunner } from '../runtime/toolRunner';

let dir: string;
const runner = new CoreToolRunner();
const run = (args: Record<string, unknown>) => runner.run({ name: 'read_file', arguments: args }, { cwd: dir, signal: new AbortController().signal });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-range-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'wide.txt'), `${Array.from({ length: 40 }, (_, i) => `${i + 1} ${'w'.repeat(500)}`).join('\n')}\n`, 'utf8');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('read_file line ranges', () => {
  it('advertises startLine/endLine', () => {
    const read = runner.definitions().find((d) => d.name === 'read_file')!;
    expect(Object.keys((read.parameters as { properties: object }).properties)).toEqual(['path', 'startLine', 'endLine']);
  });

  it('returns exactly the requested inclusive range with an absolute LINES header', async () => {
    const result = await run({ path: 'a.txt', startLine: 10, endLine: 12 });
    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('LINES 10-12 of 50\nline 10\nline 11\nline 12');
    expect(result.normalizedArguments).toEqual({ path: 'a.txt', startLine: 10, endLine: 12 });
  });

  it('a whole-file read is byte-for-byte what it was before ranges existed', async () => {
    const result = await run({ path: 'a.txt' });
    expect(result.output).toBe(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'));
    expect(result.normalizedArguments).toEqual({ path: 'a.txt' });
  });

  it('startLine alone reads to the end; endLine alone reads from the start', async () => {
    expect((await run({ path: 'a.txt', startLine: 49 })).output).toBe('LINES 49-50 of 50\nline 49\nline 50');
    expect((await run({ path: 'a.txt', endLine: 2 })).output).toBe('LINES 1-2 of 50\nline 1\nline 2');
  });

  it('clamps past the end of the file and says the range is empty when it starts beyond it', async () => {
    expect((await run({ path: 'a.txt', startLine: 48, endLine: 999 })).output).toBe('LINES 48-50 of 50\nline 48\nline 49\nline 50');
    const empty = await run({ path: 'a.txt', startLine: 90, endLine: 95 });
    expect(empty.status).toBe('succeeded');
    expect(empty.output).toContain('the file has 50 lines');
  });

  it('accepts numeric strings and ignores nonsense bounds rather than failing', async () => {
    expect((await run({ path: 'a.txt', startLine: '3', endLine: '4' })).output).toBe('LINES 3-4 of 50\nline 3\nline 4');
    expect((await run({ path: 'a.txt', startLine: 0, endLine: -2 })).output).toBe(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'));
  });

  it('a range larger than the read bound stops at a whole line and says where to continue', async () => {
    const result = await run({ path: 'wide.txt', startLine: 1, endLine: 40 });
    const header = /^LINES 1-(\d+) of 40\n/.exec(result.output)!;
    expect(header).not.toBeNull();
    const last = Number(header[1]);
    expect(last).toBeLessThan(40);
    expect(result.output).toContain(`…[truncated at line ${last}; continue with startLine=${last + 1}]`);
    expect(result.output.length).toBeLessThan(8_300);
  });

  it('still refuses a path outside the workspace, range or not', async () => {
    const result = await run({ path: '../outside.txt', startLine: 1, endLine: 2 });
    expect(result.status).toBe('failed');
  });
});
