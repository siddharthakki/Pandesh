import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { CompanionServerController, writeCompanionSettings } from '../api/companionServer';
import { getCompanionRecord, latestCompanionRevision } from '../domain/companionSync';
import { getBridgeTask } from '../domain/pandaBridge';
import { attachDevice, createHousehold, householdDirs } from '../runtime/jugaad/households';
import { addDocument, addRun, closeHouseholdIndexes, getDocument, listOutdated, listRuns, openHouseholdIndex, searchDocuments } from '../runtime/jugaad/documentIndex';
import { PIPELINE_VERSION, reprocessDocument } from '../runtime/jugaad/documentIntake';
import { startReprocess } from '../runtime/jugaad/jugaadGateway';
import { Phone, freePort, protector } from './helpers/jugaadPhone';

const INVOICE = ['Telekom Deutschland GmbH', 'Rechnung', 'Rechnungsnummer: RE-2026-88123', 'Rechnungsdatum: 02.11.2026', 'Mobilfunk Grundpreis', 'Gesamtbetrag 1.234,56 EUR', 'enthaltene MwSt 19% 197,12 EUR'].join('\n');
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('owner-authorised document reprocessing', () => {
  let dir: string; let db: CoreDatabase; let controller: CompanionServerController; let port: number; let prevKandev: string | undefined;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jugaad-rep-')); ({ db } = openCoreDatabase(path.join(dir, 'core.db')));
    prevKandev = process.env.KARKEDIKHA_KANDEV_HOME; process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'no-kandev');
    port = await freePort(); writeCompanionSettings(dir, { enabled: true, bind: 'loopback', port });
    controller = new CompanionServerController(db, dir, () => undefined, protector()); await controller.apply();
  });
  afterEach(async () => {
    await controller.close(); closeHouseholdIndexes(); db.close();
    if (prevKandev === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prevKandev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const phone = async (id: string, household: string) => { const p = new Phone(port, dir, id); await p.pair(); attachDevice(dir, id, household); return p; };
  const rt = () => ({ db, dataDir: dir });
  async function done(taskId: string) {
    for (let i = 0; i < 150; i++) { const t = getBridgeTask(db, taskId); if (['completed', 'failed', 'cancelled'].includes(t.status)) return t; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('task did not finish');
  }
  const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  async function ingested(householdName = 'Alpha') {
    const hh = createHousehold(dir, householdName); const p = await phone(`phone-${householdName.toLowerCase()}-01`, hh.id);
    const up = await p.upload(`upl-${householdName.toLowerCase()}-0001`, 'telekom.txt', Buffer.from(INVOICE));
    const fin = await p.waitTask(up.taskId);
    const index = openHouseholdIndex(dir, hh.id);
    const doc = getDocument(index, fin.documentId)!;
    return { hh, p, index, doc, original: path.join(householdDirs(dir, hh.id).inbox, doc.storedName) };
  }

  it('intake writes the first history entry', async () => {
    const { index, doc } = await ingested();
    const runs = listRuns(index, doc.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'intake', status: 'applied', pipelineVersion: PIPELINE_VERSION, textSource: 'plain' });
    expect(listOutdated(index, PIPELINE_VERSION)).toEqual([]);
  });

  it('an improved parser updates the old result: field diff in the history, original untouched, search and phone record refreshed', async () => {
    const { hh, p, index, doc, original } = await ingested();
    // Make the stored result look like it came from an older, worse pipeline.
    index.run('UPDATE documents SET fieldsJson = ? WHERE id = ?', [JSON.stringify({ kind: 'other', matchedBy: [], totalCents: 100 }), doc.id]);
    index.run("UPDATE processing_runs SET pipelineVersion = 'jugaad-intake-1' WHERE documentId = ?", [doc.id]);
    expect(listOutdated(index, PIPELINE_VERSION).map(d => d.id)).toEqual([doc.id]);
    const originalHash = sha(original); const originalStat = fs.statSync(original);
    const revBefore = latestCompanionRevision(db);

    const started = await startReprocess(rt(), hh.id, doc.id, 'host:jarvis', 'OCR and parser improved');
    const task = await done(started.taskId);
    expect(task).toMatchObject({ status: 'completed', executor: 'service:jugaad.reprocess', externalConsent: null });
    expect(task.statusDetail).toMatch(/field\(s\) changed/);

    const after = getDocument(index, doc.id)!;
    expect(after.fields).toMatchObject({ kind: 'invoice', merchant: 'Telekom Deutschland GmbH', totalCents: 123456, vatCents: 19712, invoiceNumber: 'RE-2026-88123' });
    expect(after.id).toBe(doc.id); expect(after.sha256).toBe(doc.sha256);
    const runs = listRuns(index, doc.id);
    expect(runs.map(r => [r.trigger, r.status])).toEqual([['intake', 'applied'], ['reprocess', 'applied']]);
    expect(runs[1]).toMatchObject({ by: 'host:jarvis', note: 'OCR and parser improved', pipelineVersion: PIPELINE_VERSION });
    expect(runs[1]!.changes.find(c => c.field === 'totalCents')).toEqual({ field: 'totalCents', before: 100, after: 123456 });
    expect(runs[0]!.fields).toMatchObject({ kind: 'invoice', totalCents: 123456 }); // the earlier run is preserved as it was recorded
    // the original is exactly the same bytes, same file, not rewritten
    expect(sha(original)).toBe(originalHash); expect(fs.statSync(original).mtimeMs).toBe(originalStat.mtimeMs);
    expect(listOutdated(index, PIPELINE_VERSION)).toEqual([]);
    // search and the phone see the refreshed result
    expect(searchDocuments(index, 'mobilfunk')).toHaveLength(1);
    expect(getCompanionRecord(db, `${hh.id}:${doc.id}`)!.payload).toMatchObject({ totalCents: 123456, merchant: 'Telekom Deutschland GmbH' });
    expect(latestCompanionRevision(db)).toBeGreaterThan(revBefore);
    expect((await p.call('doc.history', { documentId: doc.id })).result.runs.map((r: any) => r.trigger)).toEqual(['intake', 'reprocess']);
  }, 60_000);

  it('running it again changes nothing, and says so: a third history entry, no rewrite, no new sync revision', async () => {
    const { hh, index, doc } = await ingested();
    const first = await done((await startReprocess(rt(), hh.id, doc.id, 'host:jarvis', null)).taskId);
    expect(first.statusDetail).toMatch(/nothing changed/);
    const rev = latestCompanionRevision(db);
    const second = await done((await startReprocess(rt(), hh.id, doc.id, 'host:jarvis', null)).taskId);
    expect(second.status).toBe('completed');
    expect(listRuns(index, doc.id).map(r => r.status)).toEqual(['applied', 'unchanged', 'unchanged']);
    // only the task-status record is new; the document's own record kept its revision
    expect(getCompanionRecord(db, `${hh.id}:${doc.id}`)!.revision).toBeLessThanOrEqual(rev);
  }, 60_000);

  it('refuses when the original changed or is gone: nothing is modified and no run is recorded', async () => {
    const { hh, index, doc, original } = await ingested();
    const before = JSON.stringify(getDocument(index, doc.id));
    fs.appendFileSync(original, '\nsomeone edited the stored original');
    const t1 = await done((await startReprocess(rt(), hh.id, doc.id, 'host:jarvis', null)).taskId);
    expect(t1.status).toBe('failed'); expect(t1.statusDetail).toMatch(/no longer matches the hash/);
    fs.rmSync(original);
    const t2 = await done((await startReprocess(rt(), hh.id, doc.id, 'host:jarvis', null)).taskId);
    expect(t2.status).toBe('failed'); expect(t2.statusDetail).toMatch(/no longer in the household inbox/);
    expect(JSON.stringify(getDocument(index, doc.id))).toBe(before);
    expect(listRuns(index, doc.id)).toHaveLength(1);
  }, 60_000);

  it('a run that loses the text the previous run had is recorded but does not replace it', async () => {
    const hh = createHousehold(dir, 'Scan'); const index = openHouseholdIndex(dir, hh.id);
    const file = path.join(householdDirs(dir, hh.id).inbox, `${sha256(PNG_1X1).slice(0, 8)}-receipt.png`);
    fs.writeFileSync(file, PNG_1X1);
    const { doc } = addDocument(index, { id: 'doc_scan_0000001', sha256: sha256(PNG_1X1), name: 'receipt.png', mime: 'image/png', typeLabel: 'PNG image', bytes: PNG_1X1.length, storedName: path.basename(file), source: 'phone', textChars: 24, textSource: 'ocr', fields: { kind: 'receipt', merchant: 'EDEKA', totalCents: 1200 }, text: 'EDEKA Total EUR 12,00 ok' });
    addRun(index, { documentId: doc.id, trigger: 'intake', by: 'jugaad:phone', pipelineVersion: 'jugaad-intake-1', status: 'applied', typeLabel: 'PNG image', textSource: 'ocr', textChars: 24, fields: doc.fields, steps: [], changes: [], note: null });
    const r = await reprocessDocument(db, dir, hh.id, doc.id, { by: 'host:jarvis', ocrTools: { tesseract: null, pdftoppm: null, pdftotext: null, pdfinfo: null } });
    expect(r.outcome).toBe('kept-previous');
    expect(getDocument(index, doc.id)).toMatchObject({ textChars: 24, textSource: 'ocr', fields: { merchant: 'EDEKA', totalCents: 1200 } });
    expect(searchDocuments(index, 'edeka')).toHaveLength(1);
    const runs = listRuns(index, doc.id);
    expect(runs).toHaveLength(2); expect(runs[1]).toMatchObject({ status: 'kept-previous' }); expect(runs[1]!.note).toMatch(/previous result was kept/);
    expect(sha(file)).toBe(sha256(PNG_1X1));
  });

  it('households stay isolated: another household cannot reprocess, read the history of, or even find this document', async () => {
    const a = await ingested('Alpha'); const b = await ingested('Bravo');
    const t = await done((await startReprocess(rt(), b.hh.id, a.doc.id, 'host:jarvis', null)).taskId);
    expect(t.status).toBe('failed'); expect(t.statusDetail).toMatch(/not found in this household/);
    expect(listRuns(a.index, a.doc.id)).toHaveLength(1);
    expect((await b.p.call('doc.history', { documentId: a.doc.id })).ok).toBe(false);
    expect((await b.p.call('doc.history', { documentId: b.doc.id })).ok).toBe(true);
  }, 60_000);
});

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
