import * as vscode from 'vscode';
import { ContextAwareAgentRuntime } from './ContextAwareAgentRuntime';
import {
  AgentEngineEvent,
  AgentTaskSnapshot,
  ApprovalDecision,
  EngineSubscription,
  RollbackTarget,
  TaskBudgets,
  TaskFilter,
  ValidationCommandRequest,
} from './AgentEngineTypes';
import { RunSettings } from './LocalAgentEngine';
import { PersistedMessage } from './TaskTypes';
import { ApprovalRequest } from '../policy/ApprovalFlow';
import { AgentMode } from '../config/ConfigSchema';
import { AgentLoopEvents } from '../tools/ToolTypes';
import { rebindPermissionContext } from '../tools/PermissionContext';
import { SessionContextGate } from './SessionContextGate';

const CONTEXT_MARKER = '\n\n## Automatically selected repository context';
const LEGACY_DEFAULT_CONVERSATION = 'default';

type EngineListener = (event: AgentEngineEvent) => void;

function stripInjectedContext(content: string): string {
  const markerIndex = content.indexOf(CONTEXT_MARKER);
  return markerIndex >= 0 ? content.slice(0, markerIndex) : content;
}

function sanitizeTaskPrefix(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return (sanitized || 'conversation').slice(0, 52);
}

function isTerminalPhase(phase: AgentTaskSnapshot['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

export function bindPermissionContextToEffectiveRun(
  settings: RunSettings,
  effectiveTaskId: string,
): RunSettings {
  if (!settings.permissionContext || settings.permissionContext.runId === effectiveTaskId) {
    return settings;
  }
  return {
    ...settings,
    permissionContext: rebindPermissionContext(settings.permissionContext, effectiveTaskId),
  };
}

export class ConversationAwareAgentRuntime extends ContextAwareAgentRuntime {
  private readonly conversationHeads = new Map<string, string>();
  private readonly rootListeners = new Map<string, Set<EngineListener>>();
  private readonly approvalOwners = new Map<string, string>();
  private readonly sessionContextGate = new SessionContextGate();
  private currentConversationId?: string;

  constructor(workspaceRoot: string, secrets: vscode.SecretStorage) {
    super(workspaceRoot, secrets);

    const readPersistedMessages = this.taskStore.getMessages.bind(this.taskStore);
    this.taskStore.getMessages = async taskId => this.sanitizeRestoredMessages(
      await readPersistedMessages(taskId),
    );
  }

  setApprovalRequestCallback(callback: (request: ApprovalRequest) => void): void {
    super.setApprovalRequestCallback(request => {
      const owner = this.getTaskId();
      if (owner) { this.approvalOwners.set(request.id, owner); }
      callback(request);
    });
  }

  async respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<AgentTaskSnapshot>;
  async respondToApproval(approvalId: string, decision: ApprovalDecision): Promise<AgentTaskSnapshot>;
  async respondToApproval(first: string, second: string, third?: ApprovalDecision): Promise<AgentTaskSnapshot> {
    const approvalId = third !== undefined ? second : first;
    const decision = third ?? (second as ApprovalDecision);
    const explicitTaskId = third !== undefined ? first : undefined;
    const mappedOwner = this.approvalOwners.get(approvalId);
    const owner = explicitTaskId
      ?? mappedOwner
      ?? this.getTaskId();
    if (!owner) {
      throw new Error(`No task owns approval ${approvalId}.`);
    }

    try {
      if (mappedOwner === owner) {
        const task = await this.taskStore.getTask(owner);
        if (task?.pendingApprovalId && task.pendingApprovalId !== approvalId) {
          await this.taskStore.updateTask(owner, { pendingApprovalId: undefined });
        }
      }
      return await super.respondToApproval(owner, approvalId, decision);
    } finally {
      this.approvalOwners.delete(approvalId);
    }
  }

  async run(
    text: string,
    mode: AgentMode,
    events: AgentLoopEvents,
    images?: string[],
    modelOverride?: string,
    taskId?: string,
    settings: RunSettings = {},
    budgetOverrides?: Partial<TaskBudgets>,
  ): Promise<void> {
    const requestedConversationId = taskId?.trim();
    const conversationId = requestedConversationId && requestedConversationId !== LEGACY_DEFAULT_CONVERSATION
      ? requestedConversationId
      : this.normalizeConversationId(LEGACY_DEFAULT_CONVERSATION);
    this.currentConversationId = conversationId;

    const currentHead = await this.resolveConversationHead(conversationId);
    let effectiveTaskId = currentHead ?? conversationId;
    let effectiveText = text;

    if (currentHead) {
      const snapshot = await super.getTask(currentHead);
      const resolution = this.sessionContextGate.resolve({
        conversationId,
        currentHead,
        currentPhase: snapshot.phase,
      });

      if (resolution.decision === 'continue-completed-history') {
        effectiveTaskId = this.createTurnTaskId(conversationId);
        const history = await this.buildConversationHistory(currentHead);
        if (history && text.trim()) {
          effectiveText = `${history}\n\nCurrent user request:\n${text}`;
        }
      } else if (resolution.decision === 'start-clean') {
        effectiveTaskId = this.createTurnTaskId(conversationId);
      }
    }

    const effectiveSettings = bindPermissionContextToEffectiveRun(settings, effectiveTaskId);
    this.conversationHeads.set(conversationId, effectiveTaskId);
    const forwardedSubscriptions = this.forwardRootListeners(conversationId, effectiveTaskId);
    try {
      await super.run(
        effectiveText,
        mode,
        events,
        images,
        modelOverride,
        effectiveTaskId,
        effectiveSettings,
        budgetOverrides,
      );
      const actualTaskId = this.getTaskId() ?? effectiveTaskId;
      this.conversationHeads.set(conversationId, actualTaskId);
    } finally {
      forwardedSubscriptions.forEach(subscription => subscription.dispose());
    }
  }

  clearSession(): void {
    this.currentConversationId = undefined;
    super.clearSession();
  }

  subscribe(taskId: string, listener: EngineListener): EngineSubscription {
    const normalized = this.normalizeConversationId(taskId);
    const listeners = this.rootListeners.get(normalized) ?? new Set<EngineListener>();
    listeners.add(listener);
    this.rootListeners.set(normalized, listeners);

    const direct = super.subscribe(normalized, listener);
    return {
      dispose: () => {
        direct.dispose();
        const current = this.rootListeners.get(normalized);
        current?.delete(listener);
        if (current?.size === 0) { this.rootListeners.delete(normalized); }
      },
    };
  }

  async getTask(taskId: string): Promise<AgentTaskSnapshot> {
    const normalized = this.normalizeConversationId(taskId);
    const head = await this.resolveConversationHead(normalized);
    return super.getTask(head ?? normalized);
  }

  async listTasks(filter?: TaskFilter): Promise<AgentTaskSnapshot[]> {
    const tasks = await this.taskStore.listTasks();
    const snapshots: AgentTaskSnapshot[] = [];
    for (const task of tasks) {
      try {
        snapshots.push(await super.getTask(task.taskId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Task not found:/i.test(message)) throw error;
      }
    }
    return snapshots.filter(snapshot => {
      if (filter?.phases && !filter.phases.includes(snapshot.phase)) return false;
      if (filter?.includeTerminal === false && isTerminalPhase(snapshot.phase)) return false;
      return true;
    });
  }

  async pauseTask(taskId: string): Promise<AgentTaskSnapshot> {
    return super.pauseTask(await this.resolveRequiredHead(this.normalizeConversationId(taskId)));
  }

  async resumeTask(taskId: string, settings?: RunSettings): Promise<AgentTaskSnapshot> {
    return super.resumeTask(await this.resolveRequiredHead(this.normalizeConversationId(taskId)), settings);
  }

  async cancelTask(taskId: string): Promise<AgentTaskSnapshot> {
    return super.cancelTask(await this.resolveRequiredHead(this.normalizeConversationId(taskId)));
  }

  async sendSteering(taskId: string, message: string): Promise<AgentTaskSnapshot> {
    return super.sendSteering(await this.resolveRequiredHead(this.normalizeConversationId(taskId)), message);
  }

  async rollbackTask(taskId: string, target: RollbackTarget): Promise<AgentTaskSnapshot> {
    return super.rollbackTask(await this.resolveRequiredHead(this.normalizeConversationId(taskId)), target);
  }

  async resolveConversationHead(conversationId: string): Promise<string | undefined> {
    const normalized = this.normalizeConversationId(conversationId);
    const remembered = this.conversationHeads.get(normalized);
    if (remembered && await this.taskStore.getTask(remembered)) { return remembered; }

    const prefix = `${sanitizeTaskPrefix(normalized)}_turn_`;
    const candidates = (await this.taskStore.listTasks())
      .filter(task => task.taskId === normalized || task.taskId.startsWith(prefix))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const head = candidates[0]?.taskId;
    if (head) { this.conversationHeads.set(normalized, head); }
    return head;
  }

  private async resolveRequiredHead(conversationId: string): Promise<string> {
    return await this.resolveConversationHead(conversationId) ?? conversationId;
  }

  private normalizeConversationId(conversationId: string): string {
    if (conversationId === LEGACY_DEFAULT_CONVERSATION) {
      if (!this.currentConversationId) {
        this.currentConversationId = this.createConversationId();
      }
      return this.currentConversationId;
    }
    return conversationId;
  }

  private forwardRootListeners(
    conversationId: string,
    effectiveTaskId: string,
  ): EngineSubscription[] {
    if (conversationId === effectiveTaskId) { return []; }
    return [...(this.rootListeners.get(conversationId) ?? [])]
      .map(listener => super.subscribe(effectiveTaskId, listener));
  }

  private async buildConversationHistory(taskId: string): Promise<string> {
    const messages = await this.taskStore.getMessages(taskId);
    const relevant = messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-12)
      .map(message => {
        const content = stripInjectedContext(message.content).trim();
        return content ? `${message.role.toUpperCase()}: ${content}` : '';
      })
      .filter(Boolean);
    if (relevant.length === 0) { return ''; }

    const body = relevant.join('\n\n').slice(-12_000);
    return [
      'Conversation history from the previous completed turn:',
      body,
      'Use this history only for continuity. The current user request has priority.',
    ].join('\n\n');
  }

  private sanitizeRestoredMessages(messages: PersistedMessage[]): PersistedMessage[] {
    return messages.map(message => {
      if (message.role === 'assistant' && (message.toolCalls?.length || message.toolCallIds?.length)) {
        const names = message.toolCalls?.map(call => call.function.name).filter(Boolean) ?? [];
        const note = names.length > 0
          ? `[Recovered tool activity: ${names.join(', ')}]`
          : '[Recovered tool activity omitted because the historical record lacks complete call metadata.]';
        return {
          ...message,
          content: [message.content.trim(), note].filter(Boolean).join('\n'),
          toolCalls: undefined,
          toolCallIds: undefined,
        };
      }
      if (message.role === 'tool') {
        const label = message.toolName ? ` from ${message.toolName}` : '';
        return {
          ...message,
          role: 'user',
          content: `[Recovered prior tool result${label}]\n${message.content}`,
          toolCallId: undefined,
          toolName: undefined,
        };
      }
      return message;
    });
  }

  private createTurnTaskId(conversationId: string): string {
    return `${sanitizeTaskPrefix(conversationId)}_turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private createConversationId(): string {
    return `conversation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
