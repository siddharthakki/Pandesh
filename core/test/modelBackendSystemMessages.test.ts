import { describe, expect, it } from 'vitest';
import { normalizeSystemMessagesForOllama } from '../runtime/modelBackend';

describe('normalizeSystemMessagesForOllama', () => {
  it('merges leading system messages into one (strict chat templates reject a second system message)', () => {
    const out = normalizeSystemMessagesForOllama([
      { role: 'system', content: 'base prompt' },
      { role: 'system', content: 'continuity brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'next' },
    ]);
    expect(out.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(out[0].content).toBe('base prompt\n\ncontinuity brief');
  });

  it('presents a later system message as a labelled user note', () => {
    const out = normalizeSystemMessagesForOllama([
      { role: 'system', content: 'base' },
      { role: 'user', content: 'edit it' },
      { role: 'assistant', content: 'prose only' },
      { role: 'system', content: 'Use propose_file_change.' },
    ]);
    expect(out.filter(message => message.role === 'system')).toHaveLength(1);
    expect(out[3]).toMatchObject({ role: 'user', content: '[System note] Use propose_file_change.' });
  });

  it('leaves a conversation without system messages untouched', () => {
    const input = [{ role: 'user' as const, content: 'hi' }];
    expect(normalizeSystemMessagesForOllama(input)).toEqual(input);
  });
});
