import { AgentPhase } from './AgentEngineTypes';

export type SessionContextDecision =
  | 'start-clean'
  | 'continue-completed-history'
  | 'explicit-resume';

export interface SessionContextRequest {
  conversationId: string;
  currentHead?: string;
  currentPhase?: AgentPhase;
  explicitResumeTaskId?: string;
}

export interface SessionContextResolution {
  decision: SessionContextDecision;
  taskId?: string;
  includeCompletedHistory: boolean;
  reason: string;
}

/**
 * Every normal user turn starts with clean model context. Durable task history is
 * available only through an explicit resume action so an unrelated prior task
 * can never be revived merely because the same conversation id was reused.
 * The legacy continue-completed-history decision remains in the public type for
 * compatibility but is intentionally never returned by this gate.
 */
export class SessionContextGate {
  resolve(request: SessionContextRequest): SessionContextResolution {
    if (!request.conversationId.trim()) {
      throw new Error('Conversation id is required for context isolation.');
    }

    if (request.explicitResumeTaskId) {
      return {
        decision: 'explicit-resume',
        taskId: request.explicitResumeTaskId,
        includeCompletedHistory: false,
        reason: 'The user explicitly selected a durable task to resume.',
      };
    }

    if (!request.currentHead || !request.currentPhase) {
      return {
        decision: 'start-clean',
        includeCompletedHistory: false,
        reason: 'No durable task is attached to this conversation session.',
      };
    }

    return {
      decision: 'start-clean',
      includeCompletedHistory: false,
      reason: `Prior task ${request.currentHead} in phase ${request.currentPhase} is isolated from the new request.`,
    };
  }
}
