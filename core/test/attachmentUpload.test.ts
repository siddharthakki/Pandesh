import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { buildMinimalPdf, buildMinimalDocx, buildMinimalWav } from './fixtures/documentFixtures';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;

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
  return `idemp-upload-${idempotencyCounter}`;
}

async function jsonOf(res: Response) {
  return res.json();
}

async function createConversation() {
  const res = await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }) });
  return jsonOf(res);
}

async function createAttachment(conversationId: string, input: { originalName: string; declaredMimeType: string; kind: string; byteSize: number }) {
  const res = await authedFetch(`/v1/conversations/${conversationId}/attachments`, { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify(input) });
  return jsonOf(res);
}

async function startTestApi(localProcessingEnv?: NodeJS.ProcessEnv): Promise<RunningApiServer> {
  const processingEnv = localProcessingEnv ?? {
    ...process.env,
    KARKEDIKHA_ASR_MODEL_DIR: path.join(__dirname, '..', '..', 'models', 'whisper-base-en'),
  };
  return startApiServer({
    db,
    token: TOKEN,
    broadcaster: new EventBroadcaster(),
    dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    localProcessingEnv: processingEnv,
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-upload-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  api = await startTestApi();
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bounded authenticated attachment upload route', () => {
  it('uploads a text file and finalizes it as ready with a verified hash', async () => {
    const conv = await createConversation();
    const bytes = Buffer.from('hello attachment world', 'utf8');
    const created = await createAttachment(conv.id, { originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: bytes.length });
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.detectedMimeType).toBe('text/plain');
    expect(body.byteSize).toBe(bytes.length);
    expect(body.sha256).toHaveLength(64);

    const finalPath = path.join(dir, body.storageRelativePath.split('/').join(path.sep));
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.readFileSync(finalPath).toString('utf8')).toBe('hello attachment world');
    // No leftover .uploading temp file after a successful finalize.
    expect(fs.existsSync(`${finalPath.replace(/\.bin$/, '')}.uploading`)).toBe(false);
  });

  it('rejects an upload whose Content-Length does not match the declared byteSize', async () => {
    const conv = await createConversation();
    const created = await createAttachment(conv.id, { originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 100 });
    const bytes = Buffer.from('too short', 'utf8');
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('content_length_mismatch');

    const attachment = await jsonOf(await authedFetch(`/v1/attachments/${created.id}`));
    expect(attachment.status).toBe('failed');
    expect(attachment.errorCode).toBe('content_length_mismatch');
  });

  it('rejects content that does not match the declared kind (an image body declared as text)', async () => {
    const conv = await createConversation();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const created = await createAttachment(conv.id, { originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: png.length });
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(png),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(png.length) },
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error.code).toBe('mime_mismatch');

    const attachment = await jsonOf(await authedFetch(`/v1/attachments/${created.id}`));
    expect(attachment.status).toBe('failed');
    // No file left on disk for a rejected upload.
    const conversationDir = path.join(dir, 'attachments', conv.id);
    if (fs.existsSync(conversationDir)) {
      expect(fs.readdirSync(conversationDir)).toEqual([]);
    }
  });

  it('rejects an upload exceeding the 10 MiB slice limit', async () => {
    const conv = await createConversation();
    const oversizedDeclared = 11 * 1024 * 1024;
    const res = await authedFetch(`/v1/conversations/${conv.id}/attachments`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ originalName: 'huge.png', declaredMimeType: 'image/png', kind: 'image', byteSize: oversizedDeclared }),
    });
    expect(res.status).not.toBe(201);
  });

  it('is idempotent: retrying bytes for an already-ready attachment returns the same record without re-processing', async () => {
    const conv = await createConversation();
    const bytes = Buffer.from('idempotent content', 'utf8');
    const created = await createAttachment(conv.id, { originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: bytes.length });
    const first = await jsonOf(
      await authedFetch(`/v1/attachments/${created.id}/bytes`, {
        method: 'POST',
        body: new Uint8Array(bytes),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
      }),
    );
    const second = await jsonOf(
      await authedFetch(`/v1/attachments/${created.id}/bytes`, {
        method: 'POST',
        body: new Uint8Array(bytes),
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
      }),
    );
    expect(second).toEqual(first);
    expect(second.revision).toBe(first.revision); // no second finalize occurred
  });

  it('uploads a real PDF, extracts page-provenanced text locally, and records it as ready with localProcessingCapability "available"', async () => {
    const conv = await createConversation();
    const bytes = buildMinimalPdf('Package provenance verification text');
    const created = await createAttachment(conv.id, { originalName: 'report.pdf', declaredMimeType: 'application/pdf', kind: 'document', byteSize: bytes.length });
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.detectedMimeType).toBe('application/pdf');
    expect(body.localProcessingCapability).toBe('available');
    expect(body.extraction).not.toBeNull();
    expect(body.extraction.engine).toBe('pdfjs-dist');
    expect(body.extraction.pageCount).toBe(1);
    expect(body.extraction.sections[0].text).toContain('Package provenance verification text');
    expect(body.transcription).toBeNull();

    // Durable: re-reading the attachment (simulating restart restoration)
    // returns the same recorded extraction, not re-run/re-computed.
    const reread = await jsonOf(await authedFetch(`/v1/attachments/${created.id}`));
    expect(reread.extraction).toEqual(body.extraction);
  });

  it('uploads a real DOCX and extracts paragraph-provenanced text locally', async () => {
    const conv = await createConversation();
    const bytes = await buildMinimalDocx(['One.', 'Two.']);
    const created = await createAttachment(conv.id, {
      originalName: 'notes.docx',
      declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'document',
      byteSize: bytes.length,
    });
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.localProcessingCapability).toBe('available');
    expect(body.extraction.engine).toBe('mammoth');
    expect(body.extraction.sections.map((s: { text: string }) => s.text)).toEqual(['One.', 'Two.']);
  });

  it('uploads a real speech WAV and records a real, word-accurate local transcription with timestamped segments', async () => {
    const conv = await createConversation();
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'audio', 'quarterly-report-speech.wav'));
    const created = await createAttachment(conv.id, { originalName: 'speech.wav', declaredMimeType: 'audio/wav', kind: 'audio', byteSize: bytes.length });
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.detectedMimeType).toBe('audio/wav');
    expect(body.sha256).toHaveLength(64);
    expect(body.localProcessingCapability).toBe('available');
    expect(body.transcription).not.toBeNull();
    expect(body.transcription.engine).toContain('whisper-base.en');
    expect(body.transcription.segments.length).toBeGreaterThan(0);
    const fullText = body.transcription.segments.map((s: { text: string }) => s.text).join(' ').toLowerCase();
    expect(fullText).toContain('quarterly report');
    expect(fullText).toContain('steady growth');
    for (const segment of body.transcription.segments) {
      expect(segment.startSeconds).toBeGreaterThanOrEqual(0);
      expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
    }
    expect(body.extraction).toBeNull();

    const finalPathOnDisk = path.join(dir, body.storageRelativePath.split('/').join(path.sep));
    expect(fs.existsSync(finalPathOnDisk)).toBe(true);

    // Durable: re-reading the attachment (simulating restart restoration)
    // returns the same recorded transcription, not re-run/re-computed.
    const reread = await jsonOf(await authedFetch(`/v1/attachments/${created.id}`));
    expect(reread.transcription).toEqual(body.transcription);
  }, 60_000);

  it('uploads a real WAV audio file successfully but honestly records local transcription as unavailable when no local ASR engine is reachable', async () => {
    // Forces the honest-unavailable path deterministically, without
    // actually removing the real bundled model from disk: points the
    // built-in-engine probe at an empty directory (a legitimate
    // configuration override, not a test-only hack — see
    // core/attachments/audioProcessing.ts's builtinModelDir).
    await api.close();
    const unavailableEnv: NodeJS.ProcessEnv = { ...process.env, KARKEDIKHA_ASR_MODEL_DIR: path.join(os.tmpdir(), 'karkedikha-no-such-asr-model-dir') };
    delete unavailableEnv.KARKEDIKHA_LOCAL_ASR_COMMAND;
    api = await startTestApi(unavailableEnv);
    baseUrl = `http://127.0.0.1:${api.port}`;
    const conv = await createConversation();
    const bytes = buildMinimalWav();
    const created = await createAttachment(conv.id, { originalName: 'clip.wav', declaredMimeType: 'audio/wav', kind: 'audio', byteSize: bytes.length });
    const res = await authedFetch(`/v1/attachments/${created.id}/bytes`, {
      method: 'POST',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The bytes themselves are real, durable evidence even without
      // transcription — the attachment must still succeed.
    expect(body.status).toBe('ready');
    expect(body.detectedMimeType).toBe('audio/wav');
    expect(body.sha256).toHaveLength(64);
    expect(body.localProcessingCapability).toBe('unavailable_no_local_engine');
    expect(body.transcription).toBeNull();
    expect(body.extraction).toBeNull();

    const finalPathOnDisk = path.join(dir, body.storageRelativePath.split('/').join(path.sep));
    expect(fs.existsSync(finalPathOnDisk)).toBe(true);
  });
});
