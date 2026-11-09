/**
 * Watchdog comparison and report (pure, unit-tested in core/test/watchdogReport.test.ts).
 * Only changes are news: a failure that already failed last run is "known"; an environment failure (Ollama down,
 * port in use, timeouts) is reported apart from product defects.
 */
// ── comparison and report ────────────────────────────────────────────────────────────────────────
export function flatten(report) {
  const out = {};
  for (const suite of Object.values(report.suites ?? {})) for (const [k, t] of Object.entries(suite.tests ?? {})) out[`suite:${k}`] = t;
  for (const [k, s] of Object.entries(report.live?.scenarios ?? {})) out[`live:${k}`] = s;
  return out;
}
export function compare(current, previous) {
  const now = flatten(current);
  const before = previous ? flatten(previous) : {};
  const regressions = [], fixed = [], known = [], environment = [], slower = [];
  for (const [k, t] of Object.entries(now)) {
    const was = before[k];
    if (t.status === 'failed') {
      if (t.environment) environment.push(k);
      else if (was?.status === 'failed') known.push(k);
      else regressions.push(k);
    } else if (t.status === 'passed' && was?.status === 'failed') fixed.push(k);
    if (t.status === 'passed' && was?.status === 'passed' && was.ms > 2000 && t.ms > was.ms * 1.5 && t.ms - was.ms > 30_000) slower.push(`${k} (${Math.round(was.ms / 1000)} s → ${Math.round(t.ms / 1000)} s)`);
  }
  return { baseline: !previous, regressions, fixed, known, environment, slower };
}
export function renderReport(report, diff, model) {
  const L = [`# Pandesh watchdog — ${report.runId}`, '', `Commit \`${report.commit}\` · model \`${model}\` · ${Math.round(report.ms / 60_000)} min`, ''];
  for (const s of Object.values(report.suites ?? {})) L.push(`- **${s.name} suite:** ${s.error ? `not run — ${s.error}` : `${s.counts?.passed ?? 0} passed, ${s.counts?.failed ?? 0} failed, ${s.counts?.skipped ?? 0} skipped`} (${Math.round(s.ms / 1000)} s)`);
  if (report.live?.deferred) L.push(`- **Live scenarios:** deferred — ${report.live.deferred}`);
  else if (report.live?.error) L.push(`- **Live scenarios:** not run — ${report.live.error}`);
  else if (report.live) for (const [id, s] of Object.entries(report.live.scenarios)) L.push(`- live \`${id}\` (${s.area}): **${s.status}**${s.failure ? ` — ${s.failure}` : ''} · ${Math.round(s.ms / 1000)} s`);
  L.push('', diff.baseline ? '**First run** — this is the baseline for future comparisons.' : `**Compared with the previous run:** ${diff.regressions.length} new failure(s), ${diff.fixed.length} fixed, ${diff.known.length} still failing (known), ${diff.environment.length} environment failure(s).`);
  const section = (title, items) => { if (items.length) L.push('', `## ${title}`, ...items.slice(0, 30).map((x) => `- ${x}`), ...(items.length > 30 ? [`- … and ${items.length - 30} more`] : [])); };
  section('New failures (regressions)', diff.regressions);
  section('Fixed since last run', diff.fixed);
  section('Environment failures (not product defects)', diff.environment);
  section('Noticeably slower', diff.slower);
  if (diff.known.length) L.push('', `${diff.known.length} known failure(s) unchanged since the last run (not repeated here).`);
  return L.join('\n');
}

