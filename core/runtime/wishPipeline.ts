/**
 * Wish-to-Reality pipeline: moves a wish goal forward with the capabilities Pandesh already has.
 *
 *   research_offers      → the governed web research runner (one network approval), offers read from retrieved pages
 *   assess_opportunities → earning options Pandesh can really carry out, sized to the shortfall; scams excluded
 *   develop_offering     → a working offering on disk: the offer, the intake questions and a validated sample deliverable
 *   earn                 → waits for money a person has verified; never invents income
 *   purchase_ready       → a prepared plan only; Pandesh never pays
 *
 * Nothing here publishes, contacts anyone, collects money or buys. Every figure shown comes from a retrieved page or the
 * ledger, and an offer is only "exact" when the page itself names the exact model.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import type { ToolExecutionResult } from './toolRunner';
import { WEBSITE_OFFERING, developWebsiteOffering } from './wishFulfilment';
import { renderWishCommerce } from '../domain/wishOrders';
import {
  type WishGoal, type WishOffer, evaluateWishPurchase, formatMoney, getWishGoal, listWishOpportunities, parseAmountToCents,
  prepareWishPurchase, renderWishStatus as renderGoalStatus, replaceWishOffers, replaceWishOpportunities, selectWishOpportunity, setWishOffering,
  setWishSpecs, setWishStage,
} from '../domain/wishes';

const CURRENCY_MARK: Record<string, string> = { EUR: '(?:€|EUR)', USD: '(?:\\$|USD)', GBP: '(?:£|GBP)' };
const AMOUNT = '(\\d{1,3}(?:[.\\s]\\d{3})*(?:,\\d{2})|\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})|\\d+(?:[.,]\\d{2})?)';

/** The goal's full status: the purchase side (wishes.ts) and the customers and real money (wishOrders.ts). */
export function renderWishStatus(db: CoreDatabase, goalId: string, nowMs = Date.now()): string {
  return [renderGoalStatus(db, goalId, nowMs), ...renderWishCommerce(db, goalId)].join('\n');
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

interface EvidenceSource { title: string; url: string; text: string }

/** Splits the research runner's "[S1] Title: / URL: / Evidence:" output into sources. */
export function parseEvidenceSources(output: string): EvidenceSource[] {
  return output.split(/\n\n(?=\[S\d+\]\n)/).map((block) => {
    const title = /^Title: (.*)$/m.exec(block)?.[1]?.trim() ?? '';
    const url = /^URL: (.*)$/m.exec(block)?.[1]?.trim() ?? '';
    const text = block.split('\n').slice(4).join(' ').trim();
    return { title, url, text };
  }).filter((s) => s.url);
}

function pricesIn(text: string, currency: string): Array<{ cents: number; index: number; from: boolean }> {
  const mark = CURRENCY_MARK[currency] ?? CURRENCY_MARK.EUR;
  const found: Array<{ cents: number; index: number; from: boolean }> = [];
  for (const re of [new RegExp(`(ab\\s+|from\\s+)?${mark}\\s?${AMOUNT}`, 'gi'), new RegExp(`(ab\\s+|from\\s+)?${AMOUNT}\\s?${mark}`, 'gi')]) {
    for (const m of text.matchAll(re)) {
      const cents = parseAmountToCents(m[2] ?? '');
      if (cents) found.push({ cents, index: m.index ?? 0, from: Boolean(m[1]) });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Reads offers from retrieved pages. A page is an exact match only when its title or URL names the goal's model;
 * otherwise its price is a related variant (shown, never bought on). Prices outside 0.25×–10× the target are dropped as
 * shipping fees or unrelated products.
 */
export function extractOffers(goal: Pick<WishGoal, 'productModel' | 'productName' | 'targetPriceCents' | 'currency'>, sources: EvidenceSource[], retrievedAt: string): Array<Omit<WishOffer, 'id' | 'goalId'>> {
  const key = compact(goal.productModel ?? goal.productName);
  const plausible = (c: number) => c >= goal.targetPriceCents * 0.25 && c <= goal.targetPriceCents * 10;
  const offers: Array<Omit<WishOffer, 'id' | 'goalId'>> = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const exact = compact(s.title).includes(key) || compact(decodeURIComponent(s.url)).includes(key);
    const titlePrice = pricesIn(s.title, goal.currency).find((p) => p.from && plausible(p.cents));
    const bodyPrices = pricesIn(s.text, goal.currency).filter((p) => plausible(p.cents));
    const bodyFrom = bodyPrices.find((p) => p.from);
    const pick = titlePrice ? { p: titlePrice, basis: 'title_from_price' as const, in: s.title }
      : bodyFrom ? { p: bodyFrom, basis: 'body_from_price' as const, in: s.text }
        : bodyPrices[0] ? { p: bodyPrices.slice(0, 5).sort((a, b) => a.cents - b.cents)[0], basis: 'listed_price' as const, in: s.text }
          : null;
    if (!pick) continue;
    const dedupe = `${s.url}|${pick.p.cents}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const excerpt = pick.in.slice(Math.max(0, pick.p.index - 80), pick.p.index + 60).replace(/\s+/g, ' ').trim();
    offers.push({
      sourceUrl: s.url,
      sourceTitle: s.title || null,
      priceCents: pick.p.cents,
      currency: goal.currency,
      matchLevel: exact ? 'exact' : 'related',
      basis: pick.basis,
      excerpt,
      evidenceHash: crypto.createHash('sha256').update(`${s.url}\n${s.title}\n${s.text}`).digest('hex'),
      retrievedAt,
    });
  }
  return offers.sort((a, b) => a.priceCents - b.priceCents);
}

/** Product facts from exact-model pages only, each kept with the page it came from (sources may disagree). */
export function extractSpecs(goal: Pick<WishGoal, 'productModel' | 'productName'>, sources: EvidenceSource[]): WishGoal['specs'] {
  const key = compact(goal.productModel ?? goal.productName);
  const specs: WishGoal['specs'] = {};
  const add = (k: string, value: string, source: string) => {
    const list = (specs[k] ??= []);
    if (!list.some((x) => x.value === value)) list.push({ value, source });
  };
  for (const s of sources) {
    if (!(compact(s.title).includes(key) || compact(decodeURIComponent(s.url)).includes(key))) continue;
    const text = `${s.title} ${s.text.slice(0, 2_000)}`;
    const size = /(\d{2}(?:[.,]\d)?)\s?(?:"|''|”|″|Zoll|-?inch)/i.exec(text);
    if (size) add('size', `${size[1].replace(',', '.')}"`, s.url);
    const res = /\b(\d{4})\s?[x×]\s?(\d{3,4})\b/.exec(text);
    if (res) add('resolution', `${res[1]}x${res[2]}`, s.url);
    for (const hz of new Set([...text.matchAll(/\b(\d{2,3})\s?Hz\b/gi)].map((m) => Number(m[1])).filter((n) => n >= 100))) add('refresh', `${hz} Hz`, s.url);
    const panel = /\b(VA|IPS|OLED|TN)\b/.exec(text);
    if (panel) add('panel', panel[1], s.url);
    const curve = /\b(1[05]00|1800|2300|3800)R\b/.exec(text);
    if (curve) add('curvature', `${curve[1]}R`, s.url);
  }
  return specs;
}

// ---------------------------------------------------------------- earning opportunities

interface OpportunityTemplate {
  key: string;
  title: string;
  pandeshDoes: string;
  youDo: string;
  /** Proposed price per unit; a proposal to confirm, not a market fact. */
  unitPriceCents: number;
  /** Share of the work Pandesh performs itself (0..1). */
  pandeshShare: number;
  hoursPerUnitForYou: number;
  capability: string;
  risks: string;
  exclusionReason?: string;
}

/** What Pandesh can actually do today, and what it must not do. Excluded entries are kept so the user sees why. */
export const OPPORTUNITY_TEMPLATES: OpportunityTemplate[] = [
  {
    key: 'one_page_websites',
    title: 'One-page websites for childminders (Kindertagespflege) in Germany',
    pandeshDoes: 'Records leads and orders, builds the site with Impressum and privacy pages from the intake answers, runs the quality checks, writes the handover and the §19 UStG invoice.',
    youDo: 'Register the business, talk to prospects through permitted channels, review and send the site, send the invoice, confirm the payment with its bank reference.',
    unitPriceCents: WEBSITE_OFFERING.priceCents,
    pandeshShare: 0.7,
    hoursPerUnitForYou: 1.5,
    capability: 'built-in site generator + quality checks + invoice writer',
    risks: 'Demand at this price is unproven until real conversations; registration (Gewerbe/Finanzamt) is required before the first sale; the customer supplies and answers for their own Impressum and privacy text.',
  },
  {
    key: 'cv_cover_letters',
    title: 'CV and cover-letter rewriting',
    pandeshDoes: 'Drafts the rewritten CV and letter with the local model.',
    youDo: 'Find customers, review every draft before it goes out, handle personal data carefully, collect payment.',
    unitPriceCents: 4_000,
    pandeshShare: 0.6,
    hoursPerUnitForYou: 0.75,
    capability: 'local model text generation',
    risks: 'Personal data (GDPR); quality must be checked by you each time.',
  },
  {
    key: 'sell_unused_items',
    title: 'Sell things you no longer use',
    pandeshDoes: 'Researches fair second-hand prices and writes the listings.',
    youDo: 'Choose the items, photograph, publish, ship and collect payment.',
    unitPriceCents: 0,
    pandeshShare: 0.3,
    hoursPerUnitForYou: 1,
    capability: 'web_research + text drafting',
    risks: 'Depends entirely on what you own; Pandesh does not know your items yet.',
  },
  {
    key: 'paid_surveys_and_get_paid_apps',
    title: 'Paid surveys / "get paid to" apps run by an assistant',
    pandeshDoes: '',
    youDo: '',
    unitPriceCents: 0,
    pandeshShare: 0,
    hoursPerUnitForYou: 0,
    capability: '',
    risks: '',
    exclusionReason: 'Automating them breaks their terms and they pay cents per hour; many are data-harvesting schemes.',
  },
  {
    key: 'trading_or_gambling',
    title: 'Trading, crypto or betting to grow the money',
    pandeshDoes: '',
    youDo: '',
    unitPriceCents: 0,
    pandeshShare: 0,
    hoursPerUnitForYou: 0,
    capability: '',
    risks: '',
    exclusionReason: 'Not earning: it can lose the money, and Pandesh must not move funds.',
  },
  {
    key: 'bulk_outreach_or_paid_reviews',
    title: 'Mass cold messaging or writing paid reviews',
    pandeshDoes: '',
    youDo: '',
    unitPriceCents: 0,
    pandeshShare: 0,
    hoursPerUnitForYou: 0,
    capability: '',
    risks: '',
    exclusionReason: 'Unsolicited bulk messages and fake reviews are unlawful in the EU (ePrivacy/UWG) and against platform rules.',
  },
];

/** Scores each option for this shortfall: how much Pandesh does, how few sales close the gap, how little of your time it takes. */
export function assessOpportunities(shortfallCents: number): Array<{ key: string; title: string; status: 'candidate' | 'excluded'; score: number; assessment: Record<string, unknown> }> {
  return OPPORTUNITY_TEMPLATES.map((t) => {
    if (t.exclusionReason) return { key: t.key, title: t.title, status: 'excluded' as const, score: 0, assessment: { exclusionReason: t.exclusionReason } };
    const unitsNeeded = t.unitPriceCents > 0 ? Math.max(1, Math.ceil(shortfallCents / t.unitPriceCents)) : null;
    const speed = unitsNeeded ? 1 / unitsNeeded : 0.1;
    const yourHours = unitsNeeded ? unitsNeeded * t.hoursPerUnitForYou : null;
    const score = Math.round((t.pandeshShare * 0.5 + speed * 0.3 + (yourHours !== null ? Math.max(0, 1 - yourHours / 10) : 0) * 0.2) * 100) / 100;
    return {
      key: t.key,
      title: t.title,
      status: 'candidate' as const,
      score,
      assessment: {
        pandeshDoes: t.pandeshDoes,
        youDo: t.youDo,
        unitPriceCents: t.unitPriceCents || null,
        priceBasis: t.key === 'one_page_websites'
          ? 'opening price to test: German freelancers quote ~€500–1,500 per one-pager (vendor guides, 2026-11-03); this offer is narrower; no niche price data found'
          : t.unitPriceCents ? 'proposed price — confirm before offering it to anyone' : 'unknown until you name the items',
        unitsNeeded,
        yourHours,
        capability: t.capability,
        risks: t.risks,
      },
    };
  });
}

// ---------------------------------------------------------------- the website offering (built in wishFulfilment.ts)

export { type SiteBrief, buildWebsiteDeliverable, developWebsiteOffering, renderOnePageSite, wishFolder } from './wishFulfilment';

// ---------------------------------------------------------------- advancing a goal

export interface AdvanceWishDeps {
  db: CoreDatabase;
  dataDir: string;
  research: (query: string) => Promise<ToolExecutionResult>;
  /** Asks for network access once; resolves false when it was not granted (nothing is searched then). */
  approveNetwork: (queries: string[]) => Promise<{ approved: boolean; message?: string }>;
  nowMs?: () => number;
}

export function offerQueries(goal: WishGoal): string[] {
  const subject = goal.productModel ?? goal.productName;
  return [`${subject} Preis`, `${subject} price ${goal.currency}`, `${subject} geizhals`];
}

/** Runs every stage that can run now, from the goal's current stage, and returns what happened plus the full status. */
export async function advanceWish(deps: AdvanceWishDeps, goalId: string, opts: { refreshOffers?: boolean } = {}): Promise<{ steps: string[]; status: string }> {
  const { db } = deps;
  const now = () => (deps.nowMs ? deps.nowMs() : Date.now());
  const steps: string[] = [];
  let goal = getWishGoal(db, goalId);
  if (goal.status === 'cancelled') return { steps: ['The goal is cancelled; nothing was done.'], status: renderWishStatus(db, goalId, now()) };

  const readinessBefore = evaluateWishPurchase(db, goalId, now());
  const offersStale = readinessBefore.blockers.some((b) => /more than a week old|No offer has been researched/.test(b));
  if (goal.stage === 'research_offers' || opts.refreshOffers || offersStale) {
    const queries = offerQueries(goal);
    const consent = await deps.approveNetwork(queries);
    if (!consent.approved) {
      steps.push(`Offer research not done: ${consent.message ?? 'network access was not approved'}.`);
      return { steps, status: renderWishStatus(db, goalId, now()) };
    }
    const sources: EvidenceSource[] = [];
    const failures: string[] = [];
    for (const q of queries) {
      const r = await deps.research(q);
      if (r.status === 'succeeded') sources.push(...parseEvidenceSources(String(r.output)));
      else failures.push(`"${q}": ${r.resultCategory}`);
    }
    const unique = [...new Map(sources.map((s) => [s.url, s])).values()];
    const retrievedAt = new Date(now()).toISOString();
    const offers = extractOffers(goal, unique, retrievedAt);
    if (!unique.length) {
      steps.push(`Offer research found no retrievable pages (${failures.join('; ')}). Nothing was recorded.`);
      return { steps, status: renderWishStatus(db, goalId, now()) };
    }
    replaceWishOffers(db, goalId, offers);
    setWishSpecs(db, goalId, extractSpecs(goal, unique));
    steps.push(`Researched ${queries.length} queries, read ${unique.length} pages, recorded ${offers.length} offer(s) (${offers.filter((o) => o.matchLevel === 'exact').length} for the exact model).${failures.length ? ` Failed queries: ${failures.join('; ')}.` : ''}`);
    if (goal.stage === 'research_offers') setWishStage(db, goalId, 'assess_opportunities');
    goal = getWishGoal(db, goalId);
  }

  // An offering built by an earlier version of the website offering is reassessed and rebuilt (the selection is kept).
  const current = listWishOpportunities(db, goalId).find((o) => o.status === 'selected');
  const outdated = current?.key === 'one_page_websites' && Number((current.offering as { version?: number } | null)?.version ?? 1) < WEBSITE_OFFERING.version;
  if (outdated) steps.push(`The website offering was built by an older version; reassessing and rebuilding it (now: ${WEBSITE_OFFERING.niche}).`);
  if (goal.stage === 'assess_opportunities' || outdated) {
    const shortfall = evaluateWishPurchase(db, goalId, now()).shortfallCents;
    const assessed = replaceWishOpportunities(db, goalId, assessOpportunities(shortfall));
    const best = assessed.filter((o) => o.status !== 'excluded').sort((a, b) => b.score - a.score)[0];
    const kept = assessed.find((o) => o.status === 'selected');
    if (!kept && best) selectWishOpportunity(db, goalId, best.key);
    const choice = kept
      ? `kept the selected "${kept.title}" (score ${kept.score.toFixed(2)}${best && best.key !== kept.key ? `; "${best.title}" now scores higher at ${best.score.toFixed(2)}` : ', highest'})`
      : `selected "${best?.title}" (highest score)`;
    steps.push(`Assessed ${assessed.length} earning options for a still-to-earn amount of ${formatMoney(shortfall, goal.currency)}; ${choice}. Excluded: ${assessed.filter((o) => o.status === 'excluded').map((o) => o.title).join('; ')}.`);
    setWishStage(db, goalId, 'develop_offering');
    goal = getWishGoal(db, goalId);
  }

  if (goal.stage === 'develop_offering') {
    const selected = listWishOpportunities(db, goalId).find((o) => o.status === 'selected');
    if (selected?.key === 'one_page_websites') {
      const a = selected.assessment as { unitPriceCents: number; unitsNeeded: number };
      const offering = developWebsiteOffering(deps.dataDir, goal, a.unitPriceCents, a.unitsNeeded);
      setWishOffering(db, selected.id, offering);
      steps.push(`Developed the offering "${selected.title}" in ${String(offering.folder)}. ${String(offering.validation)} Not published.`);
      setWishStage(db, goalId, 'earn');
    } else {
      steps.push(`Developing an offering for "${selected?.title ?? 'none'}" is not built yet; select "one_page_websites" or develop it by hand.`);
    }
    goal = getWishGoal(db, goalId);
  }

  const purchase = prepareWishPurchase(db, goalId, now());
  steps.push(purchase.plan ? 'Purchase plan prepared. It is NOT executed: you place the order yourself.' : `Purchase not prepared: ${purchase.blockers.join(' ')}`);
  return { steps, status: renderWishStatus(db, goalId, now()) };
}
