import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseJsoncObject,
  resolveDesktopProviderConfig,
  resolveLegacyModelForMigration,
  assertLocalModelInstalled,
  resolveOpenRouterConfig,
  OPENROUTER_OFFICIAL_API_BASE,
} from '../src/host/desktopConfig';
import { AUTO_CHAT_MODEL } from '../../../core/domain/modelRouting';
import { RENDERER_VISIBLE_KEYS } from '../src/ipc';

describe('desktop provider config', () => {
  it('never reads .vscode/Cursor/VS Code settings as an ongoing fallback — defaults to the Auto chat model instead', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-config-'));
    const product = path.join(root, 'product');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(product, '.vscode'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(product, '.vscode', 'settings.json'), JSON.stringify({
      'ollama-agent.providerType': 'ollama',
      'ollama-agent.apiBase': 'http://127.0.0.1:11434',
      'ollama-agent.chatModel': 'qwen2.5:14b',
      'ollama-agent.cloudFallbackModel': 'openai/gpt-5.6-sol',
      'ollama-agent.cloudFallbackApiBase': 'https://api.orcarouter.ai/v1',
      'ollama-agent.modelRoutingPolicy': 'local-first-cloud-fallback',
    }));
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'ollama-agent.chatModel': 'workspace-local:7b',
    }));

    const resolved = resolveDesktopProviderConfig({
      selectedWorkspaceRoot: workspace,
      productRoot: product,
      homedir: root,
      appdata: path.join(root, 'appdata'),
      env: {},
    });

    // No stale editor setting (not even the deprecated qwen2.5:14b one) ever
    // wins here now — see AI_OS_STATE.md's model-ownership correction.
    expect(resolved.model).toBe(AUTO_CHAT_MODEL);
    expect(resolved.model).not.toBe('workspace-local:7b');
    expect(resolved.model).not.toBe('qwen2.5:14b');
    expect(resolved.source).toBe('auto-default');
    expect(resolved.providerType).toBe('ollama');
    expect(resolved.routingPolicy).toBe('local-only');
    expect(resolved.apiBase).toBe('http://127.0.0.1:11434');
    expect(resolved.model).not.toContain('openai/');
  });

  it('defaults to the Auto chat model, never throws, when nothing is configured', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-missing-'));
    const resolved = resolveDesktopProviderConfig({
      productRoot: root,
      homedir: root,
      appdata: path.join(root, 'appdata'),
      env: {},
    });
    expect(resolved.model).toBe(AUTO_CHAT_MODEL);
    expect(resolved.source).toBe('auto-default');
  });

  it('resolveLegacyModelForMigration reads the same settings precedence, but is never called on the ongoing resolution path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-legacy-'));
    const product = path.join(root, 'product');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(product, '.vscode'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(product, '.vscode', 'settings.json'), JSON.stringify({ 'ollama-agent.chatModel': 'product-local:7b' }));
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'ollama-agent.chatModel': 'workspace-local:7b' }));

    const legacy = resolveLegacyModelForMigration({
      selectedWorkspaceRoot: workspace,
      productRoot: product,
      homedir: root,
      appdata: path.join(root, 'appdata'),
    });
    expect(legacy?.model).toBe('workspace-local:7b');
  });

  it('resolveLegacyModelForMigration returns null when nothing is configured', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-legacy-empty-'));
    expect(resolveLegacyModelForMigration({ productRoot: root, homedir: root, appdata: path.join(root, 'appdata') })).toBeNull();
  });

  it('prefers an operator-selected installed model over settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-override-'));
    const product = path.join(root, 'product');
    fs.mkdirSync(path.join(product, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(product, '.vscode', 'settings.json'), JSON.stringify({
      'ollama-agent.chatModel': 'settings-model:7b',
    }));
    const resolved = resolveDesktopProviderConfig({
      productRoot: product,
      homedir: root,
      appdata: path.join(root, 'appdata'),
      env: {},
      selectedModelOverride: 'operator-pick:13b',
    });
    expect(resolved.model).toBe('operator-pick:13b');
    expect(resolved.source).toBe('operator-selection');
  });

  it('lists installed Ollama models from /api/tags', async () => {
    const { listInstalledOllamaModels } = await import('../src/host/desktopConfig');
    const names = await listInstalledOllamaModels('http://127.0.0.1:11434', async () => (
      new Response(JSON.stringify({ models: [{ name: 'b:1' }, { name: 'a:1' }] }), { status: 200 })
    ));
    expect(names).toEqual(['a:1', 'b:1']);
  });

  it('keeps OpenRouter submission paused', async () => {
    const { OPENROUTER_SUBMISSION_READY, OPENROUTER_NOT_READY_MESSAGE } = await import('../src/host/desktopConfig');
    expect(OPENROUTER_SUBMISSION_READY).toBe(false);
    expect(OPENROUTER_NOT_READY_MESSAGE).toMatch(/not ready/i);
  });

  it('parses JSONC settings', () => {
    const parsed = parseJsoncObject(`{
      // comment
      "ollama-agent.chatModel": "local:7b",
    }`);
    expect(parsed['ollama-agent.chatModel']).toBe('local:7b');
  });

  it('fails closed when the configured model is not installed', async () => {
    await expect(assertLocalModelInstalled('http://127.0.0.1:11434', 'not-installed:model', async () => (
      new Response(JSON.stringify({ models: [{ name: 'other:1b' }] }), { status: 200 })
    ))).rejects.toThrow(/refusing to substitute/);
  });
});

describe('desktop IPC contract', () => {
  it('does not expose credentials to the renderer snapshot', () => {
    expect(RENDERER_VISIBLE_KEYS).not.toContain('token');
    expect(RENDERER_VISIBLE_KEYS).not.toContain('clientId');
    expect(RENDERER_VISIBLE_KEYS).toContain('openRouter');
    expect(RENDERER_VISIBLE_KEYS.join(',')).not.toMatch(/secret|token|authorization/i);
  });

  it('keeps OpenRouter settings independent of local Ollama resolution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-desktop-or-'));
    const product = path.join(root, 'product');
    fs.mkdirSync(path.join(product, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(product, '.vscode', 'settings.json'), JSON.stringify({
      'ollama-agent.providerType': 'ollama',
      'ollama-agent.chatModel': 'local:7b',
      'ollama-agent.openRouterModel': 'openai/gpt-5.6-sol',
      'ollama-agent.openRouterMaxUsd': 3,
    }));
    const local = resolveDesktopProviderConfig({
      productRoot: product,
      homedir: root,
      appdata: path.join(root, 'appdata'),
      env: {},
      selectedModelOverride: 'local:7b',
    });
    const openRouter = resolveOpenRouterConfig({
      productRoot: product,
      homedir: root,
      appdata: path.join(root, 'appdata'),
      env: {},
    });
    expect(local.routingPolicy).toBe('local-only');
    expect(local.model).toBe('local:7b');
    expect(openRouter.apiBase).toBe(OPENROUTER_OFFICIAL_API_BASE);
    expect(openRouter.model).toBe('openai/gpt-5.6-sol');
    expect(openRouter.maxUsd).toBe(3);
  });
});
