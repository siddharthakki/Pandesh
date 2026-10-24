// Builds docs/M47_GOLDEN_MANIFEST.json from .m47-golden/ (raw evidence stays untracked; only hashes and a compact
// per-Golden summary are committed).
//   node scripts/build-m47-golden-manifest.mjs [--verdicts docs/m47-verdicts.json]
// Verdicts (PASS|PARTIAL|FAIL + reason + evidence path per Golden) are a reviewed input, not inferred here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const evidenceRoot = path.join(root, '.m47-golden');
const arg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const verdictsFile = path.resolve(root, arg('--verdicts', 'docs/M47_GOLDEN_VERDICTS.json'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const verdicts = fs.existsSync(verdictsFile) ? JSON.parse(fs.readFileSync(verdictsFile, 'utf8')) : {};
const manifest = {
  milestone: 'M47',
  baseline: 'a554c67',
  branch: git(['branch', '--show-current']),
  head: git(['rev-parse', 'HEAD']),
  generatedAt: new Date().toISOString(),
  note: 'Raw evidence lives in the untracked .m47-golden/ folder; each file below is pinned by SHA-256.',
  goldens: {},
};

for (const id of ['A', 'B', 'C', 'D', 'E', 'FGHIJ']) {
  const dir = path.join(evidenceRoot, id);
  const files = walk(dir).filter(f => !/\.(png|mp4)$/i.test(f) || /failure|end/.test(f));
  manifest.goldens[id] = {
    verdict: verdicts[id]?.verdict ?? 'NOT_RUN',
    reason: verdicts[id]?.reason ?? null,
    evidencePath: `.m47-golden/${id}/`,
    files: files.map(f => ({ path: path.relative(root, f).replace(/\\/g, '/'), bytes: fs.statSync(f).size, sha256: sha(f) })),
  };
  // Compact facts from the runner's result file, when present.
  const results = files.filter(f => /m47-golden-result\.json$|run\d*\.jsonl$/.test(f));
  manifest.goldens[id].summaries = results.map(f => {
    try {
      if (f.endsWith('.jsonl')) return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { const r = JSON.parse(l); return { model: r.model, contextTokens: r.contextTokens, runClass: r.runClass, delivered: r.delivered, testsPass: r.testsPass, terminal: r.terminal, contractModes: r.contractModes, causes: r.causes, wallMs: r.wallMs }; });
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      return { verdict: r.verdict, golden: r.golden, seed: r.seed, scenario: r.scenario, model: r.model, durationMs: r.durationMs, startState: r.startState, checks: (r.results ?? []).map(c => ({ step: c.step, name: c.name, pass: c.pass })) };
    } catch { return null; }
  }).flat().filter(Boolean);
}
const out = path.join(root, 'docs', 'M47_GOLDEN_MANIFEST.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote', out);
