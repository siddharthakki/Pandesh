/**
 * Which page the browser should read when a price question could not be answered by web research at all: the search
 * found pages, none could be fetched, and the listing gave no summary to answer from.
 *
 * The browser can read a page a plain fetch cannot. This module only chooses the page, and only from the links the
 * search itself returned; opening it goes through `browser_open_site`, which asks the user for each new site. Core
 * does not guess a site: a live check on 2026-11-17 showed geizhals.de answering Core's browser with a bot check, so
 * a made-up site search would ask for approval and then show nothing.
 *
 * Pure functions: no network, no model.
 */

export interface FoundLink { title: string; url: string }

/** Hosts whose pages are price comparisons: one of these among the search results is the best page to read. */
const PRICE_COMPARISON_HOST = /(?:^|\.)(?:geizhals\.(?:de|at|eu)|idealo\.[a-z.]+|billiger\.de|preisvergleich\.(?:de|heise\.de)|guenstiger\.de|pricespy\.[a-z.]+|pricerunner\.[a-z.]+|kelkoo\.[a-z.]+|skinflint\.co\.uk|tweakers\.net|heureka\.[a-z]+|ceneo\.pl)$/i;

/** The links `web_research` returned when it found pages but could read none (lines "- title: url"). */
export function linksFromToolError(text: string): FoundLink[] {
  return [...text.matchAll(/^- (.+?): (https?:\/\/\S+)$/gm)].slice(0, 6).map((m) => ({ title: m[1], url: m[2] }));
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export interface PricePage { url: string; site: string }

/** The one page to open: a price-comparison page the search found, else the first page it found, else nothing. */
export function pickPricePage(links: FoundLink[]): PricePage | null {
  const usable = links.filter((l) => hostOf(l.url) !== null);
  const pick = usable.find((l) => PRICE_COMPARISON_HOST.test(hostOf(l.url)!)) ?? usable[0];
  return pick ? { url: pick.url, site: hostOf(pick.url)! } : null;
}

/** True when the page the browser returned is a bot check or an access refusal rather than content. */
export function isBlockedPage(pageText: string): boolean {
  const body = pageText.slice(0, 3000);
  return /(?:verify (?:that )?you are (?:a )?human|checking your browser|just a moment\.\.\.|access denied|unusual traffic|are you a robot|captcha|sichere verbindung wird|sicherheitsüberprüfung|bitte bestätigen sie, dass sie kein roboter)/i.test(body);
}
