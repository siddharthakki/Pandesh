/**
 * Provider-neutral inference type definitions.
 *
 * These types form the contract between AgentLoop and every inference backend.
 * Providers must not leak wire-format types (OllamaRawMessage, OAI wire types, etc.)
 * through this boundary.
 */

// Re-export the shared types that are already used throughout the codebase so
// code importing from here gets everything it needs from one place.
export type {
  ChatMessage,
  ChatResponse,
  ToolCall as ChatToolCall,
  ToolDefinition,
} from '../tools/ToolTypes';

import type { ToolCall } from '../tools/ToolTypes';
import type { ProviderChatOptions } from './ProviderTypes';

/** A fully-formed inference request (messages + tools + options). */
export interface ChatRequest {
  messages: import('../tools/ToolTypes').ChatMessage[];
  tools: import('../tools/ToolTypes').ToolDefinition[];
  options: ProviderChatOptions;
}

/**
 * A tool result ready to be sent back to the model.
 * `toolCallId` is required by the OpenAI wire format for round-trip pairing;
 * Ollama ignores it.
 */
export interface ChatToolResult {
  toolCallId?: string;
  toolName: string;
  content: string;
  ok: boolean;
}

/**
 * Canonical streaming event type.
 * Re-exported from ProviderTypes as the authoritative name; callers should
 * import `ChatStreamEvent` from here going forward.
 */
export type { StreamEvent as ChatStreamEvent } from './ProviderTypes';

/**
 * Base class for all provider errors.
 * Re-exported here so callers import from InferenceTypes rather than ProviderTypes.
 */
export {
  ProviderError,
  ProviderConnectionError,
  ProviderModelNotFoundError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderApiError,
} from './ProviderTypes';

/** Allowed roles a model may serve. Phase 12 will enforce role assignment. */
export type ModelRole =
  | 'chat'
  | 'agent'
  | 'edit'
  | 'autocomplete'
  | 'vision'
  | 'embedding'
  | 'reviewer';
