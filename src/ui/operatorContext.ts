import * as path from 'path';

/**
 * Host-side facts for the operator context strip (workspace, provider, thinking, governance).
 * Pure so it can be tested; everything here is read from real configuration or provider evidence and
 * falls back to an honest "unavailable"/"Default" instead of inventing a value.
 */
export interface OperatorContextMessage {
  type: 'operatorContext';
  workspace: { name: string; path: string } | null;
  provider: string;
  thinking: string;
  governance: 'Governed';
}

export function describeWorkspace(workspaceRoot: string | undefined): OperatorContextMessage['workspace'] {
  if (!workspaceRoot) return null;
  const name = path.basename(workspaceRoot.replace(/[\\/]+$/, '')) || workspaceRoot;
  return { name, path: workspaceRoot };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const PROVIDER_NAMES: Record<string, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI-compatible',
  'openai-compatible': 'OpenAI-compatible',
  llamacpp: 'llama.cpp',
};

/** `Local • Ollama` for a loopback endpoint, `Remote • <name>` otherwise; the real provider, never a guess. */
export function describeProvider(providerType: string, baseUrl?: string): string {
  const name = PROVIDER_NAMES[providerType] ?? providerType;
  if (!baseUrl) return providerType === 'ollama' ? `Local • ${name}` : name;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return `${LOOPBACK_HOSTS.has(host) ? 'Local' : 'Remote'} • ${name}`;
  } catch {
    return name;
  }
}

/**
 * What KKD actually does about native reasoning for the model: it is switched off by the model's profile, left to
 * the model's own default, or the provider says the model has no such mode. KKD offers no reasoning levels, so
 * none are ever shown.
 */
export function describeThinking(input: {
  profileDisablesNativeThinking?: boolean;
  providerCapabilities?: readonly string[];
}): string {
  if (input.profileDisablesNativeThinking) return 'Off';
  if (input.providerCapabilities === undefined) return 'Default';
  return input.providerCapabilities.includes('thinking') ? 'Model default' : 'Not supported';
}

export function buildOperatorContextMessage(input: {
  workspaceRoot?: string;
  providerType: string;
  baseUrl?: string;
  profileDisablesNativeThinking?: boolean;
  providerCapabilities?: readonly string[];
}): OperatorContextMessage {
  return {
    type: 'operatorContext',
    workspace: describeWorkspace(input.workspaceRoot),
    provider: describeProvider(input.providerType, input.baseUrl),
    thinking: describeThinking(input),
    governance: 'Governed',
  };
}
