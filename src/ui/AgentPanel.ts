import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import { AgentRuntime } from '../agent/AgentRuntime';
import { AgentMode } from '../config/ConfigSchema';
import { Config } from '../config/Config';
import { QUALIFICATION_EVIDENCE_FILE, loadQualificationEvidence } from '../models/QualificationEvidenceStore';
import { buildOperatorContextMessage } from './operatorContext';
import { ModelProfileRegistry } from '../reliability/ModelProfiles';
import type {
  AttemptRehydrationRecord,
  ModelSelectionEvidence,
  RepositoryContextPackage,
  ResponseAlternativeRecord,
  RuntimeEventRecord,
  RuntimeTokenFrame,
  CapabilityActionDisplayEntry,
  CapabilityActionRestoreEntry,
  AttemptStatus,
  WorkspaceConversationLedgerSnapshot,
} from '../../core/shared/wireTypes';
import type { CoreClient, CoreKarkeDikhaWorkerCredentials } from '../core-client/CoreClient';
import type { CoreConnectionStatus } from '../core-client/ConnectionState';
import {
  SerializablePermissionContext,
  createDefaultPermissionContext,
  createPermissionContext,
  formatPermissionDenial,
  serializeProfilesForWebview,
  validatePermissionSelectionPayload,
} from '../tools/PermissionContext';
import { ProviderGateway } from '../providers/ProviderGateway';
import type { InferenceProvider, ModelInfo, ProviderType } from '../providers/ProviderTypes';
import {
  ORCAROUTER_LABEL,
  ORCAROUTER_PROVIDER_ID,
  decodeOrcaRouterModel,
  encodeOrcaRouterModel,
  onDidChangeOrcaRouter,
  orcaRouterServiceFor,
} from '../providers/OrcaRouter';
import { assessRetrievalNeed } from '../repository/RetrievalNeed';
import { INPUT_LIMITS, checkInput, classifyInput, pickerFilters } from '../../core/platform/artifacts/artifactInput';
import { SkillRuntimeService } from '../skills/SkillRuntimeService';
import { cloudProviderServiceFor, onDidChangeCloudProviders, providerIdFromQuotaFailure, sharedProviderCatalog } from '../providers/CloudProviders';
import { decodeCloudModel, encodeCloudModel, modelBadges, type ModelDescriptor } from '../../core/platform/modelCatalog';
import { decidePool, isQuotaFailure, spendVerdict } from '../../core/platform/cloudRouting';
import { Logger } from '../services/Logger';
import { SystemOneDecisionService } from '../systemOne/SystemOneDecisionService';
import { resolveSystemOneSettings } from '../systemOne/config';
import { RepositoryContextService } from '../context/RepositoryContextService';
import { RepoFastPath, planRepoQuery } from '../repository/RepoFastPath';
import { mentionedFileKinds } from '../repository/HtmlEvidence';
import { offerPreview } from '../preview/PreviewOffer';
import { previewableArtifacts } from '../preview/PreviewService';
import { decideExecutionPolicy } from '../orchestration/ExecutionPolicyRouter';
import { planRepositoryContextBudgetForModel } from '../context/RepositoryContextBudget';
import { detectWorkspaceProjectEvidence, resolveWorkspaceReferent, type ConversationReferent } from '../context/WorkspaceReferent';
import { isWholeWorkspaceQuestion } from '../context/ContextSelector';
import type { RepositoryContextBudgetTelemetry } from '../context/RepositoryTypes';
import { spawn } from 'child_process';
import { CommandService } from '../services/CommandService';
import { verifyTrustedDirtyProvenance, type ApprovedFileMutationRecord } from '../orchestration/TrustedDirtyProvenance';
import {
  AutonomousTask,
  AutonomousTaskEvent,
  AutonomousTaskInputTooLargeError,
  DurableTaskQueue,
  KarkeAutonomyMode,
  createDefaultAutonomousTask,
  resolveLocalTaskDestinationBranch,
  resolveLocalTaskRepositoryHead,
  resolveLocalTaskGitHubDelivery,
} from '../autonomous/M15AutonomousWork';
import { AutonomousTaskRuntime, type KarkeDikhaLifecycleAuthority } from '../activation/M15AutonomousRuntime';
import { parseAutonomousProgressPhase, renderAutonomousProgressEventPlain } from '../autonomous/AutonomousProgressEvents';
import { pandaStateForEventKind, pandaStateForLifecycleState, connectorStateForLifecycleState, isSubagentEventKind } from '../autonomous/PandaStateMapping';
import { normalizeLocalStoryDraft } from '../stories/LocalStoryStore';
import { getCoreManager } from '../extension';
import { selectContinuationAttachments } from '../../core/attachments/continuation';
import { assembleAutonomousTaskResult, assembleSaathTaskResult, saathEvidenceFromDurableRecords, resolveUnderRoot, terminalOutcomeForResult, type SaathTurnEvidence } from './taskResultAssembly';
import { RecentArtifactBook, ambiguousReferentQuestion, buildArtifactPack, namesExplicitFile as namesExplicitFileInText, type RecentArtifact } from './recentArtifacts';
import { extractFileTargets } from '../repository/RepoFastPath';
import { MAX_BROWSER_OPENS, canOpenInBrowser, findWorkspaceFiles, planWorkspaceFileOp, renderCount, renderList, renderOpenRefusal, renderOpenReport, type OpenOutcome } from '../repository/WorkspaceFileOps';
import { AttachmentRetention } from './attachmentRetention';
import { buildHtmlPreview, buildMarkdownPreview, buildSvgPreview, type Artifact, type TaskResult } from '../../core/platform/artifacts/taskResult';
import { ExecutionProjection, classifyTerminalOutcome, type DhaagaPatch, type RunMode, type TerminalOutcome } from './executionProjection';
import { planRepositoryFacts, type HostFactsSummary } from '../repository/RepositoryFacts';
import { hasFileDeixis, hasProjectDeixis } from '../repository/ReferentResolution';
import { hasAffirmativeMutationIntent } from '../../core/domain/actionIntent';
import { CoreManager } from '../core-client/CoreManager';
import { startupTelemetry } from '../services/StartupTelemetry';
import { getOrCreateProjectByName } from '../core-client/projectResolution';
import { ModelCapabilityRegistry, type ModelCapability } from '../models/ModelCapabilityRegistry';
import {
  classifyTaskRequirements,
  selectTaskModel,
  TaskModelSelectionError,
  type RejectedTaskModelCandidate,
  type TaskModelCandidate,
  type TaskModelSelectionErrorCode,
  type TaskRequirements,
} from '../models/TaskModelSelection';
import { buildProductionTaskModelCandidates, resolveAutoRoleDefaults, resolveProviderModelId } from '../models/ProductionModelCandidates';
import { effectiveModelOverride } from '../models/ModeModelOverride';
import { benchmarkForcedModel } from '../models/BenchmarkModel';
import { ResolvedModelDefaults } from '../config/ResolvedModelDefaults';
import { explicitContextWindowOverride, resolveModelContextLimit } from '../reliability/ModelDispatchPlanner';
import { deriveToolProtocol } from '../../core/domain/empiricalRouting';
import { frozenContextWindowEvidence } from '../models/ContextWindowEvidence';
import type { ModelRole } from '../providers/InferenceTypes';
import { classifyExecutionProfile } from '../orchestration/ExecutionProfile';
import { isReadOnlyFollowUpOnPriorWork } from '../orchestration/FollowUpRouting';
import {
  classifyControlAcknowledgement,
  compileAutonomousObjective,
  continuityCue,
  detectObjectiveBoundary,
  extractReferencedSymbols,
  formatCarriedConstraints,
  hasProposalAnaphor,
  isExplicitResetIntent,
  isGreetingIntent,
  isReferentialFollowUp,
  isRepositoryUnderstandingQuery,
  reconcileConstraints,
  resolveFollowUp,
  resolveProposalAnaphor,
  summarizeObjective,
  type ConversationControlState,
  type ObjectiveBoundary,
  type RepositoryRevalidation,
  type ResumptionState,
} from '../orchestration/ConversationContinuity';
import type {
  ConversationExecutionPolicy,
  ConversationWorkingStateRecord,
} from '../../core/shared/wireTypes';
import { deriveMutationPolicy } from '../../core/domain/mutationPolicy';
import { isGitAuthorIdentityUnavailableError } from '../coding/GitPrerequisites';

const AUTONOMOUS_POLL_INTERVAL_MS = 2000;
const AUTONOMOUS_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
/** A never-started attempt may be executed on reload only inside the crash window between submit and execute. */
const RELOAD_RETRY_WINDOW_MS = 5 * 60_000;

export function isFreshForReloadRetry(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now - created >= 0 && now - created <= RELOAD_RETRY_WINDOW_MS;
}
const AUTONOMOUS_AUTO_RESTORE_STATES = new Set<string>([
  'waiting_for_proposal_approval',
  'waiting_for_mutation_approval',
  'running',
  'validating',
  'waiting_for_delivery_approval',
]);
const PENDING_WORKSPACE_REQUEST_KEY = 'ollama-agent.pendingWorkspaceRequest';
const REPOSITORY_CONTEXT_QUESTION = /\b(codebase|repository|repo|workspace|source code|files?|folders?|director(?:y|ies)|class|function|module|architecture|component|defined|declared|implemented|implementation|located)\b/i;

/**
 * The cheap, purely textual half of the repository-question decision: an
 * explicit repository noun, or a literal repository-relative path.
 */
/** One observable line per repository package: every budget/truncation decision. */
function logRepositoryContextBudget(
  kind: 'baat_kar' | 'saath_kar',
  model: string,
  budget: RepositoryContextBudgetTelemetry | undefined,
): void {
  if (!budget) return;
  Logger.info(
    `[RepositoryContext] kind=${kind} model=${model} modelContext=${budget.modelContext} `
    + `reservedTokens=${budget.reservedTokens} budgetChars=${budget.budgetChars} limitedBy=${budget.limitedBy} `
    + `candidateChars=${budget.candidateChars} dedupedChars=${budget.dedupedChars} selectedChars=${budget.selectedChars} `
    + `selectedFiles=${budget.selectedFiles} droppedFiles=${budget.droppedFiles} excludedFiles=${budget.excludedFiles} `
    + `summarizedFiles=${budget.summarizedFiles} overviewQuery=${budget.overviewQuery} overviewChars=${budget.overviewChars}`,
  );
}

/** Ceiling for the Repo Fast Path evidence packet (also bounded by the model-window budget). ≈ 5k tokens. */
const REPO_FAST_PATH_MAX_CHARS = 18_000;
/** A question that names a file ('is the readme up to date') may take that file whole; still bounded by the model's window. */
const REPO_FAST_PATH_EXPLICIT_FILE_MAX_CHARS = 48_000;

function mentionsRepositorySubjectLiterally(text: string): boolean {
  return REPOSITORY_CONTEXT_QUESTION.test(text) || /(?:^|\s)[\w@.-]+(?:[/\\][\w@.-]+)+\.[A-Za-z0-9]+\b/.test(text);
}

/** A requested example is conversation, unless the user ties it to the workspace. */
function isStandaloneCodeRequest(text: string): boolean {
  if (/\b(?:repo(?:sitory)?|workspace|codebase|existing|our|my|this project|this app|save|place|insert|integrate)\b/i.test(text)
    || planRepoQuery(text).fileTargets.some(target => target.strong)) return false;
  return /\b(?:write|show|give|generate|explain|implement|create|code)\b[^.!?]{0,90}\b(?:function|snippet|example|algorithm|script|program|one-?liner|regex|regular expression|sql query|binary search|linked list|factorial|fibonacci|palindrome|prime numbers?)\b/i.test(text);
}

/**
 * A SOFT signal that a plain-language question is about THIS project's current
 * behaviour ("How does the total spending work right now?"): a how/where/why
 * question about how something works, phrased as present-tense state. Unlike a
 * literal repository noun it is not certain, so it may only try retrieval —
 * it never makes a turn fail closed.
 */
export function suggestsCurrentProjectBehaviour(text: string): boolean {
  const asksHowItWorks = /\b(?:how|where|why|what)\b[^?.!]{0,80}\b(?:work|works|working|calculated|computed|handled|determined|implemented|stored|saved)\b/i.test(text);
  const presentStateCue = /\b(?:right now|currently|at the moment|as it stands|in (?:this|my|our) (?:project|app|application|code|program|tool|repo|workspace)|(?:does|do|is|are) (?:this|my|our) (?:app|application|project|program|tool|code))\b/i.test(text);
  return asksHowItWorks && presentStateCue;
}

/**
 * True when nothing in an unclassified message ties it to this workspace: no named file, identifier, quoted text,
 * repository-shaped plan, host-fact question, deixis ("this project") or present-tense behaviour cue. Such a turn
 * ("What is the capital of France?", "Explain dependency injection") is plain chat and never pays for retrieval.
 */
function hasNoWorkspaceSignal(text: string, context: { activeFile?: string; hasFocus?: boolean } = {}): boolean {
  const plan = planRepoQuery(text);
  // The conversation already grounded on specific files and this is a short follow-up ("where is the validation?"), a file
  // KIND is named without a filename ("check the html"), or the message points at the open editor ("this file"): all are
  // workspace subjects. Retrieval stays grounded-only for them, so a wrong guess is plain chat, never a failed turn.
  if (context.hasFocus || mentionedFileKinds(text).length > 0
    || (context.activeFile && /\b(?:this|the current|the open|the active|current)\s+(?:file|page|document|tab|editor|form|screen|script|code)\b/i.test(text))) return false;
  // 'overview' / 'architecture' / 'conceptual' are keyword-typed ("dependency", "architecture" alone) and are not
  // evidence of a workspace subject; the concrete plan types, a named target or the cues below are.
  return !(['inventory', 'changes', 'identifier', 'usage', 'error_text'].includes(plan.type) || plan.fileTargets.length > 0 || plan.identifiers.length > 0 || plan.literal
    || planRepositoryFacts(text) || hasProjectDeixis(text) || hasFileDeixis(text) || suggestsCurrentProjectBehaviour(text)
    || /\b(?:my|our|this|the|that)\s+(?:repo|repository|project|app|application|codebase|code|workspace|folder|directory|files?|modules?|service|extension|readme|package|page|form|document|screen|script|stylesheet)\b/i.test(text));
}

interface BaatRepositoryContextSelection {
  context: RepositoryContextPackage;
  status?: Record<string, unknown>;
  evidence: { fileCount: number; estimatedTokens: number; paths: string[]; budget?: RepositoryContextBudgetTelemetry };
  /** Present when the host computed the answer (repository facts) or decided a clarification is needed, instead of reading files. */
  hostFacts?: HostFactsSummary;
  /** Set when the host's bounded retrieval passes ended with insufficient evidence for an architecture question. */
  evidenceGap?: string;
}

/**
 * Repository grounding fail-closed contract (Phase 2, part A).
 *
 * Thrown by `buildSupplementalRepositoryContext` when a Baat Kar turn was
 * identified as repository-specific (`isRepositoryContextQuestion` true) but
 * the existing production repository-read path could not produce any
 * evidence for it — either because selection came back empty or because
 * retrieval itself failed. `sendToAgent` treats this as a terminal failure
 * for the turn: `client.submit()` is never called, so the model never sees
 * this request without evidence and cannot answer it as generic-but-
 * authoritative-sounding plain chat.
 */
class RepositoryGroundingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryGroundingUnavailableError';
  }
}
/** Legacy profile-global pointer. It is intentionally never read: a local
 * conversation id such as `default` is not unique across VS Code workspaces. */
const BAAT_KAR_CORE_CONVERSATION_KEY = 'ollama-agent.baatKarCoreConversationId';
const WORKSPACE_CONVERSATION_STATE_KEY = 'ollama-agent.workspaceConversationState.v1';

/** The webview's own initial `currentConversationId` (media/chat.js) before
 * the user ever explicitly creates or selects another conversation. A fresh
 * panel instance's ambient `conversationId` must start at this same value —
 * not an unrelated random id — so a mount-time, webview-input-free read like
 * `restoreConversationTranscript()` looks up the durable Core conversation
 * pointer under the same key the webview will actually submit turns under. */
const DEFAULT_CONVERSATION_ID = 'default';

// Named states that each correspond to one bounded approval gate, ranked in
// their fixed forward order. Used by reconcileStaleApprovalCards to tell
// "task.state has genuinely advanced to a later gate" (authoritative proof
// that an earlier pending-record field left over on the persisted record is
// stale garbage) apart from "task.state is some transient in-between value
// (running/queued/validating/...)" — the latter is not authoritative and
// must defer to the pending-record field, since that value can lag or
// briefly revert relative to it (a normal eventual-consistency artifact of
// polling a durably-persisted record while Core is still writing forward).
/** The one-line "what is outstanding" description recorded on the conversation
 * working state for each approval gate. Purely descriptive: the actionable card
 * itself is restored from the M15 task record and Core's approvals, never from
 * this string. */
const GATE_PENDING_ACTION_DESCRIPTION: Record<string, string> = {
  waiting_for_proposal_approval: 'A proposal is waiting for your approval.',
  waiting_for_mutation_approval: 'A mutation is waiting for your approval.',
  waiting_for_delivery_approval: 'Delivery is waiting for your approval.',
};

const GATE_STATE_RANK: Record<string, number> = {
  waiting_for_proposal_approval: 1,
  waiting_for_mutation_approval: 2,
  waiting_for_delivery_approval: 3,
};


/** Outcome of submitting a Karke Dikha task to Core via `CoreClient.submit()`
 * before the M15 task is enqueued — see `submitKarkeDikhaRequest`. */
type CoreKarkeDikhaSubmission =
  | { outcome: 'rejected' }
  /**
   * Local model selection (before Core is ever contacted) found no candidate
   * meeting Karke Dikha's requirements. Distinct from `'rejected'` — Core
   * never saw this submission at all, so it must never be reported to the
   * user as a Core rejection. Carries `TaskModelSelectionError`'s own typed
   * `code`/`message`/`rejectedCandidates` unchanged.
   */
  | { outcome: 'model_selection_failed'; code: TaskModelSelectionErrorCode; message: string; rejectedCandidates: readonly RejectedTaskModelCandidate[] }
  | { outcome: 'submitted'; requestId: string; attemptId: string; authority: KarkeDikhaLifecycleAuthority };

/**
 * M32 correction (Baat Kar/Saath Kar execution cutover to Core): one active
 * Core-owned execution turn, keyed by its authoritative Core attempt id — the
 * sole correlation key for the `runtime_event`/`runtime_token` relay. A stray
 * or delayed event for an attempt id not present here (a stale/older attempt,
 * or an attempt this panel never started) is ignored; deleting the entry on
 * the first terminal event makes duplicate terminal events a no-op.
 */
interface CoreExecutionTurn {
  attemptId: string;
  /** The webview-facing conversation/run id (`AgentPanel.conversationId` or an
   * autonomous taskId) this turn's messages must be posted against. */
  conversationId: string;
  coreConversationId: string | undefined;
  mode: AgentMode;
  terminal: boolean;
  /** Live-token accumulator for the current model-invocation turn, reset on
   * every tool call so a Saath Kar tool-loop's `done` content is just the
   * final answer, mirroring the webview's own streaming-bubble reset. */
  tokenBuffer: string;
  /** Tool invocation id -> the args it was started with, so the completion
   * event (which does not repeat the tool name) can still be rendered. */
  toolArgsById: Map<string, { toolName: string; args: Record<string, unknown> }>;
  /** Present only for activation-restored turns so a newly-created webview can
   * rebuild the existing user/thinking projection without replaying history. */
  restoredInput?: string;
  restoredStatus?: string;
  /** The authoritative Kaam ka Dhaaga projection for this turn (see executionProjection.ts). */
  projection?: ExecutionProjection;
  /** True when the host supplied repository evidence/facts for this Baat Kar turn (so a refusal answer is not "Completed"). */
  repositoryTurn?: boolean;
  /** What the host itself computed or decided for this turn; decides blocked / needs-input without reading model prose. */
  hostFacts?: HostFactsSummary;
  /** Host retrieval ended with insufficient evidence: the turn cannot end as Completed. */
  evidenceGap?: string;
  /** A Core failure held until Core says whether Auto reroutes it (attempt_rerouted) or it is final (attempt_reroute_declined). */
  pendingFailure?: { reason: string; timer: ReturnType<typeof setTimeout> };
  /** Saath Kar only: the governed file mutations Core relayed for this turn (ids only; evidence is read back from Core). */
  mutationRefs?: Array<{ anchorAttemptId: string; invocationId: string; toolName: string }>;
  /** Saath Kar only: mechanical validation gates Core ran after those mutations, as Core recorded them. */
  validationRuns?: Array<{ command: string; ok: boolean; exitCode: number | null }>;
  /** Saath Kar only: structural (non test/build) checks Core ran, as Core recorded them. */
  structuralRuns?: Array<{ path: string; ok: boolean; summary: string }>;
}

interface ConversationMessage {
  role: string;
  content: string;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

interface OwnedCapabilityApproval {
  action: CapabilityActionRestoreEntry;
  correlationId: string;
  realAttemptId: string;
}

/**
 * The three surfaces the unified composer can route a turn to. Deliberately
 * NOT `AgentMode` (`'ask' | 'plan' | 'agent' | 'chat'`), which describes the
 * legacy in-panel runtime modes and has no autonomous member — this is the
 * Baat Kar / Saath Kar / Karke Dikha triple the webview's Auto recommender and
 * the execution-policy router both speak.
 */
type ComposerMode = 'chat' | 'agent' | 'autonomous';

interface WorkspaceConversationState {
  schemaVersion: 1;
  workspaceIdentity: string;
  currentConversationId: string;
  coreConversationIds: Record<string, string>;
}

/** Context budgeting knows two window sources; OrcaRouter is an OpenAI-compatible endpoint, never Ollama. */
function contextProviderType(selectedProvider: string): string {
  return selectedProvider !== 'ollama' && selectedProvider !== 'openai-compatible' ? 'openai-compatible' : selectedProvider;
}

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'ollama-agent.chatView';

  public showActivity(): void {
    this.post({ type: 'showActivity' });
  }

  public bindCoreManager(manager: CoreManager): void {
    this.coreManager = manager;
    this.coreManagerSubscription?.dispose();
    this.coreManagerSubscription = manager.onStatusChange((status) => {
      this.handleCoreStatusChange(status);
    });
    this.handleCoreStatusChange(manager.getStatus());
  }

  private handleCoreStatusChange(status: CoreConnectionStatus): void {
    this.postReadinessState();
    if (status.state === 'connected' && this.webviewReady && this.workspaceRestorationPromise === undefined) {
      void this.completeWorkspaceRestoration();
    }
  }

  public async waitForCoreConnection(timeoutMs = 5000): Promise<boolean> {
    const manager = this.coreManager ?? getCoreManager();
    if (!manager) return false;
    const isConnected = typeof manager.getStatus === 'function'
      ? manager.getStatus().state === 'connected'
      : Boolean(manager.getClient?.());
    if (isConnected && manager.getClient?.()) {
      return true;
    }
    if (typeof manager.onStatusChange !== 'function') {
      return Boolean(manager.getClient?.());
    }
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      let cleanup: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup?.();
          resolve(false);
        }
      }, timeoutMs);
      const disposable = manager.onStatusChange((status) => {
        if (status.state === 'connected' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup?.();
          resolve(true);
        }
      });
      cleanup = () => {
        disposable.dispose();
      };
    });
  }

  public async ensureCoreClientReady(timeoutMs = 4000): Promise<CoreClient | undefined> {
    const manager = this.coreManager ?? getCoreManager();
    if (!manager) return undefined;
    const client = manager.getClient?.();
    if (client) {
      if (typeof manager.getStatus === 'function') {
        if (manager.getStatus().state === 'connected') return client;
      } else {
        return client;
      }
    }
    const connected = await this.waitForCoreConnection(timeoutMs);
    return connected ? manager.getClient?.() : undefined;
  }

  public postReadinessState(): void {
    const manager = this.coreManager ?? getCoreManager();
    const status = typeof manager?.getStatus === 'function' ? manager.getStatus() : undefined;
    const coreStatus = status?.state ?? (manager?.getClient?.() ? 'connected' : 'disconnected');
    const coreReady = coreStatus === 'connected';
    this.post({
      type: 'readinessState',
      executionRunning: this.runtime?.isRunning() || this.karkeDikhaSubmissionInFlight || Boolean(this.autonomousActiveTaskId && this.autonomousPollTimer),
      coreReady,
      coreStatus,
      workspaceContextReady: this.workspaceAvailable,
      historyReady: this.conversationLedger !== undefined,
    });
  }

  public async hasActiveRecoverableWork(): Promise<{ hasActiveWork: boolean; activeTaskId?: string }> {
    if (!this.workspaceAvailable) {
      return { hasActiveWork: false };
    }
    if (this.autonomousQueue) {
      try {
        const tasks = await this.autonomousQueue.list();
        const workspaceTasks = tasks.filter(task => this.taskBelongsToWorkspace(task));
        for (const task of workspaceTasks) {
          if (!AUTONOMOUS_AUTO_RESTORE_STATES.has(task.state)) continue;
          if (await this.taskBelongsToCurrentConversation(task, this.startupSelectedConversationId ?? this.conversationId)) {
            return { hasActiveWork: true, activeTaskId: task.taskId };
          }
        }
      } catch (error) {
        Logger.warn('[AgentPanel] Error checking active recoverable work:', error);
      }
    }
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    if (client && this.workspaceAvailable) {
      try {
        const snapshot = await client.listRecentWorkspaceCapabilityActions(this.workspaceRoot);
        if (snapshot?.actions && snapshot.actions.some(action => action.actionable)) {
          return { hasActiveWork: true };
        }
      } catch {}
    }
    return { hasActiveWork: false };
  }

  private view?: vscode.WebviewView;
  private runtime?: AgentRuntime;
  private readonly repositoryContext: RepositoryContextService;
  private readonly repoFastPath: RepoFastPath;
  /** Kaam ka Dhaaga projections by run id (Core attempts, Baat Kar mode gates, Karke Dikha tasks); bounded. */
  private readonly dhaagaRuns = new Map<string, ExecutionProjection>();
  /** The one project each conversation has explicitly established ("this project"); never inferred from retrieval. */
  private readonly establishedProjects = new Map<string, string>();
  /** Baat Kar requests that stopped at "Change required" awaiting the user's explicit mode decision, by conversation id. */
  private readonly pendingModeChanges = new Map<string, { text: string; attachmentIds: string[]; conversationId: string; modelOverride?: string; projection: ExecutionProjection }>();
  /** A confirmed/declined mode change hands its projection to the next submission so the thread continues. */
  private readonly continuedProjections = new Map<string, ExecutionProjection>();
  /** Optional local System-One decision provider. Shadow-only: cannot influence routing. */
  private readonly systemOneShadow: SystemOneDecisionService;
  private conversationId: string = DEFAULT_CONVERSATION_ID;
  /** What each conversation has been about so far, so a bare "this" resolves to the right referent. */
  private readonly conversationReferents = new Map<string, ConversationReferent>();
  private lastConversationId?: string;
  private activeConversationId: string = DEFAULT_CONVERSATION_ID;
  private startupSelectedConversationId?: string;
  private coreManager?: CoreManager;
  private coreManagerSubscription?: vscode.Disposable;
  private conversations: Map<string, Conversation> = new Map();
  private selectedPermissionContext: SerializablePermissionContext = createDefaultPermissionContext();
  private activePermissionRunId: string | undefined;
  private repositoryWatcher?: vscode.FileSystemWatcher;
  private repositoryWatcherTimer?: NodeJS.Timeout;
  private readonly pendingRepositoryChanges = new Set<string>();

  // M32: Baat Kar/Saath Kar conversation durability. Maps the webview's local
  // conversationId to the Core-owned conversation it durably persists to, so a
  // Core restart or a second VS Code window can recover the same transcript.
  private readonly coreConversationIds = new Map<string, string>();
  // Durable Conversational Continuity V1: the bounded derived working state
  // for the current conversation, loaded from Core at restoration and kept
  // in sync as turns are submitted. Never authoritative about repository
  // bytes — `revalidateConversationRelevantFiles` re-reads the workspace
  // before any restored objective is acted on.
  private conversationWorkingState: ConversationWorkingStateRecord | null = null;
  /**
   * A task pointer recorded before this conversation's working state exists (the first Karke Dikha turn of a new
   * conversation starts its task before the turn itself is persisted). Applied right after the turn is persisted,
   * so the conversation still knows work was performed and a later "what did you change?" stays a follow-up.
   */
  private pendingTaskContinuity: Parameters<AgentPanel['recordTaskContinuity']>[0] | null = null;
  /**
   * The user turn that KKD asked "Should I treat it as a new task?" about. A bare confirmation must bind to THIS
   * candidate instead of discarding it and asking again. Scoped to one conversation: New Chat, reset and History
   * reopen all clear it, so a restored conversation can never resurrect a stale candidate.
   */
  private pendingTaskCandidate: { conversationId: string; text: string } | null = null;
  /** Attachments of a turn that was refused before Core committed it, kept for "resume" (attachmentRetention.ts). */
  private readonly attachmentRetention = new AttachmentRetention();
  /** Authoritative artifacts of this conversation's finished tasks: what "this html" / "it" refers to (recentArtifacts.ts). */
  private readonly recentArtifacts = new RecentArtifactBook();
  /** conversationId -> the one HTML file the person named in a live turn (never restored from History). */
  private readonly namedHtmlFiles = new Map<string, string>();
  /** The referent bound for the turn being submitted; consumed by the context builder so retrieval never runs first. */
  private turnArtifactReferent: { conversationId: string; text: string; artifact: RecentArtifact; phrase: string } | null = null;
  /** A genuinely ambiguous referent is asked about once per conversation. */
  private readonly artifactClarificationAsked = new Set<string>();
  /** Saath path -> create/modify, learned from the frozen proposal presentation, for the result's change buckets. */
  private readonly saathProposedOperations = new Map<string, string>();
  private conversationRevalidation: RepositoryRevalidation = { status: 'unknown' };
  private conversationControlState: ConversationControlState = {
    id: 'default',
    repository: '',
    resumptionState: 'none',
  };
  /**
   * Repository-relative paths the SYSTEM actually used for the turn currently
   * being submitted — the files `RepositoryContextService` selected into the
   * frozen context, or the paths a proposal targets. This is the only source
   * `relevantFiles` is allowed to draw from.
   *
   * Deliberately NOT "paths the user typed": a user asking "Why does
   * registerUser accept an empty username?" names no file at all, and a user
   * who types a wrong or imaginary filename must not have it recorded as a
   * repository fact. Model prose is never a source either.
   */
  private authoritativeTurnFiles: string[] = [];
  // Maps the webview's local conversationId (runId) to the currently-active
  // Core attempt id for that conversation — cleared when the turn reaches a
  // terminal state (see `finishCoreExecutionTurn`) or fails to start.
  private readonly coreActiveAttemptIds = new Map<string, string>();
  // M32 correction (execution cutover): the sole state driving the
  // runtime_event/runtime_token -> webview-message relay, keyed by Core
  // attempt id. See `CoreExecutionTurn`'s doc comment for the correlation
  // contract.
  private readonly coreExecutionTurns = new Map<string, CoreExecutionTurn>();
  private readonly projectedCoreExecutionAttempts = new Set<string>();
  private coreRuntimeRelaySubscribed = false;
  private coreRehydrationPromise?: Promise<void>;

  // New Karke Dikha projections reuse the Core attempt id for both local
  // taskId and attemptId. M15 keeps worktree/progress detail only; every
  // lifecycle mutation is authorized through its bound Core fence.
  // Guards against a duplicate/stale 'startAutonomousTask' webview message
  // (double-click, retry) starting a second Core submission + M15 task for
  // what is really one accepted submission, while the first is still in
  // flight between the Core submit call and the M15 enqueue call.
  private karkeDikhaSubmissionInFlight = false;
  // Monotonic counter bumped synchronously the instant a 'startAutonomousTask'
  // webview message is received, before any await in routeComposerSubmission
  // or startAutonomousTask. reconnectAutonomousTask() is fire-and-forget
  // (invoked via `void`) and can still be mid-flight — reading the durable
  // task list from disk — when a fresh submission arrives; it snapshots this
  // counter before that read and re-checks it before committing
  // autonomousActiveTaskId/a restored projection, so a slow stale-task
  // restore can never overwrite a fresher submission's identity regardless of
  // which async chain happens to resolve first. See AI_OS_STATE.md.
  private karkeDikhaSubmissionEpoch = 0;
  // Count of 'startAutonomousTask' submissions currently between acceptance
  // and completion (success, rejection or failure) — from BOTH entry points:
  // the webview message case (incremented there, before routeComposerSubmission,
  // decremented via .finally() on that call so a steer-instead-of-create
  // outcome still balances it) and startAutonomousTask() itself (incremented/
  // decremented around its own body), which is also reachable directly from
  // the public `ollama-agent.startAutonomousTask` VS Code command —
  // unprotected by the webview case's epoch bump entirely.
  //
  // The epoch field above only catches a submission that STARTS after a
  // restore read begins; it does not catch a read that itself STARTS after a
  // submission already bumped its epoch but before that submission's task is
  // enqueued (submissionEpochAtStart already equals the elevated value, so it
  // never appears to change). This counter is checked at commit time instead
  // of compared against a start-of-read snapshot, so it covers that ordering
  // too: reconnectAutonomousTask() must never commit a restored task while
  // this is nonzero, regardless of when it started relative to the pending
  // submission.
  private karkeDikhaPendingSubmissionCount = 0;
  private readonly karkeDikhaRetryInFlight = new Set<string>();

  // Autonomous mode: reuses the existing M15 DurableTaskQueue/AutonomousTaskRuntime
  // instance constructed at activation — never a second queue or executor.
  private autonomousQueue?: DurableTaskQueue;
  private autonomousRuntime?: AutonomousTaskRuntime;
  private autonomousPollTimer?: NodeJS.Timeout;
  private autonomousActiveTaskId?: string;
  private projectedAutonomousTaskId?: string;
  private autonomousTerminalSubscription?: { dispose(): void };
  private projectedTerminalTaskId?: string;
  // Serializes pollAutonomousTask per taskId. Two independent triggers can
  // legitimately overlap for the same task — the periodic interval timer and
  // an explicit awaited call right after an approval action (e.g.
  // approveProposal's `await this.pollAutonomousTask(taskId)`) — and each
  // reads the durable task record from disk independently. Without
  // serialization, a later-started-but-earlier-finishing read (or simply two
  // concurrent reads landing on either side of an in-progress multi-field
  // write) can race: one poll observes the fresh post-transition state while
  // the other observes a stale, in-between snapshot, and BOTH independently
  // decide what to tell the webview from their own snapshot. The stale one
  // can conclude a just-activated gate is "superseded" (absent pending field
  // + non-owning state, on its own consistent-looking but outdated read) and
  // post a spurious *ApprovalResolved for a gate the fresh poll just
  // legitimately activated — permanently stranding it disabled, since the
  // client never re-requests an already-surfaced gate. Chaining every call
  // onto the previous one for the same taskId means each poll only ever
  // starts once the prior one's read (and everything it decided from it) has
  // fully completed and been superseded by time, eliminating the interleaving
  // window entirely.
  private autonomousPollChain: Promise<void> = Promise.resolve();
  private readonly autonomousEventCursors = new Map<string, number>();
  private readonly notifiedDeliveryGates = new Set<string>();
  private readonly surfacedDeliveryCards = new Set<string>();
  private readonly surfacedProposalCards = new Set<string>();
  private readonly surfacedMutationCards = new Set<string>();
  // Tracks which surfaced proposal/mutation cards have already been told (via
  // *ApprovalResolved) that they are no longer actionable — keyed the same way
  // as surfacedProposalCards/surfacedMutationCards (`${taskId}:${id}`).
  private readonly resolvedProposalCards = new Set<string>();
  private readonly resolvedMutationCards = new Set<string>();
  private readonly resolvedDeliveryCards = new Set<string>();
  // M38: capability approval cards already posted to the webview this
  // session, keyed by the real Core approvalId — guards against duplicate
  // `restoreCapabilityApprovalCard` posts on a duplicate restore event (e.g.
  // `resolveWebviewView` firing twice). Cleared on every fresh webview
  // creation alongside the surfaced*Cards sets above.
  private readonly surfacedCapabilityApprovalCards = new Set<string>();
  private readonly ownedCapabilityApprovals = new Map<string, OwnedCapabilityApproval>();
  private webviewHydrated = false;
  private autonomousModeVisible = false;
  // M38 fix for the m35-inline-approval packaged-acceptance failure
  // ("expected the resolved proposal card to remain visible after host
  // close/relaunch"). Root cause: several Core-restart rehydration paths
  // (`startAutonomousPolling` — invoked from `rehydrateKarkeDikhaAttempt`,
  // `markM15RecoveryRequired`, `startAutonomousTask` — and
  // `renderRehydratedProjection`'s own direct `pollAutonomousTask` call) can
  // trigger a poll, and through it `rehydrateResolvedApprovalCards` /
  // `reconcileStaleApprovalCards` / `surfaceProposalApproval` /
  // `surfaceMutationApproval` / `surfaceDeliveryApproval`, before the freshly
  // (re)created webview has finished loading its script and attached its
  // `message` listener. `webview.postMessage` silently drops a message
  // posted before that listener exists, but every one of those methods
  // marks its card "already surfaced" the instant it decides to post,
  // regardless of whether the post is ever actually delivered — they are
  // deliberately one-shot so a genuinely-delivered card is never re-sent.
  // The result: a pre-ready poll's dropped post permanently prevents that
  // resolved proposal/mutation card (or the still-active delivery card)
  // from ever being (re)posted once the webview later becomes ready, since
  // nothing else re-triggers that same historical decision.
  //
  // Fix: route every approval-card message through `postApprovalCardMessage`
  // instead of `post` directly. Before the webview confirms readiness via
  // `webviewReady`, messages are queued here rather than sent (and rather
  // than dropped); the instant `webviewReady` arrives, the queue is flushed,
  // in order, via the ordinary `post`. This never touches the surfaced*Cards
  // bookkeeping, durable task/Core state, or the resolved*Cards decision
  // cache — it only changes *when* an already-decided post is actually
  // transmitted, so no gate is ever reopened or replayed a second time (a
  // duplicate `webviewReady` simply flushes an already-empty queue).
  private webviewReady = false;
  private readonly pendingApprovalCardMessages: Record<string, unknown>[] = [];
  /**
   * Conversation epoch. Incremented FIRST, synchronously, by New Chat. Every asynchronous hydration / restore / queued
   * message captures the epoch it was started under and is discarded when the epoch has moved on, so a read that was
   * in flight for the previous conversation can never repopulate a freshly created one.
   */
  private conversationEpoch = 0;
  private readonly workspaceIdentity: string;
  private workspaceRestorationPromise?: Promise<void>;
  private conversationLedger?: WorkspaceConversationLedgerSnapshot;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly workspaceAvailable = true,
  ) {
    this.repositoryContext = new RepositoryContextService(workspaceRoot);
    this.repoFastPath = new RepoFastPath(workspaceRoot);
    this.systemOneShadow = new SystemOneDecisionService(
      () => resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent')),
      () => (workspaceRoot ? path.join(workspaceRoot, '.ollama-agent', 'telemetry', 'system-one-shadow.jsonl') : undefined),
    );
    this.workspaceIdentity = createWorkspaceIdentity(workspaceRoot, workspaceAvailable);
    this.restoreWorkspaceConversationState();
    // Saving or removing OrcaRouter credentials refreshes the model picker immediately; no restart.
    const orcaSubscription = onDidChangeOrcaRouter(() => { if (this.view) void this.loadModels(); });
    this.context.subscriptions?.push(orcaSubscription);
    const cloudSubscription = onDidChangeCloudProviders(() => { if (this.view) void this.loadModels(); });
    this.context.subscriptions?.push(cloudSubscription);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.webviewHydrated = false;
    this.autonomousModeVisible = false;
    this.webviewReady = false;
    this.workspaceRestorationPromise = undefined;
    this.pendingApprovalCardMessages.length = 0;
    this.surfacedDeliveryCards.clear();
    this.surfacedProposalCards.clear();
    this.surfacedMutationCards.clear();
    this.resolvedProposalCards.clear();
    this.resolvedMutationCards.clear();
    this.resolvedDeliveryCards.clear();
    this.surfacedCapabilityApprovalCards.clear();
    this.ownedCapabilityApprovals.clear();
    this.projectedTerminalTaskId = undefined;
    this.projectedAutonomousTaskId = undefined;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview-v2'),
      ],
    };

    this.initRuntime();
    if (this.workspaceAvailable) this.initRepositoryWatcher();
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    startupTelemetry.mark('webview_resolved');
    startupTelemetry.mark('composer_ready');

    webviewView.webview.onDidReceiveMessage((msg: unknown) => {
      // An un-awaited rejection would otherwise vanish and leave the click looking dead.
      this.handleWebviewMessage(msg).catch(error => {
        const type = (msg as { type?: unknown } | null)?.type;
        Logger.error(`[AgentPanel] Webview message '${String(type)}' failed:`, error);
        this.post({ type: 'error', message: `That action failed: ${error instanceof Error ? error.message : String(error)}` });
      });
    });
    webviewView.onDidDispose(() => {
      if (this.autonomousPollTimer) clearInterval(this.autonomousPollTimer);
      this.autonomousPollTimer = undefined;
    });

    this.postReadinessState();
  }

  private restoreWorkspaceConversationState(): void {
    const state = this.context.workspaceState?.get<WorkspaceConversationState>(WORKSPACE_CONVERSATION_STATE_KEY);
    if (
      state?.schemaVersion === 1
      && state.workspaceIdentity === this.workspaceIdentity
      && typeof state.currentConversationId === 'string'
      && state.currentConversationId.length > 0
    ) {
      this.lastConversationId = state.currentConversationId;
      for (const [localId, coreId] of Object.entries(state.coreConversationIds ?? {})) {
        if (localId && coreId) {
          this.coreConversationIds.set(`ledger:${localId}`, coreId);
          this.coreConversationIds.set(`baat_kar:${localId}`, coreId);
        }
      }
    } else if (state) {
      // A copied/corrupted workspaceState record must fail closed instead of
      // activating another repository's conversation.
      void this.persistWorkspaceConversationState(DEFAULT_CONVERSATION_ID, {});
    }
    // Remove the unsafe pre-fix pointer. History remains available from Core;
    // only ambient activation through an unscoped profile-global alias is retired.
    void this.context.globalState?.update(BAAT_KAR_CORE_CONVERSATION_KEY, undefined);
  }

  private async persistWorkspaceConversationState(
    currentConversationId = this.conversationId,
    coreConversationIds?: Record<string, string>,
  ): Promise<void> {
    if (!this.context.workspaceState) return;
    const persisted = coreConversationIds ?? Object.fromEntries(
      [...this.coreConversationIds.entries()]
        .filter(([key]) => key.startsWith('ledger:'))
        .map(([key, value]) => [key.slice('ledger:'.length), value]),
    );
    await this.context.workspaceState.update(WORKSPACE_CONVERSATION_STATE_KEY, {
      schemaVersion: 1,
      workspaceIdentity: this.workspaceIdentity,
      currentConversationId,
      coreConversationIds: persisted,
    } satisfies WorkspaceConversationState);
  }

  private coreConversationIdFor(localConversationId: string): string | undefined {
    return this.coreConversationIds.get(`ledger:${localConversationId}`)
      ?? this.coreConversationIds.get(`baat_kar:${localConversationId}`)
      ?? this.coreConversationIds.get(`saath_kar:${localConversationId}`)
      ?? this.conversationLedger?.conversations.find(c => c.localConversationId === localConversationId)?.conversationId;
  }

  private resolveCoreConversationId(localConversationId?: string): string | undefined {
    const localId = localConversationId || this.conversationId;
    return (localId ? this.coreConversationIdFor(localId) : undefined)
      ?? (this.conversationLedger?.currentCoreConversationId || undefined);
  }

  private localConversationIdFor(coreConversationId: string): string | undefined {
    return this.conversationLedger?.conversations.find(
      item => item.conversationId === coreConversationId,
    )?.localConversationId;
  }

  private applyConversationLedger(snapshot: WorkspaceConversationLedgerSnapshot, setActive = false): void {
    if (snapshot.workspaceIdentity !== this.workspaceIdentity) {
      throw new Error('Core returned a conversation ledger for another workspace');
    }
    this.conversationLedger = snapshot;
    for (const item of snapshot.conversations) {
      this.coreConversationIds.set(`ledger:${item.localConversationId}`, item.conversationId);
      // Compatibility caches are aliases only; they never represent separate
      // restoration authorities.
      this.coreConversationIds.set(`baat_kar:${item.localConversationId}`, item.conversationId);
      this.coreConversationIds.set(`saath_kar:${item.localConversationId}`, item.conversationId);
    }
    if (snapshot.currentConversationId) {
      this.lastConversationId = snapshot.currentConversationId;
    }
    if (setActive && snapshot.currentConversationId && snapshot.currentCoreConversationId) {
      this.conversationId = snapshot.currentConversationId;
      this.activeConversationId = snapshot.currentConversationId;
    }
  }

  private async initializeConversationLedger(): Promise<void> {
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    if (!client) return;
    let snapshot = await client.getWorkspaceConversationLedger(this.workspaceIdentity);
    if (snapshot.currentConversationId) {
      this.startupSelectedConversationId = snapshot.currentConversationId;
      this.applyConversationLedger(snapshot, true);
      await this.persistWorkspaceConversationState();
      return;
    }

    // One-way migration from the prior workspaceState pointer. It is accepted
    // only for this already identity-stamped workspace record and is then
    // rebound into Core; profile-global legacy state is never read.
    const targetConversationId = this.lastConversationId ?? this.conversationId;
    const legacyCoreConversationId = this.coreConversationIdFor(targetConversationId);
    if (legacyCoreConversationId) {
      snapshot = await client.bindWorkspaceConversation({
        workspaceIdentity: this.workspaceIdentity,
        localConversationId: targetConversationId,
        conversationId: legacyCoreConversationId,
        makeCurrent: true,
        migrationMetadata: {
          migratedFrom: WORKSPACE_CONVERSATION_STATE_KEY,
          schemaVersion: 1,
        },
      });
      this.applyConversationLedger(snapshot, false);
      await this.persistWorkspaceConversationState();
    }
  }

  private completeWorkspaceRestoration(): Promise<void> {
    if (!this.workspaceRestorationPromise) {
      this.workspaceRestorationPromise = this.runWorkspaceRestoration();
    }
    return this.workspaceRestorationPromise;
  }

  private async runWorkspaceRestoration(): Promise<void> {
    this.post({ type: 'workspaceRestorationPending' });
    this.postReadinessState();
    const coreConnected = await this.waitForCoreConnection(6000);
    startupTelemetry.mark('history_restore_begin');
    if (coreConnected) {
      await this.initializeConversationLedger();
    }
    await this.replayWorkspaceHistory();
    startupTelemetry.mark('history_restore_end');
    // Composer routing is enabled only after the canonical transcript,
    // History index, task reconciliation, and actionable approvals have all
    // been published from their durable sources.
    this.post({ type: 'workspaceRestorationResolved', workspaceIdentity: this.workspaceIdentity });
    this.postReadinessState();
    void this.hydrateWebview().catch(error =>
      Logger.warn('[AgentPanel] Non-authoritative webview hydration failed:', error));
  }

  private async replayWorkspaceHistory(forceRestoreChat = false): Promise<void> {
    const epoch = this.conversationEpoch;
    const { hasActiveWork, activeTaskId } = await this.hasActiveRecoverableWork();
    if (this.conversationEpoch !== epoch) return;
    const shouldRestoreChat = forceRestoreChat || hasActiveWork || Boolean(this.startupSelectedConversationId);

    if (shouldRestoreChat) {
      if (this.startupSelectedConversationId) {
        this.conversationId = this.startupSelectedConversationId;
        this.activeConversationId = this.startupSelectedConversationId;
      } else if (hasActiveWork && activeTaskId) {
        this.autonomousActiveTaskId = activeTaskId;
      }
      await this.restoreConversationTranscript();
      if (this.conversationEpoch !== epoch) return;
      await this.restoreConversationContinuity();
      if (this.conversationEpoch !== epoch) return;
      await this.restoreCapabilityApprovalCards();
      if (this.conversationEpoch !== epoch) return;
    } else {
      // Normal startup: open fresh conversation canvas.
      // Prior conversations stay in History and are NOT auto-rendered.
      const freshId = createConversationId();
      this.conversationId = freshId;
      this.activeConversationId = freshId;
      this.conversationWorkingState = null;
      this.pendingTaskContinuity = null;
      this.pendingTaskCandidate = null;
      this.conversationControlState = {
        id: freshId,
        repository: this.workspaceIdentity,
        resumptionState: 'none',
      };
      this.postApprovalCardMessage({ type: 'newConversation', id: freshId }, epoch);
      this.postApprovalCardMessage({
        type: 'conversationContinuity',
        cue: '',
        objective: '',
        previousMode: null,
        repositoryChanged: false,
        resumptionState: 'none',
        reset: true,
      }, epoch);
    }

    if (this.workspaceAvailable) await this.reconnectAutonomousTask();
    if (this.conversationEpoch !== epoch) return;
    this.renderRehydratedProjection();
    this.flushPendingApprovalCardMessages();
    await this.loadPersistedConversations();
  }

  /**
   * M36 restart restoration: rebuilds the Baat Kar transcript — user/assistant
   * bubbles and attachment chips/provenance — from durable Core records when a
   * fresh webview is created and a Core conversation already exists for the
   * workspace-bound current conversation id (persisted in workspaceState).
   * Never mutates Core state; purely a read-and-render pass, and posts at
   * most one `restoreTranscript` message per webview creation.
   */
  private async restoreConversationTranscript(replaceExisting = false): Promise<void> {
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    if (!client || typeof client.listMessages !== 'function') return;
    const coreConversationId = this.coreConversationIdFor(this.conversationId);
    if (!coreConversationId) return;
    const epoch = this.conversationEpoch;
    try {
      const [{ messages: coreMessages }, { byMessage }, { research: researchSessions }, { alternatives }, { branch }] = await Promise.all([
        client.listMessages(coreConversationId),
        client.listConversationMessageAttachments(coreConversationId),
        client.listConversationResearch(coreConversationId),
        client.listResponseAlternatives(coreConversationId),
        client.getConversationBranch(coreConversationId),
      ]);
      if (coreMessages.length === 0 || this.conversationEpoch !== epoch) return;
      const sourceById = new Map<string, { title: string | null; finalUrl: string | null }>();
      await Promise.all(researchSessions.map(async session => {
        const detail = await client.getResearch(session.id);
        detail.sources.forEach(source => sourceById.set(source.id, { title: source.title, finalUrl: source.finalUrl }));
      }));
      const citationByMessage = new Map<string, Array<{ label: string; title: string | null; url: string | null }>>();
      await Promise.all(coreMessages.filter(message => message.role === 'assistant').map(async message => {
        const { citations } = await client.listMessageCitations(message.id);
        citationByMessage.set(message.id, citations.map(citation => ({ label: citation.visibleLabel, title: sourceById.get(citation.sourceId)?.title ?? null, url: sourceById.get(citation.sourceId)?.finalUrl ?? null })));
      }));
      if (this.conversationEpoch !== epoch) return; // New Chat happened while the transcript was being read
      this.postApprovalCardMessage({
        type: 'restoreTranscript',
        conversationId: this.conversationId,
        replaceExisting,
        messages: coreMessages
          .filter((message) => {
            if (message.role !== 'user' && message.role !== 'assistant') return false;
            if (
              message.role === 'assistant'
              && alternatives.some(alternative => alternative.assistantMessageId === message.id && !alternative.active)
            ) return false;
            // Karke Dikha's detailed M15 task wrapper is the one derived
            // projection for its ledger turn. Replaying its Core user message
            // here as a normal chat bubble as well would duplicate the same
            // durable turn.
            return !this.conversationLedger?.turns.some(turn =>
              turn.mode === 'karke_dikha'
              && (
                turn.userMessageId === message.id
                || turn.assistantMessageIds.includes(message.id)
              ),
            );
          })
          .map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            attachments: (byMessage[message.id] ?? []).map((attachment) => ({
              name: attachment.originalName,
              kind: attachment.kind,
              attachmentId: attachment.id,
              status: attachment.status,
            })),
            citations: citationByMessage.get(message.id) ?? [],
            alternatives: (() => {
              const own = alternatives.find((alternative) => alternative.assistantMessageId === message.id);
              return own ? alternatives.filter((alternative) => alternative.userMessageId === own.userMessageId) : [];
            })(),
          })),
        branch,
      }, epoch);
      await this.restoreSaathTaskResults(coreConversationId, epoch);
    } catch (error) {
      console.error('[OllamaAgent] failed to restore conversation transcript:', error);
      // An explicit reopen (History) that cannot load must say so instead of leaving an empty transcript.
      if (replaceExisting && this.conversationEpoch === epoch) {
        this.post({ type: 'error', message: `Could not load that conversation's transcript: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  /**
   * History reopen / restart: re-derives each finished Saath Kar turn's TaskResult from Core's durable records (the turn's
   * capability actions, its own tool invocations) and the disk — the same assembly the live turn ending uses. Nothing is
   * persisted from the UI. This is inert by contract: it only reads and posts cards. It never submits, executes, changes mode,
   * opens or previews anything, and it deliberately does NOT record the artifact as a recent-artifact referent, so "modify this
   * html" after a reopen does not silently bind to a historical card (the user must name it or create/modify something anew).
   * Open/Preview stay available as the person's own clicks, resolved through `taskResults` exactly like a live card.
   */
  private async restoreSaathTaskResults(coreConversationId: string, epoch: number): Promise<void> {
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    if (!client || typeof client.listCapabilityActions !== 'function' || typeof client.listToolInvocations !== 'function') return;
    const turns = (this.conversationLedger?.turns ?? []).filter(turn =>
      turn.conversationId === coreConversationId
      && turn.mode === 'saath_kar'
      && (turn.outcome === 'completed' || turn.outcome === 'failed' || turn.outcome === 'cancelled')
      && !(this.coreExecutionTurns.get(turn.attemptId) && !this.coreExecutionTurns.get(turn.attemptId)!.terminal),
    );
    if (turns.length === 0) return;
    try {
      const { actions } = await client.listCapabilityActions(coreConversationId);
      for (const turn of turns) {
        if (this.conversationEpoch !== epoch) return;
        const { toolInvocations } = await client.listToolInvocations(turn.attemptId);
        const evidence = saathEvidenceFromDurableRecords({
          attemptId: turn.attemptId,
          outcome: turn.outcome as 'completed' | 'failed' | 'cancelled',
          actions,
          invocations: toolInvocations,
          window: { from: turn.createdAt, to: turn.terminalAt ?? turn.updatedAt },
        });
        const result = assembleSaathTaskResult(evidence, { workspaceRoot: this.workspaceRoot });
        if (!result) continue;
        this.taskResults.set(turn.attemptId, result);
        this.postApprovalCardMessage({ type: 'taskResult', taskId: turn.attemptId, taskResult: result, historical: true, afterMessageId: turn.assistantMessageIds.at(-1) }, epoch);
      }
    } catch (error) {
      // A card is derived evidence; failing to rebuild one must never affect the restored transcript.
      Logger.warn('[AgentPanel] Could not restore Saath Kar task results:', error);
    }
  }

  /**
   * M38 restart restoration: re-derives any pending or recently-terminal
   * governed-capability approval card (github_read_issue/
   * github_comment_on_issue/governed_research consequential calls, see
   * core/domain/capabilityDispatch.ts) from Core's own durable state, keyed
   * on `this.conversationId` — the same correlationId the live capability
   * dispatch path uses (see `ToolExecutor.ts`'s `context.taskId ?? this.taskId`,
   * which is fed `this.conversationId` down the same chain
   * `restoreConversationTranscript` already relies on). Purely a read: it
   * never creates an attempt/approval/idempotency row. Posts at most one
   * `restoreCapabilityApprovalCard` message per approvalId per webview
   * session (`surfacedCapabilityApprovalCards` guards duplicates from a
   * duplicate restore event, e.g. `resolveWebviewView` firing twice).
   */
  private async restoreCapabilityApprovalCards(): Promise<void> {
    const epoch = this.conversationEpoch;
    const currentCoreConversationId = this.coreConversationIdFor(this.conversationId);
    if (currentCoreConversationId) {
      await this.postCapabilityApprovalCardsFor(currentCoreConversationId);
    }
    if (this.conversationEpoch !== epoch) return;
    // M38: a Saath Kar attempt's RuntimeExecutor loop dispatches governed
    // capability calls correlated on Core's own durable conversationId
    // (`request.conversationId`, cached here as `turn.coreConversationId` by
    // `rehydrateCoreExecution`/`renderRehydratedProjection`, which this method
    // always runs after) — not the webview-local `this.conversationId` above.
    // A restart must re-derive those cards too.
    for (const turn of this.coreExecutionTurns.values()) {
      if (this.conversationEpoch !== epoch) return;
      if (turn.coreConversationId) await this.postCapabilityApprovalCardsFor(turn.coreConversationId);
    }
    if (this.conversationEpoch !== epoch) return;
    // M38: independent of both calls above, and of `rehydrateCoreAttempts()`
    // ever completing — re-derives capability cards straight from Core's own
    // durable state, including ones whose owning attempt has already gone
    // terminal. `listWorkspaceAttemptRehydration` (and therefore
    // `coreExecutionTurns`) deliberately excludes terminal attempts for
    // execution-recovery purposes, so without this a resolved/denied card
    // would stop restoring the moment its attempt completed — this is what
    // keeps it visible (as completed/denied, non-actionable) across a
    // SECOND restart and beyond.
    await this.restoreHistoricalCapabilityActionCards();
  }

  private async restoreHistoricalCapabilityActionCards(): Promise<void> {
    const epoch = this.conversationEpoch;
    if (!this.workspaceAvailable) return;
    const client = getCoreManager()?.getClient();
    if (!client) return;
    try {
      const currentCoreConversationId = this.coreConversationIdFor(this.conversationId);
      if (!currentCoreConversationId) return;
      const snapshot = await client.listRecentWorkspaceCapabilityActions(this.workspaceRoot);
      if (epoch !== this.conversationEpoch) return;
      for (const action of snapshot.actions) {
        if (action.correlationId !== currentCoreConversationId) continue;
        if (this.surfacedCapabilityApprovalCards.has(action.approvalId)) continue;
        if (action.actionable && this.isWorkspaceMutationTool(action.toolName) && !this.isOwnedActiveCapabilityAction(action)) continue;
        if (action.actionable) {
          this.ownedCapabilityApprovals.set(action.approvalId, {
            action,
            correlationId: action.correlationId,
            realAttemptId: action.realAttemptId,
          });
        }
        this.surfacedCapabilityApprovalCards.add(action.approvalId);
        this.postCapabilityApprovalCard(action);
      }
    } catch (error) {
      console.error('[OllamaAgent] failed to restore historical capability approval cards:', error);
    }
  }

  private async postCapabilityApprovalCardsFor(correlationId: string): Promise<void> {
    const epoch = this.conversationEpoch;
    const client = getCoreManager()?.getClient();
    if (!client) return;
    try {
      const snapshot = await client.listCapabilityActions(correlationId);
      if (epoch !== this.conversationEpoch) return;
      const turn = [...this.coreExecutionTurns.values()].find(candidate =>
        !candidate.terminal
        && candidate.mode === 'agent'
        && candidate.coreConversationId === correlationId,
      );
      for (const action of snapshot.actions) {
        if (this.surfacedCapabilityApprovalCards.has(action.approvalId)) continue;
        // A conversation can briefly contain more than one non-terminal
        // Saath Kar turn (for example, a rejected turn finishing while the
        // user submits a retry). The correlation-scoped snapshot only names
        // the capability anchor attempt, so choosing a turn here would be
        // ambiguous and could bind the approval to the stale response. The
        // workspace-history projection carries Core's exact realAttemptId;
        // let restoreHistoricalCapabilityActionCards own actionable workspace
        // mutations and fail closed until that exact turn is available.
        if (action.actionable && this.isWorkspaceMutationTool(action.toolName)) continue;
        if (action.actionable) {
          this.ownedCapabilityApprovals.set(action.approvalId, {
            action,
            correlationId,
            realAttemptId: turn?.attemptId ?? '',
          });
        }
        this.surfacedCapabilityApprovalCards.add(action.approvalId);
        this.postCapabilityApprovalCard(action);
      }
    } catch (error) {
      console.error('[OllamaAgent] failed to restore capability approval cards:', error);
    }
  }

  /**
   * M39: relays one governed capability tool result into the chat webview,
   * reading the evidence straight from Core rather than from a runtime-event
   * payload (which is bounded and could truncate a memory recall/export). A
   * failure here is non-fatal: the conversation is unaffected, and nothing is
   * fabricated in place of the missing evidence.
   */
  private async postGovernedCapabilityToolResult(anchorAttemptId: string, invocationId: string, toolName: string, attemptId?: string): Promise<void> {
    if (!anchorAttemptId || !invocationId) return;
    const client = getCoreManager()?.getClient();
    if (!client) return;
    try {
      const { toolInvocations } = await client.listToolInvocations(anchorAttemptId);
      const invocation = toolInvocations.find((entry) => entry.id === invocationId);
      if (!invocation) return;
      const ok = invocation.status === 'succeeded';
      this.postDhaaga(this.dhaagaForAttempt(attemptId)?.toolFinished(undefined, toolName, ok, invocation.evidence ?? {}, (invocation.evidence?.['arguments'] as Record<string, unknown> | undefined) ?? {}));
      this.post({
        type: 'toolResult',
        toolName,
        ok,
        result: ok ? invocation.evidence : undefined,
        error: ok ? undefined : (invocation.evidence['output'] ?? invocation.status),
      });
    } catch (error) {
      console.error('[OllamaAgent] failed to relay governed capability tool result:', error);
    }
  }

  private postCapabilityApprovalCard(action: CapabilityActionRestoreEntry): void {
    const presentation = action.presentation as { kind?: string; path?: string; baseline?: string } | undefined;
    if (presentation?.kind === 'write_file_diff' && presentation.path) {
      this.saathProposedOperations.set(String(presentation.path).replace(/\\/g, '/'), presentation.baseline === 'absent' ? 'create_file' : 'modify_file');
    }
    const resolved = !action.actionable;
    const outcome: 'approved' | 'rejected' | 'succeeded' | 'failed' | 'cancelled' | undefined = resolved
      ? (action.outcome === 'pending' ? 'approved' : action.outcome)
      : undefined;
    this.postApprovalCardMessage({
      type: 'restoreCapabilityApprovalCard',
      approvalId: action.approvalId,
      attemptId: action.attemptId,
      toolName: action.toolName,
      description: action.arguments,
      expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus,
      requestedActionDigest: action.requestedActionDigest,
      frozenContextHash: action.frozenContextHash,
      // The frozen, proposal-time rendering Core stored when the approval was
      // created. Relayed verbatim — the panel never recomputes a diff against
      // the current working tree, which could show a change that is not the
      // one being approved.
      presentation: action.presentation,
      resolved,
      outcome,
    });
  }

  /**
   * Handles the webview's decision on a `restoreCapabilityApprovalCard` —
   * relays the exact envelope fields the panel itself sent down (never
   * fabricated/widened, mirroring `ToolExecutor.finishCoreBackedCapability`)
   * to `resolveCapabilityApproval`, then — only if approved — issues exactly
   * one more `dispatchCapability` call with the same correlationId and the
   * same {toolName, arguments}, which is Core's own idempotent
   * approved-and-execute path (see `dispatchCapability`'s `existing?.status
   * === 'approved'` branch) — not a new approval/idempotency key, and not a
   * second execution if one already happened.
   */
  private async resolveRestoredCapabilityApproval(input: {
    approvalId: string;
    attemptId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    expectedAttemptRevision: number;
    expectedAttemptStatus: AttemptStatus;
    requestedActionDigest: string;
    frozenContextHash: string;
    resolution: 'approved' | 'rejected';
  }): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) { this.post({ type: 'error', message: 'KarkeDikha Core is not connected.' }); return; }
    const owned = this.ownedCapabilityApprovals.get(input.approvalId);
    const turn = owned?.realAttemptId ? this.coreExecutionTurns.get(owned.realAttemptId) : undefined;
    if (
      !owned
      || (
        this.isWorkspaceMutationTool(owned.action.toolName)
        && (
          !turn
          || turn.terminal
          || turn.mode !== 'agent'
          || turn.coreConversationId !== owned.correlationId
        )
      )
    ) {
      this.post({ type: 'error', message: 'This approval is not owned by the active Saath Kar response in this workspace. No action was taken.' });
      return;
    }
    const action = owned.action;
    try {
      const resolved = await client.resolveCapabilityApproval(action.approvalId, {
        resolution: input.resolution,
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      });
      let outcome: 'approved' | 'rejected' | 'succeeded' | 'failed' | 'cancelled' = input.resolution;
      if (resolved.resumedAttemptId) {
        // M38: this approval belonged to a Saath Kar attempt's suspended
        // RuntimeExecutor model loop — Core already resumed it (and, for an
        // approval, already executed the action) as part of resolving it
        // above. Dispatching it again here would duplicate the mutation.
        outcome = input.resolution;
      } else if (input.resolution === 'approved') {
        const dispatched = await client.dispatchCapability({
          correlationId: owned.correlationId,
          toolName: action.toolName,
          arguments: action.arguments,
          cwd: this.workspaceRoot,
        });
        if (dispatched.outcome === 'executed') {
          const status = dispatched.toolInvocation.status;
          outcome = status === 'succeeded' || status === 'failed' || status === 'cancelled' ? status : 'failed';
        }
      }
      this.ownedCapabilityApprovals.delete(action.approvalId);
      this.post({ type: 'capabilityApprovalRestoredResolved', approvalId: input.approvalId, outcome });
      if (input.resolution === 'approved') void this.offerPreviewWhenMutationSucceeded(owned.correlationId, action);
    } catch (error) {
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * After an approved file change on an HTML page, offers the preview once Core confirms the mutation succeeded.
   * Core may have executed it as part of resolving the approval, so the outcome is read back (bounded: a few short
   * polls) instead of assumed. Nothing is offered for a change that failed or never landed.
   */
  private async offerPreviewWhenMutationSucceeded(correlationId: string, action: CapabilityActionRestoreEntry): Promise<void> {
    if (action.toolName !== 'propose_file_change' && action.toolName !== 'propose_text_edit') return;
    const target = String((action.arguments as Record<string, unknown>)?.['path'] ?? '');
    const artifact = previewableArtifacts([target])[0];
    if (!artifact || !this.workspaceRoot) return;
    const client = getCoreManager()?.getClient();
    if (!client) return;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const snapshot = await client.listCapabilityActions(correlationId);
        const current = snapshot.actions.find(item => item.approvalId === action.approvalId);
        if (current?.outcome === 'succeeded') {
          offerPreview(this.workspaceRoot, artifact);
          return;
        }
        if (current && (current.outcome === 'failed' || current.outcome === 'cancelled' || current.outcome === 'rejected')) return;
      } catch {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private isOwnedActiveCapabilityAction(action: CapabilityActionDisplayEntry): boolean {
    const turn = this.coreExecutionTurns.get(action.realAttemptId);
    return Boolean(
      turn
      && !turn.terminal
      && turn.mode === 'agent'
      && turn.coreConversationId === action.correlationId,
    );
  }

  private isWorkspaceMutationTool(toolName: string): boolean {
    return toolName === 'run_command' || toolName === 'write_file';
  }

  /**
   * Wires Agent Chat's Autonomous mode to the already-constructed M15 queue and
   * runtime. Must be called with the exact same instances used by the M15
   * command registration — this method never constructs a second queue or a
   * second autonomous runtime.
   */
  attachAutonomous(queue: DurableTaskQueue, runtime: AutonomousTaskRuntime): void {
    this.autonomousTerminalSubscription?.dispose();
    this.autonomousQueue = queue;
    this.autonomousRuntime = runtime;
    // Polling remains useful for progress, but terminal publication must not
    // depend on a timer surviving webview disposal/recreation. DurableTaskQueue
    // emits only after the terminal record and event are on disk; serialize
    // that signal with ordinary polls and project the same authoritative read.
    this.autonomousTerminalSubscription = queue.onTerminal(task => {
      if (this.autonomousActiveTaskId !== task.taskId) return;
      return this.runSerializedOnPollChain(() => this.pollAutonomousTaskUnserialized(task.taskId));
    });
    // Routed through runSerializedOnPollChain (see its doc comment) rather
    // than calling surface*Approval directly: these are a live, event-driven
    // trigger independent of the polling loop, and must never run
    // concurrently with a pollAutonomousTask call that is mid-flight against
    // its own, possibly now-stale, disk-read snapshot of the same task.
    // An approval card belongs to the conversation that owns the task: a task
    // still running for another conversation must not paint into this chat.
    const ownedOnly = (surface: (task: AutonomousTask) => Promise<void>) => async (task: AutonomousTask) => {
      if (await this.taskBelongsToCurrentConversation(task)) await surface.call(this, task);
    };
    runtime.onDeliveryApprovalRequired(task => void this.runSerializedOnPollChain(() => ownedOnly(this.surfaceDeliveryApproval)(task)));
    runtime.onProposalApprovalRequired(task => void this.runSerializedOnPollChain(() => ownedOnly(this.surfaceProposalApproval)(task)));
    runtime.onMutationApprovalRequired(task => void this.runSerializedOnPollChain(() => ownedOnly(this.surfaceMutationApproval)(task)));
    // A panel-only reload in the same Extension Host may reuse the authority
    // already bound by Core. A fresh Extension Host has an empty authority map
    // and therefore cannot reconnect from local projection alone.
    void this.reconnectAutonomousTask();
  }

  /** On panel (re)open, reconnect to any non-terminal autonomous task for this
   * workspace using durable task state — never cancels a task merely because the
   * panel was closed or reloaded. */
  private async reconnectAutonomousTask(): Promise<void> {
    const epoch = this.conversationEpoch;
    if (!this.autonomousQueue) return;
    const submissionEpochAtStart = this.karkeDikhaSubmissionEpoch;
    const generationAtStart = this.autonomousProjectionGeneration;
    try {
      const tasks = await this.autonomousQueue.list();
      if (epoch !== this.conversationEpoch) return;
      if (this.karkeDikhaSubmissionEpoch !== submissionEpochAtStart || this.karkeDikhaPendingSubmissionCount > 0) {
        // Either a fresh 'startAutonomousTask' submission began while this
        // restore read was in flight (epoch changed), or one was already
        // pending before this read even started and still hasn't reached its
        // own enqueue (count > 0 — the epoch snapshot above cannot detect
        // this ordering, since it was already at the elevated value when
        // captured). Either way that submission's own projection is
        // authoritative; committing this now-stale snapshot would silently
        // replace a live task's identity with an old one.
        return;
      }
      const eligible = tasks
        .filter(task => this.taskBelongsToWorkspace(task))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      let active: AutonomousTask | undefined;
      for (const task of eligible) {
        if (!AUTONOMOUS_AUTO_RESTORE_STATES.has(task.state)) continue;
        // Identity, not recency: a still-running task from another
        // conversation must not be re-projected into this chat.
        if (await this.taskBelongsToCurrentConversation(task)) { active = task; break; }
      }
      // Ownership changed while this snapshot was being read/verified: it is stale.
      if (epoch !== this.conversationEpoch || this.autonomousProjectionGeneration !== generationAtStart) return;
      if (active) {
        const alreadyPolling = this.autonomousActiveTaskId === active.taskId && Boolean(this.autonomousPollTimer);
        // Tells the webview a non-terminal task already exists so it can
        // reflect the task's authoritative state (e.g. "Waiting for delivery
        // approval") instead of defaulting to an idle/ready placeholder after
        // a reload or panel re-open.
        this.projectAutonomousTask({
          taskId: active.taskId,
          attemptId: active.attemptId,
          state: active.state,
          goal: active.goal,
          restored: true,
        });
        if (!alreadyPolling) this.startAutonomousPolling(active.taskId);
        return;
      }
      // A live task this panel is already polling (e.g. freshly enqueued and still
      // 'queued', which is not an auto-restore state) is not a stale projection:
      // a late background reconnect must not drop its id or stop its polling.
      const polled = this.autonomousActiveTaskId
        ? tasks.find(task => task.taskId === this.autonomousActiveTaskId)
        : undefined;
      if (polled && !AUTONOMOUS_TERMINAL_STATES.has(polled.state) && await this.taskBelongsToCurrentConversation(polled)) {
        return;
      }
      if (this.autonomousProjectionGeneration !== generationAtStart) return;
      if (this.autonomousActiveTaskId) {
        this.autonomousActiveTaskId = undefined;
      }
      if (this.autonomousPollTimer) {
        clearInterval(this.autonomousPollTimer);
        this.autonomousPollTimer = undefined;
      }
    } catch (error) {
      Logger.warn('[AgentPanel] Autonomous task reconnect failed:', error);
    }
  }

  /**
   * Activation-time Core read/reconciliation path. The promise guard makes a
   * repeated activation callback within this Extension Host a strict no-op.
   * The Core response is already workspace-scoped and non-terminal; this code
   * never submits, retries, or creates an attempt or M15 task.
   */
  rehydrateCoreAttempts(): Promise<void> {
    if (!this.coreRehydrationPromise) {
      this.coreRehydrationPromise = this.runCoreAttemptRehydration().catch(error => {
        Logger.error('[M32] Core attempt rehydration failed:', error);
      });
    }
    return this.coreRehydrationPromise;
  }

  private async runCoreAttemptRehydration(): Promise<void> {
    const epoch = this.conversationEpoch;
    const client = getCoreManager()?.getClient();
    if (!client || !this.workspaceAvailable) return;
    this.ensureCoreRuntimeRelay();
    const snapshot = await client.getWorkspaceAttemptRehydration(this.workspaceRoot);
    if (epoch !== this.conversationEpoch) return;
    const restoredProjections = new Set<string>();
    for (const record of snapshot.attempts) {
      if (epoch !== this.conversationEpoch) return;
      // Baat/Saath share one live chat projection; Karke Dikha has its own M15
      // projection. Core orders newest first, so older active/history remnants
      // cannot leak into either slot.
      const projection = record.attempt.kind === 'karke_dikha' ? 'karke_dikha' : 'core_execution';
      if (restoredProjections.has(projection)) continue;
      restoredProjections.add(projection);
      if (record.attempt.kind === 'karke_dikha') {
        await this.rehydrateKarkeDikhaAttempt(client, record);
      } else {
        await this.rehydrateCoreExecutionAttempt(client, record);
      }
    }
    // M38: `coreExecutionTurns` (and each turn's `coreConversationId`) is only
    // populated by the loop above, but `resolveWebviewView` may already have
    // run its own `restoreCapabilityApprovalCards()` pass before this
    // rehydration finished (no ordering guarantee between the two — see
    // `extension.ts`'s activation IIFE vs. `WebviewViewProvider.resolveWebviewView`),
    // in which case that pass found no coreConversationId mappings yet and
    // silently surfaced nothing. Re-running it here — after this attempt's
    // Core-side turns are known — is the deterministic fix: whichever call
    // finishes second is the one that actually posts the card.
    // `surfacedCapabilityApprovalCards` prevents a duplicate post if the
    // first pass already found it; `post()` safely no-ops if no webview
    // exists yet, and a subsequently created webview still restores the
    // card normally via its own `resolveWebviewView` -> `restoreCapabilityApprovalCards` call.
    await this.restoreCapabilityApprovalCards();
  }

  private async rehydrateCoreExecutionAttempt(client: CoreClient, record: AttemptRehydrationRecord): Promise<void> {
    const { attempt, request, context, recovery } = record;
    if (recovery === 'terminal' || recovery === 'requires_reconciliation') {
      if (recovery === 'requires_reconciliation') this.postCoreRecoveryRequired(record);
      return;
    }
    // An old never-started attempt is not shown as active and is never executed by a reload.
    if (recovery === 'safely_retryable_from_scratch' && !isFreshForReloadRetry(attempt.createdAt)) {
      this.postCoreRecoveryRequired(record, 'stale_not_started');
      return;
    }
    const runId = request.conversationId
      ? this.localConversationIdFor(request.conversationId) ?? this.conversationId
      : attempt.id;
    if (this.coreExecutionTurns.has(attempt.id)) return;
    const mode: AgentMode = attempt.kind === 'baat_kar' ? 'chat' : 'agent';
    const turn: CoreExecutionTurn = {
      attemptId: attempt.id,
      conversationId: runId,
      coreConversationId: request.conversationId ?? undefined,
      mode,
      terminal: false,
      tokenBuffer: '',
      toolArgsById: new Map(),
      restoredInput: request.currentMessage,
      restoredStatus: attempt.status,
    };
    // A restored in-flight turn gets the same authoritative projection a live one has, so its status and its terminal
    // outcome come from one place instead of legacy "Investigating/Working" flags that nothing would ever clear.
    turn.projection = new ExecutionProjection({ runId: attempt.id, mode: attempt.kind as RunMode, request: request.currentMessage });
    this.beginDhaaga(turn.projection);
    this.postDhaaga(turn.projection.modelActivity());
    this.coreExecutionTurns.set(attempt.id, turn);
    this.coreActiveAttemptIds.set(runId, attempt.id);
    if (request.conversationId) {
      this.coreConversationIds.set(`${attempt.kind}:${runId}`, request.conversationId);
    }
    this.activePermissionRunId = runId;
    this.projectRestoredCoreExecution(turn);

    // A crash between atomic submit and execute leaves the same Core attempt
    // claimable. Execute that identity; never submit a replacement. Only a fresh one: an old queued
    // attempt is a task the user may have long forgotten, and a reload must never silently start it.
    if (recovery === 'safely_retryable_from_scratch') {
      await client.executeAttempt(attempt.id, attempt.kind === 'saath_kar' ? { workingDirectory: context.workspaceRoot ?? undefined } : {});
    }

    // Close the snapshot/WS subscription race against Core terminalization.
    const current = await client.getAttempt(attempt.id);
    if (current.status === 'completed') await this.finishCoreExecutionTurn(turn, 'completed');
    else if (current.status === 'failed') {
      this.recordCloudQuotaFailure(current.failureReason ?? '');
      await this.finishCoreExecutionTurn(turn, 'failed', current.failureReason ?? undefined);
    }
    else if (current.status === 'cancelled') await this.finishCoreExecutionTurn(turn, 'cancelled');
  }

  private async rehydrateKarkeDikhaAttempt(client: CoreClient, record: AttemptRehydrationRecord): Promise<void> {
    if (!this.autonomousQueue || !this.autonomousRuntime) return;
    const { attempt, context, recovery } = record;
    const task = await this.autonomousQueue.get(attempt.id);
    if (!task) {
      // Frozen context cannot reconstruct an interrupted proposal, worktree,
      // or mutation safely. Never create a replacement M15 task on restart.
      this.postCoreRecoveryRequired(record, 'm15_projection_missing');
      return;
    }

    if (recovery === 'terminal') return;
    if (recovery === 'requires_reconciliation') {
      await this.markM15RecoveryRequired(task, record);
      return;
    }
    // Not started and old: claiming or waking it would silently run a mutation task the user left behind.
    if (recovery === 'safely_retryable_from_scratch' && !isFreshForReloadRetry(attempt.createdAt)) {
      await this.markM15RecoveryRequired(task, record);
      return;
    }

    const leaseActive = Boolean(
      attempt.fenceToken &&
      attempt.claimOwner &&
      attempt.claimExpiresAt &&
      Date.parse(attempt.claimExpiresAt) > Date.now(),
    );

    // Chat-surface ownership comes from the durable ledger's CURRENT conversation,
    // not from in-memory state that may not be loaded yet at activation time. A
    // task owned by another conversation is still recovered (authority below) but
    // is never projected into, polled for, or made the steering target of this chat.
    const ownerConversation = record.request.conversationId;
    const currentConversation = await this.durableCurrentCoreConversation(client);
    const projectIntoChat = !ownerConversation || !currentConversation || ownerConversation === currentConversation;

    if (recovery === 'safely_resumable') {
      // A live worker owns this fence. Restore projection only; binding/waking a
      // second worker would violate the lease even if this UI just restarted.
      if (projectIntoChat) {
        this.autonomousActiveTaskId = attempt.id;
        this.projectAutonomousTask({ taskId: attempt.id, state: attempt.status, attemptId: attempt.id, restored: true });
      }
      return;
    }

    let credentials: CoreKarkeDikhaWorkerCredentials;
    let pendingApprovals = record.approvals.filter(approval => approval.status === 'pending');
    if (recovery === 'awaiting_human_approval' && leaseActive) {
      credentials = {
        fenceToken: attempt.fenceToken!,
        owner: attempt.claimOwner!,
        frozenContextHash: context.contextHash,
      };
    } else {
      // Expired/claimable work can be taken only through Core's claim endpoint,
      // which issues the next fence generation and rejects a live competing lease.
      const owner = `m15-worker-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const claim = await client.claimKarkeDikhaAttempt(attempt.id, { owner });
      credentials = { fenceToken: claim.fence.token, owner, frozenContextHash: claim.context.contextHash };
      pendingApprovals = record.approvals.filter(approval => approval.status === 'pending');
    }

    const authority = this.createKarkeDikhaAuthority(client, attempt.id, context, credentials);
    this.autonomousRuntime.restoreCoreAuthority(attempt.id, authority, pendingApprovals);
    await authority.heartbeat();

    if (recovery === 'safely_retryable_from_scratch') {
      await this.autonomousQueue.update({ ...task, state: 'queued', claim: undefined, failure: undefined }, 'core_restart_rehydrated', {
        attemptId: attempt.id,
        fenceGeneration: record.attempt.fenceGeneration,
      });
      this.autonomousRuntime.wake();
    }
    if (projectIntoChat) this.startAutonomousPolling(attempt.id);
  }

  /** The workspace's durable current conversation (Core ledger). undefined when
   * unknown, in which case callers fall back to projecting (never strand a task). */
  private async durableCurrentCoreConversation(client: CoreClient): Promise<string | undefined> {
    try {
      const ledger = await client.getWorkspaceConversationLedger(this.workspaceIdentity);
      return ledger.currentCoreConversationId || undefined;
    } catch {
      return undefined;
    }
  }

  private createKarkeDikhaAuthority(
    client: CoreClient,
    attemptId: string,
    context: AttemptRehydrationRecord['context'],
    credentials: CoreKarkeDikhaWorkerCredentials,
  ): KarkeDikhaLifecycleAuthority {
    return {
      context,
      heartbeat: async () => { await client.heartbeatKarkeDikhaAttempt(attemptId, credentials); },
      requestApproval: async (kind, summary) =>
        (await client.requestKarkeDikhaApproval(attemptId, credentials, { kind, summary })).approval,
      resolveApproval: async (approval, resolution, disposition) => {
        await client.resolveKarkeDikhaApproval(approval, credentials, { resolution, disposition });
      },
      beginValidation: async () => { await client.beginKarkeDikhaValidation(attemptId, credentials); },
      reportValidation: evidence => client.reportKarkeDikhaValidation(attemptId, credentials, evidence),
      recordExecutionQuality: async evidence => { await client.recordKarkeDikhaExecutionQuality(attemptId, credentials, evidence); },
      complete: async summary => { await client.completeKarkeDikhaAttempt(attemptId, credentials, summary); },
      fail: async reason => { await client.failKarkeDikhaAttempt(attemptId, credentials, reason); },
      cancel: async () => { await client.cancelKarkeDikhaAttempt(attemptId, credentials); },
    };
  }

  private async markM15RecoveryRequired(task: AutonomousTask, record: AttemptRehydrationRecord): Promise<void> {
    await this.autonomousQueue?.update({
      ...task,
      state: 'blocked',
      claim: undefined,
      failure: {
        classification: 'recovery_required',
        message: `Core classified attempt ${record.attempt.id} as requiring reconciliation.`,
        at: new Date().toISOString(),
      },
    }, 'core_recovery_required', { attemptId: record.attempt.id });
    this.postCoreRecoveryRequired(record);
  }

  private postCoreRecoveryRequired(record: AttemptRehydrationRecord, reason = 'requires_reconciliation'): void {
    this.post({
      type: 'coreAttemptRecoveryRequired',
      attemptId: record.attempt.id,
      mode: record.attempt.kind,
      status: record.attempt.status,
      reason,
    });
    if (record.attempt.kind !== 'karke_dikha') {
      // Plain-language default surface; the raw attempt id stays available in
      // the coreAttemptRecoveryRequired message and diagnostics (M33 §2).
      this.post({ type: 'error', message: 'A previous task was interrupted and needs recovery before it can continue. Open Details for diagnostics.' });
    }
  }

  private renderRehydratedProjection(): void {
    for (const turn of this.coreExecutionTurns.values()) {
      this.projectRestoredCoreExecution(turn);
    }
    if (this.autonomousActiveTaskId) {
      this.projectAutonomousTask({ taskId: this.autonomousActiveTaskId, restored: true });
      void this.pollAutonomousTask(this.autonomousActiveTaskId);
    }
  }

  private async postAutonomousComposerContext(): Promise<void> {
    if (!this.workspaceAvailable) {
      this.post({ type: 'autonomousComposerContextUnavailable', reason: 'workspace_required' });
      return;
    }
    const dotOllamaAgent = path.join(this.workspaceRoot, '.ollama-agent');
    const hasDotOllamaAgent = fs.existsSync(dotOllamaAgent);
    const [branch, headCommit, dirty, trackedRuntimeFiles] = await Promise.all([
      this.gitOneLine(['rev-parse', '--abbrev-ref', 'HEAD']),
      this.gitOneLine(['rev-parse', '--short', 'HEAD']),
      this.gitOneLine(['status', '--porcelain']).then(out => Boolean(out)),
      hasDotOllamaAgent ? this.gitLines(['ls-files', '--', '.ollama-agent']) : Promise.resolve([]),
    ]);
    this.post({
      type: 'autonomousComposerContext',
      repositoryName: path.basename(this.workspaceRoot),
      branch: branch || 'unknown',
      headCommit: headCommit || 'unknown',
      dirty,
      hasTrackedRuntimeState: trackedRuntimeFiles.length > 0,
      trackedRuntimeFiles,
      provider: Config.getProviderType(),
      model: Config.getCodingModel(),
      permissionProfile: this.selectedPermissionContext.profileId,
    });
  }

  private gitOneLine(args: string[]): Promise<string | undefined> {
    return new Promise(resolve => {
      try {
        const child = spawn('git', args, { cwd: this.workspaceRoot, shell: false, windowsHide: true });
        let output = '';
        const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 5_000);
        child.stdout.on('data', data => { output += String(data); });
        child.on('error', () => { clearTimeout(timer); resolve(undefined); });
        child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? output.trim() || undefined : undefined); });
      } catch {
        resolve(undefined);
      }
    });
  }

  private gitLines(args: string[]): Promise<string[]> {
    return new Promise(resolve => {
      try {
        const child = spawn('git', args, { cwd: this.workspaceRoot, shell: false, windowsHide: true });
        let output = '';
        const timer = setTimeout(() => { child.kill(); resolve([]); }, 5_000);
        child.stdout.on('data', data => { output += String(data); });
        child.on('error', () => { clearTimeout(timer); resolve([]); });
        child.on('close', code => {
          clearTimeout(timer);
          resolve(code === 0 ? output.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []);
        });
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Validates and enqueues an autonomous task through the existing M15
   * DurableTaskQueue/AutonomousTaskRuntime — the same queue and runtime used by
   * the `ollama-agent.startAutonomousTask` command. Never mutates anything
   * itself; wakes the existing runtime so it drains the task through the
   * unmodified governed execution pipeline (isolated worktree, proposal
   * approval, mutation approval, validation, M16 gate, delivery approval).
   */
  async startAutonomousTask(text: string, modelOverride?: string, submissionId?: string, autonomyMode?: KarkeAutonomyMode): Promise<void> {
    if (!this.workspaceAvailable) {
      await this.requireWorkspace({ text, mode: 'agent', conversationId: this.conversationId });
      return;
    }
    const client = await this.ensureCoreClientReady(4000);
    if (!client) {
      this.post({ type: 'error', message: 'KarkeDikha Core is still starting. Try again in a moment.' });
      return;
    }
    if (!this.autonomousQueue || !this.autonomousRuntime) {
      this.post({ type: 'error', message: 'Autonomous runtime is not available in this workspace.' });
      return;
    }
    const dotOllamaAgent = path.join(this.workspaceRoot, '.ollama-agent');
    const trackedRuntimeFiles = fs.existsSync(dotOllamaAgent)
      ? await this.gitLines(['ls-files', '--', '.ollama-agent'])
      : [];
    if (trackedRuntimeFiles.length > 0) {
      this.post({
        type: 'error',
        message: `KarkeDikha runtime files are tracked by Git in this repository (${trackedRuntimeFiles.length} file(s) tracked). Runtime state should not be version-controlled because it dirties the workspace and blocks safe delivery.\n\nTo fix this safely, run:\ngit rm -r --cached .ollama-agent`,
      });
      return;
    }
    if (this.karkeDikhaSubmissionInFlight) {
      this.post({ type: 'error', message: 'A Karke Dikha submission is already in progress.' });
      return;
    }
    this.karkeDikhaSubmissionInFlight = true;
    // Covers the public `ollama-agent.startAutonomousTask` command, which
    // calls this method directly and never passes through the webview
    // message case's own epoch/pending bump. Harmless to also bump here for
    // a webview-originated call (see karkeDikhaPendingSubmissionCount's field
    // comment) — the finally below always balances it.
    this.karkeDikhaPendingSubmissionCount += 1;
    try {
      // M32 correction Phase 3: Core is consulted *first*, before the M15 task
      // exists, so the Core-issued request/attempt is the one authoritative
      // identity for this submission — the M15 task correlates to it rather
      // than the Extension Host inventing a second, independent identity (the
      // prior dual-authority bug: `beginCoreKarkeDikhaAttempt` used to create a
      // separate Core record best-effort *after* the M15 task already existed
      // and started, and a Core failure there was silently swallowed either
      // way).
      const submission = await this.submitKarkeDikhaRequest(text, modelOverride);
      if (submission.outcome === 'model_selection_failed') {
        // Local model selection failed before Core was ever asked — report
        // the true cause, never a Core rejection.
        this.post({
          type: 'error',
          message: submission.code === 'no_capable_model'
            ? "Karke Dikha couldn't start because no configured model meets this task's requirements. Choose a capable model explicitly or update your KarkeDikha model settings."
            : `Karke Dikha couldn't start: ${submission.message}`,
        });
        return;
      }
      if (submission.outcome === 'rejected') {
        // Core is reachable but rejected the submission — do not silently fall
        // through to starting an untracked M15 task for it.
        this.post({ type: 'error', message: 'Karke Dikha could not be started: Core rejected the submission.' });
        return;
      }
      const frozen = submission.authority.context;
      // Fresh snapshot of the real repository at task creation — never reused
      // from a prior task, conversation state, or a hydrated panel cache.
      const [destinationBranch, repositoryHeadAtStart] = await Promise.all([
        resolveLocalTaskDestinationBranch(this.workspaceRoot),
        resolveLocalTaskRepositoryHead(this.workspaceRoot),
      ]);
      const projectedInput = createDefaultAutonomousTask(this.workspaceRoot, frozen.taskInput, destinationBranch);
      // Bind before the projection becomes claimable so no runtime pass can
      // observe a local task without its Core fence.
      this.autonomousRuntime.bindCoreAuthority(submission.attemptId, submission.authority);
      // Unified Conversation V1: `submitKarkeDikhaRequest` (just above) already
      // established this conversation's durable Core conversationId — reuse
      // the same cached value rather than re-deriving it.
      const trustedDirtyCoreConversationId = this.coreConversationIdFor(this.conversationId);
      const trustedDirtyBaseline = trustedDirtyCoreConversationId
        ? await this.computeTrustedDirtyBaseline(trustedDirtyCoreConversationId)
        : undefined;
      let task: AutonomousTask;
      try {
        task = await this.autonomousQueue.enqueue({
          ...projectedInput,
          taskId: submission.attemptId,
          attemptId: submission.attemptId,
          destinationBranch,
          repositoryHeadAtStart,
          trustedDirtyBaseline,
          // Task-Scoped Autonomy V1 — frozen once here, at task creation.
          // Fail-closed: anything other than the exact literal 'hands_off'
          // (including undefined, from an old webview build or a caller that
          // never passed it) defaults to 'supervised', never the reverse.
          autonomyMode: autonomyMode === 'hands_off' ? 'hands_off' : 'supervised',
          providerModelRoutingSnapshot: {
            ...projectedInput.providerModelRoutingSnapshot,
            provider: frozen.selectedProvider,
            model: frozen.selectedModel,
          },
          githubDelivery: await resolveLocalTaskGitHubDelivery(this.workspaceRoot),
        });
      } catch (error) {
        await submission.authority.fail('m15_worker_enqueue_failed').catch(() => undefined);
        throw error;
      }
      this.autonomousRuntime.wake();
      this.post({
        type: 'autonomousTaskStarted',
        taskId: task.taskId,
        attemptId: task.attemptId,
        submissionId,
        state: task.state,
        goal: task.goal,
        autonomyMode: task.autonomyMode ?? 'supervised',
      });
      this.postAutonomousRepositorySnapshot(task);
      this.startAutonomousPolling(task.taskId);
      await this.recordTaskContinuity({
        latestTaskId: task.taskId,
        pendingAction: { kind: 'resume_work', description: 'An autonomous task is running for this objective.' },
      });
    } catch (error) {
      if (error instanceof AutonomousTaskInputTooLargeError) {
        this.post({ type: 'autonomousTaskRejected', reason: 'input_too_large', utf8ByteCount: error.utf8ByteCount, limitBytes: error.limitBytes });
        return;
      }
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.karkeDikhaSubmissionInFlight = false;
      this.karkeDikhaPendingSubmissionCount = Math.max(0, this.karkeDikhaPendingSubmissionCount - 1);
    }
  }

  /**
   * Projects the task's own persisted start-of-task repository snapshot
   * (Details "Branch / HEAD"). Reads only the task record — never live Git,
   * the composer-context cache, or another task.
   */
  private postAutonomousRepositorySnapshot(task: AutonomousTask): void {
    const branch = task.destinationBranch?.trim();
    const head = task.repositoryHeadAtStart?.trim();
    if (!branch && !head) return;
    this.post({
      type: 'autonomousTaskRepositorySnapshot',
      taskId: task.taskId,
      repositoryName: path.basename(task.repositoryRoot || this.workspaceRoot),
      branch: branch || 'unknown',
      headCommit: head ? head.slice(0, 7) : 'unknown',
    });
  }

  /** Bumped whenever polling/projection ownership changes (new task polled, New Chat
   * detach). An in-flight reconnect that read its task list before the change must
   * not commit (project OR clear) against the newer state. */
  private autonomousProjectionGeneration = 0;

  private startAutonomousPolling(taskId: string): void {
    this.autonomousProjectionGeneration += 1;
    if (this.autonomousPollTimer) clearInterval(this.autonomousPollTimer);
    this.autonomousActiveTaskId = taskId;
    void this.pollAutonomousTask(taskId);
    this.autonomousPollTimer = setInterval(() => void this.pollAutonomousTask(taskId), AUTONOMOUS_POLL_INTERVAL_MS);
    this.autonomousPollTimer.unref?.();
  }

  /**
   * Public entry point: chains this invocation onto `autonomousPollChain` so
   * it can never run concurrently with another poll for any task in this
   * panel (see the field comment on `autonomousPollChain` for why overlap is
   * unsafe). A rejected prior link must never permanently wedge the chain, so
   * failures are swallowed here — `pollAutonomousTaskUnserialized` already
   * handles its own errors/no-ops internally and has no return value callers
   * depend on.
   */
  private pollAutonomousTask(taskId: string): Promise<void> {
    return this.runSerializedOnPollChain(() => this.pollAutonomousTaskUnserialized(taskId));
  }

  /**
   * Chains `fn` onto `autonomousPollChain`, the single serialization point
   * for every code path that reads approval-gate state and decides what to
   * tell the webview. `pollAutonomousTask` is not the only such path:
   * `attachAutonomous` also wires `AutonomousTaskRuntime`'s
   * `onProposalApprovalRequired`/`onMutationApprovalRequired`/
   * `onDeliveryApprovalRequired` event callbacks directly to
   * `surfaceProposalApproval`/`surfaceMutationApproval`/
   * `surfaceDeliveryApproval` — a live, event-driven trigger fired by the
   * runtime the moment a gate becomes pending, entirely independent of the
   * polling loop. Without routing BOTH through this same chain, a
   * pollAutonomousTask call already in flight (past its own disk read, about
   * to run reconcileStaleApprovalCards against that now-stale snapshot) can
   * run concurrently with an event-triggered surfaceMutationApproval call
   * that just legitimately activated the gate from a fresher, in-memory
   * snapshot — the exact race this method exists to close. A rejected prior
   * link must never permanently wedge the chain, so failures are swallowed
   * here.
   */
  private runSerializedOnPollChain(fn: () => Promise<void>): Promise<void> {
    const next = this.autonomousPollChain.catch(() => undefined).then(fn);
    this.autonomousPollChain = next.catch(() => undefined);
    return next;
  }

  private async pollAutonomousTaskUnserialized(taskId: string): Promise<void> {
    if (!this.autonomousQueue || this.autonomousActiveTaskId !== taskId) return;
    const task = await this.autonomousQueue.get(taskId);
    if (!task) return;
    const allEvents = await this.autonomousQueue.eventsAfter(taskId, 0);
    const afterSeq = this.autonomousEventCursors.get(taskId) ?? 0;
    const unseen = allEvents.filter(event => event.seq > afterSeq);
    const progressEvents = unseen.filter(event => event.type === 'progress' && typeof event.payload.progress === 'string');
    if (unseen.length > 0) this.autonomousEventCursors.set(taskId, unseen[unseen.length - 1].seq);
    if (task.pendingProposal?.operations?.length) {
      const seen = this.taskProposedOperations.get(task.taskId) ?? new Map<string, string>();
      for (const operation of task.pendingProposal.operations) seen.set(String((operation as { path: string }).path), String((operation as { type: string }).type));
      this.taskProposedOperations.set(task.taskId, seen);
    }
    let taskResult: TaskResult | undefined;
    try {
      taskResult = assembleAutonomousTaskResult(task as never, {
        workspaceRoot: this.workspaceRoot,
        proposedOperations: this.taskProposedOperations.get(task.taskId),
      });
    } catch (error) {
      // The result card is derived evidence; it must never be able to break the authoritative status projection.
      Logger.warn('[AgentPanel] Could not assemble the task result:', error);
    }
    if (taskResult) {
      this.taskResults.set(task.taskId, taskResult);
      if (taskResult.artifacts.length > 0 && await this.taskBelongsToCurrentConversation(task as never)) {
        this.recentArtifacts.recordResult(this.conversationId, task.taskId, 'karke_dikha', taskResult);
      }
    }
    this.feedAutonomousDhaaga(task, progressEvents, taskResult);
    const worktreeGit = task.worktreeLocation
      ? await this.gitStatus(task.worktreeLocation)
      : undefined;
    const validationCompleted = [...allEvents].reverse().find(event =>
      event.type === 'progress' && /^validation_completed commands=\d+ failed=\d+$/.test(String(event.payload.progress ?? '')),
    );
    const validationMatch = validationCompleted
      ? /^validation_completed commands=(\d+) failed=(\d+)$/.exec(String(validationCompleted.payload.progress))
      : null;
    const proposalEvent = [...allEvents].reverse().find(event =>
      event.type === 'proposal_pending' && typeof event.payload.taskSummary === 'string',
    );
    // Phase 9 — restart-restored state: `recoverOnActivation()` blocks any
    // task that was interrupted mid-flight (preparing/running/validating/
    // committing/creating_pull_request/updating_pull_request) with
    // classification 'recovery_required' (`M15AutonomousWork.ts`
    // `recoverOnActivation`). Surface that distinctly from an ordinary
    // failure/rejection so the UI can explain "this resumed after a restart"
    // rather than presenting it as a plain error.
    const restartRestored = task.failure?.classification === 'recovery_required';
    const retryClient = getCoreManager()?.getClient();
    const retryEligibility = AUTONOMOUS_TERMINAL_STATES.has(task.state)
      && typeof retryClient?.getAttemptRetryEligibility === 'function'
      ? await retryClient.getAttemptRetryEligibility(task.attemptId).catch(() => undefined)
      : undefined;
    const authoritativeChangedCount = task.diffReview?.approvedScopePaths?.length
      ? new Set(task.diffReview.approvedScopePaths).size
      : task.mutationEvidence?.changedPaths?.length
      ? new Set(task.mutationEvidence.changedPaths).size
      : task.pendingProposal?.operations?.length
      ? new Set(task.pendingProposal.operations.map(op => (op as { path: string }).path).filter(Boolean)).size
      : (worktreeGit?.changedFileCount ?? 0);
    let destinationBranch = task.destinationBranch?.trim();
    if (!destinationBranch) {
      const liveBranch = await resolveLocalTaskDestinationBranch(task.repositoryRoot || this.workspaceRoot);
      if (liveBranch && liveBranch.trim()) {
        destinationBranch = liveBranch.trim();
      }
    }
    const resolvedDestinationBranch = destinationBranch || 'working branch';
    const statusMessage = {
      type: 'autonomousTaskStatus',
      taskId: task.taskId,
      attemptId: task.attemptId,
      goal: task.goal,
      state: task.state,
      provider: task.providerModelRoutingSnapshot['provider'] ?? Config.getProviderType(),
      model: task.providerModelRoutingSnapshot['model'] ?? Config.getCodingModel(),
      // Task-Scoped Autonomy V1 — the task's own frozen mode, so the webview
      // can display it for an active task without ever re-deriving it from
      // the live UI selector (STEP 8: a running task's mode never changes).
      autonomyMode: task.autonomyMode ?? 'supervised',
      pandaState: pandaStateForLifecycleState(task.state),
      connectorState: connectorStateForLifecycleState(task.state),
      events: progressEvents.map(event => {
        const parsed = parseAutonomousProgressPhase(String(event.payload.progress));
        return {
          eventId: event.eventId,
          seq: event.seq,
          renderedProgress: renderAutonomousProgressEventPlain(parsed, new Date(event.timestamp)),
          pandaState: pandaStateForEventKind(parsed.kind),
          isSubagent: isSubagentEventKind(parsed.kind),
          kind: parsed.kind,
          title: parsed.title,
          detail: parsed.detail,
          timestamp: event.timestamp,
          rawProgress: String(event.payload.progress),
        };
      }),
      failure: task.failure,
      ...(taskResult ? { taskResult } : {}),
      validationFailure: task.validationFailure,
      validationRepairAttempts: task.validationRepairAttempts ?? 0,
      qualityGate: task.qualityGate,
      diffReview: task.diffReview,
      // M33 outcome evidence (additive, read-only projections of the same
      // durable task record — no new lifecycle state): delivery commit,
      // branch, approved change scope, validation totals, terminal summary.
      // Truthful branch separation: destinationBranch is the workspace branch
      // being delivered/applied to (e.g. 'dev/current' or 'working branch'); taskBranchName is the dedicated
      // isolated worktree lease branch (e.g. 'forge/att_...'). branchName retains
      // destinationBranch so any consumer expecting the applied destination receives it.
      branchName: resolvedDestinationBranch,
      destinationBranch: resolvedDestinationBranch,
      taskBranchName: task.branchName,
      deliveryCommitSha: task.githubDelivery?.commitSha,
      approvedScopePaths: task.diffReview?.approvedScopePaths,
      terminalSummary: task.terminalResult?.summary,
      validationTotals: validationMatch
        ? { commands: Number(validationMatch[1]), failed: Number(validationMatch[2]) }
        : undefined,
      postDeliveryValidation: task.deliveryValidation,
      // Phase 6/9 — stage routing provenance (currently the reviewer stage
      // only; see docs/M15_REQUIREMENTS_AUDIT.md). Lets the UI show whether
      // the diff-review reviewer was the deterministic host or a configured
      // model, and why.
      stageRouting: task.stageRouting,
      restartRestored,
      retryEligibility,
      resolvedGates: {
        proposal: allEvents.some(event => event.type === 'proposal_approved'),
        mutation: allEvents.some(event => event.type === 'mutation_approved'),
      },
      proposalSummary: proposalEvent ? String(proposalEvent.payload.taskSummary).slice(0, 500) : undefined,
      deliveryEvidence: {
        changedFileCount: authoritativeChangedCount,
        destinationBranch: resolvedDestinationBranch,
        taskBranchName: task.branchName,
        deliveryCommitSha: task.githubDelivery?.commitSha,
        deliveryReached: task.state === 'completed',
        postDeliveryValidationStatus: task.deliveryValidation?.status,
        ...(worktreeGit ? { worktreeClean: worktreeGit.clean } : {}),
        ...(task.deliveryValidation?.status !== 'failed' && validationMatch && Number(validationMatch[2]) === 0
          ? { validationPassCount: Number(validationMatch[1]) }
          : {}),
      },
    };
    const terminal = AUTONOMOUS_TERMINAL_STATES.has(task.state);
    // Preview offer: only for a task this panel watched finish in THIS session. A completed task re-projected after a
    // restart (history restore) has no non-terminal predecessor here and must not raise a notification.
    const previousTaskState = this.sessionTaskStates.get(task.taskId);
    this.sessionTaskStates.set(task.taskId, task.state);
    if (task.state === 'completed' && previousTaskState && !AUTONOMOUS_TERMINAL_STATES.has(previousTaskState)) {
      const changed = task.diffReview?.approvedScopePaths?.length
        ? task.diffReview.approvedScopePaths
        : task.mutationEvidence?.changedPaths ?? [];
      const artifact = previewableArtifacts(changed)[0];
      if (artifact && this.workspaceRoot) offerPreview(this.workspaceRoot, artifact);
    }
    this.postAutonomousRepositorySnapshot(task);
    if (!terminal) {
      this.post(statusMessage);
    }
    this.rehydrateResolvedApprovalCards(task, allEvents);
    this.reconcileStaleApprovalCards(task);
    if (task.state === 'waiting_for_delivery_approval') {
      await this.surfaceDeliveryApproval(task);
    }
    if (task.state === 'waiting_for_proposal_approval') {
      await this.surfaceProposalApproval(task);
    }
    if (task.state === 'waiting_for_mutation_approval') {
      await this.surfaceMutationApproval(task);
    }
    // Keep the conversation's one-line "what is outstanding" pointer in step
    // with the task's authoritative state. The card itself is still restored
    // by the existing durable machinery; this only records that one is due.
    const gateDescription = GATE_PENDING_ACTION_DESCRIPTION[task.state];
    if (gateDescription && this.conversationWorkingState?.pendingAction?.description !== gateDescription) {
      await this.recordTaskContinuity({
        latestTaskId: task.taskId,
        latestProposalId: task.pendingProposal?.proposalId ?? null,
        pendingAction: { kind: 'awaiting_approval', description: gateDescription },
        // A governed proposal names the files the work actually targets, which
        // are authoritative repository paths in exactly the same sense as the
        // context selection above.
        proposalPaths: (task.pendingProposal?.operations ?? [])
          .map(operation => String((operation as { path?: unknown }).path ?? ''))
          .filter(Boolean),
      });
    }
    if (terminal) {
      // Historical approval-card replay above is chronological context, not
      // active lifecycle state. Publish terminal status last so every
      // coordinator finishes on the authoritative completed projection.
      // Readiness queuing prevents this restoration message being dropped.
      if (this.projectedTerminalTaskId !== task.taskId) {
        this.postApprovalCardMessage(statusMessage);
        this.projectedTerminalTaskId = task.taskId;
      }
      if (this.autonomousPollTimer) {
        clearInterval(this.autonomousPollTimer);
        this.autonomousPollTimer = undefined;
      }
      // The terminal status was posted above. Release the host's active-task
      // projection immediately so Stop/steering cannot remain bound to a
      // completed task and reconnect cannot mistake it for active work.
      if (this.autonomousActiveTaskId === task.taskId) {
        this.autonomousActiveTaskId = undefined;
      }
      if (this.conversationWorkingState?.latestTaskId === task.taskId) {
        await this.recordTaskContinuity({
          pendingAction: null,
          latestValidationSummary: validationMatch
            ? `Validation: ${validationMatch[1]} passed, ${validationMatch[2]} failed.`
            : undefined,
        });
      }
    }
  }

  private projectRestoredCoreExecution(turn: CoreExecutionTurn): void {
    if (this.projectedCoreExecutionAttempts.has(turn.attemptId)) return;
    this.projectedCoreExecutionAttempts.add(turn.attemptId);
    this.post({
      type: 'coreExecutionRestored',
      attemptId: turn.attemptId,
      conversationId: turn.conversationId,
      mode: turn.mode,
      status: turn.restoredStatus ?? 'running',
    });
    if (turn.restoredInput) {
      this.post({ type: 'workspaceRequestResumed', text: turn.restoredInput, conversationId: turn.conversationId });
    }
  }

  private taskBelongsToWorkspace(task: AutonomousTask): boolean {
    const expected = createDefaultAutonomousTask(this.workspaceRoot, task.goal);
    return path.resolve(task.repositoryRoot) === path.resolve(this.workspaceRoot)
      && task.repositoryId === expected.repositoryId;
  }

  /** attemptId -> Core conversationId that durably owns it (null = unknown/legacy).
   * Immutable once a request exists, so a positive/negative answer is cacheable. */
  private readonly taskCoreConversationCache = new Map<string, string>();

  /**
   * Conversation identity of a Karke Dikha task, from Core's durable chain:
   * task.attemptId -> attempt.requestId -> request.conversationId. A task
   * "belongs" to the visible chat only when that Core conversation is the one
   * bound to the current local conversation. Unknown (Core unreachable, or a
   * legacy request with no conversation) is treated as belonging so an
   * upgrade never strands a pre-existing task; a POSITIVE mismatch is the only
   * thing that detaches it from the current chat surface.
   */
  private async taskBelongsToCurrentConversation(task: AutonomousTask, localConversationId: string = this.conversationId): Promise<boolean> {
    let owner = this.taskCoreConversationCache.get(task.attemptId);
    if (owner === undefined) {
      const client = (this.coreManager ?? getCoreManager())?.getClient();
      if (!client) return true;
      try {
        const attempt = await client.getAttempt(task.attemptId);
        const request = await client.getRequest(attempt.requestId);
        if (!request.conversationId) return true;
        owner = request.conversationId;
        this.taskCoreConversationCache.set(task.attemptId, owner);
      } catch {
        return true;
      }
    }
    let current = this.coreConversationIdFor(localConversationId);
    if (!current) {
      // Not loaded into memory yet (early activation): use the durable ledger.
      const client = (this.coreManager ?? getCoreManager())?.getClient();
      current = client ? await this.durableCurrentCoreConversation(client) : undefined;
      if (!current) return true; // unknown -> never strand a task
    }
    return owner === current;
  }

  private async requireOwnedAutonomousTask(taskId: string): Promise<AutonomousTask | undefined> {
    const task = await this.autonomousQueue?.get(taskId);
    if (task && this.taskBelongsToWorkspace(task)) return task;
    this.postAuthorizationDenied('stale_permission_context', 'This task does not belong to the current workspace.');
    return undefined;
  }

  /** Last state this panel projected for each autonomous task during this session (see the preview offer). */
  private readonly sessionTaskStates = new Map<string, string>();
  /** Per-task operation kinds seen while the proposal was pending (path -> create/modify/delete), for TaskResult change buckets. */
  private readonly taskProposedOperations = new Map<string, Map<string, string>>();
  /** Authoritative TaskResults by task id (derived from the durable task + disk); the only source artifact actions may act on. */
  private readonly taskResults = new Map<string, TaskResult>();

  private projectAutonomousTask(message: Record<string, unknown> & { taskId: string }): void {
    if (this.projectedAutonomousTaskId === message.taskId) return;
    this.projectedAutonomousTaskId = message.taskId;
    this.postApprovalCardMessage({ type: 'autonomousTaskActive', ...message });
  }

  private async getOwnedActiveAutonomousTask(): Promise<AutonomousTask | undefined> {
    if (!this.autonomousQueue) return undefined;
    if (this.autonomousActiveTaskId) {
      const projected = await this.autonomousQueue.get(this.autonomousActiveTaskId);
      if (projected && this.taskBelongsToWorkspace(projected) && !AUTONOMOUS_TERMINAL_STATES.has(projected.state)
        && await this.taskBelongsToCurrentConversation(projected)) {
        return projected;
      }
    }
    const candidates = (await this.autonomousQueue.list())
      .filter(task =>
        this.taskBelongsToWorkspace(task)
        && !AUTONOMOUS_TERMINAL_STATES.has(task.state)
        // Only tasks eligible for restoration/projection may be discovered
        // here; a hidden durable task (e.g. queued) must not capture steering.
        && AUTONOMOUS_AUTO_RESTORE_STATES.has(task.state))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    let active: AutonomousTask | undefined;
    for (const candidate of candidates) {
      // A task owned by another conversation may keep running, but it must not
      // own this chat's steering target or projection.
      if (await this.taskBelongsToCurrentConversation(candidate)) { active = candidate; break; }
    }
    if (active) this.autonomousActiveTaskId = active.taskId;
    return active;
  }

  /**
   * Durable Conversational Continuity V1 — the single composer funnel for
   * Baat/Saath (`sendMessage`) and Karke Dikha (`startAutonomousTask`).
   *
   * Order matters and is load-bearing:
   *  1. workspace restoration (so the durable working state is loaded);
   *  2. active-task steering (unchanged — a live task still wins);
   *  3. repository REVALIDATION before any restored objective is acted on;
   *  4. referential-follow-up resolution, which may ask instead of guessing;
   *  5. the ordinary production submission, with the effective text.
   *
   * Nothing here bypasses an approval gate, a stale-baseline check, or a
   * capability check — this only decides whether the turn is submitted at all
   * and what text it carries.
   */
  private async routeComposerSubmission(
    text: string,
    submitOrdinary: (effectiveText: string) => void | Promise<void>,
    mode: ComposerMode = 'agent',
    conversationId?: string,
    /** Karke Dikha only: how a read-only follow-up about prior work is answered without starting another task. */
    submitConversational?: (effectiveText: string) => void | Promise<void>,
  ): Promise<void> {
    // 1. Explicit reset intent wins unconditionally over continuation inference.
    if (isExplicitResetIntent(text)) {
      await this.resetConversationContinuity();
      this.post({ type: 'done', content: 'Sure — starting fresh.' });
      return;
    }

    // 2. Standalone greeting opener: answer directly without resurfacing stale tasks.
    if (isGreetingIntent(text)) {
      this.post({ type: 'done', content: 'Hi! What can I help you with?' });
      return;
    }

    await this.completeWorkspaceRestoration();
    if (this.workspaceAvailable && await this.tryHandleWorkspaceFileOp(text)) return;
    if (this.workspaceAvailable && await this.tryHandleOpenArtifactRequest(text, conversationId || this.conversationId)) return;
    // Explicit mode wins: only Karke Dikha submissions may steer a live
    // autonomous task. Baat Kar and Saath Kar never silently capture it — the
    // task stays alive and visible in Activity, but this composer routes to
    // its own selected mode regardless.
    if (mode === 'autonomous') {
      const active = await this.getOwnedActiveAutonomousTask();
      if (active) {
        await this.steerTask(active.taskId, text);
        return;
      }
    }

    const prepared = await this.prepareTurnContinuity(text, mode, conversationId);
    if (prepared.clarification) {
      // Ambiguous referent or a moved repository: ask rather than act. The
      // question is delivered as an ordinary assistant turn, so the user
      // simply answers it — no memory-management UI is involved.
      this.post({ type: 'done', content: prepared.clarification });
      return;
    }
    if (prepared.conversational && submitConversational) {
      await submitConversational(prepared.effectiveText);
    } else {
      await submitOrdinary(prepared.effectiveText);
    }
    await this.recordTurnContinuity(prepared.objectiveText ?? text, mode, prepared.boundary, conversationId);
  }

  /**
   * Re-reads the repository files the persisted objective referred to.
   *
   * This is the mechanism behind the milestone's PRINCIPLE: the working state
   * remembers WHICH files mattered and their hash at the time, purely so a
   * resumed conversation can DETECT that the bytes moved. A match is never
   * treated as proof of anything — Core still enforces the write-time
   * stale-baseline check on every mutation.
   */
  private async revalidateConversationRelevantFiles(
    state: ConversationWorkingStateRecord | null,
  ): Promise<RepositoryRevalidation> {
    if (!state || !this.workspaceAvailable || state.relevantFiles.length === 0) return { status: 'unknown' };
    const changedPaths: string[] = [];
    const missingPaths: string[] = [];
    for (const file of state.relevantFiles) {
      const absolute = path.join(this.workspaceRoot, file.path);
      try {
        const bytes = await fs.promises.readFile(absolute);
        if (file.contentHash && crypto.createHash('sha256').update(bytes).digest('hex') !== file.contentHash) {
          changedPaths.push(file.path);
        }
      } catch {
        missingPaths.push(file.path);
      }
    }
    return changedPaths.length || missingPaths.length
      ? { status: 'changed', changedPaths, missingPaths }
      : { status: 'unchanged' };
  }

  /**
   * Records repository-relative paths the system authoritatively used for the
   * turn being submitted. Called by the context builder (files selected into
   * the frozen context) and by the proposal/task paths of a governed edit.
   */
  private noteAuthoritativeTurnFiles(paths: readonly string[]): void {
    for (const candidate of paths) {
      const normalized = String(candidate ?? '').replace(/\\/g, '/').trim();
      // Core rejects absolute or escaping paths; drop them here too so a bad
      // entry can never fail an otherwise good turn's continuity write.
      if (!normalized || normalized.length > 500) continue;
      if (/^([A-Za-z]:|\/)/.test(normalized) || normalized.split('/').includes('..')) continue;
      if (!this.authoritativeTurnFiles.includes(normalized)) this.authoritativeTurnFiles.push(normalized);
    }
  }

  /** SHA-256 of the current bytes of a repository-relative path, or null when
   * it cannot be read (a path the objective merely named, for instance). */
  private async hashRepositoryFile(relativePath: string): Promise<string | null> {
    if (!this.workspaceAvailable) return null;
    try {
      const bytes = await fs.promises.readFile(path.join(this.workspaceRoot, relativePath));
      return crypto.createHash('sha256').update(bytes).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Loads the durable working state for the restored conversation, revalidates
   * the repository behind it, and posts the one lightweight continuity cue.
   * Read-only: it never writes Core state and never mutates the workspace.
   */
  private async restoreConversationContinuity(): Promise<void> {
    const epoch = this.conversationEpoch;
    this.conversationWorkingState = null;
    this.pendingTaskContinuity = null;
    this.pendingTaskCandidate = null;
    this.conversationRevalidation = { status: 'unknown' };
    this.conversationControlState = {
      id: this.conversationId,
      repository: this.workspaceIdentity,
      resumptionState: 'none',
    };
    const client = getCoreManager()?.getClient();
    const coreConversationId = this.coreConversationIdFor(this.conversationId);
    if (!client?.getConversationWorkingState || !coreConversationId) return;
    try {
      // Core returns null for another workspace/profile, so a restored panel
      // can never surface a different project's objective (Step 6 / test G).
      const state = await client.getConversationWorkingState(coreConversationId, this.workspaceIdentity);
      if (epoch !== this.conversationEpoch) return;
      const revalidation = await this.revalidateConversationRelevantFiles(state);
      if (epoch !== this.conversationEpoch) return;
      this.conversationWorkingState = state;
      this.conversationRevalidation = revalidation;
      if (!state || !state.currentObjective) return;
      this.conversationControlState = {
        id: this.conversationId,
        repository: this.workspaceIdentity,
        continuationAnchor: {
          taskId: state.latestTaskId ?? undefined,
          objective: state.currentObjective,
          lastRelevantTurn: state.latestUserIntent,
        },
        resumptionState: 'restored',
      };
      this.postApprovalCardMessage({
        type: 'conversationContinuity',
        cue: continuityCue(state, this.conversationRevalidation) ?? '',
        objective: state.currentObjective,
        previousMode: AgentPanel.modeForPolicy(state.latestExecutionPolicy),
        repositoryChanged: this.conversationRevalidation.status === 'changed',
        resumptionState: 'restored',
      });
    } catch (error) {
      // Continuity is an assist, never a gate: a Core that cannot serve it
      // must still leave the conversation fully usable.
      Logger.warn('[AgentPanel] Conversation working state unavailable:', error);
    }
  }

  /**
   * Explicit fresh-chat / reset: clears continuation anchor and durable working state
   * for this conversation without deleting durable task history or cancelling running tasks.
   */
  private async resetConversationContinuity(): Promise<void> {
    this.conversationWorkingState = null;
    this.pendingTaskContinuity = null;
    this.pendingTaskCandidate = null;
    this.conversationRevalidation = { status: 'unknown' };
    this.conversationControlState = {
      id: this.conversationId,
      repository: this.workspaceIdentity,
      resumptionState: 'reset',
      continuationAnchor: undefined,
    };
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    const candidateLocalIds = [this.conversationId, this.lastConversationId].filter(Boolean) as string[];
    const targetCoreIds = new Set<string>();
    for (const localId of candidateLocalIds) {
      const coreId = this.coreConversationIdFor(localId);
      if (coreId) targetCoreIds.add(coreId);
    }
    if (client?.clearConversationWorkingState) {
      for (const coreId of targetCoreIds) {
        try {
          await client.clearConversationWorkingState(coreId, this.workspaceIdentity);
        } catch (error) {
          Logger.warn('[AgentPanel] Could not clear Core conversation working state:', error);
        }
      }
    }
    this.postApprovalCardMessage({
      type: 'conversationContinuity',
      cue: '',
      objective: '',
      previousMode: null,
      repositoryChanged: false,
      resumptionState: 'reset',
      reset: true,
    });
  }

  /** Maps a persisted execution policy back to the webview mode the Auto
   * recommender speaks. Mirrors ExecutionPolicyRouter's three policies. */
  private static modeForPolicy(policy: ConversationExecutionPolicy | null): ComposerMode | null {
    if (policy === 'READ_ONLY') return 'chat';
    if (policy === 'COLLABORATIVE_EDIT') return 'agent';
    if (policy === 'AUTONOMOUS_EXECUTION') return 'autonomous';
    return null;
  }

  private static policyForMode(mode: ComposerMode): ConversationExecutionPolicy {
    if (mode === 'chat') return 'READ_ONLY';
    if (mode === 'autonomous') return 'AUTONOMOUS_EXECUTION';
    return 'COLLABORATIVE_EDIT';
  }

  /**
   * Decides, for one submitted turn, whether the stored objective still
   * applies, whether the turn can proceed at all, and what text executes.
   */
  private async prepareTurnContinuity(
    text: string,
    mode: ComposerMode,
    conversationId?: string,
  ): Promise<{ effectiveText: string; boundary: ObjectiveBoundary; clarification?: string; conversational?: boolean; objectiveText?: string }> {
    const localConversationId = conversationId || this.conversationId;
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    const coreConversationId = this.resolveCoreConversationId(localConversationId);
    let state = this.conversationWorkingState;
    if (!state && client?.getConversationWorkingState && coreConversationId) {
      try {
        state = await client.getConversationWorkingState(coreConversationId, this.workspaceIdentity);
        if (state) {
          this.conversationWorkingState = state;
        }
      } catch {
        // ignore
      }
    }
    // Recent artifact referent: "this html", "that file", "it", "the page" resolve to what this conversation just produced
    // (authoritative TaskResult artifacts), before any retrieval or objective-boundary inference. A unique artifact binds; a
    // genuinely ambiguous one is asked about once.
    this.turnArtifactReferent = null;
    let artifactBound: RecentArtifact | undefined;
    if (this.workspaceAvailable) {
      this.recentArtifacts.prune(localConversationId, relativePath => {
        const absolute = resolveUnderRoot(this.workspaceRoot, relativePath);
        return absolute !== undefined && fs.existsSync(absolute);
      });
      const referent = this.recentArtifacts.resolve(localConversationId, text);
      if (referent.status === 'ambiguous') {
        if (!this.artifactClarificationAsked.has(localConversationId)) {
          this.artifactClarificationAsked.add(localConversationId);
          return { effectiveText: text, boundary: 'ambiguous', clarification: ambiguousReferentQuestion(referent.candidates) };
        }
        this.artifactClarificationAsked.delete(localConversationId);
      } else if (referent.status === 'bound') {
        artifactBound = referent.artifact;
        this.artifactClarificationAsked.delete(localConversationId);
        this.turnArtifactReferent = { conversationId: localConversationId, text, artifact: referent.artifact, phrase: referent.phrase };
      }
    }
    // A new-objective confirmation is pending: the user's PREVIOUS turn chose
    // "New Task" (in reply to the ambiguity prompt below) but has not yet
    // typed the new objective. That confirmation is control state, not
    // conversation content, so it was never persisted as `currentObjective`
    // — this turn is the first substantive message since, and it must
    // become the new objective directly, bypassing continuation-vs-new
    // classification entirely (root-cause fix: the classifier is what
    // previously misread the confirmation itself, and then the stale
    // objective, as ambiguous).
    //
    // classifyControlAcknowledgement()'s vocabulary ("yes", "continue",
    // "retry", "new task") is a small CLOSED set, but every word in it is
    // also plain English that can occur as ordinary chat content. It may
    // therefore only be read as a control reply — and force objective
    // routing — while KKD is actually awaiting one: either the durable
    // pendingNewObjective flag (awaiting the new objective's text after a
    // confirmed "New Task"), or the durable awaitingObjectiveClarification
    // flag (awaiting an answer to the "Should I treat it as a new task?"
    // ambiguity prompt below). Outside those two windows a bare "yes" or
    // "continue" falls straight through to the ordinary classifier below,
    // exactly like any other message.
    let boundary: ObjectiveBoundary;
    let bareUnpromptedAffirmation = false;
    if (state?.pendingNewObjective) {
      if (classifyControlAcknowledgement(text)) {
        // Another bare control reply while still pending ("yes" again, or a
        // second "new task") — stay pending and ask again rather than let a
        // control acknowledgement become the objective text.
        return { effectiveText: text, boundary: 'ambiguous', clarification: "Got it — what's the new task?" };
      }
      boundary = 'new_objective';
    } else {
      const awaitingClarification = state?.awaitingObjectiveClarification === true;
      const controlAck = awaitingClarification ? classifyControlAcknowledgement(text) : null;

      const candidate = this.pendingTaskCandidate?.conversationId === localConversationId ? this.pendingTaskCandidate : null;
      if (candidate && awaitingClarification && controlAck && controlAck !== 'retry') {
        // Bind the confirmation to the candidate the question was about. "continue/resume/keep going" answers the
        // question with "no, the old one" and re-runs the candidate under the active objective; every other
        // affirmative ("yes", "new task", "go ahead", "that's right") makes the candidate the new objective.
        this.pendingTaskCandidate = null;
        const keepsOld = controlAck === 'confirm_continue' && /^(?:yes|yep|yeah|sure|ok(?:ay)?)?[,.!]?\s*(?:continue|resume|keep\s+going|carry\s+on)/i.test(text.trim());
        let candidateObjective = candidate.text;
        if (mode === 'autonomous' || mode === 'agent') {
          let preceding: string | null = state?.latestFindingsSummary ?? null;
          if (client?.listMessages && coreConversationId) {
            try {
              const { messages } = await client.listMessages(coreConversationId);
              preceding = [...messages].reverse().find(m => m.role === 'assistant' && m.content !== candidate.text)?.content ?? preceding;
            } catch {
              // fall back to the findings summary
            }
          }
          const resolvedCandidate = mode === 'autonomous'
            ? compileAutonomousObjective({ text: candidate.text, state, precedingAssistantMessage: preceding ?? undefined })
            : { status: 'compiled' as const, objective: resolveProposalAnaphor(candidate.text, preceding) ?? candidate.text };
          if (resolvedCandidate.status === 'needs_clarification') {
            return { effectiveText: candidate.text, boundary: 'ambiguous', clarification: resolvedCandidate.message };
          }
          candidateObjective = resolvedCandidate.objective;
        }
        return { effectiveText: candidateObjective, objectiveText: candidate.text, boundary: keepsOld ? 'same_objective' : 'new_objective' };
      }

      if (controlAck === 'confirm_new') {
        // The confirmation reply must never be classified as, or persisted
        // as, the objective. Mark the durable flag (so this survives a
        // restart before the real objective arrives) and ask for it — no
        // boundary classification, no working-state write of this text.
        await this.markPendingNewObjective(state, localConversationId);
        return { effectiveText: text, boundary: 'ambiguous', clarification: "Got it! What's the new task?" };
      }

      if ((controlAck === 'confirm_continue' || controlAck === 'affirmation' || controlAck === 'retry') && state?.currentObjective) {
        // A bare control acknowledgement continuing the active objective
        // carries no content of its own: it must not run through the
        // objective-boundary classifier (which could misclassify it) or
        // become `currentObjective`. Force continuation of the existing one.
        // This turn proceeds to `recordTurnContinuity` below (boundary is
        // not 'ambiguous'), which unconditionally clears the awaiting flag —
        // this exchange is resolved either way.
        boundary = 'same_objective';
      } else if (!awaitingClarification && state?.currentObjective && classifyControlAcknowledgement(text) === 'affirmation') {
        // A bare "yes" with no control question outstanding is not approval to
        // continue the active objective: ask, never silently resume or submit.
        boundary = 'ambiguous';
        bareUnpromptedAffirmation = true;
      } else if (artifactBound) {
        // A request about the file this conversation just produced continues that work; it is not "a new task?".
        boundary = 'same_objective';
      } else {
        boundary = detectObjectiveBoundary(text, state);
        if (boundary === 'ambiguous' && client?.listMessages && coreConversationId) {
          // The stored objective label alone cannot tell "Which file would I open
          // first and why?" continues "What does this workspace contain?". Judge
          // it against the exchange that just happened (durable Core messages, so
          // this holds across a restart too) before asking the user.
          try {
            const { messages } = await client.listMessages(coreConversationId);
            const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
            const lastUser = [...messages].reverse().find(m => m.role === 'user');
            boundary = detectObjectiveBoundary(text, state, {
              previousAssistantText: lastAssistant?.content ?? null,
              previousUserText: lastUser?.content ?? null,
            });
          } catch {
            // no durable context available: keep the conservative decision
          }
        }
      }
    }

    // Asking "is this a new task?" protects against continuing a MUTATION under the wrong objective. A read-only
    // turn inside a read-only conversation (advisory / inspection, nothing active that could be mutated) gains
    // nothing from that interruption, and the history is sent either way, so it simply continues
    // (Golden A4: "Show me the relevant files."). A read-only question that arrives while a build/edit objective
    // is active still asks: that is a change of subject, not a follow-up.
    // A read-only question after work has already been performed (even a mutating build, or a task that completed
    // or blocked) is an ordinary follow-up about that work, in any mode. Mutations and new objectives still arbitrate.
    const readOnlyFollowUp = !bareUnpromptedAffirmation && isReadOnlyFollowUpOnPriorWork(text, state);
    if (
      boundary === 'ambiguous' && !bareUnpromptedAffirmation
      && (
        readOnlyFollowUp
        || (
          mode !== 'autonomous'
          && decideExecutionPolicy(text).policy === 'READ_ONLY'
          && (!state?.currentObjective || decideExecutionPolicy(state.currentObjective).policy === 'READ_ONLY')
        )
      )
    ) {
      boundary = 'same_objective';
    }
    // Karke Dikha being the selected mode must not turn a read-only follow-up into another autonomous task.
    if (mode === 'autonomous' && boundary === 'same_objective' && readOnlyFollowUp) {
      return { effectiveText: text, boundary, conversational: true };
    }

    if (boundary === 'ambiguous') {
      // The next reply may be a bare control acknowledgement ("Continue" /
      // "Yes new task") answering exactly this question — mark the durable
      // flag so that reply is honored, and only that reply.
      await this.markAwaitingObjectiveClarification(state, localConversationId);
      if (!bareUnpromptedAffirmation) this.pendingTaskCandidate = { conversationId: localConversationId, text };
      return {
        effectiveText: text,
        boundary,
        clarification: `I'm not sure whether that continues what we were doing (${state?.currentObjective ?? 'the previous task'})`
          + ' or starts something new. Should I treat it as a new task?',
      };
    }

    if (boundary === 'same_objective' && !artifactBound && isReferentialFollowUp(text)) {
      // Only a referential follow-up depends on the persisted narrative to
      // find its referent, so only it needs the repository re-checked first.
      this.conversationRevalidation = await this.revalidateConversationRelevantFiles(state);
      const resolution = resolveFollowUp({ text, state, revalidation: this.conversationRevalidation });
      if (resolution.status === 'needs_clarification') {
        return { effectiveText: text, boundary, clarification: resolution.message };
      }
    }

    // Karke Dikha autonomous execution handoff:
    // When mode is autonomous, compile a self-contained execution objective from the
    // active conversation context. This resolves conversational referents (such as
    // "those two cases", "that bug", "the second option", "what you just suggested", "those files"),
    // applies precedence (latest explicit instruction > earlier conflicting temporary constraint > inferred context),
    // and preserves non-conflicting constraints.
    if (mode === 'autonomous') {
      let precedingAssistantMessage: string | undefined = state?.latestFindingsSummary ?? undefined;
      if (client?.listMessages && coreConversationId) {
        try {
          const { messages } = await client.listMessages(coreConversationId);
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant?.content) {
            precedingAssistantMessage = lastAssistant.content;
          }
        } catch {
          // fallback to state.latestFindingsSummary
        }
      }

      const compiled = compileAutonomousObjective({
        text,
        state,
        precedingAssistantMessage,
      });

      if (compiled.status === 'needs_clarification') {
        return { effectiveText: text, boundary, clarification: compiled.message };
      }

      return { effectiveText: artifactBound ? `${compiled.objective}\n\nTarget file (resolved from the previous task's result): ${artifactBound.path}` : compiled.objective, boundary };
    }

    if (boundary === 'same_objective' && mode === 'agent' && hasProposalAnaphor(text)) {
      let preceding: string | null = state?.latestFindingsSummary ?? null;
      if (client?.listMessages && coreConversationId) {
        try {
          const { messages } = await client.listMessages(coreConversationId);
          preceding = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? preceding;
        } catch {
          // fall back to the findings summary
        }
      }
      const resolved = resolveProposalAnaphor(text, preceding);
      if (resolved) return { effectiveText: resolved, objectiveText: text, boundary };
    }

    return { effectiveText: text, boundary };
  }

  /**
   * Persists the bounded working state for the turn just submitted. Runs
   * AFTER submission so the durable Core conversation is guaranteed to exist.
   * A failure here is logged and dropped: continuity must never be able to
   * fail a turn the user already sent.
   */
  private async recordTurnContinuity(
    text: string,
    mode: ComposerMode,
    boundary: ObjectiveBoundary,
    conversationId?: string,
  ): Promise<void> {
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    const localConversationId = conversationId || this.conversationId;
    const coreConversationId = this.resolveCoreConversationId(localConversationId);
    if (!client?.saveConversationWorkingState || !coreConversationId) return;
    const startNewObjective = boundary !== 'same_objective';
    // A new objective inherits nothing: obsolete constraints, findings and
    // file references from the previous objective must not follow the user
    // into unrelated work (milestone Step 5 / test H).
    let previous = startNewObjective ? null : this.conversationWorkingState;
    if (!previous && !startNewObjective && client.getConversationWorkingState) {
      try {
        previous = await client.getConversationWorkingState(coreConversationId, this.workspaceIdentity);
      } catch {
        // ignore
      }
    }
    const now = new Date().toISOString();
    const { constraints } = reconcileConstraints(text, previous?.userConstraints ?? [], now);

    // Authoritative only: the files this turn's repository context actually
    // selected, merged with what the objective already knew about. A path the
    // user merely typed is never added here, and a file whose bytes cannot be
    // read is dropped rather than stored with a null hash it could never be
    // revalidated against.
    const mergedPaths = [...new Set([
      ...(previous?.relevantFiles ?? []).map(file => file.path),
      ...this.authoritativeTurnFiles,
    ])].slice(0, 24);
    const hashed = await Promise.all(mergedPaths.map(async relativePath => ({
      path: relativePath,
      contentHash: await this.hashRepositoryFile(relativePath),
      observedAt: now,
    })));
    const relevantFiles = hashed.filter((file): file is { path: string; contentHash: string; observedAt: string } =>
      typeof file.contentHash === 'string');
    const relevantSymbols = [...new Set([...(previous?.relevantSymbols ?? []), ...extractReferencedSymbols(text)])].slice(0, 24);

    try {
      this.conversationWorkingState = await client.saveConversationWorkingState(coreConversationId, {
        workspaceIdentity: this.workspaceIdentity,
        startNewObjective,
        // The objective label is set when the objective STARTS and then holds
        // until a new objective begins. A follow-up describes the next step,
        // not the problem: letting "Fix it, but don't change the tests." become
        // the objective loses the actual subject and degrades the resumed cue
        // to "Continuing: Fix it…" — found live in installed acceptance run 3.
        currentObjective: !startNewObjective && previous?.currentObjective
          ? previous.currentObjective
          : summarizeObjective(text),
        latestUserIntent: text.slice(0, 600),
        latestExecutionPolicy: AgentPanel.policyForMode(mode),
        relevantFiles,
        relevantSymbols,
        userConstraints: constraints,
        latestFindingsSummary: this.conversationWorkingState?.latestFindingsSummary ?? previous?.latestFindingsSummary ?? null,
        pendingAction: previous?.pendingAction ?? null,
        latestTaskId: previous?.latestTaskId ?? null,
        latestProposalId: previous?.latestProposalId ?? null,
        latestValidationSummary: previous?.latestValidationSummary ?? null,
        // An ordinary turn write is exactly the "new objective successfully
        // accepted" moment: clear the pending-confirmation flag here rather
        // than leaving it to a future write, so it can never outlive the
        // objective it was guarding.
        pendingNewObjective: false,
        // Same reasoning: an ordinary turn write means whatever control
        // question was pending (if any) is resolved — the reply either
        // matched it (handled above, before this function is even reached)
        // or the turn moved on. Either way, stale "awaiting" state must not
        // survive into the next turn.
        awaitingObjectiveClarification: false,
      });
      this.conversationRevalidation = { status: 'unchanged' };
    } catch (error) {
      Logger.warn('[AgentPanel] Conversation working state could not be persisted:', error);
    } finally {
      this.authoritativeTurnFiles = [];
    }
    if (this.pendingTaskContinuity && this.conversationWorkingState) {
      const pending = this.pendingTaskContinuity;
      this.pendingTaskContinuity = null;
      await this.recordTaskContinuity(pending);
    }
  }

  /**
   * Records the autonomous turn's POINTERS into the existing durable systems —
   * which task it is, which gate (if any) is still waiting, and a one-line
   * validation result. It deliberately copies no task state: the M15
   * `DurableTaskQueue` and Core's `approvals` remain the authorities that
   * restore the actual actionable card after a restart. These pointers exist
   * only so a resumed conversation can SAY what is outstanding.
   */
  private async recordTaskContinuity(update: {
    latestTaskId?: string | null;
    latestProposalId?: string | null;
    pendingAction?: { kind: 'awaiting_approval' | 'awaiting_validation' | 'awaiting_user_decision' | 'resume_work'; description: string } | null;
    latestValidationSummary?: string | null;
    proposalPaths?: readonly string[];
  }): Promise<void> {
    const client = getCoreManager()?.getClient();
    const coreConversationId = this.coreConversationIdFor(this.conversationId);
    const state = this.conversationWorkingState;
    if (!client?.saveConversationWorkingState || !coreConversationId) return;
    if (!state) {
      this.pendingTaskContinuity = { ...(this.pendingTaskContinuity ?? {}), ...update };
      return;
    }
    let relevantFiles = state.relevantFiles;
    if (update.proposalPaths?.length) {
      const known = new Set(state.relevantFiles.map(file => file.path));
      const additions: typeof state.relevantFiles = [];
      const now = new Date().toISOString();
      for (const candidate of update.proposalPaths) {
        const normalized = String(candidate).replace(/\\/g, '/').trim();
        if (!normalized || known.has(normalized)) continue;
        if (/^([A-Za-z]:|\/)/.test(normalized) || normalized.split('/').includes('..')) continue;
        const contentHash = await this.hashRepositoryFile(normalized);
        if (!contentHash) continue;
        known.add(normalized);
        additions.push({ path: normalized, contentHash, observedAt: now });
      }
      if (additions.length) relevantFiles = [...state.relevantFiles, ...additions].slice(0, 24);
    }
    try {
      this.conversationWorkingState = await client.saveConversationWorkingState(coreConversationId, {
        workspaceIdentity: this.workspaceIdentity,
        startNewObjective: false,
        currentObjective: state.currentObjective,
        latestUserIntent: state.latestUserIntent,
        latestExecutionPolicy: state.latestExecutionPolicy,
        relevantFiles,
        relevantSymbols: state.relevantSymbols,
        userConstraints: state.userConstraints,
        latestFindingsSummary: state.latestFindingsSummary,
        pendingAction: update.pendingAction === undefined ? state.pendingAction : update.pendingAction,
        latestTaskId: update.latestTaskId === undefined ? state.latestTaskId : update.latestTaskId,
        latestProposalId: update.latestProposalId === undefined ? state.latestProposalId : update.latestProposalId,
        latestValidationSummary: update.latestValidationSummary === undefined
          ? state.latestValidationSummary
          : update.latestValidationSummary,
        // Pointer-only write: preserve whatever the flag currently is rather
        // than defaulting it away, in case a task pointer is recorded while
        // the user still hasn't typed the new objective they confirmed.
        pendingNewObjective: state.pendingNewObjective,
        awaitingObjectiveClarification: state.awaitingObjectiveClarification,
      });
    } catch (error) {
      Logger.warn('[AgentPanel] Task continuity pointers could not be persisted:', error);
    }
  }

  /**
   * Marks the durable pending-new-objective flag: the user just confirmed
   * "New Task" but hasn't typed it yet. Kept alongside every other
   * objective-scoped field on the working state so it survives a restart
   * (milestone requirement: coherent across a restart between confirmation
   * and the new objective text).
   */
  private async markPendingNewObjective(
    state: ConversationWorkingStateRecord | null,
    conversationId?: string,
  ): Promise<void> {
    if (!state) return;
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    const localConversationId = conversationId || this.conversationId;
    const coreConversationId = this.resolveCoreConversationId(localConversationId);
    if (!client?.saveConversationWorkingState || !coreConversationId) return;
    try {
      this.conversationWorkingState = await client.saveConversationWorkingState(coreConversationId, {
        workspaceIdentity: this.workspaceIdentity,
        startNewObjective: false,
        currentObjective: state.currentObjective,
        latestUserIntent: state.latestUserIntent,
        latestExecutionPolicy: state.latestExecutionPolicy,
        relevantFiles: state.relevantFiles,
        relevantSymbols: state.relevantSymbols,
        userConstraints: state.userConstraints,
        latestFindingsSummary: state.latestFindingsSummary,
        pendingAction: state.pendingAction,
        latestTaskId: state.latestTaskId,
        latestProposalId: state.latestProposalId,
        latestValidationSummary: state.latestValidationSummary,
        pendingNewObjective: true,
        // The confirmation this write is recording IS the answer to the
        // pending clarification question — that exchange is now resolved,
        // and the next control-worded reply belongs to the *new* prompt
        // above ("Got it! What's the new task?"), not this one.
        awaitingObjectiveClarification: false,
      });
    } catch (error) {
      Logger.warn('[AgentPanel] Could not persist pending new objective flag:', error);
    }
  }

  /**
   * Marks the durable awaiting-clarification flag: KKD just asked the user
   * the objective-boundary ambiguity question ("Should I treat it as a new
   * task?") and a bare control reply to the NEXT message must be honored as
   * an answer to it, not read as ordinary chat content. Cleared as soon as
   * that reply is consumed (or any ordinary turn intervenes).
   */
  private async markAwaitingObjectiveClarification(
    state: ConversationWorkingStateRecord | null,
    conversationId?: string,
  ): Promise<void> {
    if (!state) return;
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    const localConversationId = conversationId || this.conversationId;
    const coreConversationId = this.resolveCoreConversationId(localConversationId);
    if (!client?.saveConversationWorkingState || !coreConversationId) return;
    try {
      this.conversationWorkingState = await client.saveConversationWorkingState(coreConversationId, {
        workspaceIdentity: this.workspaceIdentity,
        startNewObjective: false,
        currentObjective: state.currentObjective,
        latestUserIntent: state.latestUserIntent,
        latestExecutionPolicy: state.latestExecutionPolicy,
        relevantFiles: state.relevantFiles,
        relevantSymbols: state.relevantSymbols,
        userConstraints: state.userConstraints,
        latestFindingsSummary: state.latestFindingsSummary,
        pendingAction: state.pendingAction,
        latestTaskId: state.latestTaskId,
        latestProposalId: state.latestProposalId,
        latestValidationSummary: state.latestValidationSummary,
        pendingNewObjective: state.pendingNewObjective,
        awaitingObjectiveClarification: true,
      });
    } catch (error) {
      Logger.warn('[AgentPanel] Could not persist awaiting-clarification flag:', error);
    }
  }

  /**
   * Records what the completed turn found, so a later "what did you find?" or
   * "continue" has something concrete to resume from. Bounded to a short
   * summary — never the full answer, and never chain-of-thought.
   */
  private async recordTurnFindings(
    summary: string,
    coreConversationIdOverride?: string,
    localConversationIdOverride?: string,
  ): Promise<void> {
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    const localId = localConversationIdOverride || this.conversationId;
    const coreConversationId = coreConversationIdOverride || this.resolveCoreConversationId(localId);
    let state = this.conversationWorkingState;
    if (!client?.saveConversationWorkingState || !coreConversationId) return;
    if (!state && client.getConversationWorkingState) {
      try {
        state = await client.getConversationWorkingState(coreConversationId, this.workspaceIdentity);
      } catch {
        // ignore
      }
    }
    if (!state) return;
    const bounded = summary.trim().slice(0, 2000);
    if (!bounded) return;
    try {
      this.conversationWorkingState = await client.saveConversationWorkingState(coreConversationId, {
        workspaceIdentity: this.workspaceIdentity,
        startNewObjective: false,
        currentObjective: state.currentObjective,
        latestUserIntent: state.latestUserIntent,
        latestExecutionPolicy: state.latestExecutionPolicy,
        relevantFiles: state.relevantFiles,
        relevantSymbols: state.relevantSymbols,
        userConstraints: state.userConstraints,
        latestFindingsSummary: bounded,
        pendingAction: state.pendingAction,
        latestTaskId: state.latestTaskId,
        latestProposalId: state.latestProposalId,
        latestValidationSummary: state.latestValidationSummary,
        pendingNewObjective: state.pendingNewObjective,
        awaitingObjectiveClarification: state.awaitingObjectiveClarification,
      });
    } catch (error) {
      Logger.warn('[AgentPanel] Findings summary could not be persisted:', error);
    }
  }

  private async routeExplicitSteering(taskId: string, message: string, messageId?: string): Promise<void> {
    await this.completeWorkspaceRestoration();
    const active = await this.getOwnedActiveAutonomousTask();
    if (!active || active.taskId !== taskId) {
      this.postAuthorizationDenied('stale_permission_context', 'Steering is not owned by an active task in this workspace.');
      return;
    }
    await this.steerTask(taskId, message, messageId);
  }

  private gitStatus(cwd: string): Promise<{ clean: boolean; changedFileCount: number } | undefined> {
    return new Promise(resolve => {
      try {
        // Read-only polling of a live task worktree: never take index.lock, or it races the task's own git commits.
        const child = spawn('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd, shell: false, windowsHide: true });
        let output = '';
        const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 5_000);
        child.stdout.on('data', data => { output += String(data); });
        child.on('error', () => { clearTimeout(timer); resolve(undefined); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return resolve(undefined);
          const changedFileCount = output
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.includes('.ollama-agent')).length;
          resolve({ clean: changedFileCount === 0, changedFileCount });
        });
      } catch {
        resolve(undefined);
      }
    });
  }

  /**
   * Self-heals proposal/mutation/delivery approval cards that were surfaced to
   * some webview session but never told they were resolved — e.g. the task
   * moved past that phase while the panel was closed, reloaded, or on a
   * different poll cycle than the one that actually recorded the decision.
   * Runs on every poll. `task.state` (not merely the presence/absence of
   * `pendingProposal`/`pendingMutationApproval`) is the authoritative signal:
   * a card is only ever treated as still-active when `task.state` equals the
   * exact `waiting_for_*_approval` state that gate corresponds to. This means
   * a stale `pending*` field left over on an older persisted record (from
   * before this reconciliation existed, or from any other bug that failed to
   * clear it) can never resurrect a card as interactive once the task's
   * authoritative state has moved on — the state check alone is sufficient to
   * mark it resolved, defensively, even if the field itself is still present.
   */
  /**
   * Restores resolved proposal/mutation approval cards into a fresh webview
   * session (host close/relaunch, reload) from the durable per-task event
   * log alone — the same `proposal_pending`/`proposal_<decision>` and
   * `mutation_pending`/`mutation_approved|mutation_denied` events
   * `pollAutonomousTask` already reads for `resolvedGates`. This session's
   * in-memory `surfacedProposalCards`/`surfacedMutationCards` start empty on
   * every new AgentPanel instance, so without this, a gate resolved before
   * this session began would never be (re-)posted to the webview and its
   * card would stay hidden — while a still-pending later gate (e.g.
   * delivery) is posted normally. Runs every poll but is idempotent: once a
   * card key has been surfaced this session, it is a no-op. Reads only
   * already-recorded Core/task history; never grants or re-opens a gate.
   */
  private rehydrateResolvedApprovalCards(task: AutonomousTask, allEvents: AutonomousTaskEvent[]): void {
    const proposalPendingEvent = [...allEvents].reverse().find(event => event.type === 'proposal_pending');
    const proposalResolution = proposalPendingEvent
      ? allEvents.find(event =>
          event.seq > proposalPendingEvent.seq
          && (event.type === 'proposal_approved' || event.type === 'proposal_rejected' || event.type === 'proposal_revise'),
        )
      : undefined;
    if (proposalPendingEvent && proposalResolution) {
      const proposalId = String(proposalPendingEvent.payload.proposalId ?? '');
      const key = `${task.taskId}:${proposalId}`;
      if (proposalId && !this.surfacedProposalCards.has(key)) {
        this.surfacedProposalCards.add(key);
        this.resolvedProposalCards.add(key);
        this.postApprovalCardMessage({
          type: 'proposalApprovalRequest',
          taskId: task.taskId,
          attemptId: task.attemptId,
          proposalId,
          version: proposalPendingEvent.payload.version,
          taskSummary: proposalPendingEvent.payload.taskSummary,
          operations: proposalPendingEvent.payload.operations ?? [],
          validationCommands: proposalPendingEvent.payload.validationCommands ?? [],
          warnings: proposalPendingEvent.payload.warnings ?? [],
        });
        const decision = proposalResolution.type === 'proposal_approved'
          ? 'approved'
          : proposalResolution.type === 'proposal_rejected' ? 'rejected' : 'revision_requested';
        this.postApprovalCardMessage({ type: 'proposalApprovalResolved', taskId: task.taskId, proposalId, decision });
      }
    }

    const mutationPendingEvent = [...allEvents].reverse().find(event => event.type === 'mutation_pending');
    const mutationResolution = mutationPendingEvent
      ? allEvents.find(event =>
          event.seq > mutationPendingEvent.seq
          && (event.type === 'mutation_approved' || event.type === 'mutation_denied'),
        )
      : undefined;
    if (mutationPendingEvent && mutationResolution) {
      const requestId = String(mutationPendingEvent.payload.requestId ?? '');
      const key = `${task.taskId}:${requestId}`;
      if (requestId && !this.surfacedMutationCards.has(key)) {
        this.surfacedMutationCards.add(key);
        this.resolvedMutationCards.add(key);
        this.postApprovalCardMessage({
          type: 'mutationApprovalRequest',
          taskId: task.taskId,
          attemptId: task.attemptId,
          requestId,
          proposalId: mutationPendingEvent.payload.proposalId,
          operationCount: mutationPendingEvent.payload.operationCount,
          targets: mutationPendingEvent.payload.targets ?? [],
          elevatedConfirmationRequired: mutationPendingEvent.payload.elevatedConfirmationRequired,
          repairPolicy: mutationPendingEvent.payload.repairPolicy,
        });
        const decision = mutationResolution.type === 'mutation_approved' ? 'approved' : 'denied';
        this.postApprovalCardMessage({ type: 'mutationApprovalResolved', taskId: task.taskId, requestId, decision });
      }
    }
  }

  /** True only when `state` is itself proof that gate `gateRank` has been
   * superseded: a terminal state, or a *named* later gate state strictly
   * ahead of it. A transient non-gate value (running/queued/validating/...)
   * is not proof of anything — it must never override the pending-record
   * field either way. */
  private isGateDefinitelySupersededByState(state: AutonomousTask['state'], gateRank: number): boolean {
    if (AUTONOMOUS_TERMINAL_STATES.has(state)) return true;
    const rank = GATE_STATE_RANK[state];
    return rank !== undefined && rank > gateRank;
  }

  private reconcileStaleApprovalCards(task: AutonomousTask): void {
    // A gate is considered genuinely no-longer-current — and its surfaced
    // card resolved — when EITHER its pending-record field has cleared (the
    // ordinary case: it was actually resolved) OR task.state has moved to a
    // named later gate/terminal state (proof that a leftover pending field
    // from an older bug, or a superseded attempt, is stale garbage; see
    // "even if pendingProposal is still present" below). Neither signal
    // alone is sufficient: state equality alone treated a transient
    // non-gate value (e.g. `running`) reported for a poll or two while the
    // record is still genuinely outstanding as a resolution, posting a
    // spurious `*ApprovalResolved` that permanently stranded the card
    // disabled client-side (the client only ever resurfaces a gate from an
    // explicit request message, which this session guards against
    // resending). Pending-field-only would wrongly keep an old stale
    // pending field alive once state has genuinely, unambiguously moved on.
    //
    // A THIRD signal must also be respected, in the opposite direction: an
    // absent pending-record field is only trustworthy proof of resolution
    // when task.state is not itself currently claiming to be exactly this
    // gate's own waiting state. `task.state` and the `pending*` record are
    // written/read as two separate fields on the same eventually-consistent
    // projection, so a read can race the other way too — state already
    // says `waiting_for_mutation_approval` (this gate is unambiguously the
    // one currently active) while the `pendingMutationApproval` field
    // itself is transiently unset on that same read. Treating that as
    // "resolved" produced a spurious `mutationApprovalResolved` for a gate
    // nothing had actually resolved, permanently disabling the freshly
    // surfaced (and still visible) card — the exact
    // "M35 mutation approval card to become actionable" packaged-acceptance
    // timeout this guard exists to prevent. So: while task.state equals a
    // gate's own named waiting state, that state IS proof the gate remains
    // current, and an absent pending field alone must never override it.
    const proposalSuperseded = this.isGateDefinitelySupersededByState(task.state, GATE_STATE_RANK.waiting_for_proposal_approval)
      || (!task.pendingProposal && task.state !== 'waiting_for_proposal_approval');
    // `currentProposalKey` is derived from the pending record alone (never
    // gated by `proposalSuperseded`) so a still-present pending record is
    // always recognized as "the current key" regardless of how staleness was
    // computed.
    const currentProposalKey = task.pendingProposal ? `${task.taskId}:${task.pendingProposal.proposalId}` : undefined;
    for (const key of this.surfacedProposalCards) {
      if (!key.startsWith(`${task.taskId}:`) || this.resolvedProposalCards.has(key)) continue;
      // A surfaced key that differs from a PRESENT current pending key has
      // been superseded by a newer proposal (e.g. a revision) — that is
      // unconditional, definite proof on its own and must resolve even
      // while the gate overall is still active (`proposalSuperseded` may be
      // false). Everything else — the key matching the live pending record
      // (including the legacy case where state has moved past this gate but
      // the pending field itself was never cleared), or no pending record
      // being present at all — defers to `proposalSuperseded`: only THAT
      // signal may resolve it, never a same-key match nor a bare absent-field
      // read on their own (the latter is exactly the race `proposalSuperseded`
      // itself already guards against — see the block comment above).
      const supersededByNewerPending = currentProposalKey !== undefined && key !== currentProposalKey;
      if (!supersededByNewerPending && !proposalSuperseded) continue;
      this.resolvedProposalCards.add(key);
      this.postApprovalCardMessage({ type: 'proposalApprovalResolved', taskId: task.taskId, proposalId: key.slice(task.taskId.length + 1), decision: 'resolved' });
    }
    const mutationSuperseded = this.isGateDefinitelySupersededByState(task.state, GATE_STATE_RANK.waiting_for_mutation_approval)
      || (!task.pendingMutationApproval && task.state !== 'waiting_for_mutation_approval');
    // See `currentProposalKey`/the loop above for the rationale mirrored here.
    const currentMutationKey = task.pendingMutationApproval ? `${task.taskId}:${task.pendingMutationApproval.requestId}` : undefined;
    for (const key of this.surfacedMutationCards) {
      if (!key.startsWith(`${task.taskId}:`) || this.resolvedMutationCards.has(key)) continue;
      const supersededByNewerPending = currentMutationKey !== undefined && key !== currentMutationKey;
      if (!supersededByNewerPending && !mutationSuperseded) continue;
      this.resolvedMutationCards.add(key);
      this.postApprovalCardMessage({ type: 'mutationApprovalResolved', taskId: task.taskId, requestId: key.slice(task.taskId.length + 1), decision: 'resolved' });
    }
    const deliveryActive = task.state === 'waiting_for_delivery_approval';
    if (this.surfacedDeliveryCards.has(task.taskId) && !deliveryActive && !this.resolvedDeliveryCards.has(task.taskId)) {
      this.resolvedDeliveryCards.add(task.taskId);
      this.postApprovalCardMessage({ type: 'deliveryApprovalResolved', taskId: task.taskId, decision: 'resolved' });
    }
  }

  private async surfaceDeliveryApproval(task: AutonomousTask): Promise<void> {
    if (!this.taskBelongsToWorkspace(task)) return;
    // Task-Scoped Autonomy V1 — see the matching guard in
    // surfaceProposalApproval. Also suppresses the native
    // showInformationMessage fallback below, which must not interrupt a
    // hands-off run either.
    if ((task.autonomyMode ?? 'supervised') === 'hands_off') return;
    if (!this.surfacedDeliveryCards.has(task.taskId)) {
      this.surfacedDeliveryCards.add(task.taskId);
      this.postApprovalCardMessage({ type: 'deliveryApprovalRequest', gate: 'delivery', taskId: task.taskId, attemptId: task.attemptId });
    }
    if ((this.view?.visible && this.autonomousModeVisible) || this.notifiedDeliveryGates.has(task.taskId)) return;
    this.notifiedDeliveryGates.add(task.taskId);
    // Native fallback interaction is intentionally detached from the
    // serialized durable-state publication chain. VS Code keeps
    // showInformationMessage pending until the user chooses or dismisses it;
    // awaiting that promise here used to wedge every later poll (including
    // the terminal transition) behind an unanswered notification even when
    // the user approved through the inline webview card.
    void Promise.resolve(vscode.window.showInformationMessage(
      'KarkeDikha finished and verified the changes — your approval is needed to deliver them.',
      'Review', 'Approve', 'Reject',
    )).then(async action => {
      const current = await this.autonomousQueue?.get(task.taskId);
      if (current?.state !== 'waiting_for_delivery_approval') return;
      if (action === 'Review') await this.openAutonomousWorktree(task.taskId);
      if (action === 'Approve') await this.approveAutonomousDelivery(task.taskId);
      if (action === 'Reject') await this.rejectAutonomousDelivery(task.taskId);
    }).catch(error => Logger.warn('[AgentPanel] Delivery approval notification failed:', error));
  }

  private async approveAutonomousDelivery(taskId: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.approveDelivery(taskId);
      this.resolvedDeliveryCards.add(taskId);
      this.postApprovalCardMessage({ type: 'deliveryApprovalResolved', taskId, decision: 'approved' });
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      if (isGitAuthorIdentityUnavailableError(error)) {
        // Delivery is paused on a Git prerequisite, not resolved: keep the
        // delivery card open and offer a retry once the user has configured Git.
        await this.pollAutonomousTask(taskId);
        void vscode.window.showWarningMessage(`KarkeDikha: ${error.message}`, 'Retry Delivery').then(async action => {
          if (action === 'Retry Delivery') await this.approveAutonomousDelivery(taskId);
        }, () => undefined);
        return;
      }
      // Mirrors approveProposal/approveMutation: a click that loses the race
      // with the backend (the gate already resolved, or the task moved on)
      // must reconcile the card as stale, never surface the backend's
      // internal guard error as a normal user-facing failure banner.
      this.resolvedDeliveryCards.add(taskId);
      this.postApprovalCardMessage({ type: 'deliveryApprovalResolved', taskId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
      await this.pollAutonomousTask(taskId);
    }
  }

  private async rejectAutonomousDelivery(taskId: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.rejectDelivery(taskId);
      this.resolvedDeliveryCards.add(taskId);
      this.postApprovalCardMessage({ type: 'deliveryApprovalResolved', taskId, decision: 'rejected' });
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      this.resolvedDeliveryCards.add(taskId);
      this.postApprovalCardMessage({ type: 'deliveryApprovalResolved', taskId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
      await this.pollAutonomousTask(taskId);
    }
  }

  private async surfaceProposalApproval(task: AutonomousTask): Promise<void> {
    if (!this.taskBelongsToWorkspace(task)) return;
    // Task-Scoped Autonomy V1 — a hands-off task's own runtime auto-resolves
    // this gate; no routine approval card is ever shown for it (STEP 8:
    // "Do NOT flash approval cards for a gate that policy already
    // resolved"). This guard is a second, independent layer over the
    // runtime never firing proposalApprovalListener for a hands-off task —
    // it also covers this same function being reached via the poll loop
    // (pollAutonomousTaskUnserialized), which reads task.state directly.
    if ((task.autonomyMode ?? 'supervised') === 'hands_off') return;
    const proposal = task.pendingProposal;
    if (!proposal) return;
    const key = `${task.taskId}:${proposal.proposalId}`;
    if (!this.surfacedProposalCards.has(key)) {
      this.surfacedProposalCards.add(key);
      this.postApprovalCardMessage({
        type: 'proposalApprovalRequest',
        taskId: task.taskId,
        attemptId: task.attemptId,
        proposalId: proposal.proposalId,
        version: proposal.version,
        taskSummary: proposal.taskSummary,
        operations: proposal.operations,
        validationCommands: proposal.validationCommands,
        warnings: proposal.warnings,
      });
    }
  }

  private async surfaceMutationApproval(task: AutonomousTask): Promise<void> {
    if (!this.taskBelongsToWorkspace(task)) return;
    // Task-Scoped Autonomy V1 — see the matching guard in
    // surfaceProposalApproval.
    if ((task.autonomyMode ?? 'supervised') === 'hands_off') return;
    const mutation = task.pendingMutationApproval;
    if (!mutation) return;
    const key = `${task.taskId}:${mutation.requestId}`;
    if (!this.surfacedMutationCards.has(key)) {
      this.surfacedMutationCards.add(key);
      this.postApprovalCardMessage({
        type: 'mutationApprovalRequest',
        taskId: task.taskId,
        attemptId: task.attemptId,
        requestId: mutation.requestId,
        proposalId: mutation.proposalId,
        operationCount: mutation.operationCount,
        targets: mutation.targets,
        elevatedConfirmationRequired: mutation.elevatedConfirmationRequired,
        repairPolicy: mutation.repairPolicy,
      });
    }
  }

  private async approveProposal(taskId: string, proposalId: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.approveProposal(taskId, proposalId);
      this.resolvedProposalCards.add(`${taskId}:${proposalId}`);
      this.post({ type: 'proposalApprovalResolved', taskId, proposalId, decision: 'approved' });
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      this.post({ type: 'proposalApprovalResolved', taskId, proposalId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async rejectProposal(taskId: string, proposalId: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.rejectProposal(taskId, proposalId);
      this.resolvedProposalCards.add(`${taskId}:${proposalId}`);
      this.post({ type: 'proposalApprovalResolved', taskId, proposalId, decision: 'rejected' });
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      this.post({ type: 'proposalApprovalResolved', taskId, proposalId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async requestProposalRevision(taskId: string, proposalId: string, instructions: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.requestProposalRevision(taskId, proposalId, instructions);
      this.resolvedProposalCards.add(`${taskId}:${proposalId}`);
      this.post({ type: 'proposalApprovalResolved', taskId, proposalId, decision: 'revision_requested' });
      // A revision request rejects the current proposal card in Core terms — a
      // fresh proposal (and fresh Core approval) will supersede it once produced.
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      this.post({ type: 'proposalApprovalResolved', taskId, proposalId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async approveMutation(taskId: string, requestId: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.approveMutation(taskId, requestId);
      this.resolvedMutationCards.add(`${taskId}:${requestId}`);
      this.post({ type: 'mutationApprovalResolved', taskId, requestId, decision: 'approved' });
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      this.post({ type: 'mutationApprovalResolved', taskId, requestId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async denyMutation(taskId: string, requestId: string): Promise<void> {
    try {
      if (!await this.requireOwnedAutonomousTask(taskId)) return;
      await this.autonomousRuntime?.denyMutation(taskId, requestId);
      this.resolvedMutationCards.add(`${taskId}:${requestId}`);
      this.post({ type: 'mutationApprovalResolved', taskId, requestId, decision: 'denied' });
      await this.pollAutonomousTask(taskId);
    } catch (error) {
      this.post({ type: 'mutationApprovalResolved', taskId, requestId, decision: 'stale', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolves the worktree path from the trusted durable task record only —
   * never accepts a filesystem path directly from the webview. */
  private async openAutonomousWorktree(taskId: string): Promise<void> {
    const task = await this.autonomousQueue?.get(taskId);
    if (!task || !this.taskBelongsToWorkspace(task) || !task.worktreeLocation) {
      this.post({ type: 'error', message: 'No isolated worktree is bound for this task yet.' });
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(task.worktreeLocation));
  }

  /** Bounded, redacted diagnostics summary — never the raw task.json, prompt, or
   * file contents. */
  private async copyAutonomousDiagnostics(taskId: string): Promise<void> {
    const task = await this.autonomousQueue?.get(taskId);
    if (!task || !this.taskBelongsToWorkspace(task)) {
      this.post({ type: 'error', message: 'Task record not found.' });
      return;
    }
    const summary = this.buildAutonomousDiagnosticsSummary(task);
    await vscode.env.clipboard.writeText(summary);
    this.post({ type: 'autonomousDiagnosticsCopied' });
  }

  private buildAutonomousDiagnosticsSummary(task: AutonomousTask): string {
    const reviewerRouting = task.stageRouting?.['reviewer'];
    const lines = [
      `Task: ${task.taskId}`,
      `State: ${task.state}`,
      `Origin: ${task.origin}`,
      `Attempt: ${task.attempt}/${task.maxRetries}`,
      `Task branch: ${task.branchName ?? '(not created)'}`,
      `Destination branch: ${task.destinationBranch || 'working branch'}`,
      `Timestamps: UI progress times are local; diagnostic timestamps below are UTC.`,
      `Provider/Model: ${task.providerModelRoutingSnapshot['provider'] ?? 'unknown'}/${task.providerModelRoutingSnapshot['model'] ?? 'unknown'}`,
      `Latest progress: ${task.latestProgress ?? '(none)'}`,
      `Restart-restored: ${task.failure?.classification === 'recovery_required' ? 'yes (interrupted state blocked on activation, requires explicit resume)' : 'no'}`,
      `Failure: ${task.failure ? `${task.failure.classification}: ${task.failure.message}` : '(none)'}`,
      `Quality gate: ${task.qualityGate ? `${task.qualityGate.status} (${task.qualityGate.findingsCount} finding(s))` : '(not evaluated)'}`,
      `Diff review: ${task.diffReview
        ? `${task.diffReview.verdict} (reviewer ${task.diffReview.reviewerProvider}/${task.diffReview.reviewerModel}${task.diffReview.reviewerProvider === 'host' ? ', deterministic' : ', model'})`
        : '(not run)'}`,
      `Reviewer stage routing: ${reviewerRouting
        ? `${reviewerRouting.provider}/${reviewerRouting.model} — ${reviewerRouting.routingReason}${reviewerRouting.fallbackReason ? ` (fallback: ${reviewerRouting.fallbackReason})` : ''}`
        : '(not recorded)'}`,
    ];
    if (task.diffReview?.changedFileFindings.length) {
      lines.push(`Diff review changed-file findings: ${task.diffReview.changedFileFindings.join('; ')}`);
    }
    if (task.diffReview?.validationFindings.length) {
      lines.push(`Diff review validation findings: ${task.diffReview.validationFindings.join('; ')}`);
    }
    if (task.diffReview?.securityFindings.length) {
      lines.push(`Diff review security findings: ${task.diffReview.securityFindings.join('; ')}`);
    }
    return lines.join('\n');
  }

  private initRepositoryWatcher(): void {
    if (!this.workspaceAvailable || this.repositoryWatcher) { return; }
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function') { return; }
    const RelativePatternCtor = (vscode as typeof vscode & {
      RelativePattern?: new (base: string, pattern: string) => vscode.RelativePattern;
    }).RelativePattern;
    const pattern = RelativePatternCtor
      ? new RelativePatternCtor(this.workspaceRoot, '**/*')
      : ({ base: this.workspaceRoot, pattern: '**/*' } as vscode.GlobPattern);
    this.repositoryWatcher = vscode.workspace.createFileSystemWatcher(
      pattern,
      false,
      false,
      false,
    );
    this.context.subscriptions.push(this.repositoryWatcher);
    const record = (uri: vscode.Uri) => this.queueRepositoryChange(uri.fsPath);
    this.repositoryWatcher.onDidCreate(record, undefined, this.context.subscriptions);
    this.repositoryWatcher.onDidChange(record, undefined, this.context.subscriptions);
    this.repositoryWatcher.onDidDelete(record, undefined, this.context.subscriptions);
  }

  private queueRepositoryChange(absolutePath: string): void {
    if (!absolutePath.startsWith(this.workspaceRoot)) { return; }
    const relative = absolutePath.slice(this.workspaceRoot.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
    if (!relative || relative.startsWith('.ollama-agent/')) { return; }
    this.pendingRepositoryChanges.add(relative);
    if (this.repositoryWatcherTimer) { clearTimeout(this.repositoryWatcherTimer); }
    this.repositoryWatcherTimer = setTimeout(() => {
      const changed = [...this.pendingRepositoryChanges];
      this.pendingRepositoryChanges.clear();
      void this.repositoryContext.updateChangedFiles(changed)
        .then(status => this.post({ type: 'repositoryIntelligenceStatus', status }))
        .catch(error => Logger.warn('[AgentPanel] Repository watcher update failed:', error));
    }, 500);
  }

  private initRuntime(): void {
    this.runtime = new AgentRuntime(this.workspaceRoot, this.context.secrets);
    // M38: without this, governed_research/github_read_issue/github_comment_on_issue
    // fail closed rather than falling back to local execution (ToolExecutor).
    this.runtime.setCoreClient(getCoreManager()?.getClient());
    this.runtime.setApprovalRequestCallback((req) => {
      this.post({
        type: 'approvalRequest',
        id: req.id,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason,
        riskLevel: req.riskLevel,
      });
    });
  }

  private async handleWebviewMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') {
      this.postAuthorizationDenied('invalid_permission_context', 'Malformed webview message.');
      return;
    }
    const message = msg as { type: string; [key: string]: unknown };
    switch (message.type) {
      case 'getModels':
        void this.loadModels();
        break;
      case 'webviewReady':
        this.autonomousModeVisible = message['mode'] === 'autonomous';
        this.webviewReady = true;
        this.post({ type: 'newConversation', id: this.conversationId });
        this.postOperatorContext();
        for (const projection of this.dhaagaRuns.values()) {
          if (projection.snapshot().active) this.post({ type: 'dhaaga', op: 'snapshot', state: projection.snapshot() });
        }
        void this.completeWorkspaceRestoration()
          .then(() => this.flushPendingApprovalCardMessages())
          .catch(error => {
            Logger.error('[AgentPanel] Workspace conversation restoration failed closed:', error);
            this.post({
              type: 'error',
              message: 'Conversation restoration could not be verified. Sending remains disabled to protect this workspace.',
            });
          });
        break;
      case 'webviewModeChanged':
        this.autonomousModeVisible = message['mode'] === 'autonomous';
        if (this.autonomousModeVisible) void this.reconnectAutonomousTask();
        break;
      case 'getOperationsSnapshot':
        void this.postOperationsSnapshot();
        break;
      case 'getRepositoryIntelligenceStatus':
        void this.postRepositoryIntelligenceStatus();
        break;
      case 'rebuildRepositoryIntelligence':
        void this.rebuildRepositoryIntelligence();
        break;
      case 'pauseRepositoryIntelligence':
        this.repositoryContext.pause();
        void this.postRepositoryIntelligenceStatus();
        break;
      case 'resumeRepositoryIntelligence':
        this.repositoryContext.resume();
        void this.postRepositoryIntelligenceStatus();
        break;
      case 'listLocalModels':
        void this.listLocalModels(
          String(message['text'] ?? ''),
          String(message['conversationId'] ?? this.conversationId),
        );
        break;
      case 'sendMessage':
        await this.submitComposerMessage({
          text: String(message['text'] ?? ''),
          mode: (message['mode'] as AgentMode) ?? 'agent',
          attachmentIds: Array.isArray(message['attachmentIds']) ? (message['attachmentIds'] as string[]) : [],
          conversationId: optionalString(message['conversationId']) || this.conversationId,
          model: String(message['model'] ?? '') || undefined,
          stayInBaatKar: message['stayInBaatKar'] === true,
        });
        break;
      case 'dhaagaResync': {
        const projection = this.dhaagaRuns.get(String(message['runId'] ?? ''));
        if (projection) this.post({ type: 'dhaaga', op: 'snapshot', state: projection.snapshot() });
        break;
      }
      case 'confirmModeChange':
        await this.resolveModeChange(optionalString(message['conversationId']) || this.conversationId, 'continue');
        break;
      case 'declineModeChange':
        await this.resolveModeChange(optionalString(message['conversationId']) || this.conversationId, 'stay');
        break;
      case 'researchApprovalResponse': {
        const researchId = String(message['researchId'] ?? '');
        const approvalId = String(message['approvalId'] ?? '');
        const requestedActionDigest = String(message['requestedActionDigest'] ?? '');
        const resolution = message['resolution'] === 'approved' ? 'approved' : 'rejected';
        if (!researchId || !approvalId || !requestedActionDigest) {
          this.post({ type: 'error', message: 'Research approval was incomplete. No network request was made.' });
          break;
        }
        void this.resolveGovernedResearch(researchId, approvalId, requestedActionDigest, resolution);
        break;
      }
      case 'selectPermissionProfile': {
        const profileId = validatePermissionSelectionPayload(message);
        if (!profileId) {
          this.postAuthorizationDenied('invalid_permission_context', 'Unknown or malformed permission profile selection.');
          break;
        }
        if (this.activePermissionRunId || this.runtime?.isRunning()) {
          this.postAuthorizationDenied('stale_permission_context', 'Permission profile cannot be changed during an active run.');
          break;
        }
        this.selectedPermissionContext = createPermissionContext(profileId, 'webview-selection');
        this.postPermissionState();
        break;
      }
      case 'stopGeneration':
        void this.stopActiveCoreExecution();
        break;
      case 'newConversation':
        await this.newConversation();
        break;
      case 'dismissContinuityNotice':
        this.conversationControlState.resumptionState = 'dismissed';
        break;
      case 'selectConversation':
        await this.selectConversation(String(message['id'] ?? this.conversationId));
        break;
      case 'deleteConversation':
        void this.deleteConversation(String(message['id'] ?? this.conversationId));
        break;
      case 'searchWorkbench':
        void this.searchWorkbench(String(message['query'] ?? ''));
        break;
      case 'openWorkbenchSearchResult':
        void this.openWorkbenchConversation(String(message['conversationId'] ?? ''));
        break;
      case 'branchFromMessage':
        void this.branchFromMessage(String(message['messageId'] ?? ''));
        break;
      case 'regenerateMessage':
        void this.regenerateMessage(String(message['messageId'] ?? ''));
        break;
      case 'selectResponseAlternative':
        void this.selectResponseAlternative(String(message['alternativeId'] ?? ''));
        break;
      case 'exportConversation':
        void this.exportConversation(String(message['format'] ?? 'markdown') === 'json' ? 'json' : 'markdown');
        break;
      case 'pickAttachment':
        void this.pickAttachment(String(message['conversationId'] ?? this.conversationId));
        break;
      case 'attachUris':
        void this.attachUris(message['uris'], String(message['conversationId'] ?? this.conversationId));
        break;
      case 'attachDropped':
        void this.attachDroppedFiles(message['files'], String(message['conversationId'] ?? this.conversationId));
        break;
      case 'openWorkspace':
        void this.openWorkspaceFolder();
        break;
      case 'createWorkspace':
        void this.createWorkspaceFolder();
        break;
      case 'createLocalStory':
        void this.createLocalStory(message);
        break;
      case 'taskResultAction':
        void this.handleTaskResultAction(message);
        break;
      case 'openSetupReadiness':
        void vscode.commands.executeCommand('ollama-agent.showSetupReadiness');
        break;
      case 'openLocalBoard':
        void vscode.commands.executeCommand('ollama-agent.showLocalBoard');
        break;
      case 'openExternalSource': {
        try {
          const url = new URL(String(message['url'] ?? ''));
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme');
          void vscode.env.openExternal(vscode.Uri.parse(url.toString()));
        } catch { this.post({ type: 'error', message: 'That source link is not safe to open.' }); }
        break;
      }
      case 'approvalResponse': {
        const approvalId = String(message['id'] ?? '');
        const approvalResp = (message['response'] as 'approved' | 'rejected') ?? 'rejected';
        if (!approvalId) {
          this.post({ type: 'error', message: 'Approval response had no id — please try again.' });
          break;
        }
        if (!this.runtime) {
          this.post({ type: 'error', message: 'Agent runtime not ready.' });
          break;
        }
        void this.runtime.respondToApproval(approvalId, approvalResp).then(
          () => this.postOperationsSnapshot(),
          error => {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
          },
        );
        break;
      }
      case 'capabilityApprovalRestoredResponse': {
        const approvalId = String(message['approvalId'] ?? '');
        const attemptId = String(message['attemptId'] ?? '');
        const toolName = String(message['toolName'] ?? '');
        const args = (message['arguments'] as Record<string, unknown>) ?? {};
        const expectedAttemptRevision = Number(message['expectedAttemptRevision'] ?? NaN);
        const expectedAttemptStatus = message['expectedAttemptStatus'] as AttemptStatus;
        const requestedActionDigest = String(message['requestedActionDigest'] ?? '');
        const frozenContextHash = String(message['frozenContextHash'] ?? '');
        const resolution = message['resolution'] === 'approved' ? 'approved' : 'rejected';
        if (!approvalId || !attemptId || !toolName || !requestedActionDigest || !frozenContextHash || Number.isNaN(expectedAttemptRevision)) {
          this.post({ type: 'error', message: 'Restored capability approval was incomplete. No action was taken.' });
          break;
        }
        void this.resolveRestoredCapabilityApproval({
          approvalId,
          attemptId,
          toolName,
          arguments: args,
          expectedAttemptRevision,
          expectedAttemptStatus,
          requestedActionDigest,
          frozenContextHash,
          resolution,
        });
        break;
      }
      case 'resumeTask': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) { void this.resumeTask(taskId); }
        break;
      }
      case 'pauseTask': {
        const taskId = String(message['taskId'] ?? this.runtime?.getTaskId() ?? '');
        if (taskId) { void this.pauseTask(taskId); }
        break;
      }
      case 'cancelTask': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) { void this.cancelPersistedTask(taskId); }
        break;
      }
      case 'steerTask': {
        const taskId = String(message['taskId'] ?? this.runtime?.getTaskId() ?? '');
        const steeringMessage = String(message['message'] ?? '');
        const messageId = optionalString(message['messageId']);
        if (taskId && steeringMessage.trim()) { void this.routeExplicitSteering(taskId, steeringMessage, messageId); }
        break;
      }
      case 'getTaskSnapshot': {
        const taskId = String(message['taskId'] ?? this.runtime?.getTaskId() ?? '');
        if (taskId) { void this.postTaskSnapshot(taskId); }
        break;
      }
      case 'retryTask': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) { void this.retryTask(taskId); }
        break;
      }
      case 'archiveOldTasks':
        void this.archiveOldTasks();
        break;
      case 'getArchivedTasksSnapshot':
        void this.postArchivedTasksSnapshot();
        break;
      case 'getAutonomousComposerContext':
        void this.postAutonomousComposerContext();
        break;
      case 'startAutonomousTask': {
        const text = message['text'];
        if (typeof text !== 'string' || !text.trim()) {
          this.post({ type: 'autonomousTaskRejected', utf8ByteCount: 0, limitBytes: 0, reason: 'empty' });
          break;
        }
        // Bumped synchronously here (before routeComposerSubmission's first
        // await) so a reconnectAutonomousTask() already in flight from an
        // earlier webviewModeChanged message can detect this fresh submission
        // and refuse to clobber it with a restored stale task once its own
        // disk read resolves. See the field comment on karkeDikhaSubmissionEpoch.
        this.systemOneShadow.observe({ text, deterministicMode: 'autonomous', conversationId: optionalString(message['conversationId']) || this.conversationId });
        this.karkeDikhaSubmissionEpoch += 1;
        // Covers the full routeComposerSubmission window, including its
        // pre-startAutonomousTask preamble (workspace restoration, active-task
        // steering check, continuity prep) — not just startAutonomousTask's
        // own body. Balanced via .finally() below regardless of which
        // internal path routeComposerSubmission takes (steer into an existing
        // task, ask a clarifying question, or actually call
        // startAutonomousTask), so a steer-instead-of-create outcome — which
        // never reaches startAutonomousTask's own increment/decrement — still
        // decrements this exactly once.
        this.karkeDikhaPendingSubmissionCount += 1;
        // Task-Scoped Autonomy V1 — fail-closed at the message boundary too:
        // only the exact literal 'hands_off' is accepted from the webview;
        // anything else (missing, malformed, an old cached webview build)
        // becomes undefined here and defaults to 'supervised' inside
        // startAutonomousTask.
        const requestedAutonomyMode: KarkeAutonomyMode | undefined = message['autonomyMode'] === 'hands_off' ? 'hands_off' : undefined;
        const incomingConversationId = optionalString(message['conversationId']) || this.conversationId;
        this.conversationId = incomingConversationId;
        this.activeConversationId = incomingConversationId;
        await this.routeComposerSubmission(
          text,
          effectiveText => this.startAutonomousTask(
            effectiveText,
            optionalString(message['model']),
            optionalString(message['submissionId']),
            requestedAutonomyMode,
          ),
          'autonomous',
          incomingConversationId,
          effectiveText => this.handleUserMessage(
            effectiveText,
            'chat',
            [],
            incomingConversationId,
            optionalString(message['model']),
          ),
        ).finally(() => {
          this.karkeDikhaPendingSubmissionCount = Math.max(0, this.karkeDikhaPendingSubmissionCount - 1);
        });
        break;
      }
      case 'retryBlockedAttempt': {
        const attemptId = String(message['attemptId'] ?? '');
        const strategy = String(message['strategy'] ?? 'same_model') as 'same_model' | 'stronger_model' | 'with_guidance';
        const guidance = optionalString(message['guidance']);
        if (attemptId) void this.retryBlockedAttempt(attemptId, strategy, guidance);
        break;
      }
      case 'openAutonomousWorktree': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) void this.openAutonomousWorktree(taskId);
        break;
      }
      case 'reviewAutonomousChanges': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) void this.openAutonomousWorktree(taskId);
        break;
      }
      case 'approveAutonomousDelivery': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) void this.approveAutonomousDelivery(taskId);
        break;
      }
      case 'rejectAutonomousDelivery': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) void this.rejectAutonomousDelivery(taskId);
        break;
      }
      case 'copyAutonomousDiagnostics': {
        const taskId = String(message['taskId'] ?? '');
        if (taskId) void this.copyAutonomousDiagnostics(taskId);
        break;
      }
      case 'approveProposal': {
        const taskId = optionalString(message['taskId']);
        const proposalId = optionalString(message['proposalId']);
        if (taskId && proposalId) void this.approveProposal(taskId, proposalId);
        else this.postAuthorizationDenied('invalid_permission_context', 'Malformed approveProposal message.');
        break;
      }
      case 'rejectProposal': {
        const taskId = optionalString(message['taskId']);
        const proposalId = optionalString(message['proposalId']);
        if (taskId && proposalId) void this.rejectProposal(taskId, proposalId);
        else this.postAuthorizationDenied('invalid_permission_context', 'Malformed rejectProposal message.');
        break;
      }
      case 'requestProposalRevision': {
        const taskId = optionalString(message['taskId']);
        const proposalId = optionalString(message['proposalId']);
        const instructions = optionalString(message['instructions']);
        if (taskId && proposalId && instructions && instructions.trim()) {
          void this.requestProposalRevision(taskId, proposalId, instructions);
        } else {
          this.postAuthorizationDenied('invalid_permission_context', 'Malformed or empty requestProposalRevision message.');
        }
        break;
      }
      case 'approveMutation': {
        const taskId = optionalString(message['taskId']);
        const requestId = optionalString(message['requestId']);
        if (taskId && requestId) void this.approveMutation(taskId, requestId);
        else this.postAuthorizationDenied('invalid_permission_context', 'Malformed approveMutation message.');
        break;
      }
      case 'denyMutation': {
        const taskId = optionalString(message['taskId']);
        const requestId = optionalString(message['requestId']);
        if (taskId && requestId) void this.denyMutation(taskId, requestId);
        else this.postAuthorizationDenied('invalid_permission_context', 'Malformed denyMutation message.');
        break;
      }
      case 'getEverydayHistory':
        void this.postEverydayHistory();
        break;
      case 'getEverydayHistoryDetail': {
        const attemptId = optionalString(message['attemptId']);
        if (attemptId) void this.postEverydayHistoryDetail(attemptId);
        break;
      }
      case 'everydayModeDecision': {
        // Diagnostic-only record of the unified-composer routing decision:
        // recommended mode, selected mode, override flag, and the short
        // deterministic reason. Never influences submission — the webview has
        // already chosen exactly one existing submission path.
        Logger.info(
          `[M33] mode decision — recommended=${optionalString(message['recommendedMode']) ?? 'unknown'}`
          + ` selected=${optionalString(message['selectedMode']) ?? 'unknown'}`
          + ` overridden=${message['overridden'] === true}`
          + ` reason=${optionalString(message['reason']) ?? '(none)'}`,
        );
        break;
      }
      case 'copyAutonomousPromptDraft': {
        const text = message['text'];
        if (typeof text === 'string') void vscode.env.clipboard.writeText(text);
        break;
      }
    }
  }

  private postPermissionState(): void {
    this.post({
      type: 'permissionContextState',
      profiles: serializeProfilesForWebview(),
      selected: this.selectedPermissionContext,
      activeRunId: this.activePermissionRunId,
    });
  }

  private postAuthorizationDenied(
    code: 'invalid_permission_context' | 'stale_permission_context',
    detail: string,
  ): void {
    const denial = {
      code,
      message: detail,
      profileId: this.selectedPermissionContext.profileId,
    };
    this.post({ type: 'authorizationDenied', denial, message: formatPermissionDenial(denial) });
  }

  private async listLocalModels(text: string, conversationId: string): Promise<void> {
    const targetConversationId = conversationId || this.conversationId;
    this.conversationId = targetConversationId;

    if (text.trim()) {
      if (!this.conversations.has(targetConversationId)) {
        this.createConversation(targetConversationId, text);
      } else {
        this.updateConversation(targetConversationId, text);
      }
    }

    const toolName = 'ollama.listModels';
    this.post({ type: 'toolStart', toolName, args: {} });

    try {
      if (Config.getProviderType() !== 'ollama') {
        throw new Error('The active provider is not Ollama. Select the Ollama provider to inspect locally installed models.');
      }

      const provider = await ProviderGateway.create(this.context.secrets);
      const models = (await provider.listModels())
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
      const names = models.map(model => model.name);

      this.post({
        type: 'toolResult',
        toolName,
        ok: true,
        result: { count: names.length, models: names },
      });

      const content = names.length === 0
        ? 'No Ollama models are installed.'
        : `Installed Ollama models (${names.length}):\n${names.map(name => `- ${name}`).join('\n')}`;

      this.post({ type: 'assistantContent', content });
      this.post({ type: 'done' });
    } catch (error) {
      const message = `Could not list Ollama models: ${error instanceof Error ? error.message : String(error)}`;
      this.post({ type: 'toolResult', toolName, ok: false, error: message });
      this.post({ type: 'error', message });
    }
  }

  private async loadModels(): Promise<void> {
    console.log('[OllamaAgent] loadModels: requesting model list');
    try {
      const provider = await ProviderGateway.create(this.context.secrets);
      const cloudModels = await this.cloudPickerModels();
      let models: ModelInfo[];
      try {
        models = await provider.listModels();
      } catch (error) {
        // A reachable cloud provider keeps manual cloud selection usable while the local provider is down.
        if (cloudModels.length === 0) throw error;
        Logger.warn(`[OllamaAgent] loadModels: local provider unavailable; offering cloud models only (${error instanceof Error ? error.message : String(error)})`);
        models = [];
      }
      const configuredModel = Config.getModel();
      console.log(`[OllamaAgent] loadModels: received ${models.length} model(s)`);

      let selectedModel = configuredModel;
      let selectedModelAvailable = models.some(model => model.name === configuredModel);
      let autoSelected = false;
      let noUsableModels = false;

      // Always run discovery-based candidate building here (not only when
      // `model` itself is unset): other roles (agentModel, editModel, ...)
      // may still be Auto even when this one is explicit, and
      // ResolvedModelDefaults (see Config.ts) needs a fresh per-role result
      // each time so every synchronous Config.getXModel() caller across the
      // codebase keeps getting a real installed model, not a stale or empty one.
      try {
        const providerType = Config.getProviderType();
        const availableNames = models.map(item => item.name);
        const candidates = await buildProductionTaskModelCandidates({
          provider,
          providerType,
          availableModelNames: availableNames,
          availableModels: models,
        });
        const autoDefaults = resolveAutoRoleDefaults(candidates);
        for (const [role, model] of Object.entries(autoDefaults)) {
          ResolvedModelDefaults.set(role as 'chat' | 'agent' | 'edit' | 'reviewer', model);
        }
        if (!configuredModel) {
          // "Auto" (nothing explicitly configured): report the discovered
          // model instead of an unconfigured setting as a specific
          // unavailable model.
          if (autoDefaults.chat) {
            selectedModel = autoDefaults.chat;
            selectedModelAvailable = true;
            autoSelected = true;
          } else {
            // No installed model can serve chat at all — a genuinely unready
            // state, not a specific-model-unavailable one.
            selectedModel = '';
            selectedModelAvailable = false;
            noUsableModels = true;
          }
        }
      } catch (discoveryError) {
        console.warn('[OllamaAgent] loadModels: Auto discovery failed', discoveryError);
        if (!configuredModel) {
          selectedModel = '';
          selectedModelAvailable = false;
          noUsableModels = true;
        }
      }

      this.post({
        type: 'modelsLoaded',
        models: [
          ...models.map((model) => ({ name: model.name, modifiedAt: model.modifiedAt })),
          ...cloudModels,
        ],
        selectedModel,
        selectedModelAvailable,
        autoSelected,
        noUsableModels,
        provider: Config.getProviderType(),
      });
    } catch (error) {
      const message = `Failed to load models: ${error instanceof Error ? error.message : String(error)}`;
      console.error('[OllamaAgent] loadModels error:', message);
      this.post({ type: 'error', message });
    }
  }

  /**
   * Every connected cloud provider's live inventory as picker entries. The value is `<provider>::<exact id>` so the
   * choice carries its provider all the way to dispatch. Labels and badges derive from the model descriptor: UNKNOWN
   * is never presented as FREE. Never throws: a failing provider is surfaced once and only its models are left out.
   */
  private async cloudPickerModels(): Promise<Array<{
    name: string; label: string; provider: string; cloud: true; providerName: string; displayName: string; modelId: string;
    badges: string[]; freeness: string; vision: boolean | 'unknown'; tools: boolean | 'unknown'; coding: boolean | 'unknown'; contextWindow?: number;
  }>> {
    const service = cloudProviderServiceFor(this.context.secrets);
    const { models, failures } = await service.poolModels();
    for (const failure of failures) {
      if (failure.kind === 'not_configured') continue;
      Logger.warn(`[OllamaAgent] ${failure.provider} models unavailable: ${failure.reason}`);
      if (this.lastCloudWarnings.get(failure.provider) !== failure.reason) {
        this.lastCloudWarnings.set(failure.provider, failure.reason);
        void vscode.window.showWarningMessage(`${failure.reason} Its models are hidden until this is fixed (KarkeDikha Setup > Compute).`);
      }
    }
    for (const id of [...this.lastCloudWarnings.keys()]) if (!failures.some(f => f.provider === id)) this.lastCloudWarnings.delete(id);
    return models
      .map(model => ({
        name: encodeCloudModel(model.provider, model.modelId),
        label: `${model.modelId} — ${model.providerName} (cloud)`,
        provider: model.provider,
        cloud: true as const,
        providerName: model.providerName,
        displayName: model.displayName,
        modelId: model.modelId,
        badges: modelBadges(model),
        freeness: model.freeness,
        vision: model.vision,
        tools: model.tools,
        coding: model.coding,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      }))
      .sort((left, right) => left.providerName.localeCompare(right.providerName) || left.displayName.localeCompare(right.displayName));
  }

  private readonly lastCloudWarnings = new Map<string, string>();

  private async hydrateWebview(): Promise<void> {
    if (this.webviewHydrated) return;
    this.webviewHydrated = true;
    const hydration = [this.loadModels()];
    if (this.workspaceAvailable) hydration.push(this.reconcileRepositoryIntelligence());
    await Promise.all(hydration);
    this.post({
      type: 'workspaceState',
      available: this.workspaceAvailable,
      name: this.workspaceAvailable ? path.basename(this.workspaceRoot) : undefined,
    });
    this.postPermissionState();
    if (this.workspaceAvailable) {
      await this.reconnectAutonomousTask();
      await this.resumePendingWorkspaceRequest();
    }
  }

  private async loadPersistedConversations(): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) return;
    try {
      const epoch = this.conversationEpoch;
      const snapshot = await client.getWorkspaceConversationLedger(this.workspaceIdentity);
      if (this.conversationEpoch !== epoch) return; // a stale ledger read must not overwrite the new conversation's state
      this.applyConversationLedger(snapshot);
      const items = snapshot.conversations.slice(0, 50).map(conversation => ({
        id: conversation.localConversationId,
        title: conversation.title ?? 'Conversation',
        model: Config.getModel(),
        status: conversation.localConversationId === snapshot.currentConversationId ? 'current' : 'completed',
        phase: 'completed',
        createdAt: new Date(conversation.createdAt).getTime(),
        updatedAt: new Date(conversation.updatedAt).getTime(),
        isRecoverable: false,
      }));

      this.post({ type: 'persistedConversationsLoaded', conversations: items });
      void this.postOperationsSnapshot();
    } catch (error) {
      Logger.warn('[AgentPanel] Failed to load persisted conversations:', error);
    }
  }

  private async resumeTask(taskId: string): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const snapshot = await this.runtime.resumeTask(taskId);
      this.conversationId = taskId;
      this.post({ type: 'taskResumed', taskId, snapshot });
      await this.postOperationsSnapshot();
    } catch (error) {
      this.post({
        type: 'error',
        message: `Could not resume task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  private async pauseTask(taskId: string): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const snapshot = await this.runtime.pauseTask(taskId);
      this.post({ type: 'taskPaused', taskId, snapshot });
      await this.postOperationsSnapshot();
    } catch (error) {
      this.post({ type: 'error', message: `Failed to pause task: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async cancelPersistedTask(taskId: string): Promise<void> {
    try {
      // Karke Dikha is Core-owned and projected by M15.  Routing this through
      // the legacy AgentRuntime leaves the real worker/model call alive and
      // the visible task stranded in progress.
      const autonomousTask = await this.autonomousQueue?.get(taskId);
      if (autonomousTask) {
        if (!this.taskBelongsToWorkspace(autonomousTask)) {
          this.postAuthorizationDenied('stale_permission_context', 'This task does not belong to the current workspace.');
          return;
        }
        await this.autonomousRuntime?.cancelTask(taskId);
        await this.pollAutonomousTask(taskId);
        this.post({ type: 'taskCancelled', taskId });
        await this.postOperationsSnapshot();
        return;
      }
      if (!this.runtime) return;
      const snapshot = await this.runtime.cancelTask(taskId);
      this.post({ type: 'taskCancelled', taskId, snapshot });
      await this.postOperationsSnapshot();
    } catch (error) {
      this.post({ type: 'error', message: `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async steerTask(taskId: string, message: string, messageId?: string): Promise<void> {
    try {
      // Same Core-owned/legacy split as cancelPersistedTask: an autonomous
      // task's live graph run only ever checks the M15 steering queue.
      const autonomousTask = await this.autonomousQueue?.get(taskId);
      if (autonomousTask) {
        await this.autonomousRuntime?.sendSteering(taskId, message, messageId);
        await this.pollAutonomousTask(taskId);
        this.post({ type: 'taskSteered', taskId, messageId });
        await this.postOperationsSnapshot();
        return;
      }
      if (!this.runtime) return;
      const snapshot = await this.runtime.sendSteering(taskId, message);
      this.post({ type: 'taskSteered', taskId, snapshot });
      await this.postOperationsSnapshot();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Tell the webview exactly which steer failed so it can release the
      // pending slot and keep the text as an unsent draft (never silently lost).
      this.post({ type: 'taskSteerRejected', taskId, messageId, reason });
      this.post({ type: 'error', message: `Failed to steer task: ${reason}` });
    }
  }

  private async postTaskSnapshot(taskId: string): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const snapshot = await this.runtime.getTask(taskId);
      this.post({ type: 'taskSnapshot', taskId, snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Task not found:/i.test(message)) {
        Logger.warn('[AgentPanel] Task snapshot unavailable:', message);
        return;
      }
      this.post({ type: 'error', message: `Failed to load task: ${message}` });
    }
  }

  /**
   * M33 durable history: read-only projection served by Core's additive
   * `/v1/history/tasks` endpoints. Core's durable store stays authoritative —
   * this panel never caches or persists a second history database.
   */
  private async postEverydayHistory(): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) {
      this.post({ type: 'everydayHistory', available: false, tasks: [] });
      return;
    }
    try {
      const { tasks } = await client.listTaskHistory({ limit: 50 });
      this.post({ type: 'everydayHistory', available: true, tasks });
    } catch (error) {
      Logger.warn('[M33] Failed to load durable task history:', error);
      this.post({ type: 'everydayHistory', available: false, tasks: [] });
    }
  }

  private async postEverydayHistoryDetail(attemptId: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) return;
    try {
      const detail = await client.getTaskHistoryDetail(attemptId);
      this.post({ type: 'everydayHistoryDetail', attemptId, detail });
    } catch (error) {
      Logger.warn('[M33] Failed to load task history detail:', error);
      this.post({ type: 'everydayHistoryDetail', attemptId, detail: null });
    }
  }

  private async postOperationsSnapshot(): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const snapshot = await this.runtime.getOperationsSnapshot();
      this.post({ type: 'operationsSnapshot', snapshot });
    } catch (error) {
      Logger.warn('[AgentPanel] Failed to load operations snapshot:', error);
    }
  }

  /** Starts a brand-new task attempt seeded from a prior task's goal — never resumes the original. */
  private async retryTask(taskId: string): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const original = await this.runtime.taskStore.getTask(taskId);
      if (!original) {
        this.post({ type: 'error', message: `Could not retry task: original task ${taskId} was not found.` });
        return;
      }
      await this.newConversation();
      const newTaskId = this.conversationId;
      await this.handleUserMessage(original.userGoal, (original.mode as AgentMode) || 'agent', [], newTaskId, original.model || undefined);
    } catch (error) {
      this.post({ type: 'error', message: `Failed to retry task: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async archiveOldTasks(): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const archived = await this.runtime.taskStore.archiveStaleTasks(7 * 24 * 60 * 60 * 1000);
      this.post({ type: 'tasksArchived', taskIds: archived });
      await this.postOperationsSnapshot();
    } catch (error) {
      this.post({ type: 'error', message: `Failed to archive old tasks: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async postArchivedTasksSnapshot(): Promise<void> {
    if (!this.runtime) { return; }
    try {
      const tasks = await this.runtime.taskStore.listArchivedTasks();
      const items = tasks.slice(0, 50).map(task => ({
        taskId: task.taskId,
        title: task.title ?? task.userGoal.slice(0, 80),
        status: task.status,
        phase: task.phase ?? task.status,
        model: task.model,
        updatedAt: task.updatedAt,
        blockedReason: task.blockedReason,
        failure: task.failure,
      }));
      this.post({ type: 'archivedTasksSnapshot', tasks: items });
    } catch (error) {
      Logger.warn('[AgentPanel] Failed to load archived tasks:', error);
    }
  }

  async postRepositoryIntelligenceStatus(): Promise<void> {
    try {
      const status = await this.repositoryContext.status();
      this.post({ type: 'repositoryIntelligenceStatus', status: this.normalizeRepositoryStatus(status as unknown as Record<string, unknown>) });
    } catch (error) {
      this.post({
        type: 'repositoryIntelligenceStatus',
        status: {
          state: 'unavailable',
          staleReason: error instanceof Error ? error.message : String(error),
          statistics: { files: 0, symbols: 0, imports: 0, tests: 0, configs: 0, buildFiles: 0, markdown: 0, changedFiles: 0, deletedFiles: 0 },
          selectedFiles: [],
          estimatedTokens: 0,
          omittedCount: 0,
          pins: [],
          exclusions: [],
          storage: { kind: 'sqlite', path: '', sqliteAvailable: false },
          identity: {
            repositoryRoot: this.workspaceRoot,
            branch: 'unknown',
            headCommit: 'unknown',
            worktree: this.workspaceRoot,
            detached: false,
            schemaVersion: 2,
          },
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  private normalizeRepositoryStatus(status: Record<string, unknown>): Record<string, unknown> {
    const identity = status.identity && typeof status.identity === 'object' ? status.identity as Record<string, unknown> : {};
    return {
      ...status,
      identity: {
        repositoryRoot: String(identity.repositoryRoot ?? this.workspaceRoot),
        branch: String(identity.branch ?? 'unknown'),
        headCommit: String(identity.headCommit ?? 'unknown'),
        ...identity,
      },
    };
  }

  private async reconcileRepositoryIntelligence(): Promise<void> {
    try {
      const status = await this.repositoryContext.reconcileStartup();
      this.post({ type: 'repositoryIntelligenceStatus', status: this.normalizeRepositoryStatus(status as unknown as Record<string, unknown>) });
    } catch (error) {
      Logger.warn('[AgentPanel] Repository startup reconciliation failed:', error);
      await this.postRepositoryIntelligenceStatus();
    }
  }

  async rebuildRepositoryIntelligence(): Promise<void> {
    try {
      const status = await this.repositoryContext.rebuild();
      this.post({ type: 'repositoryIntelligenceStatus', status: this.normalizeRepositoryStatus(status as unknown as Record<string, unknown>) });
      vscode.window.showInformationMessage('Forge repository intelligence rebuilt.');
    } catch (error) {
      this.post({
        type: 'repositoryIntelligenceStatus',
        status: this.normalizeRepositoryStatus({
          state: 'unavailable',
          staleReason: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
          statistics: {}, selectedFiles: [], estimatedTokens: 0, omittedCount: 0,
        }),
      });
      vscode.window.showErrorMessage(`Forge repository intelligence rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  pauseRepositoryIndexing(): void {
    this.repositoryContext.pause();
    void this.postRepositoryIntelligenceStatus();
    vscode.window.showInformationMessage('Forge repository indexing paused.');
  }

  resumeRepositoryIndexing(): void {
    this.repositoryContext.resume();
    void this.postRepositoryIntelligenceStatus();
    vscode.window.showInformationMessage('Forge repository indexing resumed.');
  }

  async pinCurrentFileForTask(): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!active || !active.startsWith(this.workspaceRoot)) {
      vscode.window.showInformationMessage('No workspace file is active.');
      return;
    }
    const relative = active.slice(this.workspaceRoot.length).replace(/^[/\\]/, '').replace(/\\/g, '/');
    const status = await this.repositoryContext.pin(relative);
    this.post({ type: 'repositoryIntelligenceStatus', status });
    vscode.window.showInformationMessage(`Pinned ${relative} for repository context.`);
  }

  async excludePathFromRetrieval(): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const defaultValue = active?.startsWith(this.workspaceRoot)
      ? active.slice(this.workspaceRoot.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
      : '';
    const relative = await vscode.window.showInputBox({
      title: 'Exclude path from repository retrieval',
      value: defaultValue,
      prompt: 'Relative path or directory to exclude from repository intelligence retrieval.',
    });
    if (!relative?.trim()) { return; }
    const status = await this.repositoryContext.exclude(relative.trim());
    this.post({ type: 'repositoryIntelligenceStatus', status });
    vscode.window.showInformationMessage(`Excluded ${relative.trim()} from repository retrieval.`);
  }

  private async requireWorkspace(request: {
    text: string;
    mode: AgentMode;
    attachmentIds?: string[];
    conversationId: string;
    modelOverride?: string;
  }): Promise<void> {
    await this.context.globalState?.update(PENDING_WORKSPACE_REQUEST_KEY, {
      text: request.text.slice(0, 20_000),
      mode: request.mode,
      attachmentIds: request.attachmentIds ?? [],
      conversationId: request.conversationId,
      modelOverride: request.modelOverride,
      createdAt: new Date().toISOString(),
      targetWorkspaceIdentity: null,
    });
    this.post({
      type: 'workspaceRequired',
      text: request.text,
      mode: request.mode,
      conversationId: request.conversationId,
      message: 'Saath Kar needs a workspace before it can inspect or change project files.',
    });
  }

  private async openWorkspaceFolder(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Open workspace',
      title: 'Choose a workspace for Saath Kar',
    });
    const folder = selected?.[0];
    if (folder) {
      await this.bindPendingRequestToWorkspace(folder.fsPath);
      await vscode.commands.executeCommand('vscode.openFolder', folder, false);
    }
  }

  private async createWorkspaceFolder(): Promise<void> {
    const parent = (await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Choose parent folder',
      title: 'Choose where to create the project',
    }))?.[0];
    if (!parent) return;
    const name = await vscode.window.showInputBox({
      title: 'Create project folder',
      prompt: 'Project folder name',
      validateInput: value => /^[a-zA-Z0-9._-]+$/.test(value.trim()) ? undefined : 'Use letters, numbers, dot, underscore, or hyphen.',
    });
    if (!name?.trim()) return;
    const target = vscode.Uri.joinPath(parent, name.trim());
    await vscode.workspace.fs.createDirectory(target);
    await this.bindPendingRequestToWorkspace(target.fsPath);
    await vscode.commands.executeCommand('vscode.openFolder', target, false);
  }

  private async bindPendingRequestToWorkspace(workspaceRoot: string): Promise<void> {
    const pending = this.context.globalState?.get<Record<string, unknown>>(PENDING_WORKSPACE_REQUEST_KEY);
    if (!pending) return;
    await this.context.globalState?.update(PENDING_WORKSPACE_REQUEST_KEY, {
      ...pending,
      targetWorkspaceIdentity: createWorkspaceIdentity(workspaceRoot, true),
    });
  }

  private async resumePendingWorkspaceRequest(): Promise<void> {
    const pending = this.context.globalState?.get<{
      text?: string;
      mode?: AgentMode;
      attachmentIds?: string[];
      conversationId?: string;
      modelOverride?: string;
      targetWorkspaceIdentity?: string | null;
    }>(PENDING_WORKSPACE_REQUEST_KEY);
    if (!pending?.text || !pending.mode) return;
    if (!pending.targetWorkspaceIdentity) {
      await this.context.globalState?.update(PENDING_WORKSPACE_REQUEST_KEY, undefined);
      return;
    }
    if (pending.targetWorkspaceIdentity !== this.workspaceIdentity) return;
    await this.context.globalState?.update(PENDING_WORKSPACE_REQUEST_KEY, undefined);
    const conversationId = pending.conversationId || this.conversationId;
    this.conversationId = conversationId;
    const attachmentIds = pending.attachmentIds ?? [];
    this.post({ type: 'workspaceRequestResumed', text: pending.text, mode: pending.mode, conversationId });
    await this.handleUserMessage(pending.text, pending.mode, attachmentIds, conversationId, pending.modelOverride);
  }

  private async createLocalStory(message: Record<string, unknown>): Promise<void> {
    try {
      const draft = normalizeLocalStoryDraft(message['draft']);
      const client = getCoreManager()?.getClient();
      if (!client) {
        this.post({ type: 'error', message: 'KarkeDikha Core is not connected; cannot create a Board story right now.' });
        return;
      }
      const project = await getOrCreateProjectByName(client, path.basename(this.workspaceRoot));
      const sourceConversationId = optionalString(message['conversationId']) ?? this.conversationId;
      const sourceText = optionalString(message['sourceText']);
      const story = await client.request<{ id: string; title: string; status: string; revision: number }>('/v1/stories', {
        method: 'POST',
        body: {
          projectId: project.id,
          title: draft.title,
          description: draft.goal,
          acceptanceCriteria: draft.acceptanceCriteria,
          storyType: 'story',
          source: { origin: 'chat', sourceConversationId, sourceText },
        },
      });
      this.post({ type: 'localStoryCreated', story, created: true });
    } catch (error) {
      this.post({ type: 'error', message: `Could not create story: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /**
   * M36 attachment ingestion service. Each file is classified through the shared ArtifactInput table (one source of truth
   * for supported types, limits and rejection messages), bounded-checked (size, symlink/directory, no mid-read size
   * change), uploaded through Core's bounded authenticated binary route, and reported to the webview as an
   * `attachmentState` message (`uploading` -> `ready`/`failed`) carrying the stable Core attachment id — never the raw
   * bytes — so the composer can show real progress and the send payload can reference attachments by id.
   * Attaching needs no workspace: a lone file with no repository is a valid session.
   * Video and any document format without a local extractor are declined with an honest message rather than pretending
   * extraction succeeded.
   */
  private async pickAttachment(conversationId: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, filters: pickerFilters() });
    if (!uris || uris.length === 0) { return; }
    await this.uploadAttachmentUris(uris, conversationId, 'file');
  }

  /** Files dragged from the VS Code explorer or OS (as URIs) — same pipeline as the picker. */
  private async attachUris(rawUris: unknown, conversationId: string): Promise<void> {
    const uris = (Array.isArray(rawUris) ? rawUris : []).slice(0, INPUT_LIMITS.maxFilesPerMessage * 2)
      .map(value => { try { return vscode.Uri.parse(String(value)); } catch { return undefined; } })
      .filter((uri): uri is vscode.Uri => !!uri && uri.scheme === 'file');
    if (uris.length === 0) { this.post({ type: 'error', message: 'Only local files can be attached by dropping.' }); return; }
    await this.uploadAttachmentUris(uris, conversationId, 'dropped');
  }

  /** Files dropped from the OS as bytes (no path available to a webview): bounded, written to a private temp file, then uploaded. */
  private async attachDroppedFiles(rawFiles: unknown, conversationId: string): Promise<void> {
    const files = (Array.isArray(rawFiles) ? rawFiles : []).slice(0, INPUT_LIMITS.maxFilesPerMessage) as Array<{ name?: unknown; base64?: unknown }>;
    const dir = path.join(this.context.globalStorageUri?.fsPath ?? os.tmpdir(), 'dropped-attachments', crypto.randomUUID());
    const written: vscode.Uri[] = [];
    try {
      for (const file of files) {
        const name = path.basename(String(file.name ?? ''));
        const data = typeof file.base64 === 'string' && file.base64 ? Buffer.from(file.base64, 'base64') : undefined;
        const declared = Number((file as { size?: unknown }).size);
        const check = checkInput(name, data?.length ?? (Number.isFinite(declared) ? declared : 0), { dropped: true });
        if (!data || !check.ok) {
          this.post({ type: 'attachmentState', localId: crypto.randomUUID(), name: name || 'file', kind: 'text', status: 'failed', errorMessage: check.ok ? 'Could not read the dropped file.' : check.message });
          continue;
        }
        await fs.promises.mkdir(dir, { recursive: true });
        const target = path.join(dir, name);
        await fs.promises.writeFile(target, data);
        written.push(vscode.Uri.file(target));
      }
      if (written.length > 0) await this.uploadAttachmentUris(written, conversationId, 'dropped');
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async uploadAttachmentUris(uris: readonly vscode.Uri[], conversationId: string, _origin: 'file' | 'dropped'): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) {
      this.post({ type: 'error', message: 'KarkeDikha Core is not connected; cannot attach files right now.' });
      return;
    }
    const coreConversationId = await this.ensureCoreConversation(conversationId, 'baat_kar');
    if (!coreConversationId) {
      this.post({ type: 'error', message: 'Could not establish a durable Core conversation for attachments.' });
      return;
    }

    let accepted = 0;
    for (const uri of uris) {
      const name = path.basename(uri.fsPath);
      const localId = crypto.randomUUID();
      const support = classifyInput(name);
      const kind: 'image' | 'text' | 'document' | 'audio' = support?.kind ?? 'text';
      let createdId: string | undefined;
      try {
        const stat = await fs.promises.lstat(uri.fsPath).catch(() => undefined);
        if (stat?.isSymbolicLink()) throw new Error('symlinked files are not accepted as attachments');
        if (stat?.isDirectory()) throw new Error('directories are not accepted as attachments');
        const check = checkInput(name, stat?.size ?? 0, { countInMessage: accepted });
        if (!check.ok || !stat) {
          this.post({ type: 'attachmentState', localId, name, kind, status: 'failed', errorMessage: check.ok ? 'The file could not be read.' : check.message });
          continue;
        }
        accepted++;
        this.post({ type: 'attachmentState', localId, name, kind, status: 'uploading' });

        const created = await client.createAttachment(coreConversationId, {
          originalName: name,
          declaredMimeType: check.support.mimeType,
          kind: check.support.kind,
          byteSize: stat.size,
        });
        createdId = created.id;

        // Bounded streaming upload — the file is never buffered whole in the Extension Host; only the declared size
        // (fixed above) travels as Content-Length, and Core independently streams/hashes/verifies the bytes it
        // actually receives (attachmentUpload.ts).
        const stream = fs.createReadStream(uri.fsPath, { highWaterMark: 256 * 1024 });
        const ready = await client.uploadAttachmentBytes(created.id, stream, stat.size);

        // Pre/post identity check: a file that was replaced or mutated while we were streaming it must not be accepted as
        // ready, even though Core already independently verified the byte count it received.
        const postStat = await fs.promises.lstat(uri.fsPath);
        if (postStat.isSymbolicLink() || postStat.mtimeMs !== stat.mtimeMs || postStat.size !== stat.size) {
          throw new Error('file changed on disk while being uploaded');
        }

        this.post({
          type: 'attachmentState',
          localId,
          name,
          kind,
          status: ready.status === 'ready' ? 'ready' : 'failed',
          attachmentId: ready.id,
          byteSize: ready.byteSize,
          sha256: ready.sha256 ?? undefined,
          errorMessage: ready.errorMessageRedacted ?? undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (createdId) {
          // Best-effort: an attachment that finished uploading (or partially did) but failed our post-upload identity
          // check must not be left dangling as an orphaned 'ready'/'uploading' record the UI already reported as failed.
          void client.deleteAttachment(createdId).catch(() => undefined);
        }
        this.post({ type: 'attachmentState', localId, name, kind, status: 'failed', errorMessage: message });
      }
    }
  }

  private async searchWorkbench(query: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) { this.post({ type: 'error', message: 'KarkeDikha Core is not connected.' }); return; }
    try { this.post({ type: 'workbenchSearchResults', query, results: (await client.searchConversations(query)).results }); }
    catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  private async persistCoreConversationPointer(localId: string, coreId: string): Promise<void> {
    this.coreConversationIds.set(`baat_kar:${localId}`, coreId);
    await this.persistWorkspaceConversationState(localId);
  }

  private async openWorkbenchConversation(coreConversationId: string): Promise<void> {
    if (!coreConversationId) return;
    this.conversationId = coreConversationId;
    await this.persistCoreConversationPointer(coreConversationId, coreConversationId);
    this.post({ type: 'conversationSelected', id: coreConversationId });
    await this.restoreConversationTranscript();
    await this.restoreConversationContinuity();
  }

  private async branchFromMessage(messageId: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    const parentId = await this.ensureCoreConversation(this.conversationId, 'baat_kar');
    if (!client || !parentId || !messageId) { this.post({ type: 'error', message: 'This message cannot be branched because its durable conversation is unavailable.' }); return; }
    try {
      const branch = await client.branchConversation(parentId, { branchPointMessageId: messageId });
      await this.persistCoreConversationPointer(branch.id, branch.id);
      this.post({ type: 'conversationBranched', id: branch.id, parentConversationId: parentId });
      await this.openWorkbenchConversation(branch.id);
    } catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  private async regenerateMessage(messageId: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    const coreConversationId = await this.ensureCoreConversation(this.conversationId, 'baat_kar');
    if (!client || !coreConversationId || !messageId) { this.post({ type: 'error', message: 'This response cannot be regenerated because its durable conversation is unavailable.' }); return; }
    try {
      const result = await client.regenerateResponse(coreConversationId, messageId);
      this.coreExecutionTurns.set(result.attempt.id, { attemptId: result.attempt.id, conversationId: this.conversationId, coreConversationId, mode: 'chat', terminal: false, tokenBuffer: '', toolArgsById: new Map() });
      this.coreActiveAttemptIds.set(this.conversationId, result.attempt.id);
      this.post({ type: 'regenerationStarted' });
    } catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  private async selectResponseAlternative(alternativeId: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    const coreConversationId = await this.ensureCoreConversation(this.conversationId, 'baat_kar');
    if (!client || !coreConversationId || !alternativeId) return;
    try { await client.selectResponseAlternative(coreConversationId, alternativeId); await this.restoreConversationTranscript(true); }
    catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  private async exportConversation(format: 'json' | 'markdown'): Promise<void> {
    const client = getCoreManager()?.getClient();
    const coreConversationId = await this.ensureCoreConversation(this.conversationId, 'baat_kar');
    if (!client || !coreConversationId) { this.post({ type: 'error', message: 'No durable conversation is available to export.' }); return; }
    try {
      const target = await vscode.window.showSaveDialog({ filters: format === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] }, saveLabel: 'Export conversation' });
      if (!target) return;
      const exported = await client.exportConversation(coreConversationId, format);
      const content = exported.format === 'markdown' ? exported.content : `${JSON.stringify(exported.content, null, 2)}\n`;
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
      this.post({ type: 'conversationExported', format, path: target.fsPath });
    } catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  private async handleUserMessage(
    text: string,
    mode: AgentMode,
    attachmentIds: string[] = [],
    conversationId: string,
    modelOverride?: string,
    options: { stayInBaatKar?: boolean } = {},
  ): Promise<void> {
    if (!text.trim() && attachmentIds.length === 0) { return; }
    if (mode === 'chat' && options.stayInBaatKar !== true && !isStandaloneCodeRequest(text) && hasAffirmativeMutationIntent(text)) {
      await this.requireModeChange({ text, attachmentIds, conversationId, modelOverride });
      return;
    }
    if (requiresWorkspaceForMode(mode, this.workspaceAvailable)) {
      await this.requireWorkspace({ text, mode, attachmentIds, conversationId, modelOverride });
      return;
    }

    if (!this.conversations.has(conversationId)) {
      this.createConversation(conversationId, text);
    } else {
      this.updateConversation(conversationId, text);
    }

    if (mode === 'chat' && attachmentIds.length === 0 && this.isResearchRequest(text)) {
      await this.requestGovernedResearch(text, conversationId);
      return;
    }
    await this.sendToAgent(text, attachmentIds, mode, modelOverride, conversationId);
  }

  private async submitComposerMessage(input: { text: string; mode: AgentMode; attachmentIds: string[]; conversationId: string; model?: string; stayInBaatKar?: boolean }): Promise<void> {
    const requestedMode = input.mode;
    const composerMode: ComposerMode = requestedMode === 'chat' ? 'chat' : 'agent';
    const incomingConversationId = input.conversationId;
    this.conversationId = incomingConversationId;
    this.activeConversationId = incomingConversationId;
    // Shadow advisory only (no-op unless explicitly enabled): the deterministic
    // decision above stays the effective one.
    this.systemOneShadow.observe({
      text: input.text,
      deterministicMode: requestedMode === 'chat' ? 'chat' : 'agent',
      conversationId: incomingConversationId,
    });
    // A turn refused before Core committed it keeps its attachments; a bare "resume" continues the same objective with them.
    const carry = this.attachmentRetention.resolve(incomingConversationId, input.text, input.attachmentIds);
    if (carry.carried) {
      this.post({ type: 'executionQualityProgress', message: `Resuming your earlier request with the same ${carry.attachmentIds.length === 1 ? 'attachment' : 'attachments'}.`, details: { reason: carry.reason } });
    }
    await this.routeComposerSubmission(
      carry.text,
      effectiveText => this.handleUserMessage(
        effectiveText,
        requestedMode,
        carry.attachmentIds,
        incomingConversationId,
        input.model,
        { stayInBaatKar: input.stayInBaatKar === true },
      ),
      composerMode,
      incomingConversationId,
    );
  }

  /** Deliberately narrow product intent detection: this keeps normal chat on
   * its existing path while a plain-language request to research is routed to
   * the one Core-owned governed-research workflow. */
  private isResearchRequest(text: string): boolean {
    return /\b(research|search the web|look up online|web evidence|sources? for)\b/i.test(text);
  }

  private async requestGovernedResearch(text: string, conversationId: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) { this.post({ type: 'error', message: 'KarkeDikha Core is not connected. Research cannot start.' }); return; }
    const coreConversationId = await this.ensureCoreConversation(conversationId, 'baat_kar');
    if (!coreConversationId) { this.post({ type: 'error', message: 'Could not establish a durable conversation for research.' }); return; }
    try {
      const { session, approval } = await client.createResearch(coreConversationId, text);
      this.post({ type: 'researchApprovalRequest', researchId: session.id, approvalId: approval.id, requestedActionDigest: approval.requestedActionDigest, provider: approval.summary.provider, queryPreview: approval.summary.queryPreview });
    } catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  private async resolveGovernedResearch(researchId: string, approvalId: string, requestedActionDigest: string, resolution: 'approved' | 'rejected'): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) { this.post({ type: 'error', message: 'KarkeDikha Core is not connected.' }); return; }
    try {
      const session = await client.resolveResearch(researchId, { approvalId, requestedActionDigest, resolution });
      if (resolution === 'rejected') { this.post({ type: 'researchDenied', researchId }); return; }
      this.post({ type: 'researchProgress', researchId, message: 'Researching approved sources…' });
      const deadline = Date.now() + 35_000;
      let current = session;
      while (current.state === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        current = (await client.getResearch(researchId)).session;
      }
      const [{ messages }, detail] = await Promise.all([client.listMessages(current.conversationId), client.getResearch(researchId)]);
      const assistant = [...messages].reverse().find(message => message.role === 'assistant');
      const citations = assistant ? await client.listMessageCitations(assistant.id) : { citations: [] };
      const sourceById = new Map(detail.sources.map(source => [source.id, source]));
      this.post({ type: 'researchCompleted', researchId, state: current.state, content: assistant?.content ?? 'Research ended without an answer.', citations: citations.citations.map(citation => ({ label: citation.visibleLabel, title: sourceById.get(citation.sourceId)?.title ?? null, url: sourceById.get(citation.sourceId)?.finalUrl ?? null })) });
    } catch (error) { this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  }

  /**
   * M32 correction (dual execution authority removal, Baat Kar/Saath Kar):
   * Core is now the sole executor for these two modes. This method creates
   * the one authoritative Core request+attempt via `CoreClient.submit()`,
   * asks Core to run it (`executeAttempt`), and returns — all output
   * (streamed tokens, tool start/result, completion, failure) arrives
   * asynchronously via the `runtime_event`/`runtime_token` relay
   * (`handleCoreRuntimeEvent`/`handleCoreRuntimeToken`) and is rendered
   * through the existing webview message protocol. `AgentRuntime.run()` is
   * never called here, including on a Core failure — a Core rejection or
   * unreachable Core surfaces as a structured `error` message, with no
   * fallback execution path.
   *
   * M36: the user message is no longer appended here — `client.submit()` now
   * appends it, links `attachmentIds` to it, and creates the request/attempt,
   * all inside one Core transaction (see `core/domain/submission.ts`). Image
   * attachments require a vision-capable model selection; Core enforces this
   * as an honest blocker rather than silently falling back to text-only.
   */
  private async sendToAgent(
    text: string,
    attachmentIds: string[],
    mode: AgentMode,
    modelOverride?: string,
    taskId?: string,
  ): Promise<void> {
    const runId = taskId ?? this.conversationId;
    this.activePermissionRunId = runId;
    this.postPermissionState();
    this.ensureCoreRuntimeRelay();

    // Set once Core has durably committed the turn (its message, attachment links and attempt). Before that, a failure
    // leaves the attachments uploaded but unlinked, so they are kept for "resume".
    let committed = false;
    const fail = async (message: string): Promise<void> => {
      console.error('[OllamaAgent] Core execution failed to start:', message);
      if (!committed && attachmentIds.length > 0) this.attachmentRetention.retain(runId, { text, attachmentIds, reason: message });
      this.post({ type: 'error', message });
      this.coreActiveAttemptIds.delete(runId);
      await this.finishActiveTurnBookkeeping(runId);
    };

    const client = await this.ensureCoreClientReady(4000);
    if (!client) {
      const manager = this.coreManager ?? getCoreManager();
      const status = typeof manager?.getStatus === 'function' ? manager.getStatus() : undefined;
      await fail(describeCoreUnavailableForBaat(status));
      return;
    }

    const kind = AgentPanel.coreKindFor(mode);

    try {
      const coreConversationId = await this.ensureCoreConversation(runId, kind, text);
      if (!coreConversationId) {
        throw new Error('failed to establish a durable Core conversation for this turn');
      }
      let hasImageAttachment = false;
      for (const attachmentId of attachmentIds) {
        const attachment = await client.getAttachment(attachmentId);
        if (attachment.kind === 'image') { hasImageAttachment = true; break; }
      }
      // A follow-up about an image sent earlier in THIS conversation ("What is the red object?") still needs a vision
      // model, because Core re-attaches the earlier image from the conversation (attachments/continuation.ts). A new
      // conversation has no links, so nothing leaks across New Chat.
      if (!hasImageAttachment) {
        try {
          const [{ messages }, { byMessage }] = await Promise.all([
            client.listMessages(coreConversationId),
            client.listConversationMessageAttachments(coreConversationId),
          ]);
          hasImageAttachment = selectContinuationAttachments({ messages, byMessage, currentTurnNotYetAppended: true }).some(item => item.kind === 'image');
        } catch {
          // Continuity is best-effort here; Core re-checks vision capability before any image is sent.
        }
      }
      const emptyResponseRecovery = attachmentIds.length === 0
        ? await this.findGroundedEmptyResponseRecovery(client, coreConversationId, runId, kind, text)
        : undefined;
      let modelSelection: ModelSelectionEvidence;
      try {
        modelSelection = emptyResponseRecovery?.modelSelection && !modelOverride
          ? emptyResponseRecovery.modelSelection
          : await this.selectModelForTask(text, kind, modelOverride, hasImageAttachment);
      } catch (selectionError) {
        // No selection happened, so the previous turn's "suited to this task" line must not keep describing this one.
        this.post({ type: 'modelSelectionFailed' });
        throw selectionError;
      }
      this.post({ type: 'modelSuitability', summary: modelSelection.suitabilitySummary, details: modelSelection });
      this.postOperatorContext(modelSelection.selectedModel);
      const repositorySelection = emptyResponseRecovery?.repositorySelection
        ?? await this.applySkillGuidance(await this.buildSupplementalRepositoryContext(text, kind, mode, modelSelection, attachmentIds.length), text, kind, modelSelection, hasImageAttachment);

      const submission = await client.submit({
        currentMessage: text,
        requestedMode: kind,
        conversationId: coreConversationId,
        requestedProvider: modelSelection.selectedProvider,
        requestedModel: modelSelection.selectedModel,
        modelSelection,
        repositoryContext: repositorySelection?.context,
        attachmentIds,
        // Persist workspace identity for activation correlation and for the
        // frozen Baat repository package when this is a repository question.
        workspaceRoot: this.workspaceAvailable ? this.workspaceRoot : null,
        toolPermissionPolicy: { profile: this.selectedPermissionContext.profileId },
      });
      committed = true;
      this.attachmentRetention.consume(runId);

      if (repositorySelection) {
        this.post({ type: 'repositoryContextEvidence', available: true, ...repositorySelection.evidence, ...(repositorySelection.hostFacts ? { factsLabel: repositorySelection.hostFacts.measured ?? 'computed by the host' } : {}) });
        if (repositorySelection.status) {
          this.post({ type: 'repositoryIntelligenceStatus', status: repositorySelection.status });
        }
      }

      this.coreExecutionTurns.set(submission.attempt.id, {
        attemptId: submission.attempt.id,
        conversationId: runId,
        coreConversationId,
        mode,
        terminal: false,
        tokenBuffer: '',
        toolArgsById: new Map(),
      });
      this.coreActiveAttemptIds.set(runId, submission.attempt.id);
      {
        // One projection per run. A confirmed/declined mode change hands its projection over so the thread continues.
        const continued = this.continuedProjections.get(runId);
        this.continuedProjections.delete(runId);
        const projection = continued ?? new ExecutionProjection({ runId: submission.attempt.id, mode: kind as RunMode, request: text });
        const registered = this.coreExecutionTurns.get(submission.attempt.id);
        if (registered) {
          registered.projection = projection;
          registered.repositoryTurn = Boolean(repositorySelection);
          if (repositorySelection?.hostFacts) registered.hostFacts = repositorySelection.hostFacts;
          if (repositorySelection?.evidenceGap) registered.evidenceGap = repositorySelection.evidenceGap;
        }
        if (continued) {
          this.dhaagaRuns.set(projection.snapshot().runId, projection);
        } else {
          this.beginDhaaga(projection);
          if (repositorySelection?.hostFacts) this.postDhaaga(projection.repositoryFacts(repositorySelection.hostFacts));
          else if (repositorySelection) this.postDhaaga(projection.repositoryEvidence(repositorySelection.evidence.paths, path.basename(this.workspaceRoot)));
        }
      }

      console.log(`[OllamaAgent] Core execution start — mode=${mode} attemptId=${submission.attempt.id}`);
      await client.executeAttempt(submission.attempt.id, kind === 'saath_kar' ? { workingDirectory: this.workspaceRoot } : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Drop any turn state this attempt may have already registered so a
      // stray later event for it (if Core did partially succeed) cannot
      // resurrect a start that we are about to report as failed.
      for (const [attemptId, turn] of this.coreExecutionTurns) {
        if (turn.conversationId === runId && !turn.terminal) this.coreExecutionTurns.delete(attemptId);
      }
      await fail(message);
    }
  }

  /**
   * A bare Resume/Continue after Core truthfully reports an empty model
   * response must not ask the repository selector to infer a subject from the
   * word "Resume". Reuse only the immediately preceding failed turn's frozen,
   * bounded repository package and model evidence, and only for the exact
   * empty-response failure. Every other failure and every substantive new
   * instruction stays on the ordinary selection path.
   */
  private async findGroundedEmptyResponseRecovery(
    client: CoreClient,
    coreConversationId: string,
    localConversationId: string,
    kind: 'baat_kar' | 'saath_kar',
    text: string,
  ): Promise<{ modelSelection?: ModelSelectionEvidence; repositorySelection: BaatRepositoryContextSelection } | undefined> {
    if (!isReferentialFollowUp(text)) return undefined;
    try {
      const ledger = await client.getWorkspaceConversationLedger(this.workspaceIdentity);
      if (
        ledger.currentConversationId !== localConversationId
        || ledger.currentCoreConversationId !== coreConversationId
      ) return undefined;
      const preceding = [...ledger.turns].reverse().find(turn => turn.conversationId === coreConversationId);
      if (!preceding || preceding.outcome !== 'failed' || preceding.mode !== kind) return undefined;

      const attempt = await client.getAttempt(preceding.attemptId);
      if (attempt.status !== 'failed' || attempt.failureReason?.trim() !== 'model produced an empty response') {
        return undefined;
      }
      const context = await client.getAttemptContext(preceding.attemptId);
      const repositoryContext = context.repositoryContext;
      if (!repositoryContext?.prompt || repositoryContext.selectedFiles.length === 0) return undefined;

      const paths = repositoryContext.selectedFiles.map(file => file.path);
      this.noteAuthoritativeTurnFiles(paths);
      return {
        modelSelection: context.modelSelection,
        repositorySelection: {
          context: repositoryContext,
          evidence: {
            fileCount: paths.length,
            estimatedTokens: repositoryContext.estimatedTokens,
            paths,
          },
        },
      };
    } catch (error) {
      Logger.warn('[AgentPanel] Could not restore frozen repository evidence for empty-response recovery:', error);
      return undefined;
    }
  }

  /**
   * Selects bounded repository excerpts for a workspace-backed conversation
   * turn, through the existing `RepositoryContextService`/`ContextSelector`
   * and the existing per-mode context role — no second retrieval path.
   *
   * Baat Kar only asks for it when the existing model policy identified the
   * turn as repository exploration, because a plain question must stay plain
   * chat. Saath Kar always asks: it is the collaborate-on-this-repository
   * mode, its role is `implementer` (`roleForMode('agent')`), and it needs to
   * find the right file and the surrounding conventions before proposing a
   * change. Failure is explicitly surfaced but never prevents the submission.
   */
  /**
   * Decides whether a Baat Kar turn should carry bounded repository excerpts.
   *
   * Two passes, cheapest first:
   *  1. an explicit repository noun or a literal path in the text;
   *  2. otherwise, identifier-like tokens in the question are LOOKED UP in the
   *     repository index, and context is attached only if one of them names a
   *     symbol that actually exists here.
   *
   * Pass 2 is what makes the ordinary way people ask about their own code work
   * — "Why does registerUser accept an empty username?" names no file, no
   * folder and no repository noun, and the previous keyword-only gate answered
   * it as plain chat. A camelCase token alone is NOT taken as proof; the
   * repository index has to confirm the symbol, so "Explain the difference
   * between TCP and UDP" stays ordinary conversation.
   */
  private async isRepositoryContextQuestion(text: string, attachmentCount = 0): Promise<boolean> {
    return (await this.classifyRepositoryQuestion(text, attachmentCount)) !== 'none';
  }

  /**
   * Appends the few skills resolved for this turn to the repository context as short advisory guidance. The package hash is
   * recomputed (Core verifies it against the prompt). Never changes permissions, and does nothing when no repository
   * package exists for the turn or no skill is selected.
   */
  private async applySkillGuidance(
    selection: BaatRepositoryContextSelection | undefined,
    text: string,
    kind: 'baat_kar' | 'saath_kar',
    modelSelection: ModelSelectionEvidence,
    hasImage: boolean,
  ): Promise<BaatRepositoryContextSelection | undefined> {
    if (!selection) return selection;
    try {
      const skills = await SkillRuntimeService.forWorkspace(this.context, this.workspaceRoot).resolveForTurn({
        intent: text,
        kind,
        model: { vision: hasImage ? true : undefined, tools: kind === 'saath_kar' ? true : undefined },
      });
      if (!skills || !skills.compiled) return selection;
      Logger.info(`[Skills] ${skills.selected.map(s => s.id).join(', ')} (${skills.compiledTokens} tokens)`);
      const prompt = `${selection.context.prompt}

${skills.compiled}`;
      if (prompt.length > 190_000) return selection;
      return {
        ...selection,
        context: {
          ...selection.context,
          prompt,
          estimatedTokens: selection.context.estimatedTokens + skills.compiledTokens,
          packageHash: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
        },
      };
    } catch (error) {
      Logger.warn(`[Skills] guidance unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return selection;
    }
  }

  /** Plugs the background repository graph in as one more ranked retrieval source (ranking only; source is still read exactly). */
  attachRepositoryGraph(graph: { rankForPlan(plan: { identifiers: readonly string[]; keywords: readonly string[] }): string[] } | undefined): void {
    this.repoFastPath.setGraphRanker(graph ? plan => graph.rankForPlan(plan) : undefined);
  }

  /**
   * Objectives that already name every file to create need no repository retrieval: it would only drag unrelated files
   * into the evidence. Conservative (see RetrievalNeed): any sign of dependence on existing code keeps retrieval on.
   */
  private objectiveNeedsRetrieval(text: string): boolean {
    const need = assessRetrievalNeed(text, {
      fileExists: rel => {
        try { return fs.existsSync(path.join(this.workspaceRoot, rel)); } catch { return true; }
      },
    });
    if (!need.needed) Logger.info(`[Retrieval] skipped: ${need.reason} (${need.targets.join(', ')})`);
    return need.needed;
  }

  /** Why (if at all) a question is about the repository. 'workspace_overview' = an ambiguous "this" resolved to the workspace. */
  private async classifyRepositoryQuestion(text: string, attachmentCount = 0): Promise<'literal' | 'symbol' | 'workspace_overview' | 'none'> {
    if (isStandaloneCodeRequest(text)) return 'none';
    if (mentionsRepositorySubjectLiterally(text)) return 'literal';
    const candidates = extractReferencedSymbols(text);
    if (candidates.length > 0) {
      try {
        // Fast path first: a bounded git grep / workspace-symbol check never builds the repository index, which is
        // the slow step on a large repository. Only when it cannot tell does the index-backed check run.
        const fastKnown = await this.repoFastPath.knowsSymbols(candidates);
        if (fastKnown === true) return 'symbol';
        if (fastKnown === undefined && (await this.repositoryContext.findKnownSymbols(candidates)).length > 0) return 'symbol';
      } catch (error) {
        // An unavailable index must never turn a plain question into an error;
        // it just means we cannot confirm the identifier, so stay conservative.
        Logger.warn('[AgentPanel] Repository symbol confirmation unavailable:', error);
      }
    }
    return (await this.isWholeWorkspaceReference(text, attachmentCount)) ? 'workspace_overview' : 'none';
  }

  private noteConversationReferent(kind: 'baat_kar' | 'saath_kar', repositoryGrounded: boolean, text: string): void {
    if (kind === 'saath_kar' || repositoryGrounded) this.conversationReferents.set(this.conversationId, 'workspace');
    // A substantive turn answered as plain chat gives a later bare "this" another plausible referent.
    else if (text.trim().length >= 25 && this.conversationReferents.get(this.conversationId) !== 'workspace') this.conversationReferents.set(this.conversationId, 'other');
  }

  private async isWholeWorkspaceReference(text: string, attachmentCount = 0): Promise<boolean> {
    if (!this.workspaceAvailable) return false;
    const conversationReferent = this.conversationReferents.get(this.conversationId) ?? 'none';
    // The pure checks come first: the bounded workspace scan runs only for a turn that could actually resolve to the
    // workspace, so ordinary chat ("What is 2 + 2?") never pays for a directory walk. The decision is unchanged.
    if (attachmentCount > 0 || conversationReferent === 'other' || !isWholeWorkspaceQuestion(text)) return false;
    const evidence = await detectWorkspaceProjectEvidence(this.workspaceRoot);
    return resolveWorkspaceReferent({
      text,
      evidence,
      conversationReferent,
      hasAttachments: false,
    }) === 'workspace_overview';
  }

  private async buildSupplementalRepositoryContext(
    text: string,
    kind: 'baat_kar' | 'saath_kar',
    mode: AgentMode,
    modelSelection: ModelSelectionEvidence,
    attachmentCount = 0,
  ): Promise<BaatRepositoryContextSelection | undefined> {
    if (!this.workspaceAvailable) return undefined;
    const boundPack = this.consumeArtifactReferentPack(text, kind, modelSelection);
    if (boundPack) return boundPack;
    if (kind === 'baat_kar' && isStandaloneCodeRequest(text)) return undefined;
    if (kind === 'saath_kar' && !this.objectiveNeedsRetrieval(text)) return undefined;
    const repositoryQuestion = kind === 'baat_kar' ? await this.classifyRepositoryQuestion(text, attachmentCount) : 'none';
    const isRepoQuestion = repositoryQuestion !== 'none';
    const activeFile = this.activeEditorRelativePath();
    if (kind === 'baat_kar' && !isRepoQuestion && attachmentCount === 0
      && hasNoWorkspaceSignal(text, { activeFile, hasFocus: this.repoFastPath.hasFocus() })) return undefined;
    const overviewIntent = repositoryQuestion === 'workspace_overview';
    this.noteConversationReferent(kind, isRepoQuestion, text);
    // Host retrieval is the default for a workspace-bound Baat Kar turn. The classifier above only decides whether a
    // failed retrieval is fatal (a question it recognised as repository-specific); it never decides whether the
    // workspace is available. An unclassified turn gets the cheap grounded-only preflight: it yields a packet only
    // when the message actually matches the workspace (a named file, a symbol, a lexical hit) and is plain chat otherwise.
    const softProjectQuestion = kind === 'baat_kar' && !isRepoQuestion;
    try {
      // The package gets only what the selected model's window leaves after
      // the system prompt, objective, conversation replay, tool definitions
      // (Saath Kar), expected output and a safety margin are reserved.
      const budget = planRepositoryContextBudgetForModel({
        model: modelSelection.selectedModel,
        providerType: contextProviderType(modelSelection.selectedProvider),
        objective: text,
        toolsEnabled: kind === 'saath_kar',
        surface: kind,
        maxOutputTokens: Config.getMaxOutputTokens() || undefined,
      });
      if (kind === 'baat_kar') {
        // Repo Fast Path: ONE host retrieval (no model call, no index build, no search/read loop) producing a bounded
        // evidence packet, whatever the repository size. The slower index-backed selector below is only the fallback
        // when the fast path found nothing usable.
        const fast = await this.repoFastPath.repoQuery(text, {
          // A turn about a specific file (named, a file kind, the open editor, or the conversation's focus) gets the larger
          // single-file ceiling; whole-workspace questions keep the smaller one.
          maxChars: Math.min(budget.budgetChars, planRepoQuery(text).fileTargets.some(target => target.strong) || mentionedFileKinds(text).length > 0 || (activeFile !== undefined && !hasNoWorkspaceSignal(text, { activeFile })) || this.repoFastPath.hasFocus() ? REPO_FAST_PATH_EXPLICIT_FILE_MAX_CHARS : REPO_FAST_PATH_MAX_CHARS),
          requireGrounding: softProjectQuestion,
          ...(activeFile ? { activeFile } : {}),
          hotFiles: this.authoritativeTurnFiles,
          ...(this.establishedProjects.has(this.conversationId) ? { establishedProject: this.establishedProjects.get(this.conversationId) } : {}),
        });
        if (fast && (fast.grounded || !softProjectQuestion)) {
          const paths = fast.files.map(file => file.path);
          this.noteAuthoritativeTurnFiles(paths);
          if (softProjectQuestion) this.noteConversationReferent(kind, true, text);
          if (fast.referent) this.establishedProjects.set(this.conversationId, fast.referent.path);
          return {
            context: {
              prompt: fast.prompt,
              selectedFiles: fast.files,
              estimatedTokens: fast.estimatedTokens,
              packageHash: fast.packageHash,
            },
            evidence: { fileCount: paths.length, estimatedTokens: fast.estimatedTokens, paths },
            ...(fast.hostFacts ? { hostFacts: fast.hostFacts } : {}),
            ...(fast.evidenceVerdict && !fast.evidenceVerdict.sufficient ? { evidenceGap: fast.evidenceVerdict.reason } : {}),
          };
        }
        if (softProjectQuestion) return undefined;
      }
      const selected = await this.repositoryContext.build({
        query: text,
        mode,
        model: modelSelection.selectedModel,
        providerType: contextProviderType(modelSelection.selectedProvider),
        tokenBudget: budget.budgetTokens,
        budget,
        overviewIntent,
        hints: this.collectRepositoryContextHints(),
      });
      logRepositoryContextBudget(kind, modelSelection.selectedModel, selected.diagnostics.budget);
      // An overview-only package (no excerpted file) is still repository
      // evidence for a whole-repository question such as an architecture
      // overview; the selector only produces one for that kind of question.
      if (!selected.prompt) {
        this.post({
          type: 'repositoryContextEvidence',
          available: false,
          message: kind === 'saath_kar'
            ? 'No relevant repository context selected · working from the request alone'
            : 'No relevant repository context selected · answering as plain chat',
        });
        // Fail-closed contract (Baat Kar only): this turn was identified as a
        // repository-specific question, and the existing production
        // repository-read path came back with no evidence at all. Answering
        // anyway would mean the model invents file/function names that were
        // never actually retrieved — the exact legacy bug this replaces.
        // Saath Kar keeps its existing "work from the request alone" path:
        // it is the collaborate-on-this-repository mode and has its own
        // tools to go look, so an empty context selector result there is not
        // an evidence dead end.
        if (kind === 'baat_kar' && isRepoQuestion) {
          throw new RepositoryGroundingUnavailableError(
            "Repository context is currently unavailable, so I can't verify that from this workspace.",
          );
        }
        return undefined;
      }
      const evidence = {
        fileCount: selected.files.length,
        estimatedTokens: selected.diagnostics.estimatedTokens,
        paths: selected.files.map(file => file.path),
        ...(selected.diagnostics.budget ? { budget: selected.diagnostics.budget } : {}),
      };
      // These are the files that genuinely reached the model for this turn, so
      // they are exactly the files a later "continue" must revalidate.
      this.noteAuthoritativeTurnFiles(evidence.paths);
      return {
        context: {
          prompt: selected.prompt,
          selectedFiles: selected.files.map(file => ({ path: file.path, estimatedTokens: file.estimatedTokens })),
          estimatedTokens: selected.diagnostics.estimatedTokens,
          packageHash: selected.diagnostics.packageHash,
        },
        evidence,
        status: {
          state: selected.index.state,
          identity: selected.index.identity,
          updatedAt: selected.index.updatedAt,
          statistics: selected.index.statistics,
          selectedFiles: selected.diagnostics.selectedFiles,
          estimatedTokens: selected.diagnostics.estimatedTokens,
          omittedCount: selected.diagnostics.omittedCount ?? selected.diagnostics.rejectedFiles.length,
        },
      };
    } catch (error) {
      if (error instanceof RepositoryGroundingUnavailableError) {
        // Do NOT swallow: a repository-specific question with no retrievable
        // evidence must fail the submission closed rather than let the
        // caller fall through to an ungrounded model call. Rethrown to
        // `sendToAgent`, which surfaces it as the user-facing failure and
        // never calls `client.submit()` for this turn.
        throw error;
      }
      console.warn('[OllamaAgent] supplemental repository context unavailable; continuing without it:', error);
      this.post({
        type: 'repositoryContextEvidence',
        available: false,
        message: kind === 'saath_kar'
          ? 'Repository context unavailable · working from the request alone'
          : 'Repository context unavailable · answering as plain chat',
      });
      if (kind === 'baat_kar' && isRepoQuestion) {
        throw new RepositoryGroundingUnavailableError(
          "Repository context is currently unavailable, so I can't verify that from this workspace.",
        );
      }
      return undefined;
    }
  }

  /**
   * When the turn's referent was bound to a recent artifact, the context pack is that file (whole when it fits), with no
   * retrieval at all. Consumed once: matched on the exact effective text of the turn that bound it.
   */
  private consumeArtifactReferentPack(text: string, kind: 'baat_kar' | 'saath_kar', modelSelection: ModelSelectionEvidence): BaatRepositoryContextSelection | undefined {
    const bound = this.turnArtifactReferent;
    if (!bound || bound.conversationId !== this.conversationId || !text.startsWith(bound.text)) return undefined;
    this.turnArtifactReferent = null;
    try {
      const budget = planRepositoryContextBudgetForModel({
        model: modelSelection.selectedModel,
        providerType: contextProviderType(modelSelection.selectedProvider),
        objective: text,
        toolsEnabled: kind === 'saath_kar',
        surface: kind,
        maxOutputTokens: Config.getMaxOutputTokens() || undefined,
      });
      const pack = buildArtifactPack({ workspaceRoot: this.workspaceRoot, artifact: bound.artifact, phrase: bound.phrase, budgetChars: budget.budgetChars });
      if (!pack) return undefined;
      const paths = pack.selectedFiles.map(file => file.path);
      this.noteAuthoritativeTurnFiles(paths);
      this.noteConversationReferent(kind, true, text);
      return {
        context: { prompt: pack.prompt, selectedFiles: pack.selectedFiles, estimatedTokens: pack.estimatedTokens, packageHash: pack.packageHash },
        evidence: { fileCount: paths.length, estimatedTokens: pack.estimatedTokens, paths },
      };
    } catch (error) {
      Logger.warn('[AgentPanel] Could not build the recent-artifact context pack; falling back to retrieval:', error);
      return undefined;
    }
  }

  /** Workspace-relative path of the file in the active editor, or undefined when none is open inside this workspace. */
  private activeEditorRelativePath(): string | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (!active || (active.uri.scheme && active.uri.scheme !== 'file')) return undefined;
    const relative = path.relative(this.workspaceRoot, active.uri.fsPath).replace(/\\/g, '/');
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : undefined;
  }

  private collectRepositoryContextHints(): {
    openFiles: string[];
    diagnosticFiles: Array<{ path: string; severity: 'error' | 'warning' | 'info'; message?: string }>;
  } {
    const openFiles = (vscode.window.visibleTextEditors ?? [])
      .map(editor => editor.document.uri.fsPath)
      .filter(file => file.startsWith(this.workspaceRoot))
      .map(file => file.slice(this.workspaceRoot.length).replace(/^[/\\]/, ''));
    const languageApi = vscode.languages as typeof vscode.languages | undefined;
    const diagnosticFiles = (languageApi?.getDiagnostics?.() ?? [])
      .filter(([uri]) => uri.fsPath.startsWith(this.workspaceRoot))
      .flatMap(([uri, diagnostics]) => diagnostics.slice(0, 5).map(diagnostic => ({
        path: uri.fsPath.slice(this.workspaceRoot.length).replace(/^[/\\]/, ''),
        severity: diagnostic.severity === vscode.DiagnosticSeverity.Error
          ? 'error' as const
          : diagnostic.severity === vscode.DiagnosticSeverity.Warning
            ? 'warning' as const
            : 'info' as const,
        message: diagnostic.message,
      })));
    return { openFiles, diagnosticFiles };
  }

  /**
   * M32 correction: subscribes this panel to the Core's runtime_event/
   * runtime_token WS channels exactly once (guarded — a second call is a
   * no-op), so reconnects and repeated turns never register duplicate
   * listeners (which would double-render every relayed message).
   */
  private ensureCoreRuntimeRelay(): void {
    if (this.coreRuntimeRelaySubscribed) return;
    const manager = this.coreManager ?? getCoreManager();
    if (!manager) return; // retried on the next call — CoreManager is a process-lifetime singleton set at activation
    this.coreRuntimeRelaySubscribed = true;
    manager.onRuntimeEvent((event) => this.handleCoreRuntimeEvent(event));
    manager.onRuntimeToken((frame) => this.handleCoreRuntimeToken(frame));
  }

  /**
   * Translates one Core `runtime_event` into the existing webview message
   * protocol. Strict attempt correlation: only events whose `attemptId`
   * (tool_invocation events carry it in `metadata.attemptId`; attempt events
   * use `entityId` directly) matches a still-open entry in
   * `coreExecutionTurns` are ever rendered — everything else (another
   * conversation's attempt, a stale/superseded attempt, a duplicate terminal
   * event, or any event after this turn already went terminal) is ignored.
   */
  // ── Kaam ka Dhaaga projection plumbing ──────────────────────────────────

  private beginDhaaga(projection: ExecutionProjection): void {
    const state = projection.snapshot();
    this.dhaagaRuns.set(state.runId, projection);
    if (this.dhaagaRuns.size > 6) {
      for (const [id, candidate] of this.dhaagaRuns) {
        if (this.dhaagaRuns.size <= 6) break;
        if (!candidate.snapshot().active && id !== state.runId) this.dhaagaRuns.delete(id);
      }
    }
    this.post({ type: 'dhaaga', op: 'snapshot', state });
  }

  private postDhaaga(patch: DhaagaPatch | null | undefined): void {
    if (patch) this.post({ type: 'dhaaga', op: 'patch', runId: patch.state.runId, patch });
  }

  private dhaagaForAttempt(attemptId: string | undefined): ExecutionProjection | undefined {
    return attemptId ? this.coreExecutionTurns.get(attemptId)?.projection : undefined;
  }

  /**
   * Execution contract, not a label: Baat Kar is read-only conversation. A request that clearly asks for edits is
   * never executed, and never silently becomes Saath Kar. The host retrieves bounded evidence (no model call), shows
   * where it stopped, and waits for an explicit decision. Core independently offers Baat Kar no tools.
   */
  private async requireModeChange(input: { text: string; attachmentIds: string[]; conversationId: string; modelOverride?: string }): Promise<void> {
    const projection = new ExecutionProjection({ runId: `gate-${Date.now().toString(36)}`, mode: 'baat_kar', request: input.text });
    this.beginDhaaga(projection);
    if (this.workspaceAvailable && this.objectiveNeedsRetrieval(input.text)) {
      try {
        const fast = await this.repoFastPath.repoQuery(input.text, { maxChars: 6_000 });
        if (fast) this.postDhaaga(projection.repositoryEvidence(fast.files.map(file => file.path), path.basename(this.workspaceRoot)));
      } catch (error) {
        Logger.warn(`[ModeGate] bounded evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.postDhaaga(projection.modeChangeRequired());
    this.pendingModeChanges.set(input.conversationId, { ...input, projection });
    this.post({
      type: 'modeChangeRequired',
      runId: projection.snapshot().runId,
      text: input.text,
      conversationId: input.conversationId,
      from: 'baat_kar',
      to: 'saath_kar',
      prompt: 'This request requires editing files. Continue in Saath Kar?',
    });
  }

  private async resolveModeChange(conversationId: string, decision: 'continue' | 'stay'): Promise<void> {
    const pending = this.pendingModeChanges.get(conversationId);
    if (!pending) return;
    this.pendingModeChanges.delete(conversationId);
    if (decision === 'continue') {
      this.postDhaaga(pending.projection.modeChanged('saath_kar'));
      this.continuedProjections.set(conversationId, pending.projection);
      await this.submitComposerMessage({ text: pending.text, mode: 'agent', attachmentIds: pending.attachmentIds, conversationId, model: pending.modelOverride });
      // Changing mode is not the objective. If the confirmed request never became a Core attempt (and nothing already
      // reported why), say so and settle the thread; it must never sit "Working" or read as Completed.
      if (!this.coreActiveAttemptIds.has(conversationId) && this.continuedProjections.get(conversationId) === pending.projection) {
        this.continuedProjections.delete(conversationId);
        this.postDhaaga(pending.projection.terminal('blocked', 'mode_change_not_resumed'));
        this.post({ type: 'error', message: 'Saath Kar did not start the request, so nothing was changed. Send it again to retry.' });
      }
    } else {
      this.postDhaaga(pending.projection.modeChangeDeclined());
      this.continuedProjections.set(conversationId, pending.projection);
      await this.submitComposerMessage({ text: pending.text, mode: 'chat', attachmentIds: pending.attachmentIds, conversationId, model: pending.modelOverride, stayInBaatKar: true });
    }
  }

  /** Karke Dikha: project the task's typed progress events and lifecycle state through the same reducer. */
  /**
   * Open / Reveal / Copy path for an artifact card. The webview only names a task and an artifact id; the path comes from
   * the host's own TaskResult and is re-resolved under the workspace, so a forged message cannot reach another file.
   */
  private async handleTaskResultAction(message: Record<string, unknown>): Promise<void> {
    const result = this.taskResults.get(String(message['taskId'] ?? ''));
    const artifact = result?.artifacts.find(candidate => candidate.id === String(message['artifactId'] ?? ''));
    if (!result || !artifact?.path) return;
    const absolute = resolveUnderRoot(this.workspaceRoot, artifact.path);
    if (!absolute) return;
    const uri = vscode.Uri.file(absolute);
    switch (String(message['action'] ?? '')) {
      case 'open':
        await vscode.commands.executeCommand('vscode.open', uri);
        break;
      case 'reveal':
        await vscode.commands.executeCommand('revealFileInOS', uri);
        break;
      case 'copyPath':
        await vscode.env.clipboard.writeText(absolute);
        break;
      case 'openInBrowser':
        // The person's own click on an artifact the host produced; never launched automatically.
        if (artifact.type === 'html') await this.launchArtifactInBrowser(absolute, artifact.path);
        break;
      case 'preview':
        await this.previewArtifact(absolute, artifact);
        break;
      default:
        break;
    }
  }

  /**
   * Static, scriptless preview of a produced artifact in a side panel, built only from the existing sanitising preview models
   * (core/platform/artifacts/taskResult.ts). Running the page is a different action; this never executes it.
   */
  private async previewArtifact(absolute: string, artifact: Artifact): Promise<void> {
    if (artifact.type !== 'html' && artifact.type !== 'svg' && artifact.type !== 'markdown') return;
    const stat = await fs.promises.stat(absolute);
    if (!stat.isFile() || stat.size > 2_000_000) {
      this.post({ type: 'error', message: `${artifact.title} is too large to preview here. Use Open instead.` });
      return;
    }
    const raw = await fs.promises.readFile(absolute, 'utf8');
    const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
    let html: string;
    if (artifact.type === 'html') html = buildHtmlPreview(raw).srcdoc;
    else if (artifact.type === 'svg') html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><img alt="${escapeHtml(artifact.title)}" style="max-width:100%" src="${buildSvgPreview(raw).dataUrl}"></body></html>`;
    else html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${buildMarkdownPreview(raw).html}</body></html>`;
    const panel = vscode.window.createWebviewPanel('kdArtifactPreview', `Preview · ${artifact.title}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: false, enableForms: false, localResourceRoots: [] });
    panel.webview.html = html;
  }

  /**
   * "Open this html in the browser": an explicit request about a recent artifact is a user-facing artifact action, not a
   * question for the model (which has no browser tool and used to answer that none existed). Returns true when handled.
   */
  private async tryHandleOpenArtifactRequest(text: string, conversationId: string): Promise<boolean> {
    this.rememberNamedHtmlFile(text, conversationId);
    const openInBrowser = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:open|opne|show|launch|view|preview|run)\b[^.?!]*\b(?:in|with|on)\s+(?:the\s+|a\s+|my\s+)?(?:default\s+)?(?:web\s*)?browser\b/i.test(text);
    const openThisHtml = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:open|opne|launch|view|preview)\s+(?:this|that|the|it)\s+(?:html|web\s*page|page)\b/i.test(text);
    if (!openInBrowser && !openThisHtml) return false;
    if (/https?:\/\//i.test(text)) return false;
    this.recentArtifacts.prune(conversationId, relativePath => {
      const absolute = resolveUnderRoot(this.workspaceRoot, relativePath);
      return absolute !== undefined && fs.existsSync(absolute);
    });
    const referent = this.recentArtifacts.resolve(conversationId, text);
    if (referent.status === 'ambiguous') {
      this.post({ type: 'done', content: ambiguousReferentQuestion(referent.candidates) });
      return true;
    }
    let relativePath: string | undefined;
    if (referent.status === 'bound') {
      if (!/\.html?$/i.test(referent.artifact.path)) return false;
      relativePath = referent.artifact.path;
    } else if (!namesExplicitFileInText(text)) {
      // No produced artifact: the one HTML file the person themselves named in this live conversation is an authoritative target.
      const named = this.namedHtmlFiles.get(conversationId);
      if (named && fs.existsSync(path.join(this.workspaceRoot, named))) relativePath = named;
    }
    if (!relativePath) {
      // A pronoun-only open request with nothing to bind is answered here, never handed to a model that has no browser tool.
      if (referent.status === 'none' && /\b(?:that|this|it|the\s+(?:html|page))\b/i.test(text) && !namesExplicitFileInText(text)) {
        this.post({ type: 'done', content: 'I do not have a recent HTML file to open. Name the file (for example `index.html`) and I will open it in your browser.' });
        return true;
      }
      return false;
    }
    const absolute = resolveUnderRoot(this.workspaceRoot, relativePath);
    if (!absolute) return false;
    const launched = await this.launchArtifactInBrowser(absolute, relativePath, false);
    this.post({ type: 'done', content: launched.ok ? `Opened ${relativePath} in your browser.` : launched.message });
    return true;
  }

  /** The single HTML file the person named in their latest message, if it exists under the workspace. Live conversation only. */
  private rememberNamedHtmlFile(text: string, conversationId: string): void {
    const html = extractFileTargets(text).filter(target => target.strong && /\.html?$/i.test(target.text));
    if (html.length !== 1) return;
    const absolute = resolveUnderRoot(this.workspaceRoot, html[0].text);
    if (absolute && fs.existsSync(absolute)) this.namedHtmlFiles.set(conversationId, html[0].text);
  }

  /**
   * Exhaustive file questions ("how many html files", "list all css files", "open all html files in browser") are
   * filesystem facts: a deterministic walk of the workspace, host-side, no model turn, no shell. Semantic retrieval is never
   * used here because it returns only the most relevant files, which silently under-counts "all".
   */
  private async tryHandleWorkspaceFileOp(text: string): Promise<boolean> {
    const plan = planWorkspaceFileOp(text);
    if (!plan || !this.workspaceRoot || hasAffirmativeMutationIntent(text.replace(/\b(?:open|view|preview|show)\b/gi, ''))) return false;
    const found = await findWorkspaceFiles(this.workspaceRoot, plan.extensions);
    if (plan.kind === 'count') {
      this.post({ type: 'done', content: renderCount(plan, found) });
      return true;
    }
    if (plan.kind === 'list') {
      this.post({ type: 'done', content: renderList(plan, found) });
      return true;
    }
    if (!canOpenInBrowser(plan.extensions) || found.files.length === 0 || found.files.length > MAX_BROWSER_OPENS) {
      this.post({ type: 'done', content: renderOpenRefusal(plan, found) });
      return true;
    }
    const outcomes: OpenOutcome[] = [];
    for (const relativePath of found.files) {
      const absolute = resolveUnderRoot(this.workspaceRoot, relativePath);
      if (!absolute) { outcomes.push({ path: relativePath, ok: false, message: 'the path is outside the workspace' }); continue; }
      const launched = await this.launchArtifactInBrowser(absolute, relativePath, false);
      outcomes.push(launched.ok ? { path: relativePath, ok: true } : { path: relativePath, ok: false, message: launched.message });
    }
    this.post({ type: 'done', content: renderOpenReport(plan, found, outcomes) });
    return true;
  }

  /**
   * Launches an already host-resolved artifact path in the OS default handler. No model turn, never automatic. The outcome is
   * reported truthfully: a missing file, a launch the OS refused (`openExternal` resolving false) or a thrown error is an
   * error message, never a silent no-op and never "Opened".
   */
  private async launchArtifactInBrowser(absolute: string, displayPath: string, announceError = true): Promise<{ ok: true } | { ok: false; message: string }> {
    const fail = (message: string): { ok: false; message: string } => {
      if (announceError) this.post({ type: 'error', message });
      return { ok: false, message };
    };
    if (!fs.existsSync(absolute)) return fail(`Could not open ${displayPath} in your browser: the file no longer exists.`);
    try {
      const opened = await vscode.env.openExternal(vscode.Uri.file(absolute));
      return opened ? { ok: true } : fail(`Could not open ${displayPath} in your browser: the operating system did not launch it. Use Open or Reveal instead.`);
    } catch (error) {
      return fail(`Could not open ${displayPath} in your browser: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private feedAutonomousDhaaga(task: { taskId: string; goal: string; state: string; failure?: { classification?: string } | undefined }, events: ReadonlyArray<{ payload: Record<string, unknown> }>, result?: TaskResult): void {
    const runId = `kd-${task.taskId}`;
    let projection = this.dhaagaRuns.get(runId);
    if (!projection) {
      projection = new ExecutionProjection({ runId, mode: 'karke_dikha', request: task.goal });
      this.beginDhaaga(projection);
    }
    for (const event of events) {
      const parsed = parseAutonomousProgressPhase(String(event.payload['progress']));
      this.postDhaaga(projection.autonomousProgress(parsed.kind, parsed.title, parsed.detail));
    }
    const phase = projection.snapshot().phase;
    if (/^waiting_for_(?:approval|proposal_approval|mutation_approval|delivery_approval)$/.test(task.state)) {
      this.postDhaaga(projection.approvalRequested());
    } else if (phase === 'waiting_approval') {
      this.postDhaaga(projection.approvalSettled('unknown'));
    }
    if (task.state === 'completed') {
      // Success must match execution evidence: a runtime "completed" with a missing promised file or failed validation is not green.
      const verdict = result ? terminalOutcomeForResult(result) : { outcome: 'completed' as const, detail: undefined };
      this.postDhaaga(projection.terminal(verdict.outcome, verdict.detail));
    }
    else if (task.state === 'blocked') this.postDhaaga(projection.terminal('blocked', task.failure?.classification ?? 'blocked'));
    else if (task.state === 'failed') this.postDhaaga(projection.terminal('failed', task.failure?.classification ?? 'failed'));
    else if (task.state === 'cancelled') this.postDhaaga(projection.terminal('cancelled'));
  }

  private handleCoreRuntimeEvent(event: RuntimeEventRecord): void {
    if (event.domain === 'execution_quality') {
      const turn = this.coreExecutionTurns.get(event.entityId);
      if (!turn || turn.terminal) return;
      const messages: Record<string, string> = {
        repository_path_corrected: 'Corrected a repository path and continued safely.',
        repository_path_blocked: 'The requested path was unsafe or ambiguous, so it was blocked.',
        loop_detected: 'The current approach was not making progress.',
        strategy_changed: 'The current approach was not making progress. Trying a different strategy.',
        model_escalated: 'Trying a stronger configured model for this task.',
        model_routing_fallback: 'The local model could not complete this step, so the approved cloud fallback model ran it instead.',
      };
      const message = messages[event.eventType];
      if (message) this.post({ type: 'executionQualityProgress', message, details: event.metadata });
      return;
    }
    if (event.domain === 'tool_invocation') {
      const attemptId = event.metadata?.['attemptId'] as string | undefined;
      const turn = attemptId ? this.coreExecutionTurns.get(attemptId) : undefined;
      if (!turn || turn.terminal) return;

      // M39: a governed capability call's tool invocation lives on the
      // capability anchor attempt (core/domain/capabilityDispatch.ts), which
      // has no turn of its own. Core relays it onto this Saath Kar attempt
      // with ids only; the evidence itself is fetched from Core here so the
      // webview renders exactly what Core stored — never a client guess.
      if (event.eventType === 'capability_tool_invocation_completed') {
        const governedTool = String(event.metadata?.['toolName'] ?? '');
        if (turn.mode === 'agent' && (governedTool === 'propose_file_change' || governedTool === 'propose_text_edit')) {
          (turn.mutationRefs ??= []).push({ anchorAttemptId: String(event.metadata?.['anchorAttemptId'] ?? ''), invocationId: event.entityId, toolName: governedTool });
        }
        void this.postGovernedCapabilityToolResult(
          String(event.metadata?.['anchorAttemptId'] ?? ''),
          event.entityId,
          String(event.metadata?.['toolName'] ?? 'unknown_tool'),
          attemptId,
        );
        return;
      }

      if (event.eventType === 'tool_invocation_started') {
        const toolName = String(event.metadata?.['toolName'] ?? 'unknown_tool');
        const args = (event.metadata?.['argsSummary'] as Record<string, unknown>) ?? {};
        turn.toolArgsById.set(event.entityId, { toolName, args });
        turn.tokenBuffer = ''; // mirrors the webview clearing its streaming bubble on toolStart
        this.postDhaaga(turn.projection?.toolStarted(event.entityId, toolName, args));
        this.post({ type: 'toolStart', toolName, args });
      } else if (event.eventType === 'tool_invocation_completed') {
        const cached = turn.toolArgsById.get(event.entityId);
        turn.toolArgsById.delete(event.entityId);
        const toolName = cached?.toolName ?? 'unknown_tool';
        const status = String(event.metadata?.['status'] ?? 'failed');
        const evidence = (event.metadata?.['evidence'] as Record<string, unknown>) ?? {};
        const ok = status === 'succeeded';
        if (turn.mode === 'agent' && toolName === 'workspace_validation') {
          const gates = Array.isArray(cached?.args?.['gates']) ? (cached!.args['gates'] as unknown[]).map(String) : [];
          (turn.validationRuns ??= []).push({ command: gates.join(' && ') || 'workspace validation', ok, exitCode: ok ? 0 : 1 });
        } else if (turn.mode === 'agent' && toolName === 'static_html_check') {
          (turn.structuralRuns ??= []).push({ path: String(cached?.args?.['path'] ?? ''), ok, summary: String(evidence['output'] ?? (ok ? 'Static HTML structure check passed' : 'Static HTML structure check failed')).split('\n')[0].slice(0, 300) });
        }
        this.postDhaaga(turn.projection?.toolFinished(event.entityId, toolName, ok, evidence, cached?.args ?? {}));
        this.post({
          type: 'toolResult',
          toolName,
          ok,
          result: ok ? evidence : undefined,
          error: ok ? undefined : (evidence['output'] ?? status),
          blocked: undefined,
        });
      }
      return;
    }

    if (event.domain !== 'attempt') return;
    if (event.eventType === 'attempt_rerouted') {
      this.adoptCoreRerouteSuccessor(event);
      return;
    }
    const turn = this.coreExecutionTurns.get(event.entityId);
    if (!turn || turn.terminal) return;

    if (event.eventType === 'attempt_reroute_declined') {
      const held = turn.pendingFailure;
      if (held) {
        clearTimeout(held.timer);
        turn.pendingFailure = undefined;
        void this.finishCoreExecutionTurn(turn, 'failed', held.reason);
      }
      return;
    }
    if (event.eventType === 'attempt_transitioned') {
      const to = event.metadata?.['to'] as string | undefined;
      if (to === 'completed') {
        void this.finishCoreExecutionTurn(turn, 'completed');
      } else if (to === 'waiting_for_approval') {
        // M38: the turn stays open (not terminal) — RuntimeExecutor suspended
        // its model loop on a governed-capability approval; show the card the
        // exact same way a restart would restore it, correlated on Core's own
        // conversationId, not `this.conversationId` (see `restoreCapabilityApprovalCards`).
        // Actionable workspace mutations need the independent history
        // projection's exact realAttemptId; the correlation-only projection
        // names only the shared capability anchor and fails closed.
        if (turn.coreConversationId) void this.restoreCapabilityApprovalCards();
        this.postDhaaga(turn.projection?.approvalRequested());
      } else if (to === 'running') {
        this.postDhaaga(turn.projection?.approvalSettled('unknown'));
      }
      // 'running' and other non-terminal transitions need no webview message —
      // the turn is already shown as active from the moment sendToAgent posted it.
    } else if (event.eventType === 'attempt_failed') {
      const reason = String(event.metadata?.['failureReason'] ?? 'execution failed');
      this.recordCloudQuotaFailure(reason);
      // Core decides right after every Baat/Saath failure whether Auto continues on another model (attempt_rerouted)
      // or the failure is final (attempt_reroute_declined). Hold the terminal state for that decision; the timer only
      // guards a Core that never answers.
      if (turn.pendingFailure) return;
      turn.pendingFailure = {
        reason,
        timer: setTimeout(() => {
          if (turn.terminal || !turn.pendingFailure) return;
          turn.pendingFailure = undefined;
          void this.finishCoreExecutionTurn(turn, 'failed', reason);
        }, 5_000),
      };
    } else if (event.eventType === 'attempt_cancelled') {
      void this.finishCoreExecutionTurn(turn, 'cancelled');
    }
  }

  /**
   * Auto continued a failed turn on another model: the same turn (same Dhaaga, same objective) now follows the
   * successor attempt, and the surface says which model failed and which took over.
   */
  private adoptCoreRerouteSuccessor(event: RuntimeEventRecord): void {
    const predecessorId = String(event.metadata?.['predecessorAttemptId'] ?? '');
    const turn = this.coreExecutionTurns.get(predecessorId);
    if (!turn || turn.terminal) return;
    if (turn.pendingFailure) { clearTimeout(turn.pendingFailure.timer); turn.pendingFailure = undefined; }
    this.coreExecutionTurns.delete(predecessorId);
    turn.attemptId = event.entityId;
    turn.tokenBuffer = '';
    this.coreExecutionTurns.set(event.entityId, turn);
    if (this.coreActiveAttemptIds.get(turn.conversationId) === predecessorId) {
      this.coreActiveAttemptIds.set(turn.conversationId, event.entityId);
    }
    const failed = String(event.metadata?.['failedModel'] ?? 'the previous model');
    const next = String(event.metadata?.['selectedModel'] ?? 'another model');
    this.post({
      type: 'executionQualityProgress',
      message: `${failed} could not finish (${String(event.metadata?.['fingerprint'] ?? 'model failure').replace(/_/g, ' ')}); Auto continued on ${next}.`,
      details: event.metadata,
    });
  }

  /** Live token relay — best-effort UX only; `finishCoreExecutionTurn` fetches
   * the durable assistant message as the authoritative `done` content, so a
   * client that misses frames here (e.g. across a reconnect) never loses text. */
  private handleCoreRuntimeToken(frame: RuntimeTokenFrame): void {
    const turn = this.coreExecutionTurns.get(frame.attemptId);
    if (!turn || turn.terminal) return;
    turn.tokenBuffer += frame.delta;
    this.postDhaaga(turn.projection?.modelActivity());
    // Only Baat Kar's single answer streams into the conversation. In a tool-calling turn the text between tool calls
    // is the model's own working narration ("Let me...", "Now I'll..."); it belongs to the Dhaaga, and the final
    // answer arrives once as the durable `done` message.
    if (turn.mode === 'chat') this.post({ type: 'token', delta: frame.delta });
  }

  /**
   * Terminal handling for a Core-owned turn: marks it terminal and removes it
   * from `coreExecutionTurns` (so any further/duplicate event for this
   * attempt is ignored), posts the corresponding webview message, and runs
   * the same completion bookkeeping (`postTaskSnapshot`/`postOperationsSnapshot`/
   * permission-state reset) the legacy path ran in its `finally` block.
   */
  private async finishCoreExecutionTurn(
    turn: CoreExecutionTurn,
    outcome: 'completed' | 'failed' | 'cancelled',
    detail?: string,
  ): Promise<void> {
    const epoch = this.conversationEpoch;
    turn.terminal = true;
    // "Completed" means the requested objective was satisfied, which the runtime cannot know from a finished model call
    // alone: read the durable answer first, then project the honest terminal outcome.
    const assistant = outcome === 'completed' ? await this.fetchLatestCoreAssistantProjection(turn.coreConversationId, turn.tokenBuffer) : undefined;
    if (epoch !== this.conversationEpoch) return;
    let ending: { outcome: TerminalOutcome; detail?: string } = assistant
      ? classifyTerminalOutcome({
        hostOutcome: turn.hostFacts?.outcome,
        measured: turn.hostFacts?.measured,
        evidenceGap: turn.evidenceGap,
        baatKarRepositoryTurn: turn.mode === 'chat' && Boolean(turn.repositoryTurn),
        answer: assistant.content,
      })
      : { outcome, detail };
    // Saath Kar: the same evidence-backed result Karke Dikha gets, built from what Core recorded and the disk (never from
    // the model's prose). A "completed" turn whose recorded validation failed is not shown as green.
    // (Awaited only for Saath Kar: a Baat Kar turn keeps exactly its previous ordering.)
    const saathResult = turn.mode === 'agent' ? await this.assembleSaathTurnResult(turn, outcome, detail) : undefined;
    if (turn.mode === 'agent' && epoch !== this.conversationEpoch) return;
    if (saathResult && ending.outcome === 'completed' && saathResult.status !== 'completed') {
      const verdict = terminalOutcomeForResult(saathResult);
      ending = { outcome: verdict.outcome, ...(verdict.detail ? { detail: verdict.detail } : {}) };
    }
    this.postDhaaga(turn.projection?.terminal(ending.outcome, ending.detail));
    this.coreExecutionTurns.delete(turn.attemptId);
    if (this.coreActiveAttemptIds.get(turn.conversationId) === turn.attemptId) {
      this.coreActiveAttemptIds.delete(turn.conversationId);
    }

    if (assistant) {
      // The streamed bubble is only an optimistic display. Attach the durable
      // message identity and its Core-owned alternative group at completion so
      // it gains the same Branch/Regenerate/Answer controls as a restored
      // transcript; otherwise a live regenerated response cannot be selected
      // or regenerated again until a later webview recreation.
      this.post({ type: 'done', content: assistant.content, messageId: assistant.messageId, alternatives: assistant.alternatives, outcome: ending.outcome, runId: turn.projection?.snapshot().runId, epoch });
      // Durable Conversational Continuity V1: keep a short record of what this
      // turn concluded so a later "what did you find?" / "continue" resumes
      // from something concrete. Bounded summary only — never the full answer.
      await this.recordTurnFindings(assistant.content, turn.coreConversationId, turn.conversationId);
    } else if (outcome === 'failed') {
      this.post({ type: 'error', message: detail ?? 'execution failed' });
    } else {
      this.post({ type: 'stopped' });
    }

    if (saathResult) {
      this.taskResults.set(turn.attemptId, saathResult);
      this.recentArtifacts.recordResult(turn.conversationId, turn.attemptId, 'saath_kar', saathResult);
      this.post({ type: 'taskResult', taskId: turn.attemptId, taskResult: saathResult });
    }

    await this.finishActiveTurnBookkeeping(turn.conversationId);
  }

  /** Builds a Saath Kar turn's TaskResult from Core's recorded tool invocations and the real filesystem. Never throws. */
  private async assembleSaathTurnResult(turn: CoreExecutionTurn, outcome: 'completed' | 'failed' | 'cancelled', detail?: string): Promise<TaskResult | undefined> {
    if (turn.mode !== 'agent') return undefined;
    const refs = turn.mutationRefs ?? [];
    if (refs.length === 0 && !(turn.validationRuns?.length) && !(turn.structuralRuns?.length)) return undefined;
    try {
      const client = getCoreManager()?.getClient();
      const mutations: SaathTurnEvidence['mutations'] = [];
      const byAnchor = new Map<string, Awaited<ReturnType<NonNullable<typeof client>['listToolInvocations']>>['toolInvocations']>();
      for (const ref of refs) {
        if (!client || !ref.anchorAttemptId) continue;
        if (!byAnchor.has(ref.anchorAttemptId)) byAnchor.set(ref.anchorAttemptId, (await client.listToolInvocations(ref.anchorAttemptId)).toolInvocations);
        const invocation = byAnchor.get(ref.anchorAttemptId)?.find(entry => entry.id === ref.invocationId);
        if (!invocation) continue;
        const evidence = (invocation.evidence ?? {}) as Record<string, unknown>;
        const args = ((evidence['normalizedArguments'] as Record<string, unknown> | undefined) ?? invocation.argsSummary ?? {}) as Record<string, unknown>;
        const changedPath = String(args['path'] ?? '').replace(/\\/g, '/');
        if (!changedPath) continue;
        mutations.push({ path: changedPath, ok: invocation.status === 'succeeded', ...(this.saathProposedOperations.has(changedPath) ? { operation: this.saathProposedOperations.get(changedPath) } : {}) });
      }
      const snapshot = turn.projection?.snapshot();
      return assembleSaathTaskResult({
        attemptId: turn.attemptId,
        outcome,
        ...(outcome === 'failed' && detail ? { failureMessage: detail } : {}),
        ...(snapshot && 'model' in snapshot && typeof (snapshot as { model?: unknown }).model === 'string' ? { model: (snapshot as { model: string }).model } : {}),
        mutations,
        validations: turn.validationRuns ?? [],
        structuralChecks: turn.structuralRuns ?? [],
      }, { workspaceRoot: this.workspaceRoot });
    } catch (error) {
      // The card is derived evidence; it must never break the authoritative turn ending.
      Logger.warn('[AgentPanel] Could not assemble the Saath Kar task result:', error);
      return undefined;
    }
  }

  /** The durable assistant message is the source of truth for `done.content`
   * (survives a reconnect that missed live token frames); `fallback` (the
   * locally-accumulated token buffer) is used only if the fetch itself fails. */
  private async fetchLatestCoreAssistantProjection(
    coreConversationId: string | undefined,
    fallback: string,
  ): Promise<{ content: string; messageId?: string; alternatives: ResponseAlternativeRecord[] }> {
    if (!coreConversationId) return { content: fallback, alternatives: [] };
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    if (!client) return { content: fallback, alternatives: [] };
    try {
      const [{ messages }, { alternatives }] = await Promise.all([
        client.listMessages(coreConversationId),
        client.listResponseAlternatives(coreConversationId),
      ]);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          const own = alternatives.find(alternative => alternative.assistantMessageId === messages[i].id);
          return {
            content: messages[i].content,
            messageId: messages[i].id,
            alternatives: own ? alternatives.filter(alternative => alternative.userMessageId === own.userMessageId) : [],
          };
        }
      }
      return { content: fallback, alternatives: [] };
    } catch (error) {
      console.error('[OllamaAgent] failed to fetch durable assistant projection for done message:', error);
      return { content: fallback, alternatives: [] };
    }
  }

  private async finishActiveTurnBookkeeping(runId: string): Promise<void> {
    if (this.activePermissionRunId === runId) {
      this.activePermissionRunId = undefined;
      this.selectedPermissionContext = createDefaultPermissionContext();
    }
    if (runId) { await this.postTaskSnapshot(runId); }
    await this.postOperationsSnapshot();
    this.postPermissionState();
  }

  /**
   * M32 correction (cancellation): routes `stopGeneration` through Core's
   * existing `cancelAttempt` capability, which reaches the real in-Core
   * `AbortController` (`core/runtime/executor.ts`), instead of the legacy
   * local `AgentRuntime.stop()`. The 'stopped' webview message and
   * completion bookkeeping are posted once Core confirms the cancellation via
   * an `attempt_cancelled` runtime_event (see `handleCoreRuntimeEvent`), not
   * synchronously here.
   */
  private async stopActiveCoreExecution(): Promise<void> {
    const runId = this.activePermissionRunId;
    const attemptId = runId ? this.coreActiveAttemptIds.get(runId) : undefined;
    if (!attemptId) {
      // Nothing Core-tracked is running — reset UI state defensively so a
      // stray stop click is always a safe no-op, matching the prior behavior.
      this.activePermissionRunId = undefined;
      this.selectedPermissionContext = createDefaultPermissionContext();
      this.postPermissionState();
      return;
    }
    const client = getCoreManager()?.getClient();
    if (!client) return;
    try {
      await client.cancelAttempt(attemptId);
    } catch (error) {
      console.error('[OllamaAgent] failed to cancel Core attempt:', error);
    }
  }

  private createConversation(id: string, firstMessage: string): void {
    const conversation: Conversation = {
      id,
      title: firstMessage.length > 50 ? `${firstMessage.substring(0, 50)}…` : firstMessage,
      model: Config.getModel(),
      messages: [{ role: 'user', content: firstMessage }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.conversations.set(id, conversation);
    this.post({ type: 'conversationCreated', conversation });
  }

  private updateConversation(id: string, message: string): void {
    const conversation = this.conversations.get(id);
    if (conversation) {
      conversation.messages.push({ role: 'user', content: message });
      conversation.updatedAt = Date.now();
      this.post({ type: 'conversationUpdated', conversation });
    }
  }

  /**
   * M32 conversation durability: gets or creates the Core-owned conversation
   * backing this webview conversationId, for either Baat Kar or Saath Kar.
   * Returns undefined (never throws) when Core is unreachable — the caller
   * (`sendToAgent`) treats that as a hard failure to start execution (Core is
   * now the sole executor for these modes, not just a durability shadow), but
   * this helper itself stays best-effort/non-throwing so its cache lookup is
   * safe to call from anywhere.
   */
  private async ensureCoreConversation(
    conversationId: string,
    _mode: 'baat_kar' | 'saath_kar',
    firstMessage?: string,
  ): Promise<string | undefined> {
    const cacheKey = `ledger:${conversationId}`;
    const cached = this.coreConversationIds.get(cacheKey)
      ?? this.coreConversationIds.get(`baat_kar:${conversationId}`)
      ?? this.coreConversationIds.get(`saath_kar:${conversationId}`);
    if (cached) return cached;
    const client = (this.coreManager ?? getCoreManager())?.getClient();
    if (!client) return undefined;
    try {
      // A visible conversation is one container across all three modes. Its
      // per-turn mode lives on requests/conversation_turns.
      const conversation = await client.createConversation({
        mode: 'baat_kar',
        repositoryId: null,
        title: firstMessage ? truncateConversationTitle(firstMessage) : null,
      });
      this.coreConversationIds.set(cacheKey, conversation.id);
      const snapshot = await client.bindWorkspaceConversation({
        workspaceIdentity: this.workspaceIdentity,
        localConversationId: conversationId,
        conversationId: conversation.id,
        title: conversation.title,
        makeCurrent: true,
      });
      this.applyConversationLedger(snapshot, true);
      await this.persistWorkspaceConversationState(conversationId);
      return conversation.id;
    } catch (error) {
      console.error('[OllamaAgent] failed to establish the workspace conversation ledger:', error);
      return undefined;
    }
  }

  private static coreKindFor(mode: AgentMode): 'baat_kar' | 'saath_kar' {
    return mode === 'chat' ? 'baat_kar' : 'saath_kar';
  }

  // --- M32 correction Phase 3: Karke Dikha (M15 autonomous task) dual-authority removal ---

  /**
   * Unified Conversation V1 — computes the narrow trusted-dirty baseline (see
   * src/orchestration/TrustedDirtyProvenance.ts) for a Karke Dikha task about
   * to start in THIS conversation. Returns `undefined` (never an empty array
   * used as a signal) whenever the workspace is clean, Core/git is
   * unavailable, or verification fails for any reason — in every one of
   * those cases the existing, unmodified `workspace_dirty` protection
   * continues to apply exactly as before at delivery time. Never guesses:
   * every dirty tracked path must independently verify against Core's own
   * durable approval records for this exact conversation.
   */
  private async computeTrustedDirtyBaseline(coreConversationId: string): Promise<AutonomousTask['trustedDirtyBaseline']> {
    if (!this.workspaceRoot) return undefined;
    const client = getCoreManager()?.getClient();
    if (!client) return undefined;
    try {
      const status = await CommandService.runGit(['status', '--porcelain'], this.workspaceRoot);
      if (status.exitCode !== 0) return undefined;
      const dirtyTrackedPaths = status.stdout
        .split(/\r?\n/)
        .filter((line) => line.length > 0 && !line.startsWith('??'))
        .map((line) => line.slice(3).trim().replace(/\\/g, '/'));
      if (dirtyTrackedPaths.length === 0) return undefined;

      const snapshot = await client.listCapabilityActions(coreConversationId);
      const approvedMutations: ApprovedFileMutationRecord[] = snapshot.actions
        .filter((action) => action.kind === 'mutation' && action.toolName === 'propose_file_change')
        .map((action) => ({
          approvalId: action.approvalId,
          path: String((action.arguments as Record<string, unknown>)?.['path'] ?? ''),
          content: String((action.arguments as Record<string, unknown>)?.['content'] ?? ''),
          resolvedAt: action.resolvedAt ?? action.requestedAt,
          status: action.status === 'approved' ? 'approved' as const : action.status === 'rejected' ? 'rejected' as const : 'pending' as const,
          conversationId: coreConversationId,
        }));

      const verification = verifyTrustedDirtyProvenance({
        conversationId: coreConversationId,
        dirtyTrackedPaths,
        readCurrentFile: (relPath) => {
          try { return fs.readFileSync(path.join(this.workspaceRoot!, relPath), 'utf8'); } catch { return null; }
        },
        approvedMutations,
      });
      if (!verification.trusted) return undefined;
      return verification.paths.map((entry) => ({ path: entry.path, sha256: entry.sha256, approvalId: entry.approvalId, content: entry.content }));
    } catch {
      return undefined;
    }
  }

  /**
   * Submits a Karke Dikha task to Core via the single atomic `POST /v1/submit`
   * path *before* the M15 task exists, so Core's request/attempt is the one
   * authoritative identity this submission is recorded under — never a
   * separate identity invented independently by the Extension Host. Core
   * unavailability/rejection fails closed; success includes the claimed fence
   * adapter that every M15 worker callback must use.
   */
  private async submitKarkeDikhaRequest(goal: string, modelOverride?: string): Promise<CoreKarkeDikhaSubmission> {
    const client = getCoreManager()?.getClient();
    if (!client) return { outcome: 'rejected' };
    try {
      const coreConversationId = await this.ensureCoreConversation(this.conversationId, 'baat_kar', goal);
      if (!coreConversationId) return { outcome: 'rejected' };
      const generativeSelection = await this.selectModelForTask(goal, 'karke_dikha', modelOverride);
      const profile = classifyExecutionProfile(goal, {
        repositoryExploration: true,
        toolCalling: true,
        fileMutation: true,
        validationRepair: true,
      });
      // A trivial exact-content write is a host-owned deterministic route.
      // Do not freeze/announce a 30B model as selected when no model will run.
      // Retain the normal selection only as an explicit escalation candidate;
      // if deterministic binding fails, the existing bounded escalation path
      // can use it and will then record the real generative routing decision.
      const modelSelection: ModelSelectionEvidence = profile.useDeterministicProposal && !modelOverride
        ? {
            ...generativeSelection,
            selectedProvider: 'host',
            selectedModel: 'deterministic',
            selectionReason: 'The trivial exact-content execution profile uses the deterministic host proposal route; no model is selected.',
            suitabilitySummary: 'Using the deterministic exact-content route',
            userOverrode: false,
            candidates: [
              {
                provider: 'host',
                model: 'deterministic',
                available: true,
                capable: true,
                costRank: 0,
                rejectionReasons: [],
              },
              ...generativeSelection.candidates,
            ],
            escalationCandidates: [
              {
                provider: generativeSelection.selectedProvider,
                model: generativeSelection.selectedModel,
                reason: 'Available only if the deterministic exact-content route produces bounded escalation evidence.',
              },
              ...generativeSelection.escalationCandidates.filter(candidate =>
                candidate.provider !== generativeSelection.selectedProvider
                || candidate.model !== generativeSelection.selectedModel),
            ],
          }
        : generativeSelection;
      this.post({ type: 'modelSuitability', summary: modelSelection.suitabilitySummary, details: modelSelection });
      this.postOperatorContext(modelSelection.selectedModel);
      const result = await client.submit({
        currentMessage: goal,
        requestedMode: 'karke_dikha',
        conversationId: coreConversationId,
        workspaceRoot: this.workspaceRoot,
        requestedProvider: modelSelection.selectedProvider,
        requestedModel: modelSelection.selectedModel,
        modelSelection,
        toolPermissionPolicy: { profile: this.selectedPermissionContext.profileId },
        hasWorkspace: true,
        gitCapable: true,
      });
      const owner = `m15-worker-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const claim = await client.claimKarkeDikhaAttempt(result.attempt.id, { owner });
      const credentials = { fenceToken: claim.fence.token, owner, frozenContextHash: claim.context.contextHash };
      const authority = this.createKarkeDikhaAuthority(client, result.attempt.id, claim.context, credentials);
      return { outcome: 'submitted', requestId: result.request.id, attemptId: result.attempt.id, authority };
    } catch (error) {
      // A TaskModelSelectionError is thrown by local model selection
      // (selectModelForTask, above) *before* client.submit() is ever called —
      // Core was never contacted, so this must never be reported as a Core
      // rejection. Preserve its typed code/message/rejectedCandidates as-is.
      if (error instanceof TaskModelSelectionError) {
        return { outcome: 'model_selection_failed', code: error.code, message: error.message, rejectedCandidates: error.rejectedCandidates };
      }
      console.error('[OllamaAgent] Core rejected Karke Dikha submission:', error);
      return { outcome: 'rejected' };
    }
  }

  private async retryBlockedAttempt(
    predecessorAttemptId: string,
    strategy: 'same_model' | 'stronger_model' | 'with_guidance',
    guidance?: string,
  ): Promise<void> {
    if (!this.autonomousQueue || !this.autonomousRuntime) return;
    if (this.karkeDikhaRetryInFlight.has(predecessorAttemptId)) return;
    const client = getCoreManager()?.getClient();
    if (!client) {
      this.post({ type: 'error', message: 'Core is unavailable, so this attempt cannot be retried safely.' });
      return;
    }
    this.karkeDikhaRetryInFlight.add(predecessorAttemptId);
    try {
      const eligibility = await client.getAttemptRetryEligibility(predecessorAttemptId);
      if (!eligibility.eligible) throw new Error(eligibility.reason ?? 'This blocker is not safe to retry automatically.');
      const predecessorContext = await client.getAttemptContext(predecessorAttemptId);
      let selectedModel = predecessorContext.selectedModel;
      let modelSelection = predecessorContext.modelSelection;
      if (strategy === 'stronger_model') {
        const stronger = predecessorContext.modelSelection?.escalationCandidates.find(candidate =>
          candidate.provider === predecessorContext.selectedProvider && candidate.model !== predecessorContext.selectedModel,
        );
        if (!stronger) throw new Error('No stronger configured model is available on the current provider.');
        selectedModel = stronger.model;
        if (modelSelection) {
          // The predecessor's frozen window belongs to the model it selected;
          // the stronger model gets its own resolution (or none, never a stale one).
          // Its routing explanation described the predecessor's model, so it is dropped with the window.
          const { contextWindowTokens: _staleWindow, contextWindowSource: _staleSource, routing: _staleRouting, ...withoutWindow } = modelSelection;
          modelSelection = {
            ...withoutWindow,
            selectedModel,
            selectionReason: `Retrying with a stronger coding model: ${stronger.reason}`,
            suitabilitySummary: 'Retrying with a stronger coding model',
            userOverrode: false,
            escalationCandidates: modelSelection.escalationCandidates.filter(candidate => candidate.model !== selectedModel),
            ...frozenContextWindowEvidence({
              model: selectedModel,
              providerType: predecessorContext.selectedProvider,
              maxOutputTokens: Config.getMaxOutputTokens() || undefined,
            }),
          };
        }
      }
      const successor = await client.retryAttempt(predecessorAttemptId, {
        strategy,
        guidance,
        selectedProvider: predecessorContext.selectedProvider,
        selectedModel,
        modelSelection,
      });
      const successorContext = await client.getAttemptContext(successor.id);
      const owner = `m15-worker-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const claim = await client.claimKarkeDikhaAttempt(successor.id, { owner });
      const credentials = { fenceToken: claim.fence.token, owner, frozenContextHash: claim.context.contextHash };
      const authority = this.createKarkeDikhaAuthority(client, successor.id, successorContext, credentials);
      this.autonomousRuntime.bindCoreAuthority(successor.id, authority);
      const predecessorTask = await this.autonomousQueue.get(predecessorAttemptId);
      const destinationBranch = predecessorTask?.destinationBranch ?? await resolveLocalTaskDestinationBranch(this.workspaceRoot);
      const repositoryHeadAtStart = await resolveLocalTaskRepositoryHead(this.workspaceRoot);
      const projected = createDefaultAutonomousTask(this.workspaceRoot, successorContext.taskInput, destinationBranch);
      // Task-Scoped Autonomy V1 — a retry continues the same user-authorized
      // work, so it inherits the predecessor task's frozen autonomy mode
      // rather than silently reverting to 'supervised' or picking up
      // whatever the live UI selector currently shows.
      const task = await this.autonomousQueue.enqueue({
        ...projected,
        taskId: successor.id,
        attemptId: successor.id,
        destinationBranch,
        repositoryHeadAtStart,
        autonomyMode: predecessorTask?.autonomyMode ?? 'supervised',
        providerModelRoutingSnapshot: {
          ...projected.providerModelRoutingSnapshot,
          provider: successorContext.selectedProvider,
          model: successorContext.selectedModel,
        },
        githubDelivery: predecessorTask?.githubDelivery ?? await resolveLocalTaskGitHubDelivery(this.workspaceRoot),
      });
      this.autonomousRuntime.wake();
      this.post({
        type: 'autonomousRetryStarted',
        taskId: task.taskId,
        attemptId: task.attemptId,
        predecessorAttemptId,
        message: strategy === 'stronger_model' ? 'Retrying with a stronger coding model' : 'Retrying the previous blocked task',
      });
      this.startAutonomousPolling(task.taskId);
    } catch (error) {
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.karkeDikhaRetryInFlight.delete(predecessorAttemptId);
    }
  }


  /** Capability requirements for a task; shared by Auto/local selection and manual cloud selection. */
  private async taskRequirementsFor(
    goal: string,
    mode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
    hasImageAttachment: boolean,
  ): Promise<TaskRequirements> {
    const executionProfile = classifyExecutionProfile(goal);
    // Same gate the context builder uses, so model selection and context
    // selection cannot disagree about whether this is a repository question.
    const baatRepositoryExploration = mode === 'baat_kar'
      ? this.workspaceAvailable && await this.isRepositoryContextQuestion(goal)
      : false;
    return classifyTaskRequirements(goal, {
      ...(mode === 'karke_dikha'
        ? executionProfile.useDeterministicProposal
          ? {
              repositoryExploration: false,
              toolCalling: false,
              fileMutation: true,
              codingComplexity: 'low' as const,
              minimumContextWindow: 4_096,
              validationRepair: false,
            }
          : {
              repositoryExploration: true,
              toolCalling: true,
              fileMutation: true,
              validationRepair: true,
              codingComplexity: executionProfile.tier === 'complex' ? 'high' as const : executionProfile.tier === 'small' ? 'low' as const : undefined,
            }
        : mode === 'saath_kar'
          ? { repositoryExploration: true, toolCalling: true }
          : mode === 'baat_kar'
            ? {
                repositoryExploration: baatRepositoryExploration,
                toolCalling: false,
                fileMutation: false,
                validationRepair: false,
                codingComplexity: 'none' as const,
              }
            : {}),
      // An explicit read-only objective establishes mutationPolicy=denied:
      // no mode may then require file mutation or validation/repair, so the
      // recorded capability evidence cannot later justify a mutation nudge.
      ...(deriveMutationPolicy(goal) === 'denied'
        ? { fileMutation: false, validationRepair: false, codingComplexity: 'none' as const }
        : {}),
      // A turn with an image attachment must require vision regardless of the
      // text-only heuristic — the caller (sendToAgent) never falls back to
      // text-only processing when the model selection lacks vision.
      ...(hasImageAttachment ? { vision: true } : {}),
    });
  }

  /**
   * Cloud model selection for an exact provider + model. Fails closed: when the provider is unconfigured, unreachable,
   * no longer lists the exact model, or the spend policy forbids it, the turn is refused with a visible reason — it is
   * never rerouted to Ollama or another cloud model. `automaticFallback` marks a pool choice made by Auto.
   */
  private async selectCloudModel(
    goal: string,
    mode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
    providerId: string,
    modelId: string,
    hasImageAttachment: boolean,
    automaticFallback = false,
  ): Promise<ModelSelectionEvidence> {
    const service = cloudProviderServiceFor(this.context.secrets);
    const label = sharedProviderCatalog().get(providerId)?.displayName ?? providerId;
    let inventory = await service.listModels(providerId);
    if (inventory.ok && !inventory.models.some(item => item.modelId === modelId)) inventory = await service.listModels(providerId, { force: true });
    if (!inventory.ok) throw new Error(`${label} model "${modelId}" cannot be used: ${inventory.reason}`);
    const descriptor: ModelDescriptor | undefined = inventory.models.find(item => item.modelId === modelId || item.aliases.includes(modelId));
    if (!descriptor) throw new Error(`${label} does not list "${modelId}". Pick a model from the picker; KarkeDikha will not substitute another one.`);
    const verdict = spendVerdict(Config.getCloudSpendPolicy(), descriptor);
    if (!verdict.allowed) {
      throw new Error(`${verdict.reason} Turn off "Never incur paid usage" in KarkeDikha Setup to use it, or pick a model marked FREE.`);
    }
    if (hasImageAttachment && descriptor.vision !== true) {
      throw new Error(`${descriptor.displayName} (${label}) is not confirmed to support images, so the attachment was not sent. Pick a model with the VISION badge.`);
    }

    // Provider-published facts only; the registry fills the rest from its name-based table, exactly as for any
    // OpenAI-compatible model, and the context window is resolved by the same function dispatch uses.
    const registry = ModelCapabilityRegistry.getInstance();
    if (descriptor.contextWindow) {
      registry.cacheProbedMetadata(modelId, 'openai-compatible', { contextWindow: descriptor.contextWindow });
    }
    const limit = resolveModelContextLimit({
      model: modelId,
      providerType: 'openai-compatible',
      providerMetadata: registry.getProbedMetadata(modelId, 'openai-compatible'),
      userOverride: explicitContextWindowOverride(),
    });
    const capabilities = { ...registry.getCapabilities(modelId, 'openai-compatible'), contextWindow: limit.effectiveLimit };
    const candidate: TaskModelCandidate = {
      provider: providerId,
      model: modelId,
      available: true,
      capabilities,
      configuredRoles: ['chat', 'agent', 'edit', 'reviewer'],
      explicitlyConfigured: true,
      toolProtocol: deriveToolProtocol({ nativeToolCalling: capabilities.tools, providerCapabilities: undefined }),
    };
    const requirements = await this.taskRequirementsFor(goal, mode, hasImageAttachment);
    const selected = selectTaskModel({
      provider: providerId,
      candidates: [candidate],
      requirements,
      userOverride: { provider: providerId, model: modelId },
    });
    Logger.info(`[ModelSelect] model_selected=${selected.selectedModel} provider=${providerId} selection_policy=${automaticFallback ? 'pool' : 'manual'} mode=${mode}`);
    return {
      requiredCapabilities: {
        readOnlyExplanation: requirements.readOnlyExplanation,
        repositoryExploration: requirements.repositoryExploration,
        toolCalling: requirements.toolCalling,
        fileModification: requirements.fileMutation,
        codingComplexity: requirements.codingComplexity,
        contextRequirement: requirements.minimumContextWindow >= 32_768 ? 'large' : requirements.minimumContextWindow >= 8_192 ? 'medium' : 'small',
        vision: requirements.vision,
        validationAndRepair: requirements.validationRepair,
      },
      selectedProvider: providerId,
      selectedModel: modelId,
      selectionReason: automaticFallback
        ? `Local models are unavailable; the free cloud pool chose ${descriptor.displayName} on ${label}. ${selected.reason}`
        : selected.reason,
      suitabilitySummary: selected.suitabilitySummary,
      userOverrode: !automaticFallback,
      belowPreferredConfidence: selected.belowPreferredConfidence,
      normalEligibility: selected.normalEligibility,
      eligibilityReason: selected.eligibilityReason,
      routing: selected.routing,
      ...frozenContextWindowEvidence({
        model: modelId,
        providerType: 'openai-compatible',
        maxOutputTokens: Config.getMaxOutputTokens() || undefined,
      }),
      candidates: [{ provider: providerId, model: modelId, available: true, capable: true, costRank: 1, rejectionReasons: [] }],
      escalationCandidates: [],
      routingPolicy: automaticFallback ? 'local-first-cloud-fallback' : providerId === 'orcarouter' ? 'explicit-orcarouter' : 'explicit-cloud',
      cloudSpend: { ...Config.getCloudSpendPolicy(), modelFreeness: descriptor.freeness },
    };
  }

  /**
   * The free cloud pool as an Auto selection, used only when the local provider cannot list models at all and the user
   * enabled "Use free cloud when needed" (modelRoutingPolicy). The pool ranks connected providers' models by catalog
   * priority under the HARD spend policy: nothing paid or unclassified is ever returned under FREE_ONLY, and when every
   * eligible provider is exhausted the turn stops with a truthful reason instead of charging. A manual pick never
   * reaches here and is never changed by it.
   */
  private async selectCloudFallbackAuto(
    goal: string,
    mode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
    hasImageAttachment: boolean,
  ): Promise<ModelSelectionEvidence | undefined> {
    if (Config.getModelRoutingPolicy() !== 'local-first-cloud-fallback') return undefined;
    const service = cloudProviderServiceFor(this.context.secrets);
    const sink = (this.coreManager ?? getCoreManager())?.getClient();
    if (sink) await service.pushAllToCore(sink);
    const connected = await service.connectedProviderIds();
    if (connected.length === 0) return undefined;
    const { models } = await service.poolModels();
    const preferred: Record<string, string> = {};
    for (const [id, cfg] of Object.entries(Config.getCloudProviderConfigs())) if (cfg.selectedModel) preferred[id] = cfg.selectedModel;
    const legacyModel = Config.getCloudFallbackModel();
    if (legacyModel && connected.includes('orcarouter')) preferred.orcarouter = preferred.orcarouter ?? legacyModel;
    const decision = decidePool({
      models,
      connectedProviders: new Set(connected),
      catalog: sharedProviderCatalog(),
      policy: Config.getCloudSpendPolicy(),
      requirements: { ...(hasImageAttachment ? { vision: true } : {}), ...(mode !== 'baat_kar' ? { tools: true } : {}) },
      quota: service.quota,
      preferredModels: preferred,
    });
    if (decision.kind === 'blocked') {
      throw new Error(`Local models are unavailable and the free cloud pool cannot take this task. ${decision.reason}`);
    }
    const chosen = decision.candidate.descriptor;
    return this.selectCloudModel(goal, mode, chosen.provider, chosen.modelId, hasImageAttachment, true);
  }

  /** A cloud attempt that failed on quota marks that provider exhausted so the pool moves on. */
  private recordCloudQuotaFailure(failureReason: string): void {
    const providerId = providerIdFromQuotaFailure(sharedProviderCatalog(), failureReason);
    if (providerId) cloudProviderServiceFor(this.context.secrets).quota.markExhausted(providerId);
  }

  /** Records a quota/rate failure so the pool skips that provider and the next Auto turn uses another free one. */
  noteCloudFailure(providerId: string, status: number | undefined, message: string): boolean {
    if (!isQuotaFailure(status, message)) return false;
    cloudProviderServiceFor(this.context.secrets).quota.markExhausted(providerId);
    return true;
  }

  /** Deterministic, same-provider selection over models already configured for
   * roles and models reported available by the active provider. Capability
   * eligibility (including context window) is refined with each candidate's
   * measured runtime metadata — see resolveCandidateCapabilities — but no
   * model call is used to select another model. */
  private async selectModelForTask(
    goal: string,
    mode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
    perTurnModelOverride?: string,
    hasImageAttachment = false,
  ): Promise<ModelSelectionEvidence> {
    // A manually picked OrcaRouter model is an exact provider+model choice: it is resolved against OrcaRouter's own
    // inventory and never against Ollama's, so it can neither be dropped as a "stale" local override nor replaced.
    const cloudChoice = decodeCloudModel(perTurnModelOverride);
    if (cloudChoice && sharedProviderCatalog().has(cloudChoice.providerId)) {
      return this.selectCloudModel(goal, mode, cloudChoice.providerId, cloudChoice.modelId, hasImageAttachment);
    }
    const providerType = Config.getProviderType();
    const provider = await ProviderGateway.create(this.context.secrets);
    let availableModels: Awaited<ReturnType<typeof provider.listModels>>;
    try {
      availableModels = await provider.listModels();
    } catch (error) {
      // Local provider unavailable. Only Auto may use the enabled fallback; an explicit local pick stays authoritative.
      if (perTurnModelOverride?.trim() || effectiveModelOverride(perTurnModelOverride)) throw error;
      const fallback = await this.selectCloudFallbackAuto(goal, mode, hasImageAttachment);
      if (!fallback) throw error;
      Logger.info(`[ModelSelect] local provider unavailable; using enabled cloud fallback ${fallback.selectedModel}`);
      return fallback;
    }
    const availableNames = availableModels.map(item => item.name);
    // The current provider inventory is authoritative: a per-turn choice that the provider no longer lists is a stale
    // selection, not a Manual choice, so it must not block Auto.
    const staleOverride = Boolean(perTurnModelOverride?.trim()) && !availableNames.includes(resolveProviderModelId(perTurnModelOverride!.trim(), availableModels));
    if (staleOverride) Logger.warn(`[ModelSelect] ignoring uninstalled per-turn model '${perTurnModelOverride}'; using Auto`);
    perTurnModelOverride = staleOverride ? undefined : perTurnModelOverride;
    const modelOverride = effectiveModelOverride(perTurnModelOverride);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType,
      availableModelNames: availableNames,
      availableModels,
      modelOverride,
      userOverrideContextWindow: explicitContextWindowOverride(),
      hasImages: hasImageAttachment,
      // M50: real benchmark evidence and provider residency evidence. Both are optional and neutral when absent.
      qualificationEvidence: loadQualificationEvidence(
        this.context.globalStorageUri ? path.join(this.context.globalStorageUri.fsPath, QUALIFICATION_EVIDENCE_FILE) : undefined,
      ),
      residentModels: await provider.listResidentModels?.().catch(() => undefined),
    });
    const requirements = await this.taskRequirementsFor(goal, mode, hasImageAttachment);
    const selected = selectTaskModel({
      provider: providerType,
      candidates,
      requirements,
      // Same alias resolution the candidate set used, so an override naming a
      // provider-published alias selects the listed model it denotes.
      userOverride: modelOverride
        ? { provider: providerType, model: resolveProviderModelId(modelOverride, availableModels) }
        : undefined,
      // model:test only: the runner (not the user) forced this model, so registry policy records must not refuse it.
      benchmarkForced: !perTurnModelOverride && benchmarkForcedModel() === modelOverride,
    });
    if (!selected.overridden) {
      // Keep ResolvedModelDefaults current for whichever role this task
      // actually exercised, in addition to loadModels()'s broader refresh —
      // an explicit per-task override is the user's own choice and must never
      // become a remembered "Auto" default for other callers.
      ResolvedModelDefaults.set(mode === 'baat_kar' ? 'chat' : 'agent', selected.selectedModel);
    }
    Logger.info(`[ModelSelect] model_selected=${selected.selectedModel} selection_policy=${selected.overridden ? 'manual' : 'auto'} mode=${mode}`);
    // Activity/debug log only (never the chat UI): per-candidate decision record for Auto, so repeated selection of one model can be audited.
    for (const line of selected.decisionTrace ?? []) Logger.info(`[ModelSelect:trace] ${line}`);
    const costOrder = [...candidates].sort((left, right) => left.model.localeCompare(right.model));
    return {
      requiredCapabilities: {
        readOnlyExplanation: requirements.readOnlyExplanation,
        repositoryExploration: requirements.repositoryExploration,
        toolCalling: requirements.toolCalling,
        fileModification: requirements.fileMutation,
        codingComplexity: requirements.codingComplexity,
        contextRequirement: requirements.minimumContextWindow >= 32_768 ? 'large' : requirements.minimumContextWindow >= 8_192 ? 'medium' : 'small',
        vision: requirements.vision,
        validationAndRepair: requirements.validationRepair,
      },
      selectedProvider: selected.selectedProvider,
      selectedModel: selected.selectedModel,
      selectionReason: selected.reason,
      suitabilitySummary: selected.suitabilitySummary,
      userOverrode: selected.overridden,
      belowPreferredConfidence: selected.belowPreferredConfidence,
      normalEligibility: selected.normalEligibility,
      eligibilityReason: selected.eligibilityReason,
      ...(selected.overridden && benchmarkForcedModel() ? { benchmarkForcedModel: true } : {}),
      // M50: frozen with the selection so resume and restart read the decision back instead of routing again.
      routing: selected.routing,
      // Frozen with the selection so Core budgets context against the window
      // this model is actually dispatched with, and records where it came from.
      ...frozenContextWindowEvidence({
        model: selected.selectedModel,
        providerType,
        maxOutputTokens: Config.getMaxOutputTokens() || undefined,
      }),
      candidates: costOrder.map((candidate, index) => {
        const rejected = selected.rejectedCandidates.find(item => item.provider === candidate.provider && item.model === candidate.model);
        return {
          provider: candidate.provider,
          model: candidate.model,
          available: candidate.available,
          capable: !rejected,
          costRank: index + 1,
          rejectionReasons: [...(rejected?.reasons ?? [])],
        };
      }),
      escalationCandidates: selected.escalationCandidates.map(item => ({
        provider: item.provider,
        model: item.model,
        reason: item.reason,
      })),
    };
  }

  /** Saath Kar only: records a real tool invocation's start/completion as Core
   * evidence. No-op (never throws) when Core is unreachable or there is no
   * active Core attempt for this conversation. */
  private async newConversation(): Promise<void> {
    // FIRST, synchronously: advance the conversation epoch. Any hydration/restore/rehydration started before this
    // point now belongs to a replaced conversation and discards its own output. One click is always enough.
    const epoch = ++this.conversationEpoch;
    this.pendingApprovalCardMessages.length = 0;
    this.resetConversationScopedHostState();
    // New Chat is a hard reset: a foreground Baat/Saath run must not keep
    // streaming, mutating or asking approvals inside the fresh conversation.
    // (No-op when nothing Core-tracked is running. Background Karke Dikha tasks
    // are not cancelled; the webview detaches them from the new conversation.)
    await this.stopActiveCoreExecution();
    if (epoch !== this.conversationEpoch) return;
    const id = createConversationId();
    const priorId = this.conversationId;
    this.conversationId = id;
    this.activeConversationId = id;
    const coreConversationId = await this.ensureCoreConversation(id, 'baat_kar');
    if (this.conversationEpoch !== epoch) return; // a newer New Chat superseded this one; it owns the reset
    if (!coreConversationId) {
      this.conversationId = priorId;
      this.activeConversationId = priorId;
      this.post({ type: 'error', message: 'Could not create a durable conversation while Core is unavailable.' });
      return;
    }
    await this.persistWorkspaceConversationState();
    if (this.conversationEpoch !== epoch) return;
    this.runtime?.clearSession();
    // Detach any Karke Dikha task projected for the previous conversation. The
    // task itself keeps running in the worker (Activity/History still show it);
    // only this panel's chat-surface ownership — polling, projection, steering
    // target, "running" readiness — ends here. Ownership is re-derived by
    // conversation identity on any later reload (taskBelongsToCurrentConversation).
    if (this.autonomousPollTimer) {
      clearInterval(this.autonomousPollTimer);
      this.autonomousPollTimer = undefined;
    }
    this.autonomousActiveTaskId = undefined;
    this.projectedAutonomousTaskId = undefined;
    this.autonomousProjectionGeneration += 1;
    // A new conversation starts with no objective. Continuity is scoped to one
    // conversation, so nothing from the previous one may follow the user here.
    this.conversationWorkingState = null;
    this.pendingTaskContinuity = null;
    this.pendingTaskCandidate = null;
    this.conversationRevalidation = { status: 'unknown' };
    this.conversationControlState = {
      id,
      repository: this.workspaceIdentity,
      resumptionState: 'none',
      continuationAnchor: undefined,
    };
    this.selectedPermissionContext = createDefaultPermissionContext();
    this.resetConversationScopedHostState();
    this.post({ type: 'newConversation', id, reset: true, epoch });
    this.post({ type: 'conversationContinuity', reset: true, epoch });
    this.postPermissionState();
  }

  /** Everything the host remembers about the previous conversation's turns: evidence, referents, projections, mode. */
  private resetConversationScopedHostState(): void {
    this.pendingModeChanges.clear();
    this.continuedProjections.clear();
    this.authoritativeTurnFiles = [];
    this.attachmentRetention.clear();
    this.recentArtifacts.clear();
    this.namedHtmlFiles.clear();
    this.turnArtifactReferent = null;
    this.artifactClarificationAsked.clear();
    this.saathProposedOperations.clear();
    this.repoFastPath.resetConversationState();
    this.dhaagaRuns.clear();
    this.establishedProjects.clear();
    this.conversationReferents.clear();
  }

  private async selectConversation(id: string): Promise<void> {
    if (this.autonomousActiveTaskId && this.conversationId !== id) {
      const active = await this.getOwnedActiveAutonomousTask();
      if (active) {
        this.projectAutonomousTask({ taskId: active.taskId, attemptId: active.attemptId, state: active.state, goal: active.goal, restored: true });
        // A click that changes nothing must say why, never look like a dead button.
        this.post({ type: 'error', message: 'A Karke Dikha task is still running, so this conversation was not opened. Stop or finish the task, then open it from History.' });
        return;
      }
      // The remembered task id was stale (finished or owned elsewhere): it must not turn History into a dead button.
      this.autonomousActiveTaskId = undefined;
    }
    if (this.conversationId !== id) {
      const client = (this.coreManager ?? getCoreManager())?.getClient();
      if (!client) {
        this.post({ type: 'error', message: 'Could not select conversation while Core is unavailable.' });
        return;
      }
      // History is inert: reopening a conversation never reactivates attachments a blocked turn retained.
      this.attachmentRetention.clear(id);
      this.recentArtifacts.clear(id);
      this.namedHtmlFiles.delete(id);
      let snapshot: WorkspaceConversationLedgerSnapshot;
      try {
        snapshot = await client.selectWorkspaceConversation(this.workspaceIdentity, id);
      } catch (error) {
        this.post({ type: 'error', message: `Could not open that conversation: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      this.applyConversationLedger(snapshot, true);
      this.runtime?.clearSession();
      this.conversationId = id;
      this.activeConversationId = id;
      await this.persistWorkspaceConversationState();
      this.selectedPermissionContext = createDefaultPermissionContext();
    }
    this.post({ type: 'conversationSelected', id });
    await this.restoreConversationTranscript(true);
    // Switching conversations re-resolves the objective from the newly-selected
    // conversation's own durable working state — never the previous one's.
    await this.restoreConversationContinuity();
    await this.restoreCapabilityApprovalCards();
    this.postPermissionState();
  }

  private async deleteConversation(id: string): Promise<void> {
    const client = getCoreManager()?.getClient();
    if (!client) {
      this.post({ type: 'error', message: 'Could not delete conversation while Core is unavailable.' });
      return;
    }
    const snapshot = await client.archiveWorkspaceConversation(this.workspaceIdentity, id);
    this.applyConversationLedger(snapshot);
    this.conversations.delete(id);
    this.post({ type: 'conversationDeleted', id });
    await this.persistWorkspaceConversationState();
    await this.loadPersistedConversations();
  }

  stop(): void {
    // Baat Kar/Saath Kar are Core-owned (Correction Phase 4): the legacy
    // `AgentRuntime.stop()` no longer has anything live to stop for those
    // modes, so a Core-owned turn must also be cancelled here or this
    // command-palette entry point silently no-ops during active execution.
    void this.stopActiveCoreExecution();
    this.runtime?.stop();
  }

  async clearSession(): Promise<void> {
    this.runtime?.clearSession();
    const id = createConversationId();
    const priorId = this.conversationId;
    this.conversationId = id;
    const coreConversationId = await this.ensureCoreConversation(id, 'baat_kar');
    if (!coreConversationId) {
      this.conversationId = priorId;
      this.post({ type: 'error', message: 'Could not clear into a new durable conversation while Core is unavailable.' });
      return;
    }
    await this.persistWorkspaceConversationState();
    this.activePermissionRunId = undefined;
    this.selectedPermissionContext = createDefaultPermissionContext();
    this.view?.webview.postMessage({ type: 'clear', conversationId: id });
    this.postPermissionState();
  }

  private post(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * M50 operator context: the workspace, provider and thinking facts for the persistent context strip. Mode, the
   * routed model and status are owned by the webview (mode selector, `modelSuitability`, status flags); governance
   * is a separate, read-only badge. Never throws: a failed lookup leaves the strip's previous values in place.
   */
  private postOperatorContext(selectedModel?: string): void {
    try {
      const providerType = Config.getProviderType();
      this.post({ ...buildOperatorContextMessage({
        workspaceRoot: this.workspaceAvailable ? this.workspaceRoot : undefined,
        providerType,
        baseUrl: Config.getApiBase(),
        ...(selectedModel
          ? {
              profileDisablesNativeThinking: ModelProfileRegistry.resolve(selectedModel, providerType).disableNativeThinking === true,
              providerCapabilities: ModelCapabilityRegistry.getInstance().getProbedMetadata(selectedModel, providerType)?.providerCapabilities,
            }
          : {}),
      }) });
    } catch (error) {
      Logger.error('[AgentPanel] Operator context could not be built:', error);
    }
  }

  /**
   * Used by every approval-card call site (`rehydrateResolvedApprovalCards`,
   * `reconcileStaleApprovalCards`, `surfaceProposalApproval`,
   * `surfaceMutationApproval`, `surfaceDeliveryApproval`,
   * `approveAutonomousDelivery`, `rejectAutonomousDelivery`) instead of
   * `post` directly. See the `webviewReady`/`pendingApprovalCardMessages`
   * field comment for the full race this closes: queuing here (rather than
   * posting immediately and risking a silent drop before the webview's
   * script has attached its `message` listener) guarantees a card decided
   * upon before readiness is still delivered, in the same order it was
   * decided, the instant `webviewReady` arrives — without ever touching the
   * surfaced*Cards/resolved*Cards bookkeeping those methods already use to
   * guarantee each card is requested/resolved at most once.
   *
   * M39 correction: this discipline now also covers the two durable
   * RESTORATION messages `resolveWebviewView` fires immediately —
   * `restoreTranscript` (`restoreConversationTranscript`) and
   * `restoreCapabilityApprovalCard` (`postCapabilityApprovalCard`). Both were
   * posted with the raw `post()` while `webviewReady` was still false, so
   * whenever the Core read happened to resolve before the webview script
   * attached its `message` listener the message was silently dropped — and
   * because both call sites are one-shot (the webview's own
   * `transcriptRestored` flag and the panel's `surfacedCapabilityApprovalCards`
   * set each suppress a second attempt), the loss was permanent for that
   * webview: an empty transcript and missing approval cards after a restart,
   * intermittently. This was the root cause of a flaky packaged
   * restart-restoration failure.
   */
  private postApprovalCardMessage(msg: Record<string, unknown>, epoch: number = this.conversationEpoch): void {
    if (epoch !== this.conversationEpoch) return; // belongs to a conversation that New Chat already replaced
    const stamped = { ...msg, epoch };
    if (!this.webviewReady) {
      this.pendingApprovalCardMessages.push(stamped);
      return;
    }
    this.post(stamped);
  }

  private flushPendingApprovalCardMessages(): void {
    if (!this.webviewReady) return;
    const queued = this.pendingApprovalCardMessages.splice(0, this.pendingApprovalCardMessages.length);
    for (const msg of queued) {
      if (typeof msg['epoch'] === 'number' && msg['epoch'] !== this.conversationEpoch) continue;
      this.post(msg);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    if (Config.getUiV2Enabled()) {
      return this.buildHtmlV2(webview);
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.js'));
    const pandaBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'panda'));

    const htmlPath = path.join(this.context.extensionUri.fsPath, 'media', 'chat.html');
    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      html = '<html><body>Error loading UI</body></html>';
    }

    return html
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cssUri}}/g, cssUri.toString())
      .replace(/{{jsUri}}/g, jsUri.toString())
      .replace(/{{pandaBaseUri}}/g, pandaBaseUri.toString())
      .replace(/{{modelName}}/g, Config.getModel());
  }

  /**
   * UI v2 shell (strangler migration, Phase 1). Loads the bundled React app
   * built by esbuild.webview-v2.js from out/webview-v2/. Falls back to the
   * legacy shell with an inline error message if the bundle hasn't been
   * built yet, since `npm run bundle:webview-v2` is a separate build step.
   */
  private buildHtmlV2(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const bundleDir = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview-v2');
    const jsPath = path.join(bundleDir.fsPath, 'webview.js');
    const cssPath = path.join(bundleDir.fsPath, 'webview.css');

    if (!fs.existsSync(jsPath)) {
      return '<html><body>UI v2 bundle not found. Run <code>npm run bundle:webview-v2</code>.</body></html>';
    }

    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(bundleDir, 'webview.js'));
    const cssUri = fs.existsSync(cssPath)
      ? webview.asWebviewUri(vscode.Uri.joinPath(bundleDir, 'webview.css'))
      : undefined;
    const pandaBaseUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panda'),
    );

    const htmlPath = path.join(this.context.extensionUri.fsPath, 'media', 'chat-v2.html');
    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      html = '<html><body>Error loading UI v2</body></html>';
    }

    return html
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{cssUri}}/g, cssUri?.toString() ?? '')
      .replace(/{{jsUri}}/g, jsUri.toString())
      .replace(/{{pandaBaseUri}}/g, pandaBaseUri.toString());
  }

  show(): void {
    this.view?.show();
  }
}


export function requiresWorkspaceForMode(mode: AgentMode, workspaceAvailable: boolean): boolean {
  return !workspaceAvailable && mode !== 'chat';
}

/**
 * Truthful, state-specific text for why Baat Kar/Saath Kar can't submit right
 * now. Replaces one generic "please wait for it to reconnect" string that was
 * actively false for a deterministic dead end (`authentication_failed`) and
 * uninformative for every other case — see CoreManager's own reconnect loop
 * for what actually recovers on its own vs. what needs the user to act.
 */
export function describeCoreUnavailableForBaat(status: CoreConnectionStatus | undefined): string {
  switch (status?.state) {
    case 'starting':
      return 'KarkeDikha Core is starting. This usually takes a few seconds — try again in a moment.';
    case 'reconnecting':
      // No counters, no backoff figures: the operator needs to know it is
      // reconnecting and what to do if it does not come back.
      return 'KarkeDikha Core is not answering. Pandesh is reconnecting in the background; '
        + 'if it does not come back, use "KarkeDikha: Restart KarkeDikha Core".';
    case 'disconnected':
      return 'KarkeDikha Core stopped answering and Pandesh stopped retrying on its own. '
        + 'Use "KarkeDikha: Restart KarkeDikha Core" to bring it back, then try again.';
    case 'authentication_failed':
      return 'KarkeDikha Core is running under a different session\'s credentials and refused this one. '
        + 'This can happen when another isolated VS Code profile already started a Core on this machine. '
        + 'Close that other session or use "KarkeDikha: Restart KarkeDikha Core", then try again.';
    case 'incompatible':
      return 'KarkeDikha Core is running an incompatible version. Use "KarkeDikha: Restart KarkeDikha Core" to replace it, then try again.';
    case 'database_failed':
      return `KarkeDikha Core failed to start (${status.detail ?? 'database error'}). Use "KarkeDikha: Restart KarkeDikha Core" or check the Core log, then try again.`;
    case 'unavailable':
      return `KarkeDikha Core could not be reached${status.detail ? ` (${status.detail})` : ''}. `
        + 'Use "KarkeDikha: Restart KarkeDikha Core" to bring it back, then try again.';
    default:
      return 'KarkeDikha Core is not connected yet. Try again in a moment, or use "KarkeDikha: Restart KarkeDikha Core".';
  }
}

function createConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncateConversationTitle(value: string): string {
  const normalized = value.trim();
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}

function createWorkspaceIdentity(workspaceRoot: string, workspaceAvailable: boolean): string {
  const resolved = path.resolve(workspaceRoot).replace(/\\/g, '/');
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256')
    .update(`${workspaceAvailable ? 'workspace' : 'no-workspace'}:${normalized}`)
    .digest('hex')
    .slice(0, 24);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
