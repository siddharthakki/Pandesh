import { describe, expect, it } from 'vitest';
import { ContextBudgetPlanner, IMAGE_TOKEN_ALLOWANCE } from '../../reliability/ContextBudget';
import { ModelProfileRegistry, resolveContextLimit } from '../../reliability/ModelProfiles';
import { ToolCallNormalizer, ToolLoopDetector } from '../../reliability/ToolCallReliability';
import { ChatMessage, ToolDefinition } from '../../tools/ToolTypes';

const readFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

const CONTENT_CATEGORIES = new Set([
  'system',
  'tool_definitions',
  'task_goal',
  'repository_context',
  'recent_conversation',
  'tool_results',
  'image_payload',
]);

describe('M11 model profiles and context limits', () => {
  it('resolves Qwen coder by family and keeps provider runtime below advertised context', () => {
    const profile = ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama');
    expect(profile.id).toBe('qwen-coder-local');
    const limit = resolveContextLimit({
      model: 'qwen3-coder:30b',
      profile,
      providerRuntimeLimit: 32768,
      declaredLimit: 131072,
    });
    expect(limit.effectiveLimit).toBe(32768);
    expect(limit.provenance).toBe('provider_runtime');
  });

  it('marks unknown models as conservative fallback estimates', () => {
    const profile = ModelProfileRegistry.resolve('local-mystery:latest', 'openai-compatible');
    const limit = resolveContextLimit({ model: 'local-mystery:latest', profile });
    expect(profile.fallback).toBe(true);
    expect(limit.fallback).toBe(true);
    expect(limit.provenance).toBe('profile_operational');
    expect(limit.estimated).toBe(true);
  });

  it('honors explicit user override first', () => {
    const profile = ModelProfileRegistry.resolve('llama3.1:8b', 'ollama');
    const limit = resolveContextLimit({
      model: 'llama3.1:8b',
      profile,
      userOverride: 12000,
      providerRuntimeLimit: 32768,
    });
    expect(limit.effectiveLimit).toBe(12000);
    expect(limit.provenance).toBe('user_override');
  });

  it('resolves the vision minimum before preflight and records it on the resolution', () => {
    const profile = ModelProfileRegistry.resolve('qwen2.5vl:7b', 'ollama');
    const limit = resolveContextLimit({
      model: 'qwen2.5vl:7b',
      profile,
      userOverride: 8192,
      visionMinimum: 16384,
    });
    expect(limit.effectiveLimit).toBe(16384);
    expect(limit.visionMinimumApplied).toBe(true);

    const untouched = resolveContextLimit({
      model: 'qwen2.5vl:7b',
      profile,
      userOverride: 32768,
      visionMinimum: 16384,
    });
    expect(untouched.effectiveLimit).toBe(32768);
    expect(untouched.visionMinimumApplied).toBe(false);
  });
});

describe('M11 context budgeting', () => {
  const profile = ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama');

  function preflight(messages: ChatMessage[], effectiveLimit: number, maxOutputTokens: number) {
    const limit = resolveContextLimit({ model: 'qwen3-coder:30b', profile, userOverride: effectiveLimit });
    return new ContextBudgetPlanner().preflight({
      messages,
      tools: [readFileTool],
      profile,
      limit,
      maxOutputTokens,
    });
  }

  it('blocks an oversized request before dispatch with a structured reason', () => {
    const result = preflight(
      [
        { role: 'system', content: 'You are safe.' },
        { role: 'user', content: 'x'.repeat(6000) },
      ],
      1000,
      256,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('Request blocked before model dispatch');
  });

  it('reserves exactly the requested output allowance (never less)', () => {
    const result = preflight(
      [
        { role: 'system', content: 'You are safe.' },
        { role: 'user', content: 'Read package.json.' },
      ],
      32768,
      512,
    );
    expect(result.ok).toBe(true);
    expect(result.outputReserve).toBe(512);
    expect(result.repairReserve).toBe(profile.safeRepairReserve);
    expect(result.categories.map(item => item.category)).toContain('tool_definitions');
  });

  it('sums content categories to exactly the content-token total (no duplicate allocation)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: '[Attached file: a.ts]\n```ts\ncode\n```' },
      { role: 'assistant', content: 'Working on it.', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: { path: 'a.ts' } } }] },
      { role: 'tool', content: 'file contents', tool_call_id: 'call_1', tool_name: 'read_file' },
      { role: 'user', content: 'Now summarize.' },
    ];
    const result = preflight(messages, 32768, 512);
    const contentSum = result.categories
      .filter(item => CONTENT_CATEGORIES.has(item.category))
      .reduce((sum, item) => sum + item.tokens, 0);
    expect(contentSum).toBe(result.contentTokens);
    expect(result.projectedTotal).toBe(
      result.contentTokens + result.protocolOverhead + result.safetyMargin + result.outputReserve + result.repairReserve,
    );
  });

  it('accounts image payloads with the documented conservative allowance instead of ignoring them', () => {
    const withImage = preflight(
      [{ role: 'user', content: 'Describe.', images: ['aGVsbG8='] }],
      32768,
      512,
    );
    const imageCategory = withImage.categories.find(item => item.category === 'image_payload');
    expect(imageCategory?.tokens).toBe(IMAGE_TOKEN_ALLOWANCE);
  });

  it('accepts a projection exactly at the limit and blocks one token above', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are safe.' },
      { role: 'user', content: 'y'.repeat(1200) },
    ];
    // Measure against a huge limit first so the projection is limit-independent.
    const measured = preflight(messages, 1_000_000, 256);
    const exact = preflight(messages, measured.projectedTotal, 256);
    expect(exact.ok).toBe(true);
    const oneUnder = preflight(messages, measured.projectedTotal - 1, 256);
    expect(oneUnder.ok).toBe(false);
    expect(oneUnder.status).toBe('blocked');
  });

  it('fails closed on invalid/zero context configuration', () => {
    const limit = { ...resolveContextLimit({ model: 'qwen3-coder:30b', profile }), effectiveLimit: 0 };
    const result = new ContextBudgetPlanner().preflight({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      profile,
      limit,
      maxOutputTokens: 128,
    });
    expect(result.ok).toBe(false);
  });
});

describe('M11 tool-call normalization and repair', () => {
  const normalizer = new ToolCallNormalizer();
  const profile = ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama');

  it('normalizes fenced JSON and validates required arguments', () => {
    const result = normalizer.normalize({
      content: '```json\n{"name":"read_file","arguments":{"path":"src/index.ts"}}\n```',
      nativeCalls: undefined,
      tools: [readFileTool],
      profile,
      repairBudgetTokens: 512,
    });
    expect(result.ok).toBe(true);
    expect(result.calls[0].function.name).toBe('read_file');
    expect(result.steps).toContain('fenced_json');
  });

  it('repairs a single trailing comma but refuses to invent missing sensitive args', () => {
    const repaired = normalizer.normalize({
      content: '```json\n{"name":"read_file","arguments":{"path":"README.md",}}\n```',
      nativeCalls: undefined,
      tools: [readFileTool],
      profile,
      repairBudgetTokens: 512,
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.repaired).toBe(true);
    expect(repaired.repair.attempted).toBe(true);
    expect(repaired.repair.result).toBe('succeeded');

    const denied = normalizer.normalize({
      content: '```json\n{"name":"read_file","arguments":{}}\n```',
      nativeCalls: undefined,
      tools: [readFileTool],
      profile,
      repairBudgetTokens: 512,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain('Missing required field');
  });

  it('fails closed on unknown tool names instead of passing them as prose', () => {
    const result = normalizer.normalize({
      content: '{"name":"readfile","arguments":{"path":"README.md"}}',
      nativeCalls: undefined,
      tools: [readFileTool],
      profile: ModelProfileRegistry.resolve('llama3.1:8b', 'ollama'),
      repairBudgetTokens: 512,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unknown_tool');
  });
});

describe('M11 tool-loop detection', () => {
  it('stops identical consecutive calls with no intervening progress', () => {
    const detector = new ToolLoopDetector(2);
    const call = { function: { name: 'read_file', arguments: { path: 'README.md' } } };
    expect(detector.beforeDispatch(call).ok).toBe(true);
    detector.recordResult(call, {
      ok: true,
      mutatedWorkspace: false,
      classification: 'success',
      resultFingerprint: 'same',
    });
    const duplicate = detector.beforeDispatch(call);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.code).toBe('duplicate_tool_call');
  });

  it('stops short alternating cycles only when results show no progress', () => {
    const detector = new ToolLoopDetector(2);
    const a = { function: { name: 'read_file', arguments: { path: 'a.ts' } } };
    const b = { function: { name: 'read_file', arguments: { path: 'b.ts' } } };
    const observe = (call: typeof a, fingerprint: string) =>
      detector.recordResult(call, { ok: true, mutatedWorkspace: false, classification: 'success', resultFingerprint: fingerprint });

    expect(detector.beforeDispatch(a).ok).toBe(true);
    observe(a, 'a-result');
    expect(detector.beforeDispatch(b).ok).toBe(true);
    observe(b, 'b-result');
    expect(detector.beforeDispatch(a).ok).toBe(true);
    observe(a, 'a-result');
    const cycle = detector.beforeDispatch(b);
    expect(cycle.ok).toBe(false);
    expect(cycle.code).toBe('tool_loop_detected');
  });
});
