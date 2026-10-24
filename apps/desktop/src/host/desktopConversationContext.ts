import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type {
  ConversationExport,
  ConversationWorkingStateRecord,
} from '../../../../core/shared/wireTypes';
import type { ConversationContextView } from '../ipc';

/** Must stay identical to the workspace identity used by the existing
 * Durable Conversational Continuity layer in src/ui/AgentPanel.ts. */
export function conversationWorkspaceIdentity(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot).replace(/\\/g, '/');
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256')
    .update(`workspace:${normalized}`)
    .digest('hex')
    .slice(0, 24);
}

export function buildConversationContextView(input: {
  exported: ConversationExport;
  workingState: ConversationWorkingStateRecord | null;
  repositoryName: string | null;
  workspaceSelected: boolean;
}): ConversationContextView {
  const { exported, workingState } = input;
  const attachments = new Set<string>();
  let citationCount = 0;
  for (const message of exported.messages) {
    for (const attachment of message.attachments) {
      if (!attachment.deletedAt) attachments.add(attachment.originalName);
    }
    citationCount += message.citations.length;
  }
  const researchSourceCount = exported.research.reduce((sum, item) => sum + item.sources.length, 0);

  return {
    state: workingState ? 'available' : (input.workspaceSelected ? 'not_recorded' : 'no_workspace'),
    repositoryName: input.repositoryName,
    objective: workingState?.currentObjective ?? null,
    latestUserIntent: workingState?.latestUserIntent ?? null,
    executionPolicy: workingState?.latestExecutionPolicy ?? null,
    pendingAction: workingState?.pendingAction?.description ?? null,
    relevantFiles: workingState?.relevantFiles.map((file) => file.path) ?? [],
    relevantSymbols: workingState?.relevantSymbols ?? [],
    constraints: workingState?.userConstraints.map((constraint) => constraint.text) ?? [],
    findings: workingState?.latestFindingsSummary ?? null,
    validation: workingState?.latestValidationSummary ?? null,
    attachmentNames: [...attachments].sort((a, b) => a.localeCompare(b)),
    citationCount,
    researchSourceCount,
    messageCount: exported.messages.filter((message) => message.role === 'user' || message.role === 'assistant').length,
    updatedAt: workingState?.updatedAt ?? exported.conversation.updatedAt,
  };
}
