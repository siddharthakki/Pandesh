import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { dispatchBridgeTask, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { defaultServiceRegistry, ServiceRegistry } from '../runtime/kandev/bridgeServices';
import { coreServices, detectFileType, weakestVerification } from '../runtime/kandev/bridgeCoreServices';
import { dailyBriefService } from '../runtime/kandev/bridgeBriefService';
import { classifyInstruction, WORKSPACE_MARKER } from '../runtime/kandev/intentRouter';
import type { KandevClient } from '../runtime/kandev/kandevClient';

describe('intent router: routine operations vs interpretation', () => {
  const svc = (t: string) => { const i = classifyInstruction(t); return i?.kind === 'service' ? { cls: i.taskClass, args: i.args } : null; };

  it('routes the exact task that took a 27B model 156 s to the listing service', () => {
    const r = svc('List the filenames in the authorized workspace and report the count. Do not read file contents, modify files or invoke external services.');
    expect(r).toEqual({ cls: 'filesystem.list', args: { path: WORKSPACE_MARKER } });
  });

  it('routes listing, metadata, hashing, type detection, PDF, health and search', () => {
    expect(svc('How many files are in "D:/data/inbox"?')).toMatchObject({ cls: 'filesystem.list', args: { path: 'D:/data/inbox' } });
    expect(svc('What is the file size of D:/data/report.pdf')).toMatchObject({ cls: 'filesystem.metadata' });
    expect(svc('Give me the SHA-256 of D:/data/a.zip')).toMatchObject({ cls: 'filesystem.hash' });
    expect(svc('What type of file is D:/data/blob.bin?')).toMatchObject({ cls: 'document.detect' });
    expect(svc('How many pages in the PDF D:/docs/a.pdf')).toMatchObject({ cls: 'pdf.info' });
    expect(svc('OCR the scanned PDF D:/docs/scan.pdf')).toMatchObject({ cls: 'ocr.pdf' });
    expect(svc('health check')).toMatchObject({ cls: 'service.health' });
    expect(svc('Is Ollama running?')).toMatchObject({ cls: 'service.health' });
    expect(svc('search my conversations for tailscale setup')).toMatchObject({ cls: 'search.records', args: { query: 'tailscale setup', scope: 'conversations' } });
  });

  it('routes workflows by name', () => {
    expect(classifyInstruction('Hi what is my daily brief')).toMatchObject({ kind: 'workflow', workflowId: 'daily-brief' });
    expect(classifyInstruction('run the workflow verify-file on D:/data/a.txt')).toMatchObject({ kind: 'workflow', workflowId: 'verify-file', input: { path: 'D:/data/a.txt' } });
    expect(classifyInstruction('extract the text of the PDF D:/docs/a.pdf')).toMatchObject({ kind: 'workflow', workflowId: 'extract-document' });
  });

  it('leaves interpretation, reasoning, planning, change and ambiguity to the model', () => {
    for (const t of [
      'Explain why the files in the workspace are so large',
      'Summarize the PDF D:/docs/a.pdf',
      'Compare the hash of two files and decide which to keep',
      'Delete the old files in "D:/data/inbox"',
      'Fix the failing test in the workspace',
      'List the files and recommend a cleanup plan',
      'what is the weather',
      'List the files',                       // no operand: not guessed
      'Hash my file',                          // no path
      '{"path":"D:/x"}',                       // explicit service args are handled by the explicit path
    ]) expect(classifyInstruction(t), t).toBeNull();
  });
});

describe('deterministic services', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-det-')); fs.mkdirSync(path.join(dir, 'ws')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ args, signal: new AbortController().signal, ...extra });
  const get = (id: string) => coreServices([path.join(dir, 'ws')]).find(s => s.id === id)!;

  it('fs.list counts hidden entries separately and never drops them', async () => {
    const ws = path.join(dir, 'ws');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'x'); fs.writeFileSync(path.join(ws, '.gitignore'), 'y'); fs.mkdirSync(path.join(ws, '.git')); fs.mkdirSync(path.join(ws, 'sub'));
    const out = await get('fs.list').run(ctx({ path: ws }));
    expect(out.evidence.counts).toMatchObject({ files: 1, folders: 1, hiddenFiles: 1, hiddenFolders: 1, total: 4 });
    expect((out.evidence.entries as Array<{ name: string; hidden: boolean }>).filter(e => e.hidden).map(e => e.name).sort()).toEqual(['.git', '.gitignore']);
    await expect(get('fs.list').run(ctx({ path: path.join(dir) }))).rejects.toThrow(/outside the roots/);
  });

  it('detects types from content, not from the name', async () => {
    const ws = path.join(dir, 'ws');
    fs.writeFileSync(path.join(ws, 'report.txt'), '%PDF-1.4\nfake');
    fs.writeFileSync(path.join(ws, 'notes.md'), '# hello\nworld');
    fs.writeFileSync(path.join(ws, 'data.json'), '{"a":1}');
    fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 0xff, 0xfe, 0]));
    const t = async (n: string) => (await get('doc.detect-type').run(ctx({ path: path.join(ws, n) }))).evidence;
    expect(await t('report.txt')).toMatchObject({ label: 'PDF document', basis: 'signature', mime: 'application/pdf' });
    expect(await t('notes.md')).toMatchObject({ label: 'Plain text', basis: 'text-heuristic' });
    expect(await t('data.json')).toMatchObject({ label: 'JSON document' });
    expect(await t('blob.bin')).toMatchObject({ label: 'Unknown binary' });
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'x.jpg')).toMatchObject({ label: 'PNG image', nameMatches: false });
  });

  it('fs.inspect hashes and reports metadata', async () => {
    const ws = path.join(dir, 'ws'); fs.writeFileSync(path.join(ws, 'h.txt'), 'hello');
    const inspect = defaultServiceRegistry([ws]).get('fs.inspect')!;
    const out = await inspect.run(ctx({ path: path.join(ws, 'h.txt') }));
    expect(out.evidence).toMatchObject({ bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
    expect(typeof out.evidence.modifiedAt).toBe('string');
    expect(inspect.taskClasses).toEqual(expect.arrayContaining(['filesystem.hash', 'filesystem.metadata']));
  });

  it('health reports the database and an unreachable Ollama honestly', async () => {
    const { db } = openCoreDatabase(path.join(dir, 'core.db'));
    const prev = process.env.KARKEDIKHA_OLLAMA_URL; process.env.KARKEDIKHA_OLLAMA_URL = 'http://127.0.0.1:1';
    try {
      const out = await get('svc.health').run(ctx({}, { db, host: { kandevRunning: async () => false, runWorkflow: async () => ({ status: 'completed', steps: [] }) } }));
      expect(out.evidence).toMatchObject({ database: 'ok', ollama: { reachable: false }, kandev: { running: false } });
      expect(out.summary).toMatch(/Needs attention: ollama/);
    } finally { if (prev === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = prev; db.close(); }
  });
});

describe('workflow verification level', () => {
  it('is the weakest completed step: a model summary keeps the whole run at worker-only; skipped steps do not count', () => {
    expect(weakestVerification([{ status: 'completed', verification: 'independent' }, { status: 'completed', verification: 'independent' }])).toBe('independent');
    expect(weakestVerification([{ status: 'completed', verification: 'independent' }, { status: 'completed', verification: 'worker-only' }])).toBe('worker-only');
    expect(weakestVerification([{ status: 'completed', verification: 'independent' }, { status: 'refused', verification: null }])).toBe('independent');
    expect(weakestVerification([{ status: 'completed', verification: null }])).toBe('worker-only');
  });
});

describe('dispatch: deterministic first, model for the rest', () => {
  let dir: string; let db: CoreDatabase; let pairing: BridgePairing; let nativeCalls: string[]; let rt: BridgeRuntime;
  const kandev = { healthy: async () => false, tool: async () => ({ agents: [] }) } as unknown as KandevClient;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-det2-')); fs.mkdirSync(path.join(dir, 'data'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome' }).pairing;
    nativeCalls = [];
    const roots = [path.join(dir, 'data', 'panda-workspaces')];
    const services = defaultServiceRegistry(roots); for (const s of coreServices(roots)) services.register(s); services.register(dailyBriefService());
    rt = { db, kandev, dataDir: path.join(dir, 'data'), services, executor: { execute: async (id: string) => { nativeCalls.push(id); }, cancel: () => undefined } as unknown as NonNullable<BridgeRuntime['executor']> };
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const submit = (text: string, n: number) => submitBridgeTask(db, pairing, { clientRequestId: `req-det-${String(n).padStart(4, '0')}`, instruction: text }).task;
  const until = async (pred: () => boolean) => { for (let i = 0; i < 300 && !pred(); i++) await new Promise(r => setTimeout(r, 20)); };

  it('"list the files and report the count" runs the filesystem service, not the model', async () => {
    const t = submit('List the filenames in the authorized workspace and report the count. Do not read file contents, modify files or invoke external services.', 1);
    const r = await dispatchBridgeTask(rt, t.id, { executor: 'auto', decidedBy: 'test', authority: 'extension' });
    expect(r.started).toBe(true);
    await until(() => getBridgeTask(db, t.id).status === 'completed');
    const done = getBridgeTask(db, t.id);
    expect(done).toMatchObject({ executor: 'service:fs.list', routing: 'auto', status: 'completed' });
    expect(done.result?.verification).toBe('independent');
    const ev = JSON.parse(done.result!.evidence!);
    expect(ev.counts).toMatchObject({ files: 2, folders: 0, hiddenFiles: 1, hiddenFolders: 1, total: 4 }); // package.json, README.md, .gitignore, .git
    expect(nativeCalls).toHaveLength(0);
    expect(done.statusDetail).toBeTruthy();
  });

  it('a request that needs interpretation still goes to the local model', async () => {
    const t = submit('Explain why my build is failing and plan a fix', 2);
    // Which local agent takes it depends on what is installed on this PC (and the fake Kandev cannot start one); what matters is that no service did.
    await dispatchBridgeTask(rt, t.id, { executor: 'auto', decidedBy: 'test', authority: 'extension' }).catch(() => undefined);
    const executor = getBridgeTask(db, t.id).executor;
    expect(executor).toBeTruthy();
    expect(executor!.startsWith('service:')).toBe(false);
  });

  it('the daily brief runs as the registered workflow with child bridge tasks, not a research mission', async () => {
    const t = submit('Hi what is my daily brief', 3);
    // No model executor here: the optional summary step is skipped and the collected data is the result.
    const noModel: BridgeRuntime = { ...rt, executor: undefined };
    await dispatchBridgeTask(noModel, t.id, { executor: 'auto', decidedBy: 'test', authority: 'extension' });
    await until(() => ['completed', 'failed'].includes(getBridgeTask(db, t.id).status));
    const done = getBridgeTask(db, t.id);
    expect(done.executor).toBe('service:workflow.run');
    expect(done.status).toBe('completed');
    const ev = JSON.parse(done.result!.evidence!);
    expect(ev.workflow).toBe('daily-brief');
    expect(ev.steps[0]).toMatchObject({ name: 'collect', executor: 'service:brief.daily', status: 'completed' });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM missions')!.n).toBe(0);
  });

  it('an explicit executor choice is never rerouted by the intent router', async () => {
    const t = submit('List the filenames in the authorized workspace and report the count.', 4);
    await dispatchBridgeTask(rt, t.id, { executor: 'native', decidedBy: 'test', authority: 'extension' });
    expect(getBridgeTask(db, t.id)).toMatchObject({ executor: 'native', routing: 'explicit' });
    expect(nativeCalls).toHaveLength(1);
  });
});

void ServiceRegistry;
