/**
 * What a tool shows the user while it works: the one contract between a
 * capability and the desktop's contextual workspace.
 *
 * Any capability — built in or added later — publishes activity by returning
 * an `activity` value with its tool result. Core stores it with the tool
 * invocation evidence and relays it on the invocation's runtime event; the
 * workspace renders it by `kind` alone, so a new capability never needs a
 * change to the sidebar.
 *
 * Everything here is display data, bounded and sanitized on both sides of the
 * wire. It never carries credentials, cookies, absolute host paths or bytes:
 * previews are referenced by Core artifact id.
 */

export type ToolActivityKind = 'browser' | 'code' | 'document' | 'image' | 'video' | 'workshop' | 'tool';

export interface ToolActivity {
  kind: ToolActivityKind;
  /** Short human title: a page title, file name or prompt. */
  title?: string;
  /** The public http(s) page this activity is about. */
  url?: string;
  /** A workspace-relative file path. */
  path?: string;
  /** Core artifacts holding the visible result (screenshot, image, video). */
  artifactIds?: string[];
  /** Readable text from the page or document. Untrusted; render as text. */
  excerpt?: string;
  /** A unified diff of the change, when the tool changed a file. */
  diff?: string;
  /** For a command: what ran, how it ended and how long it took (as measured by the runner). */
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /** Test counts parsed from the command's own summary line; absent when the output has none. */
  tests?: TestSummary;
  /** A Workshop version or view command (core/shared/workshop/model.ts): which workshop, and what happened to it. */
  workshop?: { workshopId: string; type: string; action: string; version?: number };
}

export interface TestSummary { passed?: number; failed?: number; skipped?: number; total?: number; line: string }

const num = (re: RegExp, s: string): number | undefined => { const m = re.exec(s); const v = m ? Number(m.slice(1).find((x) => x !== undefined)) : NaN; return Number.isFinite(v) ? v : undefined; };

/**
 * The test summary a runner printed (vitest/jest/pytest/mocha/dotnet style). Only counts that literally appear
 * in the output are returned; nothing is inferred.
 */
export function parseTestSummary(output: string): TestSummary | undefined {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isCandidate = (l: string) => /\b\d+\s+(?:passed|passing|failed|failing)\b/i.test(l) || /\b(?:Passed|Failed):\s*\d+/.test(l);
  const candidates = lines.filter(isCandidate);
  // TAP-style summary (node --test prints "ℹ pass 1" or "# pass 1"; tap prints "# pass 1"): one count per line.
  if (!candidates.length) {
    const tap = (k: string) => { const l = [...lines].reverse().find((x) => new RegExp(`^[#\\u2139]\\s*${k}\\s+\\d+$`).test(x)); return l ? Number(l.replace(/\D+/g, '')) : undefined; };
    const passed = tap('pass'); const failed = tap('fail');
    if (passed === undefined && failed === undefined) return undefined;
    const s: TestSummary = { line: lines.filter((x) => /^[#ℹ]\s*(?:tests|pass|fail|skipped)\s+\d+$/.test(x)).join(' · ').slice(0, 200) };
    const total = tap('tests'); const skipped = tap('skipped');
    if (passed !== undefined) s.passed = passed;
    if (failed !== undefined) s.failed = failed;
    if (skipped !== undefined) s.skipped = skipped;
    if (total !== undefined) s.total = total;
    return s;
  }
  const line = [...candidates].reverse().find((l) => /^Tests?[:\s]/.test(l)) ?? candidates[candidates.length - 1];
  const s: TestSummary = { line: line.slice(0, 200) };
  const passed = num(/\b(\d+)\s+(?:passed|passing)\b|\bPassed:\s*(\d+)/i, line);
  const failed = num(/\b(\d+)\s+(?:failed|failing)\b|\bFailed:\s*(\d+)/i, line);
  const skipped = num(/\b(\d+)\s+(?:skipped|pending)\b|\bSkipped:\s*(\d+)/i, line);
  const total = num(/\b(\d+)\s+total\b|\((\d+)\)\s*$|\bTotal:\s*(\d+)/i, line);
  if (passed !== undefined) s.passed = passed;
  if (failed !== undefined) s.failed = failed;
  if (skipped !== undefined) s.skipped = skipped;
  if (total !== undefined) s.total = total;
  return s;
}

/** Artifact source of a browser page screenshot: a preview of work, not a delivered result. */
export const BROWSER_SCREENSHOT_SOURCE = 'browser_screenshot';

export const TOOL_ACTIVITY_KINDS: readonly ToolActivityKind[] = ['browser', 'code', 'document', 'image', 'video', 'workshop', 'tool'];

const MAX_TITLE = 160;
const MAX_URL = 600;
const MAX_PATH = 300;
const MAX_EXCERPT = 1_200;
const MAX_DIFF = 2_400;
const MAX_ARTIFACTS = 4;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters (other than newline and tab) never reach a renderer.
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Only a credential-free public-looking http(s) URL survives. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** A relative path inside the workspace; absolute or escaping paths are dropped. */
function relativePath(value: unknown): string | undefined {
  const raw = text(value, MAX_PATH);
  if (!raw) return undefined;
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) return undefined;
  return normalized;
}

/** Bounds and sanitizes an activity; returns undefined when nothing usable is left. */
export function sanitizeToolActivity(raw: unknown): ToolActivity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = TOOL_ACTIVITY_KINDS.includes(record.kind as ToolActivityKind) ? record.kind as ToolActivityKind : undefined;
  if (!kind) return undefined;
  const artifactIds = Array.isArray(record.artifactIds)
    ? record.artifactIds.filter((id): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)).slice(0, MAX_ARTIFACTS)
    : [];
  const activity: ToolActivity = { kind };
  const title = text(record.title, MAX_TITLE);
  const url = webUrl(record.url);
  const filePath = relativePath(record.path);
  const excerpt = text(record.excerpt, MAX_EXCERPT);
  const diff = text(record.diff, MAX_DIFF);
  if (title) activity.title = title;
  if (url) activity.url = url;
  if (filePath) activity.path = filePath;
  if (artifactIds.length) activity.artifactIds = artifactIds;
  if (excerpt) activity.excerpt = excerpt;
  if (diff) activity.diff = diff;
  const command = text(record.command, 300);
  if (command) activity.command = command;
  if (record.exitCode === null || (typeof record.exitCode === 'number' && Number.isInteger(record.exitCode))) activity.exitCode = record.exitCode as number | null;
  if (typeof record.timedOut === 'boolean') activity.timedOut = record.timedOut;
  if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0) activity.durationMs = Math.round(record.durationMs);
  const w = record.workshop as Record<string, unknown> | undefined;
  if (w && typeof w === 'object' && typeof w.workshopId === 'string' && /^[\w-]{1,100}$/.test(w.workshopId) && typeof w.type === 'string' && /^[a-z0-9]{1,20}$/.test(w.type)) {
    activity.workshop = {
      workshopId: w.workshopId,
      type: w.type,
      action: text(w.action, 40) ?? 'update',
      ...(typeof w.version === 'number' && Number.isInteger(w.version) && w.version > 0 ? { version: w.version } : {}),
    };
  }
  const t = record.tests as Record<string, unknown> | undefined;
  if (t && typeof t === 'object' && typeof t.line === 'string') {
    const tests: TestSummary = { line: text(t.line, 200) ?? '' };
    for (const k of ['passed', 'failed', 'skipped', 'total'] as const) if (typeof t[k] === 'number' && Number.isInteger(t[k]) && (t[k] as number) >= 0) tests[k] = t[k] as number;
    activity.tests = tests;
  }
  return activity;
}
