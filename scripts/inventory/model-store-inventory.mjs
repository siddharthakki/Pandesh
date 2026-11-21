#!/usr/bin/env node
/**
 * Cross-engine model store inventory. METADATA ONLY and READ-ONLY: it never moves, deletes, links, renames or writes inside a
 * scanned root. It complements scripts/model-inventory-audit.mjs (Ollama API + evals) by looking at the files on disk for every
 * engine: Ollama blobs (mapped to model names through their manifests), LM Studio, Hugging Face caches, ComfyUI, llama.cpp, and
 * any other folder given with --root.
 *
 * For each model file it records: path, size, format, engine (by location), GGUF architecture / name / file type when the file is
 * GGUF, and a sampled fingerprint (sha256 of size + first and last 1 MiB). Ollama blobs are content-addressed (sha256 file name).
 * Duplicates:
 *   - exact: same Ollama blob digest referenced by several model names (no extra disk use: shared blob);
 *   - probable: same size and same sampled fingerprint in different places (real extra disk use). --full-hash confirms them with
 *     a full sha256 of those candidates only.
 *
 * Usage:
 *   node scripts/inventory/model-store-inventory.mjs [--root <dir>]... [--no-defaults] [--full-hash] [--out <dir>] [--min-mb 50]
 * Writes model-inventory.json and model-inventory.md to --out (default: .acceptance-evidence/model-store-inventory/<stamp>).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MODEL_EXT = new Set(['.gguf', '.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.onnx', '.pb', '.engine']);
const SAMPLE = 1024 * 1024;

/** Default roots on this kind of machine; only those that exist are scanned. */
export function defaultRoots(env = process.env, home = os.homedir()) {
  const roots = [
    { engine: 'ollama', dir: env.OLLAMA_MODELS || path.join(home, '.ollama', 'models') },
    { engine: 'lmstudio', dir: path.join(home, '.lmstudio', 'models') },
    { engine: 'lmstudio', dir: path.join(home, '.cache', 'lm-studio', 'models') },
    { engine: 'huggingface', dir: env.HF_HOME ? path.join(env.HF_HOME, 'hub') : path.join(home, '.cache', 'huggingface', 'hub') },
    { engine: 'huggingface', dir: path.join(home, '.cache', 'huggingface', 'hub') },
    { engine: 'llama.cpp', dir: path.join(home, '.cache', 'llama.cpp') },
    { engine: 'comfyui', dir: 'C:\\Projects\\ImageGeneration' },
    { engine: 'local-ai', dir: 'D:\\AI' },
    { engine: 'local-ai', dir: 'E:\\AI' },
  ];
  const seen = new Set();
  return roots.filter((r) => { const k = path.resolve(r.dir).toLowerCase(); if (seen.has(k) || !fs.existsSync(r.dir)) return false; seen.add(k); return true; });
}

/** Engine guessed from a path, for files found under a generic root. */
export function engineOf(file, rootEngine) {
  const p = file.replace(/\\/g, '/').toLowerCase();
  if (p.includes('/.ollama/') || /\/ollama\/models\//.test(p)) return 'ollama';
  if (p.includes('/.lmstudio/') || p.includes('/lm-studio/')) return 'lmstudio';
  if (p.includes('/huggingface/') || /\/models--[^/]+--/.test(p)) return 'huggingface';
  if (p.includes('comfyui') || p.includes('/imagegeneration/')) return 'comfyui';
  if (p.includes('/strata')) return 'strata';
  if (p.includes('llama')) return 'llama.cpp';
  if (p.includes('vllm')) return 'vllm';
  return rootEngine;
}

const GGUF_TYPES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }; // byte widths of scalar value types
const FILE_TYPE = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 28: 'IQ4_XS', 30: 'BF16', 32: 'TQ1_0', 33: 'TQ2_0', 38: 'MXFP4' };

/**
 * Reads the GGUF header (bounded: the first 16 MiB) and returns architecture, name, file type and parameter hints.
 * Returns null for a non-GGUF file and { error } for a header it cannot parse. Never throws.
 */
export function readGgufHeader(file, limit = 16 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(limit, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'GGUF') return null;
    const version = buf.readUInt32LE(4);
    let off = version === 1 ? 16 : 24; // v1 used 32-bit counts
    const kvCount = version === 1 ? buf.readUInt32LE(12) : Number(buf.readBigUInt64LE(16));
    const str = () => { const n = Number(buf.readBigUInt64LE(off)); off += 8; const s = buf.toString('utf8', off, off + n); off += n; return s; };
    const value = (t) => {
      if (t === 8) return str();
      if (t === 9) { const at = buf.readUInt32LE(off); off += 4; const n = Number(buf.readBigUInt64LE(off)); off += 8; for (let i = 0; i < n; i++) value(at); return `[array ${n}]`; }
      const w = GGUF_TYPES[t];
      if (!w) throw new Error(`unknown GGUF value type ${t}`);
      let v;
      if (t === 4) v = buf.readUInt32LE(off); else if (t === 5) v = buf.readInt32LE(off); else if (t === 6) v = buf.readFloatLE(off);
      else if (t === 10 || t === 11) v = Number(buf.readBigUInt64LE(off)); else if (t === 0 || t === 7) v = buf.readUInt8(off); else v = null;
      off += w;
      return v;
    };
    const meta = {};
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      const t = buf.readUInt32LE(off); off += 4;
      const v = value(t);
      if (/^general\.(architecture|name|file_type|size_label|basename|quantization_version)$/.test(key) || /\.context_length$|\.block_count$/.test(key)) meta[key] = v;
      if (off > buf.length - 16) break;
    }
    return {
      version,
      architecture: meta['general.architecture'] ?? null,
      name: meta['general.name'] ?? meta['general.basename'] ?? null,
      sizeLabel: meta['general.size_label'] ?? null,
      fileType: meta['general.file_type'] !== undefined ? (FILE_TYPE[meta['general.file_type']] ?? `type ${meta['general.file_type']}`) : null,
      contextLength: Object.entries(meta).find(([k]) => k.endsWith('.context_length'))?.[1] ?? null,
    };
  } catch (err) {
    return { error: String(err.message ?? err).slice(0, 120) };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** sha256 over the size and the first and last MiB: cheap, and equal for byte-identical files. */
export function sampledFingerprint(file, size) {
  const h = createHash('sha256').update(String(size));
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(SAMPLE, size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (size > SAMPLE) {
      const tail = Buffer.alloc(Math.min(SAMPLE, size - head.length));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex').slice(0, 32);
}

function fullHash(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try { let n; let pos = 0; while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) { h.update(buf.subarray(0, n)); pos += n; } } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** Walks a root without following directory links (a junction into another store must not be counted twice). */
function* walk(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (depth < 14 && !/^(node_modules|\.git|__pycache__|venv|\.venv)$/i.test(e.name)) yield* walk(p, depth + 1); }
    else if (e.isFile()) yield p;
  }
}

/** Ollama: manifests name the blobs. Returns the blob files with the model names that use them. */
export function readOllamaStore(dir) {
  const manifests = path.join(dir, 'manifests');
  const blobs = path.join(dir, 'blobs');
  const byDigest = new Map();
  if (!fs.existsSync(manifests)) return byDigest;
  for (const file of walk(manifests)) {
    let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const rel = path.relative(manifests, file).split(path.sep);
    // registry/namespace/model/tag
    const name = rel.length >= 4 ? `${rel[1] === 'library' ? '' : `${rel[0] === 'registry.ollama.ai' ? '' : `${rel[0]}/`}${rel[1]}/`}${rel[2]}:${rel[3]}` : rel.join('/');
    for (const layer of m.layers ?? []) {
      if (!/model|projector|adapter/.test(layer.mediaType ?? '')) continue;
      const digest = String(layer.digest ?? '').replace(':', '-');
      const blob = path.join(blobs, digest);
      const entry = byDigest.get(digest) ?? { digest, file: blob, size: layer.size, mediaType: layer.mediaType, models: [] };
      entry.models.push(name);
      byDigest.set(digest, entry);
    }
  }
  return byDigest;
}

export function inventory({ roots, minBytes = 50 * 1024 * 1024, full = false }) {
  const files = [];
  const seenFiles = new Set();
  const ollamaBlobs = [];
  for (const root of roots) {
    if (root.engine === 'ollama' && fs.existsSync(path.join(root.dir, 'manifests'))) {
      for (const b of readOllamaStore(root.dir).values()) {
        const exists = fs.existsSync(b.file);
        const head = exists ? readGgufHeader(b.file) : null;
        ollamaBlobs.push({ ...b, exists, gguf: head });
        seenFiles.add(path.resolve(b.file).toLowerCase());
      }
      continue;
    }
    for (const file of walk(root.dir)) {
      const ext = path.extname(file).toLowerCase();
      if (!MODEL_EXT.has(ext)) continue;
      const key = path.resolve(file).toLowerCase();
      if (seenFiles.has(key)) continue;
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.size < minBytes) continue;
      seenFiles.add(key);
      files.push({ file, size: st.size, format: ext.slice(1), engine: engineOf(file, root.engine), modified: st.mtime.toISOString(), accessed: st.atime.toISOString(), gguf: ext === '.gguf' ? readGgufHeader(file) : null });
    }
  }
  // Probable duplicates: same size, then the same sampled fingerprint (including Ollama blobs against loose GGUF files).
  const all = [...files.map((f) => ({ ...f, kind: 'file' })), ...ollamaBlobs.filter((b) => b.exists).map((b) => ({ file: b.file, size: b.size, engine: 'ollama', kind: 'ollama-blob', models: b.models }))];
  const bySize = new Map();
  for (const f of all) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  const duplicateGroups = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byPrint = new Map();
    for (const f of group) { const fp = sampledFingerprint(f.file, f.size); byPrint.set(fp, [...(byPrint.get(fp) ?? []), f]); }
    for (const [fp, same] of byPrint) {
      if (same.length < 2) continue;
      let confirmed = null;
      if (full) { const hashes = new Set(same.map((f) => fullHash(f.file))); confirmed = hashes.size === 1; }
      duplicateGroups.push({ fingerprint: fp, size: same[0].size, copies: same.length, reclaimableBytes: same[0].size * (same.length - 1), confirmedByFullHash: confirmed, members: same.map((f) => ({ file: f.file, engine: f.engine, kind: f.kind, models: f.models })) });
    }
  }
  const sharedBlobs = ollamaBlobs.filter((b) => b.models.length > 1).map((b) => ({ digest: b.digest, size: b.size, models: b.models }));
  const totals = {};
  for (const f of files) totals[f.engine] = (totals[f.engine] ?? 0) + f.size;
  const uniqueOllama = new Map(ollamaBlobs.filter((b) => b.exists).map((b) => [b.digest, b.size]));
  totals.ollama = (totals.ollama ?? 0) + [...uniqueOllama.values()].reduce((a, b) => a + b, 0);
  return { scannedAt: new Date().toISOString(), roots, files, ollamaBlobs, duplicateGroups, sharedBlobs, totals, reclaimableBytes: duplicateGroups.reduce((a, g) => a + g.reclaimableBytes, 0) };
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

export function toMarkdown(inv) {
  const lines = [`# Model store inventory (${inv.scannedAt})`, '', 'Metadata only; nothing was moved, linked or deleted.', '', '## Disk use by engine', '', '| Engine | Size |', '|---|---|'];
  for (const [e, s] of Object.entries(inv.totals).sort((a, b) => b[1] - a[1])) lines.push(`| ${e} | ${gb(s)} |`);
  lines.push('', `## Ollama models (${inv.ollamaBlobs.length} model blobs)`, '', '| Model(s) | Size | Arch | Quant | Blob present |', '|---|---|---|---|---|');
  for (const b of [...inv.ollamaBlobs].sort((a, c) => c.size - a.size)) lines.push(`| ${b.models.join(', ')} | ${gb(b.size)} | ${b.gguf?.architecture ?? '?'} | ${b.gguf?.fileType ?? '?'} | ${b.exists ? 'yes' : 'NO'} |`);
  lines.push('', `## Other model files (${inv.files.length})`, '', '| File | Engine | Format | Size | Arch | Quant | Last modified |', '|---|---|---|---|---|---|---|');
  for (const f of [...inv.files].sort((a, b) => b.size - a.size)) lines.push(`| ${f.file} | ${f.engine} | ${f.format} | ${gb(f.size)} | ${f.gguf?.architecture ?? ''} | ${f.gguf?.fileType ?? ''} | ${f.modified.slice(0, 10)} |`);
  lines.push('', `## Probable duplicates (${inv.duplicateGroups.length} groups, ${gb(inv.reclaimableBytes)} reclaimable if one copy is kept)`, '');
  for (const g of inv.duplicateGroups) {
    lines.push(`- ${g.copies} × ${gb(g.size)} (fingerprint ${g.fingerprint.slice(0, 12)}${g.confirmedByFullHash === true ? ', confirmed by full hash' : g.confirmedByFullHash === false ? ', NOT identical by full hash' : ', sampled only'}):`);
    for (const m of g.members) lines.push(`  - ${m.file} (${m.engine}${m.models ? `: ${m.models.join(', ')}` : ''})`);
  }
  lines.push('', `## Ollama blobs shared by several names (${inv.sharedBlobs.length}; no extra disk use)`, '');
  for (const s of inv.sharedBlobs) lines.push(`- ${gb(s.size)}: ${s.models.join(', ')}`);
  return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('model-store-inventory.mjs')) {
  const argv = process.argv.slice(2);
  const extra = []; let out = null; let minMb = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') extra.push({ engine: 'other', dir: argv[++i] });
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--min-mb') minMb = Number(argv[++i]);
  }
  const roots = [...(argv.includes('--no-defaults') ? [] : defaultRoots()), ...extra.filter((r) => fs.existsSync(r.dir))];
  const inv = inventory({ roots, minBytes: minMb * 1024 * 1024, full: argv.includes('--full-hash') });
  out ??= path.join(process.cwd(), '.acceptance-evidence', 'model-store-inventory', inv.scannedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'model-inventory.json'), JSON.stringify(inv, null, 2));
  fs.writeFileSync(path.join(out, 'model-inventory.md'), toMarkdown(inv));
  console.log(JSON.stringify({ out, roots: roots.length, files: inv.files.length, ollamaBlobs: inv.ollamaBlobs.length, duplicateGroups: inv.duplicateGroups.length, reclaimableGB: +(inv.reclaimableBytes / 1024 ** 3).toFixed(2), totalsGB: Object.fromEntries(Object.entries(inv.totals).map(([k, v]) => [k, +(v / 1024 ** 3).toFixed(1)])) }));
}
