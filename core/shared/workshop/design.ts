/**
 * The Design workshop's document: one self-contained HTML page (inline CSS, optional inline script, data: images).
 *
 * The page is untrusted content. It is never opened in a Pandesh window with Pandesh's privileges: the window shows
 * it in a sandboxed frame served from its own `pandesh-preview:` origin with a policy that allows no network, no
 * forms, no navigation and no access to the window (apps/desktop/src/host/designPreview.ts). Here: size limits, the
 * edits a model or a person can make, and a line diff for comparing versions. Pure TypeScript.
 */

export const MAX_DESIGN_BYTES = 300 * 1024;

export interface DesignCheck { ok: boolean; errors: string[]; warnings: string[] }

/** What a page needs to be shown, and what will not work in the offline preview (said up front, not discovered). */
export function checkDesignHtml(html: unknown): DesignCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof html !== 'string' || !html.trim()) return { ok: false, errors: ['the page is empty'], warnings };
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_DESIGN_BYTES) errors.push(`the page is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_DESIGN_BYTES / 1024} KB`);
  if (!/<(?:html|body|main|section|div|h1|h2|p|header|button)\b/i.test(html)) errors.push('this does not look like an HTML page (no html, body or content elements)');
  const external = [...html.matchAll(/(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)].map((m) => m[1]).filter((u) => !/^https?:\/\/(?:#|$)/.test(u));
  if (/@import\s+url\(\s*["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html)) warnings.push('the CSS loads something from another address; the preview is offline, so it will not appear');
  const loads = external.filter((u) => /\.(?:css|js|png|jpe?g|gif|svg|webp|woff2?|ttf)(?:[?#]|$)/i.test(u) || /fonts\.googleapis|cdn/i.test(u));
  if (loads.length) warnings.push(`${loads.length} resource(s) come from other addresses (${loads.slice(0, 2).join(', ')}${loads.length > 2 ? ', …' : ''}); the preview is offline, so they will not load`);
  if (/<form\b/i.test(html)) warnings.push('forms do not submit in the preview (it cannot send anything)');
  return { ok: errors.length === 0, errors, warnings };
}

export interface DesignChange { find: string; replace: string }

/**
 * Applies exact find/replace edits (each `find` must occur exactly once, so an edit can never land in the wrong
 * place) or replaces the whole page. Returns what changed in plain words.
 */
export function applyDesignEdits(html: string, change: { replacements?: unknown; html?: unknown }): { ok: true; html: string; summary: string } | { ok: false; errors: string[] } {
  if (typeof change.html === 'string' && change.html.trim()) {
    const check = checkDesignHtml(change.html);
    if (!check.ok) return { ok: false, errors: check.errors };
    if (change.html === html) return { ok: false, errors: ['the new page is identical to the current one'] };
    return { ok: true, html: change.html, summary: 'the whole page was rewritten' };
  }
  if (!Array.isArray(change.replacements) || change.replacements.length === 0) return { ok: false, errors: ['give replacements: [{ find, replace }] or a whole new html'] };
  if (change.replacements.length > 30) return { ok: false, errors: ['at most 30 replacements at once'] };
  let next = html;
  const done: string[] = [];
  for (const [i, raw] of change.replacements.entries()) {
    const r = raw as Partial<DesignChange>;
    if (typeof r?.find !== 'string' || !r.find || typeof r.replace !== 'string') return { ok: false, errors: [`replacement ${i + 1} needs find and replace text`] };
    const count = next.split(r.find).length - 1;
    if (count === 0) return { ok: false, errors: [`replacement ${i + 1}: "${r.find.slice(0, 60)}" is not in the page; quote the current text exactly (workshop_status shows it)`] };
    if (count > 1) return { ok: false, errors: [`replacement ${i + 1}: "${r.find.slice(0, 60)}" appears ${count} times; include more of the surrounding text so it is unique`] };
    next = next.replace(r.find, () => r.replace!);
    done.push(`"${r.find.slice(0, 40)}" → "${r.replace.slice(0, 40)}"`);
  }
  const check = checkDesignHtml(next);
  if (!check.ok) return { ok: false, errors: check.errors };
  if (next === html) return { ok: false, errors: ['the replacements changed nothing'] };
  return { ok: true, html: next, summary: done.join('; ') };
}

export interface DiffLine { kind: ' ' | '+' | '-'; text: string; oldLine?: number; newLine?: number }

/** A line diff (longest common subsequence), trimmed to the changed regions with a little context. */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return [{ kind: '-', text: `(${a.length} lines)` }, { kind: '+', text: `(${b.length} lines; too large to compare line by line)` }];
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const all: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { all.push({ kind: ' ', text: a[i], oldLine: i + 1, newLine: j + 1 }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { all.push({ kind: '-', text: a[i], oldLine: i + 1 }); i += 1; }
    else { all.push({ kind: '+', text: b[j], newLine: j + 1 }); j += 1; }
  }
  while (i < a.length) { all.push({ kind: '-', text: a[i], oldLine: i + 1 }); i += 1; }
  while (j < b.length) { all.push({ kind: '+', text: b[j], newLine: j + 1 }); j += 1; }
  const keep = new Set<number>();
  all.forEach((l, k) => { if (l.kind !== ' ') for (let d = -context; d <= context; d += 1) keep.add(k + d); });
  return all.filter((_, k) => keep.has(k));
}

/** The page's title, or its first heading. */
export function designTitle(html: string): string {
  const t = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html)?.[1] ?? '';
  return t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled page';
}
