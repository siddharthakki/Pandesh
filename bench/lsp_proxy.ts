/**
 * Proxy for "VS Code's already-running language service": the TypeScript LanguageService is exactly what VS Code's
 * tsserver runs behind executeReferenceProvider / executeWorkspaceSymbolProvider. Measures what the extension host would
 * wait on once the editor has loaded the project (VS Code adds only local IPC on top).
 *
 *   node out-bench/lsp_proxy.js <root> <relFile> <symbol> [out.json]
 */
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(process.argv[2]!);
const rel = process.argv[3]!;
const symbol = process.argv[4]!;
const out = process.argv[5];
const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };

const t0 = performance.now();
const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')!;
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, path.dirname(cfgPath));
const versions = new Map<string, number>();
const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => cfg.fileNames,
  getScriptVersion: f => String(versions.get(f) ?? 0),
  getScriptSnapshot: f => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
  getCurrentDirectory: () => root,
  getCompilationSettings: () => cfg.options,
  getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const abs = path.join(root, rel);
const text = fs.readFileSync(abs, 'utf8');
const pos = text.indexOf(`function ${symbol}`) + 'function '.length;

const s1 = performance.now();
const first = service.findReferences(abs, pos); // loads the program
const coldMs = performance.now() - s1;
const lat: number[] = []; let refs = 0;
for (let i = 0; i < 20; i++) { const s = performance.now(); const r = service.findReferences(abs, pos); lat.push(performance.now() - s); refs = (r ?? []).reduce((n, x) => n + x.references.length, 0); }
const nav: number[] = [];
for (let i = 0; i < 20; i++) { const s = performance.now(); service.getNavigateToItems(symbol, 20); nav.push(performance.now() - s); }
// incremental: touch the file, re-ask
const inc: number[] = [];
for (let i = 0; i < 5; i++) { versions.set(abs, (versions.get(abs) ?? 0) + 1); const s = performance.now(); service.findReferences(abs, pos); inc.push(performance.now() - s); }
const files = [...new Set((first ?? []).flatMap(r => r.references.map(x => path.relative(root, x.fileName).replace(/\\/g, '/'))))];
const result = {
  projectFiles: cfg.fileNames.length, configAndSetupMs: Math.round(s1 - t0), firstFindReferencesMs: Math.round(coldMs),
  warmReferences: { p50: +pct(lat, .5).toFixed(1), p95: +pct(lat, .95).toFixed(1) }, warmWorkspaceSymbol: { p50: +pct(nav, .5).toFixed(1), p95: +pct(nav, .95).toFixed(1) },
  afterEditReferencesMs: { p50: +pct(inc, .5).toFixed(0), p95: +pct(inc, .95).toFixed(0) }, references: refs, files, rssMb: Math.round(process.memoryUsage().rss / 1048576),
};
console.log(JSON.stringify(result, null, 1));
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
