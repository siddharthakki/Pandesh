import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodingPlanner } from '../../coding/CodingPlanner';
import { ProviderGatewayGovernedModelExecutionDependency } from '../../agent/ProviderGatewayGovernedModelExecutionDependency';
import type { InferenceProvider } from '../../providers/ProviderTypes';
import type { ChatMessage, ToolDefinition } from '../../tools/ToolTypes';
import * as vscodeMock from '../mocks/vscode';

// Regression for a real dogfood run (att_144a4f36-acf9-4139-8ca2-8b99a6b339d7):
// GovernedModelExecutionDispatcher (via ProviderGatewayGovernedModelExecutionDependency)
// already distinguishes *which* invalid-response shape occurred — not_done,
// unexpected_tool_call or empty_content — specifically so durable evidence can
// record which one happened without ever persisting the raw response (see the
// GOVERNED_MODEL_INVALID_RESPONSE_REASONS doc comment). FixedMultiAgentGraph's
// full five-stage path already propagates this sub-reason. CodingPlanner's
// lightweight single-shot path silently dropped it, so a real failure of this
// kind reached the durable task with only the generic classification
// "invalid_model_response" and no way to tell which of the three cases fired
// short of an undifferentiated rerun.
describe('CodingPlanner invalid-model-response sub-reason propagation', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-planner-invalid-response-'));
    vscodeMock._resetConfig();
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function planWithChatResponse(response: { content?: string; tool_calls?: unknown[]; done?: boolean }) {
    const chat = vi.fn(async (_messages: ChatMessage[], _tools: ToolDefinition[]) => ({
      message: { role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls },
      done: response.done ?? true,
    }));
    const provider = { providerType: 'ollama', chat } as unknown as InferenceProvider;
    const planner = new CodingPlanner(root, new ProviderGatewayGovernedModelExecutionDependency(async () => provider), {
      model: 'unknown-model:latest',
      providerType: 'ollama',
    });
    return planner.plan('Create one generated TypeScript file.');
  }

  it('preserves unexpected_tool_call alongside invalid_model_response when the provider spontaneously emits tool calls', async () => {
    const result = await planWithChatResponse({
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'some_tool', arguments: {} } }],
    });
    expect(result.proposal).toBeUndefined();
    expect(result.governedResult.failureCode).toBe('invalid_model_response');
    expect(result.governedResult.invalidResponseReason).toBe('unexpected_tool_call');
    // This is the regression: the sub-reason must reach the caller's errors
    // (and therefore the durable task's failure.message), not only the
    // generic failureCode.
    expect(result.errors).toEqual(['invalid_model_response', 'unexpected_tool_call']);
  });

  it('preserves empty_content alongside invalid_model_response for a blank completion', async () => {
    const result = await planWithChatResponse({ content: '' });
    expect(result.governedResult.invalidResponseReason).toBe('empty_content');
    expect(result.errors).toEqual(['invalid_model_response', 'empty_content']);
  });

  it('preserves not_done alongside invalid_model_response when the response never completed', async () => {
    const result = await planWithChatResponse({ content: 'partial', done: false });
    expect(result.governedResult.invalidResponseReason).toBe('not_done');
    expect(result.errors).toEqual(['invalid_model_response', 'not_done']);
  });
});
