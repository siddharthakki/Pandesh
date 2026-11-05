/**
 * AW-B — an artifact must survive a genuine Core restart.
 *
 * The real Core (the esbuild bundle the product ships) is spawned as a real
 * child process, driven over real HTTP, restarted for real, and asked for the
 * same artifact by its durable id. The bytes are verified against the file on
 * disk, and an unauthenticated caller is refused.
 *
 * This is an acceptance driver, not a unit test: nothing here is mocked.
 * Evidence lands in `.acceptance-evidence/artifact-restart/`.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const evidenceDir = path.join(repoRoot, '.acceptance-evidence', 'artifact-restart');
const runRoot = process.env.PANDESH_ARTIFACT_RESTART_ROOT
  ?? path.join(repoRoot, '.tmp', `artifact-restart-${process.pid}`);
const dataDir = path.join(runRoot, 'data');
const mediaDir = path.join(runRoot, 'media');

const checks = [];
function record(name, status, detail) {
  checks.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`[${status}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`);
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, checks }, null, 2));
}

const startedAt = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(bundlePath)) {
  console.error(`Core bundle missing at ${bundlePath}. Run "npm run bundle:core" first.`);
  process.exit(1);
}
fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const token = 'artifact-restart-acceptance-token';

/** A tiny but genuinely valid PNG (1x1, opaque red). */
function writePng(file) {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bytes = Buffer.from(base64, 'base64');
  fs.writeFileSync(file, bytes);
  return bytes;
}

let child = null;

async function startCore() {
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: token, KARKEDIKHA_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const recordPath = path.join(dataDir, 'core.json');
    if (fs.existsSync(recordPath)) {
      try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (record.port) return { ...record, logs };
      } catch { /* partial write */ }
    }
    await sleep(60);
  }
  throw new Error(`Core did not start within 30s:\n${logs.join('')}`);
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
        'X-Client-Id': 'artifact-restart-acceptance',
      },
      body: '{}',
    });
  } catch { /* already gone */ }
  const exited = new Promise((resolve) => {
    if (!child) return resolve();
    child.once('exit', () => resolve());
    setTimeout(resolve, 8000);
  });
  await exited;
  if (child && !child.killed) child.kill();
  child = null;
  await sleep(300);
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Client-Id': 'artifact-restart-acceptance',
    ...extra,
  };
}

async function main() {
  const imagePath = path.join(mediaDir, 'lighthouse.png');
  const imageBytes = writePng(imagePath);
  const imageSha = crypto.createHash('sha256').update(imageBytes).digest('hex');

  // ---- 1. first Core: create the artifact --------------------------------
  const first = await startCore();
  record('core_started', 'PASS', { port: first.port, instanceId: first.instanceId });

  const conversationRes = await fetch(`http://127.0.0.1:${first.port}/v1/conversations`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': `conv-${Date.now()}` }),
    body: JSON.stringify({ mode: 'baat_kar', title: 'Artifact restart acceptance' }),
  });
  const conversation = conversationRes.status === 201 ? await conversationRes.json() : null;
  record('conversation_created', conversation ? 'PASS' : 'FAIL', conversation ? { id: conversation.id } : { status: conversationRes.status });

  const registerRes = await fetch(`http://127.0.0.1:${first.port}/v1/artifacts`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': `artifact-${Date.now()}` }),
    body: JSON.stringify({
      conversationId: conversation?.id ?? null,
      kind: 'image',
      title: 'Lighthouse at sunset',
      mimeType: 'image/png',
      absolutePath: imagePath,
      source: 'artifact-restart-acceptance',
      metadata: { prompt: 'a lighthouse at sunset' },
    }),
  });
  const registered = registerRes.status === 201 ? await registerRes.json() : null;
  record('artifact_registered', registered ? 'PASS' : 'FAIL', registered ? { id: registered.id, availability: registered.availability } : { status: registerRes.status });
  if (!registered) {
    await stopCore(first.port);
    return;
  }

  const beforeRes = await fetch(`http://127.0.0.1:${first.port}/v1/artifacts/${registered.id}`, { headers: authHeaders() });
  const before = beforeRes.ok ? await beforeRes.json() : null;
  record('artifact_accessible_before_restart', before?.availability === 'ready' ? 'PASS' : 'FAIL', before ? { availability: before.availability, sha256: before.sha256 } : { status: beforeRes.status });

  // A private artifact must not be readable without the Core bearer token.
  const unauthenticated = await fetch(`http://127.0.0.1:${first.port}/v1/artifacts/${registered.id}`);
  record('artifact_refuses_unauthenticated_caller', unauthenticated.status === 401 || unauthenticated.status === 403 ? 'PASS' : 'FAIL', { status: unauthenticated.status });

  // ---- 2. a genuine restart ---------------------------------------------
  const firstInstance = first.instanceId;
  await stopCore(first.port);
  record('core_stopped', 'PASS', { instanceId: firstInstance });

  const second = await startCore();
  record('core_restarted', second.instanceId !== firstInstance ? 'PASS' : 'FAIL', { first: firstInstance, second: second.instanceId });

  // ---- 3. the same durable identity must still resolve -------------------
  const afterRes = await fetch(`http://127.0.0.1:${second.port}/v1/artifacts/${registered.id}`, { headers: authHeaders() });
  const after = afterRes.ok ? await afterRes.json() : null;
  record('artifact_retrievable_by_durable_id_after_restart', after ? 'PASS' : 'FAIL', after ? { id: after.id, availability: after.availability } : { status: afterRes.status });

  const bytesOnDisk = fs.readFileSync(imagePath);
  const shaOnDisk = crypto.createHash('sha256').update(bytesOnDisk).digest('hex');
  record('artifact_bytes_unchanged_after_restart', after?.sha256 === shaOnDisk && after?.byteSize === bytesOnDisk.length ? 'PASS' : 'FAIL',
    { recordedSha: after?.sha256, diskSha: shaOnDisk, recordedBytes: after?.byteSize, diskBytes: bytesOnDisk.length });
  record('artifact_still_renderable', after?.availability === 'ready' && shaOnDisk === imageSha ? 'PASS' : 'FAIL', { availability: after?.availability });

  const unauthenticatedAfter = await fetch(`http://127.0.0.1:${second.port}/v1/artifacts/${registered.id}`);
  record('artifact_refuses_unauthenticated_caller_after_restart', unauthenticatedAfter.status === 401 || unauthenticatedAfter.status === 403 ? 'PASS' : 'FAIL', { status: unauthenticatedAfter.status });

  await stopCore(second.port);
}

try {
  await main();
} catch (error) {
  record('run_error', 'FAIL', String(error?.stack ?? error));
} finally {
  if (child && !child.killed) child.kill();
  const failed = checks.filter((c) => c.status === 'FAIL');
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), checks }, null, 2));
  console.log(`\n${checks.length} checks, ${failed.length} failed. Evidence: ${evidenceDir}`);
  if (failed.length > 0) process.exitCode = 1;
}
