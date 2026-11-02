import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { listMessages } from '../domain/conversations';
import { listStories } from '../domain/stories';
import {
  authenticatePairing, claimBridgeDispatch, classifySensitivity, createPairingCode, evaluateTransferPolicy, getBridgeTask, listBridgeTasks,
  listCheckpoints, recordBridgeStatus, redeemPairingCode, revokePairing, submitBridgeTask,
} from '../domain/pandaBridge';
import { parseNvidiaSmi, gpuLaneLimit } from '../runtime/hardwareCapacity';
import { isLocalModel, prepareTaskWorkspace, transferInfo, TESTS_PRESENT_CHECK } from '../runtime/kandev/pandaBridge';
import { spawnSync } from 'node:child_process';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-bridge-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function pair(label = 'Chrome') {
  const { code } = createPairingCode(db);
  return redeemPairingCode(db, { code, label, extensionId: 'abcdefghijklmnopabcdefghijklmnop' });
}

describe('pairing', () => {
  it('redeems a code once, stores only hashes, and authenticates the token', () => {
    const { code } = createPairingCode(db);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bridge_pairing_codes WHERE codeHash = ?", [code])?.n).toBe(0); // not stored in the clear
    const { pairing, token } = redeemPairingCode(db, { code, label: 'Chrome' });
    expect(authenticatePairing(db, token).id).toBe(pairing.id);
    expect(JSON.stringify(db.all('SELECT * FROM bridge_pairings'))).not.toContain(token);
    expect(() => redeemPairingCode(db, { code })).toThrow(/invalid, expired or already used/);
  });

  it('rejects an expired code and burns open codes after repeated wrong guesses', () => {
    const old = createPairingCode(db, Date.now() - 6 * 60_000);
    expect(() => redeemPairingCode(db, { code: old.code })).toThrow();
    const live = createPairingCode(db);
    for (let i = 0; i < 5; i++) expect(() => redeemPairingCode(db, { code: 'WRONGCODE' })).toThrow();
    expect(() => redeemPairingCode(db, { code: live.code })).toThrow(); // burned by the brute-force guard
  });

  it('revocation takes effect on the very next request', () => {
    const { pairing, token } = pair();
    expect(authenticatePairing(db, token).id).toBe(pairing.id);
    revokePairing(db, pairing.id);
    expect(() => authenticatePairing(db, token)).toThrow(/revoked or is unknown/);
    expect(() => authenticatePairing(db, undefined)).toThrow(/not paired/);
  });
});

describe('intake', () => {
  const instruction = '  Build a simple calculator app\n\twith "quotes" & unicode ✓  ';

  it('keeps the exact instruction, a source reference and creates the Pandesh conversation turn', () => {
    const { pairing } = pair();
    const { task, duplicate } = submitBridgeTask(db, pairing, {
      clientRequestId: 'req-0000001', instruction,
      sourceRef: { url: 'https://chatgpt.com/c/abc-123?model=x#frag', conversationId: 'abc-123', via: 'panda_mode' },
    });
    expect(duplicate).toBe(false);
    expect(task.status).toBe('awaiting_executor');
    expect(task.instruction).toBe(instruction);
    expect(task.sourceRef).toMatchObject({ kind: 'chatgpt', url: 'https://chatgpt.com/c/abc-123', conversationId: 'abc-123', via: 'panda_mode' });
    const turns = listMessages(db, task.conversationId!).filter(m => m.role === 'user');
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe(instruction);
  });

  it('delivers once per request id; identical text under a new request id is a separate task', () => {
    const { pairing } = pair();
    const a = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction });
    const b = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction });
    expect(b.duplicate).toBe(true);
    expect(b.task.id).toBe(a.task.id);
    expect(listBridgeTasks(db)).toHaveLength(1);
    expect(listMessages(db, a.task.conversationId!).filter(m => m.role === 'user')).toHaveLength(1);
    const c = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000002', instruction }); // a deliberate second request, same words
    expect(c.duplicate).toBe(false);
    expect(c.task.id).not.toBe(a.task.id);
    expect(c.task.conversationId).not.toBe(a.task.conversationId);
    expect(listBridgeTasks(db)).toHaveLength(2);
  });

  it('refuses empty or oversized instructions and context the user did not confirm', () => {
    const { pairing } = pair();
    expect(() => submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: '   ' })).toThrow(/empty/);
    expect(() => submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'x'.repeat(20_001) })).toThrow(/longer than/);
    expect(() => submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'ok', context: { text: 'earlier chat', userConfirmed: false } })).toThrow(/confirmed/);
    const withContext = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000009', instruction: 'ok', context: { text: 'earlier chat', userConfirmed: true } });
    expect(withContext.task.contextConfirmed).toBe(true);
    expect(listBridgeTasks(db)).toHaveLength(1);
  });
});

describe('confidentiality and external transfer', () => {
  it('flags secrets and confidential markers locally', () => {
    expect(classifySensitivity('Build a simple calculator app').sensitivity).toBe('normal');
    for (const text of [
      '-----BEGIN RSA PRIVATE KEY-----\nabc', 'use key AKIAABCDEFGHIJKLMNOP', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'password: hunter22',
      'connect to postgres://admin:s3cret@db.internal/x', 'card 4111 1111 1111 1111', 'This is CONFIDENTIAL, do not share', 'ssn 123-45-6789',
    ]) expect(classifySensitivity(text).sensitivity, text).toBe('confidential');
    expect(classifySensitivity('plain', true).reasons).toContain('marked confidential by you');
  });

  it('never lets a task reach an external executor without consent, and needs a second override when confidential', () => {
    const normal = { sensitivity: 'normal' as const, sensitivityReasons: [] };
    const secret = { sensitivity: 'confidential' as const, sensitivityReasons: ['API token'] };
    const claude = transferInfo('claude', null);
    expect(claude.external).toBe(true);
    expect(evaluateTransferPolicy(normal, transferInfo('opencode', null), undefined)).toEqual({ allowed: true });
    expect(evaluateTransferPolicy(secret, transferInfo('opencode', 'ollama/qwen3-coder'), undefined)).toEqual({ allowed: true }); // local model: stays on this PC
    expect(evaluateTransferPolicy(normal, claude, undefined)).toMatchObject({ allowed: false, code: 'external_consent_required' });
    expect(evaluateTransferPolicy(normal, claude, { externalTransfer: false })).toMatchObject({ allowed: false });
    expect(evaluateTransferPolicy(normal, claude, { externalTransfer: true })).toEqual({ allowed: true });
    expect(evaluateTransferPolicy(secret, claude, { externalTransfer: true })).toMatchObject({ allowed: false, code: 'confidential_override_required' });
    expect(evaluateTransferPolicy(secret, claude, { externalTransfer: true, confidentialOverride: true })).toEqual({ allowed: true });
    // a cloud model behind a local-looking agent is still external
    expect(transferInfo('opencode', 'anthropic/claude-sonnet').external).toBe(true);
    expect(isLocalModel('ollama/qwen3-coder:swift-27b')).toBe(true);
    expect(transferInfo('some-unknown-agent', null).external).toBe(true);
  });
});

describe('dispatch claim and checkpoints', () => {
  it('lets exactly one caller start the work', () => {
    const { pairing } = pair();
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'Build a calculator' });
    const route = { executor: 'opencode', model: null, routing: 'explicit' as const, consent: null, grantedBy: 'host' };
    expect(claimBridgeDispatch(db, task.id, route)).toBe(true);
    expect(claimBridgeDispatch(db, task.id, route)).toBe(false);
    expect(claimBridgeDispatch(db, task.id, { ...route, executor: 'claude' })).toBe(false);
    expect(getBridgeTask(db, task.id)).toMatchObject({ executor: 'opencode', status: 'dispatching', routing: 'explicit' });
  });

  it('stores a checkpoint only on change, never regresses a terminal state, and survives a restart', () => {
    const { pairing } = pair();
    const { task } = submitBridgeTask(db, pairing, { clientRequestId: 'req-0000001', instruction: 'Build a calculator' });
    const result = { verification: 'independent' as const, evidence: 'tests=3 pass=3 fail=0', changedFiles: ['calc.js'], commit: 'abc1234', pendingApprovals: [], activity: [], timeline: [] };
    expect(recordBridgeStatus(db, task.id, 'running', 'Working.')).toBe(true);
    expect(recordBridgeStatus(db, task.id, 'running', 'Working.')).toBe(false);
    expect(recordBridgeStatus(db, task.id, 'completed', 'Finished and verified.', result)).toBe(true);
    expect(recordBridgeStatus(db, task.id, 'running', 'Working.')).toBe(false); // a late poll cannot reopen a finished task
    const before = listCheckpoints(db, task.id).map(c => c.status);
    expect(before).toEqual(['received', 'awaiting_executor', 'running', 'completed']);

    db.close();
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const again = getBridgeTask(db, task.id);
    expect(again.status).toBe('completed');
    expect(again.result).toEqual(result);
    expect(again.completedAt).not.toBeNull();
    expect(listCheckpoints(db, task.id).map(c => c.status)).toEqual(before);
  });
});

describe('isolated workspace and independent test check', () => {
  it('creates a private git repository and a check that rejects "no tests"', () => {
    const ws = prepareTaskWorkspace(dir, 'ptask_abc');
    expect(ws.startsWith(path.join(dir, 'panda-workspaces'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.git'))).toBe(true);
    expect(prepareTaskWorkspace(dir, 'ptask_abc')).toBe(ws); // idempotent

    const checkFile = path.join(dir, 'check.mjs');
    fs.writeFileSync(checkFile, TESTS_PRESENT_CHECK);
    const run = () => spawnSync(process.execPath, [checkFile], { env: { ...process.env, KKD_ACCEPT_ROOT: ws }, encoding: 'utf8' });
    expect(run().status).not.toBe(0); // nothing to test: not accepted
    fs.writeFileSync(path.join(ws, 'calc.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 2));\n");
    expect(run().status).toBe(0);
    fs.writeFileSync(path.join(ws, 'calc.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('breaks', () => assert.equal(1 + 1, 3));\n");
    expect(run().status).not.toBe(0);
  });
});

describe('GPU capacity', () => {
  it('derives lanes from real VRAM and never below one', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3090, 24576, 3196\n')).toEqual({ name: 'NVIDIA GeForce RTX 3090', totalVramMb: 24576, freeVramMb: 3196 });
    expect(parseNvidiaSmi('')).toBeNull();
    expect(gpuLaneLimit({ name: 'x', totalVramMb: 24576, freeVramMb: 0 }, {})).toBe(1);
    expect(gpuLaneLimit({ name: 'x', totalVramMb: 49152, freeVramMb: 0 }, {})).toBe(2);
    expect(gpuLaneLimit({ name: 'x', totalVramMb: 8192, freeVramMb: 0 }, {})).toBe(1);
    expect(gpuLaneLimit(null, {})).toBe(1);
    expect(gpuLaneLimit(null, { KARKEDIKHA_GPU_LANES: '3' })).toBe(3);
  });
});

describe('HTTP surface', () => {
  const TOKEN = generateToken();
  const HOST = generateToken();
  let api: RunningApiServer;
  let base: string;

  beforeEach(async () => {
    api = await startApiServer({
      db, token: TOKEN, hostToken: HOST, operatorToken: generateToken(), broadcaster: new EventBroadcaster(), dataDir: dir,
      coreInfo: () => ({ coreVersion: '0', apiVersion: 1, instanceId: 't', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
    });
    base = `http://127.0.0.1:${api.port}`;
  });
  afterEach(async () => { await api.close(); });

  const call = async (method: string, p: string, opts: { host?: boolean; pairing?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'native-host' };
    if (opts.host) headers['X-Host-Token'] = HOST;
    if (opts.pairing) headers['X-Panda-Pairing'] = opts.pairing;
    const res = await fetch(`${base}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const pairOver = async (label = 'Chrome') => {
    const code = (await call('POST', '/v1/bridge/pairing-codes', { host: true })).json.code as string;
    return (await call('POST', '/v1/bridge/pair', { body: { code, label } })).json as { pairingId: string; token: string };
  };

  it('only Pandesh can issue pairing codes; a paired browser cannot', async () => {
    expect((await call('POST', '/v1/bridge/pairing-codes')).status).toBe(403);
    const { token } = await pairOver();
    expect((await call('POST', '/v1/bridge/pairing-codes', { pairing: token })).status).toBe(403);
  });

  it('receives the task once and returns its durable id immediately; revocation cuts access at once', async () => {
    const { token, pairingId } = await pairOver();
    const body = { clientRequestId: 'click-000000001', instruction: 'Build a simple calculator app', sourceRef: { url: 'https://chatgpt.com/c/x', via: 'send_button' } };
    const first = await call('POST', '/v1/bridge/tasks', { pairing: token, body });
    const retry = await call('POST', '/v1/bridge/tasks', { pairing: token, body });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(retry.json.taskId).toBe(first.json.taskId);
    expect(first.json.task.instruction).toBe('Build a simple calculator app');
    expect(listBridgeTasks(db)).toHaveLength(1);

    // Pandesh sees the same task the browser does.
    const hostView = await call('GET', `/v1/bridge/tasks/${first.json.taskId}`, { host: true });
    const browserView = await call('GET', `/v1/bridge/tasks/${first.json.taskId}`, { pairing: token });
    expect(hostView.json.id).toBe(browserView.json.id);
    expect((await call('GET', '/v1/bridge/tasks', { host: true })).json.tasks).toHaveLength(1);

    expect((await call('POST', `/v1/bridge/pairings/${pairingId}/revoke`, { host: true })).status).toBe(200);
    expect((await call('GET', `/v1/bridge/tasks/${first.json.taskId}`, { pairing: token })).status).toBe(401);
    expect((await call('POST', '/v1/bridge/tasks', { pairing: token, body: { ...body, clientRequestId: 'click-000000002', instruction: 'another' } })).status).toBe(401);
  });

  it('keeps one browser from seeing another browser’s tasks', async () => {
    const a = await pairOver('A');
    const b = await pairOver('B');
    const t = await call('POST', '/v1/bridge/tasks', { pairing: a.token, body: { clientRequestId: 'click-000000001', instruction: 'private work' } });
    expect((await call('GET', `/v1/bridge/tasks/${t.json.taskId}`, { pairing: b.token })).status).toBe(404);
    expect((await call('GET', '/v1/bridge/tasks', { pairing: b.token })).json.tasks).toHaveLength(0);
    expect((await call('POST', `/v1/bridge/tasks/${t.json.taskId}/cancel`, { pairing: b.token })).status).toBe(404);
  });

  it('refuses an external executor without consent, and an extension can never grant it; nothing starts', async () => {
    const { token } = await pairOver();
    const t = await call('POST', '/v1/bridge/tasks', { pairing: token, body: { clientRequestId: 'click-000000001', instruction: 'Build a simple calculator app' } });
    const id = t.json.taskId as string;
    const noConsent = await call('POST', `/v1/bridge/tasks/${id}/dispatch`, { host: true, body: { executor: 'claude' } });
    expect(noConsent.status).toBe(403);
    expect(noConsent.json.error.details.reason).toBe('external_consent_required');
    // the extension claims consent in its own request body: ignored
    const forged = await call('POST', `/v1/bridge/tasks/${id}/dispatch`, { pairing: token, body: { executor: 'claude', consent: { externalTransfer: true, confidentialOverride: true } } });
    expect(forged.status).toBe(403);
    expect(getBridgeTask(db, id)).toMatchObject({ status: 'awaiting_executor', executor: null, storyId: null });
    expect(listStories(db, { limit: 50 })).toHaveLength(0);
  });

  it('requires the confidential override on top of consent', async () => {
    const { token } = await pairOver();
    const t = await call('POST', '/v1/bridge/tasks', { pairing: token, body: { clientRequestId: 'click-000000001', instruction: 'Deploy using password: hunter2hunter2 to the server' } });
    expect(t.json.task.sensitivity).toBe('confidential');
    const id = t.json.taskId as string;
    const res = await call('POST', `/v1/bridge/tasks/${id}/dispatch`, { host: true, body: { executor: 'claude', consent: { externalTransfer: true } } });
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe('confidential_override_required');
    expect(getBridgeTask(db, id).status).toBe('awaiting_executor');
    expect(listStories(db, { limit: 50 })).toHaveLength(0);
  });

  it('does not substitute an executor the user did not pick', async () => {
    const { token } = await pairOver();
    const t = await call('POST', '/v1/bridge/tasks', { pairing: token, body: { clientRequestId: 'click-000000001', instruction: 'Build a calculator' } });
    const res = await call('POST', `/v1/bridge/tasks/${t.json.taskId}/dispatch`, { host: true, body: { executor: 'no-such-agent' } });
    expect(res.status).toBe(403); // unknown executors are treated as external, so they need consent first
    expect(getBridgeTask(db, t.json.taskId).executor).toBeNull();
  });
});
