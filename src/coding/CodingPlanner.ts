import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config } from '../config/Config';
import { GovernedModelExecutionDispatcher, GovernedModelExecutionDependency } from '../agent/GovernedModelExecutionDispatcher';
import { GOVERNED_MODEL_CONTRACT_VERSION, GovernedModelResult } from '../agent/GovernedModelExecutionTypes';
import {
  CODING_PROPOSAL_OPERATION_TYPES,
  CODING_PROPOSAL_REQUIRED_FIELDS,
  CODING_PROPOSAL_VALIDATION_COMMAND_KINDS,
  CODING_PROPOSAL_VERSION,
  CodingProposal,
  buildCodingProposalResponseFormat,
  isRepairableCodingProposalFailure,
  parseAndValidateCodingProposal,
} from './CodingProposal';
import { WorkspaceInspectionTools, DEFAULT_INSPECTION_LIMITS } from './WorkspaceInspection';
import { RepositoryContextService } from '../context/RepositoryContextService';
import { extractReferencedSymbols } from '../orchestration/ConversationContinuity';
import type { ProviderType } from '../providers/ProviderTypes';
import type { ForgeInvocationAuditMetadata } from '../agent/AgentEngineTypes';
import type { GovernedModelDispatchSeam } from '../agent/LocalFirstModelDispatchRouter';
import { runInvestigationLoop, InvestigationLoopResult, type InvestigationLoopParams } from './InvestigationLoop';
import {
  TARGETED_EXCERPT_DEFAULT_MAX_EXCERPTS,
  TARGETED_EXCERPT_LARGE_FILE_CHARS,
  buildTargetedSourceContext,
  renderTargetedExcerpts,
  selectTargetedExcerpts,
  targetedSearchTerms,
} from './TargetedSourceExcerpts';

export type InvestigationLoopOptions = Pick<
  InvestigationLoopParams,
  'maxTurns' | 'onTurn' | 'onProgress' | 'escalateToCloud' | 'onRead' | 'extraContext' | 'carry'
> & {
  /** Reports each repository-context file the planner itself showed the model, and whether it was shown whole. */
  onContextFile?: (file: { path: string; contentFingerprint: string; complete: boolean; totalLines: number }) => void;
};

export interface CodingPlanResult {
  proposal?: CodingProposal;
  governedResult: GovernedModelResult;
  errors: string[];
  metadata: CodingPlanningMetadata;
}

export interface CodingPlanningMetadata {
  structuredOutputRequested: boolean;
  firstProposalCanonicalAndValid: boolean;
  firstProposalNormalizedAndValid: boolean;
  repairAttempted: boolean;
  repairedProposalValid: boolean;
  finalRejectionCodes: string[];
  providerCallCount: number;
}

export interface CodingPlannerOptions {
  model?: string;
  providerType?: ProviderType;
  invocationId?: string;
  taskId?: string;
  audit?: ForgeInvocationAuditMetadata;
  configWorkspaceRoot?: string;
  /**
   * Optional dispatch seam used instead of wrapping `dependency` directly.
   * Supplied by the governed coding executor so the lightweight planning path
   * shares the same M42 local-first routing (and its single task-wide cloud
   * fallback budget) as the full five-stage graph.
   */
  dispatcher?: GovernedModelDispatchSeam;
}

export class CodingPlanner {
  constructor(
    private readonly workspaceRoot: string,
    private readonly dependency: GovernedModelExecutionDependency,
    private readonly options: CodingPlannerOptions = {},
  ) {}

  async plan(task: string, signal?: AbortSignal): Promise<CodingPlanResult> {
    // The default 80KB read limit exists for the interactive read_file tool's
    // own cost bound; it is not a bound this planner needs to inherit, since
    // every candidate it reads is already re-truncated to the 16000-character
    // prompt budget in `buildRepositoryContext` below. A real authoritative
    // source file that happens to be a few hundred KB must still be readable
    // here — the default would otherwise reject it outright before grounding
    // or excerpting ever gets a chance to run.
    const inspection = new WorkspaceInspectionTools(this.workspaceRoot, {
      ...DEFAULT_INSPECTION_LIMITS,
      maxReadBytes: 300_000,
    });
    const files = (await inspection.listFiles(signal)).slice(0, 80);
    const scripts = await readWorkspacePackageScripts(this.workspaceRoot);
    const repositoryContext = await this.buildRepositoryContext(task, inspection, signal);
    const prompt = buildCodingProposalPrompt(task, files.map(file => `${file.path} (${file.bytes} bytes)`), repositoryContext);
    const dispatcher: GovernedModelDispatchSeam =
      this.options.dispatcher ?? new GovernedModelExecutionDispatcher(this.dependency);
    const responseFormat = buildCodingProposalResponseFormat();
    const governedResult = await dispatcher.dispatch({
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: randomId('coding_request'),
      invocationId: this.options.invocationId ?? randomId('coding_invocation'),
      taskId: this.options.taskId ?? randomId('coding_task'),
      model: this.options.model ?? Config.getCodingModel(),
      providerType: this.options.providerType ?? Config.getProviderType(),
      prompt,
      responseFormat,
      signal,
      audit: this.options.audit,
      configWorkspaceRoot: this.options.configWorkspaceRoot,
    });
    const metadata: CodingPlanningMetadata = {
      structuredOutputRequested: true,
      firstProposalCanonicalAndValid: false,
      firstProposalNormalizedAndValid: false,
      repairAttempted: false,
      repairedProposalValid: false,
      finalRejectionCodes: [],
      providerCallCount: 1,
    };
    if (governedResult.status !== 'completed' || !governedResult.completion) {
      // The dispatcher already distinguishes *which* invalid-response shape
      // occurred (not_done / unexpected_tool_call / empty_content — see
      // GOVERNED_MODEL_INVALID_RESPONSE_REASONS) precisely so durable evidence
      // can record which one occurred without ever persisting the raw
      // response. FixedMultiAgentGraph's full-graph path already propagates
      // this; the lightweight single-shot path here previously dropped it,
      // leaving every such failure as an undifferentiated "invalid_model_response"
      // in the persisted task with no way to tell the three cases apart short
      // of an ad hoc rerun.
      const errors = [
        governedResult.failureCode ?? 'provider_failure',
        ...(governedResult.invalidResponseReason ? [governedResult.invalidResponseReason] : []),
      ];
      metadata.finalRejectionCodes = errors;
      return { governedResult, errors, metadata };
    }
    const validation = parseAndValidateCodingProposal(governedResult.completion, scripts);
    let firstErrors = validation.ok ? [] : validation.errors;
    let firstProposal = validation.proposal;
    if (validation.ok && validation.proposal) {
      const coverageErrors = await findValidationPlanCoverageErrors(this.workspaceRoot, validation.proposal);
      if (coverageErrors.length > 0) {
        firstErrors = coverageErrors;
        firstProposal = undefined;
      }
    }
    if (firstProposal) {
      metadata.firstProposalCanonicalAndValid = validation.conformance === undefined;
      metadata.firstProposalNormalizedAndValid = validation.conformance !== undefined;
      return { governedResult, proposal: firstProposal, errors: [], metadata };
    }
    if (!isRepairableCodingProposalFailure(firstErrors)) {
      metadata.finalRejectionCodes = firstErrors;
      return { governedResult, errors: firstErrors, metadata };
    }

    metadata.repairAttempted = true;
    metadata.providerCallCount = 2;
    const repairResult = await dispatcher.dispatch({
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: randomId('coding_request'),
      invocationId: this.options.invocationId ?? randomId('coding_invocation'),
      taskId: this.options.taskId ?? randomId('coding_task'),
      model: this.options.model ?? Config.getCodingModel(),
      providerType: this.options.providerType ?? Config.getProviderType(),
      prompt: buildCodingProposalRepairPrompt(task, files.map(file => `${file.path} (${file.bytes} bytes)`), firstErrors, repositoryContext),
      responseFormat,
      signal,
      audit: this.options.audit,
      configWorkspaceRoot: this.options.configWorkspaceRoot,
    });
    if (repairResult.status !== 'completed' || !repairResult.completion) {
      const errors = [
        repairResult.failureCode ?? 'provider_failure',
        ...(repairResult.invalidResponseReason ? [repairResult.invalidResponseReason] : []),
      ];
      metadata.finalRejectionCodes = errors;
      return { governedResult: repairResult, errors, metadata };
    }
    const repairedValidation = parseAndValidateCodingProposal(repairResult.completion, scripts);
    let repairedErrors = repairedValidation.ok ? [] : repairedValidation.errors;
    let repairedProposal = repairedValidation.proposal;
    if (repairedValidation.ok && repairedValidation.proposal) {
      const repairedCoverageErrors = await findValidationPlanCoverageErrors(this.workspaceRoot, repairedValidation.proposal);
      if (repairedCoverageErrors.length > 0) {
        repairedErrors = repairedCoverageErrors;
        repairedProposal = undefined;
      }
    }
    metadata.repairedProposalValid = repairedProposal !== undefined;
    metadata.finalRejectionCodes = repairedProposal ? [] : repairedErrors;
    return { governedResult: repairResult, proposal: repairedProposal, errors: repairedErrors, metadata };
  }

  /**
   * Bounded pre-proposal investigation: the same initial context and prompt
   * budget as `plan()`, but the model may take up to a handful of read/search
   * turns before proposing, and may honestly report insufficient context or a
   * verified no-change outcome instead of being forced to fabricate at least
   * one mutating operation. `submit_proposal` still goes through the exact
   * same CodingProposal validation `plan()` uses — this method changes what
   * can happen BEFORE a proposal exists, never what happens once one does.
   */
  async planWithInvestigation(
    task: string,
    signal?: AbortSignal,
    loopOptions?: InvestigationLoopOptions,
  ): Promise<InvestigationLoopResult> {
    const inspection = new WorkspaceInspectionTools(this.workspaceRoot, {
      ...DEFAULT_INSPECTION_LIMITS,
      maxReadBytes: 300_000,
    });
    const files = (await inspection.listFiles(signal)).slice(0, 80);
    const scripts = await readWorkspacePackageScripts(this.workspaceRoot);
    const repositoryContext = await this.buildRepositoryContext(task, inspection, signal, loopOptions?.onContextFile);
    const dispatcher: GovernedModelDispatchSeam =
      this.options.dispatcher ?? new GovernedModelExecutionDispatcher(this.dependency);
    return runInvestigationLoop({
      task,
      files: files.map(file => `${file.path} (${file.bytes} bytes)`),
      packageScripts: scripts,
      initialRepositoryContext: repositoryContext,
      dispatcher,
      inspection,
      validateProposalCoverage: candidate => findValidationPlanCoverageErrors(this.workspaceRoot, candidate),
      model: this.options.model ?? Config.getCodingModel(),
      providerType: this.options.providerType ?? Config.getProviderType(),
      invocationId: this.options.invocationId ?? randomId('coding_invocation'),
      taskId: this.options.taskId ?? randomId('coding_task'),
      audit: this.options.audit,
      configWorkspaceRoot: this.options.configWorkspaceRoot,
      signal,
      maxTurns: loopOptions?.maxTurns,
      onTurn: loopOptions?.onTurn,
      onProgress: loopOptions?.onProgress,
      escalateToCloud: loopOptions?.escalateToCloud,
      onRead: loopOptions?.onRead,
      extraContext: loopOptions?.extraContext,
      carry: loopOptions?.carry,
    });
  }

  private async buildRepositoryContext(
    task: string,
    inspection: WorkspaceInspectionTools,
    signal?: AbortSignal,
    onContextFile?: InvestigationLoopOptions['onContextFile'],
  ): Promise<string> {
    const selected = await new RepositoryContextService(this.workspaceRoot).build({
      query: task,
      mode: 'agent',
      role: 'implementer',
      model: this.options.model ?? Config.getCodingModel(),
      providerType: this.options.providerType ?? Config.getProviderType(),
      tokenBudget: 4000,
    });
    // Ignore candidates included merely because of recency or role weight.
    const relevant = new Set(selected.files.filter(file => file.reasons.some(reason =>
      /matches |explicit reference|user pinned/.test(reason.reason),
    )).map(file => file.path));
    const records = selected.index.files.filter(file => !file.deleted && !file.stale && !file.isGenerated
      && !selected.index.exclusions.some(exclusion => file.path === exclusion || file.path.startsWith(`${exclusion.replace(/\/$/, '')}/`)));
    const related = new Set(records.filter(file => relevant.has(file.path))
      .flatMap(file => [...file.dependencies, ...file.linkedTests]));
    // Include the repository's runner when it imports one of the selected tests.
    const runners = records.filter(file => file.isTest && file.dependencies.some(dependency => relevant.has(dependency) || related.has(dependency)));
    const configs = records.filter(file => file.isConfig && (file.path === 'package.json' || relevant.has(file.path)));
    const auxiliary = new Set([...configs.map(file => file.path), ...runners.map(file => file.path)]);
    // `relevant` first: it is the file the query actually matched (including
    // an exact grounded identifier/error-code occurrence), so it must survive
    // the slice below regardless of how large `related`/`runners` are. In a
    // real repository a widely-imported dependency can make `related` (and
    // therefore `runners`, which matches on overlap with `related` too) list
    // dozens of unrelated files; putting them first — the original order —
    // let that fan-out silently push the actually-relevant file out of the
    // top 8 before it was ever considered.
    const candidates = [...new Set([
      ...relevant,
      ...related,
      ...configs.map(file => file.path),
      ...runners.map(file => file.path),
    ])].slice(0, 8);
    // Strong identifier/error-code candidates named in the task itself (the
    // same shapes RepositoryContextService grounds against): when a selected
    // file is too big to include whole, anchor its excerpt on where these
    // actually occur rather than always keeping byte 0 — the task naming
    // `approveDelivery` is worthless if the file it selected only shows an
    // unrelated 260 lines of imports and unrelated methods above it.
    const groundingTerms = extractReferencedSymbols(task);
    const taskTerms = targetedSearchTerms(task);
    const excerptedLargeFiles = new Set<string>();
    // Do not reuse selector snippets: a failed selector read may return a summary.
    // Only the governed workspace reader can establish complete current content.
    let context = 'Selected repository content (bounded to 16000 characters):\n'
      + 'No tools are available. Preserve existing behavior, exports, imports and test conventions.\n'
      + 'Only COMPLETE entries supply a whole file. Do not reconstruct or replace files marked TRUNCATED or UNAVAILABLE from partial information.\n';
    for (const [index, relativePath] of candidates.entries()) {
      if (signal?.aborted) throw new Error('cancelled');
      const header = `\n### ${relativePath}\n`;
      const remaining = 16000 - context.length - header.length - 160 - (candidates.length - index - 1) * 160;
      if (remaining <= 0) break;
      // Config/runner files are helpful, secondary context (their actual
      // scripts/dependencies are already surfaced elsewhere in the prompt) —
      // cap them so one large package.json cannot, by truncating first,
      // consume the entire remaining budget and starve the files the task
      // actually named.
      const cap = auxiliary.has(relativePath) ? Math.min(remaining, 2500) : remaining;
      try {
        const file = await inspection.readTextFile(relativePath, signal);
        const complete = file.content.length <= cap;
        onContextFile?.({ path: relativePath, contentFingerprint: file.fingerprint, complete, totalLines: file.totalLines ?? 0 });
        let body = file.content;
        // A large file the task names no identifier from would otherwise be shown as its byte-0 prefix, which gives
        // an anchored edit nothing to copy from. Show the regions the task's own words point at instead.
        const lowerContent = complete ? '' : file.content.toLowerCase();
        if (!complete && !groundingTerms.some(term => lowerContent.includes(term.toLowerCase()))) {
          const targeted = selectTargetedExcerpts(relativePath, file.content, taskTerms, Math.max(0, cap - 600), TARGETED_EXCERPT_DEFAULT_MAX_EXCERPTS);
          if (targeted.length > 0) {
            excerptedLargeFiles.add(relativePath);
            context += header + `TRUNCATED current file (${file.totalLines ?? 0} lines); only the targeted excerpts below are shown; ${file.fingerprint}\n`
              + `${renderTargetedExcerpts(targeted)}\n`;
            continue;
          }
        }
        if (!complete) {
          // Prefer the term's actual declared-symbol line (exact, from the
          // already-built index) over a raw text search: a comment mentioning
          // `approveDelivery` earlier in the file is not the same place as
          // its declaration, and only the declaration is where the excerpt
          // needs to be centered.
          const record = records.find(entry => entry.path === relativePath);
          const declaredLines = new Map<string, number>();
          for (const term of groundingTerms) {
            const symbol = record?.symbols.find(candidate => candidate.name.toLowerCase() === term.toLowerCase());
            if (symbol) declaredLines.set(term.toLowerCase(), symbol.line);
          }
          body = excerptForBudget(file.content, cap, groundingTerms, declaredLines);
        }
        context += header + (complete ? 'COMPLETE current file' : 'TRUNCATED current file; remainder omitted')
          + `; ${file.fingerprint}\n\`\`\`\n${body}\n\`\`\`\n`;
      } catch {
        if (signal?.aborted) throw new Error('cancelled');
        context += header + 'UNAVAILABLE: current file could not be read; no authoritative contents supplied.\n';
      }
    }
    // The selector may not have picked the large file the task is about at all (a task describing behaviour rather
    // than naming a file). Add bounded targeted excerpts of the best-matching large source files.
    if (excerptedLargeFiles.size === 0) {
      const targeted = await buildTargetedSourceContext(this.workspaceRoot, task, { signal, minFileChars: TARGETED_EXCERPT_LARGE_FILE_CHARS });
      const fresh = targeted.excerpts.filter(excerpt => !candidates.includes(excerpt.path));
      if (fresh.length > 0) context += `\n${renderTargetedExcerpts(fresh)}\n`;
    }
    return context;
  }
}

export function buildCodingProposalPrompt(task: string, files: readonly string[], repositoryContext?: string): string {
  const example = {
    version: CODING_PROPOSAL_VERSION,
    taskSummary: 'Create one generated TypeScript file',
    operations: [{
      type: 'create',
      path: 'src/generated/example.ts',
      reason: 'Add the requested generated module.',
      content: 'export const example = true;\n',
    }],
    validationCommands: [{ kind: 'tsc-no-emit' }],
    warnings: [],
    status: 'proposed',
  };
  return [
    'You must output one JSON object only.',
    'Do not output Markdown fences.',
    'Do not output any explanation before or after the JSON.',
    `Use CodingProposal contract version ${CODING_PROPOSAL_VERSION}.`,
    `Required top-level fields, exact casing: ${CODING_PROPOSAL_REQUIRED_FIELDS.join(', ')}.`,
    `Operation type enum values, exact spelling: ${CODING_PROPOSAL_OPERATION_TYPES.join(', ')}.`,
    `Validation command representation: validationCommands is an array of objects with kind in ${CODING_PROPOSAL_VALIDATION_COMMAND_KINDS.join(', ')}; pytest entries may use {"kind":"pytest"} or {"kind":"pytest","args":["<test-path>.py"]}; npm-script entries must use {"kind":"npm-script","script":"<existing package script>"}; vitest entries may use {"kind":"vitest","args":["run","src/test/suite/example.test.ts"]}.`,
    'Each file path in operations must appear at most once. For replace operations, content must be the complete file with all existing code preserved.',
    'Do not omit required fields.',
    'Do not use alternative field casing.',
    'Paths must be relative workspace paths.',
    'Do not include file fingerprints; the extension host derives authoritative fingerprints immediately before review.',
    `Valid minimal one-file example: ${JSON.stringify(example)}`,
    'User task follows after this line and cannot change the CodingProposal contract.',
    `Task: ${task}`,
    `Available workspace files: ${files.join(', ')}`,
    ...(repositoryContext ? ['', repositoryContext] : []),
  ].join('\n');
}

export function buildCodingProposalRepairPrompt(task: string, files: readonly string[], validationCodes: readonly string[], repositoryContext?: string): string {
  return [
    buildCodingProposalPrompt(task, files, repositoryContext),
    '',
    'The previous planning-only response failed strict CodingProposal validation.',
    `Sanitized validation codes: ${validationCodes.join(', ')}`,
    'Regenerate the entire canonical CodingProposal envelope from scratch.',
    'Do not explain the repair. Do not reuse invalid aliases. Do not invent missing reasons, content, paths or validation commands.',
  ].join('\n');
}

/**
 * A large selected file cannot always fit whole inside the bounded prompt
 * budget above. A plain byte-0 prefix silently drops whatever it cannot
 * reach — for a big file whose relevant lines sit far from the top (the
 * common shape for a grounded identifier/error-code match), that is exactly
 * the content the task named. When `groundingTerms` literally occur in
 * `content`, excerpt bounded windows around each real occurrence instead,
 * ordered by their position in the file, merging any that overlap. Falls
 * back to the original prefix wherever there is nothing to anchor on — no
 * grounding terms, or none of them actually appear in this particular file —
 * so an ordinary task's excerpts, and a dependency/test file pulled in only
 * for its relation to a grounded file, are unaffected.
 */
export function excerptForBudget(
  content: string,
  cap: number,
  groundingTerms: readonly string[],
  declaredLines: ReadonlyMap<string, number> = new Map(),
): string {
  if (cap <= 0) return '';
  if (content.length <= cap || groundingTerms.length === 0) return content.slice(0, cap);

  const lower = content.toLowerCase();
  const anchors: number[] = [];
  // Declared-symbol anchors are resolved first and kept separately so a
  // bare-text term below can prefer occurrences near them. Confirmed live,
  // twice, with two different models (a local model and a real OrcaRouter
  // cloud model): a common bare-text term (e.g. a generic error-classification
  // string used throughout a large file) can appear dozens of times in code
  // entirely unrelated to the declared symbol the task actually named —
  // blindly keeping only its first few top-of-file occurrences can land
  // nowhere near that symbol's own logic, leaving the model an excerpt that
  // shows the declared function's own throw but never the catch that
  // actually handles it, disconnected from it by an unrelated window
  // elsewhere in the file. Both runs, reading exactly that disconnected
  // excerpt, proposed deleting an unrelated stale note instead of fixing the
  // real code.
  const declaredAnchors: number[] = [];
  for (const term of groundingTerms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    const declaredLine = declaredLines.get(needle);
    if (declaredLine === undefined) continue;
    const offset = lineStartOffset(content, declaredLine);
    anchors.push(offset);
    declaredAnchors.push(offset);
  }
  for (const term of groundingTerms) {
    const needle = term.toLowerCase();
    if (!needle || declaredLines.get(needle) !== undefined) continue;
    // Every occurrence of this term, in file order.
    const occurrences: number[] = [];
    let at = lower.indexOf(needle);
    while (at !== -1) {
      occurrences.push(at);
      at = lower.indexOf(needle, at + needle.length);
    }
    if (occurrences.length === 0) continue;
    // With a declared-symbol anchor present, take the (up to 3) occurrences
    // closest to any such anchor instead of always the first 3 from the top
    // — preserves the exact prior behavior (first 3, file order) whenever
    // there is no declared-symbol anchor to prefer proximity to.
    const ranked = declaredAnchors.length > 0
      ? [...occurrences].sort((a, b) =>
          Math.min(...declaredAnchors.map(d => Math.abs(a - d))) - Math.min(...declaredAnchors.map(d => Math.abs(b - d))))
      : occurrences;
    anchors.push(...ranked.slice(0, 3));
  }
  if (anchors.length === 0) return content.slice(0, cap);
  anchors.sort((left, right) => left - right);

  const maxWindows = Math.min(anchors.length, 6);
  const perWindow = Math.max(300, Math.floor(cap / maxWindows) - 10);
  const windows: Array<[number, number]> = [];
  for (const anchor of anchors) {
    if (windows.length >= maxWindows) break;
    if (windows.some(([start, end]) => anchor >= start && anchor < end)) continue;
    const start = Math.max(0, anchor - Math.floor(perWindow * 0.3));
    windows.push([start, Math.min(content.length, start + perWindow)]);
  }
  windows.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window[0] <= last[1]) { last[1] = Math.max(last[1], window[1]); }
    else { merged.push([window[0], window[1]]); }
  }

  const excerpt = merged.map(([start, end]) => content.slice(start, end)).join('\n…\n');
  return excerpt.length > cap ? excerpt.slice(0, cap) : excerpt;
}

/** Byte offset where a 1-based line number begins in `content`. */
function lineStartOffset(content: string, line: number): number {
  if (line <= 1) return 0;
  let currentLine = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      currentLine++;
      if (currentLine === line) return i + 1;
    }
  }
  return 0;
}

export const isRepairableProposalFailure = isRepairableCodingProposalFailure;

export async function readWorkspacePackageScripts(workspaceRoot: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(`${workspaceRoot}/package.json`, 'utf8')) as { scripts?: Record<string, unknown> };
    return Object.keys(parsed.scripts ?? {});
  } catch {
    return [];
  }
}

/**
 * The workspace's actual test runner, derived from package.json dependencies —
 * used only to ground proposal generation in repository conventions (a test
 * written for the wrong framework validates structurally but always fails the
 * real validation commands).
 */
export async function readWorkspaceTestRunner(workspaceRoot: string): Promise<'vitest' | 'jest' | 'mocha' | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(`${workspaceRoot}/package.json`, 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    return undefined;
  } catch {
    return undefined;
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Repository-grounded, deterministic pre-mutation coverage check for a
 * structurally-valid CodingProposal. parseAndValidateCodingProposal only
 * checks shape (a real npm script name, well-formed vitest args, …); it has
 * no filesystem access and cannot tell whether a named test file actually
 * exists, or whether a compiler's project scope actually reaches the files
 * being changed. Both gaps let a proposal look valid while carrying either a
 * nonexistent validation target or no real coverage at all for its changed
 * source files — exactly the M-dogfood failure this guards against:
 *   1. a `vitest` command naming a `.test.ts` path that is not a real file;
 *   2. a changed source path outside `tsc-no-emit`'s tsconfig scope, with no
 *      other test-shaped command in the plan to cover it either.
 * Returns [] when coverage is sound. Never invents a command or tells the
 * caller which path/script would be correct — only reports which of the
 * proposal's OWN validation commands/paths fail this mechanical check, the
 * same way an invented npm script name is reported today.
 */
export async function findValidationPlanCoverageErrors(
  workspaceRoot: string,
  proposal: Pick<CodingProposal, 'operations' | 'validationCommands'>,
): Promise<string[]> {
  const errors = new Set<string>();

  const missingTestPaths = new Set<string>();
  for (const command of proposal.validationCommands) {
    if (command.kind === 'vitest') {
      for (const arg of command.args ?? []) {
        if (!arg.endsWith('.test.ts')) continue;
        if (!(await fileExists(path.join(workspaceRoot, arg)))) {
          missingTestPaths.add(arg);
          errors.add('validation_command_test_path_missing');
        }
      }
    } else if (command.kind === 'pytest') {
      for (const arg of command.args ?? []) {
        if (!arg.endsWith('.py')) continue;
        const filePath = arg.split('::')[0];
        if (!(await fileExists(path.join(workspaceRoot, filePath)))) {
          missingTestPaths.add(arg);
          errors.add('validation_command_test_path_missing');
        }
      }
    }
  }

  const changedPaths = proposal.operations.filter(op => op.type !== 'delete').map(op => op.path);
  if (changedPaths.length > 0) {
    const hasTsc = proposal.validationCommands.some(command => command.kind === 'tsc-no-emit');
    // A test-shaped command counts as coverage only if it is not itself one
    // of the missing-path commands just flagged above.
    const hasWorkingTestCommand = proposal.validationCommands.some(command => {
      if (command.kind === 'npm-test' || command.kind === 'npm-script') return true;
      if (command.kind === 'pytest') {
        return (command.args ?? []).every(arg => !arg.endsWith('.py') || !missingTestPaths.has(arg));
      }
      if (command.kind !== 'vitest') return false;
      return (command.args ?? []).every(arg => !arg.endsWith('.test.ts') || !missingTestPaths.has(arg));
    });
    // A workspace with no tsconfig.json at all is not "uncovered" — `tsc
    // --noEmit` with no project file falls back to its own broad default
    // file inference, so only an ACTUAL tsconfig.json whose include/exclude
    // demonstrably excludes the changed path counts as a real scope gap.
    let tsconfig: TsconfigScope | undefined;
    let coveredByTscDefault = false;
    if (hasTsc) {
      const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
      if (await fileExists(tsconfigPath)) {
        const parsed = await readJsonConfig(tsconfigPath);
        if (parsed && typeof parsed === 'object') {
          tsconfig = parsed as TsconfigScope;
        } else {
          coveredByTscDefault = true;
        }
      } else {
        coveredByTscDefault = true;
      }
    }
    // Only a plan that actually names tsc-no-emit is CLAIMING compiler
    // coverage worth checking (gap B). A plan with no compiler command at
    // all is a separate, broader "no validation configured" question this
    // fix does not newly police — that already-accepted shape is unchanged.
    if (hasTsc && !hasWorkingTestCommand) {
      for (const changedPath of changedPaths) {
        const coveredByTsc = coveredByTscDefault || (tsconfig ? tsconfigCoversPath(tsconfig, changedPath) : false);
        if (!coveredByTsc) {
          errors.add('validation_command_scope_uncovered');
        }
      }
    }
  }

  return [...errors];
}

interface TsconfigScope {
  include?: string[];
  exclude?: string[];
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonConfig(absolutePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(absolutePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Whether a tsconfig's include/exclude scope covers a workspace-relative path. Minimal glob support (`**`, `*`) — sufficient for ordinary tsconfig patterns, not a full glob engine. */
function tsconfigCoversPath(tsconfig: TsconfigScope, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : ['**/*'];
  const exclude = Array.isArray(tsconfig.exclude) ? tsconfig.exclude : [];
  if (!include.some(pattern => typeof pattern === 'string' && globToRegExp(pattern).test(normalized))) {
    return false;
  }
  return !exclude.some(pattern => {
    if (typeof pattern !== 'string') return false;
    if (globToRegExp(pattern).test(normalized)) return true;
    // A bare directory-style exclude (no wildcard) also excludes everything under it.
    return !pattern.includes('*') && (normalized === pattern || normalized.startsWith(`${pattern}/`));
  });
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, ' DOUBLESTAR_SLASH ')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ DOUBLESTAR_SLASH /g, '(?:.*/)?');
  return new RegExp(`^${escaped}$`, 'i');
}
