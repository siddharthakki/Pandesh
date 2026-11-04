/**
 * Household intelligence: reads the sources a person authorized (Gmail through its connector grant, named folders),
 * extracts obligations locally, folds them into deduplicated records, writes the briefing of what changed and keeps
 * the JUGAAD phone in step. No model, no cloud: every extraction is the deterministic local parser, and only the
 * derived facts plus a short excerpt are stored as evidence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { extractObligation, type SourceText } from '../domain/obligationExtraction';
import {
  decideObligation, getObligation, listObligations, recordObligationSource, renderObligation, type Obligation,
} from '../domain/householdObligations';
import { applyCompanionOps, upsertCompanionRecord, type CompanionOp, type CompanionOpResult, type CompanionRecord } from '../domain/companionSync';
import { extractPdfFromBytes } from '../attachments/documentExtraction';
import { isCredentialFilePath } from '../platform/credentialStore';
import { validateRoot } from './pcOrganizer';
import { nowIso } from '../domain/ids';

export type ConnectorReader = (toolName: 'gmail_search' | 'gmail_read_thread', args: Record<string, unknown>) => Promise<{ ok: true; data: any } | { ok: false; reason: string }>;

export const OBLIGATION_GMAIL_QUERY = '(rechnung OR invoice OR receipt OR quittung OR beleg OR abo OR abonnement OR subscription OR renewal OR verlängerung OR kündigung OR zahlung OR payment OR lastschrift OR mahnung OR zahlungserinnerung OR vertrag OR versicherung OR garantie OR warranty OR sendungsverfolgung OR terminbestätigung OR störung OR preisanpassung) -category:promotions -category:social';

const MAX_THREADS = 20;
const MAX_FILES = 200;

export interface ScanReport {
  sourcesRead: { gmailMessages: number; files: number };
  unavailable: string[];
  extracted: number;
  created: Obligation[];
  updated: Array<{ obligation: Obligation; changed: string[] }>;
  unchanged: number;
  ignored: number;
}

function messageText(m: any): string {
  const body = String(m?.bodyText ?? '').trim();
  if (body) return body;
  const html = String(m?.bodyHtml ?? '');
  return html ? html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ') : String(m?.snippet ?? '');
}

async function gmailSources(reader: ConnectorReader, lookbackDays: number, unavailable: string[]): Promise<SourceText[]> {
  const search = await reader('gmail_search', { query: `newer_than:${lookbackDays}d ${OBLIGATION_GMAIL_QUERY}`, maxResults: 40 });
  if (!search.ok) { unavailable.push(`Gmail: ${search.reason}`); return []; }
  const results: any[] = Array.isArray(search.data?.results) ? search.data.results : [];
  const out: SourceText[] = [];
  const seenThreads = new Set<string>();
  for (const r of results) {
    const threadId = String(r.threadId ?? '');
    if (threadId && !seenThreads.has(threadId) && seenThreads.size < MAX_THREADS) {
      seenThreads.add(threadId);
      const thread = await reader('gmail_read_thread', { threadId });
      if (thread.ok && Array.isArray(thread.data?.messages)) {
        for (const m of thread.data.messages) {
          if (!m?.id || out.some((s) => s.sourceRef === `gmail:${m.id}`)) continue;
          out.push({ sourceType: 'gmail', sourceRef: `gmail:${m.id}`, label: String(m.subject ?? '(no subject)'), from: String(m.from ?? ''), observedAt: String(m.receivedAt ?? nowIso()), text: messageText(m) });
        }
        continue;
      }
    }
    if (!out.some((s) => s.sourceRef === `gmail:${r.id}`)) {
      out.push({ sourceType: 'gmail', sourceRef: `gmail:${r.id}`, label: String(r.subject ?? '(no subject)'), from: String(r.from ?? ''), observedAt: String(r.receivedAt ?? nowIso()), text: String(r.snippet ?? '') });
    }
  }
  return out;
}

async function folderSources(folders: string[], options: { sinceMs?: number; inspectContents: boolean }, unavailable: string[]): Promise<SourceText[]> {
  const out: SourceText[] = [];
  for (const raw of folders) {
    const v = validateRoot(raw);
    if (!v.ok) { unavailable.push(`${raw}: ${v.reason}`); continue; }
    const pending = [{ dir: v.root, depth: 0 }];
    while (pending.length && out.length < MAX_FILES) {
      const { dir, depth } = pending.shift()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (entries.some((e) => e.name === '.git' || e.name === 'node_modules' || e.name === 'package.json')) continue;
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) { if (depth < 4) pending.push({ dir: full, depth: depth + 1 }); continue; }
        if (!e.isFile() || !/\.(pdf|txt|eml|md)$/i.test(e.name) || isCredentialFilePath(full)) continue;
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (options.sinceMs && st.mtimeMs < options.sinceMs) continue;
        let text = '';
        if (options.inspectContents) {
          try {
            if (/\.pdf$/i.test(e.name) && st.size <= 15 * 1024 * 1024) text = (await extractPdfFromBytes(new Uint8Array(fs.readFileSync(full)))).sections.slice(0, 4).map((s) => s.text).join('\n');
            else if (st.size <= 1024 * 1024) text = fs.readFileSync(full, 'utf8').slice(0, 20_000);
          } catch { /* unreadable: the name alone is used */ }
        }
        out.push({ sourceType: 'file', sourceRef: full, label: e.name, observedAt: new Date(st.mtimeMs).toISOString(), text });
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/** Reads the authorized sources and folds every obligation they mention into the records. Idempotent per source. */
export async function scanObligationSources(db: CoreDatabase, input: {
  gmail?: { reader: ConnectorReader; lookbackDays: number };
  folders?: string[];
  inspectContents?: boolean;
  sinceMs?: number;
  nowMs?: number;
}): Promise<ScanReport> {
  const unavailable: string[] = [];
  const sources = [
    ...(input.gmail ? await gmailSources(input.gmail.reader, input.gmail.lookbackDays, unavailable) : []),
    ...(input.folders?.length ? await folderSources(input.folders, { sinceMs: input.sinceMs, inspectContents: input.inspectContents === true }, unavailable) : []),
  ];
  const report: ScanReport = {
    sourcesRead: { gmailMessages: sources.filter((s) => s.sourceType === 'gmail').length, files: sources.filter((s) => s.sourceType === 'file').length },
    unavailable, extracted: 0, created: [], updated: [], unchanged: 0, ignored: 0,
  };
  for (const src of sources) {
    const facts = extractObligation(src);
    if (!facts) { report.ignored += 1; continue; }
    report.extracted += 1;
    const r = recordObligationSource(db, src, facts, input.nowMs);
    if (r.created) report.created.push(r.obligation);
    else if (r.newEvidence && r.changed.length) report.updated.push({ obligation: r.obligation, changed: r.changed });
    else report.unchanged += 1;
  }
  // A record created and then updated within the same scan is reported once, as new.
  report.updated = report.updated.filter((u) => !report.created.some((c) => c.id === u.obligation.id));
  report.created = report.created.map((c) => getObligation(db, c.id));
  return report;
}

const fmtMoney = (o: Obligation) => (o.amountCents === null ? '' : ` · ${(o.amountCents / 100).toFixed(2).replace('.', ',')} ${o.currency === 'EUR' || !o.currency ? '€' : o.currency}`);
const PAY_WORDS: Record<string, string> = {
  requested: 'payment requested (not proven unpaid)', due_soon: 'due soon', potentially_overdue: 'possibly overdue', confirmed: 'paid (confirmed)', unknown: 'payment status unknown', not_applicable: '',
};

/** The briefing: what changed since the previous run first, then what is coming up, then what needs a decision. */
export function renderHouseholdBriefing(db: CoreDatabase, report: ScanReport | null, nowMs = Date.now(), title = 'Household briefing'): { markdown: string; lines: string[] } {
  const lines: string[] = [];
  if (report) {
    for (const o of report.created) lines.push(`NEW: ${o.title}${o.nextDate ? ` — ${o.dateKind ?? 'date'} ${o.nextDate}` : ''}${fmtMoney(o)}${PAY_WORDS[o.paymentStatus] ? ` — ${PAY_WORDS[o.paymentStatus]}` : ''} (needs your confirmation)`);
    for (const u of report.updated) lines.push(`CHANGED: ${u.obligation.title} — ${u.changed.join(', ')} → ${u.obligation.nextDate ?? 'no date'}${fmtMoney(u.obligation)}, ${PAY_WORDS[u.obligation.paymentStatus] || u.obligation.paymentStatus}`);
  }
  const upcoming = listObligations(db, { status: ['confirmed', 'proposed'], withinDays: 30, nowMs });
  const overdue = upcoming.filter((o) => o.paymentStatus === 'potentially_overdue');
  for (const o of overdue) if (!lines.some((l) => l.includes(o.title))) lines.push(`CHECK: ${o.title} may be overdue (${o.nextDate})${fmtMoney(o)}`);
  for (const o of upcoming.filter((x) => x.paymentStatus !== 'potentially_overdue').slice(0, 10)) {
    if (!lines.some((l) => l.includes(o.title))) lines.push(`UPCOMING: ${o.title} — ${o.dateKind ?? 'date'} ${o.nextDate}${fmtMoney(o)}${PAY_WORDS[o.paymentStatus] ? ` — ${PAY_WORDS[o.paymentStatus]}` : ''}${o.status === 'proposed' ? ' (unconfirmed)' : ''}`);
  }
  const header = [`## ${title}`];
  if (report) {
    header.push(`Read ${report.sourcesRead.gmailMessages} email(s) and ${report.sourcesRead.files} file(s); ${report.extracted} mentioned an obligation; ${report.created.length} new, ${report.updated.length} changed, ${report.unchanged} already known.`);
    for (const u of report.unavailable) header.push(`Not read: ${u}.`);
  }
  if (!lines.length) lines.push('Nothing new and nothing due in the next 30 days.');
  return { markdown: [...header, '', ...lines.map((l) => `- ${l}`), '', 'Pandesh never pays, cancels or replies on its own. An invoice email does not prove a bill is unpaid; confirm or mark it paid.'].join('\n'), lines };
}

/** Publishes a briefing to the phone. One record per day: a second run that day replaces it (same id, new revision). */
export function publishBriefing(db: CoreDatabase, title: string, lines: string[], nowMs = Date.now()): CompanionRecord {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return upsertCompanionRecord(db, { recordId: `briefing:${day}`, kind: 'briefing', payload: { date: day, title, lines: lines.slice(0, 25).map((l) => l.slice(0, 240)), generatedAt: new Date(nowMs).toISOString() } });
}

/** What a phone operation means here: resolving a Pandesh-owned date marks the obligation resolved, on the PC too. */
export function handleCompanionOps(db: CoreDatabase, deviceId: string, ops: CompanionOp[]): CompanionOpResult[] {
  return applyCompanionOps(db, deviceId, ops, (op, record) => {
    if (op.op === 'ack') return { result: 'applied', detail: 'acknowledged' };
    if (!record || record.kind !== 'important_date' || !record.recordId.startsWith('obligation:')) return { result: 'rejected', detail: 'only Important Dates from Pandesh can be changed from the phone' };
    const id = record.recordId.slice('obligation:'.length);
    const ob = getObligation(db, id);
    if (op.op === 'resolve') {
      if (ob.status === 'resolved') return { result: 'applied', detail: 'already resolved' };
      decideObligation(db, id, { action: 'resolve', actor: `jugaad:${deviceId}`, resolution: op.resolution === 'paid' ? 'paid' : 'done' });
      return { result: 'applied', detail: `resolved (${op.resolution ?? 'done'}) on the phone` };
    }
    if (op.op === 'reopen') {
      if (ob.status !== 'resolved') return { result: 'applied', detail: 'already open' };
      decideObligation(db, id, { action: 'reopen', actor: `jugaad:${deviceId}` });
      return { result: 'applied', detail: 'reopened on the phone' };
    }
    return { result: 'rejected', detail: `unsupported operation ${op.op}` };
  });
}

export function renderObligationList(db: CoreDatabase, obligations: Obligation[]): string {
  if (!obligations.length) return 'No household obligations match.';
  return obligations.map((o) => renderObligation(db, o)).join('\n');
}
