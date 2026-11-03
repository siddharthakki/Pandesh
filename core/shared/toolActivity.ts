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

export type ToolActivityKind = 'browser' | 'code' | 'document' | 'image' | 'video' | 'tool';

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
}

/** Artifact source of a browser page screenshot: a preview of work, not a delivered result. */
export const BROWSER_SCREENSHOT_SOURCE = 'browser_screenshot';

export const TOOL_ACTIVITY_KINDS: readonly ToolActivityKind[] = ['browser', 'code', 'document', 'image', 'video', 'tool'];

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
  return activity;
}
