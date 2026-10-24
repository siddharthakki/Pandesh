/**
 * On-demand repository navigation for Saath Kar / Karke Dikha: the questions a model would otherwise answer by grepping
 * blind (where is X defined, who uses X, what breaks if X changes, what is in this repo). All four are read-only and are
 * thin views over the engine that already exists:
 *
 *   RepositoryGraphService (persistent, incremental graph)  +  VSCodeWorkspaceHost (the editor's language services)
 *
 * No new index, parser or server. When the editor's language service has a definition it answers `find_references`
 * semantically; otherwise the import graph scopes a whole-word search. Output is `path:line  text` lines, not file bodies.
 */
import * as path from 'path';
import { ToolResult, ToolContext } from './ToolTypes';
import { RepositoryGraphService } from '../repository/RepositoryGraphService';
import { RepositoryGraphIndexer } from '../../core/platform/repo/graphIndexer';
import { RepositoryContextEngine } from '../../core/platform/repo/evidence';
import { LocalFilesystemWorkspaceHost } from '../../core/platform/repo/workspaceHost';
import { tsAstExtractor } from '../repository/TsAstExtractor';
import { deriveSubsystemTerms } from '../repository/RepoEvidencePlans';
import { stemNeedle } from '../../core/platform/repo/repositoryGraph';

const GRAPH_WAIT_MS = 1_500;
/** Words that describe the act of asking, not the thing asked about. */
const NOISE = new Set(['find', 'logic', 'might', 'break', 'modify', 'change', 'where', 'which', 'what', 'code', 'used', 'using', 'handle', 'handled', 'implemented', 'show', 'tell', 'does', 'work', 'works', 'relevant', 'file', 'files', 'function', 'method', 'data']);
const standalone = new Map<string, { engine: RepositoryContextEngine; indexer: RepositoryGraphIndexer }>();

/** The workspace's engine: the extension's live graph service when there is one, else a lazily built portable one. */
async function engineFor(ctx: ToolContext): Promise<{ engine: RepositoryContextEngine; indexer: RepositoryGraphIndexer | undefined }> {
  const service = RepositoryGraphService.current();
  if (service && path.resolve(service.workspaceRoot).toLowerCase() === path.resolve(ctx.workspaceRoot).toLowerCase()) {
    await service.refresh();
    return { engine: service.engine, indexer: service.indexer };
  }
  const key = path.resolve(ctx.workspaceRoot).toLowerCase();
  let entry = standalone.get(key);
  if (!entry) {
    const host = new LocalFilesystemWorkspaceHost(ctx.workspaceRoot);
    const indexer = new RepositoryGraphIndexer(host, { extractor: tsAstExtractor });
    entry = { engine: new RepositoryContextEngine(host, indexer), indexer };
    standalone.set(key, entry);
    void indexer.start();
  }
  return entry;
}

/** Bounded wait for a first usable graph; queries still work (search-backed) if it is not there yet. */
async function settle(indexer: RepositoryGraphIndexer | undefined): Promise<void> {
  if (!indexer || indexer.isReady()) return;
  await Promise.race([indexer.ready(), new Promise<void>(resolve => setTimeout(resolve, GRAPH_WAIT_MS))]);
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const fmtRef = (r: { path: string; line: number; text: string }): string => `${r.path}:${r.line}  ${r.text}`;

/**
 * "Where is X handled?" when the model does not know a symbol name. The question's words (stemmed, with the project's
 * concept vocabulary: persist -> store/save/database ...) rank files by path, symbol and centrality; each hit lists the
 * matching symbols with their lines so the next step is one read_file_range, not a blind grep.
 */
export async function findRelevant(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const topic = str(args['topic']);
  if (!topic) return { ok: false, error: 'topic is required' };
  const { engine, indexer } = await engineFor(ctx);
  await settle(indexer);
  const graph = engine.graph;
  // camelCase / snake_case identifiers in the question are split into words ("validateToolArguments" -> validate tool arguments).
  const words = topic.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  const derived = deriveSubsystemTerms(words);
  const keep = (terms: string[]): string[] => [...new Set(terms.filter(t => t.length >= 3 && !NOISE.has(t)))];
  const primary = keep(derived.primary).length > 0 ? keep(derived.primary) : keep(words.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).slice(0, 4);
  const expanded = keep(derived.expanded);
  if (!graph || !engine.graphUsable()) {
    const hits = await engine.findReferences(primary[0] ?? topic, { max: 12 });
    const matches = hits.references.map(fmtRef).join('\n');
    return { ok: true, data: `Index warming up; text matches for "${primary[0] ?? topic}":\n${matches}`.trim(), summary: 'text matches' };
  }
  // Two rankings fused: what the question says, and what the project's vocabulary says it means (persist -> store, save, ...).
  // A file that shows up in both is the best answer; either list alone is still useful.
  const lists = [graph.rankFiles(primary, { max: 12, deadlineMs: 150 }), expanded.length ? graph.rankFiles(expanded, { max: 12, deadlineMs: 150 }) : []];
  const fused = new Map<string, { score: number; reasons: string[] }>();
  lists.forEach(list => list.forEach((file, rank) => {
    const entry = fused.get(file.path) ?? { score: 0, reasons: [] };
    entry.score += 1 / (60 + rank);
    for (const reason of file.reasons) if (entry.reasons.length < 2 && !entry.reasons.includes(reason)) entry.reasons.push(reason);
    fused.set(file.path, entry);
  }));
  const ranked = [...fused.entries()].sort((x, y) => y[1].score - x[1].score).slice(0, 8);
  const needles = [...primary, ...expanded].map(t => stemNeedle(t.toLowerCase())).filter(t => t.length >= 3);
  const lines = ranked.map(([file, info]) => {
    const symbols = graph.symbolsIn(file).filter(sym => needles.some(n => sym.name.toLowerCase().includes(n))).slice(0, 4).map(sym => `${sym.name}:${sym.line}`);
    return `${file}${symbols.length ? `  [${symbols.join(', ')}]` : ''}  — ${info.reasons.join('; ')}`;
  });
  return { ok: true, data: lines.join('\n') || `Nothing in the index matches "${topic}". Try grep with a likely keyword.`, summary: `${lines.length} relevant file(s)` };
}

export async function findReferences(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const symbol = str(args['symbol']);
  if (!symbol) return { ok: false, error: 'symbol is required' };
  const { engine, indexer } = await engineFor(ctx);
  await settle(indexer);
  const result = await engine.findReferences(symbol, { ...(str(args['path']) ? { path: str(args['path']) } : {}), max: 40 });
  const head = result.definitions.slice(0, 3).map(d => `defined at ${d.path}:${d.line} (${d.kind})`).join('; ');
  const body = result.references.map(fmtRef).join('\n');
  return {
    ok: true,
    data: `${head || `no definition found for ${symbol}`}\n${result.references.length} reference(s) [${result.source}]\n${body}`.trim(),
    summary: `${result.references.length} reference(s) to ${symbol}`,
  };
}

export async function impactAnalysis(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = str(args['target']);
  if (!target) return { ok: false, error: 'target is required (a file path or a symbol name)' };
  const { engine, indexer } = await engineFor(ctx);
  await settle(indexer);
  const impact = await engine.impact(target.replace(/\\/g, '/'), { max: 25 });
  const section = (label: string, items: string[]): string => (items.length ? `${label} (${items.length}):\n${items.map(i => `  ${i}`).join('\n')}` : '');
  const parts = [
    `${impact.kind} ${impact.target} [${impact.source}]`,
    section('Directly affected', impact.direct),
    section('Indirectly affected (importers of those)', impact.indirect),
    impact.references.length ? `Reference sites:\n${impact.references.slice(0, 15).map(r => `  ${fmtRef(r)}`).join('\n')}` : '',
    section('Tests to run', impact.tests),
  ].filter(Boolean);
  return { ok: true, data: parts.join('\n'), summary: `${impact.direct.length} direct, ${impact.indirect.length} indirect, ${impact.tests.length} test(s)` };
}

export async function repoMap(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { engine, indexer } = await engineFor(ctx);
  await settle(indexer);
  const graph = engine.graph;
  if (!graph || !engine.graphUsable()) return { ok: true, data: 'Repository index is still warming up; use list_directory for now.', summary: 'index not ready' };
  const focus = str(args['focus']).split(/[\s,]+/).filter(Boolean);
  const budget = Math.min(3000, Math.max(300, Number(args['budgetTokens']) || 1200));
  const map = graph.repoMap({ budgetTokens: budget, focus });
  return { ok: true, data: map.text, summary: `${map.files} files, ~${map.tokenEstimate} tokens` };
}
