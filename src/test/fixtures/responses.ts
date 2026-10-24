import type { ChatResponse } from '../../tools/ToolTypes';
import type { StreamEvent } from '../../providers/ProviderTypes';

export const textResponse = (content: string): ChatResponse => ({
  message: { role: 'assistant', content },
  done: true,
});

export const toolCallResponse = (
  name: string,
  args: Record<string, unknown>,
  id?: string,
): ChatResponse => ({
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, function: { name, arguments: args } }],
  },
  done: true,
});

export const streamTokens = (tokens: string[], toolCalls?: Array<{ name: string; args: Record<string, unknown> }>): StreamEvent[] => {
  const events: StreamEvent[] = tokens.map((delta) => ({ type: 'token', delta }));
  if (toolCalls) {
    toolCalls.forEach((tc, idx) => {
      events.push({ type: 'tool_call', index: idx, toolCall: { function: { name: tc.name, arguments: tc.args } } });
    });
  }
  events.push({ type: 'done', content: tokens.join('') });
  return events;
};

export const TOOL_CONTEXT = {
  workspaceRoot: '/fake/workspace',
  sessionId: 'test-session',
  turnId: 'test-turn',
  model: 'test-model',
};
