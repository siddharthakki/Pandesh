/**
 * Resolves ollama-agent.systemOne.* settings, falling back to the legacy
 * ollama-agent.laya.* settings when the new key was never explicitly set by
 * the user. This lets existing Laya configuration keep working without any
 * action, while steering new configuration toward the generic names.
 *
 * Unknown/invalid `mode` always fails safe to 'off'.
 */
import type * as vscode from 'vscode';
import type { SystemOneMode, SystemOneSettings } from './types';

interface ConfigLike {
  get<T>(key: string, defaultValue: T): T;
  inspect<T>(key: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
}

function isExplicitlySet(config: ConfigLike, key: string): boolean {
  const inspected = config.inspect<unknown>(key);
  if (!inspected) return false;
  return inspected.globalValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined;
}

function resolve<T>(config: ConfigLike, newKey: string, legacyKey: string, defaultValue: T): T {
  if (isExplicitlySet(config, newKey)) return config.get<T>(newKey, defaultValue);
  if (isExplicitlySet(config, legacyKey)) return config.get<T>(legacyKey, defaultValue);
  return config.get<T>(newKey, defaultValue);
}

function normalizeMode(mode: unknown): SystemOneMode {
  return mode === 'shadow' ? 'shadow' : 'off';
}

export function resolveSystemOneSettings(config: vscode.WorkspaceConfiguration): SystemOneSettings {
  const enabled = resolve<boolean>(config, 'systemOne.enabled', 'laya.enabled', false);
  const mode = normalizeMode(resolve<string>(config, 'systemOne.mode', 'laya.mode', 'shadow'));
  const endpoint = resolve<string>(config, 'systemOne.endpoint', 'laya.endpoint', 'http://127.0.0.1:8771');
  const timeoutMs = resolve<number>(config, 'systemOne.timeoutMs', 'laya.timeoutMs', 800);
  const provider = config.get<string>('systemOne.provider', 'ollaya');
  const model = config.get<string>('systemOne.model', '').trim() || null;
  return { enabled, mode, provider, endpoint, model, timeoutMs };
}
