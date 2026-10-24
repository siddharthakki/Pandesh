import { describe, expect, it } from 'vitest';
import { TokenBudget } from '../../models/TokenBudget';
import { ChatMessage } from '../../tools/ToolTypes';

describe('TokenBudget metadata', () => {
  it('retains tool identifiers while shortening old output', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_123',
          function: { name: 'read_file', arguments: { path: 'large.txt' } },
        }],
      },
      {
        role: 'tool',
        content: 'long output '.repeat(200),
        tool_call_id: 'call_123',
        tool_name: 'read_file',
      },
      { role: 'assistant', content: 'continue' },
      { role: 'user', content: 'next' },
    ];

    const pruned = TokenBudget.pruneOldToolResults(messages, 100);
    const tool = pruned.find(message => message.role === 'tool');
    expect(tool?.content).toBe('[truncated for context budget]');
    expect(tool?.tool_call_id).toBe('call_123');
    expect(tool?.tool_name).toBe('read_file');
  });

  it('does not alter the caller-owned message', () => {
    const original: ChatMessage = {
      role: 'tool',
      content: 'long output '.repeat(200),
      tool_call_id: 'call_456',
      tool_name: 'grep',
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      original,
      { role: 'assistant', content: 'continue' },
      { role: 'user', content: 'next' },
    ];

    TokenBudget.pruneOldToolResults(messages, 50);
    expect(original.content).toBe('long output '.repeat(200));
  });
});
