import { describe, it, expect } from 'vitest';
import {
  stampKind, stampLabel, stampClass, formatDuration, formatTokens, visibleOps, hasPartial, shareable,
  type Receipt,
} from '../renderer-v2/src/receiptModel';

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  missionId: 'msn_1', objective: 'Build a tip calculator', status: 'completed', headline: 'Verified',
  startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:47Z', durationMs: 47000,
  steps: [], operations: [{ label: 'files written', count: 2 }, { label: 'tests passed', count: 5 }],
  artifacts: [], verifiedOutputs: [{ label: 'tests pass', level: 'checked' }],
  partialOrFailed: [], approvalsUsed: 2, model: 'gemma4:12b', provider: 'ollama',
  tokens: { prompt: 100, completion: 50 }, costUsd: null, nextAction: 'Run it for 84.50.', undoAvailable: true,
  undoHint: 'git revert available', independentlyReviewed: true, ...over,
});

describe('receipt model', () => {
  it('maps status to stamp kind/label/class', () => {
    expect(stampKind('completed')).toBe('verified');
    expect(stampLabel(stampKind('completed'))).toBe('Verified');
    expect(stampClass(stampKind('completed'))).toBe('verified');
    expect(stampKind('failed')).toBe('failed');
    expect(stampLabel(stampKind('failed'))).toBe('Not finished');
    expect(stampClass(stampKind('failed'))).toBe('failed');
    expect(stampKind('completed_with_issues')).toBe('issues');
    expect(stampLabel(stampKind('completed_with_issues'))).toBe('Completed with issues');
  });
  it('formats duration and tokens', () => {
    expect(formatDuration(47000)).toBe('47s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(null)).toBe('—');
    expect(formatTokens({ prompt: 100, completion: 50 })).toBe('150 tokens');
    expect(formatTokens(null)).toBe('—');
  });
  it('orders visible ops and hides zeros', () => {
    const r = receipt({ operations: [{ label: 'files written', count: 2 }, { label: 'tests passed', count: 5 }, { label: 'git commits', count: 0 }] });
    const ops = visibleOps(r);
    expect(ops.map((o) => o.label)).toEqual(['files written', 'tests passed']);
  });
  it('hasPartial is true only when partialOrFailed non-empty', () => {
    expect(hasPartial(receipt())).toBe(false);
    expect(hasPartial(receipt({ partialOrFailed: [{ step: 1, status: 'failed', reason: 'x' }] }))).toBe(true);
  });
  it('shareable excludes free-text and includes key facts', () => {
    const text = shareable(receipt());
    expect(text).toContain('Pandesh Outcome Receipt');
    expect(text).toContain('Verified');
    expect(text).toContain('gemma4:12b');
    expect(text).toContain('redacted');
    expect(text).not.toContain('Build a tip calculator'); // objective excluded
    expect(text).not.toContain('C:\\');
  });
});