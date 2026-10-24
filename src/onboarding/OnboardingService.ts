/**
 * Onboarding orchestrator — the I/O boundary for the setup/readiness UX.
 *
 * Gathers real facts through the actual production seams (ProviderReadinessProbe
 * for reachability + model discovery on the configured local provider —
 * Ollama or an OpenAI-compatible server — ModelCapabilityRegistry
 * for capability evaluation, ProviderGateway for cloud fallback configuration
 * state, RuntimeIntelligence for observed runtime profiles) and hands them to
 * the pure `evaluateOnboardingReadiness`. Performs no network calls to any
 * cloud endpoint — cloud fallback status is always read from local
 * settings/SecretStorage, never probed.
 */
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { ProviderGateway, CloudFallbackRouteResolution } from '../providers/ProviderGateway';
import { ProviderReadinessProbe } from '../diagnostics/ProviderReadiness';
import { TaskModelCandidate } from '../models/TaskModelSelection';
import { buildProductionTaskModelCandidates } from '../models/ProductionModelCandidates';
import { explicitContextWindowOverride } from '../reliability/ModelDispatchPlanner';
import {
  AdvancedSettingsSnapshot,
  CloudFallbackReadiness,
  OnboardingCoreRuntimeStatus,
  OnboardingModeId,
  OnboardingReadiness,
  OrcaRouterReadiness,
  evaluateOnboardingReadiness,
  providerDisplayName,
} from './OnboardingReadiness';
import type { ModelRoutingPolicy } from '../config/ConfigSchema';
import type { CoreConnectionStatus } from '../core-client/ConnectionState';
import { RuntimeIntelligence, type ReprobeResult } from '../runtimeProfile/RuntimeIntelligence';
import type { RuntimeCapabilityProfile } from '../runtimeProfile/RuntimeCapabilityProfile';
import { ollamaRecoveryNumCtxCeiling } from '../../core/runtime/ollamaChatControls';
import { getBuildIdentity } from './BuildIdentity';
import { sanitizeEndpoint } from './OnboardingDiagnostics';
import { orcaRouterServiceFor } from '../providers/OrcaRouter';
import { cloudProviderServiceFor } from '../providers/CloudProviders';
import { computeSystemReadiness } from '../../core/platform/readinessState';
import { collectCapabilityRows } from './CapabilityRegistry';
import { encodeCloudModel, type ModelDescriptor } from '../../core/platform/modelCatalog';
import type { CloudPoolProviderRow, CloudPoolReadiness, SetupModelEntry } from './OnboardingReadiness';

export class OnboardingService {
  /**
   * `getCoreStatus` is injected rather than read from a module-level
   * singleton so this stays a plain, test-constructible class — the real
   * caller (extension.ts) passes `() => coreManager?.getStatus()`. Core
   * connectivity is a hard requirement for every mode (see
   * `AgentPanel.sendToAgent` / `submitKarkeDikhaRequest`, both of which
   * reject outright with no Core client) and must never be conflated with
   * provider/model readiness — a perfect local model is still useless if Core
   * hasn't connected.
   */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly getCoreStatus: () => CoreConnectionStatus | undefined = () => undefined,
    private readonly extensionVersion: string = '0.0.0',
    private readonly runtime: () => RuntimeIntelligence = () => RuntimeIntelligence.shared,
  ) {}

  /** How long Setup waits on the provider before calling it unreachable; the panel must never hang. */
  static readonly PROBE_TIMEOUT_MS = 10_000;

  async assess(): Promise<OnboardingReadiness> {
    const providerType = Config.getProviderType();
    const probe = ProviderReadinessProbe.forSecrets(this.secrets);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OnboardingService.PROBE_TIMEOUT_MS);
    const probeResult = await probe.run(controller.signal).finally(() => clearTimeout(timer));
    const reachable = probeResult.reachability === 'ready';
    const label = providerDisplayName(providerType);
    const providerStatus = { providerType, label, apiBase: sanitizeEndpoint(probeResult.apiBase) };

    const orcaRouter = await this.describeOrcaRouter();
    const cloudResolution = await ProviderGateway.resolveCloudFallback(this.secrets);
    const cloudFallback = describeCloudFallback(cloudResolution, Config.getModelRoutingPolicy());
    const coreRuntime = describeCoreRuntime(this.getCoreStatus());
    const build = getBuildIdentity(this.extensionVersion);
    const advanced = describeAdvancedSettings();

    if (!reachable) {
      return this.finish(evaluateOnboardingReadiness({
        providerType,
        provider: {
          ...providerStatus,
          reachable: false,
          detail: probeResult.reachability === 'cancelled' && controller.signal.aborted
            ? `${label} did not respond within ${OnboardingService.PROBE_TIMEOUT_MS / 1000} seconds.`
            : probeResult.failureReason ?? `The ${label} could not be reached.`,
          nextAction: probeResult.nextAction,
        },
        coreRuntime,
        candidates: [],
        cloudFallback,
        build,
        advanced,
      }), orcaRouter);
    }

    const installedNames = probeResult.availableModelNames ?? [];
    let candidates: TaskModelCandidate[] = [];
    try {
      const provider = await ProviderGateway.create(this.secrets);
      // Same production candidate set AgentPanel.selectModelForTask builds —
      // see ProductionModelCandidates.ts. Configured role settings
      // (ollama-agent.chatModel/agentModel/...) are authoritative for
      // automatic selection (AI_OS_ARCHITECTURE.md, "Local-First Model
      // Routing"); an installed-but-unconfigured model must not be silently
      // promoted to READY here when the real execution path would reject it.
      candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType,
        availableModelNames: installedNames,
        availableModels: probeResult.availableModels,
        userOverrideContextWindow: explicitContextWindowOverride(),
      });
    } catch {
      // Reachability already succeeded above; a failure constructing the
      // provider a second time here is treated conservatively as "no
      // installed models known" rather than surfacing a second error.
      candidates = [];
    }

    // Observed profiles for what is actually installed. Display only: absence of a profile is shown as such and
    // never turns into a rejection (RuntimeCapabilityProfile is advisory).
    const profiles = new Map<string, RuntimeCapabilityProfile>();
    for (const candidate of candidates) {
      if (!candidate.available) continue;
      const profile = await this.runtime().findForModel(providerType, candidate.model).catch(() => undefined);
      if (profile) profiles.set(candidate.model, profile);
    }

    return this.finish(evaluateOnboardingReadiness({
      providerType,
      profiles,
      build,
      advanced,
      provider: { ...providerStatus, reachable: true, detail: `${label} is running and reachable at ${providerStatus.apiBase}.` },
      coreRuntime,
      candidates,
      cloudFallback,
      // Config.getCodingModel() (Auto by default — see Defaults.ts) only ever
      // resolves to a model that discovery already found installed, so it is
      // never a useful "what should I pull" suggestion: if it resolved to
      // something, that something is already usable and this suggestion
      // wouldn't even be shown (see evaluateOnboardingReadiness's
      // `karkeModel.ready ? undefined : ...`). This is the one place a
      // concrete starter model name is still worth naming — a genuinely empty
      // "ollama pull " command is useless guidance for a user with nothing
      // installed at all.
      pullCommandSuggestion: providerType === 'ollama'
        ? `ollama pull ${Config.getCodingModel() || 'qwen2.5-coder:1.5b'}`
        : undefined,
    }), orcaRouter);
  }

  /**
   * Adds the cloud pool, the browsable model list and the system verdict to the evaluated local readiness.
   * Stored configuration and this session's own observations only: opening Setup never contacts a cloud provider.
   */
  private async finish(base: OnboardingReadiness, orcaRouter: OrcaRouterReadiness): Promise<OnboardingReadiness> {
    const service = cloudProviderServiceFor(this.secrets);
    const statuses = await service.statuses();
    const providers: CloudPoolProviderRow[] = statuses.map(status => ({
      id: status.descriptor.id,
      displayName: status.descriptor.displayName,
      connected: status.connected,
      enabled: status.enabled,
      freeTierKind: status.descriptor.freeTier.kind,
      freeTierNote: status.descriptor.freeTier.note,
      paymentRequired: status.descriptor.paymentMethodRequired,
      privacyWarning: status.descriptor.privacyWarning,
      capabilityTags: [...status.descriptor.capabilities],
      host: hostOf(status.baseUrl ?? status.descriptor.baseUrl),
      ...(status.modelCount !== undefined ? { modelCount: status.modelCount, freeCount: status.freeCount } : {}),
      quotaExhausted: status.quotaExhausted,
      ...(status.lastError ? { error: { kind: status.lastError.kind, reason: status.lastError.reason } } : {}),
      requiresAccountId: status.descriptor.requiresBaseUrlInput === true,
      lastVerifiedAt: status.descriptor.lastVerifiedAt,
    }));
    const usable = providers.filter(row => row.connected && row.enabled);
    const available = usable.filter(row => !row.quotaExhausted);
    const spend = Config.getCloudSpendPolicy();
    const useFreeCloud = Config.getModelRoutingPolicy() === 'local-first-cloud-fallback';
    const cloudPool: CloudPoolReadiness = {
      providers,
      localFirst: true,
      useFreeCloud,
      spendMode: spend.mode,
      paidBlocked: spend.mode === 'FREE_ONLY',
      allowCredits: spend.allowCredits === true,
      catalogVersion: service.catalog.version,
      connectedCount: usable.length,
      availableCount: available.length,
      exhaustedIds: usable.filter(row => row.quotaExhausted).map(row => row.id),
    };
    const cloudModels: ModelDescriptor[] = usable.flatMap(row => [...service.models.providerModels(row.id)]);
    const modelEntries: SetupModelEntry[] = [
      ...base.models.filter(model => model.state === 'ready').map((model): SetupModelEntry => ({
        name: model.name,
        ...(model.contextTokens ? { contextWindow: model.contextTokens } : {}),
        ...(model.tools !== 'unknown' ? { tools: model.tools === 'yes' } : {}),
        ...(model.vision !== 'unknown' ? { vision: model.vision === 'yes' } : {}),
      })),
      ...cloudModels.slice(0, 8000).map((model): SetupModelEntry => ({
        name: encodeCloudModel(model.provider, model.modelId),
        label: `${model.modelId} — ${model.providerName} (cloud)`,
        provider: model.provider,
        cloud: true,
        providerName: model.providerName,
        displayName: model.displayName,
        modelId: model.modelId,
        freeness: model.freeness,
        vision: model.vision,
        tools: model.tools,
        coding: model.coding,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      })),
    ];
    const coreState = base.coreRuntime.connected ? 'connected' : base.coreRuntime.state === 'starting' || base.coreRuntime.state === 'reconnecting' ? 'starting' : 'unavailable';
    const system = computeSystemReadiness({
      core: coreState,
      localReachable: base.provider.reachable,
      localUsable: base.provider.reachable && base.modes.some(mode => Boolean(mode.model)),
      cloudConnected: cloudPool.connectedCount,
      cloudAvailable: cloudPool.availableCount,
      useFreeCloud,
    });
    return { ...base, orcaRouter, cloudPool, modelEntries, system, capabilityRows: collectCapabilityRows() };
  }

  /** Stored configuration only; never contacts OrcaRouter. */
  private async describeOrcaRouter(): Promise<OrcaRouterReadiness> {
    const service = orcaRouterServiceFor(this.secrets);
    const config = await service.resolveConfig();
    if (!config) {
      return { configured: false, summary: 'Not set up. Manual cloud models are unavailable until you add an OrcaRouter key.' };
    }
    return {
      configured: true,
      apiBase: sanitizeEndpoint(config.apiBase),
      summary: `Credentials saved for ${sanitizeEndpoint(config.apiBase)}. Its models appear in the model picker; pick one to use it. Nothing is sent unless you do.`,
    };
  }

  /** Reachability only: a health check against the configured endpoint, no model discovery, no model call. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OnboardingService.PROBE_TIMEOUT_MS);
    const endpoint = sanitizeEndpoint(Config.getApiBase());
    try {
      const provider = await ProviderGateway.create(this.secrets);
      await provider.healthCheck(controller.signal);
      return { ok: true, message: `Connected to ${endpoint}.` };
    } catch (error) {
      const reason = controller.signal.aborted
        ? `no response within ${OnboardingService.PROBE_TIMEOUT_MS / 1000}s`
        : error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Could not reach ${endpoint}: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Validates and saves a new provider endpoint. Nothing is contacted until the caller re-checks. */
  async setEndpoint(raw: string): Promise<{ ok: true; endpoint: string } | { ok: false; reason: string }> {
    const candidate = raw.trim();
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return { ok: false, reason: 'Enter a full URL such as http://127.0.0.1:11434.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'The endpoint must start with http:// or https://.' };
    }
    if (url.username || url.password) {
      return { ok: false, reason: 'Credentials do not belong in the endpoint URL.' };
    }
    await Config.setApiBase(candidate);
    return { ok: true, endpoint: Config.getApiBase() };
  }

  /** Bounded re-probe of one model; see `RuntimeIntelligence.reprobe` for the cooldown and de-duplication. */
  async reprobe(model: string): Promise<ReprobeResult> {
    const provider = await ProviderGateway.create(this.secrets);
    return this.runtime().reprobe(provider, model);
  }
}

function hostOf(url: string | undefined): string | undefined {
  try { return url ? new URL(url.replace(/\{[A-Za-z]+\}/g, 'x')).host : undefined; } catch { return undefined; }
}

/**
 * What the advanced knobs really are. Context is the budget KarkeDikha plans against; the Ollama wire `num_ctx`
 * and `num_predict` are set by the Core runtime (implicit server default, `num_predict` unset), so the
 * output figure here is labelled an internal reservation and is never presented as a wire cap.
 */
function describeAdvancedSettings(): AdvancedSettingsSnapshot {
  const context = Config.getContextWindowSetting();
  const output = Config.getMaxOutputTokensSetting();
  const manualOutput = output.explicitlyConfigured && output.value > 0;
  return {
    context: context.explicitlyConfigured ? { kind: 'manual', tokens: context.value } : { kind: 'auto' },
    outputReservation: manualOutput ? { kind: 'manual', tokens: output.value } : { kind: 'auto' },
    wireOutputCap: 'not_sent',
    reasoning: 'auto',
    recoveryCeiling: ollamaRecoveryNumCtxCeiling(),
  };
}

/**
 * Truthful Core-runtime summary. `undefined` status (CoreManager never
 * constructed, e.g. no `getCoreStatus` injected) is reported as
 * not-connected/unavailable rather than assumed healthy — readiness must
 * fail closed here exactly as it does for the model provider.
 */
function describeCoreRuntime(status: CoreConnectionStatus | undefined): OnboardingCoreRuntimeStatus {
  const state = status?.state ?? 'unavailable';
  const connected = state === 'connected';
  const summary = connected
    ? 'KarkeDikha Core is connected.'
    : coreRuntimeSummaryForState(state, status?.detail);
  return { connected, state, detail: status?.detail, summary };
}

function coreRuntimeSummaryForState(state: CoreConnectionStatus['state'], detail: string | undefined): string {
  switch (state) {
    case 'starting':
    case 'reconnecting':
      return 'KarkeDikha Core is starting.';
    case 'authentication_failed':
      return 'KarkeDikha Core is running under a different session\'s credentials.';
    case 'incompatible':
      return 'KarkeDikha Core is running an incompatible version.';
    case 'database_failed':
      return `KarkeDikha Core failed to start${detail ? ` (${detail})` : ''}.`;
    case 'unavailable':
    default:
      return `KarkeDikha Core could not be reached${detail ? ` (${detail})` : ''}.`;
  }
}

function describeCloudFallback(
  resolution: CloudFallbackRouteResolution,
  policy: ModelRoutingPolicy,
): CloudFallbackReadiness {
  const endpoint = sanitizeEndpoint(Config.getCloudFallbackApiBase()) || undefined;
  const model = Config.getCloudFallbackModel() || undefined;
  if (policy === 'local-only') {
    return {
      policy,
      configured: false,
      summary: 'Off. Repository and task content stays on this machine.',
      endpoint,
      model,
    };
  }
  if (resolution.available) {
    return {
      policy,
      configured: true,
      summary: `On — ${resolution.model} via ${endpoint}. Used only after a recoverable local failure.`,
      endpoint,
      model,
    };
  }
  return {
    policy,
    configured: false,
    reason: resolution.reason,
    summary: incompleteCloudFallbackSummary(resolution.reason),
    endpoint,
    model,
  };
}

function incompleteCloudFallbackSummary(reason: CloudFallbackRouteResolution['reason']): string {
  switch (reason) {
    case 'endpoint_not_configured':
      return 'Requested, but no cloud endpoint is set. Local-only until configured.';
    case 'model_not_configured':
      return 'Requested, but no cloud model is set. Local-only until configured.';
    case 'credential_missing':
      return 'Requested, but no API key is stored. Local-only until configured.';
    case 'spend_policy_blocks':
      return 'Requested, but this model is not known to be free and "Never incur paid usage" is on. Local-only until you pick a free model or allow paid cloud.';
    default:
      return 'Requested, but not fully configured. Local-only until configured.';
  }
}
