/**
 * "Make it work like you" pass (2026-11-09): routing by request, Core's own output checks, verified-claim guard,
 * hand-off security preflight. Each case comes from a live run in the real-world challenge.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isQuickRequest, routeModel } from '../domain/modelRouting';
import { checkWrittenOutput, ungroundedValues } from '../runtime/outputChecks';
import { withholdUnsupportedActionClaims } from '../runtime/actionClaims';

const run = (command: string, args: string[]) => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error };
};

describe('Auto routing by request', () => {
  it.each(['Quick question: how much free RAM do I have right now?', 'What do you remember about Project Cedar?', 'When and where is the Project Birch review?', 'What time is it in Berlin?'])('quick: %s', (t) => {
    expect(isQuickRequest(t)).toBe(true);
  });
  it.each([
    'Find the broken Python project in my test workspace. Run its tests, identify the failure, fix the bug, and rerun the tests.',
    'Ask Coding to create a small Python expense tracker.',
    'Create a small local HTML expense dashboard using my sample invoice files.',
    "Project Cedar's meeting has changed to Monday at 11 AM. Forget only the old room.",
  ])('multi-step: %s', (t) => {
    expect(isQuickRequest(t)).toBe(false);
  });
  it('a quick question goes to the fast model, real work to the 27B model', () => {
    const catalog = { reachable: true, models: ['gemma4:12b', 'qwen3.8:27b-mtp-q4_K_M'] } as never;
    expect(routeModel('saath_kar' as never, undefined, catalog, { requestText: 'How much free RAM do I have?' }).selectedModel).toBe('gemma4:12b');
    expect(routeModel('saath_kar' as never, undefined, catalog, { requestText: 'Fix the bug in buggy_project and rerun the tests.' }).selectedModel).toBe('qwen3.8:27b-mtp-q4_K_M');
  });
});

describe("Core's check of a written file", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-outcheck-'));
  it('catches a Python file that does not parse (baseline T11 shape)', () => {
    const file = path.join(tmp(), 'temperature.py');
    const content = 'def f(c):\n    \\"\\"\\"x\\"\\"\\"\n    return c\n';
    fs.writeFileSync(file, content);
    const c = checkWrittenOutput(file, content, '', run);
    expect(c.syntaxOk).toBe(false);
    expect(c.summary).toMatch(/PROBLEM/);
  });
  it('flags a dashboard value nothing returned (T13 "Tuxedo 4.0 → 5.0.1")', () => {
    const html = '<html><body><table><tr><td>Ollama</td><td>0.40.12</td><td>0.40.15</td></tr><tr><td>Tuxedo</td><td>4.0</td><td>5.0.1</td></tr></table></body></html>';
    const corpus = 'Ollama.Ollama (winget): installed 0.40.12 → latest 0.40.15 [update_available]';
    const c = checkWrittenOutput('dash.html', html, corpus);
    expect(c.ungrounded).toEqual(['4.0', '5.0.1']);
  });
  it('accepts values in any common spelling, including totals from calculate', () => {
    expect(ungroundedValues('Total EUR 267.39, A-1001 EUR 82.5, v26.13.0', '82.50 + 144.90 + 39.99 = 267.39\nNode v26.13.0')).toEqual([]);
  });
});

describe('"verified" needs a real check of the result (R16)', () => {
  it('withheld when nothing checked the written file', () => {
    const r = withholdUnsupportedActionClaims('All data has been successfully verified against the source text files.', ['read_file', 'write_file'], { outputsVerified: false });
    expect(r.withheld.map((w) => w.kind)).toContain('verified');
  });
  it('stands when Core checked it or it was read back', () => {
    expect(withholdUnsupportedActionClaims('The file was verified by re-reading it.', ['write_file', 'read_file'], { outputsVerified: true }).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I could not verify the file.', ['write_file'], { outputsVerified: false }).withheld).toEqual([]);
  });
});
