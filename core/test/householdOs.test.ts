/**
 * Household OS: PC organization journal, recurring routines, obligations and the JUGAAD companion protocol.
 * Real files in a temporary folder, a real Core database; no model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { classifyFile, detectType } from '../domain/fileClassification';
import { listOrganizationRules, listPlanMoves, updateMove } from '../domain/fileOrganization';
import { applyOrganizationPlan, proposeOrganization, undoOrganizationPlan, validateRoot } from '../runtime/pcOrganizer';
import { claimDueScheduledTasks, nextOccurrence } from '../domain/scheduledTasks';
import { createHouseholdRoutine, listRoutineRuns, recordMissedRun, validateRoutineScope } from '../domain/householdRoutines';
import { extractObligation } from '../domain/obligationExtraction';
import { decideObligation, derivePaymentStatus, getObligation, listObligationEvidence, recordObligationSource } from '../domain/householdObligations';
import {
  checkFreshness, createCompanionPairingCode, getCompanionRecord, listCompanionChanges, openCompanionMessage, pairingKey, pairingProof, redeemCompanionPairing, sealCompanionMessage,
} from '../domain/companionSync';
import { handleCompanionOps } from '../runtime/householdService';
import { runHouseholdRoutine } from '../runtime/householdRoutineRunner';

let dir: string;
let db: CoreDatabase;
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'household-os-'));
  ({ db } = openCoreDatabase(path.join(dir, 'core.db')));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, data: Buffer | string, mtime?: Date): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

describe('file classification', () => {
  it('identifies files by their header, not their extension, and flags temporary downloads', () => {
    expect(detectType(new Uint8Array(PDF), '.pdf')).toBe('pdf');
    expect(detectType(new Uint8Array(JPEG), '.pdf')).toBe('jpeg');
    const c = (name: string, head: Buffer) => classifyFile({ name, ext: path.extname(name), size: head.length, mtimeMs: Date.UTC(2025, 2, 1), detected: detectType(new Uint8Array(head), path.extname(name)) });
    expect(c('Steuerbescheid_2024.pdf', PDF)).toMatchObject({ category: 'tax', year: 2024 });
    expect(c('Lebenslauf.pdf', PDF).category).toBe('career');
    expect(c('IMG_20230704.jpg', JPEG)).toMatchObject({ category: 'photos', year: 2023 });
    expect(c('setup.exe.crdownload', Buffer.from('xx')).category).toBe('temporary');
    expect(c('notes.pdf', PDF)).toMatchObject({ category: 'documents', ambiguous: true });
  });

  it('refuses drive roots, system folders and the whole profile', () => {
    expect(validateRoot('C:\\').ok).toBe(false);
    expect(validateRoot(process.env.SystemRoot ?? 'C:\\Windows').ok).toBe(false);
    expect(validateRoot(os.homedir(), { ...process.env, USERPROFILE: os.homedir() }).ok).toBe(false);
    expect(validateRoot(dir).ok).toBe(true);
  });
});

describe('PC organization journal', () => {
  function seed(): string {
    const root = path.join(dir, 'Downloads');
    write('Downloads/Steuerbescheid_2024.pdf', PDF);
    write('Downloads/Rechnung_Telekom_2025-03.pdf', Buffer.concat([PDF, Buffer.from('a')]));
    write('Downloads/IMG_20230704.jpg', JPEG);
    write('Downloads/copy of IMG.jpg', JPEG);
    write('Downloads/big.iso.part', 'partial');
    write('Downloads/myrepo/.git/HEAD', 'ref: refs/heads/main');
    write('Downloads/myrepo/src/index.ts', 'export {}');
    return root;
  }

  it('proposes without touching the disk, applies with verification, recovers an interrupted move and undoes exactly', async () => {
    const root = seed();
    const before = fs.readdirSync(root).sort();
    const plan = await proposeOrganization(db, { roots: [root] });
    expect(fs.readdirSync(root).sort()).toEqual(before);
    const moves = listPlanMoves(db, plan.id);
    const s = plan.summary as any;
    expect(moves.find((m) => m.fromPath.endsWith('Steuerbescheid_2024.pdf'))?.toPath).toBe(path.join(root, 'Tax', '2024', 'Steuerbescheid_2024.pdf'));
    expect(moves.find((m) => m.category === 'unit')?.fromPath).toBe(path.join(root, 'myrepo'));
    expect(s.duplicates.sets).toBe(1);
    expect(s.temporary.files).toBe(1);
    expect(moves.some((m) => m.fromPath.includes('.part'))).toBe(false);

    // Simulate a crash after the rename but before the journal settled: the row says "moving" and the file is already there.
    const tax = moves.find((m) => m.fromPath.endsWith('Steuerbescheid_2024.pdf'))!;
    fs.mkdirSync(path.dirname(tax.toPath), { recursive: true });
    fs.renameSync(tax.fromPath, tax.toPath);
    updateMove(db, plan.id, tax.idx, { status: 'moving', finalPath: tax.toPath });

    const report = await applyOrganizationPlan(db, plan.id, { actor: 'test', expectedDigest: plan.digest, saveRules: true });
    expect(report.failedNow).toEqual([]);
    expect(fs.existsSync(path.join(root, 'myrepo'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'Media', 'Photos', '2023', 'IMG_20230704.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'big.iso.part'))).toBe(true);
    const settled = listPlanMoves(db, plan.id).find((m) => m.idx === tax.idx)!;
    expect(settled.status).toBe('verified');
    expect(report.plan.status).toBe('partially_applied');
    expect(listOrganizationRules(db, root).map((r) => r.category).sort()).toEqual(expect.arrayContaining(['invoices', 'photos', 'tax']));

    await expect(applyOrganizationPlan(db, plan.id, { actor: 'test', expectedDigest: 'f'.repeat(64) })).rejects.toThrow(/does not match/);

    const undo = await undoOrganizationPlan(db, plan.id);
    expect(undo.problems).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(before);
  });

  it('a routine-mode plan moves only categories with an approved rule', async () => {
    const root = seed();
    const first = await proposeOrganization(db, { roots: [root] });
    await applyOrganizationPlan(db, first.id, { actor: 'test', categories: ['tax'], saveRules: true });
    write('Downloads/Steuererklaerung_2025.pdf', Buffer.concat([PDF, Buffer.from('2025')]));
    write('Downloads/Arbeitsvertrag.pdf', Buffer.concat([PDF, Buffer.from('job')]));
    const routinePlan = await proposeOrganization(db, { roots: [root], targetBase: root, rules: listOrganizationRules(db, root), origin: 'routine' });
    const moves = listPlanMoves(db, routinePlan.id);
    expect(moves.map((m) => path.basename(m.fromPath))).toEqual(['Steuererklaerung_2025.pdf']);
    expect(((routinePlan.summary as any).ambiguous.examples as any[]).some((a) => a.path.endsWith('Arbeitsvertrag.pdf'))).toBe(true);
  });
});

describe('recurring routines', () => {
  it('computes weekly occurrences in the routine timezone and records missed runs truthfully', () => {
    const after = new Date('2026-11-04T12:00:00Z'); // a Wednesday
    const next = nextOccurrence({ dailyTime: '10:00', timezone: 'Europe/Berlin', recurrence: { kind: 'weekly', weekdays: [0] } }, after);
    expect(next.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    const task = createHouseholdRoutine(db, { kind: 'folder_cleanup', timezone: 'Europe/Berlin', scope: { folders: [dir] }, now: after });
    expect(task.nextRunAt).toBe('2026-11-08T09:00:00.000Z');
    expect(task.scope).toMatchObject({ folders: [dir], maxMovesPerRun: 100 });
    // Pandesh was off for four days past the occurrence: outside the 3-day weekly window → missed, next one scheduled.
    const missed: string[] = [];
    const claimed = claimDueScheduledTasks(db, new Date('2026-11-12T12:00:00Z'), (t, due) => { missed.push(due); recordMissedRun(db, t, due); });
    expect(claimed).toEqual([]);
    expect(missed).toEqual(['2026-11-08T09:00:00.000Z']);
    expect(listRoutineRuns(db, task.id)[0]).toMatchObject({ status: 'missed', trigger: 'missed' });
  });

  it('refuses operations a routine kind does not have', () => {
    expect(() => validateRoutineScope('folder_cleanup', { folders: ['x'], operations: ['delete_files'] })).toThrow(/cannot delete_files/);
    expect(() => validateRoutineScope('obligations_check', { operations: ['send_mail'] })).toThrow(/cannot send_mail/);
  });

  it('a run is recorded once per occurrence and stays inside its folder scope', async () => {
    const root = path.join(dir, 'Inbox');
    write('Inbox/Rechnung_2025.pdf', PDF);
    const task = createHouseholdRoutine(db, { kind: 'folder_cleanup', scope: { folders: [root] } });
    const r = await runHouseholdRoutine(db, null, task, 'schedule');
    expect(r.run?.status).toBe('succeeded');
    expect(r.run?.summary).toMatch(/0 file\(s\) moved by approved rules; 1 proposal/);
    expect(fs.existsSync(path.join(root, 'Rechnung_2025.pdf'))).toBe(true);
    expect((await runHouseholdRoutine(db, null, task, 'schedule')).run).toBeNull();
    expect(getCompanionRecord(db, `routine:${task.id}`)?.kind).toBe('task_status');
  });
});

describe('household obligations', () => {
  const invoice = (id: string, observedAt: string, text: string) => ({
    sourceType: 'gmail' as const, sourceRef: `gmail:${id}`, label: 'Ihre Telekom Rechnung für März', from: 'Telekom Deutschland GmbH <rechnung@telekom.de>', observedAt, text,
  });

  it('turns several emails about one contract into one record with evidence, and never calls an invoice unpaid', () => {
    const a = invoice('m1', '2026-03-03T08:00:00Z', 'Kundennummer: 551234987\nRechnungsbetrag: 39,95 € monatlich. Der Betrag wird am 10.03.2026 per SEPA-Lastschrift von Ihrem Konto abgebucht.');
    const fa = extractObligation(a)!;
    expect(fa).toMatchObject({ counterparty: 'Telekom Deutschland', amountCents: 3995, currency: 'EUR', date: '2026-03-10', dateKind: 'debit', cadence: 'monthly', accountNumber: '551234987' });
    const r1 = recordObligationSource(db, a, fa, Date.parse('2026-03-04T00:00:00Z'));
    expect(r1.created).toBe(true);
    expect(r1.obligation.paymentStatus).toBe('due_soon');
    expect(recordObligationSource(db, a, fa).newEvidence).toBe(false);

    const paid = invoice('m2', '2026-03-11T08:00:00Z', 'Kundennummer: 551234987\nVielen Dank für Ihre Zahlung. Der Betrag von 39,95 € wurde abgebucht.');
    const r2 = recordObligationSource(db, paid, extractObligation(paid)!, Date.parse('2026-03-12T00:00:00Z'));
    expect(r2.created).toBe(false);
    expect(r2.obligation.id).toBe(r1.obligation.id);
    expect(r2.obligation.paymentStatus).toBe('confirmed');
    expect(listObligationEvidence(db, r1.obligation.id)).toHaveLength(2);
  });

  it('derives payment status from all evidence', () => {
    const today = '2026-05-01';
    const bill = { signal: 'invoice' as const, observedAt: '2026-04-20T00:00:00Z', facts: {} };
    expect(derivePaymentStatus({ kind: 'bill', evidence: [bill], nextDate: '2026-04-28', dateKind: 'due', resolution: null, today })).toBe('potentially_overdue');
    expect(derivePaymentStatus({ kind: 'bill', evidence: [bill], nextDate: '2026-05-05', dateKind: 'due', resolution: null, today })).toBe('due_soon');
    expect(derivePaymentStatus({ kind: 'bill', evidence: [bill], nextDate: '2026-06-05', dateKind: 'due', resolution: null, today })).toBe('requested');
    expect(derivePaymentStatus({ kind: 'bill', evidence: [bill], nextDate: null, dateKind: null, resolution: null, today })).toBe('requested');
    expect(derivePaymentStatus({ kind: 'bill', evidence: [], nextDate: null, dateKind: null, resolution: null, today })).toBe('unknown');
    expect(derivePaymentStatus({ kind: 'delivery', evidence: [bill], nextDate: null, dateKind: null, resolution: null, today })).toBe('not_applicable');
  });

  it('a confirmed obligation becomes one Important Date; the phone resolving it applies exactly once', () => {
    const src = { sourceType: 'gmail' as const, sourceRef: 'gmail:n1', label: 'Dein Netflix-Abo verlängert sich', from: 'Netflix <info@mailer.netflix.com>', observedAt: '2026-11-01T08:00:00Z', text: 'Dein Abonnement verlängert sich am 15.11.2026. Preis: 13,99 € monatlich. Mitgliedsnummer: NFX-20931' };
    const ob = recordObligationSource(db, src, extractObligation(src)!).obligation;
    expect(listCompanionChanges(db, 0)).toHaveLength(0);
    decideObligation(db, ob.id, { action: 'confirm', actor: 'test' });
    decideObligation(db, ob.id, { action: 'confirm', actor: 'test' });
    const changes = listCompanionChanges(db, 0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ recordId: `obligation:${ob.id}`, kind: 'important_date', payload: { type: 'SUBSCRIPTION', date: '2026-11-15' } });
    const op = { opId: 'op-0000000001', recordId: `obligation:${ob.id}`, op: 'resolve' as const, resolution: 'paid' as const };
    expect(handleCompanionOps(db, 'phone-12345678', [op])[0].result).toBe('applied');
    expect(handleCompanionOps(db, 'phone-12345678', [op])[0].result).toBe('duplicate');
    expect(getObligation(db, ob.id)).toMatchObject({ status: 'resolved', resolution: 'paid', resolvedBy: 'jugaad:phone-12345678' });
    expect(listCompanionChanges(db, changes[0].revision)[0].payload).toMatchObject({ status: 'resolved', paymentStatus: 'confirmed' });
  });
});

describe('JUGAAD companion protocol', () => {
  it('pairs only with proof of the code, seals the device key, and authenticates every message', () => {
    const { code } = createCompanionPairingCode();
    const salt = crypto.randomBytes(16);
    const deviceId = 'jugaad-test-device';
    expect(() => redeemCompanionPairing(db, { deviceId, label: 'Pixel', salt: salt.toString('base64'), proof: pairingProof(pairingKey('WRONGCODE', salt), deviceId).toString('base64') })).toThrow(/wrong, expired/);
    const key = pairingKey(code, salt);
    const r = redeemCompanionPairing(db, { deviceId, label: 'Pixel', salt: salt.toString('base64'), proof: pairingProof(key, deviceId).toString('base64') });
    const sealed = JSON.parse(openCompanionMessage(key, `${deviceId}:pair`, r.sealedKey)) as { deviceKey: string };
    const deviceKey = Buffer.from(sealed.deviceKey, 'base64');
    expect(deviceKey).toHaveLength(32);
    // The code works once.
    expect(() => redeemCompanionPairing(db, { deviceId, label: 'Pixel', salt: salt.toString('base64'), proof: pairingProof(key, deviceId).toString('base64') })).toThrow();

    const msg = sealCompanionMessage(deviceKey, deviceId, JSON.stringify({ method: 'pull' }));
    expect(JSON.parse(openCompanionMessage(deviceKey, deviceId, msg))).toEqual({ method: 'pull' });
    expect(() => openCompanionMessage(crypto.randomBytes(32), deviceId, msg)).toThrow(/did not authenticate/);
    expect(() => openCompanionMessage(deviceKey, 'other-device', msg)).toThrow(/did not authenticate/);
    checkFreshness(deviceId, Date.now(), 'nonce-aaaaaaaa');
    expect(() => checkFreshness(deviceId, Date.now(), 'nonce-aaaaaaaa')).toThrow(/replayed/);
    expect(() => checkFreshness(deviceId, Date.now() - 3_600_000, 'nonce-bbbbbbbb')).toThrow(/too old/);
  });
});
