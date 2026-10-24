import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createConversation } from '../domain/conversations';
import { dispatchCapability, resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { listArtifacts } from '../domain/artifacts';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createImageStudioCapabilityAdapter } from '../runtime/imageStudioCapability';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-studio-cap-')); fs.mkdirSync(path.join(dir, 'output')); fs.writeFileSync(path.join(dir, 'app.py'), '# fixture'); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function approve(approval: any) {
  resolveCapabilityApproval(db, {
    approvalId: approval.id, resolution: 'approved', attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision, expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest, frozenContextHash: approval.frozenContextHash,
    actor: 'operator', clientId: 'desktop', idempotencyKey: `approve:${approval.id}`,
  });
}

describe('Image Studio governed capability', () => {
  it('does not call Studio before approval, then registers exactly one verified artifact', async () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/status')) return new Response(JSON.stringify({ comfyui: true, ollama: true }), { status: 200 });
      if (url.endsWith('/api/generate')) {
        fs.writeFileSync(path.join(dir, 'output', 'result.png'), 'verified-image-bytes');
        return new Response(JSON.stringify({ status: 'completed', images: [{ path: '/images/result.png', seed: 42 }], used_checkpoint: 'sdxl.safetensors' }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const registry = new GovernedCapabilityRegistry().register(createImageStudioCapabilityAdapter({ db, studioRoot: dir, fetchImpl: fetchImpl as typeof fetch }));
    const input = { correlationId: conversation.id, toolName: 'image_generate', arguments: { prompt: 'A calm blue control center', checkpoint: 'sdxl.safetensors', width: 1024, height: 1024, seed: 42 }, cwd: dir, actor: 'desktop', clientId: 'desktop' };
    const requested = await dispatchCapability(db, registry, input);
    expect(requested.outcome).toBe('approval_required');
    expect(fetchImpl).not.toHaveBeenCalled();
    if (requested.outcome !== 'approval_required') throw new Error('expected approval');
    approve(requested.approval);
    const executed = await dispatchCapability(db, registry, input);
    expect(executed.outcome).toBe('executed');
    const [artifact] = listArtifacts(db, conversation.id);
    expect(artifact.availability).toBe('ready');
    expect(artifact.source).toBe('image-generation-studio');
    expect(artifact.metadata).toMatchObject({ prompt: 'A calm blue control center', seed: 42, checkpoint: 'sdxl.safetensors' });
  });

  it('lists the live checkpoints read-only, with no approval gate, for chat to recommend from', async () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/models')) {
        return new Response(JSON.stringify({
          checkpoints: [
            { name: 'oneObsession_anima29BV1.safetensors', category: 'anime' },
            { name: 'v1-5-pruned-emaonly-fp16.safetensors', category: 'general' },
          ],
        }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const adapter = createImageStudioCapabilityAdapter({ db, studioRoot: dir, fetchImpl: fetchImpl as typeof fetch });
    expect(adapter.classify('image_list_checkpoints')).toBe('read_only');
    const registry = new GovernedCapabilityRegistry().register(adapter);
    const input = { correlationId: conversation.id, toolName: 'image_list_checkpoints', arguments: {}, cwd: dir, actor: 'desktop', clientId: 'desktop' };
    const result = await dispatchCapability(db, registry, input);
    expect(result.outcome).toBe('executed');
    if (result.outcome !== 'executed') throw new Error('expected immediate execution, no approval');
    expect(JSON.parse(result.toolInvocation.evidence.output as string)).toEqual({
      checkpoints: [
        { name: 'oneObsession_anima29BV1.safetensors', category: 'anime' },
        { name: 'v1-5-pruned-emaonly-fp16.safetensors', category: 'general' },
      ],
    });
  });

  it('fails without creating an artifact when ComfyUI is down', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ comfyui: false, ollama: true }), { status: 200 }));
    const adapter = createImageStudioCapabilityAdapter({ db, studioRoot: dir, fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'image_generate', arguments: { prompt: 'test image', checkpoint: 'fixture.safetensors' } }, { cwd: dir });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('image_studio_comfyui_unavailable');
    expect(listArtifacts(db)).toEqual([]);
  });

  it('bounds provider diagnostics instead of persisting an unbounded traceback', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/status')) return new Response(JSON.stringify({ comfyui: true, ollama: true }), { status: 200 });
      return new Response(JSON.stringify({ status: 'failed', message: `traceback ${'frame '.repeat(500)}` }), { status: 200 });
    });
    const adapter = createImageStudioCapabilityAdapter({ db, studioRoot: dir, fetchImpl: fetchImpl as typeof fetch });
    const result = await adapter.run({ name: 'image_generate', arguments: { prompt: 'test image', checkpoint: 'fixture.safetensors' } }, { cwd: dir });
    expect(result.status).toBe('failed');
    expect(result.output.length).toBeLessThanOrEqual(501);
    expect(result.output.endsWith('…')).toBe(true);
    expect(listArtifacts(db)).toEqual([]);
  });
});
