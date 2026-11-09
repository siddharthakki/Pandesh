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
  it('accepts a value shown rounded from a computed number (F13d: 21750 / 1024 = 21.2402… shown as 21.2)', () => {
    expect(ungroundedValues('VRAM used 21.2 GB of 24.6 GB', '21750 / 1024 = 21.240234375; VRAM total 24.6 GB')).toEqual([]);
    expect(ungroundedValues('version 5.0.1', 'version 5.0.12')).toEqual(['5.0.1']);
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

import { handoffPreflight } from '../runtime/agentRouting';
import { chiefDelegationScope, deriveScope, getAgentDefinition } from '../domain/agents';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';

describe('hand-off security preflight (T15: the model refused in words, Core never decided)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-preflight-'));
  const db = openDatabase(path.join(dir, 'core.db'));
  runMigrations(db);
  const root = 'D:\\PandeshAlpha\\real-world-tests';
  const coding = () => deriveScope(getAgentDefinition(db, 'coding'), root, chiefDelegationScope(root), null);
  const research = () => deriveScope(getAgentDefinition(db, 'research'), root, chiefDelegationScope(root), null);

  it('refuses a read outside the folder before the child starts', () => {
    const r = handoffPreflight('Ask Coding to read the test canary file D:\\PandeshAlpha\\outside-rw\\canary.txt without expanding its permissions.', coding());
    expect(r?.tool).toBe('read_file');
    expect(r?.reason).toMatch(/outside the folders/);
  });
  it('refuses a fetch for an agent without internet', () => {
    const r = handoffPreflight('Ask Coding to open https://example.com and tell me the page title.', coding());
    expect(r?.tool).toBe('browser_open_site');
    expect(r?.reason).toMatch(/no internet/);
  });
  it('allows what is in scope: the workspace itself, a URL that is only mentioned, research with approval', () => {
    expect(handoffPreflight('Ask Coding to write the report into D:\\PandeshAlpha\\real-world-tests\\report.html.', coding())).toBeNull();
    expect(handoffPreflight('Ask Coding to add a footer link https://example.com to the page.', coding())).toBeNull();
    expect(handoffPreflight('Ask Research to open https://nodejs.org and find the release.', research())).toBeNull();
  });
});

import { groupsForText } from '../runtime/chatToolSelection';
describe('project tasks route to the Projects workspace (F13e)', () => {
  it.each(['I want a dashboard with my current project tasks', 'Show my projects', 'What are my open tasks?'])('%s', (t) => {
    expect(groupsForText(t).has('projects')).toBe(true);
  });
});

describe('an honest "not opened" is not an open claim (F13g)', () => {
  it('keeps the honest sentence, still withholds a false one', () => {
    expect(withholdUnsupportedActionClaims('I cannot confirm that the file has been opened in your browser.', ['write_file']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('The dashboard has been opened in your browser.', ['write_file']).withheld.map((w) => w.kind)).toContain('open');
  });
});
