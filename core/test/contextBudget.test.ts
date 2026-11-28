import { beforeEach, describe, expect, it } from 'vitest';
import {
  boundToolResultText, charsPerToken, contextExhausted, endsMidSentence, estimatePromptTokens, fitMessagesToBudget,
  messagesChars, recordPromptCalibration, resetPromptCalibration, TOOL_RESULT_MODEL_CAP_CHARS,
} from '../runtime/contextBudget';
import { isResearchStubReply } from '../runtime/piAgentEngine';

describe('context budget', () => {
  beforeEach(() => resetPromptCalibration());

  it('calibrates chars per token from real telemetry (the 2026-11-28 prompt: 101K chars = 32,414 tokens)', () => {
    expect(estimatePromptTokens(101_000, 'm')).toBeGreaterThan(30_000); // default 3.0, not 4
    recordPromptCalibration('m', 101_000, 32_414);
    expect(charsPerToken('m')).toBeCloseTo(3.116, 2);
    expect(estimatePromptTokens(101_000, 'm')).toBeGreaterThanOrEqual(32_000);
    expect(charsPerToken('other')).toBe(3);
  });

  it('ignores tiny or implausible measurements', () => {
    recordPromptCalibration('m', 500, 400);
    expect(charsPerToken('m')).toBe(3);
  });

  it('bounds a big tool result, says it is partial, and leaves small ones alone', () => {
    const small = 'x'.repeat(500);
    expect(boundToolResultText(small)).toEqual({ text: small, omitted: 0 });
    const big = 'a'.repeat(25_000);
    const b = boundToolResultText(big);
    expect(b.text.length).toBeLessThan(TOOL_RESULT_MODEL_CAP_CHARS + 600);
    expect(b.omitted).toBeGreaterThan(12_000);
    expect(b.text).toMatch(/NOT the complete result/);
  });

  it('fits a conversation by shrinking old tool results first and keeps pairing and the user message', () => {
    const messages: any[] = [
      { role: 'user', content: [{ type: 'text', text: 'find enterprise mail' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: '1', name: 'gmail_search', arguments: { query: 'x' } }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'r'.repeat(30_000) }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: '2', name: 'gmail_read_thread', arguments: { threadId: 'a' } }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'q'.repeat(3_000) }] },
    ];
    const fit = fitMessagesToBudget(messages, 12_000);
    expect(fit.fits).toBe(true);
    expect(fit.messages).toHaveLength(5);
    expect(messagesChars(fit.messages)).toBeLessThanOrEqual(12_000);
    expect(fit.messages[0]).toBe(messages[0]);
    expect(fit.messages[4]).toBe(messages[4]); // newest result untouched when older ones were enough
    expect(JSON.stringify(fit.messages[2])).toMatch(/NOT the complete result/);
  });

  it('returns the same array when it already fits', () => {
    const messages: any[] = [{ role: 'user', content: 'hi' }];
    expect(fitMessagesToBudget(messages, 1000).messages).toBe(messages);
  });

  it('recognises cut-off replies without a length rule', () => {
    for (const cut of ['The', 'Based on', 'I found two emails from', 'The invoice total is:', '```json\n{"a":1}']) expect(endsMidSentence(cut), cut).toBe(true);
    for (const ok of ['Yes', 'No', '€250', 'Done.', 'Hello! How can I help?', 'The total is 250', 'Paris.', '42']) expect(endsMidSentence(ok), ok).toBe(false);
  });

  it('never accepts "The" as an answer, but accepts short complete ones', () => {
    expect(isResearchStubReply('The', false)).toBe(true);
    expect(isResearchStubReply('Yes', false)).toBe(false);
    expect(isResearchStubReply('€250', false)).toBe(false);
  });

  it('detects a call that used the whole window', () => {
    expect(contextExhausted(32_414, 1, 32_768)).toBe(true);
    expect(contextExhausted(14_000, 700, 32_768)).toBe(false);
  });
});
