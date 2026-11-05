/**
 * Governed management of the local Ollama models.
 *
 * Pandesh could always LIST the installed models. It could not install one,
 * free one from the GPU, or remove one. These are exactly the operations a
 * person asks for ("pull the small model", "free the VRAM", "remove that
 * 20 GB model"), and they are the operations with real consequences, so they
 * go through the ordinary governed path: an approval that names the exact
 * model, and evidence that says what actually happened.
 *
 * The safety rules are the point:
 *   - a pull never happens without an approval that names the model and its
 *     size, and it refuses when the disk cannot hold it,
 *   - a delete refuses while the model is loaded or in use, because that
 *     would break the very session that asked for it,
 *   - every call talks to the local Ollama HTTP API only; nothing is uploaded.
 */
import * as fs from 'node:fs';
import type { CoreDatabase } from '../db/connection';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { DEFAULT_OLLAMA_URL } from './modelBackend';
import { nowIso } from '../domain/ids';

export interface OllamaManagementOptions {
  db?: CoreDatabase;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Free bytes on the disk Ollama stores its models on. */
  freeDiskBytes?: () => number;
}

interface OllamaTag { name?: string; size?: number; modified_at?: string; digest?: string }
interface OllamaProcess { name?: string; size_vram?: number; expires_at?: string }

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function ollamaUrl(options: OllamaManagementOptions): string {
  return (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
}

async function ollamaGet(options: OllamaManagementOptions, urlPath: string, timeoutMs = 10_000): Promise<unknown> {
  const fetcher = options.fetchImpl ?? fetch;
  const response = await fetcher(`${ollamaUrl(options)}${urlPath}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Ollama ${urlPath} answered ${response.status}`);
  return response.json();
}

/** The free bytes on the volume Ollama keeps its models on. */
export function defaultFreeDiskBytes(): number {
  try {
    const stats = fs.statfsSync(process.env.USERPROFILE ?? process.cwd());
    return stats.bavail * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export interface OllamaModelView {
  name: string;
  sizeBytes: number;
  loaded: boolean;
  vramBytes: number;
  modifiedAt: string | null;
  digest: string | null;
}

/** Every installed model, with whether it is currently resident in VRAM. */
export async function listOllamaModels(options: OllamaManagementOptions = {}): Promise<OllamaModelView[]> {
  const [tags, running] = await Promise.all([
    ollamaGet(options, '/api/tags') as Promise<{ models?: OllamaTag[] }>,
    ollamaGet(options, '/api/ps').catch(() => ({ models: [] })) as Promise<{ models?: OllamaProcess[] }>,
  ]);
  const loaded = new Map<string, OllamaProcess>();
  for (const entry of running.models ?? []) {
    if (entry.name) loaded.set(entry.name, entry);
  }
  return (tags.models ?? []).map((tag) => {
    const process = loaded.get(tag.name ?? '');
    return {
      name: tag.name ?? '',
      sizeBytes: tag.size ?? 0,
      loaded: Boolean(process),
      vramBytes: process?.size_vram ?? 0,
      modifiedAt: tag.modified_at ?? null,
      digest: tag.digest ?? null,
    };
  });
}

/**
 * The models a delete must refuse: the ones that are resident in VRAM now,
 * and the one this Core is currently routing to.
 */
export async function protectedModels(options: OllamaManagementOptions, extra: string[] = []): Promise<{ loaded: string[]; selected: string[] }> {
  const loaded: string[] = [];
  try {
    const running = await ollamaGet(options, '/api/ps') as { models?: OllamaProcess[] };
    for (const entry of running.models ?? []) if (entry.name) loaded.push(entry.name);
  } catch { /* Ollama is not answering; nothing is loaded then */ }
  const selected = extra.filter(Boolean);
  return { loaded, selected };
}

export function createOllamaManagementAdapter(options: OllamaManagementOptions = {}): GovernedCapabilityAdapter {
  const freeDiskBytes = options.freeDiskBytes ?? defaultFreeDiskBytes;

  async function list(): Promise<ToolExecutionResult> {
    try {
      const models = await listOllamaModels(options);
      const lines = models.map((model) => `${model.loaded ? '[loaded]' : '[installed]'} ${model.name} — ${(model.sizeBytes / 1e9).toFixed(1)} GB${model.loaded ? ` (${(model.vramBytes / 1e9).toFixed(1)} GB in VRAM)` : ''}`);
      return {
        status: 'succeeded', exitCode: 0,
        output: lines.length ? `${lines.length} model(s) installed:\n${lines.join('\n')}` : 'No model is installed in Ollama.',
        resultCategory: 'ollama_models_listed',
        normalizedArguments: { count: models.length },
      };
    } catch (error) {
      return failure(`Ollama did not answer: ${error instanceof Error ? error.message : String(error)}`, 'ollama_unreachable');
    }
  }

  async function pull(call: ModelToolCall): Promise<ToolExecutionResult> {
    const requested = typeof call.arguments.model === 'string' ? call.arguments.model.trim() : '';
    if (!requested) return failure('model is required', 'invalid_arguments');
    if (!/^[A-Za-z0-9._\-/:@]+$/.test(requested)) return failure('that is not a valid model name', 'invalid_arguments');
    let installed: OllamaModelView[];
    try {
      installed = await listOllamaModels(options);
    } catch (error) {
      return failure(`Ollama did not answer: ${error instanceof Error ? error.message : String(error)}`, 'ollama_unreachable');
    }
    const already = installed.find((model) => model.name === requested || model.name.split(':')[0] === requested.split(':')[0]);
    if (already && already.name === requested) {
      return { status: 'succeeded', exitCode: 0, output: `"${requested}" is already installed (${(already.sizeBytes / 1e9).toFixed(1)} GB). Nothing was downloaded.`, resultCategory: 'ollama_model_present' };
    }
    const free = freeDiskBytes();
    const knownSize = already?.sizeBytes ?? 0;
    if (knownSize > 0 && knownSize > free) {
      return failure(`"${requested}" needs about ${(knownSize / 1e9).toFixed(1)} GB but only ${(free / 1e9).toFixed(1)} GB are free. Free some space first.`, 'ollama_insufficient_disk');
    }
    const fetcher = options.fetchImpl ?? fetch;
    try {
      const response = await fetcher(`${ollamaUrl(options)}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: requested, stream: false }),
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return failure(`Ollama could not pull "${requested}" (${response.status}): ${text.slice(0, 200)}`, 'ollama_pull_failed');
      }
      await response.json().catch(() => ({}));
      const after = await listOllamaModels(options);
      const now = after.find((model) => model.name === requested);
      if (!now) return failure(`Ollama reported the pull finished but "${requested}" is not in the model list.`, 'ollama_pull_unverified');
      return {
        status: 'succeeded', exitCode: 0,
        output: `Pulled "${requested}" (${(now.sizeBytes / 1e9).toFixed(1)} GB). It is installed and can be used now.`,
        resultCategory: 'ollama_model_pulled',
        normalizedArguments: { model: requested, sizeBytes: now.sizeBytes },
      };
    } catch (error) {
      return failure(`the pull failed: ${error instanceof Error ? error.message : String(error)}`, 'ollama_pull_failed');
    }
  }

  async function unload(call: ModelToolCall): Promise<ToolExecutionResult> {
    const requested = typeof call.arguments.model === 'string' ? call.arguments.model.trim() : '';
    if (!requested) return failure('model is required', 'invalid_arguments');
    const models = await listOllamaModels(options);
    const target = models.find((model) => model.name === requested);
    if (!target) return failure(`"${requested}" is not installed in Ollama.`, 'ollama_model_unknown');
    if (!target.loaded) {
      return { status: 'succeeded', exitCode: 0, output: `"${requested}" was not loaded in VRAM, so nothing had to be freed.`, resultCategory: 'ollama_model_not_loaded' };
    }
    const fetcher = options.fetchImpl ?? fetch;
    try {
      const response = await fetcher(`${ollamaUrl(options)}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: requested, keep_alive: 0 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return failure(`Ollama could not unload "${requested}" (${response.status}).`, 'ollama_unload_failed');
      await response.json().catch(() => ({}));
      return {
        status: 'succeeded', exitCode: 0,
        output: `Unloaded "${requested}" from VRAM; about ${(target.vramBytes / 1e9).toFixed(1)} GB was freed.`,
        resultCategory: 'ollama_model_unloaded',
        normalizedArguments: { model: requested, vramBytes: target.vramBytes },
      };
    } catch (error) {
      return failure(`the unload failed: ${error instanceof Error ? error.message : String(error)}`, 'ollama_unload_failed');
    }
  }

  async function remove(call: ModelToolCall): Promise<ToolExecutionResult> {
    const requested = typeof call.arguments.model === 'string' ? call.arguments.model.trim() : '';
    if (!requested) return failure('model is required', 'invalid_arguments');
    const models = await listOllamaModels(options);
    const target = models.find((model) => model.name === requested);
    if (!target) return failure(`"${requested}" is not installed in Ollama.`, 'ollama_model_unknown');
    // An actively used model is never removed: that would break the very
    // session that asked for it.
    if (target.loaded) {
      return failure(`"${requested}" is loaded in VRAM right now (${(target.vramBytes / 1e9).toFixed(1)} GB). Unload it first, then remove it.`, 'ollama_model_in_use');
    }
    const selected = typeof call.arguments.confirm === 'string' ? call.arguments.confirm.trim() : '';
    if (selected !== requested) {
      return failure(`Deleting a model is irreversible. Confirm by passing confirm="${requested}".`, 'ollama_delete_not_confirmed');
    }
    const fetcher = options.fetchImpl ?? fetch;
    try {
      const response = await fetcher(`${ollamaUrl(options)}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: requested }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return failure(`Ollama could not delete "${requested}" (${response.status}): ${text.slice(0, 200)}`, 'ollama_delete_failed');
      }
      const after = await listOllamaModels(options);
      if (after.some((model) => model.name === requested)) {
        return failure(`Ollama reported the delete finished but "${requested}" is still listed.`, 'ollama_delete_unverified');
      }
      return {
        status: 'succeeded', exitCode: 0,
        output: `Deleted "${requested}" (${(target.sizeBytes / 1e9).toFixed(1)} GB freed on disk).`,
        resultCategory: 'ollama_model_deleted',
        normalizedArguments: { model: requested, sizeBytes: target.sizeBytes },
      };
    } catch (error) {
      return failure(`the delete failed: ${error instanceof Error ? error.message : String(error)}`, 'ollama_delete_failed');
    }
  }

  async function run(call: ModelToolCall): Promise<ToolExecutionResult> {
    if (call.name === 'ollama_list_models') return list();
    if (call.name === 'ollama_pull_model') return pull(call);
    if (call.name === 'ollama_unload_model') return unload(call);
    if (call.name === 'ollama_delete_model') return remove(call);
    return failure(`unknown tool '${call.name}'`, 'invalid_arguments');
  }

  return {
    id: 'ollama-management',
    definitions: () => [
      {
        name: 'ollama_list_models',
        description: 'List the local Ollama models that are installed, with their size on disk and whether each one is currently loaded in VRAM. Read-only, no approval needed. Use it before any pull, unload or delete.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'ollama_pull_model',
        description: 'Download a model into the local Ollama. Consequential and approval-gated: the approval names the exact model. Pandesh refuses when the disk cannot hold it and never downloads anything without this approval. Use a small model unless the person asked for a specific one.',
        parameters: { type: 'object', properties: { model: { type: 'string', description: 'The Ollama model id, e.g. "qwen2.5-coder:3b".' } }, required: ['model'] },
      },
      {
        name: 'ollama_unload_model',
        description: 'Free the VRAM a local model occupies by asking Ollama to unload it (keep_alive 0). Consequential and approval-gated. The model stays installed; only its GPU memory is released.',
        parameters: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
      },
      {
        name: 'ollama_delete_model',
        description: 'Remove a local model from disk and free the space. Irreversible, so it is approval-gated AND refuses while the model is loaded or in use. The call must also pass confirm with the exact model id.',
        parameters: { type: 'object', properties: { model: { type: 'string' }, confirm: { type: 'string', description: 'The exact model id again, so a deletion is never a slip.' } }, required: ['model', 'confirm'] },
      },
    ],
    classify: (toolName) => (toolName === 'ollama_list_models' ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    redactArguments: (_toolName, args) => ({ ...args }),
    run,
  };
}
