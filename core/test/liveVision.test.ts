/**
 * Opt-in LIVE vision proof (KKD_LIVE_VISION=1): a real image travels the production path
 * attachment upload -> Core submit/freeze -> executor.applyAttachments -> OllamaModelBackend -> a real local vision model,
 * and the answer must come from the pixels (a solid red square on white). No simulated captions, no mock backend.
 *
 *   KKD_LIVE_VISION=1 KKD_LIVE_VISION_MODEL=qwen3.5:0.8b npx vitest run core/test/liveVision.test.ts
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { openCoreDatabase } from '../db/openCore';
import { startApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { OllamaModelBackend } from '../runtime/modelBackend';

const LIVE = process.env.KKD_LIVE_VISION === '1';
const MODEL = process.env.KKD_LIVE_VISION_MODEL ?? 'qwen3.5:0.8b';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 96x96 RGB PNG: white background with one solid red square in the middle. */
function redSquarePng(): Buffer {
  const size = 96;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3, 255);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      if (x >= 24 && x < 72 && y >= 24 && y < 72) { row[1 + x * 3] = 220; row[2 + x * 3] = 0; row[3 + x * 3] = 0; }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

describe.skipIf(!LIVE)('LIVE: a real image reaches a real local vision model through the production path', () => {
  it('answers from the pixels', async () => {
    const token = generateToken();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-live-vision-'));
    const db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const api = await startApiServer({
      db, token, broadcaster: new EventBroadcaster(), dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'live', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: { backend: new OllamaModelBackend('http://127.0.0.1:11434'), defaultModel: MODEL, dataDir: dir },
    });
    const base = `http://127.0.0.1:${api.port}`;
    let n = 0;
    const call = async (url: string, init: RequestInit & { idem?: boolean } = {}) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'X-Client-Id': 'live', ...(init.headers as Record<string, string> | undefined) };
      if (init.body !== undefined && !(init.body instanceof Uint8Array)) headers['Content-Type'] = 'application/json';
      if (init.method === 'POST') headers['Idempotency-Key'] = `live-${++n}`;
      const res = await fetch(`${base}${url}`, { ...init, headers });
      const body = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
      return body;
    };
    try {
      const conv = await call('/v1/conversations', { method: 'POST', body: JSON.stringify({ mode: 'baat_kar' }) });
      const png = redSquarePng();
      const created = await call(`/v1/conversations/${conv.id}/attachments`, { method: 'POST', body: JSON.stringify({ originalName: 'square.png', declaredMimeType: 'image/png', kind: 'image', byteSize: png.length }) });
      await call(`/v1/attachments/${created.id}/bytes`, { method: 'POST', body: new Uint8Array(png), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(png.length) } });
      const selection = {
        requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false, codingComplexity: 'none', contextRequirement: 'small', vision: true, validationAndRepair: false },
        selectedProvider: 'ollama', selectedModel: MODEL, selectionReason: 'live', suitabilitySummary: 'live', userOverrode: true, candidates: [], escalationCandidates: [],
      };
      const submission = await call('/v1/submit', { method: 'POST', body: JSON.stringify({ currentMessage: 'What colour is the square in this image? Answer with one word.', requestedMode: 'baat_kar', conversationId: conv.id, attachmentIds: [created.id], modelSelection: selection }) });
      await call(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST' });
      let attempt: any;
      for (const deadline = Date.now() + 240_000; Date.now() < deadline;) {
        attempt = await (await fetch(`${base}/v1/attempts/${submission.attempt.id}`, { headers: { Authorization: `Bearer ${token}`, 'X-Client-Id': 'live' } })).json();
        if (['completed', 'failed'].includes(attempt.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      expect(attempt.status, JSON.stringify(attempt.failureReason ?? '')).toBe('completed');
      const messages = (await call(`/v1/conversations/${conv.id}/messages`)).messages as Array<{ role: string; content: string }>;
      const answer = messages.filter(m => m.role === 'assistant').at(-1)!.content;
      console.log('[live-vision] model=%s answer=%s', MODEL, JSON.stringify(answer.slice(0, 300)));
      expect(answer.toLowerCase()).toContain('red');
    } finally {
      await api.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 280_000);
});
