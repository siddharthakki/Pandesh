/** Baat Kar's production retrieval (RepoFastPath.repoQuery) on the same tasks. vscode is the unit-test mock. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RepoFastPath } from '../src/repository/RepoFastPath';
import { LocalFilesystemWorkspaceHost } from '../core/platform/repo/workspaceHost';
import { RepositoryGraphIndexer } from '../core/platform/repo/graphIndexer';
import { RepositoryContextEngine } from '../core/platform/repo/evidence';
import { tsAstExtractor } from '../src/repository/TsAstExtractor';

const root = path.resolve(process.argv[2]!);
const tasks = JSON.parse(fs.readFileSync(process.argv[3]!, 'utf8')) as Array<{ id: string; question: string; expect: string[]; expectText?: string[] }>;
const reps = 6;
const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
(async () => {
  let engine: RepositoryContextEngine | undefined;
  if (process.argv.includes('--graph')) { const host = new LocalFilesystemWorkspaceHost(root); const ix = new RepositoryGraphIndexer(host, { extractor: tsAstExtractor }); engine = new RepositoryContextEngine(host, ix); await ix.start(); }
  const rows = [];
  for (const t of tasks) {
    const lat: number[] = []; let last: Awaited<ReturnType<RepoFastPath['repoQuery']>>;
    let coldMs = 0;
    for (let i = 0; i < reps; i++) {
      const fp = new RepoFastPath(root); if (engine) fp.setGraphRanker(plan => engine!.rankPaths(plan)); // fresh instance each rep => no result cache: honest per-query cost
      const s = performance.now();
      last = await fp.repoQuery(t.question, { maxChars: 24_000 });
      const ms = performance.now() - s; if (i === 0) coldMs = ms; lat.push(ms);
    }
    const files = (last!?.files ?? []).map(f => f.path);
    const prompt = last!?.prompt ?? '';
    const fr = t.expect.filter(e => files.some(f => f === e || f.endsWith(e) || prompt.includes(e))).length / t.expect.length;
    const tr = t.expectText?.length ? t.expectText.filter(e => prompt.includes(e)).length / t.expectText.length : 1;
    rows.push({ id: t.id, p50: +pct(lat, .5).toFixed(0), p95: +pct(lat, .95).toFixed(0), firstMs: +coldMs.toFixed(0), tokens: last!?.estimatedTokens ?? 0, fileRecall: +fr.toFixed(2), textRecall: +tr.toFixed(2), type: last!?.type, grounded: last!?.grounded, files: files.slice(0, 6) });
  }
  console.log(JSON.stringify(rows, null, 1));
  if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(rows, null, 1));
})();
