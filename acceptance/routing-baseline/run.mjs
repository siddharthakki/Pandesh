// node acceptance/routing-baseline/run.mjs [label]
// Measures the CURRENT first-turn tool-group selection (core/runtime/chatToolSelection.ts `groupsForText`) against prompts.mjs.
// Deterministic, offline, read-only: it changes no routing behaviour and writes only results/.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PROMPTS, EXTERNAL } from './prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const label = process.argv[2] ?? 'm4-baseline';
const out = path.join(HERE, '.bundle.mjs');
await esbuild.build({ entryPoints: [path.join(ROOT, 'core', 'runtime', 'chatToolSelection.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const { groupsForText } = await import(pathToFileURL(out).href);
fs.rmSync(out, { force: true });

const rows = PROMPTS.map((p) => {
  const offered = [...groupsForText(p.text)].sort();
  const missing = p.expect.filter((g) => !offered.includes(g));
  const forbidden = p.forbid.filter((g) => offered.includes(g));
  return { id: p.id, text: p.text, expect: p.expect, offered, missing, forbidden, exact: !missing.length && !forbidden.length };
});
const expectedTotal = rows.reduce((n, r) => n + r.expect.length, 0);
const expectedHit = rows.reduce((n, r) => n + r.expect.length - r.missing.length, 0);
let commit = '';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const summary = {
  label, commit, prompts: rows.length,
  exactCorrect: rows.filter((r) => r.exact).length,
  expectedGroupRecall: `${expectedHit}/${expectedTotal}`,
  promptsMissingAnExpectedGroup: rows.filter((r) => r.missing.length).length,
  promptsWithAForbiddenGroup: rows.filter((r) => r.forbidden.length).length,
  promptsOfferingWrongExternalDataGroup: rows.filter((r) => r.forbidden.some((g) => EXTERNAL.has(g))).length,
  meanGroupsOffered: +(rows.reduce((n, r) => n + r.offered.length, 0) / rows.length).toFixed(2),
};
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', `${label}.json`), JSON.stringify({ summary, rows }, null, 2));
const fails = rows.filter((r) => !r.exact);
fs.writeFileSync(path.join(HERE, 'results', `${label}.md`), [`# Routing baseline ${label}`, '', '```json', JSON.stringify(summary, null, 1), '```', '', '## Not exact', '', '| id | prompt | missing | forbidden offered | offered |', '|---|---|---|---|---|',
  ...fails.map((r) => `| ${r.id} | ${r.text.replace(/\|/g, '/').slice(0, 70)} | ${r.missing.join(', ')} | ${r.forbidden.join(', ')} | ${r.offered.join(', ')} |`)].join('\n') + '\n');
console.log(JSON.stringify(summary, null, 1));
for (const r of fails) console.log(`${r.id} missing=[${r.missing}] forbidden=[${r.forbidden}] offered=[${r.offered}]  "${r.text.slice(0, 60)}"`);
