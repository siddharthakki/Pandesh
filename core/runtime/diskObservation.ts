/**
 * Ties the evidence to the request: a question about one folder or file is observed only if a successful read touched
 * THAT folder or file, not any other. (Listing the workspace root and then reporting a count for rw/inbox is not an
 * observation of rw/inbox.) Deliberately small: it compares named targets with the paths of tool calls and is not a
 * general verifier of answers.
 */

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^["'`]+|["'`?.,;:!]+$/g, '').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();

/** Folder or file names the request points at: path tokens, "the X folder", "im Ordner X", file names. */
export function namedDiskTargets(text: string): string[] {
  const t = String(text || '');
  const found = new Set<string>();
  const add = (s: string | undefined) => { const n = norm(s ?? ''); if (n && n.length > 1) found.add(n); };
  for (const m of t.matchAll(/(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])?[\w.~-]+(?:[\\/][\w.~-]+)+[\\/]?/g)) add(m[0]); // rw/inbox, C:\a\b, events/
  for (const m of t.matchAll(/\b([\w.-]+)\s+(?:folder|directory|dir)\b/gi)) if (!/^(?:the|a|an|my|this|that|your|its|any|each|every|same|other|root)$/i.test(m[1])) add(m[1]);
  for (const m of t.matchAll(/\b(?:folder|directory|dir)\s+(?:called|named)\s+([\w.-]+)/gi)) add(m[1]);
  for (const m of t.matchAll(/\b(?:ordner|verzeichnis\w*)\s+([\w.-]+)/gi)) add(m[1]);
  for (const m of t.matchAll(/\b[\w-]+\.(?:txt|csv|tsv|json|md|pdf|docx?|xlsx?|pptx?|log|ts|tsx|js|mjs|py|html?|zip|eml|msg|png|jpe?g|yaml|yml|xml|ini)\b/gi)) add(m[0]);
  // A bare file name that sits inside a named path is covered by the path; drop single names that are just a path's tail.
  return [...found];
}

function stringArgs(args: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(args);
  return out;
}

/** True when a read call's arguments point at the target (equal, or the target is a trailing or inner part of the path). */
export function readCoversTarget(args: unknown, target: string): boolean {
  return stringArgs(args).some((a) => {
    const p = norm(a);
    return p === target || p.endsWith(`/${target}`) || p.includes(`/${target}/`) || p.startsWith(`${target}/`);
  });
}

/**
 * Whether the successful reads of this turn cover what the request names. With nothing named ("how many files are in
 * my workspace") any successful read counts, as before. With targets, every named target needs a covering read.
 */
export function observationCoversRequest(requestText: string, reads: ReadonlyArray<{ args?: unknown }>): { covered: boolean; missing: string[] } {
  const targets = namedDiskTargets(requestText);
  if (targets.length === 0) return { covered: reads.length > 0, missing: [] };
  const missing = targets.filter((tg) => !reads.some((r) => readCoversTarget(r.args, tg)));
  // A path token already names its tail ("rw/inbox" makes "inbox" redundant): a covered longer path covers its own last segment.
  const effective = missing.filter((m) => !targets.some((o) => o !== m && o.endsWith(`/${m}`) && !missing.includes(o)));
  return { covered: effective.length === 0 && reads.length > 0, missing: effective };
}
