/**
 * The only way the v2 renderer reaches Pandesh: the existing preload bridge
 * (`window.desktop`, apps/desktop/src/preload.ts). No network access, no new
 * IPC surface beyond `getUiVariant` / `setUiVariant`. Types are the subset of
 * apps/desktop/src/ipc.ts the v2 surfaces read.
 */
import { useEffect, useRef, useState } from 'react';

export type ApprovalResolution = 'approved' | 'rejected';

export interface ApprovalCard { approvalId: string; gate: string; toolName: string; scope: string; paths: string[]; detail: string }

export interface ArtifactView { id: string; conversationId: string | null; kind: 'image' | 'video' | 'document' | 'file'; title: string; mimeType: string; fileName: string; byteSize: number; source: string; createdAt: string; availability: 'ready' | 'missing' | 'changed' | 'unreadable' }
export interface ToolPreview { kind: string; title?: string; url?: string; path?: string; artifactIds?: string[]; excerpt?: string; diff?: string }
export interface WorkspaceActivity { id: string; conversationId: string | null; taskId: string | null; capability?: string; kind?: string; title?: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt?: string; endedAt?: string | null; detail?: string | null; preview?: ToolPreview | null; [k: string]: unknown }

export interface Snapshot {
  coreState: string;
  coreDetail?: string;
  model: string | null;
  modelIsAuto: boolean;
  modelServerReachable?: boolean | null;
  provider: string;
  selectedInferenceProvider: string;
  attemptId: string | null;
  running: boolean;
  awaitingApproval: boolean;
  pendingApproval: ApprovalCard | null;
  pendingImageApproval?: { approvalId: string; presentation: Record<string, unknown> | null; request?: { prompt: string } } | null;
  pendingWeatherApproval?: { approvalId: string; presentation: Record<string, unknown> | null } | null;
  workspaceActivities: WorkspaceActivity[];
  lastTurnOutcome: 'completed' | 'failed' | 'cancelled' | null;
  turnOutcomeKind: string | null;
  blockedReason: string | null;
  selectedConversationId: string | null;
  selectedAgentId?: string | null;
  activeConversationId: string | null;
  contextEnvelope?: number | null;
  speaking: boolean;
  voiceMode: boolean;
  localSpeech?: { state?: string; ready?: boolean; detail?: string; [k: string]: unknown };
  cloud?: { selected?: { providerId?: string; model?: string } | null; [k: string]: unknown };
  modelNote?: string | null;
}

export interface TranscriptMessage { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; model?: string | null; provider?: string | null }
export interface ConversationEntry { id: string; title: string | null; preview: string | null; state: string; updatedAt: string; archivedAt: string | null; pinnedAt: string | null }
export interface ActivityEvent { kind: string; at: string; conversationId?: string; messageRole?: string; attemptId?: string; eventType?: string; toolName?: string; summary: string; text?: string }
export interface TaskRow {
  attemptId: string; requestId: string; conversationId: string | null; kind: string; status: string; title: string;
  provider: string | null; model: string | null; worker: string; activity: string; createdAt: string; startedAt: string | null;
  completedAt: string | null; elapsedMs: number; lastEventAt: string | null; lastEventType: string | null; cancelRequestedAt: string | null;
  failureReason: string | null; cancellable: boolean; live: boolean; leaseExpiresAt: string | null; interrupted: boolean;
}
export interface QueuedCommand { id: string; instruction?: string; title?: string; state?: string; [k: string]: unknown }
export interface BriefAction { kind: string; label: string; approvalId?: string; attemptId?: string; conversationId?: string; artifactId?: string }
export interface BriefItem { id: string; kind: string; stance: string; title: string; detail: string; state: string; at: string; source: { kind: string; label: string; checkedAt: string }; actions: BriefAction[] }
export interface Brief { generatedAt: string; home: BriefItem[] }

export interface DesktopApi {
  getSnapshot(): Promise<Snapshot | null>;
  submitTask(goal: string): Promise<{ attemptId: string; requestId: string; model: string; routed?: string }>;
  cancel(): Promise<void>;
  cancelTask(attemptId: string): Promise<{ requested: boolean }>;
  resumeTask(attemptId: string): Promise<{ attemptId: string }>;
  resolveApproval(approvalId: string, resolution: ApprovalResolution): Promise<void>;
  resolveAssistantApproval(approvalId: string, resolution: ApprovalResolution): Promise<{ status: string }>;
  resolveImageApproval(approvalId: string, resolution: ApprovalResolution): Promise<unknown>;
  resolveWeatherApproval(approvalId: string, resolution: ApprovalResolution): Promise<unknown>;
  listConversations(includeArchived?: boolean): Promise<ConversationEntry[]>;
  openConversation(id: string, select?: boolean): Promise<{ conversation: ConversationEntry; messages: TranscriptMessage[] }>;
  newConversation(): Promise<void>;
  getTaskOverview(): Promise<{ tasks: TaskRow[]; queued: QueuedCommand[] }>;
  getAssistantBrief(options?: { external?: boolean }): Promise<Brief>;
  getUiVariant(): Promise<{ variant: 'classic' | 'v2'; forcedByEnv: boolean }>;
  setUiVariant(variant: 'classic' | 'v2'): Promise<{ variant: 'classic' | 'v2'; forcedByEnv: boolean }>;
  retryCoreConnection(): Promise<Snapshot | null>;
  household(action: string, args?: Record<string, unknown>): Promise<unknown>;
  openExternalUrl(url: string): Promise<{ opened: boolean }>;
  listArtifacts(conversationId?: string): Promise<ArtifactView[]>;
  loadArtifactPreview(artifactId: string): Promise<{ artifact: ArtifactView; dataUrl: string; fileUrl?: string }>;
  openArtifactFile(artifactId: string): Promise<{ opened: boolean }>;
  openArtifactFolder(artifactId: string): Promise<{ opened: boolean }>;
  openWorkspaceFolder(): Promise<{ opened: boolean }>;
  onEvent(listener: (event: ActivityEvent) => void): () => void;
}

export const api: DesktopApi = (window as unknown as { desktop: DesktopApi }).desktop;

type Listener = (e: ActivityEvent) => void;
const listeners = new Set<Listener>();
let subscribed = false;
/** One bridge subscription fanned out to every surface. */
export function onDesktopEvent(fn: Listener): () => void {
  if (!subscribed && api) {
    subscribed = true;
    api.onEvent((e) => { for (const l of [...listeners]) { try { l(e); } catch (err) { console.error(err); } } });
  }
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Snapshot kept fresh by Core events (coalesced) plus a slow safety poll. */
export function useSnapshot(): { snapshot: Snapshot | null; error: string | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const refresh = () => {
    if (pending.current) return;
    pending.current = true;
    setTimeout(async () => {
      pending.current = false;
      try { const s = await api.getSnapshot(); setSnapshot(s); setError(null); } catch (err) { setError(String((err as Error)?.message ?? err)); }
    }, 60);
  };
  useEffect(() => {
    refresh();
    const off = onDesktopEvent((e) => { if (e.kind !== 'token') refresh(); });
    const poll = setInterval(refresh, 5000);
    return () => { off(); clearInterval(poll); };
  }, []);
  return { snapshot, error, refresh };
}

export function errorText(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? 'Unknown error');
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
