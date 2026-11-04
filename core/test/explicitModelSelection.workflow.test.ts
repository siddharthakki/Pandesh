/**
 * An explicit (manual) model choice must be recorded as the user's override end to end, so Auto reroute can
 * never substitute it, for chat and app-building requests alike. Real Core database and HTTP /v1/submit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { getAttemptContext } from '../domain/attemptContext';
import { isAutoSelection } from '../runtime/autoRerouteRuntime';

const TOKEN = generateToken();
const GEMMA = 'gemma4:26b-a4b-it-qat';
let dir: string; let db: CoreDatabase; let api: RunningApiServer; let n = 0;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-explicit-model-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  api = await startApiServer({
    db, token: TOKEN, broadcaster: new EventBroadcaster(), dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'explicit-model', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
  });
});
afterEach(async () => { await api.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function submit(body: Record<string, unknown>) {
  n += 1;
  const res = await fetch(`http://127.0.0.1:${api.port}/v1/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'explicit-model-client', 'Idempotency-Key': `explicit-${n}` },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<any>;
}

describe('explicit local model selection', () => {
  it.each([
    ['chat', 'baat_kar', 'Hello, how are you?'],
    ['app building', 'karke_dikha', 'Build a small app that takes an image as input and generates step-by-step origami instructions.'],
  ])('keeps %s on the exact selected model and records it as a manual choice', async (_label, mode, text) => {
    const body = await submit({ currentMessage: text, requestedMode: mode, requestedProvider: 'ollama', requestedModel: GEMMA, hasWorkspace: false });
    expect(body.modelSelection.selectedModel).toBe(GEMMA);
    expect(body.modelSelection.userOverrode).toBe(true);
    const context = getAttemptContext(db, body.attempt.id);
    expect(context.selectedModel).toBe(GEMMA);
    expect(isAutoSelection(context)).toBe(false);
  });

  it('upgrades client-supplied evidence that forgot to mark a requested model as the user override', async () => {
    const body = await submit({
      currentMessage: 'Hello', requestedMode: 'baat_kar', requestedProvider: 'ollama', requestedModel: GEMMA,
      modelSelection: {
        requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false, codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false },
        selectedProvider: 'ollama', selectedModel: GEMMA, selectionReason: 'x', suitabilitySummary: 'x', userOverrode: false,
        candidates: [], escalationCandidates: [],
      },
    });
    expect(body.modelSelection.userOverrode).toBe(true);
    expect(isAutoSelection(getAttemptContext(db, body.attempt.id))).toBe(false);
  });
});
