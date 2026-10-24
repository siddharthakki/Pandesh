import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Deterministic, exhaustive workspace file operations: count / list / find / open-in-browser for "all <extension> files".
 *
 * These are filesystem facts, not retrieval questions. Semantic retrieval returns the few most relevant files, so using it
 * for "all" silently under-counts (two of three HTML files). Everything here is a bounded directory walk under the workspace
 * root. No model, no shell, symlinks are never followed, and generated/hidden trees are skipped.
 */

export type FileOpKind = 'count' | 'list' | 'open_in_browser';

export interface FileOpPlan {
  kind: FileOpKind;
  /** Lower-case extensions without the dot, e.g. ['html', 'htm']. */
  extensions: string[];
  /** What the user called them: "HTML". */
  label: string;
}

const ALIASES: Record<string, { label: string; ext: string[] }> = {
  html: { label: 'HTML', ext: ['html', 'htm'] },
  htm: { label: 'HTML', ext: ['html', 'htm'] },
  css: { label: 'CSS', ext: ['css'] },
  js: { label: 'JavaScript', ext: ['js', 'mjs', 'cjs'] },
  javascript: { label: 'JavaScript', ext: ['js', 'mjs', 'cjs'] },
  ts: { label: 'TypeScript', ext: ['ts', 'tsx'] },
  typescript: { label: 'TypeScript', ext: ['ts', 'tsx'] },
  json: { label: 'JSON', ext: ['json'] },
  md: { label: 'Markdown', ext: ['md', 'markdown'] },
  markdown: { label: 'Markdown', ext: ['md', 'markdown'] },
  py: { label: 'Python', ext: ['py'] },
  python: { label: 'Python', ext: ['py'] },
  svg: { label: 'SVG', ext: ['svg'] },
  pdf: { label: 'PDF', ext: ['pdf'] },
  txt: { label: 'text', ext: ['txt'] },
  csv: { label: 'CSV', ext: ['csv'] },
  yaml: { label: 'YAML', ext: ['yaml', 'yml'] },
  yml: { label: 'YAML', ext: ['yaml', 'yml'] },
  png: { label: 'PNG', ext: ['png'] },
  jpg: { label: 'JPEG', ext: ['jpg', 'jpeg'] },
  jpeg: { label: 'JPEG', ext: ['jpg', 'jpeg'] },
};

/** Types a default browser renders itself. Anything else is listed, never "opened in the browser". */
const BROWSER_OPENABLE = new Set(['html', 'htm', 'svg', 'pdf']);

/** Opening dozens of tabs is not what "open all" means; above this the list is shown and the user narrows it. */
export const MAX_BROWSER_OPENS = 10;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'bin', 'obj', 'target', 'coverage', 'venv', 'env', '__pycache__', 'site-packages']);
const MAX_FILES_SCANNED = 200_000;
const WALK_BUDGET_MS = 8_000;

function extensionWord(text: string): { label: string; ext: string[] } | undefined {
  const dotted = /(?:^|\s)\.([a-z0-9]{1,5})\s+files?\b/i.exec(text);
  if (dotted) return ALIASES[dotted[1].toLowerCase()] ?? { label: `.${dotted[1].toLowerCase()}`, ext: [dotted[1].toLowerCase()] };
  for (const match of text.matchAll(/\b([a-z0-9]{2,10})\s+(?:files?|pages?|documents?)\b/gi)) {
    const found = ALIASES[match[1].toLowerCase()];
    if (found) return found;
  }
  return undefined;
}

// Per-project / per-folder / ranking questions belong to the project census, not to the workspace-wide file walk.
const PROJECT_SCOPED = /\b(?:each|every|per)\s+(?:project|package|module|folder|directory|repo)|\bby\s+(?:project|folder)|\bwhich\s+(?:project|folder)\b|\b(?:most|largest|biggest)\b/i;

/**
 * Recognises "how many / list / find / open all <ext> files". Pure and case-insensitive. Returns undefined for anything
 * else so ordinary questions keep their existing route.
 */
export function planWorkspaceFileOp(question: string): FileOpPlan | undefined {
  const q = String(question ?? '').trim();
  if (!q || q.length > 300 || PROJECT_SCOPED.test(q) || /https?:\/\//i.test(q)) return undefined;
  const found = extensionWord(q);
  if (!found) return undefined;
  // "open ... in browser": a command, not a question. "open all", "open every", "open the html files" all name a set.
  if (/^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:open|launch|view|show|preview)\b/i.test(q)
    && (/\b(?:in|with|on)\s+(?:the\s+|a\s+|my\s+)?(?:default\s+)?(?:web\s*)?browser\b|\bfor\s+(?:me\s+to\s+)?(?:view|viewing|preview)\b/i.test(q))
    && /\b(?:all|every|each|both|the)\b/i.test(q)) {
    return { kind: 'open_in_browser', extensions: found.ext, label: found.label };
  }
  if (/\b(?:how many|count|number of|total)\b/i.test(q)) return { kind: 'count', extensions: found.ext, label: found.label };
  if (/^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:list|show|find|give|get|display|enumerate|what|which|where)\b/i.test(q)
    && /\b(?:all|every|the|my|our|these|those|are there|exist)\b/i.test(q)) {
    return { kind: 'list', extensions: found.ext, label: found.label };
  }
  return undefined;
}

export interface WalkResult { files: string[]; truncated: boolean }

/**
 * Every file under `root` whose extension is in `extensions`, as sorted workspace-relative posix paths. Hidden directories
 * (".git", ".ollama-agent", ".tmp"…) and generated trees are skipped; symlinks are not followed.
 */
export async function findWorkspaceFiles(root: string, extensions: readonly string[]): Promise<WalkResult> {
  const wanted = new Set(extensions.map(ext => ext.toLowerCase()));
  const started = Date.now();
  const files: string[] = [];
  let scanned = 0;
  let truncated = false;
  let level: string[] = [''];
  while (level.length > 0 && !truncated) {
    const next: string[] = [];
    for (const dir of level) {
      if (scanned >= MAX_FILES_SCANNED || Date.now() - started > WALK_BUDGET_MS) { truncated = true; break; }
      let entries: import('fs').Dirent[];
      try { entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) next.push(rel);
        } else if (entry.isFile()) {
          scanned += 1;
          const dot = entry.name.lastIndexOf('.');
          if (dot > 0 && wanted.has(entry.name.slice(dot + 1).toLowerCase())) files.push(rel);
        }
      }
    }
    level = next;
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), truncated };
}

export function canOpenInBrowser(extensions: readonly string[]): boolean {
  return extensions.some(ext => BROWSER_OPENABLE.has(ext.toLowerCase()));
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const bullets = (files: readonly string[]): string => files.map(file => `- \`${file}\``).join('\n');

export function renderCount(plan: FileOpPlan, result: WalkResult): string {
  const { files, truncated } = result;
  if (files.length === 0) return `No ${plan.label} files were found in this workspace.${truncated ? ' The scan hit its safety limit, so this may be incomplete.' : ''}`;
  return `There ${files.length === 1 ? 'is' : 'are'} ${plural(files.length, `${plan.label} file`)} in this workspace:\n\n${bullets(files)}${truncated ? '\n\nThe scan hit its safety limit, so this may be a lower bound.' : ''}`;
}

export function renderList(plan: FileOpPlan, result: WalkResult): string {
  return renderCount(plan, result);
}

export interface OpenOutcome { path: string; ok: boolean; message?: string }

/** What the user is told after an open-all. Every enumerated path is accounted for as opened or failed. */
export function renderOpenReport(plan: FileOpPlan, found: WalkResult, outcomes: readonly OpenOutcome[]): string {
  const opened = outcomes.filter(outcome => outcome.ok);
  const failed = outcomes.filter(outcome => !outcome.ok);
  const lines: string[] = [];
  if (opened.length > 0) lines.push(`Opened ${plural(opened.length, `${plan.label} file`)} in your default browser.`);
  if (opened.length > 0) lines.push('', bullets(opened.map(outcome => outcome.path)));
  if (failed.length > 0) {
    lines.push('', `${plural(failed.length, 'file')} could not be opened:`);
    for (const outcome of failed) lines.push(`- \`${outcome.path}\`: ${outcome.message ?? 'the operating system did not launch it'}`);
  }
  if (found.truncated) lines.push('', 'The scan hit its safety limit, so there may be more files than listed.');
  return lines.join('\n').trim();
}

export function renderOpenRefusal(plan: FileOpPlan, found: WalkResult): string {
  if (!canOpenInBrowser(plan.extensions)) {
    return `${plan.label} files are not something a browser displays, so I did not open them.${found.files.length > 0 ? ` They are:\n\n${bullets(found.files)}` : ''}`;
  }
  if (found.files.length === 0) return `No ${plan.label} files were found in this workspace, so nothing was opened.`;
  return `There are ${found.files.length} ${plan.label} files, more than the ${MAX_BROWSER_OPENS} I open at once, so I opened none:\n\n${bullets(found.files)}\n\nName the ones you want opened.`;
}
