/**
 * Persistent, restart-safe, size-bounded storage for the repository graph.
 *
 * Only per-file records are stored (symbols, imports as written, exports, hash, size, mtime); edges are derived on load
 * by the graph itself, so the file stays small and can never hold a stale edge. Writes are atomic (tmp + rename), so a
 * crash mid-save leaves the previous snapshot intact. A schema or identity mismatch is treated as "no snapshot".
 */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { FileNode, RepositoryGraph } from './repositoryGraph';
import type { FileRole, ImportRec, Provenance, SymbolRec, SymbolKind } from './extractors';

export const GRAPH_SCHEMA_VERSION = 1;

export interface GraphSnapshotMeta {
  schema: number;
  identityId: string;
  head?: string;
  savedAt: string;
  files: number;
  indexedFiles: number;
}

export interface GraphStore {
  load(identityId: string, restore: (node: FileNode) => void): Promise<GraphSnapshotMeta | undefined>;
  save(identity: { id: string; head?: string }, graph: RepositoryGraph): Promise<{ saved: boolean; bytes: number; reason?: string }>;
  clear(identityId: string): Promise<void>;
}

type Row = [
  string, number, number, string | 0, string, FileRole, string | 0, Provenance,
  Array<[string, SymbolKind, number, 0 | 1, string | 0, string[] | 0, string[] | 0]>,
  Array<[string, number, ImportRec['kind'], string[] | 0, Provenance, number]>,
  string[],
];

function toRow(node: FileNode): Row {
  return [
    node.path, node.size, node.mtimeMs, node.hash ?? 0, node.language, node.role, node.pkg ?? 0, node.provenance,
    node.symbols.map(s => [s.name, s.kind, s.line, s.exported ? 1 : 0, s.container ?? 0, s.extends?.length ? s.extends : 0, s.implements?.length ? s.implements : 0]),
    node.imports.map(i => [i.spec, i.line, i.kind, i.names?.length ? i.names : 0, i.provenance, i.confidence]),
    node.exports,
  ];
}

function fromRow(row: Row): FileNode {
  const symbols: SymbolRec[] = row[8].map(s => ({
    name: s[0], kind: s[1], line: s[2], exported: s[3] === 1,
    ...(s[4] ? { container: s[4] } : {}), ...(s[5] ? { extends: s[5] } : {}), ...(s[6] ? { implements: s[6] } : {}),
  }));
  const imports: ImportRec[] = row[9].map(i => ({ spec: i[0], line: i[1], kind: i[2], ...(i[3] ? { names: i[3] } : {}), provenance: i[4], confidence: i[5] }));
  return {
    path: row[0], size: row[1], mtimeMs: row[2], ...(row[3] ? { hash: row[3] } : {}), language: row[4], role: row[5],
    ...(row[6] !== 0 ? { pkg: row[6] as string } : {}), provenance: row[7], symbols, imports, exports: row[10], indexed: true,
  };
}

export class JsonlGraphStore implements GraphStore {
  constructor(private readonly dir: string, private readonly maxBytes = 256 * 1024 * 1024) {}

  private metaPath(id: string): string { return path.join(this.dir, id, 'meta.json'); }
  private dataPath(id: string): string { return path.join(this.dir, id, 'files.jsonl'); }

  async load(identityId: string, restore: (node: FileNode) => void): Promise<GraphSnapshotMeta | undefined> {
    let meta: GraphSnapshotMeta;
    try { meta = JSON.parse(await fs.readFile(this.metaPath(identityId), 'utf8')) as GraphSnapshotMeta; } catch { return undefined; }
    if (meta.schema !== GRAPH_SCHEMA_VERSION || meta.identityId !== identityId) return undefined;
    let restored = 0;
    try {
      const lines = readline.createInterface({ input: createReadStream(this.dataPath(identityId), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        try { restore(fromRow(JSON.parse(line) as Row)); restored++; } catch { /* a damaged line only loses that file */ }
      }
    } catch { return undefined; }
    return { ...meta, indexedFiles: restored };
  }

  async save(identity: { id: string; head?: string }, graph: RepositoryGraph): Promise<{ saved: boolean; bytes: number; reason?: string }> {
    const dir = path.join(this.dir, identity.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = this.dataPath(identity.id) + '.tmp';
    const handle = await fs.open(tmp, 'w');
    let bytes = 0;
    let written = 0;
    try {
      let batch: string[] = [];
      const flush = async (): Promise<boolean> => {
        if (batch.length === 0) return true;
        const chunk = batch.join('\n') + '\n';
        bytes += Buffer.byteLength(chunk);
        batch = [];
        if (bytes > this.maxBytes) return false;
        await handle.write(chunk);
        return true;
      };
      for (const node of graph.files.values()) {
        if (!node.indexed) continue;
        batch.push(JSON.stringify(toRow(node)));
        written++;
        if (batch.length >= 500 && !(await flush())) {
          await handle.close();
          await fs.rm(tmp, { force: true });
          return { saved: false, bytes, reason: `snapshot exceeds the ${Math.round(this.maxBytes / 1048576)} MB disk bound` };
        }
      }
      if (!(await flush())) {
        await handle.close();
        await fs.rm(tmp, { force: true });
        return { saved: false, bytes, reason: `snapshot exceeds the ${Math.round(this.maxBytes / 1048576)} MB disk bound` };
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    await fs.rename(tmp, this.dataPath(identity.id));
    const stats = graph.stats();
    const meta: GraphSnapshotMeta = { schema: GRAPH_SCHEMA_VERSION, identityId: identity.id, head: identity.head, savedAt: new Date().toISOString(), files: stats.files, indexedFiles: written };
    const metaTmp = this.metaPath(identity.id) + '.tmp';
    await fs.writeFile(metaTmp, JSON.stringify(meta));
    await fs.rename(metaTmp, this.metaPath(identity.id));
    return { saved: true, bytes };
  }

  async clear(identityId: string): Promise<void> {
    await fs.rm(path.join(this.dir, identityId), { recursive: true, force: true });
  }

  /** Total bytes on disk for the snapshot (for diagnostics/benchmarks). */
  async diskBytes(identityId: string): Promise<number> {
    try { return (await fs.stat(this.dataPath(identityId))).size; } catch { return 0; }
  }
}
