/**
 * Review findings on Mail Hub: (1) a sync that stops at its limit must continue with older mail on the next sync and say
 * how far back the index reaches; (2) a question must be read into conditions locally, not AND-ed word by word.
 * The Outlook worker is a fake at its process boundary; the database and the index are real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { OutlookConnector } from '../runtime/mail/outlookConnector';
import { MailIndex } from '../runtime/mail/mailIndex';
import { interpretQuestion } from '../runtime/mail/mailSearch';

let dir: string; let db: CoreDatabase; let state: string; let connector: OutlookConnector; let index: MailIndex;
const ACCTS = [{ storeId: 'S1', name: 'one@gmail.com', inboxItems: 0, inboxUnread: 0 }];
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const setBox = (messages: unknown[], extra: Record<string, unknown> = {}) => fs.writeFileSync(state, JSON.stringify({ accounts: ACCTS, messages, ...extra }));
const reads = () => (fs.existsSync(`${state}.reads`) ? fs.readFileSync(`${state}.reads`, 'utf8').trim().split(/\s+/).filter(Boolean) : []);
const mk = (n: number, over: Record<string, unknown> = {}) => ({ entryId: `e${n}`, conversationId: `c${n}`, internetMessageId: `<id${n}@x>`, subject: `Subject ${n}`, fromName: 'Sender', fromAddress: `s${n}@example.com`, to: 'me', received: iso(n / 4), unread: true, attachments: 0, body: `Body ${n}`, ...over });

const fakeWorker = () => {
  const script = path.join(dir, 'fake.js');
  fs.writeFileSync(script, `
const fs=require('fs');const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',(l)=>{const r=JSON.parse(l);const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
 const out=(data)=>console.log(JSON.stringify({id:r.id,ok:true,data}));
 if(r.cmd==='accounts')return out({accounts:s.accounts});
 if(r.cmd==='list'){const before=r.beforeIso?new Date(Date.parse(r.beforeIso)+60000).toISOString():null;
  const all=s.messages.filter(m=>(!r.sinceIso||m.received>=r.sinceIso)&&(!before||m.received<before)).sort((a,b)=>b.received.localeCompare(a.received));
  const page=all.slice(r.offset||0,(r.offset||0)+r.limit);fs.appendFileSync(${JSON.stringify(state + '.reads')},page.map(m=>m.entryId).join(' ')+' ');
  return out({messages:page,folderItems:all.length,hasMore:(r.offset||0)+page.length<all.length});}
 console.log(JSON.stringify({id:r.id,ok:false,error:'unknown command'}));});`);
  return { file: process.execPath, args: [script] };
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcov-')); state = path.join(dir, 'box.json'); setBox([]);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  connector = new OutlookConnector({ dataDir: dir, command: fakeWorker(), defaultTimeoutMs: 5000 });
  index = new MailIndex(db, connector);
  await index.accounts(); index.setAuthorized('S1', true);
});
afterEach(() => { connector.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('backfill after a limited sync', () => {
  it('continues with older mail on each sync, never rereading the newest, until the window is covered', async () => {
    // 120 messages over the last 30 days (4 per day), 40 read per sync.
    setBox(Array.from({ length: 119 }, (_, i) => mk(i + 1)));
    index.updateSettings({ maxPerSync: 50, windowDays: 30, maxPerAccount: 2000 });
    const s1 = await index.sync('S1');
    expect(s1.indexed).toBe(50); expect(s1.complete).toBe(false);
    const cov1 = index.coverage('S1').from!;
    const s2 = await index.sync('S1');
    expect(s2.mode).toBe('incremental'); expect(s2.backfilled).toBeGreaterThan(0);
    expect(index.coverage('S1').from! < cov1).toBe(true);
    const total2 = index.list({ limit: 100 }).total; expect(total2).toBeGreaterThan(50);
    const s3 = await index.sync('S1');
    expect(index.list({ limit: 100 }).total).toBe(119);
    expect(s3.complete).toBe(true); expect(index.coverage('S1').complete).toBe(true);
    // The newest messages were read once by the first pass and again only by the 2-day incremental overlap, not by every sync.
    const counts = new Map<string, number>(); for (const id of reads()) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(counts.get('e119')).toBeLessThanOrEqual(1); // the oldest: read once
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  it('keeps backfilling on a busy mailbox where a day of mail is more than one sync can read', async () => {
    // Found live on a real mailbox: 60 messages are about one day, so a 2-day overlap used the whole budget every time.
    const busy = Array.from({ length: 300 }, (_, i) => mk(i + 1, { received: iso((i + 1) / 60) })); // 60 per day
    setBox(busy);
    index.updateSettings({ maxPerSync: 60, windowDays: 30, maxPerAccount: 2000 });
    await index.sync('S1');
    let from = index.coverage('S1').from!;
    for (let i = 0; i < 4; i++) {
      await index.sync('S1');
      const now = index.coverage('S1').from!;
      expect(now < from).toBe(true); // every sync reaches further back
      from = now;
    }
    expect(index.list({ limit: 100 }).total).toBeGreaterThan(60 * 3); // about 60 new each sync, less the short overlap
  });

  it('once covered, a sync reads only what is new and does not backfill again', async () => {
    setBox(Array.from({ length: 20 }, (_, i) => mk(i + 1)));
    await index.sync('S1');
    expect(index.coverage('S1').complete).toBe(true);
    const before = reads().length;
    const r = await index.sync('S1');
    expect(r.backfilled).toBe(0); expect(r.mode).toBe('incremental');
    expect(reads().length - before).toBeLessThanOrEqual(20);
  });

  it('removes mail that left Outlook inside the range it backfills', async () => {
    const all = Array.from({ length: 60 }, (_, i) => mk(i + 1));
    setBox(all);
    await index.sync('S1'); // everything indexed, coverage complete
    expect(index.list({ limit: 100 }).total).toBe(60);
    // A day later the daily reconcile reads only the newest 50 (limit), and two old messages have left Outlook meanwhile.
    index.updateSettings({ maxPerSync: 50 });
    db.run('UPDATE mail_accounts SET lastReconcileAt = ?', [iso(2)]);
    setBox(all.filter((m) => m.entryId !== 'e57' && m.entryId !== 'e59'));
    const r1 = await index.sync('S1');
    expect(r1.mode).toBe('reconcile'); expect(r1.complete).toBe(false); // verified only back to the 50th newest
    expect(index.list({ limit: 100 }).total).toBe(60); // the old ones are unverified, not yet dropped
    await index.sync('S1'); // the backfill reaches them
    const subjects = index.list({ limit: 100 }).rows.map((r) => r.subject);
    expect(subjects).not.toContain('Subject 57'); expect(subjects).not.toContain('Subject 59');
    expect(index.list({ limit: 100 }).total).toBe(58); expect(index.coverage('S1').complete).toBe(true);
  });

  it('does not fight the per-account cap: it stops, says so, and resumes when the cap is raised', async () => {
    setBox(Array.from({ length: 150 }, (_, i) => mk(i + 1)));
    index.updateSettings({ maxPerSync: 100, maxPerAccount: 100, windowDays: 60 });
    await index.sync('S1'); await index.sync('S1');
    const c = index.coverage('S1');
    expect(c.capped).toBe(true); expect(c.complete).toBe(false);
    expect(index.list({ limit: 100 }).total).toBeLessThanOrEqual(100);
    const readsBefore = reads().length;
    await index.sync('S1');
    expect(reads().length - readsBefore).toBeLessThan(60); // no wholesale rereading of old mail each time
    index.updateSettings({ maxPerAccount: 500 });
    expect(index.coverage('S1').capped).toBe(false);
    for (let i = 0; i < 3; i++) await index.sync('S1');
    expect(index.list({ limit: 100 }).total).toBe(150); expect(index.coverage('S1').complete).toBe(true);
  });

  it('says how far back the index reaches in the account list', async () => {
    setBox(Array.from({ length: 90 }, (_, i) => mk(i + 1)));
    index.updateSettings({ maxPerSync: 50 });
    await index.sync('S1');
    const a = index.knownAccounts().find((x) => x.storeId === 'S1')!;
    expect(a.coverage.complete).toBe(false); expect(a.coverage.from).toBeTruthy();
    expect(index.recentActivity(1)[0].detail).toMatch(/covered back to|continues next sync/);
  });
});

describe('questions are read into conditions', () => {
  const NOW = new Date('2026-11-18T12:00:00'); // a Wednesday

  it('reads the review examples', () => {
    const r = interpretQuestion('Have recruiters replied to my applications?', NOW);
    expect(r.categories).toEqual(['career']); expect(r.words).toEqual([]);
    const w = interpretQuestion('What important messages arrived this week?', NOW);
    expect(w.excludeBulk).toBe(true); expect(new Date(w.sinceIso!).getDay()).toBe(1); expect(w.words).toEqual([]);
    const n = interpretQuestion('Which emails require a response?', NOW);
    expect(n.needsReply).toBe(true);
    const f = interpretQuestion('Which invoices are due soon?', NOW);
    expect(f.categories).toEqual(['finance']); expect(f.words).toEqual([]);
    expect(interpretQuestion('What appointments were mentioned in email?', NOW).categories).toEqual(['event']);
    expect(interpretQuestion('Find my electricity receipt', NOW)).toMatchObject({ categories: ['finance'], words: ['electricity'], short: false });
    expect(interpretQuestion('invoice', NOW)).toMatchObject({ categories: ['finance'], words: ['invoice'], short: true });
  });
  it('turns nothing searchable into nothing, and never into query syntax', () => {
    expect(interpretQuestion('?!', NOW).words).toEqual([]);
    expect(interpretQuestion('" OR 1=1 --', NOW).categories).toEqual([]);
  });

  const seed = async () => {
    setBox([
      mk(1, { subject: 'Interview availability', body: 'Please share your availability for an interview.', fromAddress: 'anna@firm.example' }),
      mk(2, { subject: 'Application received', body: 'We received your application for Program Manager.', fromAddress: 'jobs@corp.example' }),
      mk(3, { subject: 'Your electricity invoice for November', body: 'Amount due: €124.40. Due date: 23 November 2026.', fromAddress: 'billing@energy.example' }),
      mk(4, { subject: 'Weekly digest', body: 'Top stories. Unsubscribe', fromAddress: 'news@digest.example' }),
      mk(5, { subject: 'Lunch?', body: 'Can you join us for lunch on Friday?', fromAddress: 'sam@friend.example' }),
      mk(40, { subject: 'Old note', body: 'Nothing', fromAddress: 'old@x.example' }),
    ]);
    index.updateSettings({ windowDays: 30 });
    await index.sync('S1');
  };

  it('finds recruiter mail for a sentence that never uses the words in the messages', async () => {
    await seed();
    const r = index.list({ q: 'Have recruiters replied to my applications?' });
    expect(r.rows.map((x) => x.subject).sort()).toEqual(['Application received', 'Interview availability']);
    expect(r.interpreted).toMatch(/career mail/);
  });
  it('finds bills for "invoices due soon", and does not return unrelated mail', async () => {
    await seed();
    expect(index.list({ q: 'Which invoices are due soon?' }).rows.map((x) => x.subject)).toEqual(['Your electricity invoice for November']);
  });
  it('lists mail that may need a reply, without newsletters, and respects "this week"', async () => {
    await seed();
    const r = index.list({ q: 'Which emails require a response?' });
    expect(r.rows.map((x) => x.subject)).toContain('Interview availability'); expect(r.rows.map((x) => x.subject)).toContain('Lunch?');
    expect(r.rows.map((x) => x.subject)).not.toContain('Weekly digest');
    const imp = index.list({ q: 'What important messages arrived in the last 3 days?' });
    expect(imp.rows.map((x) => x.subject)).not.toContain('Weekly digest'); expect(imp.rows.map((x) => x.subject)).not.toContain('Old note');
  });
  it('puts the topic inside the category first and falls back to the category when nothing has both', async () => {
    await seed();
    const both = index.list({ q: 'Find the electricity bill from my provider' });
    expect(both.rows[0].subject).toBe('Your electricity invoice for November');
    const none = index.list({ q: 'Any recruiter mail about astronauts?' });
    expect(none.total).toBeGreaterThan(0); expect(none.interpreted).toMatch(/nothing also matched/);
  });
  it('a single word still searches text, and an authorized-only scope still applies', async () => {
    await seed();
    expect(index.list({ q: 'lunch' }).rows.map((x) => x.subject)).toEqual(['Lunch?']);
    index.setAuthorized('S1', false);
    expect(index.list({ q: 'recruiters' }).total).toBe(0);
  });
});
