/**
 * The deliverable ledger (M1, reliability program): what the request asked to exist, checked against what exists.
 *
 * The defect this closes (audit S21): a turn that asked for six files and produced four plus an index that linked to
 * the missing ones was recorded `verified`, because the verdict counted which KINDS of tool succeeded ("1 action
 * completed"), not whether the requested results exist. This module decides, from the request and the file system and
 * never from the model's sentence, which deliverables are still missing.
 *
 * Three sources of expected deliverables, all deterministic and conservative (a false "missing" is as harmful as a
 * false "done", so each source only fires on an unambiguous signal):
 *   1. files the request names as OUTPUT ("create invoices-summary.md", "save the result to out/report.csv");
 *   2. one output per input ("write an analysis for each file in inbox"): as many new files as the folder holds;
 *   3. link closure: a Markdown/HTML file written in this turn that links to a local file that does not exist.
 * Present means: exists, non-empty, and written or changed during this turn (a stale file of the same name is not
 * a deliverable).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const EXT = 'md|markdown|txt|csv|tsv|json|jsonl|xlsx?|docx?|pptx?|pdf|html?|xml|ya?ml|toml|ini|log|js|mjs|cjs|ts|tsx|jsx|py|ps1|bat|sh|sql|css|png|jpe?g|gif|webp|svg|zip';
const FILE_TOKEN = new RegExp(`(?<![\\w/\\\\:.-])((?:[\\w.-]+[\\\\/])*[\\w][\\w.-]*\\.(?:${EXT}))(?![\\w/-])`, 'gi');
const OUTPUT_VERB = /\b(create|creates|created|write|writes|save|saves|produce|produces|generate|generates|make|makes|export|exports|output|store|put|build|draft|compose)\b/i;
const INPUT_CUTOFF = /\b(?:from|using|based on|by reading|reading|out of|given|taken from|in the file)\b/i;

export interface LedgerInput {
  requestText: string;
  workspace: string;
  /** Absolute paths of files this turn wrote successfully (from the tool ledger). */
  writtenFiles: readonly string[];
  /** Epoch ms when the turn started; a deliverable must have been written or changed at or after it. */
  turnStartMs: number;
}
export interface LedgerResult {
  /** Human-readable list of what was expected. */
  expected: string[];
  /** What is not on disk (or empty, or stale). */
  missing: string[];
  /** What is verified present. */
  present: string[];
}

/** Output files the request names. Exported for tests. */
export function namedOutputFiles(requestText: string): string[] {
  const found: string[] = [];
  for (const sentence of requestText.split(/(?<=[.!?])\s+|\n+/)) {
    const verb = OUTPUT_VERB.exec(sentence);
    if (!verb) continue;
    let tail = sentence.slice(verb.index + verb[0].length);
    const cut = INPUT_CUTOFF.exec(tail);
    if (cut) tail = tail.slice(0, cut.index);
    for (const m of tail.matchAll(FILE_TOKEN)) {
      const token = m[1].replace(/\\/g, '/');
      if (/[<>*{}]/.test(token) || /^https?:/i.test(token)) continue;
      // "a summary of report.pdf into summary.md": the nearest connector before a token says whether it is read or made.
      const before = tail.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      const lastOf = (re: RegExp) => { let at = -1; for (const x of before.matchAll(re)) at = x.index ?? -1; return at; };
      if (lastOf(/\b(?:of|about|from|using|reading|based on|given)\b/gi) > lastOf(/\b(?:into|to|as|named|called|in|at)\b/gi)) continue;
      if (!found.includes(token)) found.push(token);
    }
  }
  return found.slice(0, 12);
}

/** "one analysis for each file in inbox": how many outputs, and the folder that decides it. Exported for tests. */
export function perInputRequirement(requestText: string, workspace: string): { folder: string; count: number } | null {
  const m = /\b(?:for|of|per)\s+(?:each|every)\s+(?:of\s+the\s+)?(?:\w+\s+){0,3}?(?:files?|documents?|pages?|sources?)\s+(?:in|inside|of|from)\s+(?:the\s+)?[`"']?([\w./\\-]+?)[`"']?(?:\s+(?:folder|directory))?(?=[\s,.;:!?)]|$)/i.exec(requestText)
    ?? /\b(?:each|every)\s+(?:of\s+the\s+)?(?:\w+\s+){0,3}?(?:files?|documents?)\s+in\s+(?:the\s+)?[`"']?([\w./\\-]+?)[`"']?(?:\s+(?:folder|directory))?(?=[\s,.;:!?)]|$)/i.exec(requestText);
  if (!m) return null;
  if (!OUTPUT_VERB.test(requestText)) return null;
  const folder = path.resolve(workspace, m[1]);
  if (!isInside(folder, workspace)) return null;
  try {
    const count = fs.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile()).length;
    return count > 0 ? { folder: m[1], count } : null;
  } catch { return null; }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function freshAndNonEmpty(file: string, turnStartMs: number): boolean {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0 && st.mtimeMs >= turnStartMs - 2000;
  } catch { return false; }
}

/** Relative local link targets inside a Markdown/HTML file ("[x](a.md)", "href=\"a.html\""), minus anchors and URLs. */
export function localLinkTargets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\(([^)\s]+?)(?:\s+"[^"]*")?\)|href=["']([^"']+)["']/gi)) {
    const raw = (m[1] ?? m[2] ?? '').split('#')[0].split('?')[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('mailto:')) continue;
    out.add(decodeURIComponent(raw));
  }
  return [...out];
}

export function deliverableLedger(input: LedgerInput): LedgerResult {
  const { workspace, turnStartMs } = input;
  const expected: string[] = []; const missing: string[] = []; const present: string[] = [];
  const mark = (label: string, ok: boolean) => { expected.push(label); (ok ? present : missing).push(label); };

  // 1. Output files the request names. A bare name may be satisfied anywhere in the workspace by a file written this
  //    turn (the model may choose the folder); a path must match exactly.
  const written = input.writtenFiles.map((f) => path.resolve(f));
  for (const token of namedOutputFiles(input.requestText)) {
    const exact = path.resolve(workspace, token);
    const bare = !token.includes('/');
    const ok = freshAndNonEmpty(exact, turnStartMs)
      || (bare && written.some((w) => path.basename(w).toLowerCase() === token.toLowerCase() && isInside(w, workspace) && freshAndNonEmpty(w, turnStartMs)));
    mark(token, ok);
  }

  // 2. One output per input file.
  const per = perInputRequirement(input.requestText, workspace);
  if (per) {
    const inputFolder = path.resolve(workspace, per.folder);
    const outputs = new Set(written.filter((w) => isInside(w, workspace) && !isInside(w, inputFolder) && freshAndNonEmpty(w, turnStartMs)));
    mark(`${per.count} output files, one for each file in ${per.folder}`, outputs.size >= per.count);
  }

  // 3. Link closure of what this turn wrote.
  for (const file of written) {
    if (!/\.(md|markdown|html?)$/i.test(file) || !isInside(file, workspace)) continue;
    let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const target of localLinkTargets(text)) {
      const resolved = path.resolve(path.dirname(file), target);
      if (!isInside(resolved, workspace)) continue;
      mark(`${path.relative(workspace, file).replace(/\\/g, '/')} links to ${target}`, fs.existsSync(resolved));
    }
  }
  return { expected, missing, present };
}

/**
 * Verification as a deliverable (audit S16): "git works" after its own `run_checks git --version` failed. When the turn's
 * own checks ended in failure and no later check succeeded, a reply that says the thing works / passes / is verified is
 * unbacked. Returns what is missing ("a successful check ... (the check failed: ...)"), or null.
 */
const CHECK_TOOLS = /^(?:run_checks|run_command)$/;
const WORKS_CLAIM = /\b(?:works?|working|functional|operational|verified|passes|passed|all (?:good|green|set)|correctly (?:installed|configured|set up|working))\b/i;
const NEGATION = /\b(?:not|n't|never|could ?not|unable|failed|fails|did not|didn't|no longer|unverified|cannot|can't)\b/i;
export function unbackedWorkingClaim(reply: string, calls: ReadonlyArray<{ tool: string; status: string; result?: unknown }>): string | null {
  const checks = calls.filter((c) => CHECK_TOOLS.test(c.tool) && c.status !== 'running');
  if (!checks.length) return null;
  const isErr = (c: { result?: unknown }) => Boolean((c.result as { isError?: boolean } | undefined)?.isError);
  if (!isErr(checks[checks.length - 1]) || checks.some((c, i) => !isErr(c) && i > checks.findIndex(isErr))) return null;
  const claim = reply.split(/(?<=[.!?\n])\s+/).find((s) => WORKS_CLAIM.test(s) && !NEGATION.test(s));
  if (!claim) return null;
  const last = checks[checks.length - 1];
  const text = ((last.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((p) => p.text ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `a successful check behind "${claim.trim().slice(0, 80)}" (the check failed: ${text || 'no output'})`;
}

/**
 * Dates the owner stated explicitly (ISO, "2026-12-01") for tasks must be the dates that were stored (audit S20: a due date
 * and a priority silently lost, reply "done"). Judged only on requests about tasks/deadlines; relative dates ("next
 * Friday") are resolved by the model and are not judged here.
 */
export function statedTaskDates(requestText: string): string[] {
  if (!/\b(?:task|todo|to-do|deadline|due|project)s?\b/i.test(requestText)) return [];
  return [...new Set([...requestText.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((m) => m[1]))].slice(0, 12);
}
export function missingTaskDates(requestText: string, calls: ReadonlyArray<{ tool: string; args?: unknown; status: string; result?: unknown }>): string[] {
  const dates = statedTaskDates(requestText);
  if (!dates.length) return [];
  const stored = calls
    .filter((c) => (c.tool === 'add_task' || c.tool === 'update_task') && c.status === 'completed' && !(c.result as { isError?: boolean } | undefined)?.isError)
    .map((c) => String((c.args as { dueAt?: string } | undefined)?.dueAt ?? ''));
  return dates.filter((d) => !stored.some((s) => s.startsWith(d))).map((d) => `a task due ${d} stored (the date you gave)`);
}
