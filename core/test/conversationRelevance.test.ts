import { describe, it, expect } from 'vitest';
import { selectRelevantTask, boundConversationContext, isExplicitResumeRequest, MAX_TURN_CHARS } from '../domain/conversationRelevance';

const gmail = { objective: 'Extract the contracts from my Gmail', status: 'partial' };

describe('selectRelevantTask', () => {
  it('does not offer an open task to an unrelated request', () => {
    for (const text of ['What is the weather in Paris?', 'Discover the connected PC devices', 'Print a test page on the Brother printer', 'What is the capital of France?']) {
      expect(selectRelevantTask([gmail], text)).toBeUndefined();
    }
  });
  it('resumes on a bare resume request or one naming the task', () => {
    for (const text of ['Continue', 'status?', 'Continue where you left off', 'What happened with the contract extraction?', 'any updates on the contracts']) {
      expect(selectRelevantTask([gmail], text)).toBe(gmail);
    }
  });
  it('does not hijack a resume request that is about something else', () => {
    expect(selectRelevantTask([gmail], 'Continue printing the quarterly report')).toBeUndefined();
  });
  it('ignores finished tasks', () => {
    expect(selectRelevantTask([{ ...gmail, status: 'satisfied' }], 'Continue')).toBeUndefined();
  });
  it('prefers the task with the most subject overlap', () => {
    const other = { objective: 'Plan the Berlin trip', status: 'in_progress' };
    expect(selectRelevantTask([other, gmail], 'how are the Gmail contracts going')).toBe(gmail);
  });
});

describe('boundConversationContext', () => {
  const turns = [
    { role: 'user', content: 'Extract contracts from Gmail' },
    { role: 'assistant', content: '| Contract Type | ... big table ...' },
    { role: 'user', content: 'weather in Paris?' },
    { role: 'assistant', content: 'Cloudy.' },
    { role: 'user', content: 'list devices' },
    { role: 'assistant', content: 'Printers: Brother.' },
  ];
  it('keeps only a short tail on a new topic so earlier answers cannot be echoed', () => {
    const b = boundConversationContext(turns, 'What is the capital of France?');
    expect(b.newTopic).toBe(true);
    expect(b.turns.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(b.turns)).not.toContain('Contract Type');
  });
  it('keeps the wider window for a related or resume request', () => {
    expect(boundConversationContext(turns, 'Continue').turns.length).toBe(6);
    expect(boundConversationContext(turns, 'show the contracts table again').newTopic).toBe(false);
  });
  it('caps each turn', () => {
    const b = boundConversationContext([{ role: 'assistant', content: 'x'.repeat(MAX_TURN_CHARS * 3) }], 'hello');
    expect(b.turns[0].content.length).toBeLessThan(MAX_TURN_CHARS + 60);
  });
  it('detects resume wording', () => {
    expect(isExplicitResumeRequest('Print a test page')).toBe(false);
    expect(isExplicitResumeRequest('resume')).toBe(true);
  });
});
