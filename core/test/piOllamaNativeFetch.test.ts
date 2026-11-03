import { describe, it, expect } from 'vitest';
import { toOllamaMessages } from '../runtime/piOllamaNativeFetch';

describe('toOllamaMessages', () => {
  it('maps OpenAI tool calls, tool results and images to the native /api/chat shape', () => {
    const out = toOllamaMessages([
      { role: 'developer', content: 'rules' },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.pdf"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Total EUR 10' },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'rules' });
    expect(out[1]).toEqual({ role: 'user', content: 'what is this?', images: ['AAAA'] });
    expect(out[2]).toEqual({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.pdf' } } }] });
    expect(out[3]).toEqual({ role: 'tool', content: 'Total EUR 10', tool_call_id: 'c1', tool_name: 'read_file' });
  });

  it('tolerates malformed tool arguments instead of failing the turn', () => {
    const [msg] = toOllamaMessages([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{oops' } }] }]);
    expect(msg.tool_calls).toEqual([{ function: { name: 'f', arguments: {} } }]);
  });
});
