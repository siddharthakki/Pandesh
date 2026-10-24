import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import { clearVisionCapabilityCache } from '../src/host/desktopVision';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const NOTES = Buffer.from('Quarterly notes\n- ship the thing\n', 'utf8');

let dataDir: string;
let host: DesktopSession;
let submits: Array<Record<string, any>>;
let uploads: Array<{ id: string; bytes: number }>;
let createdAttachments: Array<Record<string, any>>;

type Internals = { client: unknown; coreState: string; provider: unknown; modelAvailable: boolean; installedModels: string[]; operatorSelectedModel: string; refreshProvider(): void; refreshProviderSoft(): void; refreshModelAvailability(): Promise<void> };

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    createConversation: async () => ({ id: 'conv-1' }),
    createAttachment: async (_conv: string, input: Record<string, any>) => {
      createdAttachments.push(input);
      return { id: `att-${createdAttachments.length}`, status: 'uploading' };
    },
    uploadAttachmentBytes: async (id: string, stream: NodeJS.ReadableStream) => {
      let bytes = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) bytes += chunk.length;
      uploads.push({ id, bytes });
      return { id, status: 'ready' };
    },
    submit: async (input: Record<string, any>) => {
      submits.push(input);
      return {
        request: { id: 'req-1' }, attempt: { id: 'att-run-1' }, planningOnly: false, messageId: 'm1',
        modelSelection: input.modelSelection ?? { selectedModel: 'auto-picked', requiredCapabilities: {} },
      };
    },
    listArtifacts: async () => ({ artifacts: [] }),
    executeAttempt: async () => ({}),
    ...overrides,
  };
}

beforeEach(() => {
  clearVisionCapabilityCache();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-attach-session-'));
  submits = []; uploads = []; createdAttachments = [];
  host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  const internal = host as unknown as Internals;
  internal.client = fakeClient();
  internal.coreState = 'connected';
  internal.provider = { model: 'lfm:24b', apiBase: 'http://127.0.0.1:11434', source: 'test' };
  internal.modelAvailable = true;
  internal.installedModels = ['lfm:24b', 'gemma4:12b'];
  internal.operatorSelectedModel = 'lfm:24b';
  vi.spyOn(internal, 'refreshProvider').mockImplementation(() => undefined);
  vi.spyOn(internal, 'refreshProviderSoft').mockImplementation(() => undefined);
  vi.spyOn(internal, 'refreshModelAvailability').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    if (String(url).includes('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'lfm:24b' }, { name: 'gemma4:12b' }] }) };
    }
    const model = init?.body ? String(JSON.parse(String(init.body)).model) : '';
    const caps: Record<string, string[]> = { 'lfm:24b': ['completion', 'tools'], 'gemma4:12b': ['completion', 'vision', 'tools'] };
    return { ok: true, json: async () => ({ capabilities: caps[model] ?? [] }) };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('sending attachments through the existing Core pipeline', () => {
  it('stages files, uploads each through Core, submits with the attachment ids, and clears the composer', async () => {
    host.stageAttachmentBytes('notes.txt', NOTES);
    expect(host.snapshot().stagedAttachments).toHaveLength(1);
    await host.submitTask('Summarize my notes');
    expect(createdAttachments).toEqual([{ originalName: 'notes.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: NOTES.length }]);
    expect(uploads).toEqual([{ id: 'att-1', bytes: NOTES.length }]);
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ currentMessage: 'Summarize my notes', conversationId: 'conv-1', attachmentIds: ['att-1'] });
    expect(host.snapshot().stagedAttachments).toEqual([]);
    expect(fs.readdirSync(path.join(dataDir, 'attachment-staging'))).toEqual([]); // bytes live in Core now
  });

  it('a text-only model that cannot see images is replaced for that message by an installed vision model, and the host says so', async () => {
    host.stageAttachmentBytes('screenshot.png', PNG);
    await host.submitTask('What is in this picture?');
    expect(submits[0].requestedModel).toBe('gemma4:12b');
    expect(submits[0].modelSelection.requiredCapabilities.vision).toBe(true);
    expect(submits[0].modelSelection.userOverrode).toBe(true);
    expect(host.snapshot().model).toBe('gemma4:12b');
    expect(host.snapshot().modelNote).toContain("can't see images");
  });

  it('keeps a vision-capable selected model, and never claims an override', async () => {
    const internal = host as unknown as Internals;
    internal.provider = { model: 'gemma4:12b', apiBase: 'http://127.0.0.1:11434', source: 'test' };
    internal.operatorSelectedModel = 'gemma4:12b';
    host.stageAttachmentBytes('screenshot.png', PNG);
    await host.submitTask('Describe it');
    expect(submits[0].requestedModel).toBe('gemma4:12b');
    expect(host.snapshot().modelNote).toBeNull(); // the person's own choice needs no explanation
  });

  it('refuses plainly when no installed model can see images, and keeps the files in the composer', async () => {
    (host as unknown as Internals).installedModels = ['lfm:24b'];
    host.stageAttachmentBytes('screenshot.png', PNG);
    await expect(host.submitTask('What is this?')).rejects.toThrow(/None of your installed models can see images/);
    expect(submits).toHaveLength(0);
    expect(host.snapshot().stagedAttachments).toHaveLength(1);
  });

  it('if an upload fails the message is not sent and the file is restored for another try', async () => {
    (host as unknown as Internals).client = fakeClient({
      uploadAttachmentBytes: async () => { throw new Error('file is not what it claims to be'); },
    });
    host.stageAttachmentBytes('notes.txt', NOTES);
    await expect(host.submitTask('Read this')).rejects.toThrow(/Could not attach "notes.txt": file is not what it claims to be/);
    expect(submits).toHaveLength(0);
    expect(host.snapshot().stagedAttachments!.map((a) => a.name)).toEqual(['notes.txt']);
  });

  it('if Core refuses the message after the upload, the staged file comes back too', async () => {
    (host as unknown as Internals).client = fakeClient({ submit: async () => { throw new Error('Core is busy'); } });
    host.stageAttachmentBytes('notes.txt', NOTES);
    await expect(host.submitTask('Read this')).rejects.toThrow(/Core is busy/);
    expect(host.snapshot().stagedAttachments!.map((a) => a.name)).toEqual(['notes.txt']);
  });

  it('a message without attachments is untouched (no attachmentIds, Auto routing preserved)', async () => {
    (host as unknown as Internals).operatorSelectedModel = '__auto__';
    await host.submitTask('hello there');
    expect(submits[0]).not.toHaveProperty('attachmentIds');
    expect(submits[0].autoSelectModel).toBe(true);
    expect(host.snapshot().modelNote).toBeNull();
  });

  it('removing a staged file before sending leaves nothing to upload', async () => {
    const view = host.stageAttachmentBytes('notes.txt', NOTES);
    host.removeStagedAttachment(view.id);
    await host.submitTask('never mind the file');
    expect(createdAttachments).toEqual([]);
    expect(submits[0]).not.toHaveProperty('attachmentIds');
  });
});
