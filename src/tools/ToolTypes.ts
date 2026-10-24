import type { ContextPreflightResult } from '../reliability/ContextBudget';
import type { RepositoryIntelligenceStatus } from '../context/RepositoryTypes';

export type ToolResult =
  | { ok: true; data: unknown; summary?: string }
  | {
      ok: false;
      error: string;
      blocked?: boolean;
      requiresApproval?: boolean;
      policyViolation?: boolean;
    };

export interface ToolCall {
  /**
   * Provider-assigned call identifier.
   * Populated by OpenAICompatibleProvider so tool results can be paired with
   * the correct tool_call_id on the next request. Absent for Ollama responses.
   */
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface RegisteredTool {
  schema: ToolDefinition;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  riskLevel: RiskLevel;
  mutatesWorkspace: boolean;
  requiresWorkspace: boolean;
}

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export type AgentMode = 'ask' | 'plan' | 'agent' | 'chat';

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  /** Durable task ID — set once a TaskStore task has been created. */
  taskId?: string;
  turnId: string;
  model: string;
  mode?: AgentMode;
  iterationId?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  /** Neutral identity for a tool-result message. */
  tool_call_id?: string;
  /** Human-readable tool name retained across task resume. */
  tool_name?: string;
  images?: string[];
  timestamp?: string;
}

export interface ChatResponse {
  message: ChatMessage;
  done: boolean;
}

/** @deprecated Use ChatMessage */
export type OllamaMessage = ChatMessage;
/** @deprecated Use ChatResponse */
export type OllamaResponse = ChatResponse;

// Canonical event interfaces
export interface ToolExecutionEvents {
  onToolStart?: (
    toolName: string,
    args: Record<string, unknown>
  ) => void;

  onToolResult?: (
    toolName: string,
    result: ToolResult
  ) => void;
}

export interface AgentLoopEvents extends ToolExecutionEvents {
  onToken?: (delta: string) => void;
  onAssistantContent?: (content: string) => void;
  onIterationStart?: (iteration: number) => void;
  onContextUsage?: (usage: ContextPreflightResult) => void;
  onRepositoryContext?: (status: RepositoryIntelligenceStatus) => void;
  onReliabilityEvent?: (event: { code: string; message: string; pattern?: string; steps?: string[] }) => void;
  onModelSelected?: (model: string, reason: string) => void;
  onDone?: (finalContent: string) => void;
  onError?: (error: string) => void;
  onStopped?: () => void;
  onApprovalRequest?: (id: string, toolName: string, args: Record<string, unknown>, reason: string, riskLevel: string) => void;
}
