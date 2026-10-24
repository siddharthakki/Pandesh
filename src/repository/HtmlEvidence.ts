import * as path from 'path';

/**
 * Deterministic, read-only evidence helpers for HTML documents, used by the Repo Fast Path.
 *
 * A single-file web app keeps its stylesheet first and its behaviour last, so a head-first excerpt shows the model only
 * CSS. These helpers give a large HTML file a bounded, line-numbered shape (outline of controls and functions, then the
 * script/function bodies the question is about) and resolve the local scripts/stylesheets it links to. No model, no
 * network, no execution: remote and data: references are listed, never fetched.
 */

export type FileKind = 'html' | 'css' | 'script' | 'json';

const KIND_EXTENSIONS: Record<FileKind, readonly string[]> = {
  html: ['.html', '.htm'],
  css: ['.css', '.scss', '.less'],
  script: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
  json: ['.json'],
};

const KIND_WORDS: ReadonlyArray<[FileKind, RegExp]> = [
  ['html', /\b(?:html|web ?page|webpage|markup)\b/i],
  ['css', /\b(?:css|style ?sheets?|stylesheets?)\b/i],
  ['script', /\b(?:javascript|js|typescript)\b|\b(?:the|this|that) scripts?\b/i],
  ['json', /\bjson\b/i],
];

/** "the html", "this stylesheet", "the javascript": a file KIND named without a filename. */
export function mentionedFileKinds(question: string): FileKind[] {
  const q = String(question ?? '');
  return KIND_WORDS.filter(([, pattern]) => pattern.test(q)).map(([kind]) => kind);
}

export function fileMatchesKind(file: string, kind: FileKind): boolean {
  return KIND_EXTENSIONS[kind].includes(path.posix.extname(file).toLowerCase());
}

/**
 * Resolves a file-kind reference to workspace files: the active editor when it is of that kind; otherwise the only (or
 * unambiguously shallowest) file of that kind; otherwise up to `limit` shallowest candidates, so several same-kind files
 * are all inspected instead of one being guessed. Nothing is returned when no file of the kind exists.
 */
export function resolveKindReference(question: string, files: readonly string[], activeFile?: string, limit = 3): string[] {
  const kinds = mentionedFileKinds(question);
  if (kinds.length === 0) return [];
  const candidates = (kind: FileKind) => files.filter(file => fileMatchesKind(file, kind) && !/(?:^|\/)(?:node_modules|dist|out|build|\.git)\//.test(file));
  for (const kind of kinds) {
    if (activeFile && fileMatchesKind(activeFile, kind) && files.includes(activeFile)) return [activeFile];
  }
  for (const kind of kinds) {
    const found = candidates(kind).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    if (found.length === 0) continue;
    if (found.length === 1 || found[0].split('/').length < found[1].split('/').length) return [found[0]];
    return found.filter(file => file.split('/').length === found[0].split('/').length).slice(0, limit);
  }
  return [];
}

export interface LinkedAssets { scripts: string[]; styles: string[]; remote: string[] }

/** Local `<script src>` / `<link rel=stylesheet href>` targets that exist in the workspace file list, plus remote ones (listed only). */
export function extractLinkedAssets(html: string, htmlRel: string, files: readonly string[]): LinkedAssets {
  const out: LinkedAssets = { scripts: [], styles: [], remote: [] };
  const known = new Set(files);
  const baseDir = path.posix.dirname(htmlRel);
  const add = (list: string[], ref: string) => {
    const cleaned = ref.split(/[?#]/)[0].trim();
    if (!cleaned) return;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleaned)) { if (/^(?:https?:)?\/\//i.test(cleaned) && !out.remote.includes(cleaned)) out.remote.push(cleaned); return; }
    const resolved = path.posix.normalize(cleaned.startsWith('/') ? cleaned.slice(1) : path.posix.join(baseDir, cleaned));
    if (resolved.startsWith('..') || !known.has(resolved) || list.includes(resolved)) return;
    list.push(resolved);
  };
  for (const match of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(out.scripts, match[1]);
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(match[0])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[0]);
    if (href) add(out.styles, href[1]);
  }
  return out;
}

const FUNCTION_PATTERNS = [
  /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*(?:\/\/.*)?$/, // object/class method shorthand
];
const METHOD_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'with']);

interface ScriptBlock { start: number; end: number }
interface FunctionSite { name: string; line: number }

function scriptBlocks(lines: readonly string[]): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let open = -1;
  lines.forEach((line, index) => {
    if (open < 0 && /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(line) && !/<script\b[^>]*>[^<]*<\/script>/i.test(line)) open = index;
    else if (open >= 0 && /<\/script>/i.test(line)) { blocks.push({ start: open, end: index }); open = -1; }
  });
  if (open >= 0) blocks.push({ start: open, end: lines.length - 1 });
  return blocks;
}

function functionSites(lines: readonly string[], blocks: readonly ScriptBlock[]): FunctionSite[] {
  const sites: FunctionSite[] = [];
  for (const block of blocks) {
    for (let i = block.start; i <= block.end; i++) {
      for (const pattern of FUNCTION_PATTERNS) {
        const m = pattern.exec(lines[i]);
        if (m && !METHOD_KEYWORDS.has(m[1])) { sites.push({ name: m[1], line: i + 1 }); break; }
      }
    }
  }
  return sites;
}

const GENERIC_TERMS = new Set(['check', 'identify', 'iddentify', 'functionality', 'functionalities', 'function', 'functions', 'feature', 'features', 'logic', 'html', 'file', 'code',
  'page', 'work', 'works', 'does', 'what', 'where', 'show', 'tell', 'find', 'list', 'describe', 'explain', 'explains', 'behaviour', 'behavior', 'happens', 'happen', 'inspect', 'review', 'look', 'app', 'application', 'main', 'sections', 'section']);

const clip = (line: string, n = 200) => (line.length > n ? `${line.slice(0, n)}…` : line);
const numbered = (lines: readonly string[], from: number, to: number) => lines.slice(from - 1, to).map((l, k) => `${from + k}| ${clip(l)}`).join('\n');

/**
 * Bounded, line-numbered excerpt of an HTML document that does not fit its budget:
 *   1. outline: <title>, headings, forms, controls with ids and inline handlers, script blocks, function index;
 *   2. the opening lines of the document (doctype, head, first markup);
 *   3. function bodies / lines whose name or text match the question's terms, in file order;
 *   4. the leading lines of the remaining script blocks (behaviour), never the whole stylesheet;
 * and an explicit statement of which line ranges were NOT included.
 */
export function buildHtmlExcerpt(raw: string, budget: number, terms: readonly string[], truncatedOnDisk = false): { text: string; includedLines: number } {
  const lines = raw.split(/\r?\n/);
  const blocks = scriptBlocks(lines);
  const sites = functionSites(lines, blocks);
  // Question words that say WHAT KIND of answer is wanted, not WHERE it lives, would match every function: dropped. The rest
  // match by stem ("validation" finds "valid", "submission" finds "submit") so naming the concept finds the code.
  const wanted = [...new Set(terms.map(t => t.toLowerCase()).filter(t => t.length >= 4 && !GENERIC_TERMS.has(t))
    .map(t => (t.length >= 8 ? t.slice(0, 5) : t.length >= 6 ? t.slice(0, 4) : t)))];

  const outline: string[] = [];
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim();
  if (title) outline.push(`title: ${title.slice(0, 120)}`);
  const controls: string[] = [];
  lines.forEach((line, index) => {
    if (controls.length >= 70) return;
    if (/<(?:h[1-3]|form|button|input|select|textarea|nav|section|dialog)\b/i.test(line) && !blocks.some(b => index >= b.start && index <= b.end)) {
      const handler = /\bon(?:click|submit|change|input|keydown|blur)\s*=\s*["']([^"']{1,80})/i.exec(line)?.[1];
      const id = /\bid\s*=\s*["']([^"']+)/i.exec(line)?.[1];
      const tag = /<([a-z0-9]+)/i.exec(line)?.[1]?.toLowerCase();
      controls.push(`${index + 1}| <${tag}${id ? ` id=${id}` : ''}>${handler ? ` on…=${handler}` : ''} ${clip(line.replace(/\s+/g, ' ').trim(), 90)}`);
    }
  });
  if (controls.length) outline.push(`markup controls (line| tag id handler):\n${controls.join('\n')}`);
  if (blocks.length) outline.push(`inline script blocks (line ranges): ${blocks.map(b => `${b.start + 1}-${b.end + 1}`).join(', ')}`);
  if (sites.length) outline.push(`functions (line| name), ${sites.length} total:\n${sites.slice(0, 120).map(s => `${s.line}| ${s.name}`).join(', ')}`);
  let outlineText = outline.join('\n');
  const outlineCap = Math.floor(budget * 0.34);
  if (outlineText.length > outlineCap) outlineText = `${outlineText.slice(0, outlineCap)}\n…[outline truncated]`;

  const included = new Array<boolean>(lines.length).fill(false);
  let used = outlineText.length;
  const take = (i: number) => {
    if (included[i]) return true;
    const cost = Math.min(lines[i].length, 200) + 8;
    if (used + cost > budget - 700) return false;
    included[i] = true;
    used += cost;
    return true;
  };
  // 2. opening of the document (small: the head is mostly style)
  for (let i = 0; i < Math.min(lines.length, 12) && used < budget * 0.4; i++) take(i);
  // 3. question-targeted functions (whole body up to a bound), then matching lines
  const functionEnd = (site: FunctionSite) => {
    const next = sites.find(s => s.line > site.line)?.line ?? Number.POSITIVE_INFINITY;
    const block = blocks.find(b => site.line - 1 >= b.start && site.line - 1 <= b.end);
    return Math.min(site.line + 59, next - 1, (block?.end ?? lines.length - 1));
  };
  // Best match first: a name hit outweighs a body hit, and a function matching several question terms outranks one matching a
  // single broad term, so the budget goes to the code the question is about, not to whatever comes first in the file.
  const score = (site: FunctionSite) => {
    const name = site.name.toLowerCase();
    const body = lines.slice(site.line - 1, Math.min(site.line + 25, lines.length)).join('\n').toLowerCase();
    return wanted.reduce((sum, t) => sum + (name.includes(t) ? 3 : body.includes(t) ? 1 : 0), 0);
  };
  const matchedSites = wanted.length
    ? sites.map(site => ({ site, score: score(site) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.site.line - b.site.line).map(item => item.site)
    : [];
  for (const site of matchedSites.slice(0, 12)) {
    for (let i = site.line - 1; i < functionEnd(site); i++) if (!take(i)) break;
  }
  for (let i = 0; i < lines.length && wanted.length; i++) {
    if (included[i] || !blocks.some(b => i >= b.start && i <= b.end)) continue;
    if (wanted.some(t => lines[i].toLowerCase().includes(t))) { for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 6); k++) take(k); }
  }
  // 4. the start of each remaining script block, so behaviour is represented even without a term match
  for (const block of blocks) {
    for (let i = block.start; i <= Math.min(block.end, block.start + (matchedSites.length ? 40 : 6)); i++) if (!take(i)) break;
  }
  // 5. no term pointed anywhere: the first line of every function across the script, so the whole behaviour is sampled
  if (matchedSites.length === 0) for (const site of sites) take(site.line - 1);

  const ranges: Array<[number, number]> = [];
  const omitted: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const flag = included[i];
    const start = i;
    while (i + 1 < lines.length && included[i + 1] === flag) i++;
    (flag ? ranges : omitted).push([start + 1, i + 1]);
  }
  const body = ranges.map(([a, b]) => numbered(lines, a, b)).join('\n…\n');
  const omittedText = omitted.length
    ? `NOT included: lines ${omitted.slice(0, 10).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')}${omitted.length > 10 ? ', …' : ''}`
    : 'every line was included';
  const text = [
    `[HTML structure — derived by the host from the whole file, not from the excerpt below]\n${outlineText}`,
    body,
    `[file has ${lines.length}${truncatedOnDisk ? '+' : ''} lines${truncatedOnDisk ? ' (only the first part of a larger file was read; everything after it is unseen)' : ''}; ${omittedText}. Do not claim to have verified text you were not given; name the sections you could not check.]`,
  ].join('\n\n');
  return { text, includedLines: included.filter(Boolean).length };
}
