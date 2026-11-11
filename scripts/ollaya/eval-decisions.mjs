// Measures Ollaya's local decision models on Pandesh's decision points (see questions.mjs and datasets/).
// One request per model and case, strictly one at a time, so the machine stays usable. Loopback only; it never pulls
// a model and never touches Ollama.
//
//   node scripts/ollaya/eval-decisions.mjs [--models a,b] [--decisions x,y] [--out DIR] [--endpoint URL] [--resume]
//        [--questions q1,q2] [--limit N]   (only those questions / the first N cases: e.g. to time a production setup)
//   node scripts/ollaya/eval-decisions.mjs --summarize-only --out DIR
//
// Output in --out: raw.jsonl (every answer and its latency), summary.json and summary.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS, DEFAULT_MODELS, GUARD_MODELS } from './questions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);

const endpoint = new URL(arg('endpoint', 'http://127.0.0.1:11435'));
if (!['127.0.0.1', '[::1]', '::1', 'localhost'].includes(endpoint.hostname)) {
  throw new Error(`refusing ${endpoint.origin}: the decision server must be on this machine (loopback)`);
}
const models = arg('models', DEFAULT_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
const decisions = arg('decisions', Object.keys(DECISIONS).join(',')).split(',').map((d) => d.trim()).filter(Boolean);
const outDir = path.resolve(arg('out', path.join(here, '..', '..', '.tmp', 'ollaya-eval')));
// --questions a,b asks only those questions (to time a production setup); scorers that need others are skipped.
const onlyQuestions = arg('questions', '') ? new Set(arg('questions', '').split(',').map((q) => q.trim())) : null;
const limit = Number(arg('limit', '0')) || Infinity;
const questionsFor = (spec) => (onlyQuestions ? Object.fromEntries(Object.entries(spec.questions).filter(([k]) => onlyQuestions.has(k))) : spec.questions);
const rawFile = path.join(outDir, 'raw.jsonl');
fs.mkdirSync(outDir, { recursive: true });

function loadCases(decision) {
  const spec = DECISIONS[decision];
  const cases = fs.readFileSync(path.join(here, 'datasets', spec.file), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  // Deterministic split: within each stratum (label combination), alternate dev/test in id order.
  const seen = new Map();
  for (const c of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    const k = spec.stratify(c);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    c.split = n % 2 === 0 ? 'dev' : 'test';
  }
  return cases;
}

async function ask(model, state, questions) {
  const body = { model, state };
  if (questions) body.questions = questions;
  const t0 = performance.now();
  try {
    const res = await fetch(new URL('/v1/systemone', endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const json = await res.json().catch(() => null);
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ms, error: `${res.status} ${json?.error ?? ''}`.trim() };
    return { ms, served: json?.model, answers: json?.answers ?? {} };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: e.message };
  }
}

async function run() {
  const done = new Set();
  if (flag('resume') && fs.existsSync(rawFile)) {
    for (const line of fs.readFileSync(rawFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const r = JSON.parse(line);
      if (!r.error) done.add(`${r.model}|${r.decision}|${r.id}`);
    }
  } else if (fs.existsSync(rawFile)) {
    fs.renameSync(rawFile, `${rawFile}.${Date.now()}.bak`);
  }
  for (const model of models) {
    const guard = GUARD_MODELS.has(model);
    for (const decision of decisions) {
      const spec = DECISIONS[decision];
      if (guard && !spec.guardState) continue;
      const cases = loadCases(decision).slice(0, limit);
      const questions = questionsFor(spec);
      if (!guard && !Object.keys(questions).length) continue;
      let errors = 0;
      const started = Date.now();
      for (const c of cases) {
        if (done.has(`${model}|${decision}|${c.id}`)) continue;
        const r = guard ? await ask(model, spec.guardState(c), null) : await ask(model, spec.state(c), questions);
        if (r.error) errors += 1;
        fs.appendFileSync(rawFile, `${JSON.stringify({ model, decision, id: c.id, split: c.split, ...r })}\n`);
      }
      console.log(`${model.padEnd(22)} ${decision.padEnd(18)} ${cases.length} cases, ${errors} errors, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
}

// ---------- metrics ----------
const pct = (x) => (x === null || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`);
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96; const ph = k / n; const d = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / d; const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function auc(rows) {
  const pos = rows.filter((r) => r.label).map((r) => r.risk); const neg = rows.filter((r) => !r.label).map((r) => r.risk);
  if (!pos.length || !neg.length) return null;
  let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
function at(rows, t) {
  const tp = rows.filter((r) => r.label && r.risk >= t).length; const fp = rows.filter((r) => !r.label && r.risk >= t).length;
  const pos = rows.filter((r) => r.label).length; const neg = rows.length - pos;
  return { t, tp, fp, pos, neg, recall: pos ? tp / pos : null, precision: tp + fp ? tp / (tp + fp) : null, fpr: neg ? fp / neg : null };
}
/** The threshold a dev split would pick: the highest recall with precision >= 0.8 (ties: the higher threshold). */
function devThreshold(dev) {
  const candidates = [...new Set([0.5, 0.8, ...dev.map((r) => r.risk)])].sort((a, b) => b - a);
  let best = null;
  for (const t of candidates) {
    const m = at(dev, t);
    if (m.precision !== null && m.precision >= 0.8 && (best === null || m.recall > best.recall)) best = m;
  }
  return best;
}

function summarize() {
  const raw = fs.readFileSync(rawFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const byKey = new Map();
  for (const r of raw) byKey.set(`${r.model}|${r.decision}|${r.id}`, r); // last answer wins (resume)
  const cases = Object.fromEntries(Object.keys(DECISIONS).map((d) => [d, new Map(loadCases(d).map((c) => [c.id, c]))]));
  const results = { binary: [], choice: [], latency: [] };
  const groups = new Map();
  for (const r of byKey.values()) { const k = `${r.model}|${r.decision}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

  for (const [k, rs] of groups) {
    const [model, decision] = k.split('|');
    const spec = DECISIONS[decision]; const guard = GUARD_MODELS.has(model);
    const ok = rs.filter((r) => !r.error);
    results.latency.push({ model, decision, calls: rs.length, errors: rs.length - ok.length, p50: quantile(ok.map((r) => r.ms), 0.5), p95: quantile(ok.map((r) => r.ms), 0.95), served: [...new Set(ok.map((r) => r.served))].join(',') });
    for (const [name, sc] of Object.entries(spec.scorers ?? {})) {
      if (Boolean(sc.guard) !== guard) continue;
      const rows = ok.map((r) => ({ id: r.id, split: r.split, label: sc.label(cases[decision].get(r.id)), risk: sc.risk(r.answers) })).filter((x) => typeof x.risk === 'number');
      if (!rows.length) continue;
      const dev = rows.filter((x) => x.split === 'dev'); const test = rows.filter((x) => x.split === 'test');
      // Two folds: tune on one half, measure on the other, both ways. The pooled out-of-fold predictions decide the bar,
      // so a threshold that only works on the half it was picked from cannot pass.
      const tA = devThreshold(dev); const tB = devThreshold(test);
      const oof = [...(tA ? test.map((x) => ({ ...x, flagged: x.risk >= tA.t })) : []), ...(tB ? dev.map((x) => ({ ...x, flagged: x.risk >= tB.t })) : [])];
      const tp = oof.filter((x) => x.label && x.flagged).length; const fp = oof.filter((x) => !x.label && x.flagged).length;
      const pos = oof.filter((x) => x.label).length;
      const outOfFold = tA && tB ? { tp, fp, pos, n: oof.length, recall: pos ? tp / pos : null, precision: tp + fp ? tp / (tp + fp) : null, recallCI: wilson(tp, pos), precisionCI: wilson(tp, tp + fp) } : null;
      const onTest = tA ? at(test, tA.t) : null;
      const bandCaution = rows.filter((x) => x.label); const bandSafe = rows.filter((x) => !x.label);
      results.binary.push({
        model, decision, scorer: name, n: rows.length, auc: auc(rows), aucTest: auc(test),
        at50: at(rows, 0.5), at80: at(rows, 0.8),
        band: { flaggedCaution: bandCaution.filter((x) => x.risk >= 0.8).length / (bandCaution.length || 1), falseFlags: bandSafe.filter((x) => x.risk >= 0.8).length / (bandSafe.length || 1), abstain: rows.filter((x) => x.risk > 0.2 && x.risk < 0.8).length / rows.length },
        devThreshold: tA ? tA.t : null,
        swapThreshold: tB ? tB.t : null,
        test: onTest ? { ...onTest, recallCI: wilson(onTest.tp, onTest.pos), precisionCI: wilson(onTest.tp, onTest.tp + onTest.fp) } : null,
        outOfFold,
        meetsBar: Boolean(outOfFold && outOfFold.recall >= 0.9 && outOfFold.precision !== null && outOfFold.precision >= 0.8),
        misses: oof.filter((x) => x.label && !x.flagged).map((x) => x.id),
        falseAlarms: oof.filter((x) => !x.label && x.flagged).map((x) => x.id),
      });
    }
    for (const [name, sc] of Object.entries(spec.choices ?? {})) {
      if (guard) continue;
      const rows = ok.map((r) => { const a = sc.answer(r.answers); return { id: r.id, split: r.split, label: sc.label(cases[decision].get(r.id)), choice: a?.choice ?? null, confidence: a?.confidence ?? null }; }).filter((x) => x.choice);
      if (!rows.length) continue;
      const acc = (xs) => (xs.length ? xs.filter((x) => x.choice === x.label).length / xs.length : null);
      const covered = rows.filter((x) => x.confidence >= 0.6);
      const labels = [...new Set(rows.map((x) => x.label))];
      results.choice.push({
        model, decision, scorer: name, n: rows.length, accuracy: acc(rows), accuracyTest: acc(rows.filter((x) => x.split === 'test')),
        coverage60: covered.length / rows.length, accuracyCovered60: acc(covered),
        perClassRecall: Object.fromEntries(labels.map((l) => [l, acc(rows.filter((x) => x.label === l))])),
        confusion: Object.fromEntries(labels.map((l) => [l, Object.fromEntries(labels.map((m) => [m, rows.filter((x) => x.label === l && x.choice === m).length]))])),
        wrong: rows.filter((x) => x.choice !== x.label).map((x) => `${x.id}:${x.choice}`),
      });
    }
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);

  const lines = ['# Ollaya decision models: measured results', '', `Endpoint ${endpoint.origin}; ${byKey.size} answers. Each dataset is split in half (alternating per label); each half picks a threshold that the other half is scored with, and the pooled out-of-fold predictions decide the bar.`, ''];
  for (const decision of Object.keys(DECISIONS)) {
    const bin = results.binary.filter((r) => r.decision === decision).sort((a, b) => (b.auc ?? 0) - (a.auc ?? 0));
    if (bin.length) {
      lines.push(`## ${decision}`, '', 'Caution class = the outcome that should make Pandesh more careful. Bar: out-of-fold recall ≥ 90% at precision ≥ 80% (threshold tuned on one half, measured on the other, both ways).', '');
      lines.push('| model | wording | AUC | recall@0.5 | FPR@0.5 | thresholds (fold A / B) | out-of-fold recall (95% CI) | out-of-fold precision | bar | ≥0.8 flags / false flags / abstain |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|');
      for (const r of bin) {
        const o = r.outOfFold;
        const ci = o && o.recallCI[0] !== null ? ` (${pct(o.recallCI[0])}–${pct(o.recallCI[1])})` : '';
        const th = r.devThreshold === null || r.swapThreshold === null ? 'none ≥80% precision' : `${r.devThreshold.toFixed(2)} / ${r.swapThreshold.toFixed(2)}`;
        lines.push(`| ${r.model} | ${r.scorer} | ${r.auc === null ? '—' : r.auc.toFixed(2)} | ${pct(r.at50.recall)} | ${pct(r.at50.fpr)} | ${th} | ${o ? pct(o.recall) + ci : '—'} | ${o ? pct(o.precision) : '—'} | ${r.meetsBar ? '**yes**' : 'no'} | ${pct(r.band.flaggedCaution)} / ${pct(r.band.falseFlags)} / ${pct(r.band.abstain)} |`);
      }
      lines.push('');
    }
    const ch = results.choice.filter((r) => r.decision === decision).sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0));
    if (ch.length) {
      lines.push(`## ${decision}`, '', '| model | wording | accuracy | test accuracy | answered at confidence ≥0.6 | accuracy when answered | weakest class |', '|---|---|---|---|---|---|---|');
      for (const r of ch) {
        const weakest = Object.entries(r.perClassRecall).sort((a, b) => a[1] - b[1])[0];
        lines.push(`| ${r.model} | ${r.scorer} | ${pct(r.accuracy)} | ${pct(r.accuracyTest)} | ${pct(r.coverage60)} | ${pct(r.accuracyCovered60)} | ${weakest[0]} ${pct(weakest[1])} |`);
      }
      lines.push('');
    }
  }
  lines.push('## Latency per call (all questions of a decision in one call, CPU)', '', '| model | decision | calls | errors | p50 ms | p95 ms | served by |', '|---|---|---|---|---|---|---|');
  for (const l of results.latency.sort((a, b) => a.model.localeCompare(b.model) || a.decision.localeCompare(b.decision))) lines.push(`| ${l.model} | ${l.decision} | ${l.calls} | ${l.errors} | ${l.p50 ?? '—'} | ${l.p95 ?? '—'} | ${l.served} |`);
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(`summary: ${path.join(outDir, 'summary.md')}`);
}

if (!flag('summarize-only')) await run();
summarize();
