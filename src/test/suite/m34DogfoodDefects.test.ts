import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import {
  FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
  FIXED_MULTI_AGENT_STAGES,
  FixedMultiAgentGraph,
} from '../../orchestration/FixedMultiAgentGraph';
import {
  GovernedModelExecutionDependency,
  GovernedModelExecutionDispatcher,
  GovernedModelExecutionOutcome,
} from '../../agent/GovernedModelExecutionDispatcher';
import { GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';
import { parseAndValidateCodingProposal } from '../../coding/CodingProposal';
import { isContractRepairEligible } from '../../coding/GovernedCodingExecutor';
import { classifyRequest } from '../../../core/domain/routing';

const nodeRequire = createRequire(__filename);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const everyday = nodeRequire(path.join(__dirname, '..', '..', '..', 'media', 'everyday-presentation.js'));

/**
 * The verbatim M34 dogfood request (attempt att_e90c4545-d2a2-4b26-ba39-00e90a9a3aa7)
 * that was misrecommended as Baat Kar: its "do not modify …" requirement lines
 * tripped the whole-text negation guard even though the request opens with a
 * clear implementation imperative.
 */
const PACKAGE_PROVENANCE_REQUEST = `Fix the package-provenance defect in this repository.

During npm run verify,
src/test/suite/m12RetrievalIntegrationPackaging.test.ts creates or overwrites
the root karkedikha-win32-x64.vsix. This changes ZIP timestamps and the artifact
hash, making release provenance unreliable.

Change the test so all generated package output and temporary artifacts are
created inside a test-owned temporary directory instead of the repository root.

Requirements:

- do not modify, delete, overwrite, or depend on an existing root VSIX;
- use an isolated temporary output path unique to the test run;
- clean up the temporary directory on both success and failure;
- preserve the original package-content assertions;
- do not weaken packaging validation;
- do not modify .vscodeignore;
- do not introduce bundling;
- do not change production packaging behavior;
- support Windows paths correctly;
- add regression coverage proving an existing root VSIX remains byte-for-byte
  unchanged;
- prove no generated VSIX or temporary packaging artifact remains in the
  repository after the test.

Run the focused packaging test first, then relevant package checks, followed by
the repository verification required by policy.

Deliver one isolated commit containing only the intended test and test-support
changes.

Report:

- root cause;
- files changed;
- temporary-output strategy;
- root VSIX SHA-256 before and after;
- tests and package checks run;
- delivery commit;
- any unresolved limitation.`;

/**
 * The rejected proposal shape reproduced from the dogfood failure: structurally
 * schema-valid, but its npm-script validation command names a script that does
 * not exist in package.json (the model invented "test:packaging").
 */
function reproducedProposal(script: string): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Fix package-provenance defect by isolating test VSIX output to a temporary directory',
    operations: [{
      type: 'replace',
      path: 'src/test/suite/m12RetrievalIntegrationPackaging.test.ts',
      reason: 'Isolate generated VSIX output away from the repository root.',
      content: 'export const placeholder = true;\n',
    }],
    validationCommands: [{ kind: 'npm-script', script }],
    warnings: [],
    status: 'proposed',
  });
}

const WORKSPACE_SCRIPTS = ['compile', 'test', 'validate', 'verify', 'test:extension'];

function dependency(
  impl: (request: GovernedModelRequest) => Promise<GovernedModelExecutionOutcome>,
): GovernedModelExecutionDependency {
  return { execute: vi.fn(impl) };
}

function graphRequest(workspaceRoot?: string) {
  return {
    contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
    invocationId: 'inv_m34_dogfood',
    taskId: 'task_m34_dogfood',
    goal: PACKAGE_PROVENANCE_REQUEST,
    model: 'test-model',
    workspaceRoot,
  };
}

async function workspaceWithScripts(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m34-dogfood-'));
  const scripts = Object.fromEntries(WORKSPACE_SCRIPTS.map(name => [name, 'echo ok']));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts, devDependencies: { vitest: '^4.0.0' } }), 'utf8');
  return root;
}

describe('M34 dogfood regression 1: exact package-provenance request routing', () => {
  it('recommends Karke Dikha in the unified composer for the verbatim dogfood request', () => {
    const reco = everyday.recommendMode(PACKAGE_PROVENANCE_REQUEST);
    expect(reco.mode).toBe('autonomous');
    expect(reco.name).toBe('Karke Dikha');
  });

  it('routes the verbatim dogfood request to karke_dikha in Core', () => {
    expect(classifyRequest(PACKAGE_PROVENANCE_REQUEST).resolvedMode).toBe('karke_dikha');
  });

  it('is not a prompt-specific special case: any clear fix request with negated constraint lines still avoids the negated actions', () => {
    const paraphrase = 'Update the logger config file so retries back off. Do not modify the production logger and do not delete any fixtures.';
    // Unified Conversation V1: this is a bounded edit with no end-to-end
    // delegation signal, so the composer's Auto recommendation now defaults
    // to a governed Saath Kar proposal rather than unattended autonomous
    // execution (see src/orchestration/ExecutionPolicyRouter.ts). Core's
    // classifyRequest is a separate function serving other callers and is
    // deliberately left unchanged (still karke_dikha for any mutation).
    expect(everyday.recommendMode(paraphrase).mode).toBe('agent');
    expect(classifyRequest(paraphrase).resolvedMode).toBe('karke_dikha');
  });

  it('keeps the negation guard: purely negated requests still avoid Karke Dikha', () => {
    const negatedOnly = 'Please do not delete or modify the config file, just tell me what it does.';
    expect(everyday.recommendMode(negatedOnly).mode).toBe('chat');
    expect(classifyRequest(negatedOnly).resolvedMode).not.toBe('karke_dikha');
    expect(everyday.recommendMode("No thank you. Don't create or modify any files.").mode).toBe('chat');
  });
});

describe('M34 dogfood regression 2: fresh tasks never inherit a previous mode selection', () => {
  it('recommendMode is pure — a prior different draft cannot influence a fresh request', () => {
    const baat = everyday.recommendMode('What is a race condition?');
    expect(baat.mode).toBe('chat');
    const fresh = everyday.recommendMode(PACKAGE_PROVENANCE_REQUEST);
    expect(fresh.mode).toBe('autonomous');
    // Same fresh request again, after yet another chat-shaped draft in between.
    everyday.recommendMode('Explain the difference between TCP and UDP.');
    expect(everyday.recommendMode(PACKAGE_PROVENANCE_REQUEST)).toEqual(fresh);
  });

  it('the composer recomputes at submit time and clears the manual override after every submission', () => {
    const js = fsSync.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'chat-everyday.js'), 'utf8');
    // Submission recomputes from the submitted text — never from stale state.
    // `previousPolicyMode()` prefers Core's durable working state over the
    // webview-local `lastPolicyMode` (Durable Conversational Continuity V1);
    // the recompute-at-submit-time invariant this test guards is unchanged.
    expect(js).toContain('recommendation = everyday.recommendMode(text, previousPolicyMode(), previousPolicyIsRestored());');
    // A submission consumes the override so the next task starts fresh…
    expect(js).toMatch(/setPhase\([^)]*\);\s*\n\s*overrideMode = null;/);
    // …and clearing the draft also clears a stale override.
    expect(js).toContain('if (!userInput.value.trim()) overrideMode = null;');
  });
});

describe('M34 dogfood regression 3+4: reproduced proposal rejection and corrected proposal acceptance', () => {
  it('reproduces the host-validation failure for the invented npm script', () => {
    const result = parseAndValidateCodingProposal(reproducedProposal('test:packaging'), WORKSPACE_SCRIPTS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['validation_command_unsupported']);
  });

  it('accepts the corrected proposal that names a real package script', () => {
    const result = parseAndValidateCodingProposal(reproducedProposal('verify'), WORKSPACE_SCRIPTS);
    expect(result.ok).toBe(true);
    expect(result.proposal?.validationCommands).toEqual([{ kind: 'npm-script', script: 'verify' }]);
  });

  it('grounds proposal stages in the host contract, including the real package scripts', async () => {
    const root = await workspaceWithScripts();
    const prompts = new Map<string, string>();
    try {
      const dep = dependency(async modelRequest => {
        const stage = modelRequest.requestId.split(':').pop()!;
        prompts.set(stage, modelRequest.prompt);
        return { completion: stage === 'validator' ? reproducedProposal('verify') : `output from ${stage}` };
      });
      const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep));

      const result = await graph.execute(graphRequest(root));

      expect(result.status).toBe('completed');
      expect(result.proposalConsumption?.status).toBe('ready');
      for (const stage of ['implementer', 'reviewer', 'validator']) {
        expect(prompts.get(stage), stage).toContain('Host contract for the CodingProposal');
        expect(prompts.get(stage), stage).toContain('verify, test:extension');
        expect(prompts.get(stage), stage).toContain('Never invent npm script names');
        // Repository conventions the schema cannot express: the real test runner.
        expect(prompts.get(stage), stage).toContain("run under vitest");
      }
      for (const stage of ['repository-analyst', 'planner']) {
        expect(prompts.get(stage), stage).not.toContain('Host contract for the CodingProposal');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('one bounded validator regeneration turns the reproduced rejection into a host-valid proposal', async () => {
    const root = await workspaceWithScripts();
    try {
      const dep = dependency(async modelRequest => {
        if (modelRequest.requestId.endsWith(':validator-repair')) {
          expect(modelRequest.prompt).toContain('validation_command_unsupported');
          return { completion: reproducedProposal('verify') };
        }
        const stage = modelRequest.requestId.split(':').pop()!;
        return { completion: stage === 'validator' ? reproducedProposal('test:packaging') : `output from ${stage}` };
      });
      const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep));
      const request = graphRequest(root);

      const first = await graph.execute(request);
      expect(first.proposalConsumption?.status).toBe('invalid');
      expect(first.proposalConsumption?.errors).toEqual(['validation_command_unsupported']);
      expect(isContractRepairEligible(first.proposalConsumption?.errors ?? [])).toBe(true);

      const repaired = await graph.regenerateValidatorProposal(
        request,
        first.finalValidatorOutput!,
        'Host contract validation rejected it with: validation_command_unsupported.',
      );
      expect(repaired.status).toBe('ready');
      expect(repaired.proposal?.validationCommands).toEqual([{ kind: 'npm-script', script: 'verify' }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('tells proposal stages not to assume a test framework when package.json names none, including on the bounded repair prompt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m34-no-framework-'));
    try {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }), 'utf8');
      const prompts = new Map<string, string>();
      const dep = dependency(async modelRequest => {
        if (modelRequest.requestId.endsWith(':validator-repair')) {
          prompts.set('validator-repair', modelRequest.prompt);
          return { completion: reproducedProposal('verify') };
        }
        const stage = modelRequest.requestId.split(':').pop()!;
        prompts.set(stage, modelRequest.prompt);
        return { completion: stage === 'validator' ? reproducedProposal('verify') : `output from ${stage}` };
      });
      const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep));
      const request = graphRequest(root);
      await graph.execute(request);

      for (const stage of ['implementer', 'reviewer', 'validator']) {
        expect(prompts.get(stage), stage).toContain('Do not assume any test framework\'s globals');
        expect(prompts.get(stage), stage).not.toMatch(/run under (vitest|jest|mocha)/);
      }

      // The same generic (non-fixture-specific) guidance reaches the bounded
      // repair prompt too — it is built through the same hostContractPromptBlock.
      const repaired = await graph.regenerateValidatorProposal(
        request,
        reproducedProposal('verify'),
        'Validation failed: some real command evidence.',
      );
      expect(repaired.status).toBe('ready');
      const repairPrompt = (dep.execute as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].prompt as string;
      expect(repairPrompt).toContain('Do not assume any test framework\'s globals');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('M34 dogfood regression 5: malformed and unsafe proposals still fail closed', () => {
  it('rejects malformed model output', () => {
    expect(parseAndValidateCodingProposal('not json at all', WORKSPACE_SCRIPTS).ok).toBe(false);
    expect(parseAndValidateCodingProposal('{"version":1', WORKSPACE_SCRIPTS).ok).toBe(false);
  });

  it('security and resource-limit rejections are never repair-eligible', () => {
    expect(isContractRepairEligible(['path_traversal_rejected'])).toBe(false);
    expect(isContractRepairEligible(['credential_path_rejected'])).toBe(false);
    expect(isContractRepairEligible(['prototype_pollution_rejected'])).toBe(false);
    expect(isContractRepairEligible(['total_byte_limit_exceeded'])).toBe(false);
    expect(isContractRepairEligible(['validation_command_unsupported', 'path_traversal_rejected'])).toBe(false);
    expect(isContractRepairEligible([])).toBe(false);
  });

  it('an unsafe path is rejected by host validation regardless of prompt grounding', () => {
    const traversal = JSON.parse(reproducedProposal('verify'));
    traversal.operations[0].path = '../outside/escape.ts';
    const result = parseAndValidateCodingProposal(JSON.stringify(traversal), WORKSPACE_SCRIPTS);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('path_traversal_rejected');
  });
});

describe('M34 dogfood regression: approved validation build outputs are not misflagged as side effects', () => {
  it('allows the repository’s own build-output roots while still flagging source writes', async () => {
    const { ValidationSideEffectDetector } = await import('../../coding/ExecutionIntegrity');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m34-sideeffect-'));
    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
      const detector = new ValidationSideEffectDetector(root, []);
      await detector.capture();
      // Approved validation commands produce these; none is a source mutation.
      await fs.mkdir(path.join(root, 'out-core'), { recursive: true });
      await fs.writeFile(path.join(root, 'out-core', 'core.js'), 'bundled', 'utf8');
      await fs.mkdir(path.join(root, 'out-core-tsc'), { recursive: true });
      await fs.writeFile(path.join(root, 'out-core-tsc', 'core.js'), 'compiled', 'utf8');
      await fs.writeFile(path.join(root, 'karkedikha-win32-x64.vsix'), 'zip', 'utf8');
      await fs.mkdir(path.join(root, '.ollama-agent', 'index'), { recursive: true });
      await fs.writeFile(path.join(root, '.ollama-agent', 'index', 'repository-intelligence.sqlite'), 'index', 'utf8');
      expect(await detector.detect()).toEqual([]);
      // A genuine source write is still flagged.
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
      expect(await detector.detect()).toEqual(['src/a.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('M34 dogfood regression 6: proposal rejection causes no duplication and no repository mutation', () => {
  it('a rejected proposal leaves exactly one dispatch per stage and the workspace untouched', async () => {
    const root = await workspaceWithScripts();
    try {
      const before = (await fs.readdir(root)).sort();
      const dep = dependency(async modelRequest => {
        const stage = modelRequest.requestId.split(':').pop()!;
        return { completion: stage === 'validator' ? reproducedProposal('test:packaging') : `output from ${stage}` };
      });
      const graph = new FixedMultiAgentGraph(new GovernedModelExecutionDispatcher(dep));

      const result = await graph.execute(graphRequest(root));

      expect(result.proposalConsumption?.status).toBe('invalid');
      const dispatched = (dep.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].requestId);
      expect(dispatched).toHaveLength(FIXED_MULTI_AGENT_STAGES.length);
      expect(new Set(dispatched).size).toBe(dispatched.length);
      expect((await fs.readdir(root)).sort()).toEqual(before);
      const persisted = await fs.readFile(path.join(root, 'package.json'), 'utf8');
      expect(JSON.parse(persisted).scripts.verify).toBe('echo ok');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
