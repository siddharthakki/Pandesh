import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecoverySupervisor } from '../../autonomous/recovery/RecoverySupervisor';
import { emptyFacts, type StageOutcome } from '../../autonomous/recovery/RecoveryTypes';
import { deriveExecutionEconomy } from '../../autonomy/ExecutionEconomyProfile';
import {
  analyzeFailureOutput,
  buildFailureFingerprint,
  computePatchDelta,
  derivePatchFootprint,
} from '../../autonomy/FailureFingerprint';

let root: string;
let worktree: string;

async function write(relative: string, content: string): Promise<void> {
  const target = path.join(worktree, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

const GOAL = 'Fix calculate_total so that total.test.ts passes.';
const BASE = 'export function calculateTotal(items: number[]): number {\n  return items.length;\n}\n';
const A = 'export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
const B = 'export function calculateTotal(items: number[]): number {\n  let sum = 0;\n  for (const n of items) sum += n;\n  return sum;\n}\n';
const OUTPUT = ' FAIL  src/total.test.ts > sums the items\nAssertionError: expected 3 to be 6';

function economy(tokens: number) {
  return deriveExecutionEconomy({ contextWindow: { contextTokens: tokens, source: 'router_metadata' } });
}

async function open(tokens = 8_192): Promise<RecoverySupervisor> {
  return RecoverySupervisor.open({
    repositoryRoot: root,
    taskId: 'task_auto',
    worktreeRoot: worktree,
    candidates: [
      { provider: 'ollama', model: 'small:7b', local: true, available: true, capability: { chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: ['agent'], contextWindow: 8192 }, strength: 7 },
      { provider: 'ollama', model: 'bigger:32b', local: true, available: true, capability: { chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: ['agent'], contextWindow: 32768 }, strength: 32 },
    ],
    modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
    resolveBaseRevision: async () => undefined,
    autonomy: { economyFor: () => economy(tokens), validationCommand: 'npm test -- total' },
  });
}

function failed(pass: number, patch: ReturnType<typeof derivePatchFootprint>): StageOutcome {
  const fp = buildFailureFingerprint({ semantics: [analyzeFailureOutput(OUTPUT, ['src/total.ts'])], files: ['src/total.ts'], patch, evidence: `ev-${pass}` });
  return {
    attemptId: 'att_1', pass, stage: 'validation', ok: false, status: 'validation_failed', cause: 'validation_failure', subcode: 'code_defect',
    details: [], facts: { ...emptyFacts(), proposalPaths: ['src/total.ts'], validationFailures: [{ command: 'npm test -- total', exitCode: 1, timedOut: false, signature: 's', namedPaths: ['src/total.ts'], kind: 'code_defect', semantic: analyzeFailureOutput(OUTPUT, ['src/total.ts']) }] },
    fingerprints: { failure: fp.key, evidence: `ev-${pass}`, patch: patch?.hash, proposal: patch?.hash },
    failureFingerprint: fp, model: { provider: 'ollama', model: 'small:7b' }, observedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-auto-root-'));
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-auto-wt-'));
  await write('package.json', JSON.stringify({ name: 'shop', scripts: { test: 'vitest run' } }));
  await write('src/total.ts', BASE);
  await write('src/total.test.ts', "import { calculateTotal } from './total';\ntest('sums', () => expect(calculateTotal([1, 2, 3])).toBe(6));\n");
  await write('src/cart.ts', "import { calculateTotal } from './total';\nexport const cartTotal = (c: number[]) => calculateTotal(c);\n");
  await write('src/format.ts', 'export const money = (n: number) => `$${n}`;\n');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await fs.rm(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('M46 autonomy layer inside the recovery supervisor', () => {
  it('compiles a bounded pack for a constrained model on the first pass and records why, without contents', async () => {
    const supervisor = await open(8_192);
    const handle = await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    const rendered = await handle.session.renderRecoveryContext();
    expect(rendered).toContain('# Context Pack');
    expect(rendered).toContain('Fix calculate_total');
    expect(rendered).toContain('src/total.ts');
    expect(rendered).toMatch(/Current subgoal[\s\S]*Read /);
    expect(rendered).not.toContain('src/format.ts');

    const record = supervisor.journal.state.subgoalPlan;
    expect(record?.fragmented).toBe(true);
    expect(record?.subgoals.length).toBeGreaterThan(1);

    const journalText = await fs.readFile(path.join(root, '.ollama-agent', 'tasks', 'task_auto', 'recovery', 'journal.jsonl'), 'utf8').catch(async () => {
      // the task directory helper decides the layout; locate the journal instead of assuming it
      const found: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.name === 'journal.jsonl') found.push(full);
        }
      };
      await walk(root);
      return fs.readFile(found[0], 'utf8');
    });
    const packRecord = journalText.split('\n').filter(Boolean).map(line => JSON.parse(line) as { t: string; pack?: { budgetChars: number; packChars: number; selected: unknown[] } }).find(record => record.t === 'context_pack');
    expect(packRecord?.pack?.packChars).toBeLessThanOrEqual(packRecord!.pack!.budgetChars);
    expect(packRecord?.pack?.selected.length).toBeGreaterThan(1);
    expect(journalText).not.toContain('items.length'); // identities and sizes only, never file contents
  });

  it('files the pack showed whole count as read, so a proposal to rewrite them is grounded', async () => {
    const supervisor = await open(8_192);
    const handle = await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    const entries = supervisor.journal.state.evidence.get('src/total.ts');
    expect(entries?.at(-1)).toMatchObject({ source: 'runtime_seed', ranges: [[1, 4]] });
    const verdict = await handle.session.checkGrounding([{ type: 'replace', path: 'src/total.ts', content: A }]);
    expect(verdict.ok).toBe(true);
  });

  it('does not attach a pack on a first pass for a capable model, but still records the plan and telemetry', async () => {
    const supervisor = await open(262_144);
    const handle = await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'bigger:32b' }, goal: GOAL });
    expect(await handle.session.renderRecoveryContext()).not.toContain('# Context Pack');
    expect(supervisor.journal.state.subgoalPlan?.fragmented).toBe(false);
    expect(supervisor.journal.state.subgoalPlan?.subgoals).toHaveLength(1);
  });

  it('degrades to plain M42 behaviour without a goal, and never fails a pass when the layer errors', async () => {
    const supervisor = await open();
    const noGoal = await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' } });
    expect(await noGoal.session.renderRecoveryContext()).not.toContain('# Context Pack');
    await fs.rm(worktree, { recursive: true, force: true });
    const missing = await supervisor.beginPass({ attemptId: 'att_2', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    expect(missing.pass).toBe(2);
  });

  it('after a failure the next pack carries the failure, validation state and what the model has already seen', async () => {
    const supervisor = await open(8_192);
    const first = await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    expect(first.pass).toBe(1);
    const decision = await supervisor.controller.decide(failed(1, undefined));
    await supervisor.commit(decision);
    const second = await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL, directives: decision.directives });
    const rendered = await second.session.renderRecoveryContext();
    expect(rendered).toMatch(/Relevant failures[\s\S]*validation_failure\/code_defect/);
    expect(rendered).toMatch(/Validation state[\s\S]*status: failing/);
    expect(rendered).toContain('failing: sums the items');
  });

  it('a reworded repeat widens the evidence with real callers and tests from the worktree', async () => {
    const supervisor = await open(8_192);
    await supervisor.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    const p1 = derivePatchFootprint([computePatchDelta({ path: 'src/total.ts', op: 'replace', before: BASE, content: A })]);
    const p2 = derivePatchFootprint([computePatchDelta({ path: 'src/total.ts', op: 'replace', before: A, content: B })], [computePatchDelta({ path: 'src/total.ts', op: 'replace', before: BASE, content: A })]);
    const d1 = await supervisor.controller.decide(failed(1, p1));
    await supervisor.commit(d1);
    const d2 = await supervisor.controller.decide(failed(2, p2));
    expect(d2.directives.strategy).toBe('widen_evidence');
    // The test file was already shown whole by the first pack, so only the unseen caller is added.
    expect(d2.directives.seedEvidencePaths).toContain('src/cart.ts');
    expect(d2.directives.seedEvidencePaths).not.toContain('src/format.ts');
  });

  it('is reproducible from durable state: a restarted supervisor compiles an equivalent pack', async () => {
    const one = await open(8_192);
    const handle1 = await one.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    const text1 = await handle1.session.renderRecoveryContext();
    const hash1 = one.journal.state.records;

    const two = await open(8_192);
    const handle2 = await two.beginPass({ attemptId: 'att_1', model: { provider: 'ollama', model: 'small:7b' }, goal: GOAL });
    const text2 = await handle2.session.renderRecoveryContext();
    // The second dispatch is pass 2 with the first pass's evidence recorded, so the pack differs only in
    // what durable state says changed; the objective, subgoal and repository sections are identical.
    const section = (text: string, title: string) => new RegExp(`## ${title}\\n([\\s\\S]*?)\\n\\n##`).exec(text)?.[1];
    expect(section(text2, 'Objective')).toBe(section(text1, 'Objective'));
    expect(section(text2, 'Current subgoal')).toBe(section(text1, 'Current subgoal'));
    expect(two.journal.state.subgoalPlan?.planId).toBe(one.journal.state.subgoalPlan?.planId);
    expect(hash1).toBeGreaterThan(0);
  });
});
