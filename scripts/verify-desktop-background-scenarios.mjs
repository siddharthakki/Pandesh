/**
 * PANDESH DESKTOP INTEGRATION VERIFICATION SUITE
 *
 * Verifies real desktop behavior (Electron + Core + Database) using a separate test profile.
 *
 * NOTE: Where live Gmail is unavailable, this test uses a controlled read-only fixture
 * through the real connector/worker boundary and is explicitly labeled as an integration
 * test rather than live Gmail acceptance.
 *
 * Verified Scenarios:
 * 1. Gmail disconnected: truthful failure and blocker reported without false success
 * 2. Start extraction: immediate nonblocking acknowledgment (< 2000ms in real desktop)
 * 3. Ask unrelated questions: chat continues freely while worker is genuinely active
 * 4. Cancel and resume: new attempt allocated upon resume, ledger and task agree
 * 5. Restart and recover: boot reconciliation discovers interrupted task and worker
 *    actually executes to completion from checkpoint without extra prompt
 * 6. Automatic result delivery: verified contract inventory and notification delivered
 *    by actual worker execution (no manual SQLite completion insertion)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const cdpPort = '9666';

// Separate isolated test profile directory
const scratch = path.join(os.tmpdir(), 'pandesh-desktop-eval-' + Date.now());
const dataDir = path.join(scratch, 'desktop-data');
const logPath = path.join(scratch, 'desktop-host.log');
const preservedLogPath = path.join(repoRoot, 'dist', 'desktop-background-scenarios.log');
const fixturePath = path.join(scratch, 'gmail-contract-fixture.json');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(preservedLogPath), { recursive: true });

// Controlled read-only fixture used across real connector boundary
const fixtureData = {
  delayMs: 1200,
  search: {
    results: [
      {
        id: 'msg-lease-101',
        threadId: 'thread-lease-101',
        subject: 'Commercial Office Lease Agreement 2026 - Skyline Properties',
        from: 'leasing@skylineproperties.example',
        date: '2026-10-15',
      },
      {
        id: 'msg-nda-202',
        threadId: 'thread-nda-202',
        subject: 'Mutual Non-Disclosure Agreement - CyberTech Labs',
        from: 'legal@cybertechlabs.example',
        date: '2026-09-01',
      },
      {
        id: 'msg-services-303',
        threadId: 'thread-services-303',
        subject: 'Master Services Agreement - Global Cloud Systems',
        from: 'contracts@globalcloudsystems.example',
        date: '2026-08-20',
      },
    ],
    counts: {
      matched: 3,
      listed: 3,
      matchedIsExact: true,
    },
  },
  threads: {
    'thread-lease-101': {
      id: 'thread-lease-101',
      messages: [
        {
          id: 'msg-lease-101',
          subject: 'Commercial Office Lease Agreement 2026 - Skyline Properties',
          from: 'leasing@skylineproperties.example',
          date: '2026-10-15',
          bodyText: 'Attached is the executed commercial lease agreement for Suite 400.',
          hasAttachments: true,
          attachments: [
            {
              id: 'att-pdf-lease-101',
              filename: 'Skyline_Office_Lease.pdf',
              mimeType: 'application/pdf',
              size: 48200,
            },
          ],
        },
      ],
    },
    'thread-nda-202': {
      id: 'thread-nda-202',
      messages: [
        {
          id: 'msg-nda-202',
          subject: 'Mutual Non-Disclosure Agreement - CyberTech Labs',
          from: 'legal@cybertechlabs.example',
          date: '2026-09-01',
          bodyText: 'Attached is our mutual NDA agreement.',
          hasAttachments: true,
          attachments: [
            {
              id: 'att-pdf-nda-202',
              filename: 'CyberTech_NDA_Signed.pdf',
              mimeType: 'application/pdf',
              size: 32100,
            },
          ],
        },
      ],
    },
    'thread-services-303': {
      id: 'thread-services-303',
      messages: [
        {
          id: 'msg-services-303',
          subject: 'Master Services Agreement - Global Cloud Systems',
          from: 'contracts@globalcloudsystems.example',
          date: '2026-08-20',
          bodyText: 'Please find attached the signed Master Services Agreement.',
          hasAttachments: true,
          attachments: [
            {
              id: 'att-pdf-services-303',
              filename: 'GlobalCloud_MSA.pdf',
              mimeType: 'application/pdf',
              size: 55400,
            },
          ],
        },
      ],
    },
  },
  attachments: {
    'att-pdf-lease-101': {
      filename: 'Skyline_Office_Lease.pdf',
      mimeType: 'application/pdf',
      size: 48200,
      extractedText:
        'COMMERCIAL LEASE AGREEMENT\nLandlord: Skyline Properties Inc.\nTenant: Acme Corporation\nPremises: Suite 400, 100 Main St\nTerm: 3 years starting 2026-11-01\nBase Rent: $4,500.00 per month\nDate of Execution: 2026-10-15\nStatus: Fully Executed and Confirmed',
    },
    'att-pdf-nda-202': {
      filename: 'CyberTech_NDA_Signed.pdf',
      mimeType: 'application/pdf',
      size: 32100,
      extractedText:
        'MUTUAL NON-DISCLOSURE AGREEMENT\nParties: CyberTech Labs and Acme Corporation\nEffective Date: 2026-09-01\nGoverning Law: California\nStatus: Executed NDA',
    },
    'att-pdf-services-303': {
      filename: 'GlobalCloud_MSA.pdf',
      mimeType: 'application/pdf',
      size: 55400,
      extractedText:
        'MASTER SERVICES AGREEMENT\nProvider: Global Cloud Systems LLC\nClient: Acme Corporation\nEffective Date: 2026-08-20\nTerm: 2 years\nValue: $120,000 annually\nStatus: Executed and Active',
    },
  },
};

fs.writeFileSync(fixturePath, JSON.stringify(fixtureData, null, 2), 'utf8');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cdpWs = null;
let cdpNextId = 1;
const cdpPending = new Map();

async function waitFor(label, fn, timeoutMs = 60_000, pollIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms. Last: ${String(last)}`);
}

async function getCdpPage() {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const pages = await res.json();
    return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

async function initCdp() {
  const page = await waitFor('CDP target page', getCdpPage, 60_000);
  cdpWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    cdpWs.once('open', resolve);
    cdpWs.once('error', reject);
  });
  cdpWs.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const pending = cdpPending.get(msg.id);
    if (!pending) return;
    cdpPending.delete(msg.id);
    if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  });
  const enableId = cdpNextId++;
  cdpWs.send(JSON.stringify({ id: enableId, method: 'Runtime.enable', params: {} }));
}

async function cdp(method, params = {}) {
  if (!cdpWs) await initCdp();
  const id = cdpNextId++;
  return new Promise((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpWs.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'CDP evaluate failed');
  }
  return res.result?.value;
}

function openDb() {
  const dbPath = path.join(dataDir, 'core.db');
  return new DatabaseSync(dbPath);
}

function spawnDesktop(extraEnv = {}) {
  const electronBin = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) {
    throw new Error(`Electron binary not found at ${electronBin}`);
  }
  const childEnv = { ...process.env, ...extraEnv };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  return spawn(electronBin, [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...childEnv,
      KARKEDIKHA_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_DATA_DIR: dataDir,
      KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
      KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
      KARKEDIKHA_DESKTOP_NODE: process.execPath,
      KARKEDIKHA_DESKTOP_HOST_LOG: logPath,
      KARKEDIKHA_DESKTOP_CDP_PORT: cdpPort,
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
      ...extraEnv,
    },
    windowsHide: false,
  });
}

function killDesktop(proc) {
  if (cdpWs) {
    try { cdpWs.close(); } catch {}
    cdpWs = null;
  }
  cdpPending.clear();
  try {
    const discoveryPath = path.join(dataDir, 'core.json');
    if (fs.existsSync(discoveryPath)) {
      const rec = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      if (rec?.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(rec.pid)], { stdio: 'ignore' });
      }
    }
  } catch {}
  if (proc?.pid) {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } catch {}
  }
}

async function main() {
  console.log('===============================================================');
  console.log(' PANDESH BACKGROUND TASK INTEGRATION VERIFICATION');
  console.log(' (Controlled Read-Only Connector Fixture Integration Boundary)');
  console.log('===============================================================');
  console.log(`Test Profile: ${dataDir}`);
  console.log(`Host Log:    ${logPath}`);
  console.log(`Test Fixture: ${fixturePath}`);
  console.log('NOTE: Where live Gmail is unavailable, tests run against a controlled');
  console.log('read-only fixture and are labeled as an integration test.\n');

  const results = {
    'Gmail disconnected': 'FAIL',
    'Start extraction': 'FAIL',
    'Ask unrelated questions': 'FAIL',
    'Cancel and resume': 'FAIL',
    'Restart and recover': 'FAIL',
    'Automatic result delivery': 'FAIL',
  };

  let desktopProcess = null;

  try {
    // =========================================================================
    // PHASE 1: Gmail disconnected (Truthful failure / blocker)
    // =========================================================================
    console.log('[1/6] Testing "Gmail disconnected" (no credentials/fixture)...');
    desktopProcess = spawnDesktop({});
    await initCdp();
    await waitFor('Desktop API ready', () => evaluate('Boolean(window.karkedikhaDesktop)'), 60_000);
    await waitFor(
      'Core connected',
      async () => {
        const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        return s?.coreState === 'connected' ? s : null;
      },
      60_000,
    );
    console.log('  ✓ Desktop connected to fresh Core without Gmail integration');

    const dbPath = path.join(dataDir, 'core.db');
    await waitFor('core.db file ready', () => fs.existsSync(dbPath), 10_000);

    const disconnectedPrompt = 'Extract all contracts from my Gmail.';
    const subRes = await evaluate(`(async () => {
      return await window.karkedikhaDesktop.submitTask(${JSON.stringify(disconnectedPrompt)});
    })()`);
    console.log('  Submit response:', JSON.stringify(subRes));

    const db1 = openDb();
    // Wait for the background worker to execute Stage 1 (Gmail search) and detect disconnected Gmail
    console.log('  Waiting for background worker to truthfully fail on disconnected Gmail...');
    await waitFor(
      'Task transition to failed',
      () => {
        const task = db1.prepare("SELECT * FROM background_tasks WHERE taskType = 'gmail_contract_extraction'").get();
        return task && task.status === 'failed' ? task : null;
      },
      30_000,
      500,
    );

    const failedTask = db1.prepare("SELECT * FROM background_tasks WHERE taskType = 'gmail_contract_extraction'").get();
    const failedAttempt = db1.prepare('SELECT * FROM attempts WHERE id = ?').get(failedTask.attemptId);
    const outcome = db1.prepare('SELECT * FROM task_outcomes WHERE attemptId = ?').get(failedTask.attemptId);
    const messages = db1.prepare('SELECT * FROM conversation_messages WHERE conversationId = ?').all(failedTask.conversationId);

    const deliveredFailureMsg = messages.find(
      (m) => m.role === 'assistant' && String(m.content).includes('Gmail contract extraction because the search failed'),
    );
    const noFalseSuccess = !messages.some(
      (m) =>
        String(m.content).includes('No contract documents were found') ||
        String(m.content).includes("I've finished your Gmail contract extraction"),
    );

    console.log(`  Failed Task: status=${failedTask.status}, error=${failedTask.error}`);
    console.log(`  Failed Attempt: status=${failedAttempt?.status}`);
    console.log(`  Task Outcome: status=${outcome?.status}, blocker=${outcome?.blocker}`);
    console.log(`  Delivered Failure Message Found: ${Boolean(deliveredFailureMsg)}`);

    if (failedTask.status === 'failed' && failedAttempt?.status === 'failed' && deliveredFailureMsg && noFalseSuccess) {
      console.log('  ✓ Truthful failure reported without false success');
      results['Gmail disconnected'] = 'PASS';
    } else {
      console.log('  ✗ Gmail disconnected verification failed');
    }
    db1.close();

    // Cleanly shut down disconnected desktop before launching integration fixture
    killDesktop(desktopProcess);
    await sleep(2000);

    // =========================================================================
    // PHASE 2: Integration testing with controlled read-only Gmail fixture
    // =========================================================================
    console.log('\n[2/6] Starting Desktop with controlled read-only connector fixture...');
    desktopProcess = spawnDesktop({ KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH: fixturePath });
    await initCdp();
    await waitFor('Desktop API ready', () => evaluate('Boolean(window.karkedikhaDesktop)'), 60_000);
    await waitFor(
      'Core connected',
      async () => {
        const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        return s?.coreState === 'connected' ? s : null;
      },
      60_000,
    );
    console.log('  ✓ Desktop connected with controlled read-only connector fixture');

    // Create a new conversation for extraction
    await evaluate(`window.karkedikhaDesktop.newConversation()`);
    await sleep(1000);

    console.log('\nTesting "Start extraction" & "Ask unrelated questions"...');
    const startSubmissionTime = Date.now();
    const extractionPrompt = 'Extract all contracts from my Gmail.';

    const submitResult = await evaluate(`(async () => {
      return await window.karkedikhaDesktop.submitTask(${JSON.stringify(extractionPrompt)});
    })()`);
    const ackDuration = Date.now() - startSubmissionTime;
    console.log(`  Immediate submit response (${ackDuration}ms):`, JSON.stringify(submitResult));

    const db2 = openDb();
    const extractionTask = await waitFor('Background task created', () => {
      const t = db2.prepare("SELECT * FROM background_tasks WHERE taskType = 'gmail_contract_extraction' ORDER BY createdAt DESC LIMIT 1").get();
      return t ? t : null;
    }, 10_000);

    console.log(`  ✓ Extraction task created: id=${extractionTask.id}, status=${extractionTask.status}`);
    if (ackDuration < 2000 && extractionTask) {
      results['Start extraction'] = 'PASS';
    }

    // Immediately while the worker is actively running, submit an unrelated math prompt
    console.log('  Submitting unrelated question while extraction worker is genuinely active...');
    await evaluate(`window.karkedikhaDesktop.newConversation()`);
    await sleep(500);

    // Check worker is actively in_progress
    const currentTaskBeforeMath = db2.prepare('SELECT * FROM background_tasks WHERE id = ?').get(extractionTask.id);
    console.log(`  Background worker status before math prompt: ${currentTaskBeforeMath?.status}`);

    const mathPrompt = 'What is 15 * 14? Answer with just the calculation and result.';
    await evaluate(`(async () => {
      return await window.karkedikhaDesktop.submitTask(${JSON.stringify(mathPrompt)});
    })()`);

    // Verify worker status during math turn
    let wasActiveDuringMath = false;
    const mathAnswer = await waitFor(
      'Math answer delivered while worker was active',
      async () => {
        const taskCheck = db2.prepare('SELECT * FROM background_tasks WHERE id = ?').get(extractionTask.id);
        if (taskCheck?.status === 'in_progress') {
          wasActiveDuringMath = true;
        }
        const s = await evaluate('window.karkedikhaDesktop.getSnapshot()');
        if (!s?.running && s?.lastTurnOutcome) {
          const rows = db2.prepare('SELECT * FROM conversation_messages ORDER BY createdAt DESC LIMIT 5').all();
          const assistantMsg = rows.find((r) => r.role === 'assistant');
          if (assistantMsg && String(assistantMsg.content).includes('210')) {
            return assistantMsg.content;
          }
        }
        return null;
      },
      60_000,
      500,
    );

    console.log(`  ✓ Unrelated question answered: "${mathAnswer.slice(0, 60).replace(/\n/g, ' ')}..."`);
    console.log(`  ✓ Worker genuinely active during interactive turn: ${wasActiveDuringMath}`);
    if (wasActiveDuringMath && mathAnswer.includes('210')) {
      results['Ask unrelated questions'] = 'PASS';
    }

    // =========================================================================
    // SCENARIO 4: Cancel and resume
    // =========================================================================
    console.log('\n[3/6] Testing "Cancel and resume"...');
    await evaluate(`window.karkedikhaDesktop.openConversation(${JSON.stringify(extractionTask.conversationId)}, true)`);
    await sleep(1000);

    const initialAttemptId = extractionTask.attemptId;

    // Send "Cancel" from Desktop UI
    console.log('  Submitting "Cancel" from Desktop UI...');
    await evaluate(`(async () => {
      return await window.karkedikhaDesktop.submitTask("Cancel");
    })()`);

    const cancelledTask = await waitFor('Task status cancelled', () => {
      const t = db2.prepare('SELECT * FROM background_tasks WHERE id = ?').get(extractionTask.id);
      return t && t.status === 'cancelled' ? t : null;
    }, 15_000);

    const cancelledAttempt = db2.prepare('SELECT * FROM attempts WHERE id = ?').get(initialAttemptId);
    console.log(`  ✓ Task cancelled: status=${cancelledTask.status}, attempt status=${cancelledAttempt?.status}`);

    // Submit "Continue" from Desktop UI
    console.log('  Submitting "Continue" after cancellation...');
    await evaluate(`(async () => {
      return await window.karkedikhaDesktop.submitTask("Continue");
    })()`);

    // Verify resumption allocated a brand new attempt and synced with ledger
    const resumedTask = await waitFor('New attempt allocated on resume', () => {
      const t = db2.prepare('SELECT * FROM background_tasks WHERE id = ?').get(extractionTask.id);
      return t && t.attemptId !== initialAttemptId && t.status === 'in_progress' ? t : null;
    }, 15_000);

    const newAttemptId = resumedTask.attemptId;
    const oldAttempt = db2.prepare('SELECT * FROM attempts WHERE id = ?').get(initialAttemptId);
    const newAttempt = db2.prepare('SELECT * FROM attempts WHERE id = ?').get(newAttemptId);

    console.log(`  ✓ Resumed task with new attempt: ${newAttemptId}`);
    console.log(`  ✓ Old attempt status in immutable ledger: ${oldAttempt?.status}`);
    console.log(`  ✓ New attempt status in ledger: ${newAttempt?.status}`);

    if (newAttemptId !== initialAttemptId && oldAttempt?.status === 'cancelled' && newAttempt) {
      console.log('  ✓ Cancel -> Continue safely produced valid new attempt and ledger agrees');
      results['Cancel and resume'] = 'PASS';
    }

    // =========================================================================
    // SCENARIO 5: Restart and recover
    // =========================================================================
    console.log('\n[4/6] Testing "Restart and recover"...');
    // Ensure the task is in progress before shutting down
    const beforeRestart = db2.prepare('SELECT * FROM background_tasks WHERE id = ?').get(extractionTask.id);
    console.log(`  Task status before restart: ${beforeRestart?.status}`);

    // Kill desktop while task is in_progress
    console.log('  Shutting down Desktop host while background task is active...');
    killDesktop(desktopProcess);
    db2.close();
    await sleep(2000);

    // Re-launch Desktop host with the EXACT same data directory and fixture
    console.log('  Relaunching Desktop host for restart recovery check...');
    desktopProcess = spawnDesktop({ KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH: fixturePath });
    await initCdp();
    await waitFor('Desktop API ready after restart', () => evaluate('Boolean(window.karkedikhaDesktop)'), 60_000);
    console.log('  ✓ Desktop reconnected after restart');

    const db3 = openDb();
    // Verify that the task was picked up by boot recovery AND actually executes to completion
    // "Do not count a task remaining in_progress or failing as successful restart recovery.
    // Verify actual worker execution, persisted checkpoints, automatic conversation delivery and notification."
    console.log('  Waiting for recovered worker to actually execute to completion...');
    const completedTask = await waitFor(
      'Interrupted task executed to completion after restart',
      () => {
        const t = db3.prepare('SELECT * FROM background_tasks WHERE id = ?').get(extractionTask.id);
        return t && t.status === 'completed' ? t : null;
      },
      45_000,
      1000,
    );

    console.log(`  ✓ Interrupted task completed: status=${completedTask.status}, completedAt=${completedTask.completedAt}`);

    // Verify persisted checkpoints in SQLite
    let taskCheckpoints = [];
    try {
      taskCheckpoints = typeof completedTask.checkpoints === 'string'
        ? JSON.parse(completedTask.checkpoints)
        : (completedTask.checkpoints || []);
    } catch {}

    const attemptCheckpoints = db3
      .prepare('SELECT kind, metadata FROM checkpoints WHERE attemptId = ?')
      .all(completedTask.attemptId);

    console.log(`  ✓ Checkpoints persisted in SQLite (${taskCheckpoints.length} task checkpoints, ${attemptCheckpoints.length} attempt checkpoints):`, taskCheckpoints.map((c) => c.kind).join(', '));

    const hasExpectedCheckpoints =
      taskCheckpoints.some((c) => c.kind === 'thread_inspected') &&
      taskCheckpoints.some((c) => c.kind === 'attachment_read') &&
      taskCheckpoints.some((c) => c.kind === 'task_completed');

    if (completedTask.status === 'completed' && hasExpectedCheckpoints) {
      console.log('  ✓ Restart recovery executed actual worker and persisted checkpoints');
      results['Restart and recover'] = 'PASS';
    } else {
      console.log('  ✗ Restart recovery failed or did not reach completed status');
    }

    // =========================================================================
    // SCENARIO 6: Automatic result delivery
    // =========================================================================
    console.log('\n[5/6] Testing "Automatic result delivery"...');
    // "Do not manually insert task completion or fabricated contract results into SQLite and call it automatic delivery."
    // Verify message was delivered to conversation automatically by the worker:
    const convMessages = db3
      .prepare('SELECT * FROM conversation_messages WHERE conversationId = ? ORDER BY createdAt ASC')
      .all(extractionTask.conversationId);

    const deliveredMessage = convMessages.find(
      (m) =>
        m.role === 'assistant' &&
        String(m.content).includes('Skyline Properties') &&
        String(m.content).includes('CyberTech Labs'),
    );

    // Verify actor attribution in immutable runtime_events ledger
    const workerMessageEvent = db3
      .prepare("SELECT * FROM runtime_events WHERE domain = 'conversation' AND eventType = 'message_appended' AND actor = 'core:background_worker'")
      .get();

    console.log(`  Delivered message found: ${Boolean(deliveredMessage)}`);
    console.log(`  Worker message event recorded: ${Boolean(workerMessageEvent)}`);
    if (deliveredMessage) {
      console.log(`  Delivered message excerpt:\n${deliveredMessage.content.slice(0, 300)}...`);
    }

    const hasResultData = Boolean(completedTask.resultData && completedTask.resultData.includes('Skyline Properties'));

    // Verify desktop notification event emitted
    const completionEvent = db3
      .prepare("SELECT * FROM runtime_events WHERE domain = 'background_task' AND eventType = 'background_task_completed'")
      .get();
    console.log(`  Completion notification event recorded: ${Boolean(completionEvent)}`);

    if (deliveredMessage && workerMessageEvent && hasResultData && completionEvent) {
      console.log('  ✓ Verified contract inventory table delivered automatically into conversation by worker and notification emitted');
      results['Automatic result delivery'] = 'PASS';
    } else {
      console.log('  ✗ Automatic result delivery verification failed');
    }

    db3.close();
  } finally {
    console.log('\n[6/6] Preserving logs and cleaning up...');
    killDesktop(desktopProcess);

    // Preserve actual logs
    if (fs.existsSync(logPath)) {
      try {
        fs.copyFileSync(logPath, preservedLogPath);
        console.log(`  ✓ Preserved actual host logs at: ${preservedLogPath}`);
      } catch (err) {
        console.warn('  Warning: Could not preserve host log:', err);
      }
    }

    // Clean up temporary profile
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }

  // =========================================================================
  // FINAL PASS/FAIL REPORT
  // =========================================================================
  console.log('\n===============================================================');
  console.log(' PANDESH BACKGROUND TASK INTEGRATION EVALUATION REPORT');
  console.log(' (Controlled Read-Only Connector Fixture Integration Boundary)');
  console.log('===============================================================');
  for (const [scenario, status] of Object.entries(results)) {
    console.log(`- ${scenario}: ${status}`);
  }
  console.log('===============================================================\n');

  const allPassed = Object.values(results).every((s) => s === 'PASS');
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
