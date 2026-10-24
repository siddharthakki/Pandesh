/**
 * Google connection check after a real application restart.
 *
 * This uses the account the operator has ALREADY authorized. It never opens
 * a browser, never asks for a token, never prints a credential, and never
 * sends, drafts or deletes anything: the only calls are two read-tier
 * connector tools (`gmail_search` and `calendar_list_events`).
 *
 * What it reports:
 *   - the connector's live state and the real reason when a read failed,
 *   - the account the Core is using (an address, not a secret),
 *   - the scope names Google actually granted, so a missing scope is visible
 *     instead of mysterious,
 *   - what the read actually returned, counted and summarised.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-google-after-restart.mjs [cdpPort]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const cdpPort = process.argv[2] || process.env.PANDESH_GOOGLE_CDP_PORT || '9401';
const evidenceDir = path.join(repoRoot, 'dist', 'pandesh-acceptance');
const steps = [];

function record(step, detail) {
  steps.push({ at: new Date().toISOString(), step, ...detail });
  console.log(`[${step}] ${detail.summary ?? ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cdpSocket;
let cdpId = 1;
const cdpPending = new Map();

async function cdp(method, params = {}) {
  const id = cdpId++;
  return new Promise((resolve, reject) => {
    cdpPending.set(id, { resolve, reject });
    cdpSocket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result?.value;
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) });
  const pages = await res.json();
  const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!page) throw new Error(`no renderer on CDP ${cdpPort}`);
  cdpSocket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    cdpSocket.once('open', resolve);
    cdpSocket.once('error', reject);
  });
  cdpSocket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const pending = cdpPending.get(message.id);
    if (!pending) return;
    cdpPending.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  });
  await cdp('Runtime.enable');

  // ── 1. the connection state after the restart ──────────────────────────
  const status = await evaluate(`(async () => {
    const snapshot = await window.karkedikhaDesktop.getSnapshot();
    return {
      coreState: snapshot?.coreState,
      gmail: snapshot?.gmail ?? null,
    };
  })()`);
  record('connection-state', {
    summary: `core ${status?.coreState}; Gmail connected: ${status?.gmail?.connected}, verified: ${status?.gmail?.verified}`
      + `${status?.gmail?.capabilityBlocker ? ` — capability blocker: ${status.gmail.capabilityBlocker}` : ''}`
      + `${status?.gmail?.configBlocker ? ` — setup blocker: ${status.gmail.configBlocker}` : ''}`
      + `${status?.gmail?.lastError ? ` — last error: ${status.gmail.lastError}` : ''}`,
    coreState: status?.coreState,
    gmail: status?.gmail ?? null,
  });
  if (status?.gmail?.accountEmail) {
    record('account', { summary: `the authorized account is ${status.gmail.accountEmail}`, accountEmail: status.gmail.accountEmail });
  }
  if (status?.gmail?.calendarAccess) {
    record('calendar-scope', {
      summary: `the live token's calendar scope: ${status.gmail.calendarAccess}`,
      calendarAccess: status.gmail.calendarAccess,
    });
  }
  if (status?.gmail?.clientSource) {
    record('oauth-client', {
      summary: `the OAuth client comes from: ${status.gmail.clientSource}${status.gmail.clientHint ? ` (${status.gmail.clientHint})` : ''}`,
      clientSource: status.gmail.clientSource,
      clientHint: status.gmail.clientHint ?? null,
    });
  }

  // ── 2. a read-only Gmail search ────────────────────────────────────────
  const gmail = await evaluate(`(async () => {
    try {
      const result = await window.karkedikhaDesktop.dispatchGmailAction('gmail_search', { query: 'in:inbox', maxResults: 3 });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  })()`);
  const gmailOutput = gmail?.result?.outcome === 'executed' ? String(gmail.result.output ?? '') : '';
  record('gmail-read', {
    summary: gmail?.ok
      ? `gmail_search ${gmail.result?.outcome}: ${gmailOutput.slice(0, 160) || '(no output)'}`
      : `gmail_search failed: ${gmail?.error}`,
    ok: gmail?.ok,
    outcome: gmail?.result?.outcome ?? null,
    error: gmail?.error ?? gmail?.result?.reason ?? null,
    output: gmailOutput.slice(0, 900) || null,
  });

  // ── 3. a read-only calendar listing, straight from the live Core ──────
  // The desktop's Gmail surface deliberately only exposes Gmail actions, so
  // the calendar is checked through Core's own governed dispatch route with
  // the Core's own bearer token. The token is read from the local data
  // directory and never printed.
  const liveDataDir = process.env.PANDESH_LIVE_DATA_DIR
    ?? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'KarkeDikha', 'desktop');
  const discovery = JSON.parse(fs.readFileSync(path.join(liveDataDir, 'core.json'), 'utf8'));
  const coreToken = fs.readFileSync(path.join(liveDataDir, 'core.token'), 'utf8').trim();
  const calendarResponse = await fetch(`http://127.0.0.1:${discovery.port}/v1/capabilities/dispatch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${coreToken}`,
      'x-client-id': 'acceptance:google-check',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      correlationId: `acceptance-calendar-${Date.now()}`,
      toolName: 'calendar_list_events',
      arguments: {
        from: new Date().toISOString().slice(0, 10),
        to: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        maxResults: 5,
      },
      cwd: liveDataDir,
    }),
  });
  const calendarBody = await calendarResponse.json();
  const calendarOutput = calendarBody?.toolInvocation?.evidence?.output
    ? String(calendarBody.toolInvocation.evidence.output)
    : '';
  record('calendar-read', {
    summary: `calendar_list_events ${calendarBody?.outcome}: ${calendarOutput.slice(0, 160) || (calendarBody?.reason ?? 'no output')}`,
    ok: calendarBody?.outcome === 'executed',
    outcome: calendarBody?.outcome ?? null,
    error: calendarBody?.reason ?? null,
    output: calendarOutput.slice(0, 900) || null,
  });

  const evidence = {
    finishedAt: new Date().toISOString(),
    cdpPort,
    steps,
    gmailConnected: status?.gmail?.connected === true,
    gmailVerified: status?.gmail?.verified === true,
    gmailReadOk: gmail?.ok === true && gmail?.result?.outcome === 'executed',
    calendarReadOk: calendarBody?.outcome === 'executed',
  };
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const evidencePath = path.join(evidenceDir, `google-after-restart-${runId}.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence: ${path.relative(repoRoot, evidencePath)}`);
  console.log(`GMAIL: ${evidence.gmailReadOk ? 'readable' : 'not readable'} · CALENDAR: ${evidence.calendarReadOk ? 'readable' : 'not readable'}`);
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  console.error(`\nGOOGLE CHECK: FAIL — ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(failure ? 1 : 0);
