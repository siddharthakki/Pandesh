/**
 * AW2 — "Local media out to the phone", against the real Core and the real
 * ComfyUI.
 *
 * The request (verbatim):
 *   "Generate a 1024x1024 illustration of a lighthouse at sunset using the
 *    local checkpoint, then send a one-line summary and the saved image path
 *    to my paired phone."
 *
 * What is real here:
 *   - the Core process, its governed capability registry and approval gate,
 *   - the installed ComfyUI service, its checkpoints and its render,
 *   - the PNG bytes on disk and their SHA-256,
 *   - the opt-in companion listener, its TLS certificate, pairing, sealed
 *     envelopes, revision log and acknowledgement ledger,
 *   - a genuine Core restart between generation and delivery.
 *
 * What is NOT the real JUGAAD Android app: no JUGAAD APK exists in this
 * repository or on this machine. The phone is represented by a
 * protocol-faithful paired client: it performs the real PBKDF2 pairing, pins
 * the certificate the TLS socket actually presented, seals and opens the same
 * AES-256-GCM envelopes, pulls the record and pushes an acknowledgement. That
 * proves the Core side of delivery and acknowledged receipt; it does not prove
 * an Android screen rendered it. The limitation is recorded in the evidence.
 *
 * Evidence lands in `.acceptance-evidence/aw2-companion-delivery/`.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'aw2-companion-delivery');
const runRoot = process.env.PANDESH_AW2_ROOT ?? path.join(repoRoot, '.tmp', `aw2-companion-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const token = 'aw2-companion-acceptance-token';
const hostToken = 'aw2-companion-acceptance-host-token';

const checks = [];
const startedAt = new Date().toISOString();
const requestText = 'Generate a 1024x1024 illustration of a lighthouse at sunset using the local checkpoint, then send a one-line summary and the saved image path to my paired phone.';
let elapsedMs = null;

function record(name, status, detail) {
  checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}`}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ requestText, startedAt, checks }, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

async function startCore() {
  const logPath = path.join(runRoot, 'core-stdout.log');
  fs.mkdirSync(runRoot, { recursive: true });
  const out = fs.openSync(logPath, 'a');
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_HOST_TOKEN: hostToken, KARKEDIKHA_DATA_DIR: dataDir },
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
    throw new Error(`the Core did not publish its discovery record within 30s:\n${log.slice(-1500)}`);
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
        'X-Client-Id': 'aw2-companion-acceptance',
      },
      body: '{}',
    });
  } catch { /* already gone */ }
  await sleep(700);
  if (child && !child.killed) child.kill();
  child = null;
  await sleep(500);
}

async function api(port, method, urlPath, body, { auth = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(urlPath.startsWith('/v1/household/') ? { 'X-Host-Token': hostToken } : {}),
      'X-Client-Id': 'aw2-companion-acceptance',
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
async function dispatch(port, toolName, args, { approve = true, cwd = runRoot } = {}) {
  const correlationId = `aw2-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

// ------------------------------------------------------------------ the paired client
/** POST over HTTPS. `pin` = expected certificate SHA-256 (hex); null accepts any certificate (pairing only) and reports it. */
function companionPost(port, urlPath, body, pin) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10_000, rejectUnauthorized: false,
    }, (res) => {
      const fp = res.socket.getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase();
      if (pin && fp !== pin) { res.destroy(); reject(new Error(`certificate ${fp.slice(0, 16)} is not the pinned ${pin.slice(0, 16)}`)); return; }
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch { json = text; } resolve({ status: res.statusCode, json, fingerprint: fp }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const gcmSeal = (key, aad, text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  return { iv: iv.toString('base64'), ct: Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64') };
};
const gcmOpen = (key, aad, env) => {
  const raw = Buffer.from(env.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
};
const sealedCall = (devKey, deviceId, method, params) => ({
  d: deviceId,
  ...gcmSeal(devKey, deviceId, JSON.stringify({ method, params, ts: Date.now(), nonce: crypto.randomBytes(12).toString('base64url') })),
});

async function phoneRpc(port, pin, devKey, deviceId, method, params) {
  const response = await companionPost(port, '/companion/v1/rpc', sealedCall(devKey, deviceId, method, params), pin);
  if (response.status !== 200) return { status: response.status, error: response.json?.error, fingerprint: response.fingerprint };
  return { status: 200, result: JSON.parse(gcmOpen(devKey, `${deviceId}:resp`, response.json.sealed)), fingerprint: response.fingerprint };
}

async function companionReady() {
  for (let i = 0; i < 80; i++) {
    const c = (await api(portNow, 'GET', '/v1/household/overview')).body?.companion;
    if (c?.listening || (!c?.starting && c?.error)) return c;
    await sleep(250);
  }
  return (await api(portNow, 'GET', '/v1/household/overview')).body?.companion;
}

let portNow = 0;

function isPng(bytes) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const began = Date.now();

  // ---- ComfyUI must actually be there ------------------------------------
  const comfyUrl = process.env.KARKEDIKHA_COMFYUI_URL ?? 'http://127.0.0.1:8188';
  let comfyStats;
  try {
    comfyStats = await (await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(5000) })).json();
  } catch (error) {
    record('comfyui_reachable', 'BLOCKED', `ComfyUI is not answering at ${comfyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  record('comfyui_reachable', 'PASS', { version: comfyStats?.system?.comfyui_version });

  // ---- 1. Core, first life, and the companion listener -------------------
  const first = await startCore();
  portNow = first.port;
  record('core_started', 'PASS', { port: first.port, instanceId: first.instanceId });

  const enable = await api(first.port, 'POST', '/v1/household/companion/settings', { enabled: true, bind: 'loopback' });
  const companion = await companionReady();
  record('companion_listener_started', companion?.listening && companion?.transport === 'https' ? 'PASS' : 'FAIL', {
    listening: companion?.listening, transport: companion?.transport, vaultOpen: companion?.vaultOpen,
    keyProtection: companion?.keyProtection, certificateFingerprint: companion?.certificateFingerprint,
    enableStatus: enable.status,
  });
  if (!companion?.listening) return;

  // Pair the test device exactly as a phone would.
  const code = await api(first.port, 'POST', '/v1/household/companion/pairing-code', {});
  const deviceId = `aw2-phone-${Date.now()}`;
  const salt = crypto.randomBytes(16);
  const pairingKey = crypto.pbkdf2Sync(Buffer.from(code.body.code), salt, 120_000, 32, 'sha256');
  const proof = crypto.createHmac('sha256', pairingKey).update(`pandesh-pair:${deviceId}`).digest();
  const paired = await companionPost(code.body.port, '/companion/v1/pair', {
    deviceId, label: 'AW2 isolated paired phone', salt: salt.toString('base64'), proof: proof.toString('base64'),
  }, null);
  let opened = null;
  if (paired.status === 200 && paired.json?.sealedKey) {
    opened = JSON.parse(gcmOpen(pairingKey, `${deviceId}:pair`, paired.json.sealedKey));
  }
  const deviceKey = opened ? Buffer.from(opened.deviceKey, 'base64') : Buffer.alloc(0);
  record('phone_paired_over_pinned_tls', paired.status === 200 && opened?.tlsFingerprint === paired.fingerprint && deviceKey.length === 32 ? 'PASS' : 'FAIL', {
    status: paired.status,
    tlsFingerprintMatchesSealedReply: opened?.tlsFingerprint === paired.fingerprint,
    pairedReplyNamesPc: typeof opened?.pc === 'string',
    pairingCodeReturnedPort: code.body?.port,
  });
  if (!opened) return;
  const pin = opened.tlsFingerprint;

  const hello = await phoneRpc(code.body.port, pin, deviceKey, deviceId, 'hello', {});
  record('paired_phone_can_call', hello.status === 200 && hello.result?.ok === true ? 'PASS' : 'FAIL', {
    status: hello.status, pc: hello.result?.result?.pc, latestRevision: hello.result?.result?.latestRevision,
  });

  // An unpaired device must be refused before it can read anything.
  const strangerId = `aw2-stranger-${Date.now()}`;
  const stranger = await phoneRpc(code.body.port, pin, crypto.randomBytes(32), strangerId, 'hello', {});
  record('unpaired_device_refused', stranger.status === 401 ? 'PASS' : 'FAIL', { status: stranger.status, error: stranger.error });

  // ---- 2. discover the real checkpoints ----------------------------------
  const status = await dispatch(first.port, 'comfyui_status', {});
  const statusOutput = status.body?.toolInvocation?.evidence?.output;
  const checkpointInfo = statusOutput ? JSON.parse(statusOutput) : {};
  const checkpoints = Array.isArray(checkpointInfo.checkpoints) ? checkpointInfo.checkpoints : [];
  record('checkpoints_discovered', checkpoints.length > 0 ? 'PASS' : 'FAIL', { count: checkpoints.length, first: checkpoints[0] });
  if (!checkpoints.length) return;

  // ---- 3. generate the actual picture ------------------------------------
  const prompt = 'a red lighthouse on a rocky coast at sunset, cinematic light';
  const generationStarted = Date.now();
  const generated = await dispatch(first.port, 'comfyui_generate_image', {
    prompt, checkpoint: checkpoints[0], width: 1024, height: 1024, steps: 8,
  });
  const generationSeconds = Math.round((Date.now() - generationStarted) / 1000);
  const generatedOutput = generated.body?.toolInvocation?.evidence?.output;
  const image = generatedOutput ? JSON.parse(generatedOutput) : {};
  record('image_generated_through_comfyui', generated.body?.outcome === 'executed' && image.artifactIds?.length > 0 ? 'PASS' : 'FAIL', {
    outcome: generated.body?.outcome, artifactIds: image.artifactIds, promptId: image.promptId,
    checkpoint: image.checkpoint, width: image.width, height: image.height,
    generationSeconds, reason: generated.body?.reason,
  });
  if (!image.artifactIds?.length) return;

  // ---- 4. the artifact is a real PNG on disk, and private without auth ---
  const artifact = await api(first.port, 'GET', `/v1/artifacts/${encodeURIComponent(image.artifactIds[0])}`);
  const artifactRecord = artifact.body;
  const imagePath = artifactRecord?.absolutePath;
  const bytes = imagePath && fs.existsSync(imagePath) ? fs.readFileSync(imagePath) : Buffer.alloc(0);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  record('artifact_is_a_real_png', isPng(bytes) && bytes.length > 1000 && digest === artifactRecord?.sha256 ? 'PASS' : 'FAIL', {
    artifactId: image.artifactIds[0], path: imagePath, bytes: bytes.length, sha256: digest, sha256Matches: digest === artifactRecord?.sha256, availability: artifactRecord?.availability,
  });
  const unauthorized = await api(first.port, 'GET', `/v1/artifacts/${encodeURIComponent(image.artifactIds[0])}`, undefined, { auth: false });
  record('artifact_refused_without_authorization', unauthorized.status === 401 || unauthorized.status === 403 ? 'PASS' : 'FAIL', { status: unauthorized.status });

  // ---- 5. a genuine Core restart, then the same bytes --------------------
  await stopCore(first.port);
  const second = await startCore();
  portNow = second.port;
  const afterRestart = await api(second.port, 'GET', `/v1/artifacts/${encodeURIComponent(image.artifactIds[0])}`);
  const afterPath = afterRestart.body?.absolutePath;
  const afterBytes = afterPath && fs.existsSync(afterPath) ? fs.readFileSync(afterPath) : Buffer.alloc(0);
  const afterDigest = crypto.createHash('sha256').update(afterBytes).digest('hex');
  record('artifact_survives_core_restart', afterRestart.body?.availability === 'ready' && afterDigest === digest && afterPath === imagePath ? 'PASS' : 'FAIL', {
    before: { path: imagePath, sha256: digest }, after: { path: afterPath, sha256: afterDigest, availability: afterRestart.body?.availability },
  });

  // ---- 6. the summary and the saved path go to the paired phone ----------
  const oneLine = `Local ComfyUI ${image.width || 1024}x${image.height || 1024} lighthouse at sunset, saved at ${imagePath} (sha256 ${digest.slice(0, 16)}…).`;
  const sent = await dispatch(second.port, 'jugaad_send', {
    kind: 'note', title: 'Lighthouse at sunset', text: oneLine, ref: imagePath,
  });
  const sendOutput = sent.body?.toolInvocation?.evidence?.output ?? '';
  record('summary_queued_for_phone', sent.body?.outcome === 'executed' && /Queued for the phone/.test(sendOutput) ? 'PASS' : 'FAIL', {
    outcome: sent.body?.outcome, output: sendOutput, toolInvocationId: sent.body?.toolInvocation?.id,
  });

  // ---- 7. another restart: the record and the paired key must survive ----
  await stopCore(second.port);
  const third = await startCore();
  portNow = third.port;
  const companionAfter = await companionReady();
  record('companion_listener_returns_after_restart', companionAfter?.listening && companionAfter?.certificateFingerprint === companion?.certificateFingerprint ? 'PASS' : 'FAIL', {
    listening: companionAfter?.listening, certificateFingerprint: companionAfter?.certificateFingerprint,
  });

  const pull = await phoneRpc(code.body.port, pin, deviceKey, deviceId, 'pull', { since: 0, limit: 200 });
  const pulled = pull.result?.result?.records ?? [];
  const delivered = pulled.find((r) => r.kind === 'document_ref' && r.payload?.title === 'Lighthouse at sunset');
  const referencePath = delivered?.payload?.reference;
  const referenceBytes = referencePath && fs.existsSync(referencePath) ? fs.readFileSync(referencePath) : Buffer.alloc(0);
  const referenceDigest = crypto.createHash('sha256').update(referenceBytes).digest('hex');
  record('phone_pulled_the_record_after_restart', pull.status === 200 && Boolean(delivered) ? 'PASS' : 'FAIL', {
    status: pull.status, recordId: delivered?.recordId, revision: delivered?.revision, kind: delivered?.kind,
    nextSince: pull.result?.result?.nextSince, latestRevision: pull.result?.result?.latestRevision,
  });
  record('phone_received_the_saved_path', delivered?.payload?.summary?.includes(imagePath) && referencePath === imagePath ? 'PASS' : 'FAIL', {
    summary: delivered?.payload?.summary, reference: referencePath,
  });
  record('phone_can_verify_the_referenced_bytes', referenceDigest === digest && referenceBytes.length === bytes.length ? 'PASS' : 'FAIL', {
    referencedBytes: referenceBytes.length, referencedSha256: referenceDigest, artifactSha256: digest,
  });
  const payloadJson = JSON.stringify(delivered?.payload ?? {});
  record('only_a_summary_and_a_path_travel', payloadJson.length < 8_000 && !/data:image|base64,[A-Za-z0-9+/]{200,}/.test(payloadJson) ? 'PASS' : 'FAIL', {
    payloadChars: payloadJson.length,
    note: delivered?.payload?.note,
  });

  // ---- 8. acknowledged receipt, applied exactly once --------------------
  const ackOpId = `aw2ack-${Date.now()}`;
  const ack = await phoneRpc(code.body.port, pin, deviceKey, deviceId, 'push', {
    ops: [{ opId: ackOpId, recordId: delivered?.recordId, op: 'ack', baseRevision: delivered?.revision }],
  });
  const ackResult = ack.result?.result?.results?.[0];
  record('phone_acknowledged_receipt', ack.status === 200 && ackResult?.result === 'applied' ? 'PASS' : 'FAIL', {
    status: ack.status, result: ackResult?.result, detail: ackResult?.detail, opId: ackOpId,
  });
  const replayAck = await phoneRpc(code.body.port, pin, deviceKey, deviceId, 'push', {
    ops: [{ opId: ackOpId, recordId: delivered?.recordId, op: 'ack', baseRevision: delivered?.revision }],
  });
  record('ack_is_applied_exactly_once', replayAck.result?.result?.results?.[0]?.result === 'duplicate' ? 'PASS' : 'FAIL', {
    replay: replayAck.result?.result?.results?.[0],
  });

  // ---- 9. durable evidence ----------------------------------------------
  const overview = await api(third.port, 'GET', '/v1/household/overview');
  const companionOverview = overview.body?.companion;
  const device = companionOverview?.devices?.find((d) => d.id === deviceId);
  record('device_marks_the_pulled_revision', device && device.lastPulledRevision >= (delivered?.revision ?? Infinity) ? 'PASS' : 'FAIL', {
    lastPulledRevision: device?.lastPulledRevision, recordRevision: delivered?.revision, lastSeenAt: device?.lastSeenAt,
  });
  record('ack_is_visible_in_the_host_overview', (companionOverview?.recentOps ?? []).some((o) => o.opId === ackOpId && o.result === 'applied') ? 'PASS' : 'FAIL', {
    recentOps: companionOverview?.recentOps,
  });

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'core.db'), { readOnly: true });
  const approvalRows = db.prepare('SELECT status, resolution FROM approvals').all();
  const invocationRows = db.prepare('SELECT toolName, status FROM tool_invocations').all();
  const recordRows = db.prepare("SELECT recordId, kind, revision FROM companion_records WHERE kind = 'document_ref'").all();
  db.close();
  record('approvals_are_recorded', approvalRows.some((r) => r.status === 'approved') ? 'PASS' : 'FAIL', {
    approvals: approvalRows.length, approved: approvalRows.filter((r) => r.status === 'approved').length,
  });
  record('tool_invocations_are_recorded', ['comfyui_status', 'comfyui_generate_image', 'jugaad_send'].every((name) => invocationRows.some((r) => r.toolName === name && r.status === 'succeeded')) ? 'PASS' : 'FAIL', {
    invocations: invocationRows.map((r) => `${r.toolName}:${r.status}`),
  });
  record('companion_record_is_durable', recordRows.some((r) => r.recordId === delivered?.recordId) ? 'PASS' : 'FAIL', { records: recordRows });

  await stopCore(third.port);
  elapsedMs = Date.now() - began;
}

try {
  await main();
} catch (error) {
  record('run_error', 'FAIL', String(error?.stack ?? error));
} finally {
  if (child && !child.killed) child.kill();
  const failed = checks.filter((c) => c.status === 'FAIL');
  const blocked = checks.filter((c) => c.status === 'BLOCKED');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({
    requestText,
    modelProviderUsed: 'none: this run used the governed capability dispatch route, not an LLM turn',
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds: elapsedMs === null ? null : Math.round(elapsedMs / 1000),
    checks,
    limitations: [
      'No JUGAAD Android APK is present in this repository or on this machine, so the phone is a protocol-faithful paired client (real PBKDF2 pairing, pinned TLS, AES-256-GCM envelopes, pull and ack). The Core side of delivery and acknowledged receipt is real; an Android UI rendering it is not proven here.',
      'The image was generated by the real installed ComfyUI; the only simulated element is the phone application.',
    ],
  }, null, 2));
  console.log(`\n${checks.length} checks, ${failed.length} failed, ${blocked.length} blocked. Evidence: ${evidenceDir}`);
  if (failed.length > 0) process.exitCode = 1;
}
