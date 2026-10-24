export type AgentMode = 'ask' | 'plan' | 'agent' | 'chat';

/** Which inference backend to route requests to. */
export type ProviderType = 'ollama' | 'openai-compatible';

/**
 * Repository-data boundary for automatic model routing.
 *
 * - 'local-only'                  — only the configured local provider may ever
 *                                   receive repository/task context.
 * - 'local-first-cloud-fallback'  — local is still tried first; a configured
 *                                   cloud endpoint may receive the same context
 *                                   for exactly one bounded retry after a
 *                                   recoverable local runtime failure.
 */
export type ModelRoutingPolicy = 'local-only' | 'local-first-cloud-fallback';

/** The three user-facing modes whose model can be configured independently. */
export type ConfiguredMode = 'baat_kar' | 'saath_kar' | 'karke_dikha';

export interface AgentConfig {
  model: string;
  apiBase: string;
  providerType: ProviderType;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  allowOutsideWorkspace: boolean;
  maxIterations: number;
  maxToolOutputChars: number;
  maxFileReadChars: number;
  requireApprovalForWrites: boolean;
  requireApprovalForCommands: boolean;
  enableAuditLog: boolean;
  enableCheckpoints: boolean;
}
