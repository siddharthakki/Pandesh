/**
 * What counts as the owner's private skill content for the outbound-query boundary (publicQueryGuard.checkPublicQuery).
 *
 * Core enforces this on every outbound search path (web_research, governed_research, agent_reach), whatever the model
 * did or did not read this turn and whatever its instructions say: the owner's own skills, drafts and approved
 * repository skills are read from disk here, so a query that repeats their names or wording is refused before anything
 * leaves the machine. Built-in skills are public product text and are not included.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { approvedRepositories } from './skillCandidates';

export interface OwnerSkillText { texts: string[]; names: string[] }

const MAX_FILES = 60;
const MAX_CHARS = 20_000;
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; value: OwnerSkillText }>();

function skillFilesUnder(root: string, depth = 0, out: string[] = []): string[] {
  if (out.length >= MAX_FILES || depth > 3) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const p = path.join(root, e.name);
    if (e.isDirectory() && !/^(?:node_modules|\.git)$/i.test(e.name)) skillFilesUnder(p, depth + 1, out);
    else if (e.isFile() && /^SKILL\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}

function nameOf(text: string, file: string): string[] {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const names = [/^name\s*:\s*(.+)$/im.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, ''), path.basename(path.dirname(file))];
  return names.filter((n): n is string => !!n && n.length >= 6 && /[\p{L}]/u.test(n));
}

/** The owner's skill texts and names. Reads local files only; cached for a few seconds; never throws. */
export function ownerSkillPrivateTexts(dataDir: string | undefined): OwnerSkillText {
  if (!dataDir) return { texts: [], names: [] };
  const hit = cache.get(dataDir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const roots = [path.join(dataDir, 'skills'), path.join(dataDir, 'skill-proposals'), ...approvedRepositories(dataDir)];
  const texts: string[] = [];
  const names: string[] = [];
  for (const root of roots) {
    for (const file of skillFilesUnder(root)) {
      try {
        const text = fs.readFileSync(file, 'utf8').slice(0, MAX_CHARS);
        texts.push(text);
        names.push(...nameOf(text, file));
      } catch { /* unreadable: skip */ }
    }
  }
  const value = { texts, names: [...new Set(names)] };
  cache.set(dataDir, { at: Date.now(), value });
  return value;
}

export function resetOwnerSkillCache(): void { cache.clear(); }
