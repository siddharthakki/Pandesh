import * as vscode from 'vscode';
import { DEFAULTS } from './Defaults';
import { ModelRoutingPolicy, ProviderType } from './ConfigSchema';
import { ResolvedModelDefaults } from './ResolvedModelDefaults';
import { normalizeSpendMode, type CloudSpendMode, type CloudSpendPolicy } from '../../core/platform/cloudRouting';

/** Non-secret per-provider configuration. Credentials live only in SecretStorage (CredentialStore). */
export interface CloudProviderConfig {
  /** False keeps the stored credential but removes the provider from the pool. */
  enabled?: boolean;
  baseUrl?: string;
  /** Substituted into catalog base URLs that contain `{accountId}`. */
  accountId?: string;
  selectedModel?: string;
}

/** Where a resolved configuration value came from. */
export type ConfigValueSource = 'user' | 'default';

/**
 * A configuration value together with its provenance. `explicitlyConfigured`
 * is true only when the user actually set the value in VS Code settings
 * (global, workspace or folder scope) — never merely because the numeric
 * getter returned a value, and never for the extension's built-in default.
 */
export interface ResolvedConfigValue {
  value: number;
  explicitlyConfigured: boolean;
  source: ConfigValueSource;
}

export class Config {
  private static cfg(resourcePath?: string) {
    return vscode.workspace.getConfiguration(
      'ollama-agent',
      resourcePath ? vscode.Uri.file(resourcePath) : undefined,
    );
  }

  /**
   * Resolves a numeric setting with provenance. Explicitness is derived from
   * `WorkspaceConfiguration.inspect`, which distinguishes user-scoped values
   * from package defaults.
   */
  private static resolveNumberSetting(key: string, builtInDefault: number): ResolvedConfigValue {
    const inspected = this.cfg().inspect<number>(key);
    const userValue =
      inspected?.workspaceFolderValue ??
      inspected?.workspaceValue ??
      inspected?.globalValue;
    if (typeof userValue === 'number' && Number.isFinite(userValue)) {
      return { value: userValue, explicitlyConfigured: true, source: 'user' };
    }
    return { value: builtInDefault, explicitlyConfigured: false, source: 'default' };
  }

  /**
   * `model`/`chatModel`/`agentModel`/`editModel`/`reviewerModel`/
   * `codingModel`/`codingFallbackModel` default to `""` ("Auto" — see
   * Defaults.ts). When the raw setting is unset, these getters fall back to
   * `ResolvedModelDefaults` — the last model discovery actually selected for
   * that role this session — rather than a hardcoded name, so every caller
   * (including the many synchronous, pre-discovery call sites across the
   * codebase) gets a real installed model once discovery has run at least
   * once, and an honest `""` before that, never a fabricated one.
   */
  static getModel(): string {
    return this.cfg().get<string>('model', DEFAULTS.model) || ResolvedModelDefaults.get('chat') || '';
  }

  /**
   * The role models the user has explicitly configured, WITHOUT the Auto-resolved fallbacks the plain getters apply.
   * `getChatModel()` and friends fall back to `ResolvedModelDefaults` (what discovery last picked) so that
   * synchronous callers get a real model name; but a remembered Auto pick is not user configuration. Candidate
   * building must read this instead, otherwise yesterday's Auto choice for a role becomes today's "explicit"
   * assignment, removes that role from every other installed model, and a stronger task can no longer find one.
   */
  static getExplicitRoleModels(): { model: string; chat: string; agent: string; edit: string; coding: string; codingFallback: string; reviewer: string } {
    const raw = (key: string, fallback: string) => this.cfg().get<string>(key, fallback).trim();
    return {
      model: raw('model', DEFAULTS.model),
      chat: raw('chatModel', DEFAULTS.chatModel),
      agent: raw('agentModel', DEFAULTS.agentModel),
      edit: raw('editModel', DEFAULTS.editModel),
      coding: raw('codingModel', DEFAULTS.codingModel),
      codingFallback: raw('codingFallbackModel', DEFAULTS.codingFallbackModel),
      reviewer: raw('reviewerModel', DEFAULTS.reviewerModel),
    };
  }

  /** Feature flag for the React-based UI v2 shell (strangler migration, Phase 1). */
  static getUiV2Enabled(): boolean {
    return this.cfg().get<boolean>('uiV2Enabled', false);
  }

  static getAgentModel(): string {
    return this.cfg().get<string>('agentModel', DEFAULTS.agentModel) || ResolvedModelDefaults.get('agent') || '';
  }

  static getAutocompleteModel(): string {
    return this.cfg().get<string>('autocompleteModel', DEFAULTS.autocompleteModel);
  }

  static getEditModel(): string {
    return this.cfg().get<string>('editModel', DEFAULTS.editModel) || ResolvedModelDefaults.get('edit') || '';
  }

  static getReviewerModel(): string {
    return this.cfg().get<string>('reviewerModel', DEFAULTS.reviewerModel) || ResolvedModelDefaults.get('reviewer') || '';
  }

  static getCodingModel(): string {
    return this.cfg().get<string>('codingModel', DEFAULTS.codingModel) || ResolvedModelDefaults.get('agent') || '';
  }

  static getCodingFallbackModel(): string {
    return this.cfg().get<string>('codingFallbackModel', DEFAULTS.codingFallbackModel) || ResolvedModelDefaults.get('agent') || '';
  }

  static getChatModel(): string {
    return this.cfg().get<string>('chatModel', DEFAULTS.chatModel) || ResolvedModelDefaults.get('chat') || '';
  }

  static async updateChatModel(value: string): Promise<void> {
    await this.cfg().update('chatModel', value, vscode.ConfigurationTarget.Workspace);
  }

  static async setApiBase(value: string): Promise<void> {
    await this.cfg().update('apiBase', value.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
  }

  /** Writes the explicit context-window budget; undefined removes it (Auto). */
  static async setContextWindow(value: number | undefined): Promise<void> {
    await this.cfg().update('contextWindow', value, vscode.ConfigurationTarget.Global);
  }

  static getVisionModel(): string {
    return this.cfg().get<string>('visionModel', DEFAULTS.visionModel);
  }

  static getEmbeddingModel(): string {
    return this.cfg().get<string>('embeddingModel', DEFAULTS.embeddingModel);
  }

  static getApiBase(): string {
    return this.cfg().get<string>('apiBase', DEFAULTS.apiBase).replace(/\/$/, '');
  }

  static getSearxngUrl(): string {
    return this.cfg().get<string>('searxngUrl', DEFAULTS.searxngUrl).trim().replace(/\/$/, '');
  }

  static getMaxIterations(): number {
    return this.cfg().get<number>('maxIterations', DEFAULTS.maxIterations);
  }

  static getMaxToolOutputChars(): number {
    return this.cfg().get<number>('maxToolOutputChars', DEFAULTS.maxToolOutputChars);
  }

  static getMaxFileReadChars(): number {
    return this.cfg().get<number>('maxFileReadChars', DEFAULTS.maxFileReadChars);
  }

  static getAllowOutsideWorkspace(): boolean {
    return this.cfg().get<boolean>('allowOutsideWorkspace', DEFAULTS.allowOutsideWorkspace);
  }

  static getRequireApprovalForWrites(): boolean {
    return this.cfg().get<boolean>('requireApprovalForWrites', DEFAULTS.requireApprovalForWrites);
  }

  static getRequireApprovalForCommands(): boolean {
    return this.cfg().get<boolean>('requireApprovalForCommands', DEFAULTS.requireApprovalForCommands);
  }

  static getEnableAuditLog(): boolean {
    return this.cfg().get<boolean>('enableAuditLog', DEFAULTS.enableAuditLog);
  }

  static getEnableCheckpoints(): boolean {
    return this.cfg().get<boolean>('enableCheckpoints', DEFAULTS.enableCheckpoints);
  }

  static getTrustedAutonomyEnabled(): boolean {
    return this.cfg().get<boolean>('trustedAutonomyEnabled', DEFAULTS.trustedAutonomyEnabled);
  }

  static getProgressHeartbeatMs(): number {
    return this.cfg().get<number>('progressHeartbeatMs', DEFAULTS.progressHeartbeatMs);
  }

  static getSequentialRolesEnabled(): boolean {
    return this.cfg().get<boolean>('sequentialRolesEnabled', DEFAULTS.sequentialRolesEnabled);
  }

  static getMaxReviewerRepairPasses(): number {
    return this.cfg().get<number>('maxReviewerRepairPasses', DEFAULTS.maxReviewerRepairPasses);
  }

  static getProviderType(): ProviderType {
    return this.cfg().get<ProviderType>('providerType', DEFAULTS.providerType);
  }

  /**
   * The repository-data boundary for automatic routing. Fails closed: any
   * unrecognized value is treated as 'local-only'.
   */
  static getModelRoutingPolicy(): ModelRoutingPolicy {
    // Isolated-host/harness pin: can only restrict to local-only, never enable cloud.
    if (process.env.KARKEDIKHA_MODEL_ROUTING_POLICY === 'local-only') {
      return 'local-only';
    }
    const configured = this.cfg().get<string>('modelRoutingPolicy', DEFAULTS.modelRoutingPolicy);
    return configured === 'local-first-cloud-fallback' ? 'local-first-cloud-fallback' : 'local-only';
  }

  /**
   * Persists the routing policy so that what Setup just wrote is what every reader sees. VS Code resolves
   * folder > workspace > user, so a bare Global write is silently shadowed by a workspace value (for example a
   * `.vscode/settings.json` pin) and Setup would keep reporting the old policy after a reload.
   */
  static async setModelRoutingPolicy(value: ModelRoutingPolicy): Promise<void> {
    await this.updateWhereEffective('modelRoutingPolicy', value);
  }

  /** Persists the cloud fallback endpoint/model with the same scope rule as the policy. */
  static async setCloudFallbackEndpointAndModel(endpoint: string, model: string): Promise<void> {
    await this.updateWhereEffective('cloudFallbackApiBase', endpoint);
    await this.updateWhereEffective('cloudFallbackModel', model);
  }

  /** Connected-provider configuration (non-secret) keyed by catalog provider id. */
  static getCloudProviderConfigs(): Record<string, CloudProviderConfig> {
    const raw = this.cfg().get<unknown>('cloudProviders', {});
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, CloudProviderConfig> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id) || typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      out[id] = {
        ...(typeof v.enabled === 'boolean' ? { enabled: v.enabled } : {}),
        ...(typeof v.baseUrl === 'string' ? { baseUrl: v.baseUrl.trim().replace(/\/$/, '') } : {}),
        ...(typeof v.accountId === 'string' ? { accountId: v.accountId.trim() } : {}),
        ...(typeof v.selectedModel === 'string' ? { selectedModel: v.selectedModel.trim() } : {}),
      };
    }
    return out;
  }

  /** Writes (or, with undefined, removes) one provider's non-secret config. Never accepts credential fields. */
  static async setCloudProviderConfig(id: string, value: CloudProviderConfig | undefined): Promise<void> {
    const next = { ...this.getCloudProviderConfigs() };
    if (value === undefined) delete next[id];
    else next[id] = { enabled: value.enabled, baseUrl: value.baseUrl, accountId: value.accountId, selectedModel: value.selectedModel };
    await this.updateWhereEffective('cloudProviders', next);
  }

  /** Background repository graph (symbols / imports / tests). On by default; never blocks first use. */
  static getRepositoryGraphEnabled(): boolean {
    return this.cfg().get<boolean>('repositoryGraph.enabled', DEFAULTS.repositoryGraphEnabled) !== false;
  }

  /** Skill runtime: advisory procedures resolved per turn (built-in, user, workspace). */
  static getSkillsEnabled(): boolean {
    return this.cfg().get<boolean>('skills.enabled', DEFAULTS.skillsEnabled) !== false;
  }

  /** Upper bound on files the graph tracks (the memory bound). */
  static getRepositoryGraphMaxFiles(): number {
    const value = this.cfg().get<number>('repositoryGraph.maxFiles', DEFAULTS.repositoryGraphMaxFiles);
    return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : DEFAULTS.repositoryGraphMaxFiles;
  }

  static getCloudSpendMode(): CloudSpendMode {
    return normalizeSpendMode(this.cfg().get<string>('cloudSpendMode', DEFAULTS.cloudSpendMode));
  }

  static getCloudSpendPolicy(): CloudSpendPolicy {
    return { mode: this.getCloudSpendMode(), allowCredits: this.cfg().get<boolean>('cloudAllowCredits', DEFAULTS.cloudAllowCredits) === true };
  }

  static async setCloudSpendMode(mode: CloudSpendMode): Promise<void> {
    await this.updateWhereEffective('cloudSpendMode', mode);
  }

  /** Writes Global, then overwrites any narrower scope that holds a different value and would shadow it. */
  private static async updateWhereEffective(key: string, value: unknown): Promise<void> {
    const cfg = this.cfg();
    const inspected = cfg.inspect<unknown>(key);
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    if (inspected?.workspaceValue !== undefined && JSON.stringify(inspected.workspaceValue) !== JSON.stringify(value)) {
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
    }
    if (inspected?.workspaceFolderValue !== undefined && JSON.stringify(inspected.workspaceFolderValue) !== JSON.stringify(value)) {
      try {
        await cfg.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
      } catch {
        // No folder resource to write to; the read-back check by the caller reports a surviving override.
      }
    }
  }

  /** Base URL of the OpenAI-compatible cloud fallback endpoint ('' when unset). */
  static getCloudFallbackApiBase(): string {
    return this.cfg().get<string>('cloudFallbackApiBase', DEFAULTS.cloudFallbackApiBase).trim().replace(/\/$/, '');
  }

  /** OpenAI-compatible base URL for manually selected OrcaRouter models. */
  static getOrcaRouterApiBase(): string {
    return this.cfg().get<string>('orcaRouterApiBase', DEFAULTS.orcaRouterApiBase).trim().replace(/\/$/, '');
  }

  static async setOrcaRouterApiBase(value: string): Promise<void> {
    await this.cfg().update('orcaRouterApiBase', value.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
  }

  /** Model name to request from the cloud fallback endpoint ('' when unset). */
  static getCloudFallbackModel(): string {
    return this.cfg().get<string>('cloudFallbackModel', DEFAULTS.cloudFallbackModel).trim();
  }

  static getContextWindow(): number {
    return this.cfg().get<number>('contextWindow', DEFAULTS.contextWindow);
  }

  /**
   * Context window with provenance. Only an explicitly user-configured value
   * may act as a `user_override` in context-limit resolution; the built-in
   * default must not defeat provider/profile detection.
   */
  static getContextWindowSetting(): ResolvedConfigValue {
    return this.resolveNumberSetting('contextWindow', DEFAULTS.contextWindow);
  }

  static getMaxOutputTokens(): number {
    return this.cfg().get<number>('maxOutputTokens', DEFAULTS.maxOutputTokens);
  }

  /** Max output tokens with provenance (0/default means "not configured"). */
  static getMaxOutputTokensSetting(): ResolvedConfigValue {
    return this.resolveNumberSetting('maxOutputTokens', DEFAULTS.maxOutputTokens);
  }

  static getTemperature(): number {
    return this.cfg().get<number>('temperature', DEFAULTS.temperature);
  }

  /** Temperature with provenance; an explicit 0 is a real user decision. */
  static getTemperatureSetting(): ResolvedConfigValue {
    return this.resolveNumberSetting('temperature', DEFAULTS.temperature);
  }

  static getRequestTimeoutMs(resourcePath?: string): number {
    const configured = this.cfg(resourcePath).get<number>('requestTimeout', DEFAULTS.requestTimeoutMs);
    return Math.max(configured, DEFAULTS.requestTimeoutMs);
  }

  static getCommandTimeoutMs(): number {
    return this.cfg().get<number>('commandTimeout', DEFAULTS.commandTimeoutMs);
  }

  static getMaxTaskWallClockMs(): number {
    return this.cfg().get<number>('maxTaskWallClock', DEFAULTS.maxTaskWallClockMs);
  }

  static getMaxTaskModelCalls(): number {
    return this.cfg().get<number>('maxTaskModelCalls', DEFAULTS.maxTaskModelCalls);
  }

  static getMaxTaskToolCalls(): number {
    return this.cfg().get<number>('maxTaskToolCalls', DEFAULTS.maxTaskToolCalls);
  }

  static getMaxTaskRepairAttempts(): number {
    return this.cfg().get<number>('maxTaskRepairAttempts', DEFAULTS.maxTaskRepairAttempts);
  }

  static getMaxTaskOutputBytes(): number {
    return this.cfg().get<number>('maxTaskOutputBytes', DEFAULTS.maxTaskOutputBytes);
  }

  static getMaxTaskNoProgressSteps(): number {
    return this.cfg().get<number>('maxTaskNoProgressSteps', DEFAULTS.maxTaskNoProgressSteps);
  }

  static getIgnoredDirs(): string[] {
    return [...DEFAULTS.ignoredDirs];
  }
}
