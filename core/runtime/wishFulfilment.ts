/**
 * Wish-to-Reality, the website offering for real customers: what is sold, how one order is built, checked, handed over
 * and invoiced.
 *
 *   offering   → the customer-facing offer, intake questionnaire, a polished sample site and the owner's internal plan
 *                (acquisition through lawful channels, obligations before trading). Drafts; nothing is published.
 *   build      → index.html + impressum.html + datenschutz.html from the customer's intake answers, no external requests
 *   QC         → the structural HTML check plus the checks a German business site needs before anyone sees it
 *   handover   → the files and a handover note in the order folder; a person sends them
 *   invoice    → a §19 UStG small-business invoice (or a DEMO invoice that cannot pass for one); a person sends it
 *
 * Pandesh writes files in its own data folder only. It never sends, publishes or collects anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from '../domain/errors';
import { formatMoney, type WishGoal } from '../domain/wishes';
import { addWishOrderEvent, getWishOrder, nextInvoiceNumber, requireWishScope, type WishOrder } from '../domain/wishOrders';
import { validateStaticHtml } from './staticHtmlValidation';

/**
 * The offering as researched on 2026-11-03. German freelancers quote about €500–1,500 for a one-pager (vendor guides,
 * not neutral); this offer is narrower (built from the customer's own texts, no photos, copywriting, hosting or
 * domain), so €290 is the opening price to TEST with the first real conversations, not an established market price.
 */
export const WEBSITE_OFFERING = {
  version: 2,
  priceCents: 29_000,
  niche: 'Kindertagespflege (self-employed childminders) in Germany',
};

export interface SiteBrief {
  businessName: string;
  tagline?: string;
  about?: string;
  /** Where the business is, e.g. "Leipzig-Gohlis". */
  area?: string;
  /** Short facts shown at the top, e.g. "2 freie Plätze ab Januar". */
  highlights?: string[];
  services?: string[];
  hours?: string[];
  address?: string;
  phone?: string;
  email?: string;
  accent?: string;
  language?: string;
  /** The provider identification required by §5 DDG, as the customer states it. */
  impressum?: { name: string; address: string; phone?: string; email?: string; extra?: string[] };
  /** The customer's own privacy policy text (paragraphs separated by blank lines). Pandesh does not write legal text. */
  privacyPolicy?: string;
  /** Marks a demonstration page so it can never be mistaken for a real business. */
  sample?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const LABELS = {
  de: {
    about: 'Über uns', services: 'Angebot', hours: 'Zeiten', contact: 'Kontakt', call: 'Anrufen', write: 'E-Mail schreiben', phone: 'Telefon',
    email: 'E-Mail', impressum: 'Impressum', privacy: 'Datenschutz', back: 'Zurück zur Startseite',
    sample: 'Beispielseite von Pandesh zur Vorstellung des Angebots. Kein echtes Unternehmen.',
  },
  en: {
    about: 'About us', services: 'What we offer', hours: 'Opening hours', contact: 'Contact', call: 'Call', write: 'Send an e-mail', phone: 'Phone',
    email: 'Email', impressum: 'Legal notice', privacy: 'Privacy', back: 'Back to the home page',
    sample: 'Sample page made by Pandesh to show the service. Not a real business.',
  },
};

/** Readable text on the accent colour (WCAG relative luminance). */
function inkOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#1d2327' : '#ffffff';
}

function page(brief: SiteBrief, title: string, body: string): string {
  const accent = /^#[0-9a-f]{6}$/i.test(brief.accent ?? '') ? brief.accent! : '#1f6f5c';
  const lang = brief.language === 'en' ? 'en' : brief.language === 'de' ? 'de' : 'en';
  const L = LABELS[lang];
  const name = esc(brief.businessName.trim().slice(0, 120) || 'Business');
  const legal = brief.impressum ? `<nav aria-label="${L.impressum}"><a href="impressum.html">${L.impressum}</a> · <a href="datenschutz.html">${L.privacy}</a></nav>` : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${esc((brief.tagline ?? brief.about ?? brief.businessName).slice(0, 160))}">
<style>
:root { --accent: ${accent}; --on-accent: ${inkOn(accent)}; --ink: #1d2327; --muted: #5b6770; --bg: #f7f5f0; --card: #ffffff; --line: #e6e1d8; }
* { box-sizing: border-box; }
body { margin: 0; font: 17px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); }
a { color: var(--accent); }
.sample { background: #fff4c2; color: #4a3b00; text-align: center; padding: 8px 16px; font-size: 14px; margin: 0; }
header { background: var(--accent); color: var(--on-accent); padding: 64px 20px 56px; text-align: center; }
header h1 { margin: 0 0 10px; font-size: clamp(30px, 6vw, 48px); line-height: 1.12; letter-spacing: -0.01em; }
header p { margin: 0 auto; max-width: 620px; font-size: 19px; opacity: .95; }
.area { font-size: 15px; opacity: .9; margin-top: 6px; }
.cta { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 26px; }
.cta a { display: inline-block; padding: 12px 22px; border-radius: 999px; font-weight: 600; text-decoration: none; background: var(--on-accent); color: var(--accent); border: 2px solid var(--on-accent); }
.cta a.secondary { background: transparent; color: var(--on-accent); }
.highlights { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; list-style: none; padding: 0; margin: -22px auto 0; max-width: 860px; }
.highlights li { background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 8px 16px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 6px rgba(0,0,0,.06); }
main { max-width: 860px; margin: 0 auto; padding: 36px 20px 56px; display: grid; gap: 22px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px 26px; }
h2 { margin: 0 0 12px; font-size: 22px; color: var(--accent); }
ul { margin: 0; padding-left: 20px; }
.cards { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.cards li { background: var(--bg); border-radius: 10px; padding: 14px 16px; }
.legal p { white-space: pre-line; }
footer { text-align: center; color: var(--muted); font-size: 14px; padding: 0 20px 36px; }
footer nav { margin-bottom: 6px; }
</style>
</head>
<body>
${brief.sample ? `<p class="sample">${L.sample}</p>\n` : ''}${body}
<footer>${legal}<div>&copy; ${new Date().getFullYear()} ${name}</div></footer>
</body>
</html>
`;
}

/** The home page: a complete, self-contained, responsive one-page site (no external requests) from a customer brief. */
export function renderOnePageSite(brief: SiteBrief): string {
  const L = LABELS[brief.language === 'de' ? 'de' : 'en'];
  const name = esc(brief.businessName.trim().slice(0, 120) || 'Business');
  const list = (items?: string[]) => (items ?? []).filter(Boolean).slice(0, 20).map((i) => `<li>${esc(i)}</li>`).join('');
  const telHref = brief.phone ? `tel:${esc(brief.phone.replace(/[^\d+]/g, ''))}` : '';
  const mail = brief.email && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(brief.email) ? esc(brief.email) : '';
  const cta = telHref || mail
    ? `<div class="cta">${telHref ? `<a href="${telHref}">${L.call}</a>` : ''}${mail ? `<a class="${telHref ? 'secondary' : ''}" href="mailto:${mail}">${L.write}</a>` : ''}</div>`
    : '';
  const body = `<header>
<h1>${name}</h1>
${brief.tagline ? `<p>${esc(brief.tagline)}</p>` : ''}
${brief.area ? `<p class="area">${esc(brief.area)}</p>` : ''}
${cta}
</header>
${brief.highlights?.length ? `<ul class="highlights">${list(brief.highlights.slice(0, 4))}</ul>` : ''}
<main>
${brief.about ? `<section aria-labelledby="about"><h2 id="about">${L.about}</h2><p>${esc(brief.about)}</p></section>` : ''}
${brief.services?.length ? `<section aria-labelledby="services"><h2 id="services">${L.services}</h2><ul class="cards">${list(brief.services)}</ul></section>` : ''}
${brief.hours?.length ? `<section aria-labelledby="hours"><h2 id="hours">${L.hours}</h2><ul>${list(brief.hours)}</ul></section>` : ''}
${brief.address || telHref || mail ? `<section aria-labelledby="contact"><h2 id="contact">${L.contact}</h2>${brief.address ? `<p>${esc(brief.address)}</p>` : ''}${telHref ? `<p>${L.phone}: <a href="${telHref}">${esc(brief.phone!)}</a></p>` : ''}${mail ? `<p>${L.email}: <a href="mailto:${mail}">${mail}</a></p>` : ''}</section>` : ''}
</main>`;
  return page(brief, name, body);
}

/** Impressum and privacy pages carry exactly what the customer stated; Pandesh adds no legal wording of its own. */
export function renderLegalPage(brief: SiteBrief, kind: 'impressum' | 'datenschutz'): string {
  const L = LABELS[brief.language === 'de' ? 'de' : 'en'];
  const imp = brief.impressum;
  const content = kind === 'impressum'
    ? (imp ? [imp.name, imp.address, imp.phone ? `${L.phone}: ${imp.phone}` : '', imp.email ? `${L.email}: ${imp.email}` : '', ...(imp.extra ?? [])].filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('\n') : '')
    : (brief.privacyPolicy ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n');
  const title = kind === 'impressum' ? L.impressum : L.privacy;
  return page(brief, `${title} – ${esc(brief.businessName.trim().slice(0, 120))}`, `<main>
<section class="legal" aria-labelledby="t"><h2 id="t">${title}</h2>
${content}
</section>
<p><a href="index.html">${L.back}</a></p>
</main>`);
}

/** Writes the site (index + legal pages when the brief has an Impressum) into `siteDir`. */
export function writeSite(siteDir: string, brief: SiteBrief): string[] {
  fs.mkdirSync(siteDir, { recursive: true });
  const files: Array<[string, string]> = [['index.html', renderOnePageSite(brief)]];
  if (brief.impressum) files.push(['impressum.html', renderLegalPage(brief, 'impressum')], ['datenschutz.html', renderLegalPage(brief, 'datenschutz')]);
  for (const [name, html] of files) fs.writeFileSync(path.join(siteDir, name), html, 'utf8');
  return files.map(([name]) => name);
}

export interface SiteQualityCheck { passed: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }

const PLACEHOLDER = /example\.(com|org)|Musterstra(ß|ss)e|Beispielstra(ß|ss)e|Example Street|Lorem ipsum|\b0{3}\s?0{3,}|Kein echtes Unternehmen|Not a real business|\bTODO\b|\[(Name|Adresse|Text)\]/i;

/** The checks a German small-business site needs before a customer sees it. A real order with placeholder text fails. */
export function qualityCheckSite(siteDir: string, mode: 'real' | 'demo'): SiteQualityCheck {
  const checks: SiteQualityCheck['checks'] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const read = (f: string) => { try { return fs.readFileSync(path.join(siteDir, f), 'utf8'); } catch { return null; } };
  const pages = ['index.html', 'impressum.html', 'datenschutz.html'];
  for (const f of pages) {
    const html = read(f);
    if (html === null) { add(`${f} exists`, false, `${f} is missing`); continue; }
    const v = validateStaticHtml(siteDir, f);
    add(`${f} structure`, v.structurallySound, v.structurallySound ? `${f} passed the structural HTML check` : `${f}: ${v.findings.join('; ')}`);
    add(`${f} mobile + language`, /<meta name="viewport"/.test(html) && /<html lang="[a-z]{2}"/.test(html) && /<title>[^<]+<\/title>/.test(html), `${f} has viewport, language and title`);
    const external = /<(script|img|iframe)[^>]+src="https?:|<link[^>]+href="https?:|@import|url\(\s*['"]?https?:/i.test(html);
    add(`${f} no external requests`, !external, external ? `${f} loads something from another server (privacy notice and consent would be needed)` : `${f} loads nothing from other servers`);
    add(`${f} size`, html.length < 100_000, `${f} is ${Math.round(html.length / 1024)} KB`);
    if (mode === 'real') {
      const hit = PLACEHOLDER.exec(html);
      add(`${f} no placeholders`, !hit, hit ? `${f} still contains placeholder/sample text "${hit[0]}"` : `${f} has no placeholder text`);
    }
  }
  const index = read('index.html') ?? '';
  const linked = /href="impressum\.html"/.test(index) && /href="datenschutz\.html"/.test(index);
  add('legal links', linked, linked ? 'the home page footer links to Impressum and Datenschutz' : 'the home page does not link to Impressum and Datenschutz (the brief has no Impressum)');
  const impressum = (read('impressum.html') ?? '').replace(/<[^>]+>/g, ' ');
  const identified = /\d{5}/.test(impressum) && /@|Telefon|Phone|\+\d/.test(impressum);
  add('Impressum content', identified, identified ? 'the Impressum names a postal address (with postcode) and a fast contact (e-mail or phone)' : 'the Impressum lacks a postal address with postcode or an e-mail/phone contact');
  const privacyText = (read('datenschutz.html') ?? '').replace(/<style[\s\S]*?<\/style>|<footer[\s\S]*?<\/footer>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  // A generator-made privacy policy runs to thousands of characters; a few lines are a stub, not a policy.
  add('privacy policy present', privacyText.length >= 800, privacyText.length >= 800
    ? `the privacy page carries the customer's own privacy policy (${privacyText.length} characters)`
    : `the privacy page has only ${privacyText.length} characters of text; the customer's complete privacy policy is needed`);
  return { passed: checks.every((c) => c.ok), checks };
}

export function wishFolder(dataDir: string, goalId: string): string {
  if (!/^wish_[\w-]+$/.test(goalId)) throw new Error('invalid goal id');
  return path.join(dataDir, 'wishes', goalId);
}

const deDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const deMoney = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;

// ---------------------------------------------------------------- one order: build, check, hand over, invoice

/** Builds the customer's site from the intake answers, checks it and writes the handover package. Sends nothing. */
export function fulfilWishOrder(db: CoreDatabase, dataDir: string, orderId: string): WishOrder {
  const order = getWishOrder(db, orderId);
  if (!['intake_received', 'qc_failed', 'built'].includes(order.status)) throw new CoreError('invalid_transition', `order is ${order.status}; it is built after the intake answers arrive`);
  const brief = order.brief as unknown as SiteBrief | null;
  if (!brief?.businessName?.trim()) throw new CoreError('invalid_request', 'the intake answers have no business name');
  const folder = path.join(wishFolder(dataDir, order.goalId), 'orders', order.id);
  const siteDir = path.join(folder, 'site');
  fs.rmSync(siteDir, { recursive: true, force: true });
  const files = writeSite(siteDir, { ...brief, sample: order.mode === 'demo' });
  addWishOrderEvent(db, orderId, { by: 'pandesh', step: `site built (${files.join(', ')})` }, { sql: 'folder = ?', params: [folder] });
  const qc = qualityCheckSite(siteDir, order.mode);
  const failed = qc.checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(folder, 'UEBERGABE.md'), `# Übergabe: Website „${brief.businessName}“${order.mode === 'demo' ? ' (DEMO – kein echter Auftrag)' : ''}

## Inhalt
${files.map((f) => `- site/${f}`).join('\n')}

## So kommt die Seite online
1. Bei einem Hosting-Anbieter Ihrer Wahl ein Webspace-Paket mit Ihrer Domain buchen (Ihr Vertrag, auf Ihren Namen).
2. Die drei Dateien aus dem Ordner „site“ in das Hauptverzeichnis des Webspace hochladen (per Datei-Manager des Anbieters oder FTP).
3. HTTPS/SSL im Kundenbereich des Anbieters einschalten und die Seite auf Handy und Computer aufrufen.
Auf Wunsch machen wir die Schritte 2–3 gemeinsam (Bildschirmfreigabe, ca. 20 Minuten).

## Ihre Verantwortung
- Impressum und Datenschutzerklärung enthalten genau Ihre Angaben. Sie sind Ihre rechtlichen Erklärungen; wir geben keine Rechtsberatung.
- Sie haben die Rechte an allen Texten und Bildern, die Sie geliefert haben. Fotos von Kindern nur mit schriftlicher Einwilligung der Eltern.

## Qualitätsprüfung
${qc.checks.map((c) => `- ${c.ok ? '✓' : '✗'} ${c.detail}`).join('\n')}

Eine Änderungsrunde ist im Preis enthalten.
`, 'utf8');
  return addWishOrderEvent(db, orderId, { by: 'pandesh', step: qc.passed ? 'QC passed, handover package written' : `QC failed: ${failed.map((c) => c.detail).join('; ')}` }, {
    status: qc.passed ? 'built' : 'qc_failed', sql: 'qcJson = ?', params: [JSON.stringify(qc)],
  });
}

/** A person sent the files (and, if agreed, uploaded them with the customer) and the customer accepted them. */
export function markWishOrderDelivered(db: CoreDatabase, orderId: string, minutes?: number): WishOrder {
  const order = getWishOrder(db, orderId);
  if (order.status !== 'built') throw new CoreError('invalid_transition', `order is ${order.status}; only a built site that passed QC can be delivered`);
  return addWishOrderEvent(db, orderId, { by: 'human', step: 'delivered and accepted by the customer', ...(minutes ? { minutes } : {}) }, { status: 'delivered' });
}

/** Writes the invoice for a delivered order. A real invoice needs the 'payments' authorization and the §19 status. */
export function invoiceWishOrder(db: CoreDatabase, dataDir: string, orderId: string, goal: Pick<WishGoal, 'currency'>, nowMs = Date.now()): WishOrder {
  const order = getWishOrder(db, orderId);
  if (order.status !== 'delivered') throw new CoreError('invalid_transition', `order is ${order.status}; it is invoiced after delivery`);
  const business = requireWishScope(db, order.mode, 'payments');
  if (order.mode === 'real') {
    if (business!.vatMode !== 'kleinunternehmer') throw new CoreError('invalid_request', 'Pandesh only writes §19 UStG small-business invoices; with regular VAT use your accounting software');
    if (!order.customerAddress) throw new CoreError('invalid_request', 'an invoice needs the customer\'s postal address');
  }
  const seller = order.mode === 'real' ? business! : { legalName: 'DEMO-Anbieter (fiktiv)', address: 'Keine Anschrift – Demonstration', email: 'demo@invalid', phone: null, taxNumber: null, paymentDetails: 'keine – Demonstration' };
  const number = nextInvoiceNumber(db, order.mode, new Date(nowMs).getFullYear());
  const today = new Date(nowMs).toISOString();
  const due = new Date(nowMs + 14 * 86_400_000).toISOString();
  const deliveredAt = [...order.events].reverse().find((e) => e.step.startsWith('delivered'))?.at ?? today;
  const site = String((order.brief as { businessName?: string } | null)?.businessName ?? order.customerName);
  const pay = seller.paymentDetails ?? '';
  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Rechnung ${esc(number)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#1d2327;max-width:760px;margin:40px auto;padding:0 24px}table{width:100%;border-collapse:collapse;margin:24px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right;white-space:nowrap}.demo{background:#fff4c2;padding:10px;font-weight:700;text-align:center}.small{color:#5b6770;font-size:13px}</style></head>
<body>
${order.mode === 'demo' ? '<p class="demo">DEMO – KEINE GÜLTIGE RECHNUNG. Simulierter Auftrag, nichts zu bezahlen.</p>' : ''}
<p>${esc(seller.legalName)}<br>${esc(seller.address)}<br>${esc(seller.email)}${seller.phone ? `<br>${esc(seller.phone)}` : ''}${seller.taxNumber ? `<br>Steuernummer: ${esc(seller.taxNumber)}` : ''}</p>
<p>${esc(order.customerName)}<br>${esc(order.customerAddress ?? '')}</p>
<h1>Rechnung</h1>
<p>Rechnungsnummer: ${esc(number)}<br>Rechnungsdatum: ${deDate(today)}<br>Leistungsdatum: ${deDate(deliveredAt)}</p>
<table><tr><th>Leistung</th><th class="r">Menge</th><th class="r">Betrag</th></tr>
<tr><td>Erstellung einer einseitigen Website mit Impressum- und Datenschutzseite für „${esc(site)}“, inkl. einer Änderungsrunde, Übergabe der Dateien</td><td class="r">1</td><td class="r">${deMoney(order.priceCents)}</td></tr>
<tr><th>Gesamtbetrag</th><th></th><th class="r">${deMoney(order.priceCents)}</th></tr></table>
<p>Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.</p>
<p>Bitte überweisen Sie den Betrag bis zum ${deDate(due)} ohne Abzug${pay ? ` an: ${esc(pay)}` : ''}. Verwendungszweck: ${esc(number)}</p>
<p class="small">Vielen Dank für Ihren Auftrag.</p>
</body></html>
`;
  const folder = order.folder ?? path.join(wishFolder(dataDir, order.goalId), 'orders', order.id);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rechnung-${number}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return addWishOrderEvent(db, orderId, { by: 'pandesh', step: `invoice ${number} written (${formatMoney(order.priceCents, goal.currency)}); a person sends it` }, {
    status: 'invoiced', sql: 'invoiceNumber = ?, invoiceFile = ?', params: [number, file],
  });
}

// ---------------------------------------------------------------- the offering itself

const SAMPLE_BRIEF: SiteBrief = {
  businessName: 'Kindertagespflege Kleine Füchse',
  tagline: 'Liebevolle Betreuung für Kinder von 1 bis 3 Jahren in familiärer Atmosphäre',
  area: 'Beispielstadt-Nord',
  highlights: ['2 freie Plätze ab Januar', 'Max. 5 Kinder', 'Garten & Wald in der Nähe'],
  about: 'Ich bin Anna Beispiel, qualifizierte Kindertagespflegeperson mit Pflegeerlaubnis des Jugendamts. In meiner Wohnung mit eigenem Spielzimmer und Garten betreue ich bis zu fünf Kinder. Feste Rituale, viel Zeit draußen und eine sanfte Eingewöhnung nach dem Berliner Modell geben den Kleinen Sicherheit.',
  services: ['Betreuung Mo–Fr, 7:30–15:30 Uhr', 'Frisches, ausgewogenes Mittagessen', 'Eingewöhnung nach dem Berliner Modell', 'Täglich draußen: Garten, Spielplatz, Wald', 'Entwicklungsgespräche mit den Eltern', 'Förderung über das Jugendamt möglich'],
  hours: ['Montag bis Freitag 7:30–15:30 Uhr', 'Schließzeiten werden zu Jahresbeginn bekannt gegeben'],
  address: 'Beispielstraße 1, 00000 Beispielstadt',
  phone: '+49 000 0000000',
  email: 'kontakt@example.com',
  accent: '#c2562b',
  language: 'de',
  impressum: {
    name: 'Anna Beispiel – Kindertagespflege Kleine Füchse',
    address: 'Beispielstraße 1, 00000 Beispielstadt',
    phone: '+49 000 0000000',
    email: 'kontakt@example.com',
    extra: ['Pflegeerlaubnis nach § 43 SGB VIII erteilt durch: Jugendamt Beispielstadt (Beispielangabe)'],
  },
  privacyPolicy: [
    'BEISPIELTEXT. In einem echten Auftrag steht hier die Datenschutzerklärung, die die Kundin selbst erstellt hat (z. B. mit einem Datenschutz-Generator) und für die sie verantwortlich ist.',
    'Diese Seite lädt keine Schriften, Karten, Videos oder Statistik-Dienste von anderen Servern und setzt keine Cookies. Beim Aufruf verarbeitet der Hosting-Anbieter technisch notwendige Server-Logdaten.',
    'Wenn Sie per E-Mail oder Telefon Kontakt aufnehmen, werden Ihre Angaben zur Bearbeitung der Anfrage verwendet und nicht weitergegeben.',
    'Ihre Rechte: Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Widerspruch und Beschwerde bei einer Datenschutz-Aufsichtsbehörde. Verantwortlich ist die im Impressum genannte Person.',
  ].join('\n\n'),
  sample: true,
};

function offerTexts(price: string): Record<string, string> {
  return {
    'ANGEBOT.md': `# Ihre eigene Website für die Kindertagespflege – ${price}

ENTWURF – NICHT VERÖFFENTLICHT. Erst nach Gewerbe-/Steueranmeldung und ausdrücklicher Freigabe verwenden.

Eltern suchen ihre Tagesmutter oder ihren Tagesvater heute zuerst im Internet. Mit einer eigenen, schlichten Seite finden sie Sie direkt: wer Sie sind, wie Sie betreuen, wann ein Platz frei wird und wie man Sie erreicht.

## Das bekommen Sie
- Eine fertige Startseite: Name, Ihr Betreuungskonzept in Ihren Worten, Angebot, Zeiten, freie Plätze, Kontakt mit Anruf- und E-Mail-Knopf.
- Eine Impressum- und eine Datenschutzseite mit Ihren eigenen Angaben, gut sichtbar verlinkt.
- Läuft auf Handy und Computer, lädt nichts von fremden Servern, keine Cookies, kein Tracking.
- Eine Änderungsrunde inklusive. Sie erhalten die Dateien und gehören Ihnen; keine monatliche Gebühr an uns.
- Auf Wunsch laden wir die Seite gemeinsam bei Ihrem Hosting-Anbieter hoch (Bildschirmfreigabe, ca. 20 Minuten).

## So läuft es
1. Kurzes Gespräch (15 Minuten): passt das für Sie?
2. Sie beantworten den Fragebogen (ca. 20 Minuten).
3. Innerhalb von 3 Werktagen sehen Sie Ihre Seite.
4. Nach Ihrer Abnahme erhalten Sie die Rechnung über ${price}. Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.

## Nicht enthalten
Domain und Hosting (bei einem Anbieter Ihrer Wahl, auf Ihren Namen; meist wenige Euro im Monat), Fotos, Texterstellung, Rechtsberatung. Impressum und Datenschutzerklärung sind Ihre eigenen Angaben.

## Beispiel
Siehe sample/index.html – eine erfundene Kindertagespflege, deutlich als Beispiel gekennzeichnet.
`,
    'FRAGEBOGEN.md': `# Fragebogen für Ihre Website

1. Name Ihrer Kindertagespflege und ein Satz, der sie beschreibt.
2. Stadtteil/Ort (ohne genaue Adresse, wenn Sie sie nicht zeigen möchten).
3. Ein paar Sätze über Sie und Ihr Konzept (Qualifikation, Eingewöhnung, Tagesablauf, Essen, draußen sein).
4. Ihr Angebot als Stichpunkte (z. B. Betreuungszeiten, Alter der Kinder, Anzahl Plätze, Förderung über das Jugendamt).
5. Freie Plätze und ab wann (falls Sie das zeigen möchten).
6. Betreuungszeiten und Schließzeiten.
7. Telefon und E-Mail für Eltern.
8. Impressum: vollständiger Name, ladungsfähige Anschrift, Telefon oder E-Mail; ggf. zuständiges Jugendamt (Pflegeerlaubnis).
9. Datenschutzerklärung: bitte selbst erstellen (z. B. mit einem Datenschutz-Generator) und als Text schicken. Die Seite nutzt keine Cookies, keine Fremd-Schriften, Karten oder Statistik – das hält sie kurz.
10. Eine Farbe, die zu Ihnen passt (optional).
11. Ihre Rechnungsanschrift.
12. Bestätigung: Sie dürfen alle Texte und Bilder verwenden; Fotos von Kindern nur mit schriftlicher Einwilligung der Eltern (wir empfehlen: keine Kinderfotos).
`,
    'brief-vorlage.json': `${JSON.stringify({
      businessName: '', tagline: '', area: '', highlights: [''], about: '', services: [''], hours: [''], address: '', phone: '', email: '', accent: '#c2562b', language: 'de',
      impressum: { name: '', address: '', phone: '', email: '', extra: [''] }, privacyPolicy: '',
    }, null, 2)}\n`,
    'ENTWURF-ANSPRACHE.md': `# Entwürfe für die Kundengewinnung – NICHT VERSENDEN/VERÖFFENTLICHEN ohne Freigabe

## A. Nachricht an Menschen, die Sie persönlich kennen (Familie, Freunde, Kita-/Tagespflege-Eltern)
Hallo [Name], ich biete seit Kurzem einfache Websites für Tagesmütter und Tagesväter an: eine Seite mit Konzept, Zeiten, freien Plätzen und Kontakt, ${price} einmalig, keine monatlichen Kosten an mich. Kennst du jemanden in der Kindertagespflege, der so etwas gebrauchen könnte? Ein Beispiel schicke ich gern. Danke!

## B. Kleinanzeigen – Rubrik Dienstleistungen (eine Anzeige, Sie antworten nur auf Anfragen)
Titel: Website für Tagesmütter/Tagesväter – ${price} einmalig
Text: Eltern suchen ihre Kindertagespflege online. Ich erstelle Ihre eigene, schlichte Website: Konzept, Zeiten, freie Plätze, Kontakt, Impressum- und Datenschutzseite mit Ihren Angaben. Handy-tauglich, ohne Cookies und Tracking, eine Änderungsrunde inklusive, Sie zahlen nach Abnahme. Keine monatliche Gebühr an mich. Beispielseite auf Anfrage. Kleinunternehmer gem. § 19 UStG.

## C. Anfrage an einen Tagespflegeverein / eine Fachberatung (vorher um Erlaubnis fragen)
Guten Tag, ich biete Kindertagespflegepersonen eine einfache eigene Website zum Festpreis von ${price} an. Darf ich das Angebot in Ihrem Newsletter, an Ihrem Aushang oder bei einem Treffen kurz vorstellen? Wenn nicht, ist das völlig in Ordnung. Mit freundlichen Grüßen, [Name, Anschrift, Kontakt]

Nicht erlaubt und nicht vorgesehen: Werbe-E-Mails, -Anrufe oder -Nachrichten an Fremde ohne deren Einwilligung (§ 7 UWG), gekaufte Adresslisten, massenhafte Nachrichten in Gruppen.
`,
  };
}

const ACQUISITION_PLAN = `# Plan: the first real paying customer (internal, for the owner)

Niche: self-employed childminders (Kindertagespflegepersonen) in Germany.
Why this niche (evidence, 2026-11-03 research):
- 37,400 childminders in 2025, down 5.9% for the fifth year in a row (Destatis via bildungsserver.de); births are falling too,
  so a childminder now has to be found by parents, not just listed by the Jugendamt.
- The product they need is exactly a one-pager: concept, times, free places, contact. No shop, booking or CMS.
- Small budgets: a fixed low price with no monthly fee fits better than agency quotes (German freelancers quote ~€500–1,500 for a one-pager per vendor guides).
Unproven: whether childminders will pay €290. Desk research found no price data for this niche. Only conversations prove demand.

Validation before building anything more (target: 2 weeks):
1. Ask 5–10 childminders reached through the channels below two questions: "Do you have a website? Would a €290 one-page site with no monthly fee be worth it?"
2. Decision rule: 3+ say yes at €290 → keep the price; nobody objects to the price → raise to €390 for the next one; most say "too expensive" → test €190 or switch niche (alternatives: solo tradespeople, dog trainers, tutors).

Permitted channels, in order:
1. Personal network (people the owner knows, and their referrals). Fastest; no consent problem.
2. One Kleinanzeigen service listing (draft B). Inbound only: answer people who ask.
3. Local Tagespflege association or Fachberatung, only after asking permission (draft C): newsletter, notice board, a meeting.
4. A flyer on public notice boards where posting is allowed (family centres, supermarkets).
Not used: cold e-mail, cold calls, messages to strangers, scraped lists, group spam (§7 UWG / ePrivacy).

First sale, step by step (who does what):
- Owner: registers the business (see COMPLIANCE-CHECKLIST.md), records the authorization in Pandesh. [human, once]
- Owner: sends draft A to ~10 people they know; posts listing B. [human, ~45 min]
- Owner: 15-minute call with an interested childminder; agrees the price. [human]
- Pandesh: records the lead and the accepted order, the brief from the questionnaire. [automatic once told]
- Pandesh: builds the site + legal pages, runs QC, writes the handover. [automatic, seconds]
- Owner: reviews the page, sends it, optionally uploads it with the customer. [human, ~30 min]
- Pandesh: writes the §19 invoice. Owner sends it. [automatic + human]
- Owner: sees the payment arrive, verifies it in Pandesh with the bank reference. [human]

Money needed: the €200 limit. One sale at €290 covers it only if registration cost and the income-tax reserve are small;
with a ~€50 Gewerbeanmeldung and a 25% reserve it is (290 − 50) × 0.75 = €180, so plan for TWO sales.
`;

const COMPLIANCE_CHECKLIST = `# Before the first real customer (internal; not legal or tax advice — confirm with the Finanzamt or a Steuerberater)

Researched 2026-11-03; sources are guides and IHK pages, not statute text.

1. Registration
   - Web design is not a listed liberal profession (§18 EStG); creative design leans freelance, technical/programming work is often treated as a trade. The Finanzamt decides.
   - Trade: Gewerbeanmeldung at the Gewerbeamt (~€20–65, often online); it notifies the Finanzamt.
   - Either way: Fragebogen zur steuerlichen Erfassung via ELSTER (free), within about 4 weeks of starting. You get a Steuernummer.
   - Employed? Check your employment contract for side-work notification rules.
2. VAT: Kleinunternehmerregelung (§19 UStG) — since 2025: prior-year turnover ≤ €25,000 and current year ≤ €100,000. Choose it in the Fragebogen.
3. Invoices under §19: name and address of you and the customer, date, description of the service, amount, and the note that no VAT is charged under §19 UStG (§34a UStDV). Pandesh adds a sequential number and the service date.
   - E-invoicing: since 2025 you must be able to RECEIVE e-invoices; small businesses are exempt from ISSUING them, so a PDF/paper invoice is fine.
4. Income tax: profit is taxable income (EÜR with the yearly return). Set a reserve percentage in the authorization.
5. Your own Impressum (§5 DDG, replaced §5 TMG in May 2024) on any page or listing where you offer the service commercially: name, postal address, fast contact (e-mail/phone).
6. Customer sites: each needs the customer's own Impressum and privacy policy. Pandesh only inserts what the customer supplies and blocks delivery without them. No legal texts are written by Pandesh (Rechtsdienstleistungsgesetz).
7. Data you receive from customers: keep it to what the order needs; delete what you no longer need.
8. Marketing: no ads by e-mail/phone/messages to people who did not consent (§7 UWG). Use the channels in ACQUISITION-PLAN.md.

When done, record in Pandesh: legal name, address, e-mail, Steuernummer, §19 status, what you registered and when, the tax reserve, payment details for invoices, and which actions are allowed (publish, contact, contract, payments).
`;

/** Builds the website offering as files in Pandesh's own data folder. Nothing is published. */
export function developWebsiteOffering(dataDir: string, goal: WishGoal, unitPriceCents: number, unitsNeeded: number): Record<string, unknown> {
  const folder = path.join(wishFolder(dataDir, goal.id), 'offering-one-page-websites');
  fs.mkdirSync(folder, { recursive: true });
  const price = formatMoney(unitPriceCents, goal.currency).replace(/^€(.+)$/, '$1 €').replace('.', ',');
  const texts = offerTexts(price);
  for (const [name, text] of Object.entries(texts)) fs.writeFileSync(path.join(folder, name), text, 'utf8');
  fs.writeFileSync(path.join(folder, 'ACQUISITION-PLAN.md'), ACQUISITION_PLAN, 'utf8');
  fs.writeFileSync(path.join(folder, 'COMPLIANCE-CHECKLIST.md'), COMPLIANCE_CHECKLIST, 'utf8');
  for (const stale of ['OFFER.md', 'intake-questions.md']) fs.rmSync(path.join(folder, stale), { force: true });
  const sampleDir = path.join(folder, 'sample');
  fs.rmSync(sampleDir, { recursive: true, force: true });
  const sampleFiles = writeSite(sampleDir, SAMPLE_BRIEF);
  const qc = qualityCheckSite(sampleDir, 'demo');
  return {
    version: WEBSITE_OFFERING.version,
    niche: WEBSITE_OFFERING.niche,
    folder,
    files: [...Object.keys(texts), 'ACQUISITION-PLAN.md', 'COMPLIANCE-CHECKLIST.md', ...sampleFiles.map((f) => `sample/${f}`)],
    unitPriceCents,
    unitsNeeded,
    validation: qc.passed
      ? 'Sample site passed every quality check (structure, mobile, no external requests, legal pages linked).'
      : `Sample site FAILED quality checks: ${qc.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`,
    sampleStructurallySound: qc.passed,
    published: false,
    developedAt: new Date().toISOString(),
  };
}

/** Builds one page from a brief outside any order (a quick preview). Records no money. */
export function buildWebsiteDeliverable(dataDir: string, goalId: string, brief: SiteBrief): { file: string; structurallySound: boolean; findings: string[] } {
  if (!brief.businessName?.trim()) throw new Error('the brief needs a business name');
  const slug = brief.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'order';
  const folder = path.join(wishFolder(dataDir, goalId), 'offering-one-page-websites');
  const relative = `previews/${slug}`;
  writeSite(path.join(folder, ...relative.split('/')), { ...brief, sample: false });
  const check = validateStaticHtml(folder, `${relative}/index.html`);
  return { file: path.join(folder, ...relative.split('/'), 'index.html'), structurallySound: check.structurallySound, findings: check.findings };
}
