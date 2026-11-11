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

describe('pictures in the Workshop: a change is the next version of the picture on screen, never another conversation\'s', () => {
  /** Just enough of a PNG for its header to say its size. */
  const png = (w: number, h: number) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
  let counter = 0;
  const studio = (sent: Array<Record<string, unknown>>) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/status')) return new Response(JSON.stringify({ comfyui: true }), { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push(body);
    counter += 1;
    const name = `out-${counter}.png`;
    fs.writeFileSync(path.join(dir, 'output', name), png(Number(body.width), Number(body.height)));
    return new Response(JSON.stringify({ status: 'completed', images: [{ path: `/images/${name}`, seed: 7 }], used_checkpoint: 'sdxl.safetensors' }), { status: 200 });
  });
  const ctxOf = (conversationId: string) => ({ cwd: dir, correlationId: conversationId, attemptId: null } as never);

  it('"Create a square promotional image", then "make the background darker" on the picture open in the Workshop', async () => {
    const { listWorkshops, recordWorkshopFocus } = await import('../domain/workshops');
    const elsewhere = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const here = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createImageStudioCapabilityAdapter({ db, studioRoot: dir, fetchImpl: studio(sent) as unknown as typeof fetch });
    // An image in another conversation must never become the reference here.
    await adapter.run({ name: 'image_generate', arguments: { prompt: 'unrelated', checkpoint: 'sdxl.safetensors' } }, ctxOf(elsewhere.id));
    const first = await adapter.run({ name: 'image_generate', arguments: { prompt: 'Kha ke dikha biryani promo, square', checkpoint: 'sdxl.safetensors', width: 1024, height: 1024 } }, ctxOf(here.id));
    expect(first.status).toBe('succeeded');
    expect(sent[1]).not.toHaveProperty('image_ref');
    const [w1] = listWorkshops(db, { conversationId: here.id });
    expect(w1).toMatchObject({ type: 'image' });
    expect(w1.versions[0].meta).toMatchObject({ parentArtifactId: null, op: { kind: 'generate' }, engine: { tool: 'image_generate', provider: 'local', costUsd: 0 } });
    expect(w1.versions[0].meta.verification).toEqual({ ok: true, checks: ['PASS a 1024×1024 PNG (asked for 1024×1024), read from the file\'s own header'] });

    // The window shows it; "make the background darker" names no picture: the approval card names the one on screen.
    recordWorkshopFocus(db, { conversationId: here.id, workshopId: w1.workshopId, artifactId: w1.latestArtifactId, open: true, actor: 'window' });
    const args = await adapter.prepare!('image_generate', { prompt: 'Kha ke dikha biryani promo, square, darker background', checkpoint: 'sdxl.safetensors', denoise: 0.45 }, { correlationId: here.id });
    expect(args).toMatchObject({ referenceArtifactId: w1.latestArtifactId, changes: expect.stringMatching(/^the picture open in the Workshop: ".*", version 1$/) });
    const second = await adapter.run({ name: 'image_generate', arguments: args }, ctxOf(here.id));
    expect(second.status).toBe('succeeded');
    expect(sent[2]).toMatchObject({ image_ref: 'out-2.png', denoise: 0.45 });
    const [w2] = listWorkshops(db, { conversationId: here.id });
    expect(w2.workshopId).toBe(w1.workshopId);
    expect(w2.versions).toHaveLength(2);
    expect(w2.versions[1].meta).toMatchObject({ parentArtifactId: w1.latestArtifactId, op: { kind: 'refine' } });
    expect(w2.versions[1].meta.notes?.[0]).toMatch(/whole picture was regenerated/);
    expect(w2.versions[1].meta.recipe).toMatchObject({ referenceArtifactId: w1.latestArtifactId, denoise: 0.45 });
  });

  it('without a picture on screen, nothing implicit is used; a closed Workshop changes nothing', async () => {
    const { listWorkshops, recordWorkshopFocus } = await import('../domain/workshops');
    const here = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createImageStudioCapabilityAdapter({ db, studioRoot: dir, fetchImpl: studio(sent) as unknown as typeof fetch });
    await adapter.run({ name: 'image_generate', arguments: { prompt: 'first', checkpoint: 'sdxl.safetensors' } }, ctxOf(here.id));
    const [w] = listWorkshops(db, { conversationId: here.id });
    recordWorkshopFocus(db, { conversationId: here.id, workshopId: w.workshopId, artifactId: w.latestArtifactId, open: false, actor: 'window' });
    const args = await adapter.prepare!('image_generate', { prompt: 'second', checkpoint: 'sdxl.safetensors' }, { correlationId: here.id });
    expect(args).not.toHaveProperty('referenceArtifactId');
    await adapter.run({ name: 'image_generate', arguments: args }, ctxOf(here.id));
    expect(sent[1]).not.toHaveProperty('image_ref');
    expect(listWorkshops(db, { conversationId: here.id })).toHaveLength(2);
  });
});
