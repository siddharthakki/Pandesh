/**
 * M-benchmark P2/P3/P5 — the pure decision modules.
 */
import { describe, expect, it } from 'vitest';
import { buildAnchorContext } from '../runtime/anchorContext';
import {
  clearIdenticalFailure,
  failureScopeKey,
  noteIdenticalFailure,
  peekIdenticalFailure,
} from '../runtime/identicalFailureTracker';
import { parseJsonWithSafeRepair, repairJsonStringEscapes } from '../runtime/jsonArgumentRepair';
import { resolveAnchoredEdit } from '../runtime/textEditProposal';
import {
  assessContextFit,
  allocateContextAtAssembly,
  outputReserveTokens,
  reasoningReserveForReasoningModel,
  reasoningReserveTokens,
  usableInputTokens,
  type ContextWindow,
} from '../shared/contextBudget';
import { validationGateTier, selectValidationGates, type ValidationGate } from '../runtime/workspaceValidation';

describe('bounded anchor context (P3)', () => {
  const file = [
    'export function slugify(value: string) {',
    '  return value.trim().toLowerCase();',
    '}',
    '',
  ].join('\n');

  it('quotes the region a missed anchor was aiming at', () => {
    const context = buildAnchorContext({
      relativePath: 'src/slug.ts',
      fileText: file,
      find: 'return value.trim().toLowerCase();',
      kind: 'not_found',
    });
    expect(context).toContain('src/slug.ts');
    expect(context).toContain('return value.trim().toLowerCase();');
    expect(context.length).toBeLessThanOrEqual(1_900);
  });

  it('says where an ambiguous anchor occurs', () => {
    const twice = `${file}\nexport function other() {\n  return value.trim().toLowerCase();\n}\n`;
    const context = buildAnchorContext({
      relativePath: 'src/slug.ts',
      fileText: twice,
      find: 'return value.trim().toLowerCase();',
      kind: 'ambiguous',
    });
    expect(context).toContain('occurs on lines 2, 6');
    expect(context).toContain('so it occurs exactly once');
  });

  it('never rewrites the file text it quotes', () => {
    const smart = 'const greeting = "héllo wörld";\n';
    const context = buildAnchorContext({
      relativePath: 'a.ts',
      fileText: smart,
      find: 'const greeting = "héllo wörld";',
      kind: 'not_found',
    });
    expect(context).toContain('héllo wörld');
    // No Unicode folding: the quoted bytes are the file's bytes.
    expect(context).not.toContain('hello world');
  });
});

describe('resolveAnchoredEdit (P3)', () => {
  it('reports a stable code and bounded context when the anchor misses', () => {
    const resolved = resolveAnchoredEdit('line one\nline two\n', 'line three', 'x', { relativePath: 'a.txt' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('anchor_not_found');
    expect(resolved.context).toBeTruthy();
    expect(resolved.context).toContain('a.txt');
  });

  it('distinguishes an ambiguous anchor', () => {
    const resolved = resolveAnchoredEdit('dup\ndup\n', 'dup', 'x', { relativePath: 'a.txt' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('anchor_ambiguous');
  });

  it('still applies a resolvable anchor exactly', () => {
    const resolved = resolveAnchoredEdit('line one\nline two\n', 'line two', 'line 2');
    expect(resolved).toEqual({ ok: true, content: 'line one\nline 2\n' });
  });
});

describe('safe JSON escape repair (P3)', () => {
  it('escapes a literal newline inside a string value', () => {
    const repaired = repairJsonStringEscapes('{"find":"line one\nline two"}');
    expect(repaired.applied.map((entry) => entry.kind)).toContain('control_character_escaped');
    const parsed = parseJsonWithSafeRepair('{"find":"line one\nline two"}');
    expect(parsed?.value).toEqual({ find: 'line one\nline two' });
  });

  it('removes a backslash before a single quote, which JSON does not define', () => {
    const parsed = parseJsonWithSafeRepair('{"text":"it\'s fine"}');
    expect(parsed?.value).toEqual({ text: "it's fine" });
  });

  it('never repairs an escape a language could give a meaning to', () => {
    // `\d` is a regex escape: dropping the backslash would change the code.
    expect(parseJsonWithSafeRepair('{"pattern":"\\d+"}')).toBeNull();
    expect(parseJsonWithSafeRepair('{"pattern":"\\["}')).toBeNull();
  });

  it('never folds Unicode', () => {
    const parsed = parseJsonWithSafeRepair('{"text":"naïve — dash"}');
    expect(parsed?.value).toEqual({ text: 'naïve — dash' });
  });

  it('leaves valid JSON untouched', () => {
    const parsed = parseJsonWithSafeRepair('{"a":"b"}');
    expect(parsed?.value).toEqual({ a: 'b' });
    expect(parsed?.applied).toEqual([]);
  });
});

describe('identical failure detection (P3)', () => {
  it('counts the same target failing the same way', () => {
    let state = undefined as ReturnType<typeof noteIdenticalFailure>['state'];
    for (let index = 0; index < 2; index += 1) {
      const recorded = noteIdenticalFailure(state, {
        toolName: 'propose_text_edit',
        resultCategory: 'anchor_unresolved',
        arguments: { path: 'a.ts', find: 'slightly different anchor' },
      });
      state = recorded.state;
      expect(recorded.verdict.exhausted).toBe(false);
    }
    const third = noteIdenticalFailure(state, {
      toolName: 'propose_text_edit',
      resultCategory: 'anchor_unresolved',
      arguments: { path: 'a.ts', find: 'yet another anchor' },
    });
    expect(third.verdict.exhausted).toBe(true);
    expect(third.verdict.message).toContain('Change the approach');
  });

  it('does not count a different failure kind against the same target', () => {
    let state = undefined as ReturnType<typeof noteIdenticalFailure>['state'];
    const first = noteIdenticalFailure(state, { toolName: 'propose_text_edit', resultCategory: 'anchor_unresolved', arguments: { path: 'a.ts' } });
    state = first.state;
    const second = noteIdenticalFailure(state, { toolName: 'propose_text_edit', resultCategory: 'write_failed', arguments: { path: 'a.ts' } });
    expect(second.verdict.count).toBe(1);
  });

  it('refuses a retry of an exhausted failure before it runs', () => {
    let state = undefined as ReturnType<typeof noteIdenticalFailure>['state'];
    for (let index = 0; index < 3; index += 1) {
      state = noteIdenticalFailure(state, { toolName: 'read_file', resultCategory: 'read_failed', arguments: { path: 'a.ts' } }).state;
    }
    const peek = peekIdenticalFailure(state, { toolName: 'read_file', arguments: { path: 'a.ts' } });
    expect(peek.exhausted).toBe(true);
    expect(peek.message).toContain('STOPPED');
  });

  it('clears the record after a success', () => {
    let state = undefined as ReturnType<typeof noteIdenticalFailure>['state'];
    state = noteIdenticalFailure(state, { toolName: 'read_file', resultCategory: 'read_failed', arguments: { path: 'a.ts' } }).state;
    state = clearIdenticalFailure(state, { toolName: 'read_file', arguments: { path: 'a.ts' } });
    expect(peekIdenticalFailure(state, { toolName: 'read_file', arguments: { path: 'a.ts' } }).exhausted).toBe(false);
  });

  it('scopes by the target, not by the wording', () => {
    expect(failureScopeKey({ toolName: 'propose_text_edit', arguments: { path: 'a.ts', find: 'x' } }))
      .toBe(failureScopeKey({ toolName: 'propose_text_edit', arguments: { path: 'a.ts', find: 'completely different' } }));
  });
});

describe('validation tiers (P2)', () => {
  const gates: ValidationGate[] = [
    { id: 'compile', category: 'compile', command: 'npm run compile', source: 'package_json' },
    { id: 'test', category: 'unit_test', command: 'npm test', source: 'package_json' },
    { id: 'lint', category: 'lint', command: 'npm run lint', source: 'package_json' },
  ];

  it('keeps the cheap gates out of the expensive tier', () => {
    expect(validationGateTier('compile')).toBe('lightweight');
    expect(validationGateTier('unit_test')).toBe('full');
    expect(validationGateTier('lint')).toBe('full');
  });

  it('runs only the lightweight gate after an edit', () => {
    const selected = selectValidationGates(gates, 'lightweight', 1);
    expect(selected.gates.map((gate) => gate.id)).toEqual(['compile']);
    expect(selected.substituted).toBe(false);
  });

  it('runs the full suite at the end, not after every edit', () => {
    const selected = selectValidationGates(gates, 'full', 3);
    expect(selected.gates.map((gate) => gate.id)).toEqual(['test', 'lint']);
  });

  it('reports a substitution instead of silently swapping the tier', () => {
    const onlyExpensive: ValidationGate[] = [{ id: 'test', category: 'unit_test', command: 'npm test', source: 'package_json' }];
    const selected = selectValidationGates(onlyExpensive, 'lightweight', 1);
    expect(selected.substituted).toBe(true);
    expect(selected.gates.map((gate) => gate.id)).toEqual(['test']);
  });
});

describe('model-aware context budget (P5)', () => {
  const window = (contextTokens: number, extra: Partial<ContextWindow> = {}): ContextWindow => ({
    contextTokens, source: 'router_metadata', ...extra,
  });

  it('charges the reasoning phase against the same window', () => {
    const plain = usableInputTokens(window(32_768));
    const reasoning = usableInputTokens(window(32_768, { reasoningTokens: 4_096 }));
    expect(reasoning).toBe(plain - 4_096);
  });

  it('reserves a bounded, window-derived reasoning budget', () => {
    expect(reasoningReserveForReasoningModel(32_768)).toBe(8_192);
    expect(reasoningReserveForReasoningModel(4_096)).toBe(1_024);
    expect(reasoningReserveForReasoningModel(1_048_576)).toBe(8_192);
  });

  it('keeps the hard safety limits: the usable input never goes negative', () => {
    const tiny = usableInputTokens(window(2_048, { reasoningTokens: 100_000 }));
    expect(tiny).toBe(0);
    expect(reasoningReserveTokens(window(2_048))).toBe(0);
    expect(outputReserveTokens(window(2_048))).toBeGreaterThan(0);
  });

  it('shrinks the assembly budget when the model reasons', () => {
    const plain = allocateContextAtAssembly({ surface: 'saath_kar', window: window(32_768), fixedChars: 4_000 });
    const reasoning = allocateContextAtAssembly({
      surface: 'saath_kar', window: window(32_768, { reasoningTokens: 8_192 }), fixedChars: 4_000,
    });
    expect(reasoning.remainingChars).toBeLessThan(plain.remainingChars);
    expect(reasoning.reasoningReserveTokens).toBe(8_192);
  });

  it('reduces, selects another model, or reports the limitation — never silently', () => {
    const allocation = allocateContextAtAssembly({
      surface: 'saath_kar', window: window(4_096), fixedChars: 400_000,
    });
    expect(allocation.fixedOverflow).toBe(true);

    const reducible = assessContextFit({ allocation, reducibleChars: 10_000 });
    expect(reducible.action).toBe('reduce');

    const alternative = assessContextFit({ allocation, reducibleChars: 0, authorizedAlternativeWindows: [131_072] });
    expect(alternative.action).toBe('select_another_model');
    expect(alternative.requiredContextTokens).toBe(131_072);

    const hopeless = assessContextFit({ allocation, reducibleChars: 0, authorizedAlternativeWindows: [4_096] });
    expect(hopeless.action).toBe('report_limitation');
  });

  it('reports a fit when the request fits', () => {
    const allocation = allocateContextAtAssembly({ surface: 'baat_kar', window: window(32_768), fixedChars: 1_000 });
    expect(assessContextFit({ allocation, reducibleChars: 0 }).action).toBe('fits');
  });
});
