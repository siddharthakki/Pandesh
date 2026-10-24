import { describe, expect, it } from 'vitest';
import {
  CODING_PROPOSAL_OPERATION_TYPES,
  CODING_PROPOSAL_VALIDATION_COMMAND_KINDS,
  CODING_PROPOSAL_VERSION,
  buildCodingProposalJsonSchema,
  fingerprintText,
  detectWorkspaceValidationPolicy,
  isRepairableCodingProposalFailure,
  parseAndValidateCodingProposal,
} from '../../coding/CodingProposal';

const scripts = ['verify', 'compile', 'test'];

function proposal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Add generated constant',
    operations: [{
      type: 'create',
      path: 'src/generated/example.ts',
      reason: 'requested',
      content: 'export const value = 1;\n',
    }],
    validationCommands: [{ kind: 'tsc-no-emit' }],
    limits: {},
    warnings: [],
    status: 'proposed',
    ...overrides,
  });
}

describe('Forge coding proposal validation', () => {
  it('generates the canonical JSON Schema from exported proposal constants', () => {
    const schema = buildCodingProposalJsonSchema() as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    expect((properties.version as Record<string, unknown>).const).toBe(CODING_PROPOSAL_VERSION);
    expect((schema.required as string[])).toEqual(['version', 'taskSummary', 'operations', 'validationCommands', 'warnings', 'status']);
    expect(schema.additionalProperties).toBe(false);
    const operations = properties.operations as Record<string, unknown>;
    const operationItems = operations.items as Record<string, unknown>;
    const variants = operationItems.oneOf as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(CODING_PROPOSAL_OPERATION_TYPES.length);
    expect(variants.map(variant => ((variant.properties as Record<string, unknown>).type as Record<string, unknown>).const)).toEqual([...CODING_PROPOSAL_OPERATION_TYPES]);
    expect(variants[0].required).toContain('reason');
    expect(variants[0].required).toContain('content');
    expect(variants[1].required).not.toContain('expectedFingerprint');
    expect(variants[2].required).not.toContain('expectedFingerprint');
    const validationCommands = properties.validationCommands as Record<string, unknown>;
    const commandKinds = JSON.stringify(validationCommands);
    for (const kind of CODING_PROPOSAL_VALIDATION_COMMAND_KINDS) {
      expect(commandKinds).toContain(kind);
    }
    expect(commandKinds).not.toContain('shell');
  });

  it('accepts canonical output unchanged and without conformance metadata', () => {
    const result = parseAndValidateCodingProposal(proposal(), scripts);
    expect(result.ok).toBe(true);
    expect(result.conformance).toBeUndefined();
    expect(result.proposal?.taskSummary).toBe('Add generated constant');
    expect(result.proposal?.operations[0].type).toBe('create');
  });

  it('accepts plain JSON, one json fence and surrounding whitespace', () => {
    expect(parseAndValidateCodingProposal(proposal(), scripts).ok).toBe(true);
    const fenced = parseAndValidateCodingProposal(`\n\`\`\`json\n${proposal()}\n\`\`\`\n`, scripts);
    expect(fenced.ok).toBe(true);
    expect(fenced.conformance?.jsonFenceRemoved).toBe(true);
    expect(parseAndValidateCodingProposal(`\n  ${proposal()}  \n`, scripts).ok).toBe(true);
  });

  it('rejects ambiguous or unsafe JSON presentation forms', () => {
    expect(parseAndValidateCodingProposal(`${proposal()}\n${proposal()}`, scripts).errors).toContain('trailing_model_response_text');
    expect(parseAndValidateCodingProposal(`Here is JSON:\n${proposal()}`, scripts).errors).toContain('proposal_not_object');
    expect(parseAndValidateCodingProposal(`${proposal()}\nDone.`, scripts).errors).toContain('trailing_model_response_text');
    expect(parseAndValidateCodingProposal('{"version":1', scripts).errors).toContain('malformed_model_response');
    expect(parseAndValidateCodingProposal(JSON.stringify([JSON.parse(proposal())]), scripts).errors).toContain('proposal_not_object');
    expect(parseAndValidateCodingProposal(' '.repeat(1_000_001), scripts).errors).toContain('model_response_too_large');
    expect(parseAndValidateCodingProposal('{"__proto__":{"polluted":true}}', scripts).errors).toContain('prototype_pollution_rejected');
    expect(parseAndValidateCodingProposal('{"a":'.repeat(65) + '1' + '}'.repeat(65), scripts).errors).toContain('malformed_model_response');
  });

  it('accepts valid create, replace and delete proposals', () => {
    const fp = fingerprintText('old');
    const result = parseAndValidateCodingProposal(proposal({
      taskSummary: 'Manage project files',
      operations: [
        { type: 'create', path: 'src/a.ts', reason: 'new', content: 'a' },
        { type: 'replace', path: 'src/b.ts', reason: 'replace', content: 'b', expectedFingerprint: fp },
        { type: 'delete', path: 'src/c.ts', reason: 'remove obsolete file', expectedFingerprint: fp },
      ],
      validationCommands: [{ kind: 'git-diff-check' }, { kind: 'vitest', args: ['src/test/suite/forgeCodingProposal.test.ts'] }],
    }), scripts);
    expect(result.ok).toBe(true);
    expect(result.proposal?.operations).toHaveLength(3);
  });

  it('normalizes supported version and field aliases before strict validation', () => {
    const result = parseAndValidateCodingProposal(JSON.stringify({
      version: '1',
      task_summary: 'Alias summary',
      file_operations: [{ type: 'add', path: 'src/alias.ts', reason: 'alias', content: 'export const alias = true;\n' }],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    }), scripts);
    expect(result.ok).toBe(true);
    expect(result.conformance).toMatchObject({
      versionRepresentationNormalized: true,
      taskSummaryAliasNormalized: true,
      operationContainerAliasNormalized: true,
      operationAliasNormalized: true,
    });
    expect(result.proposal?.taskSummary).toBe('Alias summary');
    expect(result.proposal?.operations[0].type).toBe('create');
  });

  it('preserves canonical fields and rejects conflicting aliases', () => {
    expect(parseAndValidateCodingProposal(proposal({ taskSummary: 'Canonical', task_summary: 'Canonical' }), scripts).ok).toBe(true);
    expect(parseAndValidateCodingProposal(proposal({ taskSummary: 'Canonical', task_summary: 'Different' }), scripts).errors).toContain('task_summary_conflict');
    expect(parseAndValidateCodingProposal(proposal({
      operations: [{ type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' }],
      fileOperations: [{ type: 'create', path: 'src/b.ts', reason: 'x', content: 'x' }],
    }), scripts).errors).toContain('operations_conflict');
    expect(parseAndValidateCodingProposal(proposal({ version: 2 }), scripts).errors).toContain('version_unsupported');
    expect(parseAndValidateCodingProposal(proposal({ version: undefined }), scripts).errors).toContain('version_unsupported');
    expect(parseAndValidateCodingProposal(proposal({ version: 1, contractVersion: 2 }), scripts).errors).toContain('version_conflict');
  });

  it('normalizes only explicit operation aliases without requiring model fingerprints', () => {
    const fp = fingerprintText('old');
    const result = parseAndValidateCodingProposal(proposal({
      taskSummary: 'Manage project files',
      operations: [
        { type: 'modify', path: 'src/a.ts', reason: 'modify', content: 'a', expectedFingerprint: fp },
        { type: 'update', path: 'src/b.ts', reason: 'update', content: 'b', expectedFingerprint: fp },
        { type: 'remove', path: 'src/c.ts', reason: 'remove obsolete file', expectedFingerprint: fp },
      ],
    }), scripts);
    expect(result.ok).toBe(true);
    expect(result.proposal?.operations.map(op => op.type)).toEqual(['replace', 'replace', 'delete']);
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'rewrite', path: 'src/a.ts', reason: 'x', content: 'x' }] }), scripts).errors).toContain('operation_unsupported');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'modify', path: 'src/a.ts', reason: 'x', content: 'x' }] }), scripts).ok).toBe(true);
    expect(parseAndValidateCodingProposal(proposal({ taskSummary: 'Manage project files', operations: [{ type: 'remove', path: 'src/a.ts', reason: 'remove obsolete file' }] }), scripts).ok).toBe(true);
  });

  it('keeps strict security validation after normalization', () => {
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'add', path: '../a', reason: 'x', content: 'x' }] }), scripts).errors).toContain('path_traversal_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'add', path: 'C:/tmp/a', reason: 'x', content: 'x' }] }), scripts).errors).toContain('path_uri_scheme_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'add', path: '.git/config', reason: 'x', content: 'x' }] }), scripts).errors).toContain('excluded_path_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'add', path: 'dist/a', reason: 'x', content: 'x' }] }), scripts).errors).toContain('excluded_path_rejected');
    expect(parseAndValidateCodingProposal(proposal({ validationCommands: [{ kind: 'vitest', args: ['run', 'src/a.test.ts', '&&'] }] }), scripts).errors).toContain('validation_command_unsupported');
    expect(parseAndValidateCodingProposal(proposal({ operations: Array.from({ length: 13 }, (_, i) => ({ type: 'add', path: `src/${i}.ts`, reason: 'x', content: 'x' })) }), scripts).errors).toContain('file_count_limit_exceeded');
  });

  it('covers observed live structural shapes without storing raw completions', () => {
    const bounded = parseAndValidateCodingProposal(JSON.stringify({
      version: '1',
      task_summary: 'Observed bounded shape',
      operations: [{ type: 'add', path: 'src/observed.ts', reason: 'observed', content: 'export const observed = true;\n' }],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    }), scripts);
    expect(bounded.ok).toBe(true);

    const stillUnsafe = parseAndValidateCodingProposal(JSON.stringify({
      version: '1',
      task_summary: 'Observed oversized shape',
      file_operations: Array.from({ length: 13 }, (_, i) => ({ type: 'add', path: `src/observed-${i}.ts`, reason: 'observed', content: 'x' })),
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    }), scripts);
    expect(stillUnsafe.errors).toContain('file_count_limit_exceeded');
  });

  it('rejects unsafe paths, duplicate operations, excessive files and malformed model responses', () => {
    expect(parseAndValidateCodingProposal('{bad', scripts).errors).toContain('malformed_model_response');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'create', path: '/tmp/a', reason: 'x', content: 'x' }] }), scripts).errors).toContain('absolute_path_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'create', path: '../a', reason: 'x', content: 'x' }] }), scripts).errors).toContain('path_traversal_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'create', path: '.git/config', reason: 'x', content: 'x' }] }), scripts).errors).toContain('excluded_path_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'create', path: 'node_modules/a', reason: 'x', content: 'x' }] }), scripts).errors).toContain('excluded_path_rejected');
    expect(parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' },
      { type: 'create', path: 'src/a.ts', reason: 'x', content: 'x' },
    ] }), scripts).errors).toContain('duplicate_operation_path');
    expect(parseAndValidateCodingProposal(proposal({ operations: Array.from({ length: 13 }, (_, i) => ({ type: 'create', path: `src/${i}.ts`, reason: 'x', content: 'x' })) }), scripts).errors).toContain('file_count_limit_exceeded');
  });

  // Regression for a real live OrcaRouter/gpt-5.6-sol run (direct-cloud
  // primary baseline): the request-time schema declares `operations`
  // `minItems: 1`, but that is only enforced by the PROVIDER (Ollama's
  // native grammar-constrained decoding honors it; this real cloud run's
  // structured output did not) — this deterministic host-side validator
  // never independently re-checked it. `operations: []` is an array
  // (Array.isArray true) and truthy, so it silently passed as "present"
  // here, reached mutation with zero real operations, and vacuously
  // satisfied GovernedCodingExecutor's alreadySatisfied check (nothing to
  // find a mismatch against) — reporting a genuinely unfixed defect as
  // "completed: already satisfied" with no real evidence at all.
  it('rejects an empty operations array instead of silently accepting it as "no changes needed"', () => {
    const result = parseAndValidateCodingProposal(proposal({ operations: [] }), scripts);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('operations_empty');
    // Repairable: give the model one bounded chance to name a real,
    // verifiable operation instead of failing closed immediately.
    expect(isRepairableCodingProposalFailure(result.errors)).toBe(true);
  });

  it('rejects a missing operation kind as invalid rather than defaulting it to create', () => {
    const result = parseAndValidateCodingProposal(proposal({ operations: [{ path: 'src/a.ts', reason: 'x', content: 'x' }] }), scripts);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('operation_unsupported');
    expect(result.proposal).toBeUndefined();
  });

  it('treats Windows case-insensitive path aliases as duplicate operation targets', () => {
    const result = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'create', path: 'src/Foo.ts', reason: 'x', content: 'x' },
      { type: 'create', path: 'src/foo.ts', reason: 'x', content: 'x' },
    ] }), scripts);
    expect(result.errors).toContain('duplicate_operation_path');
  });

  it('rejects unsupported validation commands and byte limits while accepting legacy fingerprints as non-authoritative data', () => {
    expect(parseAndValidateCodingProposal(proposal({ validationCommands: [{ kind: 'npm-script', script: 'test:live:ollama' }] }), ['test:live:ollama']).errors).toContain('validation_command_unsupported');
    expect(parseAndValidateCodingProposal(proposal({ validationCommands: [{ kind: 'vitest', args: ['src/a.test.ts', '|', 'whoami'] }] }), scripts).errors).toContain('validation_command_unsupported');
    expect(parseAndValidateCodingProposal(proposal({ operations: [{ type: 'create', path: 'src/a.ts', reason: 'x', content: 'x'.repeat(200_001) }] }), scripts).errors).toContain('file_byte_limit_exceeded');
    const legacy = parseAndValidateCodingProposal(proposal({ operations: [{ type: 'replace', path: 'src/a.ts', reason: 'x', content: 'x', expectedFingerprint: 'bogus' }] }), scripts);
    expect(legacy.ok).toBe(true);
    expect(legacy.proposal?.operations[0].expectedFingerprint).toBe('bogus');
  });

  // Regression for the M-dogfood observed defect: a create/replace whose
  // content is an obvious placeholder rather than a complete implementation
  // (the real proposal replaced a 247-line core/domain/approvals.ts with a
  // ~20-line pseudocode stub built from exactly these markers).
  it('rejects obvious placeholder/pseudocode content in a create or replace operation', () => {
    const ellipsisComment = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'replace', path: 'src/a.ts', reason: 'x', content: 'function f() {\n  // ... existing validation logic ...\n}\n' },
    ] }), scripts);
    expect(ellipsisComment.errors).toContain('operation_placeholder_content_rejected');

    const bareEllipsisLine = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'create', path: 'src/a.ts', reason: 'x', content: 'function f() {\n  // ...\n}\n' },
    ] }), scripts);
    expect(bareEllipsisLine.errors).toContain('operation_placeholder_content_rejected');

    const todoImplement = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'replace', path: 'src/a.ts', reason: 'x', content: '// TODO: implement this properly\nexport function f() {}\n' },
    ] }), scripts);
    expect(todoImplement.errors).toContain('operation_placeholder_content_rejected');

    expect(isRepairableCodingProposalFailure(['operation_placeholder_content_rejected'])).toBe(true);
  });

  it('does not flag ordinary content merely for containing the word TODO or an ellipsis unrelated to a placeholder', () => {
    const result = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'create', path: 'src/a.ts', reason: 'x', content: "// TODO(owner): revisit this threshold later\nexport const items = ['a', 'b', '...'];\n" },
    ] }), scripts);
    expect(result.errors).not.toContain('operation_placeholder_content_rejected');
  });

  it('safely consolidates redundant identical replaces and marks conformance metadata', () => {
    const result = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'replace', path: 'src/module.py', reason: 'fix issue', content: 'def run(): return 42\n' },
      { type: 'replace', path: 'src/module.py', reason: 'fix issue again', content: 'def run(): return 42\n' },
    ] }), scripts);
    expect(result.ok).toBe(true);
    expect(result.proposal?.operations).toHaveLength(1);
    expect(result.conformance?.duplicateOperationPathsConsolidated).toBe(true);
  });

  it('rejects conflicting replace operations with differing contents as duplicate_operation_path', () => {
    const result = parseAndValidateCodingProposal(proposal({ operations: [
      { type: 'replace', path: 'src/module.py', reason: 'part 1', content: 'def run(): return 1\n' },
      { type: 'replace', path: 'src/module.py', reason: 'part 2', content: 'def run(): return 2\n' },
    ] }), scripts);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate_operation_path');
    expect(isRepairableCodingProposalFailure(result.errors)).toBe(true);
  });

  it('accepts kind pytest, normalizes python -m pytest, and rejects unsafe args', () => {
    // Bare pytest
    const bare = parseAndValidateCodingProposal(proposal({ validationCommands: [{ kind: 'pytest' }] }), scripts);
    expect(bare.ok).toBe(true);
    expect(bare.proposal?.validationCommands).toEqual([{ kind: 'pytest' }]);

    // Pytest with safe args and flags
    const withArgs = parseAndValidateCodingProposal(proposal({
      validationCommands: [{ kind: 'pytest', args: ['tests/test_core.py', '-v', '-k', 'test_eval', '--maxfail=1'] }],
    }), scripts);
    expect(withArgs.ok).toBe(true);
    expect(withArgs.proposal?.validationCommands[0]).toEqual({
      kind: 'pytest',
      args: ['tests/test_core.py', '-v', '-k', 'test_eval', '--maxfail=1'],
    });

    // python -m pytest normalization
    const normalized = parseAndValidateCodingProposal(proposal({
      validationCommands: [{ kind: 'python', args: ['-m', 'pytest', 'tests/test_core.py'] }],
    }), scripts);
    expect(normalized.ok).toBe(true);
    expect(normalized.proposal?.validationCommands[0]).toEqual({
      kind: 'pytest',
      args: ['tests/test_core.py'],
    });

    // Shell metacharacters rejected
    const unsafeMeta = parseAndValidateCodingProposal(proposal({
      validationCommands: [{ kind: 'pytest', args: ['test.py; rm -rf /'] }],
    }), scripts);
    expect(unsafeMeta.ok).toBe(false);
    expect(unsafeMeta.errors).toContain('validation_command_unsupported');

    // Path traversal rejected
    const unsafeTraversal = parseAndValidateCodingProposal(proposal({
      validationCommands: [{ kind: 'pytest', args: ['../tests/test_core.py'] }],
    }), scripts);
    expect(unsafeTraversal.ok).toBe(false);
    expect(unsafeTraversal.errors).toContain('validation_command_unsupported');

    // isRepairableCodingProposalFailure treats validation_command_unsupported as repairable
    expect(isRepairableCodingProposalFailure(['validation_command_unsupported'])).toBe(true);
  });

  it('detectWorkspaceValidationPolicy detects Python and TypeScript commands correctly', () => {
    const pythonPolicy = detectWorkspaceValidationPolicy('/repo', [], ['src/app.py', 'tests/test_app.py']);
    expect(pythonPolicy.some(cmd => cmd.includes('pytest'))).toBe(true);

    const tsPolicy = detectWorkspaceValidationPolicy('/repo', ['test', 'lint'], ['src/app.ts', 'tsconfig.json']);
    expect(tsPolicy.some(cmd => cmd.includes('tsc-no-emit'))).toBe(true);
    expect(tsPolicy.some(cmd => cmd.includes('npm-test'))).toBe(true);
  });
});
