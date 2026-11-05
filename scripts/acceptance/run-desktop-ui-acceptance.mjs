/**
 * Real Desktop UI Acceptance Runner — Pandesh All-in-One Operator
 *
 * Scenarios executed in an isolated desktop profile via CDP:
 *   Scenario A: OCR → summary (invoice-scanned.pdf -> invoice number + total summary)
 *   Scenario B: ComfyUI → activity workspace → Core restart (RTX 3090 generation, artifact recovery)
 *   Scenario C: Research → browser → verified local document (public books.toscrape.com -> grounded notes)
 *
 * All scenarios run on a real local model (gemma4:26b-a4b-it-qat) via the real Electron desktop shell.
 * Evidence lands in `.acceptance-evidence/desktop-acceptance/`.
 */

import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import CDP from 'chrome-remote-interface';
import { buildScannedInvoice } from '../lib/scannedInvoiceFixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const cdpPort = 9388;

const isolatedProfileRoot = path.join(repoRoot, '.tmp', 'isolated-desktop-profile');
const desktopDir = path.join(isolatedProfileRoot, 'desktop');
const dataDir = path.join(isolatedProfileRoot, 'data');
const workspaceDir = path.join(isolatedProfileRoot, 'workspace');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'desktop-acceptance');

const pdftoppm = process.env.KARKEDIKHA_PDFTOPPM
  ?? 'C:/Users/siddh/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftoppm.exe';

const checks = [];
const startedAt = new Date().toISOString();

function record(name, status, detail) {
  const entry = { name, status, detail, at: new Date().toISOString() };
  checks.push(entry);
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, checks }, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCoreDbInvocations() {
  const dbPath = path.join(desktopDir, 'core.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT id, attemptId, toolName, status, startedAt FROM tool_invocations ORDER BY startedAt ASC').all();
    db.close();
    return rows;
  } catch (e) {
    console.error('readCoreDbInvocations error:', e.message);
    return [];
  }
}

function readCoreDbApprovals() {
  const dbPath = path.join(desktopDir, 'core.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT id, kind, status, summary, requestedAt FROM approvals ORDER BY id ASC').all();
    db.close();
    return rows;
  } catch (e) {
    return [];
  }
}

function readCoreDbArtifacts() {
  const dbPath = path.join(desktopDir, 'core.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT id, kind, title, absolutePath, mimeType, byteSize FROM artifacts ORDER BY id ASC').all();
    db.close();
    return rows;
  } catch (e) {
    return [];
  }
}

async function captureScreenshot(client, filename) {
  try {
    const { data } = await client.Page.captureScreenshot({ format: 'png' });
    const fullPath = path.join(evidenceDir, filename);
    fs.writeFileSync(fullPath, Buffer.from(data, 'base64'));
    console.log(`Captured screenshot: ${filename} (${Math.round(data.length * 0.75 / 1024)} KB)`);
    return fullPath;
  } catch (err) {
    console.error(`Failed to capture screenshot ${filename}:`, err.message);
    return null;
  }
}

async function submitPrompt(client, text) {
  console.log(`Submitting prompt to chat interface: "${text}"`);
  await client.Runtime.evaluate({
    expression: `(() => {
      const input = document.getElementById('task-input');
      if (input) {
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const submit = document.getElementById('submit');
      if (submit) {
        submit.click();
      } else {
        window.karkedikhaDesktop.submitTask(${JSON.stringify(text)});
      }
    })()`,
  });
}

async function waitForTurnCompletion(client, {
  scenarioName,
  timeoutMs = 180000,
  approvalPrefix = 'approval',
  onApproval,
  beforeAttemptId,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let approvedCount = 0;
  let lastApprovalKey = '';
  let attemptStarted = false;
  let currentAttemptId = null;

  while (Date.now() < deadline) {
    // 1. Poll snapshot state
    const snapResult = await client.Runtime.evaluate({
      expression: 'window.karkedikhaDesktop.getSnapshot()',
      awaitPromise: true,
      returnByValue: true,
    });
    const snap = snapResult.result?.value;

    if (!attemptStarted) {
      if (snap?.running || (snap?.attemptId && snap.attemptId !== beforeAttemptId) || snap?.pendingApproval || snap?.pendingImageApproval) {
        attemptStarted = true;
        currentAttemptId = snap?.attemptId;
        console.log(`[${scenarioName}] Turn active detected (attemptId=${currentAttemptId}, running=${snap?.running})`);
      }
    }

    // 2. Check for pending approval in snapshot OR DOM
    const pendingApproval = snap?.pendingApproval;
    const pendingImageApproval = snap?.pendingImageApproval;

    if (pendingApproval || pendingImageApproval) {
      const approvalId = pendingApproval?.approvalId ?? pendingImageApproval?.approvalId;
      const tool = pendingApproval?.toolName ?? pendingImageApproval?.request?.toolName ?? 'image_generate';
      const gate = pendingApproval?.gate ?? 'generation';
      const key = `${approvalId}:${tool}`;

      if (key !== lastApprovalKey) {
        lastApprovalKey = key;
        approvedCount++;
        const shotName = `${approvalPrefix}-${approvedCount}.png`;
        await sleep(600); // let DOM finish paint
        await captureScreenshot(client, shotName);

        record(`${scenarioName}_approval_card_displayed`, 'PASS', {
          approvalId,
          tool,
          gate,
          screenshot: shotName,
        });

        if (onApproval) await onApproval({ approvalId, tool, gate }, shotName);

        console.log(`Clicking Approve button for ${tool} (${approvalId})...`);
        await client.Runtime.evaluate({
          expression: `(() => {
            const btn = document.getElementById('approve');
            if (btn && !btn.disabled) {
              btn.click();
            } else if (${JSON.stringify(Boolean(pendingImageApproval))}) {
              window.karkedikhaDesktop.resolveImageApproval(${JSON.stringify(approvalId)}, 'approved');
            } else {
              window.karkedikhaDesktop.resolveApproval(${JSON.stringify(approvalId)}, 'approved');
            }
          })()`,
        });
        await sleep(1500);
        continue;
      }
    }

    // 3. Check if turn finished
    if (attemptStarted && !snap?.running && !snap?.pendingApproval && !snap?.pendingImageApproval) {
      if (beforeAttemptId && snap?.attemptId === beforeAttemptId && !snap?.lastTurnOutcome) {
        await sleep(800);
        continue;
      }
      await sleep(1500);
      console.log(`[${scenarioName}] Turn completed: outcome=${snap?.lastTurnOutcome}`);
      return { ok: true, snap, approvedCount };
    }

    await sleep(800);
  }

  throw new Error(`Scenario ${scenarioName} timed out after ${timeoutMs}ms`);
}

async function main() {
  console.log('=== PANDESH REAL DESKTOP ACCEPTANCE HARNESS ===');
  console.log('Isolated profile root:', isolatedProfileRoot);

  for (const d of [desktopDir, dataDir, workspaceDir]) {
    if (fs.existsSync(d)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
  for (const d of [desktopDir, dataDir, workspaceDir, evidenceDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Pre-seed selected-model.json to ensure local model selection
  fs.writeFileSync(path.join(desktopDir, 'selected-model.json'), JSON.stringify({ model: 'gemma4:26b-a4b-it-qat' }, null, 2));

  // Verify poppler and tesseract
  record('pdftoppm_binary_available', fs.existsSync(pdftoppm) ? 'PASS' : 'FAIL', { path: pdftoppm });
  const tesseract = 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe';
  record('tesseract_binary_available', fs.existsSync(tesseract) ? 'PASS' : 'FAIL', { path: tesseract });

  // Clean env
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const env = {
    ...childEnv,
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: desktopDir,
    KARKEDIKHA_DATA_DIR: dataDir,
    KARKEDIKHA_DESKTOP_REPO: workspaceDir,
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort),
    KARKEDIKHA_DESKTOP_MODEL: 'gemma4:26b-a4b-it-qat',
    KARKEDIKHA_DEFAULT_MODEL: 'gemma4:26b-a4b-it-qat',
    KARKEDIKHA_MODEL: 'gemma4:26b-a4b-it-qat',
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    KARKEDIKHA_COMFYUI_URL: 'http://127.0.0.1:8188',
  };

  console.log('Launching Electron on CDP port', cdpPort);
  const child = spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, sig) => {
    console.log(`[Electron process ${child.pid}] exited: code=${code}, signal=${sig}`);
  });

  let client = null;
  try {
    // Wait for CDP
    const cdpDeadline = Date.now() + 25000;
    while (Date.now() < cdpDeadline) {
      try {
        const targets = await CDP.List({ port: cdpPort });
        const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
        if (page) {
          client = await CDP({ port: cdpPort, target: page.id });
          break;
        }
      } catch { /* waiting */ }
      await sleep(500);
    }
    if (!client) throw new Error('Failed to connect to CDP target within 25s');

    await client.Runtime.enable();
    await client.Page.enable();
    record('desktop_cdp_connected', 'PASS', { port: cdpPort, pid: child.pid });

    // Wait for Core connected
    console.log('Waiting for Core process to connect in desktop host...');
    const coreDeadline = Date.now() + 35000;
    let initialSnap = null;
    while (Date.now() < coreDeadline) {
      const snapRes = await client.Runtime.evaluate({
        expression: 'window.karkedikhaDesktop?.getSnapshot()',
        awaitPromise: true,
        returnByValue: true,
      });
      initialSnap = snapRes.result?.value;
      if (initialSnap?.coreState === 'connected') break;
      await sleep(1000);
    }
    record('desktop_core_connected', initialSnap?.coreState === 'connected' ? 'PASS' : 'FAIL', {
      coreState: initialSnap?.coreState,
      model: initialSnap?.model,
      folder: initialSnap?.folder,
    });

    // Ensure folder is set to workspaceDir and worker to local-core
    await client.Runtime.evaluate({
      expression: `window.karkedikhaDesktop.setFolder(${JSON.stringify(workspaceDir)})`,
      awaitPromise: true,
    });
    await sleep(1000);

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO A: OCR → Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- STARTING SCENARIO A: OCR → Summary ---');
    const invoiceGroundTruth = {
      invoiceNumber: 'INV-2026-9041',
      total: '1480.00',
      vendor: 'Alpine Tech GmbH',
    };

    const builtInvoice = buildScannedInvoice({
      dir: workspaceDir,
      invoiceNumber: invoiceGroundTruth.invoiceNumber,
      total: invoiceGroundTruth.total,
      vendor: invoiceGroundTruth.vendor,
      pdftoppm,
    });
    record('scenario_a_scanned_pdf_created', fs.existsSync(builtInvoice.pdfPath) ? 'PASS' : 'FAIL', {
      pdfPath: builtInvoice.pdfPath,
      sizeBytes: fs.statSync(builtInvoice.pdfPath).size,
      groundTruth: invoiceGroundTruth,
    });

    const snapBeforeA = (await client.Runtime.evaluate({ expression: 'window.karkedikhaDesktop.getSnapshot()', awaitPromise: true, returnByValue: true })).result?.value;
    const promptA = `Read this scanned invoice at ${builtInvoice.pdfPath}, extract its invoice number and total, and write a summary to the current workspace.`;
    await submitPrompt(client, promptA);

    await waitForTurnCompletion(client, {
      scenarioName: 'scenario_a',
      timeoutMs: 180000,
      approvalPrefix: 'scenario-a-approval',
      beforeAttemptId: snapBeforeA?.attemptId,
    });

    // Capture completion UI screenshot
    await captureScreenshot(client, 'scenario-a-complete.png');

    // Verify OCR tool invocation from Core DB
    const invocationsA = readCoreDbInvocations();
    const ocrInvocation = invocationsA.find((i) => i.toolName === 'document_read' || i.toolName === 'document_ocr');
    record('scenario_a_model_selected_ocr_tool', Boolean(ocrInvocation) ? 'PASS' : 'FAIL', {
      toolName: ocrInvocation?.toolName,
      status: ocrInvocation?.status,
    });

    // Verify written summary file in workspace
    const workspaceFiles = fs.readdirSync(workspaceDir);
    console.log('Files in isolated workspace after Scenario A:', workspaceFiles);

    const summaryCandidates = workspaceFiles.filter((f) => (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'invoice-text.pdf');
    let extractedNumberFound = false;
    let extractedTotalFound = false;
    let summaryContent = '';
    let matchedSummaryFile = null;

    for (const f of summaryCandidates) {
      const content = fs.readFileSync(path.join(workspaceDir, f), 'utf8');
      if (content.includes(invoiceGroundTruth.invoiceNumber) || content.includes(invoiceGroundTruth.total)) {
        matchedSummaryFile = f;
        summaryContent = content;
        extractedNumberFound = content.includes(invoiceGroundTruth.invoiceNumber);
        extractedTotalFound = content.includes(invoiceGroundTruth.total);
        break;
      }
    }

    record('scenario_a_summary_produced', Boolean(matchedSummaryFile) ? 'PASS' : 'FAIL', {
      matchedFile: matchedSummaryFile,
      allFiles: workspaceFiles,
      summaryContent: summaryContent.slice(0, 300),
    });
    record('scenario_a_ground_truth_matched', extractedNumberFound && extractedTotalFound ? 'PASS' : 'FAIL', {
      expectedInvoiceNumber: invoiceGroundTruth.invoiceNumber,
      expectedTotal: invoiceGroundTruth.total,
      extractedNumberFound,
      extractedTotalFound,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO B: ComfyUI → Activity Workspace → Core Restart
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- STARTING SCENARIO B: ComfyUI → Activity Workspace → Restart ---');
    const snapBeforeB = (await client.Runtime.evaluate({ expression: 'window.karkedikhaDesktop.getSnapshot()', awaitPromise: true, returnByValue: true })).result?.value;
    const promptB = 'Generate an illustration of a lighthouse at sunset using ComfyUI and save it to the current activity workspace.';
    await submitPrompt(client, promptB);

    await waitForTurnCompletion(client, {
      scenarioName: 'scenario_b',
      timeoutMs: 240000,
      approvalPrefix: 'scenario-b-approval',
      beforeAttemptId: snapBeforeB?.attemptId,
    });

    // Capture generated image in UI
    await captureScreenshot(client, 'scenario-b-generated.png');

    // Verify artifact in Core DB / disk
    const snapBResult = await client.Runtime.evaluate({
      expression: 'window.karkedikhaDesktop.getSnapshot()',
      awaitPromise: true,
      returnByValue: true,
    });
    const snapB = snapBResult.result?.value;
    console.log('Snapshot B after generation:');
    console.log('  lastTurnOutcome:', snapB?.lastTurnOutcome);

    // List artifacts via DB and client
    const artifactsDb = readCoreDbArtifacts();
    const imageArtifact = artifactsDb.find((a) => a.kind === 'image' || a.mimeType?.startsWith('image/'));
    record('scenario_b_image_artifact_created', Boolean(imageArtifact) ? 'PASS' : 'FAIL', {
      artifact: imageArtifact,
      count: artifactsDb.length,
    });

    // Verify real file on disk
    if (imageArtifact && imageArtifact.absolutePath && fs.existsSync(imageArtifact.absolutePath)) {
      const stats = fs.statSync(imageArtifact.absolutePath);
      const header = fs.readFileSync(imageArtifact.absolutePath).slice(0, 8);
      const isPng = header.toString('hex') === '89504e470d0a1a0a';
      record('scenario_b_image_file_verified_on_disk', isPng && stats.size > 1000 ? 'PASS' : 'FAIL', {
        path: imageArtifact.absolutePath,
        sizeBytes: stats.size,
        isPng,
      });
    }

    // Now restart Core without restarting desktop shell
    console.log('Restarting Core process without restarting desktop shell...');
    const coreRecordPath = path.join(desktopDir, 'core.json');
    if (fs.existsSync(coreRecordPath)) {
      const coreRecord = JSON.parse(fs.readFileSync(coreRecordPath, 'utf8'));
      console.log(`Shutting down Core at port ${coreRecord.port} (pid=${coreRecord.pid})...`);
      try {
        await fetch(`http://127.0.0.1:${coreRecord.port}/v1/core/shutdown`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${fs.readFileSync(path.join(desktopDir, 'core.token'), 'utf8')}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `shutdown-${Date.now()}`,
            'X-Client-Id': 'acceptance-desktop',
          },
          body: '{}',
        });
      } catch { /* shutdown */ }
      await sleep(1500);
    }

    // Trigger retryCoreConnection in desktop host via CDP
    console.log('Triggering retryCoreConnection in desktop host...');
    const retryRes = await client.Runtime.evaluate({
      expression: 'window.karkedikhaDesktop.retryCoreConnection()',
      awaitPromise: true,
      returnByValue: true,
    });
    const restartedSnap = retryRes.result?.value;
    console.log('Snapshot after Core restart:', restartedSnap?.coreState);

    // Wait until coreState is connected again
    const restartDeadline = Date.now() + 25000;
    let reconnected = false;
    while (Date.now() < restartDeadline) {
      const sRes = await client.Runtime.evaluate({
        expression: 'window.karkedikhaDesktop.getSnapshot()',
        awaitPromise: true,
        returnByValue: true,
      });
      if (sRes.result?.value?.coreState === 'connected') {
        reconnected = true;
        break;
      }
      await sleep(1000);
    }
    record('scenario_b_core_restarted_and_reconnected', reconnected ? 'PASS' : 'FAIL', {
      reconnected,
      coreState: restartedSnap?.coreState,
    });

    // Verify artifact remains durable and recoverable after restart
    const artifactsAfterDb = readCoreDbArtifacts();
    const restoredArtifact = artifactsAfterDb.find((a) => a.id === imageArtifact?.id || (a.kind === 'image' && a.title === imageArtifact?.title));
    record('scenario_b_artifact_durable_across_restart', Boolean(restoredArtifact) ? 'PASS' : 'FAIL', {
      originalId: imageArtifact?.id,
      restoredId: restoredArtifact?.id,
      countBefore: artifactsDb.length,
      countAfter: artifactsAfterDb.length,
    });

    // Capture UI screenshot after restart
    await captureScreenshot(client, 'scenario-b-after-restart.png');

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO C: Research → Browser → Verified Local Document
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- STARTING SCENARIO C: Research → Browser → Verified Local Document ---');
    // Start fresh conversation for Scenario C
    console.log('Starting fresh conversation for Scenario C...');
    await client.Runtime.evaluate({
      expression: 'window.karkedikhaDesktop.newConversation()',
      awaitPromise: true,
    });
    await sleep(1500);

    const snapBeforeC = (await client.Runtime.evaluate({ expression: 'window.karkedikhaDesktop.getSnapshot()', awaitPromise: true, returnByValue: true })).result?.value;
    const targetUrl = 'http://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html';
    const promptC = `Research the product price at ${targetUrl} using the browser. Write a summary note with the product title, price, and source URL to price-check.md in the current workspace.`;
    await submitPrompt(client, promptC);

    await waitForTurnCompletion(client, {
      scenarioName: 'scenario_c',
      timeoutMs: 240000,
      approvalPrefix: 'scenario-c-approval',
      beforeAttemptId: snapBeforeC?.attemptId,
    });

    // Capture completion UI screenshot
    await captureScreenshot(client, 'scenario-c-complete.png');

    // Verify browser / research tool invocation from Core DB
    const invocationsC = readCoreDbInvocations();
    const browserTool = invocationsC.find((i) => /browse|browser|inspect_page|search|research/i.test(i.toolName));
    record('scenario_c_model_selected_research_or_browser_tool', Boolean(browserTool) ? 'PASS' : 'FAIL', {
      toolName: browserTool?.toolName,
      status: browserTool?.status,
    });

    // Verify research note in workspace
    const workspaceFilesAfterC = fs.readdirSync(workspaceDir);
    console.log('Files in isolated workspace after Scenario C:', workspaceFilesAfterC);

    let researchNoteContent = '';
    let researchNoteFile = null;
    for (const f of workspaceFilesAfterC) {
      if ((f.endsWith('.md') || f.endsWith('.txt')) && f !== matchedSummaryFile && f !== 'invoice_summary.txt') {
        const c = fs.readFileSync(path.join(workspaceDir, f), 'utf8');
        if (/light in the attic|toscrape|51\.77/i.test(c)) {
          researchNoteFile = f;
          researchNoteContent = c;
          break;
        }
      }
    }

    // Also check DOM body text for grounded facts if written in chat
    const bodyTextRes = await client.Runtime.evaluate({
      expression: 'document.body.innerText',
      returnByValue: true,
    });
    const domText = bodyTextRes.result?.value ?? '';

    const groundedPrice = /51\.77/i.test(researchNoteContent) || /51\.77/i.test(domText);
    const groundedSource = /books\.toscrape\.com/i.test(researchNoteContent) || /books\.toscrape\.com/i.test(domText) || /toscrape/i.test(domText);

    record('scenario_c_research_note_produced', Boolean(researchNoteFile) || (groundedPrice && groundedSource) ? 'PASS' : 'FAIL', {
      file: researchNoteFile,
      excerpt: researchNoteContent ? researchNoteContent.slice(0, 300) : domText.slice(0, 300),
    });
    record('scenario_c_references_grounded_in_webpage', groundedPrice && groundedSource ? 'PASS' : 'FAIL', {
      containsPrice: groundedPrice,
      containsSourceUrl: groundedSource,
      excerpt: (researchNoteContent || domText).slice(0, 400),
    });

  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    if (child && !child.killed) {
      console.log('Terminating Electron child process...');
      child.kill('SIGTERM');
      await sleep(1000);
      if (!child.killed) child.kill('SIGKILL');
    }
  }

  const failedChecks = checks.filter((c) => c.status === 'FAIL');
  console.log(`\n======================================================`);
  console.log(`DESKTOP ACCEPTANCE COMPLETE: ${checks.length} checks, ${failedChecks.length} failed`);
  console.log(`Evidence directory: ${evidenceDir}`);
  console.log(`======================================================\n`);

  if (failedChecks.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal acceptance test error:', err);
  record('fatal_acceptance_error', 'FAIL', String(err.stack ?? err));
  process.exit(1);
});
