import { OllamaMessage } from '../tools/ToolTypes';

export class TokenBudget {
  // Rough estimate: 1 token ≈ 4 characters
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  static estimateMessagesTokens(messages: OllamaMessage[]): number {
    return messages.reduce((sum, message) => {
      const toolCalls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
      return sum + this.estimateTokens(`${message.content}${toolCalls}`);
    }, 0);
  }

  static wouldExceedBudget(messages: OllamaMessage[], budget: number): boolean {
    return this.estimateMessagesTokens(messages) > budget;
  }

  static pruneOldToolResults(messages: OllamaMessage[], budget: number): OllamaMessage[] {
    if (!this.wouldExceedBudget(messages, budget)) {
      return messages;
    }

    const result = messages.map(message => ({ ...message }));
    let index = 1;
    while (this.wouldExceedBudget(result, budget) && index < result.length - 2) {
      if (result[index].role === 'tool' && result[index].content !== '[truncated for context budget]') {
        result[index] = {
          ...result[index],
          content: '[truncated for context budget]',
        };
      }
      index++;
    }
    return result;
  }
}
