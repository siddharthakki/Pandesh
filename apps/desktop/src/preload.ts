import { contextBridge, ipcRenderer } from 'electron';
import {
  DESKTOP_CHANNELS,
  type DesktopActivityEvent,
  type DesktopAppMetadata,
  type DesktopApprovalResolution,
  type DesktopOpenRouterKeyResult,
  type DesktopGmailStatus,
  type DesktopGmailActionResult,
  type DesktopSnapshot,
  type DesktopSpeakResult,
  type DesktopSubmitResult,
  type DesktopTranscribeResult,
  type DesktopHostTelemetry,
  type ConversationRailEntryView,
  type ConversationOpenResult,
  type ConversationSearchResultView,
  type ConversationExportResult,
  type DesktopResearchApprovalView,
  type DesktopResearchResultView,
  type DesktopArtifactView,
  type DesktopArtifactPreview,
  type DesktopImageGenerationResult,
  type DesktopImageStudioStatus,
  type DesktopWeatherResult,
  type MobilePairingView,
  type DesktopAssistantBrief,
  type DesktopDailyBriefRoutine,
  type DesktopCloudPublicTextPreview,
  type DesktopCloudState,
} from './ipc';

const desktopApi = {
  getSnapshot: (): Promise<DesktopSnapshot | null> => ipcRenderer.invoke(DESKTOP_CHANNELS.getSnapshot),
  getAppMetadata: (): Promise<DesktopAppMetadata> => ipcRenderer.invoke(DESKTOP_CHANNELS.getAppMetadata),
  getDiagnosticsReport: (): Promise<string> => ipcRenderer.invoke(DESKTOP_CHANNELS.getDiagnosticsReport),
  pickFolder: (): Promise<DesktopSnapshot | null> => ipcRenderer.invoke(DESKTOP_CHANNELS.pickFolder),
  setFolder: (folder: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setFolder, folder),
  clearFolder: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.clearFolder),
  submitTask: (goal: string, worker?: string, voiceTurnId?: string, cloudApproved?: boolean): Promise<DesktopSubmitResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.submitTask, goal, worker, voiceTurnId, cloudApproved),
  selectWorker: (worker: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.selectWorker, worker),
  selectProvider: (provider: 'ollama' | 'openrouter'): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.selectProvider, provider),
  refreshCloudCatalog: (): Promise<DesktopCloudState> => ipcRenderer.invoke(DESKTOP_CHANNELS.refreshCloudCatalog),
  setCloudProviderKey: (providerId: string, apiKey: string, baseUrl?: string): Promise<DesktopCloudState> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setCloudProviderKey, providerId, apiKey, baseUrl),
  clearCloudProviderKey: (providerId: string): Promise<DesktopCloudState> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.clearCloudProviderKey, providerId),
  setCloudProviderEnabled: (providerId: string, enabled: boolean): Promise<DesktopCloudState> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setCloudProviderEnabled, providerId, enabled),
  discoverCloudModels: (providerId: string): Promise<DesktopCloudState> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.discoverCloudModels, providerId),
  testCloudProvider: (providerId: string, model: string): Promise<DesktopCloudState> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.testCloudProvider, providerId, model),
  selectCloudModel: (encoded: string | null): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.selectCloudModel, encoded),
  setCloudLocalFallback: (enabled: boolean): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setCloudLocalFallback, enabled),
  previewCloudPublicText: (text: string): Promise<DesktopCloudPublicTextPreview> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.previewCloudPublicText, text),
  listModels: (): Promise<string[]> => ipcRenderer.invoke(DESKTOP_CHANNELS.listModels),
  selectModel: (model: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.selectModel, model),
  continueTask: (predecessorAttemptId: string, guidance: string): Promise<DesktopSubmitResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.continueTask, predecessorAttemptId, guidance),
  cancel: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.cancel),
  resolveApproval: (approvalId: string, resolution: DesktopApprovalResolution): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.resolveApproval, approvalId, resolution),
  setOpenRouterApiKey: (apiKey: string): Promise<DesktopOpenRouterKeyResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setOpenRouterApiKey, apiKey),
  clearOpenRouterApiKey: (): Promise<DesktopOpenRouterKeyResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.clearOpenRouterApiKey),
  transcribeUtterance: (wavBase64: string, voiceTurnId?: string): Promise<DesktopTranscribeResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.transcribeUtterance, wavBase64, voiceTurnId),
  getHostTelemetry: (): Promise<DesktopHostTelemetry> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getHostTelemetry),
  setWakeWordEnabled: (enabled: boolean): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setWakeWordEnabled, enabled),
  setWakeWordMuted: (muted: boolean): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setWakeWordMuted, muted),
  reportWakeCapture: (meta: Record<string, unknown>): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.reportWakeCapture, meta),
  pushWakeAudio: (
    pcmBase64: string,
    meta?: Record<string, unknown>,
  ): Promise<{ score: number; detected: boolean; diagnostics?: Record<string, unknown> }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.pushWakeAudio, pcmBase64, meta),
  setVoiceMode: (enabled: boolean): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.setVoiceMode, enabled),
  speakText: (text: string): Promise<DesktopSpeakResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.speakText, text),
  stopSpeaking: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.stopSpeaking),
  markPlaybackFinished: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.markPlaybackFinished),
  refreshEverydayTools: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.refreshEverydayTools),
  createNote: (input: { title?: string; body: string }): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.createNote, input),
  updateNote: (id: string, input: { title?: string; body?: string }): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.updateNote, id, input),
  deleteNote: (id: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.deleteNote, id),
  createReminder: (input: { title: string; body?: string; dueAt: string; timezone?: string }): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.createReminder, input),
  completeReminder: (id: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.completeReminder, id),
  cancelReminder: (id: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.cancelReminder, id),
  refreshCommandQueue: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.refreshCommandQueue),
  enqueueCommand: (instruction: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.enqueueCommand, instruction),
  offerNextCommand: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.offerNextCommand),
  confirmCommandRun: (id: string, token: string, revision: number): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.confirmCommandRun, id, token, revision),
  skipCommand: (id: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.skipCommand, id),
  postponeCommand: (id: string, untilIso: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.postponeCommand, id, untilIso),
  editQueuedCommand: (id: string, instruction: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.editQueuedCommand, id, instruction),
  removeQueuedCommand: (id: string): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.removeQueuedCommand, id),
  reorderQueuedCommand: (id: string, ordinal: number): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.reorderQueuedCommand, id, ordinal),
  connectGmail: (): Promise<DesktopGmailStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.connectGmail),
  disconnectGmail: (): Promise<DesktopGmailStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.disconnectGmail),
  dispatchGmailAction: (toolName: string, args: Record<string, unknown>): Promise<DesktopGmailActionResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.dispatchGmailAction, toolName, args),
  resolveGmailApproval: (approvalId: string, resolution: DesktopApprovalResolution): Promise<DesktopGmailActionResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.resolveGmailApproval, approvalId, resolution),
  summarizeGmailThread: (messages: Array<{ from: string; subject: string; date: string; bodyText: string }>): Promise<{ summary: string }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.summarizeGmailThread, messages),
  retryGmailProbe: (): Promise<DesktopGmailStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.retryGmailProbe),
  allowInboxOrganization: (): Promise<DesktopGmailStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.allowInboxOrganization),
  saveGoogleOAuthClient: (clientId: string, clientSecret: string): Promise<DesktopGmailStatus> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.saveGoogleOAuthClient, clientId, clientSecret),
  clearGoogleOAuthClient: (): Promise<DesktopGmailStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.clearGoogleOAuthClient),
  cancelGoogleConnect: (): Promise<DesktopGmailStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelGoogleConnect),
  importGoogleOAuthClientFile: (): Promise<{ cancelled: boolean; status?: DesktopGmailStatus }> => ipcRenderer.invoke(DESKTOP_CHANNELS.importGoogleOAuthClientFile),
  pickAttachments: (): Promise<{ cancelled: boolean; errors: string[] }> => ipcRenderer.invoke(DESKTOP_CHANNELS.pickAttachments),
  stageAttachmentBytes: (name: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(DESKTOP_CHANNELS.stageAttachmentBytes, name, bytes),
  removeAttachment: (id: string): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.removeAttachment, id),
  listConversations: (includeArchived?: boolean): Promise<ConversationRailEntryView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.listConversations, includeArchived),
  openConversation: (conversationId: string, select?: boolean): Promise<ConversationOpenResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openConversation, conversationId, select),
  newConversation: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.newConversation),
  renameConversation: (conversationId: string, title: string): Promise<ConversationRailEntryView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.renameConversation, conversationId, title),
  pinConversation: (conversationId: string): Promise<ConversationRailEntryView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.pinConversation, conversationId),
  unpinConversation: (conversationId: string): Promise<ConversationRailEntryView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.unpinConversation, conversationId),
  archiveConversation: (conversationId: string): Promise<ConversationRailEntryView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.archiveConversation, conversationId),
  unarchiveConversation: (conversationId: string): Promise<ConversationRailEntryView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.unarchiveConversation, conversationId),
  searchConversations: (query: string): Promise<ConversationSearchResultView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.searchConversations, query),
  exportConversation: (conversationId: string): Promise<ConversationExportResult> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.exportConversation, conversationId),
  startWebResearch: (query: string): Promise<DesktopResearchApprovalView> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.startWebResearch, query),
  resolveWebResearch: (approval: DesktopResearchApprovalView, resolution: DesktopApprovalResolution): Promise<DesktopResearchResultView> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.resolveWebResearch, approval, resolution),
  getWebResearch: (researchId: string): Promise<DesktopResearchResultView> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getWebResearch, researchId),
  openExternalUrl: (url: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openExternalUrl, url),
  openWorkspaceFolder: (): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openWorkspaceFolder),
  openWorkspaceFile: (relativePath: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openWorkspaceFile, relativePath),
  listArtifacts: (conversationId?: string): Promise<DesktopArtifactView[]> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.listArtifacts, conversationId),
  getTaskOverview: (): Promise<{ tasks: Array<Record<string, any>>; queued: Array<Record<string, any>> }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getTaskOverview),
  cancelTask: (attemptId: string): Promise<{ requested: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.cancelTask, attemptId),
  /** Pandesh: the context-aware Home brief and the Today briefing. */
  getAssistantBrief: (options?: { external?: boolean }): Promise<DesktopAssistantBrief> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getAssistantBrief, options ?? {}),
  getDailyBriefRoutine: (): Promise<DesktopDailyBriefRoutine | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getDailyBriefRoutine),
  configureDailyBriefRoutine: (input: { dailyTime: string; timezone?: string; enabled?: boolean }): Promise<DesktopDailyBriefRoutine | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.configureDailyBriefRoutine, input),
  resolveAssistantApproval: (approvalId: string, resolution: DesktopApprovalResolution): Promise<{ status: string }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.resolveAssistantApproval, approvalId, resolution),
  resumeTask: (attemptId: string): Promise<{ attemptId: string; requestId: string }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.resumeTask, attemptId),
  /** Reconnect to the local Core on the operator's request. */
  retryCoreConnection: (): Promise<DesktopSnapshot | null> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.retryCoreConnection),
  getDevStories: (): Promise<{ available: boolean; counts: Record<string, number>; stories: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.getDevStories),
  decideDevStoryPermission: (storyId: string, pendingId: string, allow: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.decideDevStoryPermission, storyId, pendingId, allow),
  stopAllDevStories: (): Promise<{ stopped: string[]; stillRunning: string[]; kandevAvailable: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.stopAllDevStories),
  verifyExistingDevStory: (storyId: string): Promise<{ outcome: string; status: string; commit: string | null; reason: string | null }> => ipcRenderer.invoke(DESKTOP_CHANNELS.verifyExistingDevStory, storyId),
  retryDevStory: (storyId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(DESKTOP_CHANNELS.retryDevStory, storyId),
  approveDevStoryReview: (storyId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(DESKTOP_CHANNELS.approveDevStoryReview, storyId),
  confirmDeviceVerification: (storyId: string, ok: boolean, note?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.confirmDeviceVerification, storyId, ok, note),
  loadArtifactPreview: (artifactId: string): Promise<DesktopArtifactPreview> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.loadArtifactPreview, artifactId),
  openArtifactFolder: (artifactId: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openArtifactFolder, artifactId),
  openArtifactFile: (artifactId: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openArtifactFile, artifactId),
  saveArtifactCopy: (artifactId: string): Promise<{ saved: boolean; path: string | null }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.saveArtifactCopy, artifactId),
  openArtifactInStudio: (artifactId: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openArtifactInStudio, artifactId),
  useArtifactAsReference: (artifactId: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.useArtifactAsReference, artifactId),
  getMobilePairing: (): Promise<MobilePairingView> => ipcRenderer.invoke(DESKTOP_CHANNELS.getMobilePairing),
  probeImageStudio: (): Promise<DesktopImageStudioStatus> => ipcRenderer.invoke(DESKTOP_CHANNELS.probeImageStudio),
  generateImage: (input: Record<string, unknown>): Promise<DesktopImageGenerationResult> => ipcRenderer.invoke(DESKTOP_CHANNELS.generateImage, input),
  resolveImageApproval: (approvalId: string, resolution: DesktopApprovalResolution): Promise<DesktopImageGenerationResult> => ipcRenderer.invoke(DESKTOP_CHANNELS.resolveImageApproval, approvalId, resolution),
  cancelImageGeneration: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelImageGeneration),
  resolveWeatherApproval: (approvalId: string, resolution: DesktopApprovalResolution): Promise<DesktopWeatherResult> => ipcRenderer.invoke(DESKTOP_CHANNELS.resolveWeatherApproval, approvalId, resolution),
  cancelWeatherLookup: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelWeatherLookup),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.minimizeWindow),
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.maximizeWindow),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.closeWindow),
  popoutWorkbench: (): Promise<{ poppedOut: boolean }> => ipcRenderer.invoke(DESKTOP_CHANNELS.popoutWorkbench),
  closePopoutWorkbench: (): Promise<{ poppedOut: boolean }> => ipcRenderer.invoke(DESKTOP_CHANNELS.closePopoutWorkbench),
  copyToClipboard: (text: string): Promise<{ copied: boolean }> =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.copyToClipboard, text),
  quitApp: (): Promise<void> => ipcRenderer.invoke(DESKTOP_CHANNELS.quitApp),
  onEvent: (listener: (event: DesktopActivityEvent) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: DesktopActivityEvent) => listener(payload);
    ipcRenderer.on(DESKTOP_CHANNELS.event, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.event, wrapped);
  },
  onVoiceEvent: (listener: (event: Record<string, unknown>) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: Record<string, unknown>) => listener(payload);
    ipcRenderer.on(DESKTOP_CHANNELS.voiceEvent, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.voiceEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld('karkedikhaDesktop', desktopApi);
contextBridge.exposeInMainWorld('desktop', desktopApi);
