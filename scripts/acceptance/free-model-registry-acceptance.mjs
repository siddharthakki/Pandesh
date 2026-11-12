#!/usr/bin/env node
/**
 * Live acceptance for the free-model registry against a REAL, ISOLATED Core process (its own data dir and port,
 * Ollama pointed at a dead port so no local model is touched). Upstream registries are fetched live from GitHub.
 * Provider calls use a DUMMY key only, so they prove the auth path and error classification, not a real login.
 *
 *   node esbuild.core.js && node scripts/acceptance/free-model-registry-acceptance.mjs [evidenceDir]
 */
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const evidenceDir = path.resolve(process.argv[2] ?? 'D:/PandeshFreeModelsAcceptance');
const dataDir = path.join(evidenceDir, 'core-data');
const PORT = Number(process.env.PANDESH_ACCEPTANCE_PORT ?? 38431);
const TOKEN = randomBytes(32).toString('hex');
const DUMMY_KEY = 'gsk_PANDESHDUMMYacceptance00000000000000000001';
const base = `http://127.0.0.1:${PORT}`;
const evidence = { startedAt: new Date().toISOString(), dataDir, port: PORT, scenarios: {}, notes: [] };
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

function startCore(label, extraEnv = {}) {
  const log = fs.openSync(path.join(evidenceDir, `core-${label}.log`), 'w');
  const child = spawn(process.execPath, [path.join(root, 'out-core', 'core.js')], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: TOKEN, KARKEDIKHA_HOST_TOKEN: TOKEN, KARKEDIKHA_DATA_DIR: dataDir, KARKEDIKHA_CORE_PORT: String(PORT), KARKEDIKHA_OLLAMA_URL: 'http://127.0.0.1:9', ...extraEnv },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  return child;
}
async function waitHealthy(child) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Core exited with ${child.exitCode} during startup`);
    try { const r = await fetch(`${base}/v1/health`); if (r.ok) return; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error('Core did not become healthy (see the core-*.log next to the evidence)');
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function stopCore(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
  }
  await new Promise((r) => setTimeout(r, 500));
}
let n = 0;
async function call(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'free-model-acceptance', ...(method !== 'GET' ? { 'Idempotency-Key': `acc-${Date.now()}-${++n}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (text.includes(DUMMY_KEY)) throw new Error(`KEY LEAK in response to ${p}`);
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = (id, pass, details) => { evidence.scenarios[id] = { pass, ...details }; console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${details.summary}`); };

let core = startCore('run1');
try {
  await waitHealthy(core);
  // A1 + A2 + A3: live upstream refresh through Core.
  const t0 = Date.now();
  const refresh = await call('POST', '/v1/cloud/registry/refresh', {});
  const state = refresh.body.state;
  const src = Object.fromEntries(state.sources.map((s) => [s.id, s.fetch]));
  record('A1', refresh.status === 200 && src.primary && !src.primary.carriedOver && src.primary.accepted > 0, {
    summary: `primary ${src.primary?.accepted} API providers accepted of ${src.primary?.entryCount} entries (${src.primary?.rejected} rejected values), sha256 ${src.primary?.sha256?.slice(0, 12)}, ${Date.now() - t0} ms`,
    source: src.primary,
  });
  record('A2', src.secondary && !src.secondary.carriedOver && src.secondary.accepted > 0, {
    summary: `secondary ${src.secondary?.accepted} text-LLM providers accepted of ${src.secondary?.entryCount}; ${state.counts.inBothSources} providers reconciled across both sources; ${state.counts.conflicts} with recorded conflicts`,
    source: src.secondary,
    conflictsSample: state.providers.filter((p) => p.conflicts.length).slice(0, 5).map((p) => ({ id: p.id, conflicts: p.conflicts })),
  });
  const groq = state.providers.find((p) => p.id === 'groq');
  const dupModels = groq.models.filter((m) => m.sources.length > 1);
  const allKeys = state.providers.flatMap((p) => p.models.map((m) => m.key.toLowerCase()));
  record('A3', state.providers.filter((p) => p.id === 'groq').length === 1 && dupModels.length > 0 && new Set(allKeys).size === allKeys.length, {
    summary: `groq is one record from ${groq.sources.map((s) => `${s.source}:${s.key}`).join(' + ')}; ${dupModels.length} of its models listed by both sources, each once; ${allKeys.length} model keys, all unique`,
    groq: { status: groq.status, sources: groq.sources, models: groq.models.map((m) => ({ id: m.modelId, sources: m.sources, status: m.status })) },
  });
  evidence.counts = state.counts;
  evidence.changeReport = refresh.body.outcome.report.summary;

  // A4: listed free upstream, not verified by Pandesh -> unverified, not eligible.
  await call('POST', '/v1/cloud/registry/preferences', { autoProviders: ['groq', 'openrouter'] });
  const route1 = await call('POST', '/v1/cloud/route', { task: 'research', privacy: 'public' });
  const rejectedGroq = route1.body.decision.rejected ?? [];
  record('A4', groq.status === 'unverified' && route1.body.decision.kind === 'blocked', {
    summary: `groq status "${groq.status}" (${groq.statusReasons[0]}); route decision ${route1.body.decision.kind}: ${route1.body.decision.reason}`,
    unverifiedModels: state.counts.modelsByStatus.unverified, verifiedFree: state.counts.modelsByStatus.verified_free,
  });
  // A5: approved but no key -> pending setup, never selected.
  const reg1 = await call('GET', '/v1/cloud/registry');
  const groqView = reg1.body.providers.find((p) => p.id === 'groq');
  const health0 = await call('POST', '/v1/cloud/registry/providers/groq/health', { force: true });
  record('A5', groqView.setup === 'pending_setup' && /no API key/.test(JSON.stringify(health0.body.result)), {
    summary: `groq setup="${groqView.setup}", health check: ${JSON.stringify(health0.body.result)}; route: ${route1.body.decision.kind}`,
    pendingSetup: reg1.body.providers.filter((p) => p.setup === 'pending_setup').map((p) => p.id),
  });
  // A6: private -> local only. Also: unspecified privacy is treated as private.
  const priv = await call('POST', '/v1/cloud/route', { task: 'chat', privacy: 'private' });
  const unspecified = await call('POST', '/v1/cloud/route', { task: 'chat' });
  record('A6', priv.body.decision.kind === 'blocked' && unspecified.body.privacy === 'private' && unspecified.body.decision.kind === 'blocked', {
    summary: `private: ${priv.body.decision.reason}; unspecified privacy resolved to "${unspecified.body.privacy}"`,
  });
  // Live provider auth path with a DUMMY key: real HTTPS call to Groq, classified, key never echoed.
  await call('POST', '/v1/providers/groq/credential', { baseUrl: 'https://api.groq.com/openai/v1', apiKey: DUMMY_KEY });
  const health1 = await call('POST', '/v1/cloud/registry/providers/groq/health', { force: true });
  const after = (await call('GET', '/v1/cloud/registry')).body.providers.find((p) => p.id === 'groq');
  evidence.dummyKeyAuth = { health: health1.body.result, statusReasons: after.statusReasons, setup: after.setup };
  record('AUTH-DUMMY', health1.body.result.errorClass === 'auth' && /set it up again/.test(after.statusReasons.join(' ')), {
    summary: `live Groq /models with a dummy key -> HTTP ${health1.body.result.httpStatus} (${health1.body.result.errorClass}); UI prompt: "${after.statusReasons.slice(-1)[0]}"`,
  });
  evidence.registryFileSha = sha(path.join(dataDir, 'free-models', 'registry.json'));
} finally {
  await stopCore(core);
}

// A12: restart -> same registry, approvals and schedule.
core = startCore('run2-restart');
try {
  await waitHealthy(core);
  const reg = (await call('GET', '/v1/cloud/registry')).body;
  record('A12', reg.counts.providers === evidence.counts.providers && reg.preferences.autoProviders.join() === 'groq,openrouter' && Boolean(reg.schedule?.enabled), {
    summary: `after a real Core restart: ${reg.counts.providers} providers / ${reg.counts.models} models (before: ${evidence.counts.providers}/${evidence.counts.models}); auto-routing approvals ${JSON.stringify(reg.preferences.autoProviders)}; daily refresh ${reg.schedule?.enabled ? `on at ${reg.schedule.dailyTime}` : 'missing'}; key in Core memory: ${reg.providers.find((p) => p.id === 'groq').keyConfigured} (the host re-pushes it from Credential Manager on connect)`,
  });
} finally {
  await stopCore(core);
}

// A10: upstream unavailable (real HTTP 404 from GitHub for both sources) -> last known-good kept byte for byte.
core = startCore('run3-outage', {
  PANDESH_FREE_REGISTRY_URL_PRIMARY: 'https://raw.githubusercontent.com/mvalentsev/awesome-free-ai-coding/main/pandesh-acceptance-missing.json',
  PANDESH_FREE_REGISTRY_URL_SECONDARY: 'https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/pandesh-acceptance-missing.json',
});
try {
  await waitHealthy(core);
  const before = sha(path.join(dataDir, 'free-models', 'registry.json'));
  const out = (await call('POST', '/v1/cloud/registry/refresh', {})).body;
  const afterSha = sha(path.join(dataDir, 'free-models', 'registry.json'));
  record('A10', !out.outcome.ok && out.outcome.keptLastKnownGood && before === afterSha && out.state.counts.providers === evidence.counts.providers, {
    summary: `both sources failed (${out.outcome.errors.join(' | ')}); registry.json unchanged (sha ${afterSha.slice(0, 12)}); still ${out.state.counts.providers} providers`,
  });
} finally {
  await stopCore(core);
}

// No key in any file Core wrote.
const leaks = [];
for (const dirent of fs.readdirSync(dataDir, { recursive: true, withFileTypes: true })) {
  if (!dirent.isFile()) continue;
  const file = path.join(dirent.parentPath ?? dirent.path, dirent.name);
  if (fs.readFileSync(file).includes(DUMMY_KEY)) leaks.push(path.relative(dataDir, file));
}
for (const log of fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.log'))) if (fs.readFileSync(path.join(evidenceDir, log)).includes(DUMMY_KEY)) leaks.push(log);
record('NO-KEY-IN-FILES', leaks.length === 0, { summary: leaks.length ? `key found in ${leaks.join(', ')}` : 'dummy key absent from every Core file, database and log' });

evidence.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(evidenceDir, 'free-model-acceptance.json'), JSON.stringify(evidence, null, 2));
console.log(`evidence: ${path.join(evidenceDir, 'free-model-acceptance.json')}`);
process.exit(Object.values(evidence.scenarios).every((s) => s.pass) ? 0 : 1);
