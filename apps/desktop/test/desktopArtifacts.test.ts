import { afterEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-artifact-'));
  dirs.push(dir);
  const file = path.join(dir, 'generated.png');
  const bytes = Buffer.from('safe synthetic png');
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes };
}

function hostWith(record: Record<string, unknown>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-artifact-profile-'));
  dirs.push(dataDir);
  const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  const internal = host as unknown as { client: Record<string, unknown>; coreState: string };
  internal.client = { listArtifacts: async () => ({ artifacts: [record] }), getArtifact: async () => record };
  internal.coreState = 'connected';
  return host;
}

describe('Desktop artifact boundary', () => {
  it('projects a basename to the renderer and returns verified image bytes only on demand', async () => {
    const { file, bytes } = fixture();
    const record = {
      id: 'artifact-1', conversationId: 'conv-1', requestId: null, attemptId: null,
      kind: 'image', title: 'Generated image', mimeType: 'image/png', absolutePath: file,
      byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      source: 'image-studio', metadata: {}, createdAt: new Date().toISOString(), availability: 'ready',
    };
    const host = hostWith(record);
    const [view] = await host.listArtifacts();
    expect(view.fileName).toBe('generated.png');
    expect(JSON.stringify(view)).not.toContain(path.dirname(file));
    const preview = await host.loadArtifactPreview('artifact-1');
    expect(preview.dataUrl).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it('refuses preview when bytes changed after Core recorded them', async () => {
    const { file, bytes } = fixture();
    const record = {
      id: 'artifact-1', conversationId: null, requestId: null, attemptId: null,
      kind: 'image', title: 'Image', mimeType: 'image/png', absolutePath: file,
      byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      source: 'image-studio', metadata: {}, createdAt: new Date().toISOString(), availability: 'ready',
    };
    const host = hostWith(record);
    fs.writeFileSync(file, 'different bytes');
    await expect(host.loadArtifactPreview('artifact-1')).rejects.toThrow(/changed after Core recorded/);
  });
});
