import * as vscode from 'vscode';
import { ValidatedAgentRuntime } from './ValidatedAgentRuntime';
import { AgentMode } from '../config/ConfigSchema';
import { AgentLoopEvents } from '../tools/ToolTypes';
import { TaskBudgets, ValidationCommandRequest } from './AgentEngineTypes';
import { isReadOnlyInspectionRequest } from './TaskIntent';
import { hasStrictTaskScope } from './StrictTaskScope';
import { RepositoryContextService } from '../context/RepositoryContextService';
import { planRepositoryContextBudgetForModel } from '../context/RepositoryContextBudget';
import { RepositoryContextResult } from '../context/RepositoryTypes';
import { ModelCapabilityRegistry } from '../models/ModelCapabilityRegistry';
import { Config } from '../config/Config';
import { Logger } from '../services/Logger';
import { FrontierContextComposer, FrontierContextResult } from '../intelligence/FrontierContextComposer';
import { FrontierCoreServices } from '../frontier/FrontierCoreServices';
import { ProductScaleServices } from '../frontier/ProductScaleServices';

export interface ModeModelResolution {
  model: string;
  requestedModel?: string;
  reason: string;
  fellBack: boolean;
}

/**
 * Baat Kar is intentionally a fast conversational surface. It does not scan,
 * index, or compose repository context. Repository-aware read-only work belongs
 * to Ask/Plan (used by Auto) and tool-assisted work belongs to Saath Kar.
 */
export function shouldBuildRepositoryContext(mode: AgentMode): boolean {
  return mode !== 'chat';
}

export class ContextAwareAgentRuntime extends ValidatedAgentRuntime {
  private readonly repositoryContext: RepositoryContextService;
  private readonly frontierContext: FrontierContextComposer;
  private readonly frontierCore: FrontierCoreServices;
  private readonly productScale: ProductScaleServices;

  constructor(
    private readonly contextWorkspaceRoot: string,
    secrets: vscode.SecretStorage,
  ) {
    super(contextWorkspaceRoot, secrets);
    this.repositoryContext = new RepositoryContextService(contextWorkspaceRoot);
    this.frontierContext = new FrontierContextComposer(contextWorkspaceRoot);
    this.frontierCore = new FrontierCoreServices(contextWorkspaceRoot, this.frontierContext);
    this.productScale = new ProductScaleServices(contextWorkspaceRoot);
  }

  getFrontierContextComposer(): FrontierContextComposer {
    return this.frontierContext;
  }

  getFrontierCoreServices(): FrontierCoreServices {
    return this.frontierCore;
  }

  getProductScaleServices(): ProductScaleServices {
    return this.productScale;
  }

  async run(
    text: string,
    mode: AgentMode,
    events: AgentLoopEvents,
    images?: string[],
    modelOverride?: string,
    taskId?: string,
    settings: { validationCommands?: ValidationCommandRequest[]; allowedPaths?: string[] } = {},
    budgetOverrides?: Partial<TaskBudgets>,
  ): Promise<void> {
    const modelResolution = this.resolveModel(mode, modelOverride, Boolean(images?.length));
    const selectedModel = modelResolution.model;
    let selection: RepositoryContextResult | undefined;
    let frontierSelection: FrontierContextResult | undefined;
    let enrichedText = text;
    const strictReadOnlyInspection = isReadOnlyInspectionRequest(text);
    const strictExecutionScope = hasStrictTaskScope(text);
    const hints = this.collectEditorHints();
    const repositoryBudget = planRepositoryContextBudgetForModel({
      model: selectedModel,
      providerType: Config.getProviderType(),
      objective: text,
      toolsEnabled: true,
      maxOutputTokens: Config.getMaxOutputTokens() || undefined,
    });
    const tokenBudget = repositoryBudget.budgetTokens;
    const repositoryAware = shouldBuildRepositoryContext(mode);

    if (repositoryAware && text.trim() && !strictReadOnlyInspection && !strictExecutionScope) {
      try {
        selection = await this.repositoryContext.build({
          query: text,
          mode,
          model: selectedModel,
          providerType: Config.getProviderType(),
          tokenBudget,
          budget: repositoryBudget,
          hints,
        });
        events.onRepositoryContext?.({
          state: selection.index.state,
          identity: selection.index.identity,
          updatedAt: selection.index.updatedAt,
          staleReason: selection.index.staleReason,
          failureCode: selection.index.failureCode,
          statistics: selection.index.statistics,
          selectedFiles: selection.diagnostics.selectedFiles,
          estimatedTokens: selection.diagnostics.estimatedTokens,
          omittedCount: selection.diagnostics.omittedCount ?? selection.diagnostics.rejectedFiles.length,
          pins: selection.index.pins,
          exclusions: selection.index.exclusions,
          storage: {
            kind: 'sqlite',
            path: this.repositoryContext.storagePath(),
            sqliteAvailable: true,
          },
        });
      } catch (error) {
        Logger.warn('[ContextAwareAgentRuntime] Repository context selection failed:', error);
      }
    }

    if (repositoryAware && text.trim()) {
      try {
        frontierSelection = await this.frontierContext.compose({
          query: text,
          mode,
          tokenBudget,
          targetPath: hints.openFiles[0] ?? '.',
          repositoryPrompt: selection?.prompt,
        });
        enrichedText = frontierSelection.prompt;
      } catch (error) {
        Logger.warn('[ContextAwareAgentRuntime] Frontier context composition failed:', error);
        if (selection?.prompt) enrichedText = `${text}\n\n${selection.prompt}`;
      }
    }

    const routedEvents: AgentLoopEvents = {
      ...events,
      onModelSelected: (model, reason) => {
        events.onModelSelected?.(
          model,
          model === selectedModel ? modelResolution.reason : reason,
        );
      },
    };

    await super.run(
      enrichedText,
      mode,
      routedEvents,
      images,
      selectedModel,
      taskId,
      settings,
      budgetOverrides,
    );

    const effectiveTaskId = this.getTaskId() ?? taskId;
    if (effectiveTaskId && repositoryAware) {
      await this.persistContextEvidence(effectiveTaskId, selection, frontierSelection);
    }
  }

  private async persistContextEvidence(
    taskId: string,
    selection?: RepositoryContextResult,
    frontierSelection?: FrontierContextResult,
  ): Promise<void> {
    try {
      if (selection) {
        await this.repositoryContext.persist(this.taskStore.getTaskDir(taskId), selection);
        await this.taskStore.appendEvent(taskId, 'assistant_message', {
          kind: 'context_selection',
          selectedFiles: selection.files.map(file => ({
            path: file.path,
            hash: selection.index.files.find(record => record.path === file.path)?.contentHash,
            reasons: file.reasons.map(reason => reason.reason),
            score: file.score,
          })),
          estimatedTokens: selection.diagnostics.estimatedTokens,
          inputBudget: selection.diagnostics.inputBudget,
          indexVersion: selection.index.schemaVersion,
          freshness: selection.index.state,
          packageHash: selection.diagnostics.packageHash,
        });
      }
      if (frontierSelection) {
        await this.taskStore.appendEvent(taskId, 'assistant_message', {
          kind: 'frontier_context_selection',
          instructionFiles: frontierSelection.selectedInstructionFiles,
          skills: frontierSelection.selectedSkills,
          semanticSymbols: frontierSelection.semanticSymbols,
          includedSegments: frontierSelection.includedSegmentIds,
          droppedSegments: frontierSelection.droppedSegmentIds,
          estimatedTokens: frontierSelection.estimatedTokens,
          stablePrefixHash: frontierSelection.stablePrefixHash,
        });
      }
    } catch (error) {
      Logger.warn('[ContextAwareAgentRuntime] Context diagnostics persistence failed:', error);
    }
  }

  private resolveModel(
    mode: AgentMode,
    requestedModel: string | undefined,
    hasImages: boolean,
  ): ModeModelResolution {
    const roleModel = this.modelForMode(mode);
    const registry = ModelCapabilityRegistry.getInstance();
    const provider = Config.getProviderType();
    const requested = requestedModel?.trim() || undefined;

    if (hasImages) {
      if (requested && registry.supportsVision(requested, provider)) {
        return {
          model: requested,
          requestedModel: requested,
          reason: `Selected vision-capable model: ${requested}`,
          fellBack: false,
        };
      }
      const fallback = Config.getVisionModel();
      return {
        model: fallback,
        requestedModel: requested,
        reason: requested
          ? `Selected model ${requested} cannot process images; using vision model ${fallback}`
          : `Image attached; using vision model ${fallback}`,
        fellBack: Boolean(requested && requested !== fallback),
      };
    }

    if (!requested) {
      return {
        model: roleModel,
        reason: `${mode === 'agent' ? 'Saath Kar' : 'Baat Kar'} default model: ${roleModel}`,
        fellBack: false,
      };
    }

    const capabilities = registry.getCapabilities(requested, provider);
    if (!capabilities.chat || capabilities.embeddingOnly) {
      return {
        model: roleModel,
        requestedModel: requested,
        reason: `${requested} is not a chat model; using ${roleModel}`,
        fellBack: true,
      };
    }
    if (requested === Config.getAutocompleteModel()) {
      return {
        model: roleModel,
        requestedModel: requested,
        reason: `${requested} is reserved for autocomplete; using ${roleModel}`,
        fellBack: true,
      };
    }
    if (capabilities.vision) {
      return {
        model: roleModel,
        requestedModel: requested,
        reason: `${requested} is reserved for vision work; using ${roleModel}`,
        fellBack: true,
      };
    }

    if (mode === 'agent') {
      if (capabilities.tools && registry.isAllowedForRole(requested, 'agent', provider)) {
        return {
          model: requested,
          requestedModel: requested,
          reason: `Saath Kar selected model: ${requested}`,
          fellBack: false,
        };
      }
      const fallback = Config.getAgentModel();
      return {
        model: fallback,
        requestedModel: requested,
        reason: `${requested} lacks supported tool use for Saath Kar; using ${fallback}`,
        fellBack: true,
      };
    }

    if (registry.isAllowedForRole(requested, 'chat', provider)) {
      return {
        model: requested,
        requestedModel: requested,
        reason: `Baat Kar selected model: ${requested}`,
        fellBack: false,
      };
    }
    const fallback = Config.getChatModel();
    return {
      model: fallback,
      requestedModel: requested,
      reason: `${requested} is not allowed for conversational use; using ${fallback}`,
      fellBack: true,
    };
  }

  private modelForMode(mode: AgentMode): string {
    if (mode === 'agent') { return Config.getAgentModel(); }
    if (mode === 'chat' || mode === 'ask' || mode === 'plan') { return Config.getChatModel(); }
    return Config.getModel();
  }

  private collectEditorHints() {
    const windowValue = vscode.window as typeof vscode.window & {
      visibleTextEditors?: Array<{ document: { uri: vscode.Uri } }>;
    };
    const openFiles = (windowValue.visibleTextEditors ?? [])
      .map(editor => editor.document.uri.fsPath)
      .filter(file => file.startsWith(this.contextWorkspaceRoot))
      .map(file => file.slice(this.contextWorkspaceRoot.length).replace(/^[/\\]/, ''));

    const languageValue = vscode.languages as typeof vscode.languages & {
      getDiagnostics?: () => Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
    };
    const diagnosticFiles = (languageValue?.getDiagnostics?.() ?? [])
      .filter(([uri]) => uri.fsPath.startsWith(this.contextWorkspaceRoot))
      .flatMap(([uri, diagnostics]) => diagnostics
        .filter(diagnostic => diagnostic.severity <= vscode.DiagnosticSeverity.Information)
        .slice(0, 5)
        .map(diagnostic => ({
          path: uri.fsPath.slice(this.contextWorkspaceRoot.length).replace(/^[/\\]/, ''),
          severity: diagnostic.severity === vscode.DiagnosticSeverity.Error
            ? 'error' as const
            : diagnostic.severity === vscode.DiagnosticSeverity.Warning
              ? 'warning' as const
              : 'info' as const,
          message: diagnostic.message,
        })));

    return { openFiles, diagnosticFiles };
  }
}
