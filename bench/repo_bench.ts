/**
 * Repository-intelligence benchmark. Runs the *production* portable engine (graph indexer + context engine + host) —
 * the same code the VS Code extension wires up, minus the LSP layer — and a ripgrep baseline, over a task file.
 *
 *   node out-bench/repo_bench.js <root> <tasks.json> [--reps=N] [--out=result.json]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalFilesystemWorkspaceHost } from '../core/platform/repo/workspaceHost';
import { RepositoryGraphIndexer } from '../core/platform/repo/graphIndexer';
import { RepositoryContextEngine, estimateTokens } from '../core/platform/repo/evidence';
import { JsonlGraphStore } from '../core/platform/repo/graphStore';
import { tsAstExtractor } from '../src/repository/TsAstExtractor';
import { execFileSync } from 'node:child_process';

interface Task { id: string; question: string; kind: 'trace' | 'arch' | 'dependents' | 'tests' | 'defs' | 'refs' | 'impact' | 'map'; arg: string | string[]; expect: string[]; expectText?: string[] }

const args = process.argv.slice(2);
const root = path.resolve(args[0]!);
const tasks: Task[] = JSON.parse(fs.readFileSync(args[1]!, 'utf8'));
const reps = Number((args.find(a => a.startsWith('--reps=')) ?? '--reps=15').split('=')[1]);
const outFile = (args.find(a => a.startsWith('--out=')) ?? '').split('=')[1];

const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const rssMb = (): number => Math.round(process.memoryUsage().rss / 1048576);
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-bench-'));

async function buildIndexer(withStore: boolean): Promise<{ indexer: RepositoryGraphIndexer; engine: RepositoryContextEngine; host: LocalFilesystemWorkspaceHost; firstUsableMs: number; readyMs: number }> {
  const host = new LocalFilesystemWorkspaceHost(root);
  const indexer = new RepositoryGraphIndexer(host, { extractor: tsAstExtractor, ...(withStore ? { store: new JsonlGraphStore(storeDir) } : {}) });
  const engine = new RepositoryContextEngine(host, indexer);
  const t0 = performance.now();
  await indexer.start();
  const readyMs = performance.now() - t0;
  return { indexer, engine, host, firstUsableMs: indexer.timings.firstUsableMs ?? readyMs, readyMs };
}

async function runTask(engine: RepositoryContextEngine, t: Task): Promise<{ files: string[]; text: string; tokens: number }> {
  if (t.kind === 'trace') { const p = await engine.traceSymbol(String(t.arg)); return { files: p.items.map(i => i.path), text: p.items.map(i => i.text).join('\n'), tokens: p.tokenEstimate }; }
  if (t.kind === 'arch') { const p = await engine.architectureEvidence([t.arg].flat()); return { files: p.items.map(i => i.path), text: p.items.map(i => i.text).join('\n'), tokens: p.tokenEstimate }; }
  const g = engine.graph!;
  if (t.kind === 'refs') { const r = await engine.findReferences(String(t.arg)); const text = [...r.definitions.map(d => `${d.path}:${d.line}`), ...r.references.map(x => `${x.path}:${x.line} ${x.text}`)].join('\n'); return { files: [...r.definitions.map(d => d.path), ...r.references.map(x => x.path)], text, tokens: estimateTokens(text) }; }
  if (t.kind === 'impact') { const r = await engine.impact(String(t.arg)); const text = [...r.direct, ...r.indirect, ...r.tests, ...r.references.map(x => `${x.path}:${x.line} ${x.text}`)].join('\n'); return { files: [...r.direct, ...r.indirect, ...r.tests, ...r.references.map(x => x.path)], text, tokens: estimateTokens(text) }; }
  if (t.kind === 'map') { const m = g.repoMap({ budgetTokens: 1200, focus: [t.arg].flat() }); return { files: m.text.split('\n').map(l => l.split(':')[0]!), text: m.text, tokens: m.tokenEstimate }; }
  if (t.kind === 'dependents') { const f = g.importersOf(String(t.arg)).map(e => e.from); return { files: f, text: f.join('\n'), tokens: estimateTokens(f.join('\n')) }; }
  if (t.kind === 'tests') { const f = g.testsFor(String(t.arg)).map(e => e.from); return { files: f, text: f.join('\n'), tokens: estimateTokens(f.join('\n')) }; }
  const f = g.definitions(String(t.arg), 6).map(d => d.path); return { files: f, text: f.join('\n'), tokens: estimateTokens(f.join('\n')) };
}

/** Ripgrep baseline = what a tool-using model has today: grep the term, read the top matching files' hits with context. */
function rgBaseline(t: Task): { files: string[]; text: string; tokens: number } {
  const term = [t.arg].flat()[0]!;
  try {
    const out = execFileSync('rg', ['-n', '-w', '-C2', '--max-count=5', '-g', '!node_modules', '-g', '!out', term, root], { encoding: 'utf8', maxBuffer: 64e6 });
    const files = [...new Set(out.split('\n').map(l => l.match(/^(.*?)[:-]\d+[:-]/)?.[1]).filter(Boolean) as string[])].map(f => path.relative(root, f).replace(/\\/g, '/'));
    return { files, text: out, tokens: estimateTokens(out) };
  } catch { return { files: [], text: '', tokens: 0 }; }
}

const recall = (got: string[], expect: string[]): number => expect.length === 0 ? 1 : expect.filter(e => got.some(g => g === e || g.endsWith(e))).length / expect.length;
const textRecall = (text: string, expect?: string[]): number => !expect?.length ? 1 : expect.filter(e => text.includes(e)).length / expect.length;

(async () => {
  const result: Record<string, unknown> = { root, node: process.version };
  const rss0 = rssMb();

  const cold = await buildIndexer(false);
  const g = cold.indexer.graph.stats();
  result.cold = { readyMs: Math.round(cold.readyMs), firstUsableMs: Math.round(cold.firstUsableMs), files: g.files, symbols: g.symbols, rssDeltaMb: rssMb() - rss0 };
  // persist then warm-start
  const withStore = await buildIndexer(true);
  await new Promise(r => setTimeout(r, 50));
  const warm = await buildIndexer(true);
  result.warm = { readyMs: Math.round(warm.readyMs), restored: warm.indexer.timings.restored, parsed: warm.indexer.timings.parsed, skipped: warm.indexer.timings.skippedUnchanged };
  void withStore;

  const rows: unknown[] = [];
  const cpu0 = process.cpuUsage();
  for (const t of tasks) {
    const lat: number[] = []; let last = { files: [] as string[], text: '', tokens: 0 };
    for (let i = 0; i < reps; i++) { const s = performance.now(); last = await runTask(warm.engine, t); lat.push(performance.now() - s); }
    const blat: number[] = []; let base = { files: [] as string[], text: '', tokens: 0 };
    for (let i = 0; i < Math.min(reps, 5); i++) { const s = performance.now(); base = rgBaseline(t); blat.push(performance.now() - s); }
    rows.push({
      id: t.id, kind: t.kind,
      engine: { p50: +pct(lat, 0.5).toFixed(1), p95: +pct(lat, 0.95).toFixed(1), tokens: last.tokens, fileRecall: recall(last.files, t.expect), textRecall: textRecall(last.text, t.expectText), files: last.files.slice(0, 6) },
      rg: { p50: +pct(blat, 0.5).toFixed(1), tokens: base.tokens, fileRecall: recall(base.files, t.expect), textRecall: textRecall(base.text, t.expectText) },
    });
  }
  const cpu = process.cpuUsage(cpu0);
  result.queries = rows;
  result.queryCpuMs = Math.round((cpu.user + cpu.system) / 1000);
  result.rssMb = rssMb();

  // incremental refresh + freshness on a scratch copy of one file
  const scratchRel = (process.env.BENCH_EDIT_FILE ?? tasks[0]!.expect[0]!);
  const abs = path.join(root, scratchRel);
  const original = fs.readFileSync(abs, 'utf8');
  try {
    const marker = 'kkdFreshProbe' + Date.now();
    const probe = `
function ${marker}() { return 1; }
`;
    if (/\.html?$/.test(scratchRel)) fs.writeFileSync(abs, original.replace(/<\/script>(?![\s\S]*<\/script>)/i, `${probe}</script>`));
    else if (/\.py$/.test(scratchRel)) fs.appendFileSync(abs, `
def ${marker}():
    return 1
`);
    else fs.appendFileSync(abs, `
export ${probe}`);
    const s = performance.now();
    await warm.indexer.updatePaths([scratchRel]);
    const refreshMs = performance.now() - s;
    const hit = warm.indexer.graph.definitions(marker, 3).length > 0;
    result.incremental = { refreshMs: +refreshMs.toFixed(1), newSymbolVisibleImmediately: hit };
  } finally { fs.writeFileSync(abs, original); await warm.indexer.updatePaths([scratchRel]); }

  console.log(JSON.stringify(result, null, 1));
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
  fs.rmSync(storeDir, { recursive: true, force: true });
})();
