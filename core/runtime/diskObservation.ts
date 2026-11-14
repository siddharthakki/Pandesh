import * as path from 'node:path';
import { pathTokens } from './fsMention';

/**
 * Ties the evidence to the request: a question about one folder or file is observed only if a successful read was OF
 * THAT folder or file (its path ends in the named target), not of another. Listing the workspace root and then
 * reporting a count for rw/inbox is not an observation of rw/inbox, and neither is reading a file inside it or one of
 * its sub-folders. Deliberately small: it compares named targets with the path arguments of tool calls; it is not a
 * general verifier of answers. A request that names no folder or file ("how many files are in my downloads") is not
 * judged by this guard.
 *
 * Known limit: a name alone ("inbox") cannot tell /a/inbox from /b/inbox; a read of any folder with that name counts.
 */

const norm = (p: string): string => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase();
const STOP = /^(?:the|a|an|my|this|that|your|its|any|each|every|same|other|root|sub|parent|current|whole|entire)$/i;

/** Folder or file names the request points at: path tokens, "the X folder", "folder X", "im Ordner X", file names. */
export function namedDiskTargets(text: string): string[] {
  const t = String(text || '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' '); // URLs are not local paths
  const found = new Set<string>();
  const add = (s: string | undefined) => { const n = norm(String(s ?? '').replace(/^["'`]+|["'`?.,;:!]+$/g, '')); if (n && n.length > 1 && n !== '.') found.add(n); };
  for (const p of pathTokens(t)) add(p);
  for (const m of t.matchAll(/\b([\w.-]+)\s+(?:folder|directory|dir)\b/gi)) if (!STOP.test(m[1])) add(m[1]);
  for (const m of t.matchAll(/\b(?:folder|directory|dir)\s+(?:called\s+|named\s+)?(?!(?:and|or|that|which|is|are|with|in|on|of|for)\b)([\w.-]+)/gi)) if (!STOP.test(m[1])) add(m[1]);
  for (const m of t.matchAll(/\b(?:ordner|verzeichnis\w*)\s+([\w.-]+)/gi)) add(m[1]);
  for (const m of t.matchAll(/\b[\w-]+\.(?:txt|csv|tsv|json|md|pdf|docx?|xlsx?|pptx?|log|ts|tsx|js|mjs|py|html?|zip|eml|msg|png|jpe?g|yaml|yml|xml|ini)\b/gi)) add(m[0]);
  const all = [...found];
  // A name that is only the tail of a longer named path ("inbox" in "rw/inbox", "b.txt" in "a/b.txt") adds nothing.
  return all.filter((x) => !all.some((o) => o !== x && o.endsWith(`/${x}`)));
}

const PATH_KEYS = /^(?:path|paths|dir|dirpath|directory|cwd|root|file|files|filepath|filename|folder|target|source|src)$/i;

/** String values of path-like arguments only (never file content, search patterns or commands). */
function pathArgs(args: unknown): string[] {
  const out: string[] = [];
  if (!args || typeof args !== 'object') return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!PATH_KEYS.test(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
  }
  return out;
}

/** True when a read call was of the target: the path equals it or ends in it. */
export function readCoversTarget(args: unknown, target: string): boolean {
  return pathArgs(args).some((a) => {
    const p = norm(a);
    return p === target || p.endsWith(`/${target}`);
  });
}

/** Whether the successful reads of this turn cover every folder or file the request names. */
export function observationCoversRequest(requestText: string, reads: ReadonlyArray<{ args?: unknown }>): { covered: boolean; missing: string[] } {
  const targets = namedDiskTargets(requestText);
  if (targets.length === 0) return { covered: reads.length > 0, missing: [] };
  const missing = targets.filter((tg) => !reads.some((r) => readCoversTarget(r.args, tg)));
  return { covered: missing.length === 0, missing };
}
