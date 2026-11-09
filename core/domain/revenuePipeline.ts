/**
 * Revenue pipeline: the evidence-backed record of business development, per track, kept in <dataDir>/revenue-pipeline.json.
 *
 * Two kinds of writer, on purpose:
 *   - agents (Sales, Marketing, Social Media) may record what they produced: a researched lead with its public source, a
 *     prepared offer that exists as a file, and outreach/social drafts, which always land as `awaiting_approval`;
 *   - only the user (the host app) may approve or reject a draft and record what happened in the world: a response
 *     received, an opportunity, a confirmed order, money received — each with evidence the user supplies.
 * So the dashboard can never show a response, order or revenue that a model invented. Nothing here sends anything:
 * an approved draft is approved for the user to send themselves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type Track = 'catering' | 'digital';
export const TRACKS: Record<Track, string> = { catering: 'Kha Ke Dikha catering', digital: 'Wish-to-Reality digital services' };

export interface Lead { id: string; name: string; category: string; sourceUrl: string; why: string; contactRoute: string | null; status: 'qualified' | 'disqualified'; recordedBy: string; at: string }
export interface Offer { id: string; title: string; file: string; summary: string; recordedBy: string; at: string }
export interface Draft {
  id: string; kind: 'outreach' | 'social'; channel: string; leadId: string | null; text: string; recordedBy: string; at: string;
  status: 'awaiting_approval' | 'approved' | 'rejected'; decidedAt: string | null; decisionNote: string | null;
}
export interface Outcome { id: string; kind: 'response' | 'opportunity' | 'order' | 'payment'; leadId: string | null; amountEur: number | null; evidence: string; at: string }
export interface TrackRecord { leads: Lead[]; offers: Offer[]; drafts: Draft[]; outcomes: Outcome[] }
export type Pipeline = Record<Track, TrackRecord>;

const FILE = 'revenue-pipeline.json';
const empty = (): TrackRecord => ({ leads: [], offers: [], drafts: [], outcomes: [] });
const id = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();

export function readPipeline(dataDir: string): Pipeline {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) as Partial<Pipeline>;
    return { catering: { ...empty(), ...raw.catering }, digital: { ...empty(), ...raw.digital } };
  } catch { return { catering: empty(), digital: empty() }; }
}
function write(dataDir: string, p: Pipeline): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(p, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}
export function requireTrack(t: unknown): Track {
  if (t === 'catering' || t === 'digital') return t;
  throw new Error("track must be 'catering' or 'digital'");
}
const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

/** Agent: a lead found in a public source. The source URL is required; a lead without one is not a lead. */
export function recordLead(dataDir: string, track: Track, input: { name: unknown; category: unknown; sourceUrl: unknown; why: unknown; contactRoute?: unknown; qualified?: unknown }, by: string): Lead {
  const sourceUrl = clip(input.sourceUrl, 500);
  if (!/^https?:\/\/\S+\.\S+/.test(sourceUrl)) throw new Error('a lead needs the public source URL it was found on');
  const name = clip(input.name, 200);
  if (!name) throw new Error('a lead needs a name');
  const p = readPipeline(dataDir);
  if (p[track].leads.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" is already in the ${track} pipeline`);
  const lead: Lead = { id: id('lead'), name, category: clip(input.category, 120), sourceUrl, why: clip(input.why, 600), contactRoute: clip(input.contactRoute, 300) || null, status: input.qualified === false ? 'disqualified' : 'qualified', recordedBy: by, at: now() };
  p[track].leads.push(lead);
  write(dataDir, p);
  return lead;
}

/** Agent: a prepared offer. It must exist as a file, so "offer prepared" means there is something to show. */
export function recordOffer(dataDir: string, track: Track, input: { title: unknown; file: unknown; summary: unknown }, by: string): Offer {
  const file = clip(input.file, 500);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`the offer file does not exist: ${file || '(none given)'}`);
  const p = readPipeline(dataDir);
  const offer: Offer = { id: id('offer'), title: clip(input.title, 200) || path.basename(file), file, summary: clip(input.summary, 800), recordedBy: by, at: now() };
  p[track].offers.push(offer);
  write(dataDir, p);
  return offer;
}

/** Agent: an outreach or social draft. It always waits for the user; nothing is ever sent from here. */
export function recordDraft(dataDir: string, track: Track, input: { kind: unknown; channel: unknown; text: unknown; leadId?: unknown }, by: string): Draft {
  const text = clip(input.text, 5000);
  if (text.length < 20) throw new Error('a draft needs its full text');
  const kind = input.kind === 'social' ? 'social' : 'outreach';
  const p = readPipeline(dataDir);
  const leadId = clip(input.leadId, 40) || null;
  if (leadId && !p[track].leads.some((l) => l.id === leadId)) throw new Error(`no lead ${leadId} in the ${track} pipeline`);
  const draft: Draft = { id: id('draft'), kind, channel: clip(input.channel, 60) || (kind === 'social' ? 'instagram' : 'letter'), leadId, text, recordedBy: by, at: now(), status: 'awaiting_approval', decidedAt: null, decisionNote: null };
  p[track].drafts.push(draft);
  write(dataDir, p);
  return draft;
}

/** User only (host): approve or reject a draft. Approving does not send it. */
export function decideDraft(dataDir: string, track: Track, draftId: string, decision: 'approved' | 'rejected', note: string | null): Draft {
  const p = readPipeline(dataDir);
  const d = p[track].drafts.find((x) => x.id === draftId);
  if (!d) throw new Error(`no draft ${draftId}`);
  d.status = decision; d.decidedAt = now(); d.decisionNote = note;
  write(dataDir, p);
  return d;
}

/** User only (host): something that happened in the world, with the evidence the user has for it. */
export function recordOutcome(dataDir: string, track: Track, input: { kind: unknown; leadId?: unknown; amountEur?: unknown; evidence: unknown }): Outcome {
  const kind = ['response', 'opportunity', 'order', 'payment'].includes(String(input.kind)) ? input.kind as Outcome['kind'] : null;
  if (!kind) throw new Error('kind must be response, opportunity, order or payment');
  const evidence = clip(input.evidence, 1000);
  if (evidence.length < 10) throw new Error('an outcome needs evidence (what was received, from whom, when)');
  const amount = input.amountEur === undefined || input.amountEur === null || input.amountEur === '' ? null : Number(input.amountEur);
  if ((kind === 'payment' || kind === 'order') && !(amount !== null && Number.isFinite(amount) && amount > 0)) throw new Error(`a ${kind} needs its amount in EUR`);
  const p = readPipeline(dataDir);
  const o: Outcome = { id: id('out'), kind, leadId: clip(input.leadId, 40) || null, amountEur: amount, evidence, at: now() };
  p[track].outcomes.push(o);
  write(dataDir, p);
  return o;
}

/** Dashboard numbers, each derived from records (never from a model's statement). */
export function pipelineSummary(t: TrackRecord) {
  const sum = (k: Outcome['kind']) => t.outcomes.filter((o) => o.kind === k).reduce((a, o) => a + (o.amountEur ?? 0), 0);
  return {
    qualifiedLeads: t.leads.filter((l) => l.status === 'qualified').length,
    offersPrepared: t.offers.length,
    draftsAwaitingApproval: t.drafts.filter((d) => d.status === 'awaiting_approval').length,
    approvedOutreach: t.drafts.filter((d) => d.status === 'approved' && d.kind === 'outreach').length,
    approvedSocial: t.drafts.filter((d) => d.status === 'approved' && d.kind === 'social').length,
    responsesReceived: t.outcomes.filter((o) => o.kind === 'response').length,
    opportunities: t.outcomes.filter((o) => o.kind === 'opportunity').length,
    confirmedOrders: t.outcomes.filter((o) => o.kind === 'order').length,
    orderValueEur: sum('order'),
    verifiedRevenueEur: sum('payment'),
  };
}
