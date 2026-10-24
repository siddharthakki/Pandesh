import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodingPlanner } from '../../coding/CodingPlanner';
import { WorkspaceInspectionTools } from '../../coding/WorkspaceInspection';
import { RepositoryContextService } from '../../context/RepositoryContextService';
import { ProviderGatewayGovernedModelExecutionDependency } from '../../agent/ProviderGatewayGovernedModelExecutionDependency';
import type { InferenceProvider } from '../../providers/ProviderTypes';
import type { ChatMessage, ToolDefinition } from '../../tools/ToolTypes';
import * as vscodeMock from '../mocks/vscode';

describe('CodingPlanner provider-bound repository context', () => {
  let root: string;
  const goal = 'Add validation so reserveSeat rejects an empty label and update the relevant tests.';
  const implementation = "const seats = [];\nfunction reserveSeat(label) { seats.push(label); return { label }; }\nmodule.exports = { reserveSeat };\n";
  const tests = "const assert = require('node:assert');\nconst { reserveSeat } = require('./seats');\nfunction testReservation() { assert.equal(reserveSeat('front').label, 'front'); }\nmodule.exports = { testReservation };\n";
  const runner = "const checks = require('../lib/seats.test');\nfor (const check of Object.values(checks)) check();\n";
  const packageText = JSON.stringify({ scripts: { test: 'node test/check.js' } });
  const candidate = JSON.stringify({ version: 1, taskSummary: 'Validate reservation', operations: [{ type: 'replace', path: 'lib/seats.js', reason: 'validation', content: implementation }], validationCommands: [{ kind: 'npm-test' }], warnings: [], status: 'proposed' });

  async function write(relative: string, content: string) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  async function plan(responses = [candidate]) {
    const chat = vi.fn(async (_messages: ChatMessage[], _tools: ToolDefinition[]) => ({ message: { role: 'assistant', content: responses.shift() ?? candidate }, done: true }));
    const provider = { providerType: 'ollama', chat } as unknown as InferenceProvider;
    const planner = new CodingPlanner(root, new ProviderGatewayGovernedModelExecutionDependency(async () => provider), { model: 'devstral-small-2:latest', providerType: 'ollama' });
    const result = await planner.plan(goal);
    const prompts = chat.mock.calls.map(call => (call as unknown as [Array<{ content: string }>])[0].map(message => message.content).join('\n'));
    return { result, prompts, chat };
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-planner-context-'));
    vscodeMock._resetConfig();
    await write('lib/seats.js', implementation);
    await write('lib/seats.test.js', tests);
    await write('test/check.js', runner);
    await write('package.json', packageText);
    await write('lib/weather.js', 'const UNRELATED_WEATHER_SENTINEL = 42;\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    expect(root.startsWith(path.join(os.tmpdir(), 'oa-planner-context-'))).toBe(true);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  it('sends complete implementation, tests, package and runner contents in its single tool-free provider call', async () => {
    const { result, prompts, chat } = await plan();
    expect(result.proposal).toBeDefined();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1]).toEqual([]);
    for (const content of [implementation, tests, runner, packageText]) expect(prompts[0]).toContain(content);
    expect(prompts[0]).toContain('COMPLETE current file; sha256:');
    expect(prompts[0]).not.toContain('UNRELATED_WEATHER_SENTINEL');
    expect(prompts[0]).not.toMatch(/re-?read|read_file|read_file_range/i);
  });
  it('bounds context and explicitly labels an incomplete current file', async () => {
    await write('lib/seats.js', implementation + '// reservation detail\n'.repeat(2500));
    const { prompts } = await plan();
    const context = prompts[0].slice(prompts[0].indexOf('Selected repository content'));
    expect(context.length).toBeLessThanOrEqual(16000);
    expect(context).toContain('TRUNCATED current file; remainder omitted');
    expect(context).not.toContain(implementation + '// reservation detail\n'.repeat(2500));
  });
  it('does not mislabel a selector summary fallback as complete when the authoritative read fails', async () => {
    const selected = await new RepositoryContextService(root).build({ query: goal, mode: 'agent', role: 'implementer', model: 'devstral-small-2:latest', tokenBudget: 4000 });
    const file = selected.files.find(file => file.path === 'lib/seats.js')!;
    expect(file).toBeDefined();
    file.snippet = 'SUMMARY_FALLBACK_SENTINEL';
    file.truncated = false;
    vi.spyOn(RepositoryContextService.prototype, 'build').mockResolvedValue(selected);
    const read = WorkspaceInspectionTools.prototype.readTextFile;
    vi.spyOn(WorkspaceInspectionTools.prototype, 'readTextFile').mockImplementation(function (this: WorkspaceInspectionTools, relative, signal) {
      if (relative === 'lib/seats.js') return Promise.reject(new Error('unreadable'));
      return read.call(this, relative, signal);
    });
    const { prompts } = await plan();
    expect(prompts[0]).toContain('### lib/seats.js\nUNAVAILABLE:');
    expect(prompts[0]).not.toContain('SUMMARY_FALLBACK_SENTINEL');
    expect(prompts[0]).not.toContain(implementation);
  });
  it('retains the same grounded context during the existing single conformance-repair call', async () => {
    const invalid = JSON.parse(candidate);
    delete invalid.taskSummary;
    const { prompts, result } = await plan([JSON.stringify(invalid), candidate]);
    expect(result.metadata.repairAttempted).toBe(true);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) for (const content of [implementation, tests, runner, packageText]) expect(prompt).toContain(content);
  });
  it('anchors a truncated excerpt on the exact identifier named in the task rather than the file start', async () => {
    const padding = '// padding line\n'.repeat(2000);
    await write('lib/seats.js', padding + implementation);
    const { prompts } = await plan();
    const context = prompts[0].slice(prompts[0].indexOf('Selected repository content'));
    expect(context).toContain('TRUNCATED current file; remainder omitted');
    expect(context).toContain('function reserveSeat(label)');
  });
  it('does not let a large package.json crowd out the file the task names', async () => {
    await write('package.json', JSON.stringify({ scripts: { test: 'node test/check.js' }, description: 'x'.repeat(20000) }));
    const { prompts, result } = await plan();
    expect(result.proposal).toBeDefined();
    const context = prompts[0].slice(prompts[0].indexOf('Selected repository content'));
    expect(context).toContain(implementation);
  });
});
