/**
 * Artifact / TaskResult contract (host-neutral, JARVIS-reusable) and safe preview models.
 *
 * "Completed" should point at something tangible. A TaskResult carries the status, a summary, the artifacts produced, the
 * evidence behind them, validations and the actions the person can take next. Two rules hold throughout:
 *
 *   1. Validation is NEVER fabricated: `validations` are derived only from recorded evidence (EvidenceLedger).
 *   2. Generated content is NEVER rendered with privilege: every preview model below is built from sanitised content and
 *      carries the sandbox/CSP it must be shown under. Scripts are blocked in static previews; running an application is
 *      a separate, governed action (`run-target`), not a property of previewing a file.
 */
import type { EvidenceEntry, EvidenceLedger } from '../evidenceLedger';

export type ArtifactType =
  | 'text' | 'markdown' | 'file' | 'html' | 'svg' | 'image' | 'pdf' | 'json' | 'table' | 'terminal-output' | 'python-output' | 'web-preview';

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  /** Workspace-relative path, or an absolute path for a file outside any workspace. */
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  hash?: string;
  /** Bounded inline content for text-like artifacts. Never present for binary artifacts. */
  content?: string;
  /** For `web-preview`: a local URL only. */
  url?: string;
  /** Evidence ids that substantiate this artifact (a write, a command run). */
  evidenceIds: string[];
  createdAt: string;
}

export interface ValidationRecord { id: string; kind: 'test' | 'build' | 'command'; summary: string; ok: boolean; exitCode?: number; evidenceId: string }

export type ResultActionKind = 'preview' | 'open-file' | 'open-output' | 'run-target' | 'apply-to-file' | 'save-as' | 'open-externally';
export interface ResultAction { id: string; kind: ResultActionKind; label: string; artifactId?: string; requiresApproval: boolean }

/** Who produced a result. Ids only; never content. */
export interface TaskResultOrigin { taskId?: string; attemptId?: string; model?: string; provider?: string }

/** Files the run really changed, as observed on disk / in the recorded mutation evidence (never from model prose). */
export interface TaskResultChanges { created: string[]; modified: string[]; deleted: string[] }

export interface TaskResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'blocked';
  summary: string;
  artifacts: Artifact[];
  /** Additive provenance. Optional so results persisted before these fields existed stay valid. */
  origin?: TaskResultOrigin;
  changes?: TaskResultChanges;
  /** Commands the run actually executed (validation / build / test), as recorded. */
  commands?: string[];
  /** Plain-language reasons the run is not a clean completion (missing output, failed validation, nothing changed). */
  warnings?: string[];
  evidence: Array<Pick<EvidenceEntry, 'id' | 'kind' | 'subject' | 'summary' | 'ok'>>;
  validations: ValidationRecord[];
  /** `none_recorded` is shown as such; it is not a failure and not a pass. */
  validationStatus: 'passed' | 'failed' | 'none_recorded';
  actions: ResultAction[];
}

// -------------------------------------------------------------------------------------------------------- classification

const EXT_TYPES: Array<[RegExp, ArtifactType, string]> = [
  [/\.html?$/i, 'html', 'text/html'], [/\.svg$/i, 'svg', 'image/svg+xml'],
  [/\.(png|jpe?g|gif|webp)$/i, 'image', 'image/*'], [/\.pdf$/i, 'pdf', 'application/pdf'],
  [/\.json$/i, 'json', 'application/json'], [/\.(csv|tsv)$/i, 'table', 'text/csv'],
  [/\.(md|markdown)$/i, 'markdown', 'text/markdown'], [/\.txt$/i, 'text', 'text/plain'],
];

export function classifyArtifactPath(path: string): { type: ArtifactType; mimeType?: string } {
  for (const [pattern, type, mimeType] of EXT_TYPES) if (pattern.test(path)) return { type, mimeType };
  return { type: 'file' };
}

let artifactCounter = 0;
export function artifactId(prefix = 'art'): string { return `${prefix}-${Date.now().toString(36)}-${(++artifactCounter).toString(36)}`; }

// -------------------------------------------------------------------------------------------------------- TaskResult

export interface BuildResultInput {
  status: TaskResult['status'];
  summary: string;
  ledger: EvidenceLedger;
  artifacts: Artifact[];
  /** Local preview target the host can launch through the governed execution path (never launched by building a result). */
  runTarget?: { label: string; url: string };
  now?: () => Date;
}

export function validationsFromLedger(ledger: EvidenceLedger): ValidationRecord[] {
  const out: ValidationRecord[] = [];
  for (const entry of ledger.all()) {
    if (entry.kind !== 'test_run' && entry.kind !== 'build_run' && entry.kind !== 'command_run') continue;
    if (entry.ok === undefined) continue; // an unfinished or unobserved run is not a validation
    out.push({ id: `val-${entry.id}`, kind: entry.kind === 'test_run' ? 'test' : entry.kind === 'build_run' ? 'build' : 'command', summary: entry.summary, ok: entry.ok === true && (entry.exitCode === undefined || entry.exitCode === 0), ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}), evidenceId: entry.id });
  }
  return out;
}

export interface OutcomeTruthInput {
  /** What the runtime reported. */
  claimed: TaskResult['status'];
  /** Workspace-relative paths the task was expected to produce (host-recorded scope, never parsed from model prose). */
  promisedPaths: readonly string[];
  /** Real filesystem check; the caller decides the root. */
  exists: (path: string) => boolean;
  validationStatus: TaskResult['validationStatus'];
  /** True when the host recorded at least one real mutation. */
  mutated: boolean;
}

/**
 * Success must match execution evidence: a runtime "completed" is downgraded to `partial` when a promised file does not
 * exist or recorded validation failed. Anything other than `completed` is returned unchanged, because a failure is never
 * upgraded by evidence.
 */
export function reconcileOutcome(input: OutcomeTruthInput): { status: TaskResult['status']; warnings: string[]; missing: string[] } {
  const warnings: string[] = [];
  const missing = input.promisedPaths.filter(path => !input.exists(path));
  if (input.claimed !== 'completed') return { status: input.claimed, warnings, missing };
  if (missing.length > 0) warnings.push(`Promised but not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`);
  if (input.validationStatus === 'failed') warnings.push('Validation failed.');
  if (!input.mutated && input.promisedPaths.length === 0) warnings.push('No file changes were made.');
  const downgrade = missing.length > 0 || input.validationStatus === 'failed';
  return { status: downgrade ? 'partial' : 'completed', warnings, missing };
}

/** The latest test/build verdict only counts if no file changed after it (see EvidenceLedger.verify). */
export function buildTaskResult(input: BuildResultInput): TaskResult {
  const validations = validationsFromLedger(input.ledger);
  const gates = validations.filter(v => v.kind === 'test' || v.kind === 'build');
  const stale = input.ledger.verify({ kind: 'tests_passed' });
  let validationStatus: TaskResult['validationStatus'] = 'none_recorded';
  if (gates.length > 0) validationStatus = gates.at(-1)!.ok && (stale.verified || !input.ledger.all().some(e => e.kind === 'test_run')) ? 'passed' : 'failed';
  const actions: ResultAction[] = [];
  for (const artifact of input.artifacts) {
    if (artifact.type === 'html' || artifact.type === 'svg' || artifact.type === 'image' || artifact.type === 'markdown' || artifact.type === 'json' || artifact.type === 'table') actions.push({ id: `act-preview-${artifact.id}`, kind: 'preview', label: `Preview ${artifact.title}`, artifactId: artifact.id, requiresApproval: false });
    if (artifact.path) actions.push({ id: `act-open-${artifact.id}`, kind: 'open-file', label: `Open ${artifact.title}`, artifactId: artifact.id, requiresApproval: false });
    if (artifact.type === 'pdf') actions.push({ id: `act-ext-${artifact.id}`, kind: 'open-externally', label: `Open ${artifact.title} externally`, artifactId: artifact.id, requiresApproval: false });
  }
  if (input.runTarget) actions.push({ id: 'act-run-target', kind: 'run-target', label: input.runTarget.label, requiresApproval: true });
  if (input.artifacts.some(a => a.type === 'terminal-output' || a.type === 'python-output')) actions.push({ id: 'act-output', kind: 'open-output', label: 'Show output', requiresApproval: false });
  return {
    status: input.status,
    summary: input.summary,
    artifacts: input.artifacts,
    evidence: input.ledger.all().map(e => ({ id: e.id, kind: e.kind, subject: e.subject, summary: e.summary, ...(e.ok !== undefined ? { ok: e.ok } : {}) })),
    validations,
    validationStatus,
    actions,
  };
}

// -------------------------------------------------------------------------------------------------------- safe previews

/** The restrictions a preview must be shown under. Hosts apply these as an iframe `sandbox` attribute and a CSP. */
export const STATIC_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";
export const STATIC_PREVIEW_SANDBOX = '';

const BLOCKED_ELEMENTS = /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|base|link|meta|form|portal|template)\b[^>]*>/gi;
const EVENT_HANDLERS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /(\s(?:href|src|xlink:href|action|formaction|srcset|data)\s*=\s*)(["']?)\s*(?:javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi;

/**
 * Static HTML for preview: no scripts, no event handlers, no frames/forms/base, no `javascript:` URLs, remote loads blocked
 * by the CSP. `<script>` bodies are removed with their tags so they cannot leak as text.
 */
export function sanitizeHtmlForPreview(html: string): { html: string; removed: string[] } {
  const removed: string[] = [];
  let out = html.slice(0, 2_000_000);
  out = out.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, () => { removed.push('script'); return ''; });
  out = out.replace(/<\s*(style)\b[\s\S]*?<\s*\/\s*style\s*>/gi, match => match.replace(/@import[^;]+;?/gi, '').replace(/expression\s*\(/gi, '(').replace(/url\(\s*(['"]?)\s*(?!data:)[^)]*\)/gi, 'url()'));
  out = out.replace(BLOCKED_ELEMENTS, match => { removed.push(/<\s*\/?\s*(\w+)/.exec(match)![1].toLowerCase()); return ''; });
  out = out.replace(EVENT_HANDLERS, () => { removed.push('event-handler'); return ''; });
  out = out.replace(JS_URLS, (_m, attr: string) => { removed.push('javascript-url'); return `${attr}"#"`; });
  // Remote images/media cannot load under the CSP; make that visible instead of leaving a broken request.
  out = out.replace(/(\s(?:src|poster)\s*=\s*)(["'])\s*(?:https?:)?\/\/[^"']*\2/gi, (_m, attr: string) => { removed.push('remote-resource'); return `${attr}"" data-blocked="remote"`; });
  return { html: out, removed: [...new Set(removed)] };
}

export interface HtmlPreviewModel { mode: 'sandboxed-html'; srcdoc: string; sandbox: string; csp: string; removed: string[] }

export function buildHtmlPreview(html: string): HtmlPreviewModel {
  const { html: clean, removed } = sanitizeHtmlForPreview(html);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STATIC_PREVIEW_CSP}">`;
  const srcdoc = /<head[^>]*>/i.test(clean) ? clean.replace(/<head[^>]*>/i, match => `${match}${meta}`) : `<!doctype html><html><head>${meta}</head><body>${clean}</body></html>`;
  return { mode: 'sandboxed-html', srcdoc, sandbox: STATIC_PREVIEW_SANDBOX, csp: STATIC_PREVIEW_CSP, removed };
}

/** SVG shown through an `<img>` data URL (which cannot run script) after removing scripts, handlers, foreign content and remote refs. */
export function sanitizeSvg(svg: string): { svg: string; removed: string[] } {
  const removed: string[] = [];
  let out = svg.slice(0, 1_000_000);
  out = out.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, () => { removed.push('script'); return ''; });
  out = out.replace(/<\s*(foreignObject|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, (_m, tag: string) => { removed.push(tag.toLowerCase()); return ''; });
  out = out.replace(/<\s*(foreignObject|iframe|object|embed)\b[^>]*\/>/gi, (_m, tag: string) => { removed.push(tag.toLowerCase()); return ''; });
  out = out.replace(EVENT_HANDLERS, () => { removed.push('event-handler'); return ''; });
  out = out.replace(/(\s(?:xlink:href|href)\s*=\s*)(["'])\s*(?!#|data:image\/)[^"']*\2/gi, (_m, attr: string) => { removed.push('external-reference'); return `${attr}"#"`; });
  return { svg: out, removed: [...new Set(removed)] };
}

export interface ImagePreviewModel { mode: 'image'; dataUrl: string; removed: string[] }
export function buildSvgPreview(svg: string): ImagePreviewModel {
  const { svg: clean, removed } = sanitizeSvg(svg);
  return { mode: 'image', dataUrl: `data:image/svg+xml;base64,${Buffer.from(clean, 'utf8').toString('base64')}`, removed };
}

export interface JsonNode { key: string; type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'; value?: string; size?: number; children?: JsonNode[]; truncated?: boolean }
export interface JsonPreviewModel { mode: 'json-tree'; root: JsonNode; error?: string }

export function buildJsonTree(text: string, limits = { depth: 6, children: 200, string: 200 }): JsonPreviewModel {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { return { mode: 'json-tree', root: { key: '', type: 'null' }, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
  const walk = (key: string, value: unknown, depth: number): JsonNode => {
    if (value === null) return { key, type: 'null', value: 'null' };
    if (Array.isArray(value)) {
      const node: JsonNode = { key, type: 'array', size: value.length };
      if (depth < limits.depth) { node.children = value.slice(0, limits.children).map((v, i) => walk(String(i), v, depth + 1)); node.truncated = value.length > limits.children; } else node.truncated = value.length > 0;
      return node;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const node: JsonNode = { key, type: 'object', size: entries.length };
      if (depth < limits.depth) { node.children = entries.slice(0, limits.children).map(([k, v]) => walk(k, v, depth + 1)); node.truncated = entries.length > limits.children; } else node.truncated = entries.length > 0;
      return node;
    }
    if (typeof value === 'string') return { key, type: 'string', value: value.length > limits.string ? `${value.slice(0, limits.string)}…` : value };
    return { key, type: typeof value === 'number' ? 'number' : 'boolean', value: String(value) };
  };
  return { mode: 'json-tree', root: walk('', parsed, 0) };
}

export interface TablePreviewModel { mode: 'table'; columns: string[]; rows: string[][]; totalRows: number; truncated: boolean }

/** RFC-4180-style CSV/TSV parsing, bounded. */
export function buildTable(text: string, options: { maxRows?: number; maxCols?: number } = {}): TablePreviewModel {
  const maxRows = options.maxRows ?? 500;
  const maxCols = options.maxCols ?? 60;
  const delimiter = (text.split('\n', 1)[0].match(/\t/g)?.length ?? 0) > (text.split('\n', 1)[0].match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let total = 0;
  const pushRow = (): void => { row.push(cell); cell = ''; total++; if (rows.length <= maxRows) rows.push(row.slice(0, maxCols)); row = []; };
  for (let i = 0; i < text.length && total <= maxRows + 1_000_000; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { if (cell.endsWith('\r')) cell = cell.slice(0, -1); pushRow(); }
    else cell += ch;
    if (total > maxRows + 1) break;
  }
  if (cell || row.length) pushRow();
  const [header = [], ...body] = rows;
  return { mode: 'table', columns: header, rows: body.slice(0, maxRows), totalRows: Math.max(0, total - 1), truncated: total - 1 > maxRows };
}

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHref = (href: string): string => (/^(https?:|mailto:|#)/i.test(href.trim()) ? escapeHtml(href.trim()) : '#');

export interface MarkdownPreviewModel { mode: 'markdown'; html: string }

/** A deliberately small, escaping-first Markdown renderer: headings, lists, fences, inline code, bold/italic, safe links. */
export function buildMarkdownPreview(markdown: string): MarkdownPreviewModel {
  const inline = (text: string): string => escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => `<a href="${safeHref(href.replace(/&amp;/g, '&'))}" rel="noopener noreferrer">${label}</a>`);
  const lines = markdown.slice(0, 500_000).split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let list: 'ul' | 'ol' | undefined;
  const closeList = (): void => { if (list) { out.push(`</${list}>`); list = undefined; } };
  for (const line of lines) {
    if (/^```/.test(line)) { closeList(); out.push(inFence ? '</code></pre>' : '<pre><code>'); inFence = !inFence; continue; }
    if (inFence) { out.push(escapeHtml(line)); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) { closeList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
    } else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  if (inFence) out.push('</code></pre>');
  return { mode: 'markdown', html: out.join('\n') };
}

export interface OutputPreviewModel { mode: 'terminal'; stdout: string; stderr: string; exitCode?: number; truncated: boolean; files: string[] }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function buildOutputPreview(out: { stdout?: string; stderr?: string; exitCode?: number; files?: string[] }, maxChars = 60_000): OutputPreviewModel {
  const clip = (value: string): { text: string; cut: boolean } => { const clean = value.replace(ANSI, ''); return clean.length > maxChars ? { text: `${clean.slice(0, maxChars)}\n… [output truncated]`, cut: true } : { text: clean, cut: false }; };
  const stdout = clip(out.stdout ?? '');
  const stderr = clip(out.stderr ?? '');
  return { mode: 'terminal', stdout: stdout.text, stderr: stderr.text, ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}), truncated: stdout.cut || stderr.cut, files: (out.files ?? []).slice(0, 50) };
}

export interface WebPreviewModel { mode: 'web'; url: string; requiresGovernedLaunch: true }

/** Local-only URLs; an application is started by the governed run path, never by building a preview model. */
export function buildWebPreview(url: string): WebPreviewModel | { mode: 'refused'; reason: string } {
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1';
    if (!local || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return { mode: 'refused', reason: 'Only local http(s) addresses can be previewed.' };
    return { mode: 'web', url: parsed.toString(), requiresGovernedLaunch: true };
  } catch { return { mode: 'refused', reason: 'Not a valid URL.' }; }
}

export type PreviewModel = HtmlPreviewModel | ImagePreviewModel | JsonPreviewModel | TablePreviewModel | MarkdownPreviewModel | OutputPreviewModel | WebPreviewModel
  | { mode: 'text'; text: string; truncated: boolean }
  | { mode: 'file'; path?: string; sizeBytes?: number }
  | { mode: 'refused'; reason: string };

/** One entry point: the safe model for an artifact. `content` is bounded text for text-like artifacts. */
export function previewFor(artifact: Artifact, extra: { imageBase64?: string; output?: Parameters<typeof buildOutputPreview>[0] } = {}): PreviewModel {
  const content = artifact.content ?? '';
  switch (artifact.type) {
    case 'html': return buildHtmlPreview(content);
    case 'svg': return buildSvgPreview(content);
    case 'image': return extra.imageBase64 && extra.imageBase64.length < 7_000_000 && /^image\/(png|jpeg|gif|webp)/.test(artifact.mimeType ?? 'image/png')
      ? { mode: 'image', dataUrl: `data:${artifact.mimeType ?? 'image/png'};base64,${extra.imageBase64}`, removed: [] }
      : { mode: 'file', path: artifact.path, sizeBytes: artifact.sizeBytes };
    case 'json': return buildJsonTree(content);
    case 'table': return buildTable(content);
    case 'markdown': return buildMarkdownPreview(content);
    case 'terminal-output':
    case 'python-output': return buildOutputPreview(extra.output ?? { stdout: content });
    case 'web-preview': return artifact.url ? buildWebPreview(artifact.url) : { mode: 'refused', reason: 'No URL recorded.' };
    case 'text': return { mode: 'text', text: content.slice(0, 200_000), truncated: content.length > 200_000 };
    default: return { mode: 'file', path: artifact.path, sizeBytes: artifact.sizeBytes };
  }
}
