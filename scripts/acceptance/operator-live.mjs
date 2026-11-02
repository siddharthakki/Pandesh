#!/usr/bin/env node
/**
 * Live acceptance for the master operator: a real Core process (out-core/core.js, scratch data dir), the real HTTP API as the
 * Pandesh host, real Ollama, the real web, the real Downloads folder (read-only) and real OpenCode through Kandev.
 * Nothing is mocked. The script plays the user: it gives or withholds approvals and then checks the outcome on disk.
 *
 *   node esbuild.core.js
 *   OP_DATA_DIR=<scratch dir> node scripts/acceptance/operator-live.mjs [research|files|coding|privacy|all]
 *
 * It never writes to the real Downloads folder: the move path is exercised on a synthetic folder.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.resolve(process.env.OP_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'operator-live-')));
const which = process.argv[2] || 'all';
const TOKEN = crypto.randomBytes(24).toString('hex');
const HOST = crypto.randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

let core; let port;
async function startCore() {
  fs.mkdirSync(DATA, { recursive: true });
  core = spawn(process.execPath, [path.join(REPO, 'out-core', 'core.js')], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: TOKEN, KARKEDIKHA_HOST_TOKEN: HOST, KARKEDIKHA_DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  core.stdout.on('data', () => {}); core.stderr.on('data', (d) => process.stderr.write(String(d)));
  for (let i = 0; i < 60; i++) {
    try { port = JSON.parse(fs.readFileSync(path.join(DATA, 'core.json'), 'utf8')).port; if (port) { const r = await fetch(`http://127.0.0.1:${port}/v1/health`); if (r.ok) return; } } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error('Core did not start');
}
async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Host-Token': HOST, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const stepsSeen = new Map();
/** Polls a run; `onApproval(step, view)` returns 'approved' | 'rejected' for each approval the run stops at. */
async function drive(label, runId, onApproval, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const { json } = await api('GET', `/v1/operator/runs/${runId}`);
    const { run, steps } = json;
    for (const s of steps) {
      const key = `${runId}:${s.idx}:${s.status}`;
      if (!stepsSeen.has(key) && s.status !== 'pending') {
        stepsSeen.set(key, true);
        console.log(`  [${label}] step ${s.idx + 1} ${s.title} → ${s.status}${s.tool ? ` · ${s.tool}` : ''}${s.evidence ? ` · ${s.evidence.slice(0, 110)}` : ''}${s.error ? ` · ${s.error.slice(0, 160)}` : ''}`);
      }
    }
    if (run.status === 'awaiting_approval') {
      const step = steps.find((s) => s.status === 'awaiting_approval');
      if (step) {
        const decision = await onApproval(step, json);
        console.log(`  [${label}] approval "${step.title}" → ${decision}`);
        await api('POST', `/v1/operator/runs/${runId}/steps/${step.idx}/decision`, { decision });
        continue;
      }
    }
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(run.status)) return json;
    if (Date.now() - t0 > timeoutMs) return json;
    await sleep(2_000);
  }
}

async function researchWorkflow() {
  console.log('\n=== A. Public research ===');
  const instruction = "Pandesh, research today's important AI developments and tell me which techniques could improve Pandesh.";
  const created = await api('POST', '/v1/operator/runs', { instruction });
  check('A: run accepted from one natural-language instruction', created.status === 201, `${created.json.workflow}, ${created.json.privacy}`);
  let queries = [];
  const out = await drive('A', created.json.id, async (step) => { queries = step.output.queries; console.log(`  queries shown for approval: ${JSON.stringify(queries)}`); return 'approved'; }, 15 * 60_000);
  check('A: stopped for web-egress approval before searching', queries.length > 0);
  check('A: run completed', out.run.status === 'completed', out.run.statusDetail);
  if (out.run.status === 'completed') {
    const r = out.run.result;
    check('A: web research tool selected from live catalog', r.tools.some((t) => t.tool === 'capability:web_research'));
    check('A: synthesis ran on a local Ollama model', r.tools.some((t) => String(t.tool).startsWith('ollama:')), r.model);
    check('A: citations verified against fetched sources', r.verified.some((v) => /citations resolve/.test(v.evidence ?? '')), r.verified.map((v) => v.evidence).join(' | '));
    console.log(`\n--- answer (model ${r.model}) ---\n${r.answer}\n---`);
  }
  return out;
}

async function filesWorkflow() {
  console.log('\n=== B. Private Windows task ===');
  const downloads = path.join(os.homedir(), 'Downloads');
  const snapshot = () => fs.readdirSync(downloads, { recursive: true }).length;
  const before = snapshot();
  const created = await api('POST', '/v1/operator/runs', { instruction: 'Find PDF invoices in my Downloads folder and show me how they should be organized.' });
  check('B: classified as local-only', created.json.privacy === 'local_only', created.json.privacyReasons.join('; '));
  let proposal = null;
  const out = await drive('B', created.json.id, async (step, view) => {
    proposal = view.steps.find((s) => s.kind === 'propose_organization')?.output;
    check('B: asked before moving files (nothing moved yet)', snapshot() === before);
    return 'rejected';
  }, 10 * 60_000);
  check('B: no web or external model used', !JSON.stringify(out.steps.map((s) => s.tool)).match(/web_research|executor:claude|ollama/), JSON.stringify([...new Set(out.steps.map((s) => s.tool).filter(Boolean))]));
  check('B: real Downloads folder unchanged after declining', snapshot() === before);
  check('B: run completed with a proposal', out.run.status === 'completed' && Boolean(out.run.result?.proposal), out.run.statusDetail);
  if (proposal) console.log(`  proposal: ${proposal.moves.length} moves into ${proposal.layout.length} folders (${proposal.layout.slice(0, 6).map((l) => `${l.dir}=${l.count}`).join(', ')}); ${proposal.leaveInPlace} PDFs left in place`);

  // The move path itself, on a synthetic folder (never the real Downloads).
  const synth = fs.mkdtempSync(path.join(os.tmpdir(), 'op-invoices-'));
  fs.writeFileSync(path.join(synth, 'acme-invoice-0042.pdf'), minimalPdf('INVOICE Invoice No 0042 From: Acme GmbH Date: 2025-03-14 Total due 120,50 EUR VAT 19%'));
  fs.writeFileSync(path.join(synth, 'stadtwerke.pdf'), minimalPdf('Rechnung Rechnungsnummer 77 Stadtwerke Berlin Rechnungsdatum 03.02.2026 Gesamtbetrag 89,00 EUR MwSt'));
  fs.writeFileSync(path.join(synth, 'holiday-guide.pdf'), minimalPdf('A guide to holiday photography.'));
  const c2 = await api('POST', '/v1/operator/runs', { instruction: `Find PDF invoices in my folder ${synth} and show me how they should be organized.`, folder: synth });
  const out2 = await drive('B2', c2.json.id, async () => 'approved', 5 * 60_000);
  const inv = path.join(synth, 'Invoices');
  const moved = fs.existsSync(inv) ? fs.readdirSync(inv, { recursive: true }).filter((f) => String(f).endsWith('.pdf')) : [];
  check('B: after explicit approval, invoices were moved and verified', out2.run.status === 'completed' && moved.length === 2 && fs.existsSync(path.join(synth, 'holiday-guide.pdf')), moved.join(', '));
  fs.rmSync(synth, { recursive: true, force: true });
}

function minimalPdf(text) {
  const esc = text.replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 12 Tf 40 700 Td (${esc}) Tj ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

async function codingWorkflow() {
  console.log('\n=== C. Autonomous coding ===');
  const created = await api('POST', '/v1/operator/runs', { instruction: 'Build a small responsive website, test it and show me the finished result.' });
  check('C: classified as public coding', created.json.workflow === 'coding' && created.json.privacy === 'public');
  const out = await drive('C', created.json.id, async () => 'approved', 45 * 60_000);
  check('C: run completed', out.run.status === 'completed', out.run.statusDetail);
  const sel = out.steps.find((s) => s.kind === 'select_executor');
  if (sel?.selection) console.log(`  executors considered: ${sel.selection.map((c) => `${c.label}=${c.verdict}(${c.why})`).join('; ')}`);
  check('C: a local executor was selected automatically', /executor:(opencode|hermes)/.test(sel?.tool ?? ''), sel?.tool);
  const v = out.steps.find((s) => s.kind === 'verify_deliverable');
  if (v?.output) {
    check('C: independent clean-clone test run passed', v.output.tests.pass > 0 && v.output.tests.fail === 0, v.evidence);
    check('C: deliverable is responsive HTML', v.output.responsive === true && Boolean(v.output.entry));
    console.log(`  deliverable: ${v.output.entry}`);
  }
}

async function privacyChecks() {
  console.log('\n=== Privacy and explicit-choice enforcement (real API) ===');
  const a = await api('POST', '/v1/operator/runs', { instruction: 'Build a small calculator app and test it. Use the passwords in my Gmail.', executor: 'claude', preApprove: { externalTransfer: true } });
  const ra = await drive('P1', a.json.id, async () => 'rejected', 60_000);
  check('P: private coding pinned to an external executor is refused, nothing sent', ra.run.status === 'blocked' && /private|off this PC/.test(ra.run.statusDetail), ra.run.statusDetail);
  const b = await api('POST', '/v1/operator/runs', { instruction: 'Build a small calculator app and test it.', executor: 'claude' });
  const rb = await drive('P2', b.json.id, async () => 'rejected', 60_000);
  check('P: public task pinned to Claude Code without consent is blocked', rb.run.status === 'blocked' && /consent|Approve the transfer|Nothing was sent/.test(rb.run.statusDetail), rb.run.statusDetail);
  const c = await api('POST', '/v1/operator/runs', { instruction: 'Build a small calculator app and test it.', executor: 'antigravity' });
  const rc = await drive('P3', c.json.id, async () => 'rejected', 60_000);
  check('P: a pinned executor that cannot run is not substituted', rc.run.status === 'blocked' && /Nothing (else was substituted|was sent)/.test(rc.run.statusDetail) && !rc.steps.some((s) => s.tool), rc.run.statusDetail);
  const d = await api('POST', '/v1/operator/runs', { instruction: "Research today's AI news.", model: 'no-such-model:1b', preApprove: { webEgress: true } });
  const rd = await drive('P4', d.json.id, async () => 'approved', 3 * 60_000);
  check('P: a named model that is not installed blocks the step', rd.run.status === 'blocked' && /no-such-model/.test(rd.run.statusDetail), rd.run.statusDetail);
}

try {
  await startCore();
  console.log(`Core on :${port}, scratch data ${DATA}`);
  const cat = await api('GET', '/v1/operator/catalog');
  console.log('Live catalog:');
  for (const e of cat.json.entries.filter((x) => !(x.kind === 'model' && x.id !== 'ollama:gemma4:12b'))) console.log(`  ${e.available ? '✔' : '✘'} ${e.id} [${e.locality}]${e.reason ? ` — ${e.reason}` : ''}`);
  console.log(`  (${cat.json.entries.filter((e) => e.kind === 'model').length} local models installed)`);
  const all = which === 'all';
  if (all || which === 'privacy') await privacyChecks();
  if (all || which === 'research') await researchWorkflow();
  if (all || which === 'files') await filesWorkflow();
  if (all || which === 'coding') await codingWorkflow();
} catch (err) {
  console.error('ACCEPTANCE ERROR', err);
  results.push({ name: 'harness', ok: false });
} finally {
  core?.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
