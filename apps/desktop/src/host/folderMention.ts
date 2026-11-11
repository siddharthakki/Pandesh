/**
 * Finds the one folder a chat message names by its full path, so Pandesh can ask before making it the workspace:
 * "check this folder D:\Projects\Site", "what is in 'C:\Users\me\My Notes'?".
 *
 * Windows folder names often contain spaces, so an unquoted path is matched against the disk: of the runs of words that
 * start at the drive letter, the longest one that is a real folder wins ("D:\My Projects\Site and tell me" names
 * D:\My Projects\Site). A path in quotes is taken as written. Network paths (\\server\share) are never probed. The disk
 * is asked one path at a time, and the caller bounds the whole search with a timeout, so a disconnected drive cannot
 * hold up the message for long.
 *
 * Returns null when the message names no existing folder, or names more than one different folder: Pandesh cannot
 * guess which one is meant, and the message is sent as it is.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FolderMention {
  /** The folder, resolved to its full path. */
  folder: string;
  /** How the message spelled it. */
  spelled: string;
}

type IsDirectory = (fullPath: string) => Promise<boolean>;

const QUOTED = /"([A-Za-z]:[\\/][^"\r\n]*)"|'([A-Za-z]:[\\/][^'\r\n]*)'|`([A-Za-z]:[\\/][^`\r\n]*)`|\u201C([A-Za-z]:[\\/][^\u201D\r\n]*)\u201D|\u2018([A-Za-z]:[\\/][^\u2019\r\n]*)\u2019/g;
/** A drive letter that starts a path, not one inside a word ("abc:\") or a web address (".../D:/x"). */
const DRIVE_START = /(^|[^A-Za-z0-9_/\\.:-])([A-Za-z]:[\\/])/g;
/** Punctuation that ends a sentence rather than a folder name. Tried both with and without it: "Program Files (x86)". */
const TRAILING = /[\s.,;:!?)\]}>'"`\u2019\u201D]+$/;
const MAX_PATH_STARTS = 6;
const MAX_WORDS = 24;
const MAX_PROBES = 120;

export async function defaultIsDirectory(fullPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

export async function findFolderMention(text: string, isDirectory: IsDirectory = defaultIsDirectory): Promise<FolderMention | null> {
  const source = String(text ?? '');
  if (!/[A-Za-z]:[\\/]/.test(source)) return null;
  const found = new Map<string, FolderMention>();
  const knownRoots = new Map<string, boolean>();
  let probes = 0;

  const isFolder = async (spelled: string): Promise<string | null> => {
    const s = spelled.trim();
    if (!s || s.length > 260 || probes >= MAX_PROBES) return null;
    let full: string;
    try { full = path.win32.resolve(s); } catch { return null; }
    probes += 1;
    return (await isDirectory(full)) ? full : null;
  };
  const record = (full: string, spelled: string) => {
    const key = full.replace(/[\\/]+$/, '').toLowerCase() || full.toLowerCase();
    if (!found.has(key)) found.set(key, { folder: full, spelled: spelled.trim() });
  };
  /** Whether the drive exists at all: one probe per drive letter, so a missing drive costs one check, not 24. */
  const driveExists = async (spelled: string): Promise<boolean> => {
    const root = `${spelled.slice(0, 2).toUpperCase()}\\`;
    if (!knownRoots.has(root)) knownRoots.set(root, Boolean(await isFolder(root)));
    return knownRoots.get(root)!;
  };

  const quotedSpans: Array<[number, number]> = [];
  for (const m of source.matchAll(QUOTED)) {
    const spelled = m.slice(1).find((g) => typeof g === 'string' && g.length > 0) ?? '';
    quotedSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    if (!(await driveExists(spelled))) continue;
    const full = (await isFolder(spelled)) ?? (await isFolder(spelled.replace(TRAILING, '')));
    if (full) record(full, spelled);
  }

  let starts = 0;
  for (const m of source.matchAll(DRIVE_START)) {
    const at = (m.index ?? 0) + m[1].length;
    if (quotedSpans.some(([a, b]) => at >= a && at < b)) continue;
    if (++starts > MAX_PATH_STARTS) break;
    const line = source.slice(at).split(/\r?\n/)[0];
    if (!(await driveExists(line))) continue;
    // Every run of words from the drive letter, longest first.
    const parts = line.split(/(\s+)/);
    const prefixes: string[] = [];
    let acc = '';
    for (const part of parts) {
      acc += part;
      if (part.trim()) prefixes.push(acc);
      if (prefixes.length >= MAX_WORDS) break;
    }
    for (const prefix of prefixes.reverse()) {
      const trimmed = prefix.replace(TRAILING, '');
      const full = (trimmed ? await isFolder(trimmed) : null) ?? (trimmed !== prefix ? await isFolder(prefix) : null);
      if (full) { record(full, trimmed || prefix); break; }
    }
  }

  return found.size === 1 ? [...found.values()][0] : null;
}

/** The search, given at most `ms` milliseconds; slower means "no folder" and the message goes as it is. */
export function findFolderMentionWithin(text: string, ms: number, isDirectory: IsDirectory = defaultIsDirectory): Promise<FolderMention | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    findFolderMention(text, isDirectory).then(
      (found) => { clearTimeout(timer); resolve(found); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}
