import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { CompanionServerController, visibleToDevice, writeCompanionSettings } from '../api/companionServer';
import { getCompanionRecord, upsertCompanionRecord } from '../domain/companionSync';
import { attachDevice, createHousehold, legacyOwnerOf, loadHouseholds, setLegacyOwner } from '../runtime/jugaad/households';
import { closeHouseholdIndexes } from '../runtime/jugaad/documentIndex';
import { Phone, freePort, protector } from './helpers/jugaadPhone';

const INVOICE = ['Telekom Deutschland GmbH', 'Rechnung', 'Rechnungsnummer: RE-2026-88123', 'Rechnungsdatum: 02.11.2026', 'Gesamtbetrag 1.234,56 EUR'].join('\n');
const KITCHEN = ['Bauhaus Baumarkt', 'Kassenbon', 'Datum: 03.11.2026', 'Farbe 24,90', 'Summe EUR 24,90'].join('\n');

describe('household isolation: legacy and new records follow one rule', () => {
  let dir: string; let db: CoreDatabase; let controller: CompanionServerController; let port: number; let prevKandev: string | undefined;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hhiso-')); ({ db } = openCoreDatabase(path.join(dir, 'core.db')));
    prevKandev = process.env.KARKEDIKHA_KANDEV_HOME; process.env.KARKEDIKHA_KANDEV_HOME = path.join(dir, 'no-kandev');
    port = await freePort(); writeCompanionSettings(dir, { enabled: true, bind: 'loopback', port });
    controller = new CompanionServerController(db, dir, () => undefined, protector()); await controller.apply();
    // Records that existed before households did: an obligation's important date, a briefing, an old task status.
    upsertCompanionRecord(db, { recordId: 'obligation:ob_telekom', kind: 'important_date', payload: { title: 'Telekom invoice', dueDate: '2026-12-01' } });
    upsertCompanionRecord(db, { recordId: 'briefing:today', kind: 'briefing', payload: { text: 'Private briefing for the owner' } });
    upsertCompanionRecord(db, { recordId: 'task:old', kind: 'task_status', payload: { state: 'done' } });
  });
  afterEach(async () => {
    await controller.close(); closeHouseholdIndexes(); db.close();
    if (prevKandev === undefined) delete process.env.KARKEDIKHA_KANDEV_HOME; else process.env.KARKEDIKHA_KANDEV_HOME = prevKandev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const phone = async (id: string, household?: string) => { const p = new Phone(port, dir, id); await p.pair(); if (household) attachDevice(dir, id, household); return p; };
  const ids = async (p: Phone) => ((await p.call('pull', { since: 0, limit: 500 })).result.records as Array<{ recordId: string }>).map(r => r.recordId).sort();
  const LEGACY = ['briefing:today', 'obligation:ob_telekom', 'task:old'];

  it('the visibility rule, exactly', () => {
    expect(visibleToDevice('hh_aaaaaaaaaaaa:doc_1', 'hh_aaaaaaaaaaaa', null)).toBe(true);
    expect(visibleToDevice('hh_aaaaaaaaaaaa:doc_1', 'hh_bbbbbbbbbbbb', null)).toBe(false);
    expect(visibleToDevice('hh_aaaaaaaaaaaa:doc_1', null, null)).toBe(false);
    // legacy, no owner named: default-deny, nobody (an unassigned phone too)
    expect(visibleToDevice('obligation:x', null, null)).toBe(false);
    expect(visibleToDevice('obligation:x', 'hh_aaaaaaaaaaaa', null)).toBe(false);
    // legacy, owner named: only that household
    expect(visibleToDevice('obligation:x', 'hh_aaaaaaaaaaaa', 'hh_aaaaaaaaaaaa')).toBe(true);
    expect(visibleToDevice('obligation:x', 'hh_bbbbbbbbbbbb', 'hh_aaaaaaaaaaaa')).toBe(false);
    expect(visibleToDevice('obligation:x', null, 'hh_aaaaaaaaaaaa')).toBe(false);
  });

  it('nothing is migrated or assigned automatically: creating households and attaching phones changes no legacy record and names no owner', async () => {
    const before = ['obligation:ob_telekom', 'briefing:today', 'task:old'].map(id => JSON.stringify(getCompanionRecord(db, id)));
    const a = createHousehold(dir, 'Alpha'); const b = createHousehold(dir, 'Bravo');
    await phone('phone-alpha-0001', a.id); await phone('phone-bravo-0001', b.id);
    expect(legacyOwnerOf(dir)).toBeNull();
    expect(['obligation:ob_telekom', 'briefing:today', 'task:old'].map(id => JSON.stringify(getCompanionRecord(db, id)))).toEqual(before);
    expect(loadHouseholds(dir).legacyOwner).toBeNull();
  });

  it('with no owner named (default-deny), no phone sees the legacy records, an unassigned phone included; they stay on the PC untouched', async () => {
    const a = createHousehold(dir, 'Alpha'); const b = createHousehold(dir, 'Bravo');
    const pa = await phone('phone-alpha-0001', a.id); const pb = await phone('phone-bravo-0001', b.id); const old = await phone('phone-legacy-0001');
    expect(await ids(pa)).toEqual([]); expect(await ids(pb)).toEqual([]);
    expect(await ids(old)).toEqual([]);
    expect(getCompanionRecord(db, 'obligation:ob_telekom')).toBeTruthy();   // preserved, not deleted
  });

  it('once the owner names a household, only its phones see the legacy records', async () => {
    const a = createHousehold(dir, 'Alpha'); const b = createHousehold(dir, 'Bravo');
    const pa = await phone('phone-alpha-0001', a.id); const pb = await phone('phone-bravo-0001', b.id); const old = await phone('phone-legacy-0001');
    setLegacyOwner(dir, a.id);
    expect(await ids(pa)).toEqual(LEGACY);
    expect(await ids(pb)).toEqual([]);
    expect(await ids(old)).toEqual([]);   // naming an owner takes them away from the unattached phone: no one else can read them
    setLegacyOwner(dir, null);
    expect(await ids(pa)).toEqual([]);
    expect(await ids(old)).toEqual([]);   // back to default-deny
  });

  it('a phone cannot act on a record it cannot see: legacy or another household\'s, the answer is the same as for a record that does not exist', async () => {
    const a = createHousehold(dir, 'Alpha'); const b = createHousehold(dir, 'Bravo');
    const pa = await phone('phone-alpha-0001', a.id); const pb = await phone('phone-bravo-0001', b.id);
    setLegacyOwner(dir, a.id);
    const push = async (p: Phone, recordId: string, n: number) => (await p.call('push', { ops: [{ opId: `op-${n}-${p.deviceId}`.padEnd(12, 'x'), recordId, op: 'ack' }] })).result.results[0];
    expect(await push(pb, 'briefing:today', 1)).toMatchObject({ result: 'rejected', detail: 'unknown or removed record' });
    expect(await push(pb, 'obligation:ob_telekom', 2)).toMatchObject({ result: 'rejected', detail: 'unknown or removed record' });
    expect(await push(pb, 'this-record-does-not-exist', 3)).toMatchObject({ result: 'rejected', detail: 'unknown or removed record' });
    expect(await push(pa, 'briefing:today', 4)).toMatchObject({ result: 'applied' });
  });

  it('end to end with documents: two unrelated households cannot see each other\'s records, search results, tasks or sync data', async () => {
    const a = createHousehold(dir, 'Alpha'); const b = createHousehold(dir, 'Bravo');
    const pa = await phone('phone-alpha-0001', a.id); const pb = await phone('phone-bravo-0001', b.id);
    setLegacyOwner(dir, a.id);
    const ua = await pa.upload('upl-alpha-000001', 'telekom.txt', Buffer.from(INVOICE)); const fa = await pa.waitTask(ua.taskId);
    const ub = await pb.upload('upl-bravo-000001', 'bauhaus.txt', Buffer.from(KITCHEN)); const fb = await pb.waitTask(ub.taskId);
    expect([fa.status, fb.status]).toEqual(['completed', 'completed']);

    // records and sync: each sees its own document + task status; A also its legacy records; nobody sees anything of the other
    const ra = await ids(pa); const rb = await ids(pb);
    expect(ra.filter(r => r.startsWith(a.id))).toHaveLength(2); expect(ra.filter(r => r.startsWith(b.id))).toEqual([]);
    expect(rb.filter(r => r.startsWith(b.id))).toHaveLength(2); expect(rb.filter(r => r.startsWith(a.id))).toEqual([]);
    expect(ra).toEqual(expect.arrayContaining(LEGACY)); expect(rb.some(r => LEGACY.includes(r))).toBe(false);
    // search results
    expect((await pa.call('doc.search', { q: 'telekom' })).result.hits).toHaveLength(1);
    expect((await pa.call('doc.search', { q: 'bauhaus' })).result.hits).toEqual([]);
    expect((await pb.call('doc.search', { q: 'bauhaus' })).result.hits).toHaveLength(1);
    expect((await pb.call('doc.search', { q: 'telekom' })).result.hits).toEqual([]);
    // documents and tasks by id, both directions
    for (const [asker, victim] of [[pa, fb], [pb, fa]] as const) {
      expect((await asker.call('doc.get', { documentId: victim.documentId })).ok).toBe(false);
      const st = await asker.call('doc.status', { taskId: victim.taskId }); expect(st.ok).toBe(false); expect(st.error).toMatch(/not found/);
    }
    expect((await pa.call('tasks.recent')).result.tasks.map((t: any) => t.taskId)).toEqual([ua.taskId]);
    expect((await pb.call('tasks.recent')).result.tasks.map((t: any) => t.taskId)).toEqual([ub.taskId]);
    // the file system boundary is the same: uploads of one never land in the other's folder
    expect(fs.readdirSync(path.join(dir, 'jugaad', a.id, 'inbox')).join()).toMatch(/telekom/);
    expect(fs.readdirSync(path.join(dir, 'jugaad', b.id, 'inbox')).join()).not.toMatch(/telekom/);
    // a household cannot even name the other's: parameters never choose the household
    expect((await pb.call('doc.search', { q: 'telekom', householdId: a.id })).result.hits).toEqual([]);
  }, 60_000);
});
