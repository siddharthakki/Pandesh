/**
 * AW1 — "Scan every PDF in a folder with OCR, pull out the invoice number
 * and the total, and write a summary file."
 *
 * Everything is real:
 *   - the invoice PDFs are GENERATED locally as scans (a picture of a page
 *     with no text layer at all), so no personal document is ever touched,
 *   - the real Core process is driven over real HTTP,
 *   - the real governed capability reads each scan with OCR, locally,
 *   - the real approval gate decides the write,
 *   - the file, its content and the durable evidence are verified afterwards.
 *
 * Evidence lands in `.acceptance-evidence/aw1-ocr-summary/`.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScannedInvoice } from '../lib/scannedInvoiceFixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'aw1-ocr-summary');
const runRoot = process.env.PANDESH_AW1_ROOT ?? path.join(repoRoot, '.tmp', `aw1-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const scansDir = path.join(runRoot, 'Scans');
const token = 'aw1-ocr-summary-token';

const checks = [];
function record(name, status, detail) {
  checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, checks }, null, 2));
}

const startedAt = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;

async function startCore() {
  const logPath = path.join(runRoot, 'core-stdout.log');
  fs.mkdirSync(runRoot, { recursive: true });
  const out = fs.openSync(logPath, 'a');
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', out, out],
  });
  const deadline = Date.now() + 30_000;
  let port = 0;
  while (Date.now() < deadline) {
    const recordPath = path.join(dataDir, 'core.json');
    if (fs.existsSync(recordPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (parsed.port) { port = parsed.port; break; }
      } catch { /* partial write */ }
    }
    await sleep(60);
  }
  if (!port) {
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no Core output)';
    throw new Error(`the Core did not start within 30s:\n${log.slice(-1500)}`);
  }
  const healthDeadline = Date.now() + 30_000;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
}

async function stopCore(port) {
  if (!port) return;
  try {
    await fetch(`http://127.0.0.1:${port}/v1/core/shutdown`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `shutdown-${Date.now()}`,
        'X-Client-Id': 'aw1-acceptance',
      },
      body: '{}',
    });
  } catch { /* already gone */ }
  await sleep(500);
  if (child && !child.killed) child.kill();
  child = null;
}

async function api(port, method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Client-Id': 'aw1-acceptance',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': `idem-${Date.now()}-${Math.random()}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

/** One governed capability call, with its approval decided by `approve`. */
async function dispatch(port, toolName, args, { approve = true, cwd = scansDir } = {}) {
  const correlationId = `aw1-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const call = () => api(port, 'POST', '/v1/capabilities/dispatch', { correlationId, toolName, arguments: args, cwd });
  const first = await call();
  if (first.status !== 200 || first.body?.outcome !== 'approval_required') return first;
  const approval = first.body.approval;
  const resolved = await api(port, 'POST', `/v1/capabilities/approvals/${encodeURIComponent(approval.id)}/resolve`, {
    resolution: approve ? 'approved' : 'rejected',
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
  });
  if (resolved.status !== 200) return { status: resolved.status, body: resolved.body };
  return call();
}

/** The invoice number and the total out of the OCR text. */
function findInvoice(text, invoiceNumber) {
  const numberMatch = new RegExp(invoiceNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text);
  const totalMatch = /Total due:\s*EUR\s*([0-9][0-9.,]*)/i.exec(text);
  return { numberFound: Boolean(numberMatch), total: totalMatch?.[1] ?? null };
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(scansDir, { recursive: true });

  // ---- the isolated dataset ----------------------------------------------
  const { resolveOcrTools } = await import('../../core/runtime/documentOcr.ts').catch(() => ({ resolveOcrTools: null }));
  const pdftoppm = process.env.KARKEDIKHA_PDFTOPPM
    ?? 'C:/Users/siddh/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftoppm.exe';
  if (!fs.existsSync(pdftoppm)) {
    record('fixture_pdftoppm_available', 'BLOCKED', `pdftoppm is not available at ${pdftoppm}`);
    return;
  }
  const truth = [
    { invoiceNumber: 'INV-2026-00417', total: '1284.50', vendor: 'Garden Services GmbH' },
    { invoiceNumber: 'INV-2026-00418', total: '399.00', vendor: 'Roof Masters Ltd' },
    { invoiceNumber: 'INV-2026-00419', total: '87.25', vendor: 'City Water Works' },
  ];
  const invoices = truth.map((invoice) => {
    const built = buildScannedInvoice({
      dir: path.join(scansDir, invoice.invoiceNumber),
      invoiceNumber: invoice.invoiceNumber,
      total: invoice.total,
      vendor: invoice.vendor,
      pdftoppm,
    });
    return { ...built, truth: invoice };
  });
  record('generated_isolated_invoice_dataset', invoices.length === truth.length ? 'PASS' : 'FAIL', {
    invoices: invoices.map((invoice) => ({ file: path.basename(invoice.pdfPath), number: invoice.truth.invoiceNumber, total: invoice.truth.total })),
  });
  void resolveOcrTools;

  // ---- the real Core ------------------------------------------------------
  const core = await startCore();
  record('core_started', 'PASS', { port: core.port, instanceId: core.instanceId });

  // ---- 1. read every scan with OCR --------------------------------------
  const extracted = [];
  for (const invoice of invoices) {
    const result = await dispatch(core.port, 'document_read', { path: invoice.pdfPath });
    const output = result.body?.toolInvocation?.evidence?.output ?? '';
    const found = findInvoice(output, invoice.truth.invoiceNumber);
    extracted.push({ invoice, found, output });
    record(`ocr_read_${invoice.truth.invoiceNumber}`, found.numberFound && found.total === invoice.truth.total ? 'PASS' : 'FAIL', {
      numberFound: found.numberFound,
      ocrTotal: found.total,
      expectedTotal: invoice.truth.total,
      engine: /engine: tesseract/.test(output) ? 'tesseract+pdftoppm' : 'unknown',
      excerpt: output.slice(0, 160),
    });
  }
  record('every_scan_was_read_locally', extracted.every((entry) => entry.found.numberFound) ? 'PASS' : 'FAIL', {
    scans: extracted.length,
    engineUsed: /engine: tesseract/.test(extracted[0]?.output ?? '') ? 'OCR (the scans have no text layer)' : 'unknown',
  });

  // ---- 2. the write, through the governed gate ---------------------------
  // The helper the acceptance prepared in the scanned folder appends one
  // line per invoice. The COMMAND is what Pandesh asked for; the file it
  // produces is what the user asked for.
  const helper = path.join(scansDir, 'write-summary.mjs');
  fs.writeFileSync(helper, [
    "import { appendFileSync } from 'node:fs';",
    "const [, , target, ...pairs] = process.argv;",
    "if (!target || pairs.length === 0 || pairs.length % 2 !== 0) { console.error('usage: write-summary.mjs <file> <invoice> <total> [...]'); process.exit(2); }",
    "const lines = [];",
    "for (let i = 0; i < pairs.length; i += 2) lines.push(pairs[i] + ' | ' + pairs[i + 1]);",
    "appendFileSync(target, lines.join('\\n') + '\\n', 'utf8');",
    "console.log('wrote ' + lines.length + ' line(s)');",
  ].join('\n'), 'utf8');

  const summaryPath = path.join(scansDir, 'totals.md');
  const lines = extracted.map((entry) => `${entry.invoice.truth.invoiceNumber} | ${entry.found.total}`);
  const pairs = extracted.flatMap((entry) => [entry.invoice.truth.invoiceNumber, entry.found.total]);
  const command = `node write-summary.mjs totals.md ${pairs.map((value) => `"${value}"`).join(' ')}`;
  const written = await dispatch(core.port, 'run_command', { command }, { cwd: scansDir });
  record('summary_write_approved_and_executed', written.body?.outcome === 'executed' && fs.existsSync(summaryPath) ? 'PASS' : 'FAIL', {
    outcome: written.body?.outcome,
    reason: written.body?.reason,
    command,
  });

  const content = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '';
  record('summary_file_content_is_correct', lines.every((line) => content.includes(line)) ? 'PASS' : 'FAIL', { expected: lines, content });
  record('summary_file_has_one_line_per_invoice', content.trim().split(/\r?\n/).filter(Boolean).length === lines.length ? 'PASS' : 'FAIL', {
    lines: content.trim().split(/\r?\n/).filter(Boolean).length,
  });

  // ---- 3. the refusal path ------------------------------------------------
  const refusedPath = path.join(scansDir, 'refused.md');
  const refused = await dispatch(core.port, 'run_command', { command: `node write-summary.mjs refused.md "SHOULD NOT APPEAR"` }, { approve: false, cwd: scansDir });
  record('refused_write_leaves_no_file', refused.body?.outcome === 'denied' && !fs.existsSync(refusedPath) ? 'PASS' : 'FAIL', {
    outcome: refused.body?.outcome,
    reason: refused.body?.reason,
    fileExists: fs.existsSync(refusedPath),
  });

  // ---- 4. the durable evidence -------------------------------------------
  const approvals = await api(core.port, 'GET', '/v1/capabilities/actions?correlationId=none');
  void approvals;
  const dbPath = path.join(dataDir, 'core.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const approvalRows = db.prepare("SELECT status, resolution FROM approvals WHERE kind = 'mutation'").all();
  const invocationRows = db.prepare('SELECT toolName, status FROM tool_invocations').all();
  db.close();
  record('approval_rows_recorded', approvalRows.length >= lines.length + 1 ? 'PASS' : 'FAIL', {
    approvals: approvalRows.length,
    approved: approvalRows.filter((row) => row.status === 'approved').length,
    rejected: approvalRows.filter((row) => row.status === 'rejected').length,
  });
  record('tool_invocations_recorded', invocationRows.some((row) => row.toolName === 'document_read' && row.status === 'succeeded') ? 'PASS' : 'FAIL', {
    invocations: invocationRows.map((row) => `${row.toolName}:${row.status}`),
  });

  await stopCore(core.port);
}

try {
  await main();
} catch (error) {
  record('run_error', 'FAIL', String(error?.stack ?? error));
} finally {
  if (child && !child.killed) child.kill();
  const failed = checks.filter((c) => c.status === 'FAIL');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), checks }, null, 2));
  console.log(`\n${checks.length} checks, ${failed.length} failed. Evidence: ${evidenceDir}`);
  if (failed.length > 0) process.exitCode = 1;
}
