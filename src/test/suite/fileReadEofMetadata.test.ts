import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  type GovernedModelRequest,
  type GovernedModelResult,
} from '../../agent/GovernedModelExecutionTypes';
import type { GovernedModelDispatchSeam } from '../../agent/LocalFirstModelDispatchRouter';
import {
  runInvestigationLoop,
  isSpuriousInsufficientContextDueToSize,
  type FileReadHistoryEntry,
} from '../../coding/InvestigationLoop';
import { WorkspaceInspectionTools } from '../../coding/WorkspaceInspection';
import { readFile, readFileRange } from '../../tools/fileTools';
import type { ToolContext } from '../../tools/ToolTypes';

function envelope(action: Record<string, unknown>): string {
  return JSON.stringify(action);
}

function modelResult(partial: Partial<GovernedModelResult> & Pick<GovernedModelResult, 'status'>): GovernedModelResult {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: 'investigation:test:1',
    invocationId: 'inv',
    taskId: 'task',
    model: 'qwen3.8:27b-mtp-q4_K_M',
    evidence: { contractVersion: GOVERNED_MODEL_CONTRACT_VERSION } as GovernedModelResult['evidence'],
    ...partial,
  };
}

class ScriptedDispatcher implements GovernedModelDispatchSeam {
  readonly prompts: string[] = [];
  readonly requestIds: string[] = [];
  readonly requests: GovernedModelRequest[] = [];
  constructor(private readonly replies: Array<GovernedModelResult | ((request: GovernedModelRequest) => GovernedModelResult)>) {}
  async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
    this.requests.push(request);
    this.prompts.push(request.prompt);
    this.requestIds.push(request.requestId);
    const next = this.replies[this.prompts.length - 1];
    if (!next) throw new Error(`unexpected extra dispatch ${this.prompts.length}`);
    return typeof next === 'function' ? next(request) : next;
  }
}

describe('file-read EOF and size metadata contract', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-eof-metadata-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('76-line file with ~4,000 characters: totalLines === 76, character count distinct, EOF true after reading through line 76', async () => {
    // Generate 76 lines where each line is ~55 characters -> total ~4,200 characters
    const lines: string[] = [];
    for (let i = 1; i <= 76; i++) {
      const lineNum = String(i).padStart(2, '0');
      lines.push(`def test_case_${lineNum}(): assert price(${i}) > 0 # length pad`);
    }
    const content = lines.join('\n');
    expect(lines.length).toBe(76);
    expect(content.length).toBeGreaterThan(3800);
    expect(content.length).toBeLessThan(5000);

    await fs.writeFile(path.join(root, 'test_pricing.py'), content);

    const inspection = new WorkspaceInspectionTools(root);
    const textFile = await inspection.readTextFile('test_pricing.py');
    expect(textFile.totalLines).toBe(76);
    expect(textFile.characterCount).toBe(content.length);
    expect(textFile.characterCount).not.toBe(textFile.totalLines);

    // Run investigation turn reading 1-76
    const dispatcher = new ScriptedDispatcher([
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'test_pricing.py', startLine: 1, endLine: 76 }) }),
      modelResult({
        status: 'completed',
        completion: envelope({
          action: 'submit_proposal',
          proposal: {
            version: 1,
            taskSummary: 'Verified tests',
            operations: [{ type: 'replace', path: 'test_pricing.py', reason: 'Keep', content }],
            validationCommands: [{ kind: 'npm-script', script: 'test' }],
            warnings: [],
            status: 'proposed',
          },
        }),
      }),
    ]);

    const progress: string[] = [];
    const result = await runInvestigationLoop({
      task: 'Verify test_pricing.py',
      files: ['test_pricing.py'],
      packageScripts: ['test'],
      initialRepositoryContext: '',
      dispatcher,
      inspection,
      validateProposalCoverage: async () => [],
      model: 'qwen3.8:27b-mtp-q4_K_M',
      invocationId: 'inv',
      taskId: 'task',
      maxTurns: 3,
      onProgress: p => progress.push(p),
    });

    expect(result.outcome.kind).toBe('proposal');
    const readTurn = result.turns.find(t => t.action === 'read_file');
    expect(readTurn).toBeDefined();
    expect(readTurn?.totalLines).toBe(76);
    expect(readTurn?.characterCount).toBe(content.length);
    expect(readTurn?.eof).toBe(true);
    expect(readTurn?.noUnreadContent).toBeFalsy();

    // Verify prompt for turn 2 contained unambiguous EOF and distinct totalLines/characterCount
    const turn2Prompt = dispatcher.prompts[1];
    expect(turn2Prompt).toContain('totalLines: 76');
    expect(turn2Prompt).toContain(`characterCount: ${content.length}`);
    expect(turn2Prompt).toContain('eof: true');
    // Ensure 4225 / character count is NEVER exposed as lines
    expect(turn2Prompt).not.toMatch(new RegExp(`${content.length}\\s*lines`));
  });

  it('Request 1-200 against 76-line file returns 1-76 and EOF true', async () => {
    const lines = Array.from({ length: 76 }, (_, i) => `line_${i + 1}_padding_character_content_for_test`);
    const content = lines.join('\n');
    await fs.writeFile(path.join(root, 'test_pricing.py'), content);

    const inspection = new WorkspaceInspectionTools(root);
    const dispatcher = new ScriptedDispatcher([
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'test_pricing.py', startLine: 1, endLine: 200 }) }),
      modelResult({
        status: 'completed',
        completion: envelope({
          action: 'submit_proposal',
          proposal: {
            version: 1,
            taskSummary: 'Done',
            operations: [{ type: 'replace', path: 'test_pricing.py', reason: 'Verified', content }],
            validationCommands: [{ kind: 'npm-script', script: 'test' }],
            warnings: [],
            status: 'proposed',
          },
        }),
      }),
    ]);

    const result = await runInvestigationLoop({
      task: 'Check file',
      files: ['test_pricing.py'],
      packageScripts: ['test'],
      initialRepositoryContext: '',
      dispatcher,
      inspection,
      validateProposalCoverage: async () => [],
      model: 'qwen3.8:27b-mtp-q4_K_M',
      invocationId: 'inv',
      taskId: 'task',
      maxTurns: 3,
    });

    expect(result.outcome.kind).toBe('proposal');
    const readTurn = result.turns[0];
    expect(readTurn.action).toBe('read_file');
    expect(readTurn.range).toBe('1-76');
    expect(readTurn.totalLines).toBe(76);
    expect(readTurn.characterCount).toBe(content.length);
    expect(readTurn.eof).toBe(true);

    const turn2Prompt = dispatcher.prompts[1];
    expect(turn2Prompt).toContain('requested: lines 1-200');
    expect(turn2Prompt).toContain('returned: lines 1-76');
    expect(turn2Prompt).toContain('totalLines: 76');
    expect(turn2Prompt).toContain('eof: true');
  });

  it('Follow-up request starting at line 76/77 after EOF does not imply thousands of unread lines and explicitly indicates no unread content', async () => {
    const lines = Array.from({ length: 76 }, (_, i) => `test_line_${i + 1}_padding_character_content_for_test`);
    const content = lines.join('\n');
    await fs.writeFile(path.join(root, 'test_pricing.py'), content);

    const inspection = new WorkspaceInspectionTools(root);
    const dispatcher = new ScriptedDispatcher([
      // Turn 1: read 1-76
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'test_pricing.py', startLine: 1, endLine: 76 }) }),
      // Turn 2: repeat request at 76-76
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'test_pricing.py', startLine: 76, endLine: 76 }) }),
      // Turn 3: follow-up request starting at 77-100
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'test_pricing.py', startLine: 77, endLine: 100 }) }),
      // Turn 4: proposal
      modelResult({
        status: 'completed',
        completion: envelope({
          action: 'submit_proposal',
          proposal: {
            version: 1,
            taskSummary: 'Complete',
            operations: [{ type: 'replace', path: 'test_pricing.py', reason: 'Keep', content }],
            validationCommands: [{ kind: 'npm-script', script: 'test' }],
            warnings: [],
            status: 'proposed',
          },
        }),
      }),
    ]);

    const result = await runInvestigationLoop({
      task: 'Inspect tests',
      files: ['test_pricing.py'],
      packageScripts: ['test'],
      initialRepositoryContext: '',
      dispatcher,
      inspection,
      validateProposalCoverage: async () => [],
      model: 'qwen3.8:27b-mtp-q4_K_M',
      invocationId: 'inv',
      taskId: 'task',
      maxTurns: 4,
    });

    expect(result.outcome.kind).toBe('proposal');
    const turn2 = result.turns[1];
    expect(turn2.action).toBe('read_file');
    expect(turn2.noUnreadContent).toBe(true);
    expect(turn2.eof).toBe(true);

    const turn3 = result.turns[2];
    expect(turn3.action).toBe('read_file');
    expect(turn3.noUnreadContent).toBe(true);
    expect(turn3.eof).toBe(true);

    // Check prompts for explicit EOF and no unread content message
    const turn3Prompt = dispatcher.prompts[2];
    expect(turn3Prompt).toContain('EOF already reached. File contains 76 lines; no unread content remains.');
    expect(turn3Prompt).not.toContain('4225 lines');
    expect(turn3Prompt).not.toContain('4000 lines');

    const turn4Prompt = dispatcher.prompts[3];
    expect(turn4Prompt).toContain('EOF already reached. File contains 76 lines; no unread content remains.');
  });

  it('Investigation that has read the complete file may continue reasoning/propose and must not emit insufficient_context solely because character count exceeds line count', async () => {
    const lines = Array.from({ length: 76 }, (_, i) => `test_code_line_${i + 1}_padding_out_character_count_to_four_thousand`);
    const content = lines.join('\n');
    expect(content.length).toBeGreaterThan(4000);
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'tests/test_pricing.py'), content);

    const inspection = new WorkspaceInspectionTools(root);
    const dispatcher = new ScriptedDispatcher([
      // Turn 1: model reads 1-76
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'tests/test_pricing.py', startLine: 1, endLine: 76 }) }),
      // Turn 2: model attempts insufficient_context because it confuses character count with line count
      modelResult({
        status: 'completed',
        completion: envelope({
          action: 'insufficient_context',
          reason: `I have only read lines 1-76 of tests/test_pricing.py (the file is ${content.length} lines)`,
          missing: ['tests/test_pricing.py'],
        }),
      }),
      // Turn 3: after receiving clarification that the complete file is read, model proposes
      modelResult({
        status: 'completed',
        completion: envelope({
          action: 'submit_proposal',
          proposal: {
            version: 1,
            taskSummary: 'Grounded proposal after clarification',
            operations: [{ type: 'replace', path: 'tests/test_pricing.py', reason: 'Keep', content }],
            validationCommands: [{ kind: 'npm-script', script: 'test' }],
            warnings: [],
            status: 'proposed',
          },
        }),
      }),
    ]);

    const progress: string[] = [];
    const result = await runInvestigationLoop({
      task: 'Fix pricing tests',
      files: ['tests/test_pricing.py'],
      packageScripts: ['test'],
      initialRepositoryContext: '',
      dispatcher,
      inspection,
      validateProposalCoverage: async () => [],
      model: 'qwen3.8:27b-mtp-q4_K_M',
      invocationId: 'inv',
      taskId: 'task',
      maxTurns: 3,
      onProgress: p => progress.push(p),
    });

    expect(result.outcome.kind).toBe('proposal');
    expect(progress).toContain('investigation_recovery reason=clarify_full_read attempt=1/1');

    // Verify turn 3 prompt contained clarification note
    const turn3Prompt = dispatcher.prompts[2];
    expect(turn3Prompt).toContain('### clarification: files already fully read');
    expect(turn3Prompt).toContain('tests/test_pricing.py contains 76 lines');
    expect(turn3Prompt).toContain(`(${content.length} characters)`);
    expect(turn3Prompt).toContain('Lines 1-76 were already read to EOF; no unread content remains.');
  });

  it('Regression test reproducing the actual physical pattern: pricing.py ~68 lines / ~2.2K chars and test_pricing.py ~76 lines / ~4.2K chars seen as fully read', async () => {
    // Replicate physical dimensions from agent-bench:
    // pricing.py: 68 lines, ~2242 bytes
    const pricingLines: string[] = [];
    for (let i = 1; i <= 68; i++) {
      pricingLines.push(`def calc_${String(i).padStart(2, '0')}(q, r): return q * r`);
    }
    const pricingContent = pricingLines.join('\n');
    expect(pricingLines.length).toBe(68);
    expect(pricingContent.length).toBeGreaterThan(2000);
    expect(pricingContent.length).toBeLessThan(3000);

    // test_pricing.py: 76 lines, ~4225 bytes
    const testLines: string[] = [];
    for (let i = 1; i <= 76; i++) {
      testLines.push(`def test_case_${String(i).padStart(2, '0')}(): assert subtotal(10, 5) == 50 # pad`);
    }
    const testContent = testLines.join('\n');
    expect(testLines.length).toBe(76);
    expect(testContent.length).toBeGreaterThan(3900);
    expect(testContent.length).toBeLessThan(4500);

    await fs.mkdir(path.join(root, 'src/ordercalc'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/ordercalc/pricing.py'), pricingContent);
    await fs.writeFile(path.join(root, 'tests/test_pricing.py'), testContent);

    const inspection = new WorkspaceInspectionTools(root);

    const dispatcher = new ScriptedDispatcher([
      // Turn 1: agent reads pricing.py 1-68
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'src/ordercalc/pricing.py', startLine: 1, endLine: 68 }) }),
      // Turn 2: agent reads test_pricing.py 1-76
      modelResult({ status: 'completed', completion: envelope({ action: 'read_file', path: 'tests/test_pricing.py', startLine: 1, endLine: 76 }) }),
      // Turn 3: agent submits proposal without getting stuck reading 76-76 or failing on context size
      modelResult({
        status: 'completed',
        completion: envelope({
          action: 'submit_proposal',
          proposal: {
            version: 1,
            taskSummary: 'Updated pricing logic and tests',
            operations: [
              { type: 'replace', path: 'src/ordercalc/pricing.py', reason: 'Fixed calculation', content: pricingContent },
              { type: 'replace', path: 'tests/test_pricing.py', reason: 'Verified test assertions', content: testContent },
            ],
            validationCommands: [{ kind: 'npm-script', script: 'test' }],
            warnings: [],
            status: 'proposed',
          },
        }),
      }),
    ]);

    const result = await runInvestigationLoop({
      task: 'Fix ordercalc pricing discount calculation and update tests',
      files: ['src/ordercalc/pricing.py', 'tests/test_pricing.py'],
      packageScripts: ['test'],
      initialRepositoryContext: '',
      dispatcher,
      inspection,
      validateProposalCoverage: async () => [],
      model: 'qwen3.8:27b-mtp-q4_K_M',
      invocationId: 'inv',
      taskId: 'task',
      maxTurns: 3,
    });

    expect(result.outcome.kind).toBe('proposal');

    // Both files were read to EOF
    const pricingReadTurn = result.turns.find(t => t.path === 'src/ordercalc/pricing.py');
    expect(pricingReadTurn).toBeDefined();
    expect(pricingReadTurn?.totalLines).toBe(68);
    expect(pricingReadTurn?.characterCount).toBe(pricingContent.length);
    expect(pricingReadTurn?.eof).toBe(true);

    const testReadTurn = result.turns.find(t => t.path === 'tests/test_pricing.py');
    expect(testReadTurn).toBeDefined();
    expect(testReadTurn?.totalLines).toBe(76);
    expect(testReadTurn?.characterCount).toBe(testContent.length);
    expect(testReadTurn?.eof).toBe(true);

    // Verify turn 3 prompt clearly reflects both files as completely read with unambiguous metadata
    const turn3Prompt = dispatcher.prompts[2];
    expect(turn3Prompt).toContain('### read_file: src/ordercalc/pricing.py');
    expect(turn3Prompt).toContain('totalLines: 68');
    expect(turn3Prompt).toContain(`characterCount: ${pricingContent.length}`);
    expect(turn3Prompt).toContain('eof: true');

    expect(turn3Prompt).toContain('### read_file: tests/test_pricing.py');
    expect(turn3Prompt).toContain('totalLines: 76');
    expect(turn3Prompt).toContain(`characterCount: ${testContent.length}`);
    expect(turn3Prompt).toContain('eof: true');
  });

  it('fileTools direct test: readFile and readFileRange return unambiguous metadata', async () => {
    const lines = Array.from({ length: 76 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    const filePath = path.join(root, 'test_pricing.py');
    await fs.writeFile(filePath, content);

    const ctx: ToolContext = {
      workspaceRoot: root,
      taskId: 'task-1',
      sessionId: 'session-1',
      iterationId: 'iter-1',
      model: 'test-model',
    };

    // readFile returns totalLines, characterCount, eof
    const fullResult = await readFile({ path: 'test_pricing.py' }, ctx);
    expect(fullResult.ok).toBe(true);
    const fullData = fullResult.data as Record<string, unknown>;
    expect(fullData.totalLines).toBe(76);
    expect(fullData.characterCount).toBe(content.length);
    expect(fullData.eof).toBe(true);

    // readFileRange 1-200 against 76-line file
    const rangeResult = await readFileRange({ path: 'test_pricing.py', startLine: 1, endLine: 200 }, ctx);
    expect(rangeResult.ok).toBe(true);
    const rangeData = rangeResult.data as Record<string, unknown>;
    expect(rangeData.startLine).toBe(1);
    expect(rangeData.endLine).toBe(76);
    expect(rangeData.totalLines).toBe(76);
    expect(rangeData.characterCount).toBe(content.length);
    expect(rangeData.eof).toBe(true);

    // readFileRange starting after EOF (line 77-100)
    const afterEofResult = await readFileRange({ path: 'test_pricing.py', startLine: 77, endLine: 100 }, ctx);
    expect(afterEofResult.ok).toBe(true);
    const afterEofData = afterEofResult.data as Record<string, unknown>;
    expect(afterEofData.noUnreadContent).toBe(true);
    expect(afterEofData.eof).toBe(true);
    expect(afterEofData.content).toBe('EOF already reached. File contains 76 lines; no unread content remains.');
  });
});
