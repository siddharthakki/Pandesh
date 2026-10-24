/**
 * R1: local-model context efficiency. The investigation loop must not burn the context window re-reading evidence the
 * model already holds, must not loop on EOF/pathological ranges, must not cycle discard -> reread -> discard under
 * compaction, and must start a retry from retained evidence (revalidated against the files on disk).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GOVERNED_MODEL_CONTRACT_VERSION, type GovernedModelRequest, type GovernedModelResult } from '../../agent/GovernedModelExecutionTypes';
import type { GovernedModelDispatchSeam } from '../../agent/LocalFirstModelDispatchRouter';
import { runInvestigationLoop } from '../../coding/InvestigationLoop';
import { InvestigationEvidenceCarry, MAX_DELIVERIES_PER_RANGE } from '../../coding/InvestigationEvidence';
import { WorkspaceInspectionTools } from '../../coding/WorkspaceInspection';

const PROPOSAL = {
  version: 1,
  taskSummary: 'Use the real THRESHOLD',
  operations: [{ type: 'replace', path: 'index.js', reason: 'Compare against the threshold', content: "const { THRESHOLD } = require('./helper');\nfunction isValid(n) { return n > THRESHOLD; }\nmodule.exports = { isValid };\n" }],
  validationCommands: [{ kind: 'npm-script', script: 'verify' }],
  warnings: [],
  status: 'proposed',
};

const reply = (action: Record<string, unknown>): GovernedModelResult => ({
  contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
  requestId: 'investigation:test',
  invocationId: 'inv',
  taskId: 'task',
  model: 'qwen3.8:27b-mtp-q4_K_M',
  evidence: { contractVersion: GOVERNED_MODEL_CONTRACT_VERSION } as GovernedModelResult['evidence'],
  status: 'completed',
  completion: JSON.stringify(action),
});
const read = (file: string, startLine?: number, endLine?: number) => reply({ action: 'read_file', path: file, ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) });
const submit = () => reply({ action: 'submit_proposal', proposal: PROPOSAL });

class Scripted implements GovernedModelDispatchSeam {
  readonly prompts: string[] = [];
  constructor(private readonly replies: GovernedModelResult[]) {}
  async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
    this.prompts.push(request.prompt);
    const next = this.replies[this.prompts.length - 1];
    if (!next) throw new Error(`unexpected extra dispatch ${this.prompts.length}`);
    return next;
  }
}

describe('R1: investigation evidence reuse', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-evidence-reuse-'));
    await fs.writeFile(path.join(root, 'helper.js'), 'module.exports = { THRESHOLD: 42 };\n');
    await fs.writeFile(path.join(root, 'index.js'), 'function isValid(n) { return n > 10; }\nmodule.exports = { isValid };\n');
    const lines = (tag: string) => Array.from({ length: 80 }, (_, i) => `// ${tag} line ${i + 1} ${'x'.repeat(80)}`).join('\n') + '\n';
    await fs.writeFile(path.join(root, 'a.js'), lines('A'));
    await fs.writeFile(path.join(root, 'b.js'), lines('B'));
    await fs.writeFile(path.join(root, 'c.js'), lines('C'));
    await fs.writeFile(path.join(root, 'eof.py'), Array.from({ length: 451 }, (_, i) => `line_${i + 1} = ${i}`).join('\n'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const run = (dispatcher: Scripted, carry: InvestigationEvidenceCarry, maxTurns = 6) => runInvestigationLoop({
    task: 'Fix isValid to use helper.THRESHOLD',
    files: ['helper.js', 'index.js', 'a.js', 'b.js', 'c.js', 'eof.py'],
    packageScripts: ['verify'],
    initialRepositoryContext: '',
    dispatcher,
    inspection: new WorkspaceInspectionTools(root),
    validateProposalCoverage: async () => [],
    model: 'qwen3.8:27b-mtp-q4_K_M',
    invocationId: 'inv',
    taskId: 'task',
    maxTurns,
    carry,
  });

  it('an identical read while its body is still in the prompt is not delivered again', async () => {
    const carry = new InvestigationEvidenceCarry();
    const dispatcher = new Scripted([read('helper.js'), read('helper.js'), submit()]);
    const loop = await run(dispatcher, carry);
    expect(loop.outcome.kind).toBe('proposal');
    expect(carry.stats.suppressedRepeats).toBe(1);
    expect(dispatcher.prompts[2]).toContain('THRESHOLD: 42'); // the real body is still there, once
    expect((dispatcher.prompts[2].match(/THRESHOLD: 42/g) ?? []).length).toBe(1);
    expect(dispatcher.prompts[2]).toContain('ALREADY PROVIDED');
    expect([...carry.deliveries.entries()].filter(([key]) => key.startsWith('helper.js')).map(([, count]) => count)).toEqual([1]);
  });

  it('a sub-range of a range already delivered is also suppressed', async () => {
    const carry = new InvestigationEvidenceCarry();
    const dispatcher = new Scripted([read('a.js', 1, 40), read('a.js', 10, 20), submit()]);
    await run(dispatcher, carry);
    expect(carry.stats.suppressedRepeats).toBe(1);
  });

  it('EOF-line ranges (app/main.py 451-451 style) never loop: no re-delivery, a firm stop note, bounded termination', async () => {
    const carry = new InvestigationEvidenceCarry();
    const dispatcher = new Scripted([read('eof.py', 1, 451), read('eof.py', 451, 451), read('eof.py', 451, 451), read('eof.py', 451, 451), submit()]);
    const loop = await run(dispatcher, carry);
    expect(loop.outcome.kind).toBe('proposal');
    // After two consecutive reads that add nothing, the model is told plainly to decide.
    expect(dispatcher.prompts[4]).toContain('stop re-reading');
    // The EOF line itself was delivered at most once (as part of 1-451), never again.
    expect((dispatcher.prompts[4].match(/line_451 = 450/g) ?? []).length).toBeLessThanOrEqual(1);
    expect([...carry.deliveries.values()].every(count => count <= MAX_DELIVERIES_PER_RANGE)).toBe(true);
  });

  it('compaction cannot cause an unbounded discard -> reread -> discard cycle', async () => {
    const carry = new InvestigationEvidenceCarry();
    // Three large files overflow the transcript budget, so older bodies are omitted; the model then keeps asking for them.
    const dispatcher = new Scripted([
      read('a.js'), read('b.js'), read('c.js'),
      read('a.js'), read('b.js'), read('a.js'), submit(),
    ]);
    const loop = await run(dispatcher, carry, 6);
    expect(['proposal', 'turn_limit_exceeded', 'insufficient_context']).toContain(loop.outcome.kind);
    for (const [key, count] of carry.deliveries) expect(count, key).toBeLessThanOrEqual(MAX_DELIVERIES_PER_RANGE);
    expect(carry.stats.grantedRereads + carry.stats.suppressedRepeats + carry.stats.refusedRereads).toBeGreaterThan(0);
  });

  it('a retry loop starts from the retained evidence and only re-reads what changed on disk', async () => {
    const carry = new InvestigationEvidenceCarry();
    await run(new Scripted([read('helper.js'), submit()]), carry);
    expect(carry.readPaths()).toEqual(['helper.js']);

    // Retry 1: the file is unchanged. The evidence is already in the first prompt, and a repeat read is suppressed.
    const retry = new Scripted([read('helper.js'), submit()]);
    await run(retry, carry);
    expect(retry.prompts[0]).toContain('THRESHOLD: 42');
    expect(carry.stats.suppressedRepeats).toBe(1);

    // Retry 2: the file changed on disk. The stale evidence is dropped, and a fresh read delivers the new bytes.
    await fs.writeFile(path.join(root, 'helper.js'), 'module.exports = { THRESHOLD: 99 };\n');
    const afterEdit = new Scripted([read('helper.js'), submit()]);
    await run(afterEdit, carry);
    expect(afterEdit.prompts[0]).not.toContain('THRESHOLD: 42');
    expect(afterEdit.prompts[1]).toContain('THRESHOLD: 99');
    expect(carry.stats.invalidatedPaths).toBeGreaterThanOrEqual(1);
  });

  it('without a carry each loop still works exactly as before (a private store per loop)', async () => {
    const dispatcher = new Scripted([read('helper.js'), submit()]);
    const loop = await runInvestigationLoop({
      task: 'Fix isValid', files: ['helper.js'], packageScripts: ['verify'], initialRepositoryContext: '', dispatcher,
      inspection: new WorkspaceInspectionTools(root), validateProposalCoverage: async () => [], model: 'm', invocationId: 'i', taskId: 't', maxTurns: 2,
    });
    expect(loop.outcome.kind).toBe('proposal');
  });
});
