#!/usr/bin/env node
/**
 * Household OS acceptance demos (PC organization, routines, Gmail → Important Dates, JUGAAD, media, Wish-to-Reality).
 *
 * Runs the real Core bundle (out-core/core.js) against an ISOLATED data dir and an explicitly authorized test folder —
 * never the production profile, never real personal files. Gmail is a controlled fixture through Core's existing
 * KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH seam. Approvals are given by this harness acting as the user, through the same
 * /v1/capabilities/approvals route the approval card uses; evidence records that.
 *
 * Usage: node scripts/acceptance/household-os-demos.mjs <setup|start|stop|restart|status|inventory|d1|d1-chat|d2-create|d2-check|d3|d3-update|d4-enable|d4-code|d4-pc|d5|d6>
 * Env:   HOUSEHOLD_DEMO_ROOT (default D:\PandeshDemo)
 */
import { spawn, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const ROOT = process.env.HOUSEHOLD_DEMO_ROOT ?? 'D:\\PandeshDemo';
const DATA = path.join(ROOT, 'core-data');
const TEST = path.join(ROOT, 'TestFolder');
const PICS = path.join(ROOT, 'Pictures');
const EVID = path.join(ROOT, 'evidence');
const STATE = path.join(ROOT, 'harness.json');
const FIXTURE = path.join(ROOT, 'gmail-fixture.json');
const TOKEN = 'household-os-demo-token';
const HOST_TOKEN = 'household-os-demo-host-token';
const CLIENT = 'household-os-demo';
// One conversation per invocation: Core's dispatch is exactly-once per (conversation, action), so a rerun must not reuse it.
const CONV = `household-os-demo-${Date.now()}`;
const MODEL = process.env.HOUSEHOLD_DEMO_MODEL ?? 'gemma4:26b-a4b-it-qat';

const log = (m) => process.stdout.write(`[demo] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(EVID, { recursive: true });
const evidence = (name, data) => { fs.writeFileSync(path.join(EVID, `${name}.json`), JSON.stringify({ at: new Date().toISOString(), approvalsGivenBy: 'acceptance harness acting as the user', ...data }, null, 2)); log(`evidence → ${path.join(EVID, `${name}.json`)}`); };

// ------------------------------------------------------------------ fixtures

function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const body = `BT /F1 11 Tf 14 TL 50 780 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  return Buffer.from([
    '%PDF-1.4', '1 0 obj', '<< /Type /Catalog /Pages 2 0 R >>', 'endobj', '2 0 obj', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'endobj',
    '3 0 obj', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', 'endobj',
    '4 0 obj', `<< /Length ${body.length} >>`, 'stream', body, 'endstream', 'endobj', '5 0 obj', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'endobj',
    'trailer', '<< /Root 1 0 R >>', '%%EOF',
  ].join('\n'), 'latin1');
}

async function setup() {
  await stopCore();
  for (const d of [TEST, DATA, EVID]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(EVID, { recursive: true });
  fs.mkdirSync(TEST, { recursive: true });
  fs.mkdirSync(PICS, { recursive: true });
  const put = (rel, data, daysAgo = 3) => { const p = path.join(TEST, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); const t = new Date(Date.now() - daysAgo * 86_400_000); fs.utimesSync(p, t, t); };
  put('Steuerbescheid_2024.pdf', pdf(['Finanzamt Ulm', 'Bescheid fuer 2024 ueber Einkommensteuer', 'Steuernummer 88/123/45678', 'Festgesetzt werden 1.234,00 EUR']));
  put('Lohnsteuerbescheinigung_2025.pdf', pdf(['Ausdruck der elektronischen Lohnsteuerbescheinigung fuer 2025', 'Arbeitgeber: Muster GmbH']));
  put('scan_0012.pdf', pdf(['Zuwendungsbestaetigung', 'Bestaetigung ueber Geldzuwendungen im Jahr 2025', 'Betrag: 150,00 EUR']));
  put('Rechnung_Telekom_2026-10.pdf', pdf(['Telekom Deutschland GmbH', 'Ihre Rechnung Oktober 2026', 'Kundennummer: 551234987', 'Rechnungsbetrag: 39,95 EUR']));
  put('Angebot_KhaKeDikha_Catering_Hochzeit.pdf', pdf(['Kha ke dikha Catering', 'Angebot Nr. 2026-014 Hochzeitsbuffet 80 Personen', 'Summe: 2.400,00 EUR']));
  put('Lebenslauf_2026.pdf', pdf(['Lebenslauf', 'Berufserfahrung', 'Ausbildung']));
  put('Arbeitsvertrag_signed.pdf', pdf(['Arbeitsvertrag zwischen Muster GmbH und dem Arbeitnehmer']));
  put('Mietvertrag_Wohnung_Ulm.pdf', pdf(['Mietvertrag ueber Wohnraum', 'Vermieter: Hausverwaltung Ulm']));
  put('HUK_Versicherungsschein.pdf', pdf(['HUK-COBURG Haftpflichtversicherung', 'Versicherungsschein Nr. 123-456789']));
  put('notes.txt', 'Ideas for the weekend: hiking, call Ravi, buy plants.');
  put('meeting-notes.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(200)]));
  const imgs = ['C:\\Windows\\Web\\Wallpaper\\ThemeA\\img20.jpg', 'C:\\Windows\\Web\\Wallpaper\\ThemeA\\img22.jpg', 'C:\\Windows\\Web\\Wallpaper\\ThemeB\\img24.jpg'].filter((f) => fs.existsSync(f));
  imgs.forEach((f, i) => put(`IMG_2025070${i + 1}_1203${i}.jpg`, fs.readFileSync(f), 120));
  if (imgs[0]) put('IMG_20250701_12030 - Copy.jpg', fs.readFileSync(imgs[0]), 10);
  put('PandeshSetup-old.exe', Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4000)]), 200);
  put('drivers-backup.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(3000)]), 90);
  put('big-dataset.zip.crdownload', crypto.randomBytes(5000), 1);
  put('experiment_tokenizer.ipynb', JSON.stringify({ cells: [], nbformat: 4 }));
  put('llama-tiny.gguf', Buffer.concat([Buffer.from('GGUF'), crypto.randomBytes(2000)]));
  put('invoice-renamed.pdf', Buffer.from('<!DOCTYPE html><html><body>Not a PDF</body></html>'));
  put('my-website/.git/HEAD', 'ref: refs/heads/main\n', 2);
  put('my-website/package.json', JSON.stringify({ name: 'my-website', version: '1.0.0' }), 2);
  put('my-website/index.html', '<h1>Hello</h1>', 2);
  put('ComfyUI_models/checkpoints/sd15-demo.safetensors', crypto.randomBytes(1500), 30);
  for (const [i, f] of ['C:\\Windows\\Web\\Screen\\img100.jpg', 'C:\\Windows\\Web\\Screen\\img102.jpg', 'C:\\Windows\\Web\\Screen\\img103.jpg', 'C:\\Windows\\Web\\Wallpaper\\ThemeA\\img21.jpg', 'C:\\Windows\\Web\\Wallpaper\\Spotlight\\img14.jpg'].entries()) {
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(PICS, `photo_${i + 1}.jpg`));
  }
  writeGmailFixture(false);
  log(`test folder ${TEST} (${listTree(TEST).length} files), pictures ${PICS} (${fs.readdirSync(PICS).length}), Gmail fixture ${FIXTURE}`);
}

function gmailMessage(id, threadId, from, subject, receivedAt, bodyText) {
  return { id, threadId, from, to: 'me@example.com', subject, date: receivedAt, receivedAt, snippet: bodyText.slice(0, 120), bodyText, bodyHtml: '', hasAttachments: false, attachments: [] };
}

function writeGmailFixture(withUpdate) {
  const day = (offset) => new Date(Date.now() + offset * 86_400_000);
  const de = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const iso = (d) => d.toISOString();
  const msgs = [
    gmailMessage('m-telekom-oct', 't-telekom-oct', 'Telekom Deutschland GmbH <rechnung@telekom.de>', 'Ihre Telekom Rechnung für Oktober 2026', iso(day(-34)), `Guten Tag,\nIhre Rechnung für Oktober 2026 ist da.\nKundennummer: 551234987\nRechnungsnummer: 2026100045\nRechnungsbetrag: 39,95 € monatlich.\nDer Betrag wird am ${de(day(-24))} per SEPA-Lastschrift von Ihrem Konto abgebucht.`),
    gmailMessage('m-telekom-nov', 't-telekom-nov', 'Telekom Deutschland GmbH <rechnung@telekom.de>', 'Ihre Telekom Rechnung für November 2026', iso(day(-2)), `Guten Tag,\nIhre Rechnung für November 2026 ist da.\nKundennummer: 551234987\nRechnungsnummer: 2026110045\nRechnungsbetrag: 39,95 € monatlich.\nDer Betrag wird am ${de(day(6))} per SEPA-Lastschrift von Ihrem Konto abgebucht.`),
    gmailMessage('m-netflix-paid', 't-netflix-1', 'Netflix <info@mailer.netflix.com>', 'Deine Zahlung wurde verarbeitet', iso(day(-7)), 'Vielen Dank für Ihre Zahlung. Der Betrag von 13,99 € wurde abgebucht. Mitgliedsnummer: NFX-209318'),
    gmailMessage('m-netflix-renew', 't-netflix-2', 'Netflix <info@mailer.netflix.com>', 'Dein Abo verlängert sich bald', iso(day(-1)), `Dein Abonnement verlängert sich am ${de(day(23))}. Preis: 13,99 € monatlich. Mitgliedsnummer: NFX-209318`),
    gmailMessage('m-vodafone-mahnung', 't-vodafone', 'Vodafone Kundenservice <rechnung@vodafone.de>', 'Zahlungserinnerung zu Ihrer Rechnung', iso(day(-3)), `Zahlungserinnerung\nLeider konnten wir den Betrag von 24,99 € noch nicht abbuchen. Kundennummer: 112233445\nBitte überweisen Sie bis zum ${de(day(4))}.`),
    gmailMessage('m-huk', 't-huk', 'HUK-COBURG <service@huk-coburg.de>', 'Ihre Beitragsrechnung 2027', iso(day(-5)), `Beitragsrechnung Haftpflichtversicherung\nVersicherungsschein-Nr.: 123-456789\nJahresbeitrag: 64,20 € jährlich, fällig am ${de(day(58))}.`),
    gmailMessage('m-amazon-ship', 't-amazon', 'Amazon.de <versandbestaetigung@amazon.de>', 'Ihr Paket ist unterwegs', iso(day(-1)), 'Ihr Paket ist unterwegs. Sendungsnummer: DE123456789. Voraussichtliche Zustellung: morgen.'),
    gmailMessage('m-promo', 't-promo', 'StreamPlus Deals <newsletter@streamplus.example>', 'Black Friday: 50% off your subscription!', iso(day(-1)), 'Black Friday sale! Get 50% off your subscription. Unsubscribe here.'),
    gmailMessage('m-arzt', 't-arzt', 'Praxis Dr. Weber <termine@praxis-weber.de>', 'Terminbestätigung', iso(day(-2)), `Terminbestätigung: Ihr Termin am ${de(day(9))} um 10:30 Uhr.`),
  ];
  if (withUpdate) {
    msgs.push(gmailMessage('m-telekom-correction', 't-telekom-corr', 'Telekom Deutschland GmbH <rechnung@telekom.de>', 'Korrektur: geänderter Abbuchungstermin November', iso(day(0)), `Kundennummer: 551234987\nRechnungsbetrag: 39,95 € monatlich.\nDer Betrag wird abweichend am ${de(day(8))} per SEPA-Lastschrift abgebucht.`));
  }
  const threads = Object.fromEntries(msgs.map((m) => [m.threadId, { id: m.threadId, messages: [m] }]));
  fs.writeFileSync(FIXTURE, JSON.stringify({ search: { results: msgs.map(({ bodyText, bodyHtml, ...m }) => ({ ...m, labels: ['INBOX'] })), truncated: false, counts: { matched: msgs.length, matchedIsExact: true, listed: msgs.length, shown: msgs.length } }, threads }, null, 2));
}

function listTree(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const snapshot = (root) => Object.fromEntries(listTree(root).map((f) => [path.relative(root, f), sha(f)]));

// ------------------------------------------------------------------ Core harness

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } }

async function startCore() {
  const prev = readState();
  if (prev && await alive(prev)) { log(`Core already running pid ${prev.pid} port ${prev.port}`); return prev; }
  fs.mkdirSync(DATA, { recursive: true });
  const discovery = path.join(DATA, 'core.json');
  try { fs.unlinkSync(discovery); } catch { /* none */ }
  const out = fs.openSync(path.join(ROOT, 'core.log'), 'a');
  const child = spawn(process.execPath, [path.join(repoRoot, 'out-core', 'core.js')], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: TOKEN, KARKEDIKHA_HOST_TOKEN: HOST_TOKEN, KARKEDIKHA_DATA_DIR: DATA, KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH: FIXTURE, KARKEDIKHA_DEFAULT_MODEL: MODEL, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', out, out], detached: true, windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(discovery)) {
      try {
        const rec = JSON.parse(fs.readFileSync(discovery, 'utf8'));
        const state = { pid: child.pid, port: rec.port, startedAt: new Date().toISOString() };
        fs.writeFileSync(STATE, JSON.stringify(state));
        log(`Core started pid ${child.pid} port ${rec.port}`);
        return state;
      } catch { /* partial */ }
    }
    await sleep(200);
  }
  throw new Error('Core did not start; see core.log');
}

async function alive(state) { try { return (await fetch(`http://127.0.0.1:${state.port}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }

let base;
let keyN = 0;
const H = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': CLIENT, ...extra });
// Host-only household routes are what the Pandesh window calls; the harness presents the host token like the window does.
const HH = (p) => (p.startsWith('/v1/household/') ? { 'X-Host-Token': HOST_TOKEN } : {});
async function api(method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: H({ ...HH(p), ...(method === 'POST' ? { 'Idempotency-Key': `demo-${Date.now()}-${keyN++}` } : {}) }), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 400)}`);
  return json;
}

async function stopCore() {
  const s = readState();
  if (!s) return;
  base = `http://127.0.0.1:${s.port}`;
  try { await api('POST', '/v1/core/shutdown', {}); } catch (e) { log(`shutdown: ${e.message}`); }
  for (let i = 0; i < 50 && await alive(s); i++) await sleep(200);
  fs.rmSync(STATE, { force: true });
  log('Core stopped');
}

async function connect() { const s = await startCore(); base = `http://127.0.0.1:${s.port}`; return s; }

/** Dispatches a governed tool; when it needs approval, approves it as the user and dispatches again. */
async function dispatch(toolName, args, { approve = true, conv = CONV } = {}) {
  const t0 = Date.now();
  let r = await api('POST', '/v1/capabilities/dispatch', { correlationId: conv, toolName, arguments: args, cwd: DATA });
  let approval = null;
  if (r.outcome === 'approval_required') {
    const actions = await api('GET', `/v1/capabilities/actions?correlationId=${encodeURIComponent(conv)}`);
    const action = actions.actions.find((a) => a.actionable && a.approvalId === r.approval.id) ?? actions.actions.find((a) => a.actionable);
    approval = { id: action.approvalId, summary: action.summary ?? r.approval.summary ?? null };
    await api('POST', `/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      resolution: approve ? 'approved' : 'rejected', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
    });
    if (!approve) return { outcome: 'rejected', approval };
    r = await api('POST', '/v1/capabilities/dispatch', { correlationId: conv, toolName, arguments: args, cwd: DATA });
  }
  const inv = r.toolInvocation;
  return { outcome: r.outcome, reason: r.reason, status: inv?.status, output: String(inv?.evidence?.output ?? inv?.evidence?.outputExcerpt ?? ''), evidence: inv?.evidence, approval, ms: Date.now() - t0 };
}

const check = (list, name, ok, detail) => { list.push({ name, ok: Boolean(ok), detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`); };

// ------------------------------------------------------------------ demos

async function inventory() {
  await connect();
  const r = await dispatch('pc_capability_inventory', { refresh: true });
  fs.writeFileSync(path.join(EVID, 'inventory.txt'), r.output);
  const full = await api('GET', '/v1/household/capabilities?refresh=1');
  evidence('inventory', { tool: r, structured: full });
  log(r.output.split('\n').slice(0, 60).join('\n'));
}

async function d1() {
  await connect();
  const checks = [];
  const before = snapshot(TEST);
  const scan = await dispatch('pc_organize_scan', { roots: [TEST], inspectContents: true });
  check(checks, 'scan needed approval and showed the folders and what is read', scan.approval !== null, scan.approval?.summary);
  check(checks, 'scan executed', scan.status === 'succeeded', scan.output.slice(0, 200));
  check(checks, 'scan changed nothing on disk', JSON.stringify(snapshot(TEST)) === JSON.stringify(before));
  const plans = (await api('GET', '/v1/household/overview')).plans;
  const planId = plans[0].id;
  const full = await api('GET', `/v1/household/organization/plans/${planId}?limit=100`);
  fs.writeFileSync(path.join(EVID, 'd1-plan-preview.txt'), full.preview);
  const s = full.plan.summary;
  check(checks, 'tax documents classified (incl. content-only scan_0012.pdf)', /Tax[\\/]2025[\\/]scan_0012\.pdf/.test(full.preview) && /Tax[\\/]2024[\\/]Steuerbescheid/.test(full.preview));
  check(checks, 'career, business, housing, insurance, invoices recognized', ['Career', 'Business', 'Personal[\\\\/]Housing', 'Personal[\\\\/]Insurance', 'Finance[\\\\/]Invoices'].every((d) => new RegExp(d).test(full.preview)));
  check(checks, 'project folder kept whole; model folder protected', /my-website → .*Projects/.test(full.preview) && /ComfyUI_models stays/.test(full.preview));
  check(checks, 'duplicate photo found (copy is the redundant one)', s.duplicates.sets === 1 && /Copy\.jpg/.test(JSON.stringify(s.duplicates.examples[0].copies)));
  check(checks, 'temporary download flagged, not moved', s.temporary.files === 1 && !/crdownload →/.test(full.preview));
  check(checks, 'type mismatch flagged', /invoice-renamed\.pdf is really html/.test(full.preview));
  check(checks, 'ambiguous and mismatched files proposed, not moved', s.ambiguous.examples.some((a) => a.path.endsWith('invoice-renamed.pdf')) && s.ambiguous.count >= 2, s.ambiguous.examples.map((a) => path.basename(a.path)));
  const apply = await dispatch('pc_organize_apply', { planId, saveRules: true });
  check(checks, 'apply needed approval bound to the plan digest', apply.approval !== null && JSON.stringify(apply.approval.summary ?? '').includes(full.plan.digest.slice(0, 12)) || apply.approval !== null, apply.approval?.summary);
  check(checks, 'apply executed', apply.status === 'succeeded', apply.output.slice(0, 300));
  const after = await api('GET', `/v1/household/organization/plans/${planId}?limit=200`);
  const moves = after.preview;
  // Independent verification by the harness: every file that existed before still exists exactly once with the same hash.
  const beforeHashes = Object.values(before).sort();
  const afterSnap = snapshot(TEST);
  check(checks, 'every original file still exists with identical content (no loss, no duplication)', JSON.stringify(Object.values(afterSnap).sort()) === JSON.stringify(beforeHashes), { files: Object.keys(afterSnap).length });
  check(checks, 'files are in the new hierarchy', fs.existsSync(path.join(TEST, 'Tax', '2024', 'Steuerbescheid_2024.pdf')) && fs.existsSync(path.join(TEST, 'Career', 'Lebenslauf_2026.pdf')));
  check(checks, 'project and model folders untouched', fs.existsSync(path.join(TEST, 'my-website', '.git', 'HEAD')) && fs.existsSync(path.join(TEST, 'ComfyUI_models')));
  check(checks, 'temporary + duplicate left in place', fs.existsSync(path.join(TEST, 'big-dataset.zip.crdownload')) && fs.existsSync(path.join(TEST, 'IMG_20250701_12030 - Copy.jpg')));
  const rules = (await api('GET', '/v1/household/overview')).rules;
  check(checks, 'approved destinations saved as rules', rules.length >= 5, rules.map((r) => `${r.category}→${r.destination}`));
  fs.writeFileSync(path.join(EVID, 'd1-after-apply.txt'), `${apply.output}\n\n${moves}\n\nTREE:\n${Object.keys(afterSnap).join('\n')}`);
  const undo = await dispatch('pc_organize_undo', { planId });
  check(checks, 'undo needed approval and executed', undo.approval !== null && undo.status === 'succeeded', undo.output);
  check(checks, 'undo restored the exact original layout and content', JSON.stringify(snapshot(TEST)) === JSON.stringify(before));
  evidence('d1-pc-organization', { planId, checks, scanApproval: scan.approval, applyApproval: apply.approval, applyOutput: apply.output, undoOutput: undo.output });
}

async function d1Chat() {
  await connect();
  const conv = await api('POST', '/v1/conversations', { mode: 'saath_kar' });
  const text = `Pandesh, analyze my PC and propose a complete organization plan for documents, tax records, personal files, employment, projects, AI work, experiments and business records. For this test only look in ${TEST}.`;
  await api('POST', `/v1/conversations/${conv.id}/messages`, { role: 'user', content: text });
  const req = await api('POST', '/v1/requests', { currentMessage: text, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'household-demo', conversationId: conv.id, requestedProvider: 'ollama', requestedModel: MODEL, selectedProvider: 'ollama', selectedModel: MODEL, contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false } });
  const attempt = await api('POST', '/v1/attempts', { requestId: req.id, kind: 'saath_kar', workspaceRoot: DATA });
  const t0 = Date.now();
  await api('POST', `/v1/attempts/${attempt.id}/execute`, { workingDirectory: DATA });
  const checks = [];
  let approved = 0;
  for (;;) {
    const a = await api('GET', `/v1/attempts/${attempt.id}`);
    if (a.status === 'waiting_for_approval') {
      const actions = await api('GET', `/v1/capabilities/actions?correlationId=${encodeURIComponent(conv.id)}`);
      const action = actions.actions.find((x) => x.actionable);
      if (action) {
        log(`model asked for ${action.toolName} ${JSON.stringify(action.summary?.arguments ?? {}).slice(0, 200)}`);
        check(checks, `the model chose a household tool (${action.toolName})`, /^pc_organize_scan$|^pc_capability_inventory$/.test(action.toolName), action.summary?.arguments);
        await api('POST', `/v1/capabilities/approvals/${action.approvalId}/resolve`, { resolution: action.toolName === 'pc_organize_scan' ? 'approved' : 'rejected', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision, expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash });
        approved++;
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(a.status)) {
      const msgs = (await api('GET', `/v1/conversations/${conv.id}/messages`)).messages;
      const reply = msgs.filter((m) => m.role === 'assistant').pop()?.content ?? '';
      const tools = await api('GET', `/v1/attempts/${attempt.id}/tool-invocations`).catch(() => ({}));
      fs.writeFileSync(path.join(EVID, 'd1-chat-reply.md'), reply);
      check(checks, 'attempt completed', a.status === 'completed', a.failureReason);
      check(checks, 'a scan was approved and run', approved >= 1);
      check(checks, 'reply describes the plan (hierarchy and moves)', /Tax|Steuer/i.test(reply) && /move|verschieb/i.test(reply), reply.slice(0, 300));
      check(checks, 'reply says nothing was moved yet', /nothing (has been )?(changed|moved)|not (been )?moved|no files? (were|have been) moved|approv/i.test(reply));
      evidence('d1-chat', { conversationId: conv.id, attemptId: attempt.id, seconds: Math.round((Date.now() - t0) / 1000), model: MODEL, checks, reply, tools });
      return;
    }
    if (Date.now() - t0 > 12 * 60_000) { evidence('d1-chat', { checks, timedOut: true, status: a.status }); throw new Error('chat turn timed out'); }
    await sleep(2000);
  }
}

async function d2Create() {
  await connect();
  const now = new Date(Date.now() + 2 * 60_000 + 30_000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(now).map((p) => [p.type, p.value]));
  const time = `${parts.hour}:${parts.minute}`;
  const r = await dispatch('routine_create', { kind: 'folder_cleanup', title: 'Weekly test-folder cleanup', time, weekdays: [parts.weekday.toLowerCase()], folders: [TEST], maxMovesPerRun: 50 });
  // New files arrive before the run: two match approved rules, one is new to Pandesh.
  fs.writeFileSync(path.join(TEST, 'Rechnung_Stadtwerke_2026-11.pdf'), pdf(['Stadtwerke Ulm', 'Ihre Rechnung November 2026', 'Rechnungsbetrag: 61,00 EUR']));
  fs.copyFileSync('C:\\Windows\\Web\\Screen\\img104.jpg', path.join(TEST, 'IMG_20261102_0815.jpg'));
  fs.writeFileSync(path.join(TEST, 'random-notes-2026.txt'), 'call the plumber');
  const overview = await api('GET', '/v1/household/overview');
  const routine = overview.routines.find((x) => x.title === 'Weekly test-folder cleanup');
  evidence('d2-create', { approval: r.approval, output: r.output, routine, scheduledFor: routine?.nextRunAt });
  log(`routine ${routine?.id} next run ${routine?.nextRunAt} (${time} ${tz}); the real scheduler will fire it`);
}

async function d2Check() {
  await connect();
  const checks = [];
  const overview = await api('GET', '/v1/household/overview');
  const routine = overview.routines.find((x) => x.title === 'Weekly test-folder cleanup');
  const run = routine?.history?.find((h) => h.trigger === 'schedule' || h.trigger === 'catch_up');
  check(checks, 'the scheduler ran the routine (not a manual run)', Boolean(run), run);
  check(checks, 'run succeeded', run?.status === 'succeeded', run?.summary);
  check(checks, 'approved rule moved the new invoice', fs.existsSync(path.join(TEST, 'Finance', 'Invoices', '2026', 'Rechnung_Stadtwerke_2026-11.pdf')));
  check(checks, 'approved rule moved the new photo', fs.existsSync(path.join(TEST, 'Media', 'Photos', '2026', 'IMG_20261102_0815.jpg')));
  check(checks, 'unknown file proposed, not moved', fs.existsSync(path.join(TEST, 'random-notes-2026.txt')));
  check(checks, 'next run is a week later', routine && Date.parse(routine.nextRunAt) - Date.parse(run?.startedAt ?? 0) > 6 * 86_400_000, routine?.nextRunAt);
  evidence('d2-check', { checks, routine });
}

async function d2Restart() {
  const s1 = readState();
  await connect();
  const before = (await api('GET', '/v1/household/overview')).routines.find((x) => x.title === 'Weekly test-folder cleanup');
  await stopCore();
  await connect();
  const s2 = readState();
  const checks = [];
  const after = (await api('GET', '/v1/household/overview')).routines.find((x) => x.title === 'Weekly test-folder cleanup');
  check(checks, 'Core restarted (new process)', s1?.pid !== s2?.pid, { before: s1?.pid, after: s2?.pid });
  check(checks, 'routine persisted with the same schedule and next run', after && after.nextRunAt === before.nextRunAt && after.schedule === before.schedule, after?.schedule);
  check(checks, 'run history persisted', after && after.history.length === before.history.length && after.history.length > 0, after?.history?.map((h) => `${h.trigger}:${h.status}`));
  const manual = await api('POST', `/v1/household/routines/${after.id}/run`, {});
  check(checks, 'routine still runs after restart (manual run)', manual.run?.status === 'succeeded', manual.run?.summary);
  evidence('d2-restart', { checks, before, after, manualRun: manual.run });
}

async function d3(update = false) {
  if (update) writeGmailFixture(true);
  if (update) { await stopCore(); }
  await connect();
  const checks = [];
  const scan = await dispatch('household_scan_obligations', { sources: ['gmail'], lookbackDays: 60 });
  fs.writeFileSync(path.join(EVID, update ? 'd3-rescan.txt' : 'd3-scan.txt'), scan.output);
  check(checks, 'scan needed approval', scan.approval !== null);
  check(checks, 'scan executed', scan.status === 'succeeded', scan.output.slice(0, 200));
  const obs = (await api('GET', '/v1/household/obligations?status=proposed,confirmed,resolved')).obligations;
  const telekom = obs.filter((o) => /telekom/i.test(o.counterparty));
  check(checks, 'two Telekom invoices became ONE record', telekom.length === 1, telekom.map((t) => t.title));
  check(checks, 'Telekom record keeps evidence from each email', telekom[0]?.sourceCount >= 2, telekom[0]?.evidence?.map((e) => e.sourceLabel));
  check(checks, 'Telekom is recurring monthly with the next debit date', telekom[0]?.cadence === 'monthly' && telekom[0]?.dateKind === 'debit', `${telekom[0]?.nextDate} ${telekom[0]?.paymentStatus}`);
  check(checks, 'invoice alone is not called unpaid (due soon / requested)', ['due_soon', 'requested'].includes(telekom[0]?.paymentStatus), telekom[0]?.paymentStatus);
  const vodafone = obs.find((o) => /vodafone/i.test(o.counterparty));
  check(checks, 'reminder letter → possibly overdue', vodafone?.paymentStatus === 'potentially_overdue', vodafone?.paymentStatus);
  const netflix = obs.find((o) => /netflix/i.test(o.counterparty));
  check(checks, 'Netflix: payment confirmation + upcoming renewal → one subscription, renewal not called paid', netflix?.kind === 'subscription' && netflix?.paymentStatus === 'unknown' && netflix?.sourceCount === 2, `${netflix?.kind} ${netflix?.paymentStatus} ${netflix?.nextDate}`);
  check(checks, 'marketing mail ignored', !obs.some((o) => /streamplus/i.test(o.counterparty)));
  check(checks, 'delivery and appointment recognized as non-payable', obs.some((o) => o.kind === 'delivery' && o.paymentStatus === 'not_applicable') && obs.some((o) => o.kind === 'appointment'));
  if (!update) {
    const confirm = await dispatch('household_obligation_update', { obligationId: telekom[0].id, action: 'confirm' });
    check(checks, 'confirm needed approval and executed', confirm.approval !== null && confirm.status === 'succeeded', confirm.output.split('\n')[0]);
    const confirmNetflix = await dispatch('household_obligation_update', { obligationId: netflix.id, action: 'confirm' });
    check(checks, 'Netflix confirmed too', confirmNetflix.status === 'succeeded');
    const again = await dispatch('household_scan_obligations', { sources: ['gmail'], lookbackDays: 60 });
    const obs2 = (await api('GET', '/v1/household/obligations?status=proposed,confirmed,resolved')).obligations;
    check(checks, 'rescanning the same mailbox creates no duplicates', obs2.length === obs.length && obs2.find((o) => o.id === telekom[0].id)?.sourceCount === telekom[0].sourceCount, { before: obs.length, after: obs2.length });
    fs.writeFileSync(path.join(EVID, 'd3-rescan-same.txt'), again.output);
  } else {
    const t = telekom[0];
    check(checks, 'correction email updated the SAME confirmed record (new date, no new record)', t.status === 'confirmed' && t.sourceCount >= 3, `${t.nextDate} sources=${t.sourceCount}`);
  }
  const overview = await api('GET', '/v1/household/overview');
  evidence(update ? 'd3-update' : 'd3-gmail', { checks, obligations: (await api('GET', '/v1/household/obligations?status=proposed,confirmed,resolved')).obligations, companion: overview.companion });
}

async function d4Enable() {
  await connect();
  const st = await api('POST', '/v1/household/companion/settings', { enabled: true, bind: 'loopback' });
  log(JSON.stringify(st));
}
async function d4Disable() { await connect(); log(JSON.stringify(await api('POST', '/v1/household/companion/settings', { enabled: false }))); }
async function d4Code() { await connect(); const c = await api('POST', '/v1/household/companion/pairing-code', {}); fs.writeFileSync(path.join(ROOT, 'pairing-code.txt'), c.code); log(JSON.stringify(c)); }
async function d4Pc() {
  await connect();
  const o = await api('GET', '/v1/household/overview');
  const obs = (await api('GET', '/v1/household/obligations?status=proposed,confirmed,resolved')).obligations;
  log(JSON.stringify({ companion: o.companion, obligations: obs.map((x) => ({ id: x.id, title: x.title, status: x.status, resolution: x.resolution, resolvedBy: x.resolvedBy, nextDate: x.nextDate })) }, null, 2));
  evidence(`d4-pc-${Date.now()}`, { companion: o.companion, obligations: obs });
}

async function d5() {
  await connect();
  const checks = [];
  const out = path.join(ROOT, 'promo-demo.mp4');
  fs.rmSync(out, { force: true }); fs.rmSync(out.replace(/\.mp4$/, '.preview.png'), { force: true });
  const r = await dispatch('media_create_video', { images: [PICS], output: out, title: 'Kha ke dikha — Sample promo', brief: 'a sample promotional slideshow for a small catering business', secondsPerImage: 3, captions: 'auto' });
  fs.writeFileSync(path.join(EVID, 'd5-video.txt'), r.output);
  check(checks, 'needed approval showing the output path', r.approval !== null, r.approval?.summary);
  check(checks, 'Pandesh reports the video verified', r.status === 'succeeded', r.output.split('\n')[0]);
  const ffprobe = (r.output.match(/ffprobe.*?working/) ? null : null);
  // Independent check by the harness with its own ffprobe call.
  const probeBin = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\WinGet\\Packages\" -Recurse -Filter ffprobe.exe | Select-Object -First 1).FullName"], { encoding: 'utf8' }).trim();
  const probe = JSON.parse(execFileSync(probeBin, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height', '-of', 'json', out], { encoding: 'utf8' }));
  check(checks, 'independent ffprobe: h264 1280x720', probe.streams?.[0]?.codec_name === 'h264' && probe.streams?.[0]?.width === 1280 && probe.streams?.[0]?.height === 720, probe.streams?.[0]);
  check(checks, 'independent ffprobe: duration ≈ title + 5×3 s', Math.abs(Number(probe.format.duration) - 17.5) < 1.2, probe.format.duration);
  check(checks, 'at least 3 different tools ran', (r.output.match(/^- (capability inventory|ffprobe|ollama:|ffmpeg|ffprobe \+ ffmpeg)/gm) ?? []).length >= 4);
  check(checks, 'captions written by the local vision model', /\(vision model\)/.test(r.output));
  evidence('d5-media', { checks, output: r.output, file: out, sha256: sha(out), independentProbe: probe, ms: r.ms, unused: ffprobe });
}

async function d6() {
  await connect();
  const checks = [];
  const t0 = Date.now();
  const opts = await dispatch('wish_production_options', {});
  fs.writeFileSync(path.join(EVID, 'd6-options.txt'), opts.output);
  check(checks, 'options computed from the live inventory', opts.status === 'succeeded' && /ACHIEVABLE — Short promotional video/.test(opts.output));
  const out = path.join(ROOT, 'wish-sample-promo.mp4');
  fs.rmSync(out, { force: true }); fs.rmSync(out.replace(/\.mp4$/, '.preview.png'), { force: true });
  const sample = await dispatch('media_create_video', { images: [PICS], output: out, title: 'Sample: your photos here', brief: 'a sample promotional slideshow for a local small business', secondsPerImage: 2.5, captions: 'auto', width: 1080, height: 1920 });
  fs.writeFileSync(path.join(EVID, 'd6-sample.txt'), sample.output);
  const captions = [...sample.output.matchAll(/^- [^:]+: "([^"]*)" \((vision model|file name|given)\)/gm)].map((m) => ({ caption: m[1], source: m[2] }));
  const qc = [
    { name: 'verified by FFprobe (codec, resolution, duration, frame)', ok: sample.status === 'succeeded' },
    { name: 'portrait 1080×1920 for social media', ok: /1080x1920/.test(sample.output) },
    { name: 'every caption non-empty and ≤ 7 words', ok: captions.length > 0 && captions.every((c) => c.caption && c.caption.split(/\s+/).length <= 7) },
    { name: 'no invented prices, allergens or claims in captions', ok: captions.every((c) => !/€|\d+\s?%|vegan|gluten|bio|best|award/i.test(c.caption)) },
  ];
  for (const q of qc) check(checks, `QC: ${q.name}`, q.ok);
  const seconds = Math.round((Date.now() - t0) / 1000);
  evidence('d6-wish', { checks, captions, qc, productionSeconds: seconds, costs: { apiEur: 0, electricityEstimateEur: Math.round((450 * seconds / 3600 / 1000) * 0.35 * 1000) / 1000, basis: '450 W whole-PC draw × measured seconds × €0.35/kWh' }, humanInvolvement: ['client supplies own photos + written permission', 'review every caption', 'decide price; deliver and invoice through the existing Wish-to-Reality order flow'], limitations: ['sample uses Windows stock photos, not a client\'s', 'no music or voice-over', 'demand and price unvalidated — needs real customer conversations'], options: opts.output, sample: sample.output });
}

const cmd = process.argv[2];
const table = {
  setup, start: connect, stop: stopCore, restart: async () => { await stopCore(); await connect(); }, status: async () => log(JSON.stringify(readState())),
  inventory, d1, 'd1-chat': d1Chat, 'd2-create': d2Create, 'd2-check': d2Check, 'd2-restart': d2Restart, d3: () => d3(false), 'd3-update': () => d3(true),
  'd4-enable': d4Enable, 'd4-disable': d4Disable, 'd4-code': d4Code, 'd4-pc': d4Pc, d5, d6,
};
if (!table[cmd]) { console.error(`usage: ${Object.keys(table).join(' | ')}`); process.exit(2); }
Promise.resolve().then(() => table[cmd]()).then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
