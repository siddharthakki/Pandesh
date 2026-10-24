import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

describe('Desktop governed image generation', () => {
  it('starts services, waits for exact approval, then returns Core artifact ids', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-image-session-'));
    const ensureImageStudio = vi.fn(async (onStatus?: (text: string) => void) => {
      onStatus?.('Waking up Image Generation Studio…');
      return { studio: true, comfyui: true, ollama: true, detail: 'ready', checkpoints: [{ name: 'fixture.safetensors', category: 'general' }] };
    });
    const dispatchCapability = vi.fn()
      .mockResolvedValueOnce({
        outcome: 'approval_required', attemptId: 'attempt-image',
        approval: {
          id: 'approval-image', attemptId: 'attempt-image', expectedAttemptRevision: 1,
          expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'digest',
          frozenContextHash: 'context', presentation: { prompt: 'A blue control center', width: 1024, height: 1024 },
        },
      })
      .mockResolvedValueOnce({
        outcome: 'executed', attemptId: 'attempt-image',
        toolInvocation: { status: 'succeeded', evidence: { output: JSON.stringify({ artifactIds: ['artifact-1'], message: 'Generated 1 verified image' }) } },
      });
    const resolveCapabilityApproval = vi.fn(async () => ({}));
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir, ensureImageStudio });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      createConversation: async () => ({ id: 'conversation-image' }),
      dispatchCapability, resolveCapabilityApproval,
    };
    internal.coreState = 'connected';
    const requested = await host.generateImage({ prompt: 'A blue control center', checkpoint: 'fixture.safetensors', width: 1024, height: 1024, outputCount: 1 });
    expect(requested).toMatchObject({ outcome: 'approval_required', approvalId: 'approval-image' });
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    expect(ensureImageStudio).not.toHaveBeenCalled();

    const generated = await host.resolveImageApproval('approval-image', 'approved');
    expect(ensureImageStudio).toHaveBeenCalledTimes(1);
    expect(resolveCapabilityApproval).toHaveBeenCalledWith('approval-image', expect.objectContaining({ resolution: 'approved', requestedActionDigest: 'digest' }));
    expect(dispatchCapability).toHaveBeenCalledTimes(2);
    expect(dispatchCapability.mock.calls[1][0]).toEqual(dispatchCapability.mock.calls[0][0]);
    expect(generated).toEqual({ outcome: 'executed', attemptId: 'attempt-image', artifactIds: ['artifact-1'], message: 'Generated 1 verified image' });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports a bounded terminal failure when approved services cannot start', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-image-session-fail-'));
    const dispatchCapability = vi.fn().mockResolvedValue({
      outcome: 'approval_required', attemptId: 'attempt-image-fail',
      approval: {
        id: 'approval-image-fail', attemptId: 'attempt-image-fail', expectedAttemptRevision: 1,
        expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'digest-fail',
        frozenContextHash: 'context-fail', presentation: { prompt: 'A blue control center' },
      },
    });
    const host = new DesktopSession({
      productRoot: process.cwd(), dataDir,
      ensureImageStudio: async () => { throw new Error(`ComfyUI failed ${'detail '.repeat(200)}`); },
    });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      createConversation: async () => ({ id: 'conversation-image-fail' }),
      dispatchCapability,
      resolveCapabilityApproval: async () => ({}),
    };
    internal.coreState = 'connected';
    const events: Array<{ eventType?: string; summary: string }> = [];
    host.onEvent((event) => events.push(event));
    await host.generateImage({ prompt: 'A blue control center', checkpoint: 'fixture.safetensors' });
    const result = await host.resolveImageApproval('approval-image-fail', 'approved');
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') expect(result.reason.length).toBeLessThanOrEqual(501);
    expect(events.at(-1)?.eventType).toBe('image_generation_failed');
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('routes a chat-typed image request through the same governed image_generate approval, auto-picking the general checkpoint', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-image-session-chat-'));
    const dispatchCapability = vi.fn().mockResolvedValueOnce({
      outcome: 'approval_required', attemptId: 'attempt-chat-image',
      approval: {
        id: 'approval-chat-image', attemptId: 'attempt-chat-image', expectedAttemptRevision: 1,
        expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'digest-chat',
        frozenContextHash: 'context-chat', presentation: { prompt: 'a cute panda eating dosa. Indian dosa.', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors' },
      },
    });
    const host = new DesktopSession({
      productRoot: process.cwd(), dataDir,
      probeImageStudio: async () => ({
        studio: true, comfyui: true, ollama: true, detail: 'ready',
        checkpoints: [
          { name: 'oneObsession_anima29BV1.safetensors', category: 'anime' },
          { name: 'v1-5-pruned-emaonly-fp16.safetensors', category: 'general' },
        ],
      }),
    });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      createConversation: async () => ({ id: 'conversation-chat-image' }),
      dispatchCapability,
      resolveCapabilityApproval: async () => ({}),
    };
    internal.coreState = 'connected';

    const result = await host.submitTask('generate an image of a cute panda eating dosa. Indian dosa.');
    expect(result.model).toBe('image-studio');
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    expect(dispatchCapability.mock.calls[0][0]).toMatchObject({
      toolName: 'image_generate',
      arguments: expect.objectContaining({ prompt: 'a cute panda eating dosa. Indian dosa.', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors' }),
    });
    expect(host.snapshot().pendingImageApproval).toMatchObject({
      approvalId: 'approval-chat-image', attemptId: 'attempt-chat-image',
      presentation: { prompt: 'a cute panda eating dosa. Indian dosa.', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors' },
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('deep-links a verified artifact into the standalone Studio app by prompt or by filename as a reference', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-image-session-studio-link-'));
    const imagePath = path.join(dataDir, 'gen_20260101_000000_1539504420_0.png');
    const bytes = Buffer.from('fake-png-bytes');
    fs.writeFileSync(imagePath, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      getArtifact: async () => ({
        id: 'artifact-1', absolutePath: imagePath, byteSize: bytes.length, sha256,
        kind: 'image', mimeType: 'image/png', title: 'A cute panda eating dosa',
        metadata: { prompt: 'A cute panda eating dosa. Indian dosa.' }, availability: 'ready',
      }),
    };
    internal.coreState = 'connected';

    const promptUrl = await host.imageStudioAppUrlForPrompt('artifact-1');
    expect(promptUrl).toBe('http://127.0.0.1:8989/?prompt=A+cute+panda+eating+dosa.+Indian+dosa.');

    const refUrl = await host.imageStudioAppUrlForReference('artifact-1');
    expect(refUrl).toBe('http://127.0.0.1:8989/?ref=gen_20260101_000000_1539504420_0.png');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
