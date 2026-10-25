import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { failDeadExecutorAttemptsOnBoot } from '../domain/bootReconciliation';
import { acquireFence } from '../domain/fence';
import { requestCancelAttempt, transitionAttempt } from '../domain/attempts';
import { createIntent, getIntent } from '../domain/intents';
import { parseLocalOllamaModels, modelKey, type ModelDescriptor } from '../platform/modelCatalog';
import { ProviderCatalog } from '../platform/providerCatalog';
import type { RerouteEnvironment } from '../runtime/autoRerouteRuntime';
import { chooseResumeModel, recoverIntentsOnBoot } from '../runtime/intentRecovery';
import { EventBroadcaster } from '../ws/broadcaster';

let dir: string;
let workspace: string;
let db: CoreDatabase;
const DEAD_PID = 2_147_000_002;
const checks = [{ kind: 'file_exists', path: 'out.txt' }];

beforeEach(() => {
  delete process.env.KARKEDIKHA_INTENT_RESUME_MODEL;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-'));
  workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  delete process.env.KARKEDIKHA_INTENT_RESUME_MODEL;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function models(spec: Array<{ name: string; tools: boolean | 'unknown' }>): RerouteEnvironment {
  const parsed: ModelDescriptor[] = parseLocalOllamaModels(spec.map((s) => ({ name: s.name }))).map((d) => ({
    ...d,
    tools: spec.find((s) => s.name === d.modelId)!.tools,
  }));
  return { models: parsed, reachableLocalKeys: new Set(parsed.map(modelKey)), connectedProviders: new Set(), catalog: new ProviderCatalog() };
}

/** An intent whose first attempt (model-a) was running when its executor died and was failed by boot reconciliation. */
function interruptedIntent(options: { cancel?: boolean } = {}) {
  const { request, attempt } = submitRequest(db, {
    clientId: 'recovery-test', currentMessage: 'Write out.txt in the workspace for me, please.', requestedMode: 'saath_kar',
    workspaceRoot: workspace, requestedProvider: 'ollama', requestedModel: 'model-a', selectedProvider: 'ollama', selectedModel: 'model-a',
    capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${Math.random()}`,
  });
  const intent = createIntent(db, { requestId: request.id, checks, actor: 'test' });
  const fence = acquireFence(db, attempt.id, { owner: `core:executor:${DEAD_PID}`, actor: 'test', leaseMs: 60_000 });
  transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test', fenceToken: fence.token });
  if (options.cancel) requestCancelAttempt(db, attempt.id, { actor: 'user' });
  failDeadExecutorAttemptsOnBoot(db, { selfPid: process.pid, isProcessAlive: () => false });
  return { request, attempt, intent };
}

function deps(env: RerouteEnvironment | undefined, probe?: (m: string) => Promise<readonly string[] | undefined>) {
  const started: string[] = [];
  return {
    started,
    value: {
      db,
      broadcaster: new EventBroadcaster(),
      executor: { execute: async (id: string) => { started.push(id); } },
      environment: env ? async () => env : undefined,
      probeCapabilities: probe ?? (async () => undefined),
    },
  };
}

describe('chooseResumeModel', () => {
  it('prefers a model that declares tools and skips ones that declare none or already worked on the intent', async () => {
    const { intent } = interruptedIntent();
    const env = models([
      { name: 'model-a', tools: true }, // already used
      { name: 'no-tools:1b', tools: false },
      { name: 'unknown:7b', tools: 'unknown' },
      { name: 'tooled:12b', tools: true },
    ]);
    expect(await chooseResumeModel(deps(env).value, intent)).toBe('tooled:12b');
  });

  it('accepts an unknown-support model only when the provider says it supports tools', async () => {
    const { intent } = interruptedIntent();
    const env = models([{ name: 'plain:7b', tools: 'unknown' }, { name: 'agentic:9b', tools: 'unknown' }]);
    const probe = async (m: string) => (m === 'agentic:9b' ? ['completion', 'tools'] : ['completion']);
    expect(await chooseResumeModel(deps(env, probe).value, intent)).toBe('agentic:9b');
    expect(await chooseResumeModel(deps(env, async () => undefined).value, intent)).toBeUndefined();
  });

  it('never picks an embedding model or one that is not reachable', async () => {
    const { intent } = interruptedIntent();
    const env = models([{ name: 'qwen3-embedding:4b', tools: true }, { name: 'gone:3b', tools: true }]);
    env.reachableLocalKeys.clear();
    expect(await chooseResumeModel(deps(env).value, intent)).toBeUndefined();
    expect(await chooseResumeModel(deps(models([{ name: 'qwen3-embedding:4b', tools: true }])).value, intent)).toBeUndefined();
  });

  it('honours an explicit operator choice, but not one that already worked on the intent', async () => {
    const { intent } = interruptedIntent();
    process.env.KARKEDIKHA_INTENT_RESUME_MODEL = 'chosen:20b';
    expect(await chooseResumeModel(deps(undefined).value, intent)).toBe('chosen:20b');
    process.env.KARKEDIKHA_INTENT_RESUME_MODEL = 'model-a';
    expect(await chooseResumeModel(deps(undefined).value, intent)).toBeUndefined();
  });
});

describe('recoverIntentsOnBoot', () => {
  it('hands an interrupted intent to another model and starts exactly that successor, once', async () => {
    const { request, attempt, intent } = interruptedIntent();
    const d = deps(models([{ name: 'model-a', tools: true }, { name: 'model-b', tools: true }]));
    const report = await recoverIntentsOnBoot(d.value);
    expect(report).toHaveLength(1);
    expect(report[0].result).toMatch(/^resumed on model-b as att_/);
    const successorId = db.get<{ id: string }>('SELECT id FROM attempts WHERE predecessorAttemptId = ?', [attempt.id])!.id;
    expect(d.started).toEqual([successorId]);
    expect(getIntent(db, intent.id)).toMatchObject({ status: 'recovering', resumeCount: 1 });

    // A second boot pass finds the successor not yet failed and must not fork another one.
    expect(await recoverIntentsOnBoot(d.value)).toEqual([]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts WHERE requestId = ?', [request.id])!.n).toBe(2);
    expect(d.started).toHaveLength(1);
  });

  it('verifies without resuming when the interrupted run had already done the work', async () => {
    const { attempt, intent } = interruptedIntent();
    fs.writeFileSync(path.join(workspace, 'out.txt'), 'done');
    const d = deps(models([{ name: 'model-b', tools: true }]));
    const report = await recoverIntentsOnBoot(d.value);
    expect(report).toEqual([{ intentId: intent.id, result: 'verified without a resume' }]);
    expect(d.started).toEqual([]);
    expect(getIntent(db, intent.id).status).toBe('verified');
    expect(db.get('SELECT 1 AS x FROM attempts WHERE predecessorAttemptId = ?', [attempt.id])).toBeUndefined();
  });

  it('leaves the task for a person, changing nothing, when no suitable model exists', async () => {
    const { request, intent } = interruptedIntent();
    const d = deps(models([{ name: 'model-a', tools: true }]));
    const report = await recoverIntentsOnBoot(d.value);
    expect(report[0].result).toMatch(/left for a person/);
    expect(d.started).toEqual([]);
    expect(getIntent(db, intent.id)).toMatchObject({ status: 'active', resumeCount: 0 });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts WHERE requestId = ?', [request.id])!.n).toBe(1);
  });

  it('never resumes a task the user cancelled', async () => {
    const { intent } = interruptedIntent({ cancel: true });
    const d = deps(models([{ name: 'model-b', tools: true }]));
    await recoverIntentsOnBoot(d.value);
    expect(d.started).toEqual([]);
    expect(getIntent(db, intent.id).status).toBe('abandoned');
  });

  it('does nothing for requests that never declared an intent', async () => {
    submitRequest(db, {
      clientId: 'recovery-test', currentMessage: 'A task with no declared intent at all, interrupted.', requestedMode: 'saath_kar',
      workspaceRoot: workspace, requestedProvider: 'ollama', requestedModel: 'model-a', selectedProvider: 'ollama', selectedModel: 'model-a',
      capability: { hasWorkspace: true, gitCapable: false }, correlationId: 'corr-none',
    });
    const d = deps(models([{ name: 'model-b', tools: true }]));
    expect(await recoverIntentsOnBoot(d.value)).toEqual([]);
    expect(d.started).toEqual([]);
  });
});
