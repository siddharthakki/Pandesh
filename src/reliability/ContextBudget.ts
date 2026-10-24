import { ChatMessage, ToolDefinition } from '../tools/ToolTypes';
import { ContextLimitResolution, ModelProfile, TokenCountingStrategy } from './ModelProfiles';
import { StructuredOutputDecision } from './StructuredOutput';

export type ContextBudgetCategory =
  | 'system'
  | 'tool_definitions'
  | 'task_goal'
  | 'repository_context'
  | 'recent_conversation'
  | 'tool_results'
  | 'image_payload'
  | 'model_output_reserve'
  | 'repair_reserve'
  | 'protocol_overhead'
  | 'safety_margin';

/** Content categories partition the outgoing payload; each message is assigned to exactly one. */
const CONTENT_CATEGORIES: readonly ContextBudgetCategory[] = [
  'system',
  'tool_definitions',
  'task_goal',
  'repository_context',
  'recent_conversation',
  'tool_results',
  'image_payload',
];

export interface ContextCategoryUsage {
  category: ContextBudgetCategory;
  tokens: number;
  estimated: boolean;
}

export type ContextStatus = 'safe' | 'near_limit' | 'blocked' | 'unknown_fallback';

/**
 * Conservative allowance per attached image. Providers transmit images as
 * base64 but models consume them as vision tokens; the true count depends on
 * resolution and the vision encoder, which this extension cannot observe.
 * This documented estimate deliberately over-reserves rather than ignoring
 * image payloads. Local Qwen-VL-class encoders consume roughly 256–1800
 * tokens per image at supported resolutions.
 */
export const IMAGE_TOKEN_ALLOWANCE = 2048;

export interface ContextPreflightResult {
  ok: boolean;
  status: ContextStatus;
  reason?: string;
  countingMode: 'exact' | 'estimated';
  limit: ContextLimitResolution;
  /** Sum of content categories (each payload segment counted exactly once). */
  contentTokens: number;
  inputTokens: number;
  outputReserve: number;
  repairReserve: number;
  safetyMargin: number;
  protocolOverhead: number;
  projectedTotal: number;
  percentUsed: number;
  categories: ContextCategoryUsage[];
  /** Structured-output decision for this dispatch, when resolved by the shared planner. */
  structuredOutput?: StructuredOutputDecision;
}

export class ConservativeTokenCounter {
  count(text: string, strategy: TokenCountingStrategy): number {
    if (text.length === 0) { return 0; }
    const charsPerToken = strategy === 'qwen' ? 2.8 : strategy === 'glm' ? 2.9 : strategy === 'mistral' ? 3.1 : strategy === 'llama' ? 3.2 : 2.6;
    return Math.max(1, Math.ceil(text.length / charsPerToken));
  }

  countJson(value: unknown, strategy: TokenCountingStrategy): number {
    return this.count(JSON.stringify(value), strategy);
  }
}

/**
 * Serializes one message the way providers transmit it — role, content,
 * tool calls (ids, names, arguments), tool_call_id and tool_name — excluding
 * image payloads, which are counted separately via IMAGE_TOKEN_ALLOWANCE
 * (base64 length is not a meaningful proxy for vision tokens).
 */
function transmittedMessageShape(message: ChatMessage): Record<string, unknown> {
  const shape: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls && message.tool_calls.length > 0) { shape['tool_calls'] = message.tool_calls; }
  if (message.tool_call_id !== undefined) { shape['tool_call_id'] = message.tool_call_id; }
  if (message.tool_name !== undefined) { shape['tool_name'] = message.tool_name; }
  return shape;
}

function isRepositoryContextMessage(message: ChatMessage): boolean {
  return /```|\[Attached|repository|file:/i.test(message.content);
}

export class ContextBudgetPlanner {
  private readonly counter = new ConservativeTokenCounter();

  preflight(input: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    profile: ModelProfile;
    limit: ContextLimitResolution;
    /**
     * The authoritative output allowance. The caller must pass exactly the
     * value it will send to the provider (num_predict / max_tokens); this
     * planner reserves exactly that amount — never less.
     */
    maxOutputTokens: number;
  }): ContextPreflightResult {
    const strategy = input.profile.tokenizer;
    const totals = new Map<ContextBudgetCategory, number>();
    const addTo = (category: ContextBudgetCategory, tokens: number): void => {
      totals.set(category, (totals.get(category) ?? 0) + Math.max(0, Math.ceil(tokens)));
    };
    for (const category of CONTENT_CATEGORIES) { totals.set(category, 0); }

    // Assign every message to exactly one content category, counting the
    // full serialized shape the provider transmits.
    const lastUserIndex = findLastUserIndex(input.messages);
    input.messages.forEach((message, index) => {
      const tokens = this.counter.countJson(transmittedMessageShape(message), strategy);
      if (message.role === 'system') {
        addTo('system', tokens);
      } else if (message.role === 'tool') {
        addTo('tool_results', tokens);
      } else if (message.role === 'user' && index === lastUserIndex) {
        addTo('task_goal', tokens);
      } else if (message.role === 'user' && isRepositoryContextMessage(message)) {
        addTo('repository_context', tokens);
      } else {
        addTo('recent_conversation', tokens);
      }
      const imageCount = message.images?.length ?? 0;
      if (imageCount > 0) {
        addTo('image_payload', imageCount * IMAGE_TOKEN_ALLOWANCE);
      }
    });
    addTo('tool_definitions', input.tools.length > 0 ? this.counter.countJson(input.tools, strategy) : 0);

    const contentTokens = CONTENT_CATEGORIES.reduce((sum, category) => sum + (totals.get(category) ?? 0), 0);
    // Reserve exactly the provider-requested output allowance (Blocker 4).
    const outputReserve = Math.max(0, Math.ceil(input.maxOutputTokens));
    const repairReserve = Math.max(0, Math.ceil(input.profile.safeRepairReserve));
    const protocolOverhead = Math.ceil((input.messages.length * 8) + (input.tools.length * 16) + 64);
    const safetyMargin = Math.ceil((contentTokens + protocolOverhead) * 0.08);

    const categories: ContextCategoryUsage[] = [
      ...CONTENT_CATEGORIES.map(category => ({ category, tokens: totals.get(category) ?? 0, estimated: true })),
      { category: 'model_output_reserve', tokens: outputReserve, estimated: false },
      { category: 'repair_reserve', tokens: repairReserve, estimated: false },
      { category: 'protocol_overhead', tokens: protocolOverhead, estimated: true },
      { category: 'safety_margin', tokens: safetyMargin, estimated: true },
    ];

    const inputTokens = contentTokens + protocolOverhead + safetyMargin;
    const projectedTotal = inputTokens + outputReserve + repairReserve;
    const percentUsed = input.limit.effectiveLimit > 0 ? Math.round((projectedTotal / input.limit.effectiveLimit) * 1000) / 10 : 100;
    const ok = input.limit.effectiveLimit > 0 && projectedTotal <= input.limit.effectiveLimit;
    const status: ContextStatus = ok
      ? input.limit.fallback
        ? 'unknown_fallback'
        : percentUsed >= 85
          ? 'near_limit'
          : 'safe'
      : 'blocked';
    return {
      ok,
      status,
      reason: ok ? undefined : `Request blocked before model dispatch: projected ${projectedTotal.toLocaleString()} tokens exceeds the safe ${input.limit.effectiveLimit.toLocaleString()}-token limit after reserving ${outputReserve.toLocaleString()} output tokens.`,
      countingMode: 'estimated',
      limit: input.limit,
      contentTokens,
      inputTokens,
      outputReserve,
      repairReserve,
      safetyMargin,
      protocolOverhead,
      projectedTotal,
      percentUsed,
      categories,
    };
  }
}

function findLastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') { return index; }
  }
  return -1;
}
