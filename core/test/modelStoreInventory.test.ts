import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-expect-error plain ESM script without types
import { inventory, readGgufHeader, readOllamaStore, toMarkdown, engineOf } from '../../scripts/inventory/model-store-inventory.mjs';

/** A minimal but valid GGUF v3 file: header, the given string/uint32 KVs, no tensors, then padding to `size` bytes. */
function writeGguf(file: string, kv: Record<string, string | number>, size = 4096, fill = 0): void {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length));
  for (const [k, v] of Object.entries(kv)) parts.push(str(k), typeof v === 'string' ? Buffer.concat([u32(8), str(v)]) : Buffer.concat([u32(4), u32(v)]));
  const head = Buffer.concat(parts);
  const body = Buffer.alloc(Math.max(0, size - head.length), fill);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, body]));
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelinv-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('model store inventory (synthetic stores only)', () => {
  it('reads architecture, name and quantization from a GGUF header, and ignores non-GGUF files', () => {
    const f = path.join(dir, 'm.gguf');
    writeGguf(f, { 'general.architecture': 'qwen3', 'general.name': 'Qwen3 27B', 'general.file_type': 15, 'qwen3.context_length': 32768 });
    expect(readGgufHeader(f)).toMatchObject({ version: 3, architecture: 'qwen3', name: 'Qwen3 27B', fileType: 'Q4_K_M', contextLength: 32768 });
    fs.writeFileSync(path.join(dir, 'x.bin'), 'not a model');
    expect(readGgufHeader(path.join(dir, 'x.bin'))).toBeNull();
  });

  it('maps Ollama blobs to model names, counts a shared blob once, and finds a loose copy of a blob', () => {
    const store = path.join(dir, 'ollama');
    const digest = 'sha256-' + 'a'.repeat(64);
    writeGguf(path.join(store, 'blobs', digest), { 'general.architecture': 'gemma3', 'general.file_type': 7 }, 8192, 7);
    const manifest = (name: string[]) => {
      const p = path.join(store, 'manifests', ...name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: digest.replace('-', ':'), size: 8192 }, { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:t', size: 10 }] }));
    };
    manifest(['registry.ollama.ai', 'library', 'gemma4', '12b']);
    manifest(['hf.co', 'someone', 'Gemma-GGUF', 'Q8_0']);
    const byDigest = readOllamaStore(store);
    expect([...byDigest.values()][0].models.sort()).toEqual(['gemma4:12b', 'hf.co/someone/Gemma-GGUF:Q8_0']);

    // The same bytes exported as a loose GGUF for LM Studio: real extra disk use.
    const loose = path.join(dir, 'lmstudio', 'someone', 'gemma.gguf');
    fs.mkdirSync(path.dirname(loose), { recursive: true });
    fs.copyFileSync(path.join(store, 'blobs', digest), loose);
    // A different quantization of similar size: not a duplicate.
    writeGguf(path.join(dir, 'lmstudio', 'other', 'gemma-q4.gguf'), { 'general.architecture': 'gemma3', 'general.file_type': 15 }, 8192, 9);

    const inv = inventory({ roots: [{ engine: 'ollama', dir: store }, { engine: 'lmstudio', dir: path.join(dir, 'lmstudio') }], minBytes: 1, full: true });
    expect(inv.ollamaBlobs).toHaveLength(1);
    expect(inv.sharedBlobs).toHaveLength(1);
    expect(inv.totals.ollama).toBe(8192); // counted once though two names use it
    expect(inv.duplicateGroups).toHaveLength(1);
    expect(inv.duplicateGroups[0]).toMatchObject({ copies: 2, reclaimableBytes: 8192, confirmedByFullHash: true });
    expect(inv.duplicateGroups[0].members.map((m: { kind: string }) => m.kind).sort()).toEqual(['file', 'ollama-blob']);
    expect(toMarkdown(inv)).toMatch(/1 groups, 0\.00 GB reclaimable/);
  });

  it('is read-only: the scanned tree is byte-for-byte the same afterwards', () => {
    writeGguf(path.join(dir, 'a', 'one.gguf'), { 'general.architecture': 'llama' }, 2048);
    fs.copyFileSync(path.join(dir, 'a', 'one.gguf'), path.join(dir, 'a', 'two.gguf'));
    const snapshot = () => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => { const p = path.join(e.parentPath, e.name); const s = fs.statSync(p); return `${p}:${s.size}:${s.mtimeMs}`; }).sort();
    const before = snapshot();
    inventory({ roots: [{ engine: 'other', dir }], minBytes: 1, full: true });
    expect(snapshot()).toEqual(before);
  });

  it('names the engine from the path', () => {
    expect(engineOf('E:/AI/huggingface/hub/models--Qwen--X/blobs/abc', 'local-ai')).toBe('huggingface');
    expect(engineOf('C:/Projects/ImageGeneration/ComfyUI/models/checkpoints/x.safetensors', 'comfyui')).toBe('comfyui');
    expect(engineOf('D:/AI/Strata-data/models/x.gguf', 'local-ai')).toBe('strata');
  });
});
