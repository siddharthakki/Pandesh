/**
 * Jarvis Desktop's model picker and persisted `selected-model.json` are
 * authoritative for which local Ollama model Jarvis uses — see
 * `desktopModelSelection.ts` and `desktopConfig.ts`'s
 * `resolveDesktopProviderConfig`/`resolveLegacyModelForMigration`. Proves the
 * fix for the defect where, with multiple models installed and no persisted
 * selection, Desktop fell through to a stale `.vscode`/Cursor/VS Code
 * `ollama-agent.chatModel` setting (observed as an uninstalled `qwen2.5:14b`)
 * instead of defaulting to Auto.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTO_MODEL, DesktopSession } from '../src/host/desktopSession';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stubOllamaCatalog(models: string[]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).includes('/api/tags')) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  }));
}

function freshProductRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-model-ownership-product-'));
  dirs.push(root);
  return root;
}

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-model-ownership-data-'));
  dirs.push(dir);
  return dir;
}

/** Runs the same one-time-migration + provider refresh sequence `start()`
 * performs, without spawning a real Core process — mirrors the cast pattern
 * `missionCockpitSession.test.ts` already uses for private members. */
async function migrateAndRefresh(host: DesktopSession): Promise<void> {
  const adapter = host as unknown as {
    runLegacyModelMigrationIfNeeded(): Promise<void>;
    refreshProviderSoft(): void;
  };
  await adapter.runLegacyModelMigrationIfNeeded();
  adapter.refreshProviderSoft();
}

function writeLegacyChatModel(productRoot: string, model: string): void {
  fs.mkdirSync(path.join(productRoot, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(productRoot, '.vscode', 'settings.json'), JSON.stringify({ 'ollama-agent.chatModel': model }));
}

describe('Jarvis model selection ownership: one-time legacy migration', () => {
  it('a fresh profile with no legacy setting and several installed models defaults to Auto and persists it', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['jarvis-qwen3.8:27b-gsq', 'gemma4:12b']);
    const host = new DesktopSession({ productRoot, dataDir });
    await migrateAndRefresh(host);
    expect(host.snapshot().modelIsAuto).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'selected-model.json'), 'utf8')).model).toBe(AUTO_MODEL);
  });

  it('a legacy setting referencing an uninstalled model is ignored — Auto is used instead', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    writeLegacyChatModel(productRoot, 'qwen2.5:14b'); // deliberately not in the installed catalog below
    stubOllamaCatalog(['jarvis-qwen3.8:27b-gsq']);
    const host = new DesktopSession({ productRoot, dataDir });
    await migrateAndRefresh(host);
    expect(host.snapshot().modelIsAuto).toBe(true);
    expect(host.snapshot().model).not.toBe('qwen2.5:14b');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'selected-model.json'), 'utf8')).model).toBe(AUTO_MODEL);
  });

  it('a legacy setting referencing a currently installed model is migrated exactly once, then never re-consulted', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    writeLegacyChatModel(productRoot, 'jarvis-qwen3.8:27b-gsq');
    stubOllamaCatalog(['jarvis-qwen3.8:27b-gsq']);
    const host = new DesktopSession({ productRoot, dataDir });
    await migrateAndRefresh(host);
    const snap = host.snapshot();
    expect(snap.modelIsAuto).toBe(false);
    expect(snap.model).toBe('jarvis-qwen3.8:27b-gsq');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'selected-model.json'), 'utf8')).model).toBe('jarvis-qwen3.8:27b-gsq');

    // Change the legacy setting after migration — a restarted session must
    // never look at it again; Jarvis's own persisted selection is authoritative.
    writeLegacyChatModel(productRoot, 'some-other-legacy-model:7b');
    const restarted = new DesktopSession({ productRoot, dataDir });
    await migrateAndRefresh(restarted);
    expect(restarted.snapshot().model).toBe('jarvis-qwen3.8:27b-gsq');
  });

  it('an explicit operator selection made before migration runs is left unchanged', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['my-model:7b']);
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel('my-model:7b');
    await migrateAndRefresh(host); // must be a no-op: a selection already exists
    expect(host.snapshot().model).toBe('my-model:7b');
    expect(host.snapshot().modelIsAuto).toBe(false);
  });

  it('restart preserves the persisted Desktop selection across sessions', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['my-model:7b']);
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel('my-model:7b');

    const restarted = new DesktopSession({ productRoot, dataDir });
    await migrateAndRefresh(restarted);
    expect(restarted.snapshot().model).toBe('my-model:7b');
    expect(restarted.snapshot().modelIsAuto).toBe(false);
  });
});

describe('Jarvis model selection ownership: fail-closed when a selected model disappears', () => {
  it('a persisted explicit model that is no longer installed fails closed instead of substituting', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['my-model:7b']);
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel('my-model:7b');
    expect(host.snapshot().modelAvailable).toBe(true);

    // The model is uninstalled from Ollama between sessions.
    stubOllamaCatalog([]);
    const adapter = host as unknown as { refreshModelAvailability(): Promise<void> };
    await adapter.refreshModelAvailability();
    expect(host.snapshot().modelAvailable).toBe(false);
    expect(host.snapshot().coreDetail).toMatch(/select an installed model/i);
    // Never silently substitutes a different model.
    expect(host.snapshot().model).toBe('my-model:7b');
  });
});

describe('Jarvis model selection ownership: Gmail summarization model resolution', () => {
  it('Auto resolves summarization to an installed local model from the chat preference chain', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['jarvis-qwen3.8:27b-gsq', 'qwen2.5-coder:1.5b']); // fallback chain tail, not the head
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel(AUTO_MODEL);
    const adapter = host as unknown as { resolveSummarizationModel(): Promise<string> };
    const model = await adapter.resolveSummarizationModel();
    expect(model).toBe('qwen2.5-coder:1.5b');
    expect(model).not.toBe('qwen2.5:14b');
  });

  it('an explicit selection resolves summarization to that exact model when installed', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['my-model:7b']);
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel('my-model:7b');
    const adapter = host as unknown as { resolveSummarizationModel(): Promise<string> };
    await expect(adapter.resolveSummarizationModel()).resolves.toBe('my-model:7b');
  });

  it('summarization fails closed rather than using an uninstalled explicit selection', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog(['my-model:7b']);
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel('my-model:7b');
    stubOllamaCatalog([]); // uninstalled since selection
    const adapter = host as unknown as { resolveSummarizationModel(): Promise<string> };
    await expect(adapter.resolveSummarizationModel()).rejects.toThrow(/select an installed model/i);
  });

  it('summarization fails closed when Auto has no installed candidate, never falling back to OpenRouter', async () => {
    const dataDir = freshDataDir();
    const productRoot = freshProductRoot();
    stubOllamaCatalog([]); // nothing installed at all
    const host = new DesktopSession({ productRoot, dataDir });
    await host.selectModel(AUTO_MODEL);
    const adapter = host as unknown as { resolveSummarizationModel(): Promise<string> };
    await expect(adapter.resolveSummarizationModel()).rejects.toThrow(/no installed local model/i);
  });
});
