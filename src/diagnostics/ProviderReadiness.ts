import type * as vscode from 'vscode';
import { Config } from '../config/Config';
import { ProviderGateway } from '../providers/ProviderGateway';
import {
  InferenceProvider,
  ModelInfo,
  ProviderApiError,
  ProviderAuthError,
  ProviderConnectionError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
  ProviderType,
} from '../providers/ProviderTypes';

export type ProviderReadinessFailureCode =
  | 'model_unavailable'
  | 'provider_unreachable'
  | 'authentication_failed'
  | 'timeout'
  | 'provider_failure'
  | 'cancelled';

export type ProviderReachability = 'ready' | 'unavailable' | 'cancelled';
export type ProviderModelAvailability = 'available' | 'unavailable' | 'not_checked';

export interface ProviderReadinessResult {
  providerType: ProviderType;
  apiBase: string;
  chatModel: string;
  reachability: ProviderReachability;
  modelAvailability: ProviderModelAvailability;
  discoveredModelCount?: number;
  availableModelNames?: string[];
  /** The provider's full model entries (context, size, aliases), same order as `availableModelNames`. */
  availableModels?: ModelInfo[];
  failureCode?: ProviderReadinessFailureCode;
  failureReason?: string;
  nextAction?: string;
}

export class ProviderReadinessProbe {
  static forSecrets(secrets: vscode.SecretStorage): ProviderReadinessProbe {
    return new ProviderReadinessProbe(() => ProviderGateway.create(secrets));
  }

  constructor(private readonly resolveProvider: () => Promise<InferenceProvider>) {}

  async run(signal: AbortSignal): Promise<ProviderReadinessResult> {
    const metadata = readProviderMetadata();
    if (signal.aborted) {
      return failureResult(metadata, 'cancelled');
    }

    let provider: InferenceProvider;
    try {
      provider = await this.resolveProvider();
    } catch (error) {
      return failureResult(metadata, classifyReadinessFailure(error, signal));
    }

    try {
      await provider.healthCheck(signal);
    } catch (error) {
      return failureResult(metadata, classifyReadinessFailure(error, signal));
    }

    if (signal.aborted) {
      return failureResult(metadata, 'cancelled');
    }

    try {
      const models = await provider.listModels(signal);
      const availableModelNames = sortedUniqueModelNames(models);
      const availableModels = availableModelNames.map(name => models.find(model => model.name === name)!);
      const available = models.some(model => model.name === metadata.chatModel || model.aliases?.includes(metadata.chatModel));
      return {
        ...metadata,
        reachability: 'ready',
        modelAvailability: available ? 'available' : 'unavailable',
        discoveredModelCount: availableModelNames.length,
        availableModelNames,
        availableModels,
        ...(available ? {} : failureFields('model_unavailable', metadata)),
      };
    } catch (error) {
      return failureResult(metadata, classifyReadinessFailure(error, signal), { reachable: true });
    }
  }
}

function sortedUniqueModelNames(models: ModelInfo[]): string[] {
  return [...new Set(models.map(model => model.name).filter(name => name.length > 0))]
    .sort((a, b) => a.localeCompare(b));
}

export function providerReadinessDetail(result: ProviderReadinessResult): string {
  const lines = [
    `Provider: ${result.providerType}`,
    `Endpoint: ${result.apiBase}`,
    `Reachability: ${result.reachability}`,
    `Configured model: ${result.chatModel}`,
    `Model availability: ${result.modelAvailability}`,
  ];
  if (typeof result.discoveredModelCount === 'number') {
    lines.push(`Discovered models: ${result.discoveredModelCount}`);
  }
  if (result.failureCode) {
    lines.push(`Failure code: ${result.failureCode}`);
  }
  if (result.failureReason) {
    lines.push(`Failure reason: ${result.failureReason}`);
  }
  if (result.nextAction) {
    lines.push(`Next action: ${result.nextAction}`);
  }
  lines.push(`Status: ${result.failureCode ? 'failed' : 'passed'}`);
  return lines.join('\n');
}

interface ProviderMetadata {
  providerType: ProviderType;
  apiBase: string;
  chatModel: string;
}

function readProviderMetadata(): ProviderMetadata {
  return {
    providerType: Config.getProviderType(),
    apiBase: Config.getApiBase(),
    chatModel: Config.getChatModel(),
  };
}

function failureResult(
  metadata: ProviderMetadata,
  failureCode: ProviderReadinessFailureCode,
  options: { reachable?: boolean } = {},
): ProviderReadinessResult {
  return {
    ...metadata,
    reachability: failureCode === 'cancelled'
      ? 'cancelled'
      : options.reachable
        ? 'ready'
        : 'unavailable',
    modelAvailability: failureCode === 'model_unavailable' ? 'unavailable' : 'not_checked',
    ...failureFields(failureCode, metadata),
  };
}

function failureFields(
  failureCode: ProviderReadinessFailureCode,
  metadata: ProviderMetadata,
): Pick<ProviderReadinessResult, 'failureCode' | 'failureReason' | 'nextAction'> {
  return {
    failureCode,
    failureReason: failureReason(failureCode),
    nextAction: nextAction(failureCode, metadata),
  };
}

function classifyReadinessFailure(error: unknown, signal: AbortSignal): ProviderReadinessFailureCode {
  if (signal.aborted || isAbortError(error)) {
    return 'cancelled';
  }
  if (error instanceof ProviderModelNotFoundError) {
    return 'model_unavailable';
  }
  if (error instanceof ProviderConnectionError) {
    return 'provider_unreachable';
  }
  if (error instanceof ProviderAuthError) {
    return 'authentication_failed';
  }
  if (error instanceof ProviderTimeoutError) {
    return 'timeout';
  }
  if (error instanceof ProviderApiError) {
    return 'provider_failure';
  }
  return 'provider_failure';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function failureReason(failureCode: ProviderReadinessFailureCode): string {
  switch (failureCode) {
    case 'model_unavailable':
      return 'The configured chat model was not reported by the provider.';
    case 'provider_unreachable':
      return 'The configured provider endpoint was not reachable.';
    case 'authentication_failed':
      return 'The provider rejected authentication.';
    case 'timeout':
      return 'The provider readiness check timed out.';
    case 'cancelled':
      return 'The diagnostics run was cancelled.';
    case 'provider_failure':
      return 'The provider readiness check failed.';
  }
}

function nextAction(failureCode: ProviderReadinessFailureCode, metadata: ProviderMetadata): string {
  switch (failureCode) {
    case 'model_unavailable':
      return metadata.providerType === 'ollama'
        ? `Install "${metadata.chatModel}" with Ollama or select an installed model in ollama-agent.chatModel.`
        : `Select a model returned by the provider in ollama-agent.chatModel.`;
    case 'provider_unreachable':
      return metadata.providerType === 'ollama'
        ? 'Start Ollama and verify ollama-agent.apiBase.'
        : 'Start the configured OpenAI-compatible service and verify ollama-agent.apiBase.';
    case 'authentication_failed':
      return 'Update the provider API key in VS Code SecretStorage or verify provider authentication settings.';
    case 'timeout':
      return 'Verify provider responsiveness or increase ollama-agent.requestTimeout.';
    case 'provider_failure':
      return 'Verify ollama-agent.providerType, ollama-agent.apiBase and provider availability.';
    case 'cancelled':
      return 'Rerun diagnostics when ready.';
  }
}
