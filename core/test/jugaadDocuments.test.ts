import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import type { SecretProtector } from '../platform/osSecretProtector';
import { CompanionServerController, writeCompanionSettings } from '../api/companionServer';
import { createCompanionPairingCode, openCompanionMessage, pairingKey, pairingProof, revokeCompanionDevice, sealCompanionMessage } from '../domain/companionSync';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask } from '../domain/pandaBridge';
import { dispatchBridgeTask, discoverExecutors, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { bridgeServices } from '../runtime/kandev/bridgeServices';
import type { KandevClient } from '../runtime/kandev/kandevClient';
import { attachDevice, createHousehold, householdDirs } from '../runtime/jugaad/households';
import { closeHouseholdIndexes } from '../runtime/jugaad/documentIndex';
import { jugaadServices } from '../runtime/jugaad/jugaadServices';
import { parseAmountCents, parseReceiptText } from '../runtime/jugaad/receiptParser';
import { resolveOcrTools } from '../runtime/documentOcr';

const protector = (): SecretProtector => {
  const k = crypto.createHash('sha256').update('jugaad-test').digest();
  return {
    kind: 'test store',
    async protect(plain: Buffer) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv); return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]); },
    async unprotect(blob: Buffer) { const d = crypto.createDecipheriv('aes-256-gcm', k, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(blob.length - 16)); return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]); },
  };
};

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

/** A JUGAAD phone speaking the real protocol: TLS to the listener, pinned certificate, sealed calls with nonces. */
class Phone {
  private key!: Buffer; private fingerprint!: string; private cert!: string;
  constructor(readonly port: number, readonly dir: string, readonly deviceId: string) {}
  private post(urlPath: string, body: unknown, pin: boolean): Promise<{ status: number; json: any; peer: string | null }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const opts: https.RequestOptions = { host: '127.0.0.1', port: this.port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15_000,
        ...(pin ? { ca: this.cert, checkServerIdentity: (_h: string, c: any) => (c.fingerprint256.replace(/:/g, '').toLowerCase() === this.fingerprint ? undefined : new Error('pin mismatch')) } : { rejectUnauthorized: false }) };
      const req = https.request(opts, (res) => {
        const peer = (res.socket as import('node:tls').TLSSocket).getPeerCertificate?.();
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null, peer: peer?.fingerprint256 ? peer.fingerprint256.replace(/:/g, '').toLowerCase() : null }));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(data);
    });
  }
  async pair(): Promise<void> {
    const { code } = createCompanionPairingCode();
    const salt = crypto.randomBytes(16); const pk = pairingKey(code, salt);
    const r = await this.post('/companion/v1/pair', { deviceId: this.deviceId, label: 'Test phone', salt: salt.toString('base64'), proof: pairingProof(pk, this.deviceId).toString('base64') }, false);
    if (r.status !== 200) throw new Error(`pairing failed: ${JSON.stringify(r.json)}`);
    const opened = JSON.parse(openCompanionMessage(pk, `${this.deviceId}:pair`, r.json.sealedKey)) as { deviceKey: string; tlsFingerprint: string };
    this.key = Buffer.from(opened.deviceKey, 'base64'); this.fingerprint = opened.tlsFingerprint;
    this.cert = JSON.parse(fs.readFileSync(path.join(this.dir, 'companion-tls.json'), 'utf8')).certPem;
    if (r.peer !== this.fingerprint) throw new Error('certificate pin mismatch at pairing');
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string; http: number }> {
    const nonce = crypto.randomBytes(12).toString('base64url');
    const sealed = sealCompanionMessage(this.key, this.deviceId, JSON.stringify({ method, params, ts: Date.now(), nonce }));
    const r = await this.post('/companion/v1/rpc', { d: this.deviceId, ...sealed }, true);
    if (r.status !== 200) return { ok: false, error: r.json?.error, http: r.status };
    const reply = JSON.parse(openCompanionMessage(this.key, `${this.deviceId}:resp`, r.json.sealed));
    return { ok: reply.ok, result: reply.result, error: reply.error, http: 200 };
  }
  /** Uploads `bytes` in chunks of `chunk` bytes, optionally stopping early (a dropped connection). Returns the last reply. */
  async upload(uploadId: string, name: string, bytes: Buffer, opts: { chunk?: number; stopAfterChunks?: number; startOffset?: number } = {}): Promise<any> {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let offset = opts.startOffset ?? 0; let sent = 0; let last: any = null;
    for (;;) {
      const data = bytes.subarray(offset, offset + (opts.chunk ?? 40_000));
      const r = await this.call('doc.put', { uploadId, name, size: bytes.length, sha256, offset, data: data.toString('base64') });
      if (!r.ok) return { error: r.error };
      last = r.result; sent += 1;
      if (last.status === 'complete' || last.status === 'duplicate') return last;
      offset = last.received;
      if (opts.stopAfterChunks && sent >= opts.stopAfterChunks) return last;
    }
  }
  async waitTask(taskId: string, ms = 15_000): Promise<any> {
    const end = Date.now() + ms;
    for (;;) {
      const r = await this.call('doc.status', { taskId });
      if (r.ok && ['completed', 'failed', 'cancelled'].includes(r.result.status)) return r.result;
      if (Date.now() > end) throw new Error(`task ${taskId} did not finish: ${JSON.stringify(r)}`);
      await new Promise(res => setTimeout(res, 100));
    }
  }
}

const RECEIPT = ['REWE Markt GmbH', 'Musterstrasse 1, 10115 Berlin', 'Kassenbon', 'Datum: 14.11.2026', 'Milch 1,19', 'Brot 2,49', 'Summe EUR 3,68', 'MwSt 7% 0,24', 'Vielen Dank'].join('\n');
const INVOICE = ['Telekom Deutschland GmbH', 'Rechnung', 'Rechnungsnummer: RE-2026-88123', 'Rechnungsdatum: 02.11.2026', 'Mobilfunk Grundpreis', 'Gesamtbetrag 1.234,56 EUR', 'enthaltene MwSt 19% 197,12 EUR'].join('\n');

describe('receipt parser (rules, no model)', () => {
  it('parses amounts in German and English notation', () => {
    expect(parseAmountCents('1.234,56')).toBe(123456);
    expect(parseAmountCents('1,234.56')).toBe(123456);
    expect(parseAmountCents('12,5')).toBe(1250);
    expect(parseAmountCents('12.50')).toBe(1250);
    expect(parseAmountCents('1.234')).toBe(123400);
    expect(parseAmountCents('7')).toBe(700);
    expect(parseAmountCents('abc')).toBeNull();
    expect(parseAmountCents('1,2,3')).toBeNull();
  });
  it('reads a supermarket receipt', () => {
    expect(parseReceiptText(RECEIPT)).toMatchObject({ kind: 'receipt', merchant: 'REWE Markt GmbH', date: '2026-11-14', totalCents: 368, currency: 'EUR', vatCents: 24 });
  });
  it('reads an invoice and says which rules matched; unknown fields stay absent', () => {
    const r = parseReceiptText(INVOICE);
    expect(r).toMatchObject({ kind: 'invoice', merchant: 'Telekom Deutschland GmbH', date: '2026-11-02', totalCents: 123456, vatCents: 19712, invoiceNumber: 'RE-2026-88123' });
    expect(r.matchedBy).toEqual(expect.arrayContaining(['total:gesamtbetrag', 'invoice-number', 'date:labelled']));
    const none = parseReceiptText('hello world, nothing to see');
    expect(none.totalCents).toBeUndefined();
    expect(none.date).toBeUndefined();
    expect(none.kind).toBe('other');
  });
  it('rejects impossible dates instead of guessing', () => {
    expect(parseReceiptText('Datum: 31.02.2026\nSumme 5,00 EUR').date).toBeUndefined();
  });
});

describe('JUGAAD documents over the real companion protocol', () => {
  let dir: string; let db: CoreDatabase; let controller: CompanionServerController; let port: number; let prevKandev: string | undefined;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jugaad-')); ({ db } = openCoreDatabase(path.join(dir, 'core.db')));
    prevKandev = process.env.KARKEDIKHA_KANDEV_HOME; process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'no-kandev');
    port = await freePort(); writeCompanionSettings(dir, { enabled: true, bind: 'loopback', port });
    controller = new CompanionServerController(db, dir, () => undefined, protector()); await controller.apply();
  });
  afterEach(async () => {
    await controller.close(); closeHouseholdIndexes(); db.close();
    if (prevKandev === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prevKandev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const phone = async (id: string, household?: string) => { const p = new Phone(port, dir, id); await p.pair(); if (household) attachDevice(dir, id, household); return p; };

  it('a paired phone with no household can use none of the document services', async () => {
    const p = await phone('phone-nohousehold-1');
    expect((await p.call('household.info')).result).toEqual({ household: null });
    for (const m of ['doc.put', 'doc.search', 'doc.list', 'doc.status']) {
      const r = await p.call(m, { q: 'x', uploadId: 'upload-aaaaaaaa', name: 'a.txt', size: 1, sha256: '0'.repeat(64), offset: 0, taskId: 'x' });
      expect(r.ok, m).toBe(false); expect(r.error, m).toMatch(/not attached to a household/);
    }
  });

  it('end to end: upload in chunks -> tracked intake task -> fields -> search; phone sees a record and the task status', async () => {
    const hh = createHousehold(dir, 'Kitamura');
    const p = await phone('phone-kitamura-01', hh.id);
    expect((await p.call('household.info')).result.household).toMatchObject({ id: hh.id, name: 'Kitamura' });
    const bytes = Buffer.from(RECEIPT, 'utf8');
    const done = await p.upload('upl-receipt-0001', 'rewe-2026-11-14.txt', bytes, { chunk: 40 });
    expect(done).toMatchObject({ status: 'complete' });
    expect(done.taskId).toMatch(/^ptask_/);
    const final = await p.waitTask(done.taskId);
    expect(final).toMatchObject({ status: 'completed', verification: 'independent' });
    const doc = (await p.call('doc.get', { documentId: final.documentId })).result.document;
    expect(doc).toMatchObject({ name: 'rewe-2026-11-14.txt', textSource: 'plain', fields: { kind: 'receipt', merchant: 'REWE Markt GmbH', date: '2026-11-14', totalCents: 368, currency: 'EUR' } });
    const hits = (await p.call('doc.search', { q: 'milch brot' })).result.hits;
    expect(hits).toHaveLength(1); expect(hits[0].snippet).toMatch(/\[Milch\]/i);
    expect((await p.call('doc.search', { q: 'telekom' })).result.hits).toEqual([]);
    // Phone sync: the household-scoped reference and task status arrive through the normal pull.
    const pulled = (await p.call('pull', { since: 0 })).result.records as Array<{ recordId: string; kind: string; payload: any }>;
    expect(pulled.find(r => r.kind === 'document_ref')!.payload).toMatchObject({ documentId: final.documentId, merchant: 'REWE Markt GmbH', totalCents: 368 });
    expect(pulled.find(r => r.kind === 'task_status')!.payload).toMatchObject({ taskId: done.taskId, state: 'completed', workflow: 'document-intake' });
    // The task is a normal bridge task, no model and no external transfer involved.
    const task = getBridgeTask(db, done.taskId);
    expect(task).toMatchObject({ executor: 'service:jugaad.ingest', status: 'completed', externalConsent: null });
    // The host-visible evidence carries the pipeline steps (provenance) but no absolute path.
    expect(task.result!.evidence).toMatch(/"step":"detect"/); expect(task.result!.evidence).not.toMatch(/[A-Za-z]:[\\/]/);
  }, 60_000);

  it('household isolation: another household sees none of it, by search, id, task status or sync', async () => {
    const a = createHousehold(dir, 'Alpha'); const b = createHousehold(dir, 'Bravo');
    const pa = await phone('phone-alpha-0001', a.id); const pb = await phone('phone-bravo-0001', b.id);
    const up = await pa.upload('upl-iso-00001', 'secret-invoice.txt', Buffer.from(INVOICE));
    const fin = await pa.waitTask(up.taskId);
    expect((await pb.call('doc.search', { q: 'telekom rechnung' })).result.hits).toEqual([]);
    expect((await pb.call('doc.list')).result.documents).toEqual([]);
    expect((await pb.call('doc.get', { documentId: fin.documentId })).ok).toBe(false);
    const st = await pb.call('doc.status', { taskId: up.taskId });
    expect(st.ok).toBe(false); expect(st.error).toMatch(/not found/);
    const pulledB = (await pb.call('pull', { since: 0 })).result;
    expect(pulledB.records.filter((r: any) => String(r.recordId).startsWith('hh_'))).toEqual([]);
    expect(pulledB.nextSince).toBeGreaterThan(0); // the cursor still advances over records it may not see
    expect(fs.existsSync(householdDirs(dir, b.id).inbox) && fs.readdirSync(householdDirs(dir, b.id).inbox)).toEqual([]);
    // A phone cannot name another household: unknown parameters are ignored, the household always comes from the device.
    expect((await pb.call('doc.search', { q: 'telekom', householdId: a.id })).result.hits).toEqual([]);
  }, 60_000);

  it('offline and flaky link: resumes from the server offset, tolerates repeats, deduplicates and verifies the hash', async () => {
    const hh = createHousehold(dir, 'Offline'); const p = await phone('phone-offline-001', hh.id);
    const bytes = Buffer.from(Array.from({ length: 30 }, (_, i) => `Zeile ${i} Summe EUR ${i + 1},00`).join('\n') + '\n' + RECEIPT);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    // 1. the phone gets two chunks through, then loses the connection
    const partial = await p.upload('upl-offline-001', 'later.txt', bytes, { chunk: 100, stopAfterChunks: 2 });
    expect(partial).toEqual({ status: 'continue', received: 200 });
    // 2. it comes back believing nothing was sent (response lost): the server says where it really is
    const again = await p.call('doc.put', { uploadId: 'upl-offline-001', name: 'later.txt', size: bytes.length, sha256: sha, offset: 0, data: bytes.subarray(0, 100).toString('base64') });
    expect(again.result).toEqual({ status: 'resume', received: 200 });
    // 3. a chunk from the future is refused, not guessed at
    expect((await p.call('doc.put', { uploadId: 'upl-offline-001', name: 'later.txt', size: bytes.length, sha256: sha, offset: 300, data: 'AAAA' })).result).toEqual({ status: 'resume', received: 200 });
    // 4. continues from the server's offset and completes exactly once
    const done = await p.upload('upl-offline-001', 'later.txt', bytes, { chunk: 100, startOffset: 200 });
    expect(done.status).toBe('complete');
    const fin = await p.waitTask(done.taskId); expect(fin.status).toBe('completed');
    // 5. sending the same content again under a new upload id is recognised by hash before any bytes move
    expect(await p.upload('upl-offline-002', 'later-copy.txt', bytes)).toEqual({ status: 'duplicate', documentId: fin.documentId });
    expect((await p.call('doc.list')).result.documents).toHaveLength(1);
    // 6. a corrupted transfer is rejected and leaves nothing behind
    const bad = Buffer.from('this is not what was announced');
    const wrongSha = crypto.createHash('sha256').update('something else').digest('hex');
    const r = await p.call('doc.put', { uploadId: 'upl-corrupt-001', name: 'bad.txt', size: bad.length, sha256: wrongSha, offset: 0, data: bad.toString('base64') });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/does not match its SHA-256/);
    expect(fs.readdirSync(householdDirs(dir, hh.id).uploads)).toEqual([]);
    expect(fs.readdirSync(householdDirs(dir, hh.id).inbox).filter(f => f.includes('bad'))).toEqual([]);
    // 7. an upload id cannot be reused for a different file
    await p.call('doc.put', { uploadId: 'upl-reuse-0001', name: 'a.txt', size: 500, sha256: '1'.repeat(64), offset: 0, data: Buffer.from('x').toString('base64') });
    const reuse = await p.call('doc.put', { uploadId: 'upl-reuse-0001', name: 'b.txt', size: 600, sha256: '2'.repeat(64), offset: 0, data: Buffer.from('y').toString('base64') });
    expect(reuse.ok).toBe(false); expect(reuse.error).toMatch(/different file/);
  }, 60_000);

  it('limits: oversize, oversize chunk, empty and malformed ids are refused', async () => {
    const hh = createHousehold(dir, 'Limits'); const p = await phone('phone-limits-0001', hh.id);
    const base = { uploadId: 'upl-limits-001', name: 'x.bin', sha256: 'a'.repeat(64), offset: 0 };
    expect((await p.call('doc.put', { ...base, size: 26 * 1024 * 1024, data: '' })).error).toMatch(/size must be/);
    expect((await p.call('doc.put', { ...base, size: 100, data: Buffer.alloc(70_000).toString('base64') })).error).toMatch(/at most/);
    expect((await p.call('doc.put', { ...base, size: 0 })).error).toMatch(/size must be/);
    expect((await p.call('doc.put', { ...base, uploadId: '../evil', size: 10 })).error).toMatch(/uploadId/);
    expect((await p.call('doc.put', { ...base, sha256: 'zz', size: 10 })).error).toMatch(/sha256/);
  });

  it('a revoked phone is refused mid-upload, and its partial upload stays unusable by others', async () => {
    const hh = createHousehold(dir, 'Revoke'); const p = await phone('phone-revoke-0001', hh.id);
    const bytes = Buffer.from(RECEIPT.repeat(5));
    expect((await p.upload('upl-revoke-0001', 'r.txt', bytes, { chunk: 50, stopAfterChunks: 1 })).status).toBe('continue');
    revokeCompanionDevice(db, 'phone-revoke-0001');
    const r = await p.call('doc.put', { uploadId: 'upl-revoke-0001', name: 'r.txt', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), offset: 50, data: bytes.subarray(50, 100).toString('base64') });
    expect(r).toMatchObject({ ok: false, http: 401 });
  }, 30_000);

  it.skipIf(!resolveOcrTools().pdftotext)('a PDF with a text layer is read by Poppler (independent), its fields parsed and detected by content not extension', async () => {
    const lines = INVOICE.split('\n');
    const stream = `BT /F1 12 Tf 50 750 Td 14 TL ${lines.map(l => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join(' ')} ET`;
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let pdf = '%PDF-1.4\n'; const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length; pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const hh = createHousehold(dir, 'Pdf'); const p = await phone('phone-pdf-000001', hh.id);
    const done = await p.upload('upl-pdf-000001', 'scan_final.jpg', Buffer.from(pdf, 'latin1')); // misleading extension on purpose
    const fin = await p.waitTask(done.taskId);
    expect(fin).toMatchObject({ status: 'completed', verification: 'independent' });
    const doc = (await p.call('doc.get', { documentId: fin.documentId })).result.document;
    expect(doc).toMatchObject({ type: expect.stringMatching(/PDF/i), textSource: 'text-layer', fields: { kind: 'invoice', merchant: 'Telekom Deutschland GmbH', totalCents: 123456, invoiceNumber: 'RE-2026-88123' } });
    expect((await p.call('doc.search', { q: 'mobilfunk grundpreis' })).result.hits).toHaveLength(1);
  }, 60_000);

  it('a file type with no text extractor is stored and findable by name only, and says so', async () => {
    const hh = createHousehold(dir, 'Binary'); const p = await phone('phone-binary-0001', hh.id);
    const bin = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(300)]); // a ZIP-like blob
    const done = await p.upload('upl-bin-0000001', 'bundle-archive.bin', bin);
    const fin = await p.waitTask(done.taskId);
    expect(fin.status).toBe('completed');
    const doc = (await p.call('doc.get', { documentId: fin.documentId })).result.document;
    expect(doc).toMatchObject({ textSource: 'none', textChars: 0 });
    expect((await p.call('doc.search', { q: 'bundle' })).result.hits).toHaveLength(1);
    expect(getBridgeTask(db, done.taskId).result!.evidence).toMatch(/no text extractor/);
  }, 30_000);
});

describe('the intake service is internal to Pandesh', () => {
  it('is not advertised to a browser and cannot be started by one, by name or by class; the host and Core can', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jugaad-int-'));
    try {
      const { db } = openCoreDatabase(path.join(dir, 'core.db'));
      const prev = process.env.KARKEDIKHA_KANDEV_HOME; process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'no-kandev');
      const services = bridgeServices(dir);
      const kandev = { healthy: async () => false, tool: async () => ({ agents: [] }), reprobeAgent: async () => null } as unknown as KandevClient;
      const rt: BridgeRuntime = { db, kandev, dataDir: dir, services };
      const advertised = (await discoverExecutors(kandev, { services })).executors.map(e => e.id);
      expect(advertised).not.toContain('service:jugaad.ingest');
      expect((await discoverExecutors(kandev, { services, includeInternal: true })).executors.map(e => e.id)).toContain('service:jugaad.ingest');
      const browser = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome' }).pairing;
      const t1 = submitBridgeTask(db, browser, { clientRequestId: 'req-internal-001', instruction: JSON.stringify({ householdId: 'hh_000000000000', file: 'x.txt' }) }).task;
      await expect(dispatchBridgeTask(rt, t1.id, { executor: 'service:jugaad.ingest', decidedBy: 'extension:x', authority: 'extension' })).rejects.toMatchObject({ code: 'forbidden' });
      const t2 = submitBridgeTask(db, browser, { clientRequestId: 'req-internal-002', instruction: '{}' }).task;
      await expect(dispatchBridgeTask(rt, t2.id, { executor: 'auto', taskClass: 'document.ingest', decidedBy: 'extension:x', authority: 'extension' })).rejects.toMatchObject({ code: 'forbidden' });
      expect(getBridgeTask(db, t1.id).executor).toBeNull();
      expect(jugaadServices(dir)[0]!.internal).toBe(true);
      db.close();
      if (prev === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prev;
    } finally { closeHouseholdIndexes(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
