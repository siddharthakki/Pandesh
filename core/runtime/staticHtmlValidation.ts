/**
 * Lightweight STRUCTURAL validation for a standalone HTML page.
 *
 * Some workspaces have no mechanical validation gate at all (no package.json scripts, no tsconfig, no test runner):
 * an empty folder in which the model is asked to build `index.html`. Reporting "no validation was run" is truthful
 * but leaves a small gap: a page with a syntax error in its inline script, an unterminated `<script>`, or a
 * stylesheet reference that does not exist would be delivered without anyone having looked.
 *
 * This closes only that gap, with no new infrastructure (no browser, no HTML parser dependency): Node itself compiles
 * the inline scripts (`vm.Script` parses without running anything), and the rest is a handful of cheap checks.
 *
 * It is NOT semantic validation. A page that passes here may still not do what was asked. The summary says so, and
 * the confidence label stays `semantic_validation_unavailable`; callers must never present this as a test pass.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

export const STATIC_HTML_CONFIDENCE = 'semantic_validation_unavailable' as const;

export interface StaticHtmlCheckResult {
  path: string;
  /** True when no structural problem was found. Says nothing about behaviour. */
  structurallySound: boolean;
  findings: string[];
  /** What was actually examined, so the summary can't overclaim. */
  examined: string[];
}

const HTML_EXTENSION = /\.html?$/i;
/** Inline scripts of these types are JavaScript Node can syntax-check as a classic script. */
const CLASSIC_SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);
const MAX_BYTES = 2_000_000;

export function isStaticHtmlPath(relativePath: string): boolean {
  return HTML_EXTENSION.test(relativePath);
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** A reference worth checking on disk: relative, not a URL, not an anchor, not a data/blob URI. */
function localReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  const withoutQuery = trimmed.split(/[?#]/)[0];
  return withoutQuery || undefined;
}

export function validateStaticHtml(cwd: string, relativePath: string): StaticHtmlCheckResult {
  const result: StaticHtmlCheckResult = { path: relativePath, structurallySound: false, findings: [], examined: [] };
  const absolute = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    result.findings.push('the file is outside the workspace and was not examined');
    return result;
  }
  let source: string;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      result.findings.push('the path is not a file');
      return result;
    }
    if (stat.size === 0) {
      result.findings.push('the file is empty');
      return result;
    }
    if (stat.size > MAX_BYTES) {
      result.findings.push(`the file is larger than ${MAX_BYTES} bytes and was not examined`);
      return result;
    }
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    result.findings.push('the file does not exist');
    return result;
  }
  result.examined.push('file exists and is non-empty');

  // Document skeleton. Browsers repair a missing one, so a doctype is advisory-free here: only a page with no
  // recognisable document at all, or no body to show, is treated as a structural failure.
  if (!/<html[\s>]/i.test(source)) result.findings.push('no <html> element');
  if (!/<body[\s>]/i.test(source)) result.findings.push('no <body> element');
  result.examined.push('document structure');

  // Script/style elements must be closed or the rest of the page is swallowed.
  const opens = (name: string) => (source.match(new RegExp(`<${name}[\\s>]`, 'gi')) ?? []).length;
  const closes = (name: string) => (source.match(new RegExp(`</${name}\\s*>`, 'gi')) ?? []).length;
  for (const name of ['script', 'style']) {
    if (opens(name) !== closes(name)) result.findings.push(`unbalanced <${name}> tags (${opens(name)} opened, ${closes(name)} closed)`);
  }

  // Inline JavaScript: compiled, never executed.
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  let inlineChecked = 0;
  let moduleSkipped = 0;
  while ((match = scriptPattern.exec(source)) !== null) {
    const attrs = match[1];
    const body = match[2];
    if (attribute(attrs, 'src') !== undefined) continue;
    if (!body.trim()) continue;
    const type = (attribute(attrs, 'type') ?? '').trim().toLowerCase();
    if (type === 'module') { moduleSkipped += 1; continue; }
    if (!CLASSIC_SCRIPT_TYPES.has(type)) continue; // JSON data blocks, templates, etc.
    inlineChecked += 1;
    try {
      new vm.Script(body, { filename: `${relativePath}#inline-script-${inlineChecked}` });
    } catch (error) {
      result.findings.push(`inline script ${inlineChecked} has a syntax error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (inlineChecked > 0) result.examined.push(`syntax of ${inlineChecked} inline script${inlineChecked === 1 ? '' : 's'}`);
  if (moduleSkipped > 0) result.examined.push(`${moduleSkipped} module script${moduleSkipped === 1 ? '' : 's'} not syntax-checked`);

  // Local assets the page depends on must exist next to it.
  const baseDirectory = path.dirname(absolute);
  const assets = new Set<string>();
  for (const tag of source.match(/<script\b[^>]*>/gi) ?? []) {
    const ref = localReference(attribute(tag, 'src'));
    if (ref) assets.add(ref);
  }
  for (const tag of source.match(/<link\b[^>]*>/gi) ?? []) {
    if (/\brel\s*=\s*["']?(?:stylesheet|icon|modulepreload)/i.test(tag)) {
      const ref = localReference(attribute(tag, 'href'));
      if (ref) assets.add(ref);
    }
  }
  for (const ref of assets) {
    const target = ref.startsWith('/') ? path.join(cwd, ref) : path.join(baseDirectory, ref);
    if (!fs.existsSync(target)) result.findings.push(`referenced file is missing: ${ref}`);
  }
  if (assets.size > 0) result.examined.push(`${assets.size} local asset reference${assets.size === 1 ? '' : 's'}`);

  result.structurallySound = result.findings.length === 0;
  return result;
}

/**
 * The text the model and the user see. Always states what was and was not established: a clean structural check is
 * reported as exactly that, never as a passing test.
 */
export function summarizeStaticHtmlCheck(result: StaticHtmlCheckResult): string {
  const header = `Structural check of ${result.path} (${STATIC_HTML_CONFIDENCE}): ${result.structurallySound ? 'no structural problems found' : 'problems found'}.`;
  const examined = result.examined.length > 0 ? `Examined: ${result.examined.join('; ')}.` : '';
  const findings = result.findings.map(finding => `- ${finding}`).join('\n');
  const limit = 'This is not a behavioural test: no browser was run and the page\'s functionality is unverified.';
  return [header, examined, findings, limit].filter(Boolean).join('\n');
}
