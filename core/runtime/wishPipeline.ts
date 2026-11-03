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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { ToolExecutionResult } from './toolRunner';
import { validateStaticHtml } from './staticHtmlValidation';
import {
  type WishGoal, type WishOffer, evaluateWishPurchase, formatMoney, getWishGoal, listWishOpportunities, parseAmountToCents,
  prepareWishPurchase, renderWishStatus, replaceWishOffers, replaceWishOpportunities, selectWishOpportunity, setWishOffering,
  setWishSpecs, setWishStage,
} from '../domain/wishes';

const CURRENCY_MARK: Record<string, string> = { EUR: '(?:€|EUR)', USD: '(?:\\$|USD)', GBP: '(?:£|GBP)' };
const AMOUNT = '(\\d{1,3}(?:[.\\s]\\d{3})*(?:,\\d{2})|\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})|\\d+(?:[.,]\\d{2})?)';

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
    title: 'One-page websites for local small businesses',
    pandeshDoes: 'Builds the complete page from a customer brief (texts, layout, opening hours, contact links) and checks it with the static HTML validator.',
    youDo: 'Find the customer, agree the price, hand over the files or publish them, and collect payment yourself.',
    unitPriceCents: 15_000,
    pandeshShare: 0.8,
    hoursPerUnitForYou: 1,
    capability: 'built-in site generator + static HTML validation (write_file path not needed)',
    risks: 'Customer must own the texts and photos they provide; register a small business/side income as your country requires.',
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
        priceBasis: t.unitPriceCents ? 'proposed price — confirm before offering it to anyone' : 'unknown until you name the items',
        unitsNeeded,
        yourHours,
        capability: t.capability,
        risks: t.risks,
      },
    };
  });
}

// ---------------------------------------------------------------- the website offering

export interface SiteBrief {
  businessName: string;
  tagline?: string;
  about?: string;
  services?: string[];
  hours?: string[];
  address?: string;
  phone?: string;
  email?: string;
  accent?: string;
  language?: string;
  /** Marks a demonstration page so it can never be mistaken for a real business. */
  sample?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A complete, self-contained, responsive one-page site (no external requests) from a customer brief. */
export function renderOnePageSite(brief: SiteBrief): string {
  const name = esc(brief.businessName.trim().slice(0, 120) || 'Business');
  const accent = /^#[0-9a-f]{6}$/i.test(brief.accent ?? '') ? brief.accent! : '#1f6f5c';
  const lang = /^[a-z]{2}$/.test(brief.language ?? '') ? brief.language! : 'en';
  const list = (items?: string[]) => (items ?? []).filter(Boolean).slice(0, 20).map((i) => `<li>${esc(i)}</li>`).join('');
  const tel = brief.phone ? `<a href="tel:${esc(brief.phone.replace(/[^\d+]/g, ''))}">${esc(brief.phone)}</a>` : '';
  const mail = brief.email && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(brief.email) ? `<a href="mailto:${esc(brief.email)}">${esc(brief.email)}</a>` : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<meta name="description" content="${esc((brief.tagline ?? brief.about ?? name).slice(0, 160))}">
<style>
:root { --accent: ${accent}; --ink: #1d2327; --muted: #5b6770; --bg: #fbfaf7; --card: #ffffff; }
* { box-sizing: border-box; }
body { margin: 0; font: 17px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
header { background: var(--accent); color: #fff; padding: 56px 20px 48px; text-align: center; }
header h1 { margin: 0 0 8px; font-size: clamp(28px, 6vw, 44px); line-height: 1.15; }
header p { margin: 0; opacity: .92; }
main { max-width: 860px; margin: 0 auto; padding: 32px 20px 56px; display: grid; gap: 20px; }
section { background: var(--card); border-radius: 12px; padding: 22px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
h2 { margin: 0 0 10px; font-size: 21px; color: var(--accent); }
ul { margin: 0; padding-left: 20px; }
a { color: var(--accent); }
.sample { background: #fff4c2; color: #4a3b00; text-align: center; padding: 8px 16px; font-size: 14px; }
footer { text-align: center; color: var(--muted); font-size: 14px; padding: 0 20px 32px; }
</style>
</head>
<body>
${brief.sample ? '<p class="sample">Sample page made by Pandesh to show the service. Not a real business.</p>\n' : ''}<header>
<h1>${name}</h1>
${brief.tagline ? `<p>${esc(brief.tagline)}</p>` : ''}
</header>
<main>
${brief.about ? `<section aria-labelledby="about"><h2 id="about">About us</h2><p>${esc(brief.about)}</p></section>` : ''}
${brief.services?.length ? `<section aria-labelledby="services"><h2 id="services">What we offer</h2><ul>${list(brief.services)}</ul></section>` : ''}
${brief.hours?.length ? `<section aria-labelledby="hours"><h2 id="hours">Opening hours</h2><ul>${list(brief.hours)}</ul></section>` : ''}
${brief.address || tel || mail ? `<section aria-labelledby="contact"><h2 id="contact">Contact</h2>${brief.address ? `<p>${esc(brief.address)}</p>` : ''}${tel ? `<p>Phone: ${tel}</p>` : ''}${mail ? `<p>Email: ${mail}</p>` : ''}</section>` : ''}
</main>
<footer>&copy; ${new Date().getFullYear()} ${name}</footer>
</body>
</html>
`;
}

const SAMPLE_BRIEF: SiteBrief = {
  businessName: 'Sample Bakery Lindenhof',
  tagline: 'Fresh bread every morning since 1998',
  about: 'A family bakery baking sourdough, rolls and seasonal cakes on site every morning.',
  services: ['Sourdough and rye bread', 'Breakfast rolls from 6:30', 'Cakes to order for birthdays and weddings'],
  hours: ['Mon–Fri 6:30–18:00', 'Sat 7:00–13:00', 'Sun closed'],
  address: 'Example Street 1, 12345 Sample Town',
  phone: '+49 000 000000',
  email: 'hello@example.com',
  accent: '#8a4b14',
  sample: true,
};

function writeValidatedSite(folder: string, relative: string, brief: SiteBrief): { file: string; structurallySound: boolean; findings: string[] } {
  const full = path.join(folder, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, renderOnePageSite(brief), 'utf8');
  const check = validateStaticHtml(folder, relative);
  return { file: full, structurallySound: check.structurallySound, findings: check.findings };
}

export function wishFolder(dataDir: string, goalId: string): string {
  if (!/^wish_[\w-]+$/.test(goalId)) throw new Error('invalid goal id');
  return path.join(dataDir, 'wishes', goalId);
}

/** Builds the website offering as files in Pandesh's own data folder. Nothing is published. */
export function developWebsiteOffering(dataDir: string, goal: WishGoal, unitPriceCents: number, unitsNeeded: number): Record<string, unknown> {
  const folder = path.join(wishFolder(dataDir, goal.id), 'offering-one-page-websites');
  fs.mkdirSync(folder, { recursive: true });
  const price = formatMoney(unitPriceCents, goal.currency);
  fs.writeFileSync(path.join(folder, 'OFFER.md'), `# One-page website for your business — ${price}

DRAFT — NOT PUBLISHED. Nothing here has been offered to anyone. Review and authorize before using it.

## What you get
- A single, fast page with your name, what you offer, opening hours and contact links (phone and email tap-to-call/mail).
- Works on phones and computers; no tracking, no external scripts, no monthly fee.
- One round of changes included. Delivered as files you own (index.html), ready for any web host.

## How it works
1. You answer the questions in intake-questions.md (10 minutes).
2. You receive the page within 2 working days.
3. You pay ${price} after you have seen it and are happy with it.

## Not included
Domain, hosting, photos you do not own, online shop or booking systems.

## Example
See sample/index.html (a made-up bakery, clearly marked as a sample).

---
Internal note for the owner: ${unitsNeeded} sale(s) at ${price} close the current gap for "${goal.productName}". The price is a proposal; payment is collected by you, never by Pandesh.
`, 'utf8');
  fs.writeFileSync(path.join(folder, 'intake-questions.md'), `# Questions for your website

1. Business name, and one line that says what you do.
2. Two or three sentences about you.
3. What you offer (a short list).
4. Opening hours.
5. Address, phone and email to show.
6. A colour you like (optional).
7. Language of the page.
8. Confirm that you own or may use every text you send.
`, 'utf8');
  const sample = writeValidatedSite(folder, 'sample/index.html', SAMPLE_BRIEF);
  return {
    folder,
    files: ['OFFER.md', 'intake-questions.md', 'sample/index.html'],
    unitPriceCents,
    unitsNeeded,
    validation: sample.structurallySound
      ? 'Sample page passed the structural HTML check (not a visual or semantic review).'
      : `Sample page FAILED the structural HTML check: ${sample.findings.join('; ')}`,
    sampleStructurallySound: sample.structurallySound,
    published: false,
    developedAt: new Date().toISOString(),
  };
}

/** Delivers one customer order of the website offering: the page, validated, in the goal's orders folder. Records no money. */
export function buildWebsiteDeliverable(dataDir: string, goalId: string, brief: SiteBrief): { file: string; structurallySound: boolean; findings: string[] } {
  if (!brief.businessName?.trim()) throw new Error('the brief needs a business name');
  const slug = brief.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'order';
  const folder = path.join(wishFolder(dataDir, goalId), 'offering-one-page-websites');
  return writeValidatedSite(folder, `orders/${slug}/index.html`, { ...brief, sample: false });
}

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

  if (goal.stage === 'assess_opportunities') {
    const shortfall = evaluateWishPurchase(db, goalId, now()).shortfallCents;
    const assessed = replaceWishOpportunities(db, goalId, assessOpportunities(shortfall));
    const best = assessed.filter((o) => o.status === 'candidate').sort((a, b) => b.score - a.score)[0];
    if (!goal.selectedOpportunityId && best) selectWishOpportunity(db, goalId, best.key);
    steps.push(`Assessed ${assessed.length} earning options for a shortfall of ${formatMoney(shortfall, goal.currency)}; selected "${best?.title}" (highest score). Excluded: ${assessed.filter((o) => o.status === 'excluded').map((o) => o.title).join('; ')}.`);
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
