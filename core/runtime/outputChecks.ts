/**
 * Core's own check of a file the assistant just wrote (real-world challenge, items 2–3).
 *
 *  - Syntax: the file must parse. Python is parsed with `ast` (nothing is executed), JavaScript with `node --check`,
 *    JSON with JSON.parse, HTML for basic structure. A corrupt file is reported back to the model immediately.
 *  - Grounding: every decimal number or version string a report/page/text shows must appear in something this turn
 *    actually read or computed (tool results, the request, a hand-off brief). T13 wrote "Tuxedo 4.0 → 5.0.1" into a
 *    dashboard although no tool ever returned it; R16 wrote a total no tool computed.
 *
 * Pure apart from the parse subprocesses, which only read the file.
 */
import * as path from 'node:path';

/** Runs a parser synchronously; injected by the engine (process spawning stays in allowlisted modules). */
export type SyncRunner = (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: unknown };

export interface OutputCheck {
  /** Human sentence for the tool result; empty when there is nothing to say. */
  summary: string;
  syntaxOk: boolean | null;
  syntaxProblem: string | null;
  ungrounded: string[];
  /** Packages a written Python file needs that do not import on this PC (gap 5). */
  importProblems?: string[];
}

const PY_PARSE = 'import ast,sys\nsrc=open(sys.argv[1],encoding="utf-8").read()\ntry:\n    ast.parse(src)\nexcept SyntaxError as e:\n    print(f"line {e.lineno}: {e.msg}"); sys.exit(1)';

function parseProblem(file: string, content: string, run?: SyncRunner): { ok: boolean | null; problem: string | null } {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === '.py' && run) {
      const r = run('python', ['-c', PY_PARSE, file]);
      if (r.error) return { ok: null, problem: null }; // no Python here: not checked
      return r.status === 0 ? { ok: true, problem: null } : { ok: false, problem: `Python syntax error ${String(r.stdout || r.stderr).trim().slice(0, 200)}` };
    }
    if ((ext === '.js' || ext === '.mjs' || ext === '.cjs') && run) {
      const r = run(process.execPath, ['--check', file]);
      return r.status === 0 ? { ok: true, problem: null } : { ok: false, problem: `JavaScript syntax error: ${String(r.stderr).split('\n').slice(0, 4).join(' ').slice(0, 240)}` };
    }
    if (ext === '.json') {
      try { JSON.parse(content); return { ok: true, problem: null }; } catch (err) { return { ok: false, problem: `invalid JSON: ${(err as Error).message.slice(0, 160)}` }; }
    }
    if (ext === '.html' || ext === '.htm') {
      const lower = content.toLowerCase();
      if (!/<(?:html|body|div|table|h1|main|section|p)\b/.test(lower)) return { ok: false, problem: 'the HTML has no page content (no html/body/div/table/heading elements)' };
      const opens = (lower.match(/<script\b/g) ?? []).length;
      const closes = (lower.match(/<\/script>/g) ?? []).length;
      if (opens !== closes) return { ok: false, problem: `the HTML has ${opens} <script> tags but ${closes} </script> closings` };
      if (lower.includes('<html') && !lower.includes('</html>')) return { ok: false, problem: 'the HTML is cut off (no </html>)' };
      return { ok: true, problem: null };
    }
  } catch { /* not checked */ }
  return { ok: null, problem: null };
}

/** The text a person sees in the file (HTML without tags, scripts and styles; other text as is). */
export function visibleText(file: string, content: string): string {
  if (!/\.html?$/i.test(file)) return content;
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
}

const DECIMAL_OR_VERSION = /(?<![\w.])v?\d{1,3}(?:,\d{3})*(?:\.\d+)+(?![\w.]*\d)/g;
const norm = (v: string): string[] => {
  const plain = v.replace(/,/g, '').replace(/^v/, '');
  const variants = new Set([plain]);
  if (/^\d+\.\d+$/.test(plain)) {
    variants.add(String(Number(plain)));          // 82.50 -> 82.5
    variants.add(Number(plain).toFixed(2));        // 20.5 -> 20.50
  }
  return [...variants];
};

/** Decimal values / versions in `text` that appear nowhere in `corpus` (in any common spelling). */
export function ungroundedValues(text: string, corpus: string): string[] {
  const hay = corpus.replace(/,(?=\d{3}\b)/g, '');
  // Plain numbers in the corpus, so a value shown rounded (21.2 from 21750 / 1024 = 21.2402…) counts as grounded.
  const corpusNumbers = [...hay.matchAll(/(?<![\d.])\d+(?:\.\d+)?(?![\d.]*\d)/g)].map((m) => Number(m[0])).filter(Number.isFinite);
  const roundsTo = (value: string) => {
    const plain = value.replace(/,/g, '').replace(/^v/, '');
    if (!/^\d+\.\d+$/.test(plain)) return false; // versions must match exactly
    const decimals = plain.split('.')[1].length;
    const target = Number(plain);
    return corpusNumbers.some((n) => Math.abs(Number(n.toFixed(decimals)) - target) < 1e-9);
  };
  const out = new Set<string>();
  for (const m of text.matchAll(DECIMAL_OR_VERSION)) {
    const value = m[0];
    if (norm(value).some((v) => new RegExp(`(?<![\\d.])${v.replace(/\./g, '\\.')}(?![\\d])`).test(hay))) continue;
    if (roundsTo(value)) continue;
    out.add(value);
  }
  return [...out].slice(0, 12);
}

const REPORT_LIKE = /\.(?:html?|md|txt|csv)$/i;

export function checkWrittenOutput(file: string, content: string, corpus: string, run?: SyncRunner): OutputCheck {
  const { ok, problem } = parseProblem(file, content, run);
  const ungrounded = REPORT_LIKE.test(file) && corpus.trim() ? ungroundedValues(visibleText(file, content), corpus) : [];
  const parts: string[] = [];
  if (ok === true) parts.push(`it parses (${path.extname(file).slice(1)})`);
  if (ok === false) parts.push(`PROBLEM — ${problem}. Fix it and write the file again`);
  if (ungrounded.length) parts.push(`these values are not in anything read or computed this turn, so they are unverified: ${ungrounded.join(', ')}. Replace them with values from a tool result (use calculate for totals), or remove them`);
  return { summary: parts.length ? `Pandesh checked ${path.basename(file)}: ${parts.join('; ')}.` : '', syntaxOk: ok, syntaxProblem: problem, ungrounded };
}
