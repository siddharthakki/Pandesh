import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { buildMinimalPdf, buildMinimalWav } from './fixtures/documentFixtures';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let broadcaster: EventBroadcaster;
let baseUrl: string;
let backend: CapturingBackend;

/** Captures the exact request the executor built, so tests can assert the
 * real Ollama multimodal message shape (bounded text + base64 `images`). */
class CapturingBackend implements ModelBackend {
  lastRequest: ModelChatRequest | null = null;
  async streamChat(request: ModelChatRequest, onToken: (delta: string) => void): Promise<ModelChatResult> {
    this.lastRequest = request;
    onToken('ok');
    return {
      content: 'ok',
      toolCalls: [],
      provider: 'ollama',
      model: request.model,
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    };
  }
}

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined && !(init.body instanceof Uint8Array)) headers['Content-Type'] = 'application/json';
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-attexec-${idempotencyCounter}`;
}

async function jsonOf(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(`request failed ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function pollAttempt(id: string, predicate: (a: any) => boolean, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (predicate(a)) return a;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied predicate; last status=${a.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function createAndUploadAttachment(
  conversationId: string,
  input: { name: string; declaredMimeType: string; kind: 'text' | 'image'; bytes: Buffer },
) {
  const created = await jsonOf(
    await authedFetch(`/v1/conversations/${conversationId}/attachments`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ originalName: input.name, declaredMimeType: input.declaredMimeType, kind: input.kind, byteSize: input.bytes.length }),
    }),
  );
  const uploaded = await jsonOf(
    await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(input.bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(input.bytes.length) },
    }),
  );
  expect(uploaded.status).toBe('ready');
  return uploaded;
}

const visionSelection = {
  requiredCapabilities: {
    readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
    codingComplexity: 'none', contextRequirement: 'small', vision: true, validationAndRepair: false,
  },
  selectedProvider: 'ollama',
  selectedModel: 'llava',
  selectionReason: 'test',
  suitabilitySummary: 'test',
  userOverrode: false,
  candidates: [],
  escalationCandidates: [],
};

async function startTestApi(localProcessingEnv?: NodeJS.ProcessEnv): Promise<RunningApiServer> {
  const processingEnv = localProcessingEnv ?? {
    ...process.env,
    KARKEDIKHA_ASR_MODEL_DIR: path.join(__dirname, '..', '..', 'models', 'whisper-base-en'),
  };
  return startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { backend, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
    localProcessingEnv: processingEnv,
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-attexec-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  backend = new CapturingBackend();
  api = await startTestApi();
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M36: one real vision-capable execution with a text file and an image', () => {
  it('builds the real Ollama multimodal request — bounded text content plus base64 image bytes', async () => {
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));

    const textBytes = Buffer.from('The secret ingredient is basil.', 'utf8');
    const textAttachment = await createAndUploadAttachment(conv.id, { name: 'notes.txt', declaredMimeType: 'text/plain', kind: 'text', bytes: textBytes });

    const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1, 2, 3, 4])]);
    const imageAttachment = await createAndUploadAttachment(conv.id, { name: 'photo.png', declaredMimeType: 'image/png', kind: 'image', bytes: pngBytes });

    const submission = await jsonOf(
      await authedFetch('/v1/submit', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({
          currentMessage: 'What is in the photo, and what does the note say?',
          requestedMode: 'baat_kar',
          conversationId: conv.id,
          attachmentIds: [textAttachment.id, imageAttachment.id],
          modelSelection: visionSelection,
        }),
      }),
    );

    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (a) => a.status === 'completed');

    expect(backend.lastRequest).not.toBeNull();
    const userMessages = backend.lastRequest!.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    expect(lastUser.content).toContain('notes.txt');
    expect(lastUser.content).toContain('The secret ingredient is basil.');
    expect(lastUser.images).toEqual([pngBytes.toString('base64')]);
  });

  it('fails the attempt with an honest blocker instead of executing when stored bytes have been tampered with', async () => {
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const textBytes = Buffer.from('original content', 'utf8');
    const textAttachment = await createAndUploadAttachment(conv.id, { name: 'notes.txt', declaredMimeType: 'text/plain', kind: 'text', bytes: textBytes });

    const submission = await jsonOf(
      await authedFetch('/v1/submit', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({
          currentMessage: 'Summarize the note.',
          requestedMode: 'baat_kar',
          conversationId: conv.id,
          attachmentIds: [textAttachment.id],
        }),
      }),
    );

    // Tamper with the stored file after it was verified and finalized.
    const storedPath = path.join(dir, textAttachment.storageRelativePath.split('/').join(path.sep));
    fs.writeFileSync(storedPath, 'tampered content');

    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    const attempt = await pollAttempt(submission.attempt.id, (a) => a.status === 'failed');
    expect(attempt.failureReason).toMatch(/hash/i);
    expect(backend.lastRequest).toBeNull(); // the model was never invoked with tampered content
  });
});

const textOnlySelection = {
  requiredCapabilities: {
    readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
    codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false,
  },
  selectedProvider: 'ollama',
  selectedModel: 'qwen2.5-coder:1.5b',
  selectionReason: 'test',
  suitabilitySummary: 'test',
  userOverrode: false,
  candidates: [],
  escalationCandidates: [],
};

describe('M36 pass 2: document extraction and audio transcription reach the model as text, never raw bytes', () => {
  it('appends locally-extracted, page-provenanced PDF text to the prompt — no vision capability needed, no raw PDF bytes sent', async () => {
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const pdfBytes = buildMinimalPdf('The quarterly report shows growth.');
    const created = await jsonOf(
      await authedFetch(`/v1/conversations/${conv.id}/attachments`, {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({ originalName: 'report.pdf', declaredMimeType: 'application/pdf', kind: 'document', byteSize: pdfBytes.length }),
      }),
    );
    const uploaded = await jsonOf(
      await authedFetch(`/v1/attachments/${created.id}/bytes`, {
        method: 'POST',
        body: new Uint8Array(pdfBytes),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(pdfBytes.length) },
      }),
    );
    expect(uploaded.status).toBe('ready');
    expect(uploaded.extraction.sections[0].text).toContain('The quarterly report shows growth.');

    const submission = await jsonOf(
      await authedFetch('/v1/submit', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({
          currentMessage: 'Summarize the attached report.',
          requestedMode: 'baat_kar',
          conversationId: conv.id,
          attachmentIds: [uploaded.id],
          modelSelection: textOnlySelection,
        }),
      }),
    );
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (a) => a.status === 'completed');

    expect(backend.lastRequest).not.toBeNull();
    const userMessages = backend.lastRequest!.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    expect(lastUser.content).toContain('report.pdf');
    expect(lastUser.content).toContain('pdfjs-dist');
    expect(lastUser.content).toContain('The quarterly report shows growth.');
    expect(lastUser.content).toContain('[page 1]');
    expect(lastUser.images ?? []).toHaveLength(0); // never sent as an image
  });

  it('appends the real transcribed text (with timestamp provenance) to the prompt for a real speech recording', async () => {
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const wavBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'audio', 'quarterly-report-speech.wav'));
    const created = await jsonOf(
      await authedFetch(`/v1/conversations/${conv.id}/attachments`, {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({ originalName: 'speech.wav', declaredMimeType: 'audio/wav', kind: 'audio', byteSize: wavBytes.length }),
      }),
    );
    const uploaded = await jsonOf(
      await authedFetch(`/v1/attachments/${created.id}/bytes`, {
        method: 'POST',
        body: new Uint8Array(wavBytes),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(wavBytes.length) },
      }),
    );
    expect(uploaded.status).toBe('ready');
    expect(uploaded.localProcessingCapability).toBe('available');
    expect(uploaded.transcription.segments.length).toBeGreaterThan(0);

    const submission = await jsonOf(
      await authedFetch('/v1/submit', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({
          currentMessage: 'What was said in the recording?',
          requestedMode: 'baat_kar',
          conversationId: conv.id,
          attachmentIds: [uploaded.id],
          modelSelection: textOnlySelection,
        }),
      }),
    );
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (a) => a.status === 'completed');

    expect(backend.lastRequest).not.toBeNull();
    const userMessages = backend.lastRequest!.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    expect(lastUser.content).toContain('speech.wav');
    expect(lastUser.content).toContain('whisper-base.en');
    expect(lastUser.content.toLowerCase()).toContain('quarterly report');
    expect(lastUser.content.toLowerCase()).toContain('steady growth');
    // Timestamp provenance (e.g. "[0.0s-...]") is present, not just bare text.
    expect(lastUser.content).toMatch(/\[\d+(\.\d+)?s-\d+(\.\d+)?s\]/);
  }, 60_000);

  it('appends an honest unavailable-transcription note for audio instead of silently dropping the attachment or fabricating a transcript', async () => {
    await api.close();
    const unavailableEnv: NodeJS.ProcessEnv = { ...process.env, KARKEDIKHA_ASR_MODEL_DIR: path.join(os.tmpdir(), 'karkedikha-no-such-asr-model-dir') };
    delete unavailableEnv.KARKEDIKHA_LOCAL_ASR_COMMAND;
    api = await startTestApi(unavailableEnv);
    baseUrl = `http://127.0.0.1:${api.port}`;
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const wavBytes = buildMinimalWav();
    const created = await jsonOf(
      await authedFetch(`/v1/conversations/${conv.id}/attachments`, {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({ originalName: 'voice.wav', declaredMimeType: 'audio/wav', kind: 'audio', byteSize: wavBytes.length }),
      }),
    );
    const uploaded = await jsonOf(
      await authedFetch(`/v1/attachments/${created.id}/bytes`, {
        method: 'POST',
        body: new Uint8Array(wavBytes),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(wavBytes.length) },
      }),
    );
    expect(uploaded.status).toBe('ready');
    expect(uploaded.localProcessingCapability).toBe('unavailable_no_local_engine');

    const submission = await jsonOf(
      await authedFetch('/v1/submit', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({
          currentMessage: 'What was said in the recording?',
          requestedMode: 'baat_kar',
          conversationId: conv.id,
          attachmentIds: [uploaded.id],
          modelSelection: textOnlySelection,
        }),
      }),
    );
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (a) => a.status === 'completed');

    expect(backend.lastRequest).not.toBeNull();
    const userMessages = backend.lastRequest!.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    expect(lastUser.content).toContain('voice.wav');
    expect(lastUser.content).toContain('not available');
    expect(lastUser.content).toContain('unavailable_no_local_engine');
  });
});

describe('F5: follow-ups keep resolving earlier attachments without a re-upload', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([9, 8, 7, 6])]);

  async function submitAndRun(conversationId: string, message: string, selection: object, attachmentIds: string[] = []) {
    const submission = await jsonOf(
      await authedFetch('/v1/submit', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({ currentMessage: message, requestedMode: 'baat_kar', conversationId, attachmentIds, modelSelection: selection }),
      }),
    );
    await authedFetch(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp() });
    await pollAttempt(submission.attempt.id, (a) => a.status === 'completed');
    const users = backend.lastRequest!.messages.filter((m) => m.role === 'user');
    return users[users.length - 1];
  }

  it('a vision-selected follow-up re-attaches the earlier image and the earlier text file, bounded, by identity', async () => {
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const note = await createAndUploadAttachment(conv.id, { name: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', bytes: Buffer.from('alpha file body') });
    const image = await createAndUploadAttachment(conv.id, { name: 'red.png', declaredMimeType: 'image/png', kind: 'image', bytes: png });
    await submitAndRun(conv.id, 'What is in this image?', visionSelection, [note.id, image.id]);

    const followUp = await submitAndRun(conv.id, 'What is the red object?', visionSelection);
    expect(followUp.content).toContain('Earlier image in this conversation: red.png');
    expect(followUp.content).toContain('re-attached for this follow-up');
    expect(followUp.content).toContain('alpha file body');
    expect(followUp.images).toEqual([png.toString('base64')]);
  });

  it('a text-only model is told the earlier image is NOT visible, and is never sent its bytes (no fake vision)', async () => {
    const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const image = await createAndUploadAttachment(conv.id, { name: 'red.png', declaredMimeType: 'image/png', kind: 'image', bytes: png });
    await submitAndRun(conv.id, 'Describe this.', visionSelection, [image.id]);
    const followUp = await submitAndRun(conv.id, 'And what colour is it?', textOnlySelection);
    expect(followUp.content).toContain('NOT visible to you in this turn');
    expect(followUp.images).toBeUndefined();
  });

  it('a New Chat (new conversation) carries nothing over from an earlier conversation', async () => {
    const first = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const note = await createAndUploadAttachment(first.id, { name: 'secret.txt', declaredMimeType: 'text/plain', kind: 'text', bytes: Buffer.from('old conversation secret') });
    await submitAndRun(first.id, 'Summarize it.', textOnlySelection, [note.id]);
    const second = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const followUp = await submitAndRun(second.id, 'What did that file say?', textOnlySelection);
    expect(followUp.content).not.toContain('old conversation secret');
    expect(followUp.content).not.toContain('Earlier attachment');
  });
});
