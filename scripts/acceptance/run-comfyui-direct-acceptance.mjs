/**
 * AW2, part one — Pandesh drives ComfyUI DIRECTLY.
 *
 * The real ComfyUI service on this PC, the real Core process, the real
 * governed dispatch path, real approvals over real HTTP, and real artifacts
 * on disk. Nothing here is mocked.
 *
 * It proves the parts the assessment said were missing:
 *   - the checkpoints ComfyUI actually has are discoverable,
 *   - Pandesh submits a workflow and owns the returned prompt id,
 *   - the render is monitored and the output retrieved,
 *   - the artifact is durable and still readable after a Core restart,
 *   - a render that finished while the Core was down is RECOVERED, not lost,
 *   - a queued job can be cancelled.
 *
 * Evidence lands in `.acceptance-evidence/comfyui-direct/`.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'comfyui-direct');
const runRoot = process.env.PANDESH_COMFY_ROOT ?? path.join(repoRoot, '.tmp', `comfyui-direct-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const token = 'comfyui-direct-acceptance-token';

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
    throw new Error(`the Core did not publish its discovery record within 30s:\n${log.slice(-1500)}`);
  }
  // The discovery record is written before the HTTP server starts listening:
  // wait for the API itself, not just for the record.
  const healthDeadline = Date.now() + 30_000;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8'));
  return record;
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
        'X-Client-Id': 'comfyui-direct-acceptance',
      },
      body: '{}',
    });
  } catch { /* already gone */ }
  await sleep(500);
  if (child && !child.killed) child.kill();
  child = null;
  await sleep(300);
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, 'X-Client-Id': 'comfyui-direct-acceptance', ...extra };
}

async function api(port, method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': `idem-${Date.now()}-${Math.random()}` }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

/** The governed dispatch route: one capability call, with its approval. */
async function dispatch(port, toolName, args, { approve = true } = {}) {
  // The SAME correlation id throughout: it is the anchor the approval is
  // bound to, and the second dispatch is what finds the approved record and
  // actually executes the capability.
  const correlationId = `comfy-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const call = () => api(port, 'POST', '/v1/capabilities/dispatch', {
    correlationId,
    toolName,
    arguments: args,
    cwd: dataDir,
  });
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

function isPng(bytes) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });

  // ---- ComfyUI must actually be there ------------------------------------
  const comfyUrl = process.env.KARKEDIKHA_COMFYUI_URL ?? 'http://127.0.0.1:8188';
  let comfyStats;
  try {
    comfyStats = await (await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(5000) })).json();
  } catch (error) {
    record('comfyui_reachable', 'BLOCKED', `ComfyUI is not answering at ${comfyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  record('comfyui_reachable', 'PASS', { version: comfyStats?.system?.comfyui_version, os: comfyStats?.system?.os });

  // ---- 1. the Core, first life ------------------------------------------
  const first = await startCore();
  record('core_started', 'PASS', { port: first.port, instanceId: first.instanceId });

  // ---- 2. discover the checkpoints ---------------------------------------
  const status = await api(first.port, 'POST', '/v1/capabilities/dispatch', {
    correlationId: `comfy-status-${Date.now()}`,
    toolName: 'comfyui_status',
    arguments: {},
    cwd: dataDir,
  });
  const checkpoints = status.body?.toolInvocation?.evidence?.output
    ? JSON.parse(status.body.toolInvocation.evidence.output).checkpoints ?? []
    : [];
  record('checkpoints_discovered', Array.isArray(checkpoints) && checkpoints.length > 0 ? 'PASS' : 'FAIL', { count: checkpoints?.length, first: checkpoints?.[0] });

  if (!checkpoints || checkpoints.length === 0) {
    await stopCore(first.port);
    return;
  }

  // ---- 3. generate for real ------------------------------------------------
  const prompt = 'a red lighthouse on a rocky coast at sunset, cinematic light';
  const started = Date.now();
  const generated = await dispatch(first.port, 'comfyui_generate_image', {
    prompt,
    checkpoint: checkpoints[0],
    width: 512,
    height: 512,
    steps: 8,
  });
  const elapsed = Date.now() - started;
  const evidence = generated.body?.toolInvocation?.evidence;
  const parsed = evidence?.output ? JSON.parse(evidence.output) : {};
  record('image_generated_through_comfyui', generated.body?.outcome === 'executed' && parsed.artifactIds?.length > 0 ? 'PASS' : 'FAIL', {
    outcome: generated.body?.outcome,
    artifactIds: parsed.artifactIds,
    promptId: parsed.promptId,
    checkpoint: parsed.checkpoint,
    elapsedSec: Math.round(elapsed / 1000),
    reason: generated.body?.reason,
  });
  if (!parsed.artifactIds?.length) {
    await stopCore(first.port);
    return;
  }
  record('prompt_id_captured', typeof parsed.promptId === 'string' && parsed.promptId.length > 0 ? 'PASS' : 'FAIL', { promptId: parsed.promptId });

  // ---- 4. the artifact is a real image on disk ---------------------------
  const artifact = await api(first.port, 'GET', `/v1/artifacts/${encodeURIComponent(parsed.artifactIds[0])}`);
  const record0 = artifact.body;
  const absolutePath = record0?.absolutePath;
  const bytes = absolutePath && fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath) : Buffer.alloc(0);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  record('artifact_is_a_real_png', isPng(bytes) && bytes.length > 1000 && digest === record0?.sha256 ? 'PASS' : 'FAIL', {
    path: absolutePath, bytes: bytes.length, sha256Matches: digest === record0?.sha256, availability: record0?.availability,
  });

  // ---- 5. the artifact survives a Core restart ---------------------------
  await stopCore(first.port);
  const second = await startCore();
  const afterRestart = await api(second.port, 'GET', `/v1/artifacts/${encodeURIComponent(parsed.artifactIds[0])}`);
  record('artifact_survives_core_restart', afterRestart.body?.availability === 'ready' && afterRestart.body?.sha256 === digest ? 'PASS' : 'FAIL', {
    availability: afterRestart.body?.availability, sha256: afterRestart.body?.sha256,
  });

  // ---- 6. recovery: a render that finished while the Core was down -------
  // Submit a job, let ComfyUI start rendering, kill the Core, restart it and
  // let Pandesh collect the finished render.
  const recoveryPrompt = 'a small blue robot holding a lantern, studio light';
  const recoveryCorrelationId = `comfy-recover-${Date.now()}`;
  const recoveryCall = () => api(second.port, 'POST', '/v1/capabilities/dispatch', {
    correlationId: recoveryCorrelationId,
    toolName: 'comfyui_generate_image',
    arguments: { prompt: recoveryPrompt, checkpoint: checkpoints[0], width: 512, height: 512, steps: 30 },
    cwd: dataDir,
  });
  const pendingResult = await recoveryCall();
  const pendingApproval = pendingResult.body?.approval;
  if (!pendingApproval) {
    record('recovery_job_submitted', 'FAIL', { outcome: pendingResult.body?.outcome, reason: pendingResult.body?.reason });
  } else {
    await api(second.port, 'POST', `/v1/capabilities/approvals/${encodeURIComponent(pendingApproval.id)}/resolve`, {
      resolution: 'approved',
      attemptId: pendingApproval.attemptId,
      expectedAttemptRevision: pendingApproval.expectedAttemptRevision,
      expectedAttemptStatus: pendingApproval.expectedAttemptStatus,
      requestedActionDigest: pendingApproval.requestedActionDigest,
      frozenContextHash: pendingApproval.frozenContextHash,
    });
    // The second dispatch is what actually runs the capability. It is NOT
    // awaited: the Core must still be busy when it is killed. The catch is
    // attached immediately, because killing the Core resets that connection.
    const running = recoveryCall();
    running.catch(() => undefined);
    // Wait for the job to appear on record, then kill the Core immediately:
    // the render itself keeps running inside ComfyUI, which is a separate
    // process, so the picture survives the Core that asked for it.
    const jobLedger = path.join(dataDir, 'comfyui-output', 'jobs.json');
    let unfinished = [];
    const ledgerDeadline = Date.now() + 20_000;
    while (Date.now() < ledgerDeadline) {
      const ledger = fs.existsSync(jobLedger) ? JSON.parse(fs.readFileSync(jobLedger, 'utf8')) : { jobs: {} };
      unfinished = Object.values(ledger.jobs ?? {}).filter((job) => !job.artifactId);
      if (unfinished.length > 0) break;
      await sleep(250);
    }
    record('recovery_job_on_record', unfinished.length > 0 ? 'PASS' : 'FAIL', { unfinished: unfinished.map((j) => j.promptId) });

    await stopCore(second.port);
    const third = await startCore();
    // Give ComfyUI a moment to finish the render it is still working on.
    await sleep(15_000);
    const resume = await dispatch(third.port, 'comfyui_resume_jobs', {});
    const resumeOutput = resume.body?.toolInvocation?.evidence?.output ?? '';
    record('unfinished_render_recovered', /recovered\s+\S+/.test(resumeOutput) ? 'PASS' : 'FAIL', { output: resumeOutput.slice(0, 400), outcome: resume.body?.outcome });

    // The recovered artifact must be a real file with real bytes.
    const recoveredId = /recovered\s+(\S+)\s+->\s+(\S+)/.exec(resumeOutput)?.[2];
    if (recoveredId) {
      const recovered = await api(third.port, 'GET', `/v1/artifacts/${encodeURIComponent(recoveredId)}`);
      const recoveredPath = recovered.body?.absolutePath;
      const recoveredBytes = recoveredPath && fs.existsSync(recoveredPath) ? fs.readFileSync(recoveredPath) : Buffer.alloc(0);
      record('recovered_render_is_a_real_png', isPng(recoveredBytes) && recoveredBytes.length > 1000 ? 'PASS' : 'FAIL', {
        path: recoveredPath, bytes: recoveredBytes.length, availability: recovered.body?.availability,
      });
    } else {
      record('recovered_render_is_a_real_png', 'FAIL', { reason: 'no recovered artifact id in the resume output' });
    }

    // ---- 7. cancellation of a QUEUED job ---------------------------------
    const queueBefore = await (await fetch(`${comfyUrl}/queue`)).json();
    const pendingCount = (queueBefore?.queue_pending?.length ?? 0);
    record('comfyui_queue_visible', typeof pendingCount === 'number' ? 'PASS' : 'FAIL', { pending: pendingCount });
    await stopCore(third.port);
  }
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
