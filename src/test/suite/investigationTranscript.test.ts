import { describe, expect, it } from 'vitest';
import { GOVERNED_MODEL_CONTRACT_VERSION } from '../../agent/GovernedModelExecutionTypes';
import {
  compactInvestigationTranscript,
  isContextBudgetRejection,
  INVESTIGATION_TRANSCRIPT_BUDGET_CHARS,
  type InvestigationRecord,
} from '../../coding/InvestigationTranscript';

describe('InvestigationTranscript compaction', () => {
  it('dedupes identical searches and keeps the latest read for the same path+range', () => {
    const records: InvestigationRecord[] = [
      { kind: 'search', key: 'workspace\nFOO', query: 'FOO', scope: 'workspace', formatted: '\n### search: "FOO" first\n' },
      {
        kind: 'read',
        ok: true,
        path: 'helper.js',
        range: '1-1',
        fingerprint: 'sha256:aaa',
        content: 'old body THRESHOLD: 1',
      },
      { kind: 'search', key: 'workspace\nFOO', query: 'FOO', scope: 'workspace', formatted: '\n### search: "FOO" latest\n' },
      {
        kind: 'read',
        ok: true,
        path: 'helper.js',
        range: '1-1',
        fingerprint: 'sha256:bbb',
        content: 'module.exports = { THRESHOLD: 42 };',
      },
    ];
    const compacted = compactInvestigationTranscript(records, INVESTIGATION_TRANSCRIPT_BUDGET_CHARS);
    expect(compacted.transcript).toContain('latest');
    expect(compacted.transcript).not.toContain('first');
    expect(compacted.transcript).toContain('THRESHOLD: 42');
    expect(compacted.transcript).not.toContain('THRESHOLD: 1');
    expect(compacted.transcript).toContain('fingerprint=sha256:bbb');
    expect(compacted.keptReads).toBe(1);
  });

  it('omits oldest read bodies when over budget but preserves path, range, and fingerprint', () => {
    const oldContent = 'OLD_UNIQUE_BODY '.repeat(400);
    const latestContent = 'LATEST_UNIQUE_BODY module.exports = { THRESHOLD: 42 };';
    const records: InvestigationRecord[] = [
      {
        kind: 'read',
        ok: true,
        path: 'padding.js',
        range: '1-80',
        fingerprint: 'sha256:pad',
        content: oldContent,
      },
      {
        kind: 'read',
        ok: true,
        path: 'middle.js',
        range: '1-1',
        fingerprint: 'sha256:mid',
        content: 'MIDDLE_UNIQUE_TOKEN',
      },
      {
        kind: 'read',
        ok: true,
        path: 'helper.js',
        range: '1-1',
        fingerprint: 'sha256:help',
        content: latestContent,
      },
    ];
    const compacted = compactInvestigationTranscript(records, 800);
    expect(compacted.compacted).toBe(true);
    expect(compacted.omittedReadBodies).toBeGreaterThanOrEqual(1);
    expect(compacted.transcript).toContain('### read_file: padding.js range=1-80 fingerprint=sha256:pad');
    expect(compacted.transcript).toContain('BODY_OMITTED');
    expect(compacted.transcript).not.toContain('OLD_UNIQUE_BODY');
    expect(compacted.transcript).toContain('THRESHOLD: 42');
    expect(compacted.transcript).toContain('fingerprint=sha256:help');
    expect(compacted.transcript).toContain('MIDDLE_UNIQUE_TOKEN');
  });

  it('keeps a later re-read of an earlier range instead of omitting every body', () => {
    const records: InvestigationRecord[] = [
      {
        kind: 'read',
        ok: true,
        path: 'padding.js',
        range: '1-80',
        fingerprint: 'sha256:pad',
        content: 'PAD_UNIQUE_TOKEN '.repeat(400),
      },
      {
        kind: 'read',
        ok: true,
        path: 'runtime.ts',
        range: '2140-2180',
        fingerprint: 'sha256:old',
        content: 'FIRST_CLASSIFY_BODY '.repeat(40),
      },
      {
        kind: 'read',
        ok: true,
        path: 'tests.ts',
        range: '220-280',
        fingerprint: 'sha256:test',
        content: 'TEST_UNIQUE_BODY '.repeat(200),
      },
      {
        kind: 'read',
        ok: true,
        path: 'runtime.ts',
        range: '2140-2180',
        fingerprint: 'sha256:new',
        content: 'REREAD_CLASSIFY_BODY function classifyRuntimeError() { return error.classification; }',
      },
    ];
    const compacted = compactInvestigationTranscript(records, 900);
    expect(compacted.transcript).toContain('REREAD_CLASSIFY_BODY');
    expect(compacted.transcript).toContain('fingerprint=sha256:new');
    expect(compacted.transcript).not.toContain('FIRST_CLASSIFY_BODY');
    expect(compacted.transcript).toContain('BODY_OMITTED');
  });

  it('omits bulky search match lines before dropping a successful read body', () => {
    const records: InvestigationRecord[] = [
      {
        kind: 'search',
        key: 'src\napproveDelivery',
        query: 'approveDelivery',
        scope: 'src',
        formatted: `\n### search: "approveDelivery" scope=src results=30\n${'src/file.ts:1: hit\n'.repeat(40)}`,
      },
      {
        kind: 'read',
        ok: true,
        path: 'helper.js',
        range: '1-1',
        fingerprint: 'sha256:help',
        content: 'module.exports = { THRESHOLD: 42 };',
      },
    ];
    const compacted = compactInvestigationTranscript(records, 400);
    expect(compacted.transcript).toContain('THRESHOLD: 42');
    expect(compacted.transcript).toContain('MATCH_LINES_OMITTED');
    expect(compacted.transcript).not.toContain('src/file.ts:1: hit');
    expect(compacted.omittedReadBodies).toBe(0);
  });

  it('detects a context-preflight blocked execution_rejected', () => {
    expect(isContextBudgetRejection({
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'r',
      invocationId: 'i',
      taskId: 't',
      model: 'qwen3.8:27b-mtp-q4_K_M',
      status: 'failed',
      failureCode: 'execution_rejected',
      evidence: {
        contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
        requestId: 'r',
        invocationId: 'i',
        taskId: 't',
        model: 'qwen3.8:27b-mtp-q4_K_M',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'failed',
        failureCode: 'execution_rejected',
        context: {
          profileId: 'qwen-general-local',
          effectiveContextLimit: 16384,
          provenance: 'profile',
          estimated: true,
          fallback: false,
          contentTokens: 20_000,
          projectedTotalTokens: 25_000,
          outputReserveTokens: 4096,
          percentUsed: 152,
          status: 'blocked',
          structuredOutput: { requested: true, supported: true, active: true },
        },
      },
    })).toBe(true);
  });

  it('bounds transcript deterministically and strictly within budget when many observations are present', () => {
    const records: InvestigationRecord[] = [];
    for (let i = 0; i < 40; i++) {
      records.push({
        kind: 'read',
        ok: true,
        path: `src/module_${i}.ts`,
        range: '1-80',
        fingerprint: `sha256:fp_${i}`,
        content: `export function moduleFunction${i}() { return ${i}; }\n`.repeat(30),
      });
      records.push({
        kind: 'search',
        key: `src\nquery_${i}`,
        query: `query_${i}`,
        scope: 'src',
        formatted: `\n### search: "query_${i}" scope=src results=10\n${`src/module_${i}.ts:1: hit\n`.repeat(10)}`,
      });
    }

    const budget = 3000;
    const run1 = compactInvestigationTranscript(records, budget);
    const run2 = compactInvestigationTranscript(records, budget);

    // Exact deterministic reproducibility
    expect(run1.transcript).toBe(run2.transcript);
    expect(run1.transcript.length).toBeLessThanOrEqual(budget);
    expect(run1.compacted).toBe(true);
    expect(run1.omittedReadBodies).toBeGreaterThan(0);
  });
});
