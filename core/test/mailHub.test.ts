/**
 * Mail Hub index and Outlook connector. The Outlook worker is faked at its process boundary (a node program that speaks
 * the same JSON-lines protocol); the database, FTS5 index, queue, timeouts and cancellation are real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { OutlookConnector, OutlookError } from '../runtime/mail/outlookConnector';
import { OUTLOOK_WORKER_SCRIPT } from '../runtime/mail/outlookWorkerScript';
import { MailIndex } from '../runtime/mail/mailIndex';
import { extractAmounts, extractDates, readMessage } from '../runtime/mail/mailRules';

let dir: string; let db: CoreDatabase; let state: string;

/** A fake worker: reads {cmd} lines, answers from a mailbox file the test rewrites. `hang` makes it stop answering. */
const fakeWorker = (): { file: string; args: string[] } => {
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, `
const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',(l)=>{const r=JSON.parse(l);const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
 if(s.hang&&r.cmd==='list')return; if(s.crash){process.exit(3);}
 const out=(data)=>console.log(JSON.stringify({id:r.id,ok:true,data}));
 if(r.cmd==='accounts')return out({accounts:s.accounts});
 if(r.cmd==='list'){const all=s.messages.filter(m=>!r.sinceIso||m.received>=r.sinceIso);const page=all.slice(r.offset||0,(r.offset||0)+r.limit);return out({messages:page,folderItems:all.length,hasMore:(r.offset||0)+page.length<all.length});}
 if(r.cmd==='get'){const m=s.messages.find(x=>x.entryId===r.entryId);return m?out({...m,body:m.body+' [live]',attachmentList:[{name:'statement.pdf',size:1200}]}):console.log(JSON.stringify({id:r.id,ok:false,error:'item not found'}));}
 console.log(JSON.stringify({id:r.id,ok:false,error:'unknown command'}));});`);
  return { file: process.execPath, args: [script] };
};
const setBox = (o: Record<string, unknown>) => fs.writeFileSync(state, JSON.stringify(o));
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const msg = (n: number, over: Record<string, unknown> = {}) => ({ entryId: `e${n}`, conversationId: `c${n}`, internetMessageId: `<id${n}@x>`, subject: `Subject ${n}`, fromName: 'Sender', fromAddress: `s${n}@example.com`, to: 'me@example.com', received: iso(n), unread: true, attachments: 0, body: `Body ${n}`, ...over });
const ACCTS = [{ storeId: 'S1', name: 'one@gmail.com', inboxItems: 3, inboxUnread: 2 }, { storeId: 'S2', name: 'two@gmail.com', inboxItems: 1, inboxUnread: 1 }];

let connector: OutlookConnector; let index: MailIndex;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailhub-'));
  state = path.join(dir, 'box.json');
  setBox({ accounts: ACCTS, messages: [] });
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  connector = new OutlookConnector({ dataDir: dir, command: fakeWorker(), defaultTimeoutMs: 3000 });
  index = new MailIndex(db, connector);
});
afterEach(() => { connector.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('worker script is read-only', () => {
  it('contains no mailbox write', () => {
    for (const w of ['.Send(', '.Delete(', '.Move(', '.Save(', '.SaveAs', '.Display(', '.UnRead =', '.FlagStatus', '.Categories =', 'SaveAsFile', '.MarkAsTask']) expect(OUTLOOK_WORKER_SCRIPT).not.toContain(w);
  });
});

describe('extraction', () => {
  it('reads amounts and dates from the text, and says when the year was inferred', () => {
    expect(extractAmounts('Amount due: €124.40 and $1,299.00')).toEqual([{ text: '€124.40', value: 124.4, currency: 'EUR' }, { text: '$1,299.00', value: 1299, currency: 'USD' }]);
    const d = extractDates('Due date: 23 November 2026. Workshop Thursday, 19 November at 16:00', '2026-11-16T10:00:00Z');
    expect(d.find((x) => x.iso === '2026-11-23')?.yearInferred).toBe(false);
    expect(d.find((x) => x.iso === '2026-11-19')?.yearInferred).toBe(true);
  });
  it('classifies and flags a needed reply, and marks mail it cannot place as low confidence', () => {
    const r = readMessage({ subject: 'Interview availability', fromName: 'Talent', fromAddress: 'a@b.c', body: 'Please share your availability.', received: iso(0) });
    expect(r.category).toBe('career'); expect(r.facts.needsReply).toBe(true);
    expect(readMessage({ subject: 'Hello', fromName: 'x', fromAddress: 'x@y.z', body: 'nothing', received: iso(0) }).facts.confidence).toBe('low');
  });
  // Found on a real mailbox: a newsletter that mentions "subscription" and "?" was shown as a bill that needs a reply.
  it('does not turn bulk mail into a bill, an event or a request for an answer', () => {
    const newsletter = readMessage({ subject: 'Your 2027 plan, ready in one week', fromName: 'Weekly', fromAddress: 'news@weekly.example', body: 'Join us for the webinar on 14 December. Your subscription renews soon. Why wait? Unsubscribe here.', received: iso(0) });
    expect(newsletter.category).toBe('other'); expect(newsletter.facts.needsReply).toBe(false); expect(newsletter.facts.bulk).toBe(true); expect(newsletter.facts.dates).toEqual([]);
    const alert = readMessage({ subject: '1 new offer: apartment near you', fromName: 'Listings', fromAddress: 'noreply@listings.example', body: 'Can you see yourself living here?', received: iso(0) });
    expect(alert.facts.needsReply).toBe(false);
    // The unsubscribe footer is past the stored text, so the worker reports it as a hint.
    expect(readMessage({ subject: 'Weekly tips', fromName: 'Tips', fromAddress: 'hello@tips.example', body: 'A former recruiter shares an interview story.', received: iso(0), bulkHint: true }).category).toBe('other');
    // A person writing from a normal address is still found, and an invoice named in the subject of automated mail still counts.
    expect(readMessage({ subject: 'Quick question', fromName: 'Anna', fromAddress: 'anna@firm.example', body: 'Could you send me the file?', received: iso(0) }).facts.needsReply).toBe(true);
    expect(readMessage({ subject: 'Your invoice for November', fromName: 'Billing', fromAddress: 'noreply@cloud.example', body: 'Amount due: €9.99. Unsubscribe', received: iso(0) }).category).toBe('finance');
  });
});

describe('connector', () => {
  it('discovers accounts and reads a message on demand', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1)] });
    expect((await connector.accounts()).map((a) => a.name)).toEqual(['one@gmail.com', 'two@gmail.com']);
    expect((await connector.get({ storeId: 'S1', entryId: 'e1' })).attachmentList[0].name).toBe('statement.pdf');
    expect(connector.health().state).toBe('ok');
  });
  it('times out a hung call, kills the worker and recovers on the next call', async () => {
    const c = new OutlookConnector({ dataDir: dir, command: fakeWorker(), defaultTimeoutMs: 400 });
    setBox({ accounts: ACCTS, messages: [], hang: true });
    await expect(c.list({ storeId: 'S1', limit: 5 })).rejects.toMatchObject({ code: 'timeout' });
    setBox({ accounts: ACCTS, messages: [] });
    expect((await c.accounts()).length).toBe(2);
    c.stop();
  });
  it('cancels a call in flight, and reports a crashed worker as unavailable instead of hanging', async () => {
    setBox({ accounts: ACCTS, messages: [], hang: true });
    const ac = new AbortController();
    const p = connector.list({ storeId: 'S1', limit: 5 }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    setBox({ accounts: ACCTS, messages: [], crash: true });
    await expect(connector.accounts()).rejects.toBeInstanceOf(OutlookError);
    expect(connector.health().state).toBe('down');
  });
  it('bounds its queue', async () => {
    setBox({ accounts: ACCTS, messages: [], hang: true });
    const c = new OutlookConnector({ dataDir: dir, command: fakeWorker(), maxQueue: 2, defaultTimeoutMs: 2000 });
    const calls = [1, 2, 3, 4].map(() => c.list({ storeId: 'S1', limit: 1 }).catch((e: OutlookError) => e.code));
    expect((await Promise.all(calls)).filter((r) => r === 'busy').length).toBeGreaterThan(0);
    c.stop();
  });
});

describe('index', () => {
  const authorize = async (...ids: string[]) => { await index.accounts(); for (const id of ids) index.setAuthorized(id, true); };

  it('reads nothing from an account that is not authorized, and searches only authorized accounts', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1, { subject: 'Invoice November', body: 'Amount due €10.00' })] });
    await index.accounts();
    await expect(index.sync('S1')).rejects.toThrow(/not authorized/);
    index.setAuthorized('S1', true);
    await index.sync('S1');
    expect(index.list({ q: 'invoice' }).total).toBe(1);
    index.setAuthorized('S1', false);
    expect(index.list({ q: 'invoice' }).total).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_messages')!.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_fts')!.n).toBe(0);
  });

  it('searches with source-linked results and ignores query syntax in the text', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1, { subject: 'Electricity bill', body: 'Amount due: €124.40 on 23 November 2026' }), msg(2, { subject: 'Hello', body: 'nothing' })] });
    await authorize('S1'); await index.sync('S1');
    const r = index.list({ q: 'electricity' });
    expect(r.rows.map((x) => x.subject)).toEqual(['Electricity bill']);
    expect(r.rows[0].category).toBe('finance'); expect(r.rows[0].facts.amounts[0].value).toBe(124.4);
    expect(index.list({ q: '" OR 1=1 --' }).rows.length).toBe(0);
    expect(index.list({ q: 'NEAR(' }).rows.length).toBe(0);
  });

  it('deduplicates the same message held by two accounts', async () => {
    const same = msg(1, { internetMessageId: '<same@x>' });
    setBox({ accounts: ACCTS, messages: [same] });
    await authorize('S1', 'S2'); await index.sync('S1'); await index.sync('S2');
    const r = index.list({});
    expect(r.total).toBe(1); expect(r.rows[0].duplicates).toBe(1);
    expect(index.overview().counts.indexed).toBe(1);
  });

  it('drops a moved or deleted message on the reconcile instead of retaining it', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1), msg(2)] });
    await authorize('S1'); await index.sync('S1');
    expect(index.list({}).total).toBe(2);
    db.run('UPDATE mail_accounts SET lastReconcileAt = ?', [iso(2)]);
    setBox({ accounts: ACCTS, messages: [msg(1)] });
    const r = await index.sync('S1');
    expect(r.mode).toBe('reconcile'); expect(r.removed).toBe(1);
    expect(index.list({}).rows.map((x) => x.subject)).toEqual(['Subject 1']);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_fts')!.n).toBe(1);
  });

  it('is incremental after the first sync and picks up a read-state change', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1), msg(2)] });
    await authorize('S1'); expect((await index.sync('S1')).mode).toBe('reconcile');
    setBox({ accounts: ACCTS, messages: [msg(0, { received: iso(0) }), msg(1, { unread: false }), msg(2)] });
    const r = await index.sync('S1');
    expect(r.mode).toBe('incremental'); expect(index.list({}).total).toBe(3);
    expect(index.list({ unreadOnly: true }).total).toBe(2);
  });

  it('respects the per-sync and per-account bounds', async () => {
    setBox({ accounts: ACCTS, messages: Array.from({ length: 80 }, (_, i) => msg(i % 25, { entryId: `e${i}`, internetMessageId: `<m${i}@x>`, received: iso(i / 10) })) });
    index.updateSettings({ maxPerSync: 50, maxPerAccount: 100 });
    await authorize('S1');
    const r = await index.sync('S1');
    expect(r.complete).toBe(false); expect(r.indexed).toBe(50); expect(index.list({ limit: 100 }).total).toBe(50);
    index.updateSettings({ maxPerAccount: 100, maxPerSync: 50, retentionDays: 7 });
    expect(index.settings().retentionDays).toBe(7);
    index.updateSettings({ maxPerSync: 999999 });
    expect(index.settings().maxPerSync).toBe(2000);
  });

  it('reads a full message on demand and falls back to the indexed text when Outlook is down, without crashing', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1)] });
    await authorize('S1'); await index.sync('S1');
    const id = index.list({}).rows[0].id;
    expect((await index.read(id))!.source).toBe('outlook');
    setBox({ accounts: ACCTS, messages: [msg(1)], crash: true });
    const down = await index.read(id);
    expect(down!.source).toBe('index'); expect(down!.note).toMatch(/could not return/);
  });

  it('keeps message text out of the activity log', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1, { subject: 'Secret subject', body: 'Secret body', fromAddress: 'private@example.com' })] });
    await authorize('S1'); await index.sync('S1'); await index.read(index.list({}).rows[0].id);
    const log = JSON.stringify(index.recentActivity());
    expect(log).not.toMatch(/Secret|private@example/);
  });

  it('records a failed sync as an error, not as an empty mailbox', async () => {
    setBox({ accounts: ACCTS, messages: [msg(1)] });
    await authorize('S1'); await index.sync('S1');
    setBox({ accounts: ACCTS, messages: [], crash: true });
    const r = await index.sync('S1');
    expect(r.ok).toBe(false);
    expect(index.list({}).total).toBe(1);
    expect(index.knownAccounts().find((a) => a.storeId === 'S1')!.lastError).toBeTruthy();
  });
});
