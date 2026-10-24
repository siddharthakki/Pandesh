/**
 * A small, deterministic CSS cascade evaluator for responsive tests.
 *
 * jsdom does not evaluate `@media (max-width)` rules and no real browser is available to unit tests, so this resolves the
 * stylesheet for a given viewport width: it flattens the `@media` blocks that apply, matches selectors with jsdom, and picks
 * the winning declaration by importance, specificity and source order. It is intentionally conservative: rules it cannot
 * evaluate (hover/focus state, pseudo-elements, selectors jsdom rejects) are ignored, so a violation it reports is real.
 */
export interface CssRule { selector: string; decls: Map<string, { value: string; important: boolean }>; order: number; specificity: number }

export interface Viewport { width: number; height?: number }

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return text.length - 1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of text) {
    if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === separator && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

export function mediaMatches(condition: string, viewport: Viewport): boolean {
  const height = viewport.height ?? 800;
  const c = condition.toLowerCase();
  if (/prefers-|hover|pointer|forced-colors|print|orientation:\s*landscape/.test(c) && !/^\s*screen\s*$/.test(c)) return false;
  for (const part of c.split(/\band\b/)) {
    const p = part.trim();
    if (!p || p === 'screen' || p === 'all') continue;
    const m = /^\(\s*(max|min)-(width|height)\s*:\s*([\d.]+)(px|em|rem)\s*\)$/.exec(p);
    if (!m) return true; // unknown condition: assume it applies (conservative for hiding detection)
    const value = Number(m[3]) * (m[4] === 'px' ? 1 : 16);
    const actual = m[2] === 'width' ? viewport.width : height;
    if (m[1] === 'max' && !(actual <= value)) return false;
    if (m[1] === 'min' && !(actual >= value)) return false;
  }
  return true;
}

/** Approximate specificity as a single comparable number (ids, then classes/attrs/pseudo-classes, then types). */
export function specificity(selector: string): number {
  const s = selector.replace(/\([^)]*\)/g, match => (/^\(\s*[.#\[:\w]/.test(match) ? match : '')).replace(/::?[\w-]+(?=\()/g, '');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+|[>+~*]/g, ' ').match(/(?:^|\s)[a-zA-Z][\w-]*/g) ?? []).length;
  return ids * 10_000 + classes * 100 + types;
}

export function parseDeclarations(body: string): Map<string, { value: string; important: boolean }> {
  const decls = new Map<string, { value: string; important: boolean }>();
  for (const raw of splitTopLevel(body, ';')) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const prop = raw.slice(0, colon).trim().toLowerCase();
    let value = raw.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, '').trim();
    if (prop) decls.set(prop, { value, important });
  }
  return decls;
}

export function resolveRules(css: string, viewport: Viewport): CssRule[] {
  const rules: CssRule[] = [];
  let order = 0;
  const walk = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      const close = matchBrace(text, open);
      const body = text.slice(open + 1, close);
      i = close + 1;
      if (!prelude) continue;
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)![1].toLowerCase();
        if (name === 'media') { if (mediaMatches(prelude.replace(/^@media\s*/i, ''), viewport)) walk(body); }
        else if (name === 'supports' || name === 'layer' || name === 'container') walk(body);
        continue; // keyframes, font-face, property, etc.
      }
      const decls = parseDeclarations(body);
      for (const selector of splitTopLevel(prelude, ',')) {
        const sel = selector.trim();
        if (sel) rules.push({ selector: sel, decls, order: order++, specificity: specificity(sel) });
      }
    }
  };
  walk(stripComments(css).replace(/@import[^;]+;/g, ''));
  return rules;
}

const SKIP_SELECTOR = /::|:(hover|focus|focus-within|focus-visible|active|visited|disabled|checked|first-child|last-child|nth-child|nth-of-type|empty)\b/;

export interface Cascade {
  /** Winning declared value of `prop` for `el` ('' when nothing declares it). */
  value(el: Element, prop: string): string;
  /** The selector of the rule whose declaration of `prop` wins for `el` (for failure messages). */
  explain(el: Element, prop: string): string;
  /** Every winning declaration for `prop` along `el` and its ancestors, nearest first. */
  chain(el: Element, prop: string): Array<{ el: Element; value: string }>;
}

export function cascadeFor(css: string, viewport: Viewport): Cascade {
  const rules = resolveRules(css, viewport).filter(rule => !SKIP_SELECTOR.test(rule.selector) && rule.decls.size > 0);
  const cache = new WeakMap<Element, Map<string, string>>();
  const winners = new Map<string, string>();
  let counter = 0;
  const value = (el: Element, prop: string): string => {
    let perEl = cache.get(el);
    if (!perEl) { perEl = new Map(); cache.set(el, perEl); }
    const hit = perEl.get(prop);
    if (hit !== undefined) return hit;
    let best: { value: string; important: boolean; spec: number; order: number; selector: string } | undefined;
    for (const rule of rules) {
      const decl = rule.decls.get(prop);
      if (!decl) continue;
      let matches = false;
      try { matches = el.matches(rule.selector); } catch { matches = false; }
      if (!matches) continue;
      const candidate = { value: decl.value, important: decl.important, spec: rule.specificity, order: rule.order, selector: rule.selector };
      if (!best
        || (candidate.important && !best.important)
        || (candidate.important === best.important && (candidate.spec > best.spec || (candidate.spec === best.spec && candidate.order > best.order)))) best = candidate;
    }
    const result = best?.value ?? '';
    perEl.set(prop, result);
    if (best) winners.set(`${prop}|${(el as unknown as { __cid?: number }).__cid ?? (((el as unknown as { __cid?: number }).__cid = ++counter))}`, best.selector);
    return result;
  };
  const explain = (el: Element, prop: string): string => { value(el, prop); return winners.get(`${prop}|${(el as unknown as { __cid?: number }).__cid}`) ?? ''; };
  const chain = (el: Element, prop: string) => {
    const out: Array<{ el: Element; value: string }> = [];
    for (let node: Element | null = el; node; node = node.parentElement) out.push({ el: node, value: value(node, prop) });
    return out;
  };
  return { value, chain, explain };
}

export const px = (value: string): number | undefined => {
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  return m ? Number(m[1]) : undefined;
};
