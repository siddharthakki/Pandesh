import { describe, expect, it } from 'vitest';
import type { ConversationExport, ConversationWorkingStateRecord } from '../../../core/shared/wireTypes';
import { buildConversationContextView, conversationWorkspaceIdentity } from '../src/host/desktopConversationContext';

function exportedConversation(): ConversationExport {
  return {
    schemaVersion: 1,
    exportedAt: '2026-09-17T10:02:00.000Z',
    conversation: {
      id: 'conv_1', mode: 'baat_kar', projectId: null, repositoryId: null, title: 'Example',
      createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-17T10:02:00.000Z', archivedAt: null, pinnedAt: null, revision: 1,
    },
    branch: null,
    messages: [
      { seq: 1, id: 'm1', conversationId: 'conv_1', role: 'user', content: 'Inspect it', modelInvocationId: null, createdAt: '2026-09-17T10:00:00.000Z', attachments: [], citations: [], alternatives: [] },
      { seq: 2, id: 'm2', conversationId: 'conv_1', role: 'assistant', content: 'Done', modelInvocationId: null, createdAt: '2026-09-17T10:01:00.000Z', attachments: [], citations: [{ id: 'cite_1', assistantMessageId: 'm2', sourceId: 'source_1', visibleLabel: 'Source', evidenceReference: null, validationStatus: 'valid' }], alternatives: [] },
    ],
    research: [],
  };
}

function workingState(): ConversationWorkingStateRecord {
  return {
    conversationId: 'conv_1', workspaceIdentity: 'workspace', objectiveId: 'obj_1',
    currentObjective: 'Inspect the repository', latestUserIntent: 'Continue', latestExecutionPolicy: 'READ_ONLY',
    relevantFiles: [{ path: 'src/app.ts', contentHash: 'a'.repeat(64), observedAt: '2026-09-17T10:01:00.000Z' }],
    relevantSymbols: ['start'], userConstraints: [{ id: 'c1', text: 'Do not edit files', createdAt: '2026-09-17T10:00:00.000Z' }],
    latestFindingsSummary: 'The entry point is src/app.ts.', pendingAction: { kind: 'resume_work', description: 'Inspect tests' },
    latestTaskId: null, latestProposalId: null, latestValidationSummary: 'Not run',
    pendingNewObjective: false, awaitingObjectiveClarification: false,
    createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-17T10:02:00.000Z', version: 2,
  };
}

describe('Desktop conversation context projection', () => {
  it('shows only bounded working context and counts from the Core export', () => {
    const view = buildConversationContextView({ exported: exportedConversation(), workingState: workingState(), repositoryName: 'repo', workspaceSelected: true });
    expect(view).toMatchObject({ state: 'available', repositoryName: 'repo', objective: 'Inspect the repository', pendingAction: 'Inspect tests', relevantFiles: ['src/app.ts'], constraints: ['Do not edit files'], messageCount: 2, citationCount: 1 });
    expect(JSON.stringify(view)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(view)).not.toContain('modelInvocationId');
  });

  it('does not invent an objective from transcript text when no working state exists', () => {
    const view = buildConversationContextView({ exported: exportedConversation(), workingState: null, repositoryName: null, workspaceSelected: false });
    expect(view.state).toBe('no_workspace');
    expect(view.objective).toBeNull();
    expect(view.latestUserIntent).toBeNull();
  });

  it('uses a stable workspace identity and changes it for another root', () => {
    expect(conversationWorkspaceIdentity('C:\\Projects\\one')).toBe(conversationWorkspaceIdentity('C:\\Projects\\one'));
    expect(conversationWorkspaceIdentity('C:\\Projects\\one')).not.toBe(conversationWorkspaceIdentity('C:\\Projects\\two'));
  });
});
