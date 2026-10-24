import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { resolveSystemOneSettings } from '../../systemOne/config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockVscode = vscode as any;

describe('resolveSystemOneSettings (M43.4 config + M43.5 mode safety)', () => {
  it('defaults to off/shadow-only-when-explicit with no configuration at all', () => {
    mockVscode._resetConfig();
    const settings = resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent'));
    expect(settings).toEqual({
      enabled: false,
      mode: 'shadow',
      provider: 'ollaya',
      endpoint: 'http://127.0.0.1:8771',
      model: null,
      timeoutMs: 800,
    });
  });

  it('falls back to legacy ollama-agent.laya.* values when systemOne.* was never explicitly set', () => {
    mockVscode._resetConfig();
    mockVscode._setConfig('ollama-agent.laya.enabled', true);
    mockVscode._setConfig('ollama-agent.laya.mode', 'shadow');
    mockVscode._setConfig('ollama-agent.laya.endpoint', 'http://localhost:9999');
    mockVscode._setConfig('ollama-agent.laya.timeoutMs', 1234);
    const settings = resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent'));
    expect(settings.enabled).toBe(true);
    expect(settings.mode).toBe('shadow');
    expect(settings.endpoint).toBe('http://localhost:9999');
    expect(settings.timeoutMs).toBe(1234);
  });

  it('prefers an explicit systemOne.* value over a legacy laya.* value', () => {
    mockVscode._resetConfig();
    mockVscode._setConfig('ollama-agent.laya.enabled', true);
    mockVscode._setConfig('ollama-agent.systemOne.enabled', false);
    const settings = resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent'));
    expect(settings.enabled).toBe(false);
  });

  it('fails safe to off for any unknown or invalid mode value', () => {
    mockVscode._resetConfig();
    for (const invalid of ['assist', 'active', 'authoritative', 'garbage', '']) {
      mockVscode._setConfig('ollama-agent.systemOne.mode', invalid);
      expect(resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent')).mode).toBe('off');
    }
  });

  it('trims a blank model to null so the provider falls back to its own default', () => {
    mockVscode._resetConfig();
    mockVscode._setConfig('ollama-agent.systemOne.model', '   ');
    expect(resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent')).model).toBeNull();
    mockVscode._setConfig('ollama-agent.systemOne.model', 'decider:0.8b');
    expect(resolveSystemOneSettings(vscode.workspace.getConfiguration('ollama-agent')).model).toBe('decider:0.8b');
  });
});
