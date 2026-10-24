export type HookEvent =
  | 'beforeToolExecute'
  | 'afterToolExecute'
  | 'beforeAgentLoop'
  | 'afterAgentLoop';

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  sessionId: string;
}

export type HookFn = (ctx: HookContext) => Promise<void> | void;
