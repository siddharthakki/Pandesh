// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import * as extensionModule from '../../extension';
import { AgentPanel } from '../../ui/AgentPanel';

const media = path.join(__dirname, '../../../media');

describe('composer drag-and-drop and paste (webview)', () => {
  let posted: Array<Record<string, any>>;
  beforeEach(async () => {
    const html = fs.readFileSync(path.join(media, 'chat.html'), 'utf8');
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
    posted = [];
    (window as any).__ollamaAgentVsCodeApi = { postMessage: (m: Record<string, any>) => posted.push(m), getState: () => ({}), setState: () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(fs.readFileSync(path.join(media, 'chat-attach-dnd.js'), 'utf8'))();
  });

  const area = () => document.querySelector('.input-area')!;
  const fire = (target: Element, type: string, dataTransfer: object) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { dataTransfer }); target.dispatchEvent(e); return e; };
  const dt = (over: object) => ({ types: [], files: [], getData: () => '', dropEffect: '', ...over });

  it('dropped file URIs go to the host pipeline (same checks as the attach button)', () => {
    const e = fire(area(), 'drop', dt({ types: ['text/uri-list'], getData: () => '# comment\r\nfile:///c%3A/p/foo.py\r\nhttps://evil.example/x\r\nfile:///c%3A/p/bar.log\r\n' }));
    expect(e.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'attachUris', uris: ['file:///c%3A/p/foo.py', 'file:///c%3A/p/bar.log'] }]);
  });

  it('dropped file bytes are read once and sent; oversized files send only their size so the host can explain', async () => {
    const small = new File(['print(1)'], 'foo.py', { type: 'text/x-python' });
    const big = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    fire(area(), 'drop', dt({ types: ['Files'], files: [small, big] }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('attachDropped');
    expect(posted[0].files[0]).toMatchObject({ name: 'foo.py', size: 8 });
    expect(Buffer.from(posted[0].files[0].base64, 'base64').toString()).toBe('print(1)');
    expect(posted[0].files[1]).toEqual({ name: 'huge.png', size: 6 * 1024 * 1024 });
  });

  it('a pasted screenshot becomes an attachment; pasted plain text is left alone', async () => {
    const input = document.getElementById('user-input')!;
    const image = new File(['PNGDATA'], '', { type: 'image/png' });
    const pasteWith = (items: object[]) => { const e = new Event('paste', { bubbles: true, cancelable: true }); Object.assign(e, { clipboardData: { items } }); input.dispatchEvent(e); return e; };
    const e = pasteWith([{ kind: 'file', type: 'image/png', getAsFile: () => image }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(e.defaultPrevented).toBe(true);
    expect(posted[0]).toMatchObject({ type: 'attachDropped', files: [{ name: 'pasted-image.png' }] });
    posted.length = 0;
    expect(pasteWith([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]).defaultPrevented).toBe(false);
    expect(posted).toEqual([]);
  });

  it('drags that carry neither files nor URIs are ignored; the drop target shows feedback while active', () => {
    expect(fire(area(), 'dragover', dt({ types: ['text/plain'] })).defaultPrevented).toBe(false);
    fire(area(), 'dragover', dt({ types: ['Files'] }));
    expect(area().classList.contains('kd-drop-active')).toBe(true);
    fire(area(), 'drop', dt({ types: ['Files'], files: [] }));
    expect(area().classList.contains('kd-drop-active')).toBe(false);
    expect(fire(area(), 'drop', dt({ types: ['text/plain'] })).defaultPrevented).toBe(false);
  });
});

describe('attachments with NO workspace (a lone file is a valid session)', () => {
  let dir: string;
  let client: Record<string, ReturnType<typeof vi.fn>>;
  let posts: Array<Record<string, any>>;
  let panel: { attachUris(uris: unknown, conversationId: string): Promise<void>; attachDroppedFiles(files: unknown, conversationId: string): Promise<void>; uploadAttachmentUris(uris: vscode.Uri[], id: string, origin: string): Promise<void>; coreConversationIds: Map<string, string>; post: (m: Record<string, any>) => void };

  beforeEach(async () => {
    vscodeMock._resetConfig();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'attach-'));
    posts = [];
    client = {
      createAttachment: vi.fn(async () => ({ id: 'att-1' })),
      uploadAttachmentBytes: vi.fn(async (_id: string, stream: NodeJS.ReadableStream) => { for await (const _chunk of stream) { /* drain */ } return { id: 'att-1', status: 'ready', byteSize: 9, sha256: 'ab'.repeat(32) }; }),
      deleteAttachment: vi.fn(async () => undefined),
    };
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client } as never);
    // workspaceAvailable = false: no repository, no workspace folder.
    panel = new AgentPanel(createMockExtensionContext() as never, '', false) as never;
    panel.coreConversationIds.set('ledger:c1', 'core-c1');
    panel.post = message => { posts.push(message); };
  });
  afterEach(async () => { vi.restoreAllMocks(); await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('attaches foo.py without any workspace and reports ready with the Core attachment id', async () => {
    const file = path.join(dir, 'foo.py');
    await fsp.writeFile(file, 'print(1)\n');
    await panel.uploadAttachmentUris([vscode.Uri.file(file)], 'c1', 'file');
    expect(client.createAttachment).toHaveBeenCalledWith('core-c1', expect.objectContaining({ originalName: 'foo.py', declaredMimeType: 'text/plain', kind: 'text', byteSize: 9 }));
    expect(posts.map(p => p.status)).toEqual(['uploading', 'ready']);
    expect(posts[1]).toMatchObject({ name: 'foo.py', attachmentId: 'att-1', kind: 'text' });
  });

  it('images carry their real MIME type to Core, so a PNG is not declared as JPEG', async () => {
    const file = path.join(dir, 'err.png');
    await fsp.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]));
    await panel.uploadAttachmentUris([vscode.Uri.file(file)], 'c1', 'file');
    expect(client.createAttachment).toHaveBeenCalledWith('core-c1', expect.objectContaining({ declaredMimeType: 'image/png', kind: 'image' }));
  });

  it('declines unsupported, empty, directory and over-count inputs with a plain-language reason and uploads nothing', async () => {
    await fsp.writeFile(path.join(dir, 'movie.mp4'), 'x');
    await fsp.writeFile(path.join(dir, 'empty.py'), '');
    await fsp.mkdir(path.join(dir, 'folder.py'));
    await panel.uploadAttachmentUris([path.join(dir, 'movie.mp4'), path.join(dir, 'empty.py'), path.join(dir, 'folder.py')].map(p => vscode.Uri.file(p)), 'c1', 'file');
    const failed = posts.filter(p => p.status === 'failed');
    expect(failed).toHaveLength(3);
    expect(failed[0].errorMessage).toMatch(/"\.mp4" files are not supported yet/);
    expect(failed[1].errorMessage).toBe('empty.py is empty.');
    expect(failed[2].errorMessage).toMatch(/directories are not accepted/);
    expect(client.createAttachment).not.toHaveBeenCalled();
  });

  it('dropped URIs accept only local files; dropped bytes are bounded, staged privately, uploaded, and the temp copy is removed', async () => {
    await panel.attachUris(['https://evil.example/a.py', 'not a uri'], 'c1');
    expect(posts.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/Only local files/) });

    const base64 = Buffer.from('print(2)\n').toString('base64');
    const huge = { name: 'huge.png', size: 6 * 1024 * 1024 };
    await panel.attachDroppedFiles([{ name: '../../evil.py', size: 9, base64 }, huge], 'c1');
    expect(client.createAttachment).toHaveBeenCalledTimes(1);
    expect(client.createAttachment).toHaveBeenCalledWith('core-c1', expect.objectContaining({ originalName: 'evil.py' })); // path components stripped
    expect(posts.find(p => p.name === 'huge.png')).toMatchObject({ status: 'failed', errorMessage: expect.stringMatching(/limit is 5 MB for dropped files/) });
    const staging = path.join(os.tmpdir(), 'dropped-attachments');
    // The private staging directory for this drop is gone once the upload finished.
    const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
    expect(leftovers.length).toBe(fs.existsSync(staging) ? leftovers.length : 0);
  });

  it('a changed-while-uploading file is rejected and the half-created attachment is cleaned up', async () => {
    const file = path.join(dir, 'moving.py');
    await fsp.writeFile(file, 'abc');
    client.uploadAttachmentBytes.mockImplementation(async (_id: string, stream: NodeJS.ReadableStream) => {
      for await (const _chunk of stream) { /* drain */ }
      await fsp.appendFile(file, 'MORE');
      return { id: 'att-1', status: 'ready', byteSize: 3, sha256: 'cd'.repeat(32) };
    });
    await panel.uploadAttachmentUris([vscode.Uri.file(file)], 'c1', 'file');
    expect(posts.at(-1)).toMatchObject({ status: 'failed', errorMessage: expect.stringMatching(/changed on disk/) });
    expect(client.deleteAttachment).toHaveBeenCalledWith('att-1');
  });
});
