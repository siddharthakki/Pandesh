#!/usr/bin/env node
// Repeatable benchmark for the portable repository graph (core/platform/repo).
//
//   node --expose-gc scripts/repo-bench/bench.mjs --tier small
//   node --expose-gc scripts/repo-bench/bench.mjs --tier all --out D:/bench
//   node --expose-gc scripts/repo-bench/bench.mjs --repo C:/some/real/repo        (real repository, no ground truth)
//   node --expose-gc scripts/repo-bench/bench.mjs --clone https://github.com/microsoft/vscode
//
// Fixtures are generated (deterministically) or cloned OUTSIDE the working tree. Results go to stdout as JSON and,
// with --json <file>, to a file. Quality is measured against the generator's ground truth.
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generate, mulberry32 } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const TIERS = { small: 3_000, medium: 30_000, large: 120_000, xlarge: 300_000 };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) : fallback;
}

const outRoot = path.resolve(String(arg('out', path.join(os.tmpdir(), 'kkd-repo-bench'))));
if (path.relative(repoRoot, outRoot) && !path.relative(repoRoot, outRoot).startsWith('..')) throw new Error('--out must be outside the working tree');

// Bundle the portable engine once (TypeScript → CJS) so the benchmark runs the real production code.
const bundle = path.join(os.tmpdir(), `kkd-repo-engine-${process.pid}.cjs`);
buildSync({ entryPoints: [path.join(repoRoot, 'core/platform/repo/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', target: 'node20' });
const engine = createRequire(import.meta.url)(bundle);
const { LocalFilesystemWorkspaceHost, RepositoryGraphIndexer, JsonlGraphStore, RepositoryContextEngine } = engine;

const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100; };
const mb = (n) => Math.round(n / 1048576);
function memory() { global.gc?.(); global.gc?.(); const m = process.memoryUsage(); return { heapMB: mb(m.heapUsed), rssMB: mb(m.rss) }; }
const sample = (list, n, rand) => { const out = []; const used = new Set(); while (out.length < Math.min(n, list.length)) { const i = Math.floor(rand() * list.length); if (!used.has(i)) { used.add(i); out.push(list[i]); } } return out; };

async function ensureFixture(name, files) {
  const dir = path.join(outRoot, `${name}-${files}`);
  const truthFile = path.join(dir, '..', `${name}-${files}.truth.json`);
  try { await fs.access(truthFile); await fs.access(path.join(dir, '.git')); return { dir, truth: JSON.parse(await fs.readFile(truthFile, 'utf8')), generatedMs: 0 }; } catch { /* generate */ }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  await fs.mkdir(dir, { recursive: true });
  const t0 = performance.now();
  const truth = await generate(dir, files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir, maxBuffer: 1 << 30 });
  await fs.writeFile(truthFile, JSON.stringify(truth));
  return { dir, truth, generatedMs: ms(t0) };
}

async function benchOne(label, dir, truth, storeDir) {
  const rand = mulberry32(99);
  const r = { label, dir, quality: {}, latencyMs: {} };

  // ---- cold discovery (no index, no graph)
  global.gc?.();
  const baseMem = memory();
  const host = new LocalFilesystemWorkspaceHost(dir);
  let t0 = performance.now();
  const identity = await host.identity();
  const paths = await host.listPaths();
  r.files = paths.length;
  r.coldDiscoveryMs = ms(t0);

  // ---- time to first usable answer with NO graph (host search only)
  const coldEngine = new RepositoryContextEngine(host);
  const probes = truth ? sample(truth.symbols, 8, rand) : [];
  const coldTimes = [];
  for (const probe of probes) { t0 = performance.now(); await coldEngine.traceSymbol(probe.name); coldTimes.push(performance.now() - t0); }
  r.timeToFirstAnswerColdMs = { p50: pct(coldTimes, 50), p95: pct(coldTimes, 95), n: coldTimes.length };

  // ---- initial index (progressive), restart-safe store
  await fs.rm(storeDir, { recursive: true, force: true });
  const store = new JsonlGraphStore(storeDir, 1024 * 1024 * 1024);
  const progress = [];
  const indexer = new RepositoryGraphIndexer(host, { store, concurrency: 16, sliceMs: 20, onProgress: (c) => { if (progress.length < 5 || c.phase === 'ready') progress.push({ atMs: ms(t0), phase: c.phase, fraction: Math.round(c.fraction * 1000) / 1000 }); } });
  t0 = performance.now();
  const running = indexer.start();
  // First usable moment: discovery done (paths known) — a query must already work while indexing continues.
  while (!indexer.timings.firstUsableMs) await new Promise((res) => setImmediate(res));
  const partialEngine = new RepositoryContextEngine(host, indexer);
  const tPartial = performance.now();
  const partialPacket = probes.length ? await partialEngine.traceSymbol(probes[0].name) : undefined;
  r.timeToFirstAnswerDuringIndexMs = { ms: ms(tPartial), mode: partialPacket?.mode, coverageAtAnswer: Math.round(indexer.coverage().fraction * 1000) / 1000 };
  await running;
  r.initialIndexMs = ms(t0);
  r.indexTimings = { ...indexer.timings };
  r.stats = indexer.graph.stats();
  r.coverage = indexer.coverage();
  const afterMem = memory();
  r.memory = { baselineHeapMB: baseMem.heapMB, afterIndexHeapMB: afterMem.heapMB, deltaHeapMB: afterMem.heapMB - baseMem.heapMB, rssMB: afterMem.rssMB };
  r.diskIndexMB = Math.round((await store.diskBytes(identity.id)) / 1048576 * 10) / 10;
  r.progressSamples = progress;

  // ---- query latency (graph ready)
  const ctx = new RepositoryContextEngine(host, indexer);
  const graph = indexer.graph;
  const names = truth ? sample(truth.symbols, 200, rand).map((s) => s.name) : [...graph.files.values()].flatMap((f) => f.symbols.slice(0, 1).map((s) => s.name)).slice(0, 200);
  const time = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); out.push(performance.now() - t); } return { p50: pct(out, 50), p95: pct(out, 95), n }; };
  r.latencyMs.definitions = await time(Math.min(200, names.length), (i) => graph.definitions(names[i % names.length]));
  const filePool = [...graph.files.keys()];
  r.latencyMs.importersOf = await time(200, () => graph.importersOf(filePool[Math.floor(rand() * filePool.length)]));
  r.latencyMs.rankFiles = await time(50, (i) => graph.rankFiles([['service', 'api'], ['core', 'data'], ['auth'], ['jobs', 'net']][i % 4]));
  r.latencyMs.traceSymbolWithEvidence = await time(Math.min(40, names.length), (i) => ctx.traceSymbol(names[i % names.length]));
  r.latencyMs.architectureEvidence = await time(20, (i) => ctx.architectureEvidence([['api', 'service'], ['core'], ['auth', 'login'], ['jobs']][i % 4]));
  const tokens = [];
  for (let i = 0; i < Math.min(20, names.length); i++) tokens.push((await ctx.traceSymbol(names[i])).tokenEstimate);
  r.tokensPerSymbolPacket = { avg: Math.round(tokens.reduce((a, b) => a + b, 0) / Math.max(1, tokens.length)), max: Math.max(0, ...tokens) };

  // ---- quality vs ground truth
  if (truth) {
    const symbols = sample(truth.symbols, 200, rand);
    let defTop1 = 0;
    let importerRecall = 0;
    let importerPairs = 0;
    for (const s of symbols) {
      const top = graph.definitions(s.name, 3)[0];
      if (top && top.path === s.file) defTop1++;
      const found = new Set(graph.importersOf(s.file).map((e) => e.from));
      for (const user of s.importers) { importerPairs++; if (found.has(user)) importerRecall++; }
    }
    r.quality.definitionTop1 = Math.round((defTop1 / symbols.length) * 1000) / 1000;
    r.quality.importerEdgeRecall = Math.round((importerRecall / Math.max(1, importerPairs)) * 1000) / 1000;
    // Evidence quality: does the packet contain the definition AND at least one true user?
    let withBoth = 0;
    const evidenceSample = sample(truth.symbols, 60, rand);
    for (const s of evidenceSample) {
      const packet = await ctx.traceSymbol(s.name);
      const paths = new Set(packet.items.map((i) => i.path));
      if (paths.has(s.file) && s.importers.some((u) => paths.has(u))) withBoth++;
    }
    r.quality.symbolEvidenceHasDefinitionAndUser = Math.round((withBoth / evidenceSample.length) * 1000) / 1000;
    // Architecture: for a package, does the packet include its manifest, entry and a hub?
    const pkgs = sample(truth.packages, 40, rand);
    let hit = 0;
    let manifestHit = 0;
    for (const pkg of pkgs) {
      const term = pkg.name.replace('@bench/', '');
      const packet = await ctx.architectureEvidence([term]);
      const paths = new Set(packet.items.map((i) => i.path));
      const hasManifest = paths.has(pkg.manifest);
      const hasHub = pkg.hubs.some((h) => paths.has(h)) || (pkg.entry && paths.has(pkg.entry));
      if (hasManifest) manifestHit++;
      if (hasManifest && hasHub) hit++;
    }
    r.quality.architecturePacketManifestAndHub = Math.round((hit / pkgs.length) * 1000) / 1000;
    r.quality.architecturePacketManifest = Math.round((manifestHit / pkgs.length) * 1000) / 1000;
  }

  // ---- incremental update: touch 50 files, then restart from the snapshot
  const touched = sample([...graph.files.values()].filter((f) => f.language === 'typescript' && f.role === 'source'), 50, rand).map((f) => f.path);
  for (const rel of touched) await fs.appendFile(path.join(dir, rel), '\nexport function benchTouched() { return 1; }\n');
  t0 = performance.now();
  const upd = await indexer.updatePaths(touched);
  r.incrementalUpdate50FilesMs = ms(t0);
  r.incrementalUpdated = upd.updated;
  indexer.cancel();
  await new Promise((res) => setTimeout(res, 50));
  await indexer['persist']?.(true);
  const restarted = new RepositoryGraphIndexer(host, { store, concurrency: 16, sliceMs: 20 });
  t0 = performance.now();
  await restarted.start();
  r.restartFromSnapshotMs = ms(t0);
  r.restartTimings = { ...restarted.timings };
  return r;
}

async function main() {
  const results = [];
  const real = arg('repo', null);
  const clone = arg('clone', null);
  const tierArg = String(arg('tier', real || clone ? '' : 'small'));
  if (real) results.push(await benchOne(`real:${path.basename(String(real))}`, path.resolve(String(real)), undefined, path.join(outRoot, 'store-real')));
  if (clone) {
    const name = path.basename(String(clone)).replace(/\.git$/, '');
    const dir = path.join(outRoot, `clone-${name}`);
    await fs.mkdir(outRoot, { recursive: true });
    try { await fs.access(path.join(dir, '.git')); } catch { execFileSync('git', ['clone', '--depth', '1', '-q', String(clone), dir], { stdio: 'inherit' }); }
    results.push(await benchOne(`oss:${name}`, dir, undefined, path.join(outRoot, `store-${name}`)));
  }
  const tiers = tierArg === 'all' ? Object.keys(TIERS) : tierArg ? tierArg.split(',') : [];
  for (const tier of tiers) {
    if (!TIERS[tier]) throw new Error(`unknown tier ${tier}`);
    process.stderr.write(`[bench] ${tier}: preparing fixture…\n`);
    const fixture = await ensureFixture(tier, TIERS[tier]);
    process.stderr.write(`[bench] ${tier}: ${fixture.truth.files} files ready (generation ${fixture.generatedMs} ms). Measuring…\n`);
    const result = await benchOne(`${tier} (${fixture.truth.files} files)`, fixture.dir, fixture.truth, path.join(outRoot, `store-${tier}`));
    results.push(result);
    process.stderr.write(`[bench] ${tier}: done in ${result.initialIndexMs} ms index\n`);
  }
  const json = JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, generatedAt: new Date().toISOString(), results }, null, 2);
  const file = arg('json', null);
  if (file) await fs.writeFile(String(file), json);
  console.log(json);
  await fs.rm(bundle, { force: true });
}

main().catch((error) => { console.error(error); process.exit(1); });
