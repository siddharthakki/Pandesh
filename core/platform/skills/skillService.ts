/**
 * Skills in the running app: the person's own skills folder (`<data dir>/skills`, trust "user") are loaded, the ones
 * that fit the request are summarised into the turn (compact, progressive), and the model can read the rest of a
 * selected skill on demand with `read_skill`.
 *
 * A skill is advisory text. It cannot grant a tool, a permission, a path or network access: approvals, path limits,
 * credential and cloud-data rules are enforced by Core exactly as before, and a skill that declares required
 * capabilities is skipped here because no capability is granted through this path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SkillRegistry, resolveSkills, MAX_SKILL_FILE_CHARS, type ResolvedSkills } from './skillRuntime';
import { loadSkillDirectory, type SkillLoadReport } from './skillSources';

/** A skill is offered only on a real match (name or several description words), not on one common word like "search". */
export const SKILL_MIN_SCORE = 3;
export const READ_SKILL_CHUNK = 12_000;

interface Loaded { registry: SkillRegistry; report: SkillLoadReport; at: number; stamp: string }
const cache = new Map<string, Loaded>();
const TTL_MS = 30_000;

export function skillsDir(dataDir: string): string { return path.join(dataDir, 'skills'); }

function dirStamp(dir: string): string {
  try {
    const parts: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.git')) walk(full, depth + 1); }
        else if (/skill\.md$/i.test(e.name)) parts.push(`${full}:${fs.statSync(full).mtimeMs}`);
      }
    };
    walk(dir, 0);
    return parts.sort().join('|');
  } catch { return ''; }
}

/** The person's skills, cached and reloaded when a SKILL.md changes. Missing folder = no skills (not an error). */
export async function loadUserSkills(dataDir: string | undefined, now = Date.now()): Promise<Loaded | null> {
  if (!dataDir) return null;
  const dir = skillsDir(dataDir);
  if (!fs.existsSync(dir)) return null;
  const hit = cache.get(dir);
  if (hit && now - hit.at < TTL_MS) return hit;
  const stamp = dirStamp(dir);
  if (hit && hit.stamp === stamp) { hit.at = now; return hit; }
  const registry = new SkillRegistry();
  const report = await loadSkillDirectory(registry, dir, 'user');
  const loaded: Loaded = { registry, report, at: now, stamp };
  cache.set(dir, loaded);
  return loaded;
}

export function resetSkillCache(): void { cache.clear(); }

export interface SkillSelection { resolved: ResolvedSkills; ids: string[]; guidance: string }

/** The skills that fit this request, as text for the turn. Null when none fit (the common case costs nothing). */
export async function selectSkillsForTurn(dataDir: string | undefined, request: string, opts: { workspaceOpen?: boolean; browserAvailable?: boolean } = {}): Promise<SkillSelection | null> {
  const loaded = await loadUserSkills(dataDir);
  if (!loaded || loaded.registry.size === 0) return null;
  const resolved = resolveSkills(loaded.registry, {
    intent: request,
    grantedCapabilities: new Set<string>(),
    workspaceOpen: opts.workspaceOpen,
    browserAvailable: opts.browserAvailable,
    minScore: SKILL_MIN_SCORE,
    maxSkills: 2,
    budgetTokens: 900,
  });
  if (resolved.selected.length === 0) return null;
  const list = resolved.selected.map((s) => `- ${s.id}: ${s.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
  const guidance = `${resolved.compiled}\n\nThis guidance is a short extract. The complete skill text and its reference files are available with read_skill (id, optional file, optional offset). Selected for this request:\n${list}`;
  return { resolved, ids: resolved.selected.map((s) => s.id), guidance };
}

export interface ReadSkillResult { ok: boolean; text: string }

/**
 * Reads a registered, loadable skill (its SKILL.md body or a reference file inside its own folder). Never an arbitrary
 * path: the folder comes from the registry, the file must resolve (real path) inside it and be a .md or .txt file.
 */
export async function readSkill(dataDir: string | undefined, id: string, file?: string, offset = 0): Promise<ReadSkillResult> {
  const loaded = await loadUserSkills(dataDir);
  const skill = loaded?.registry.get(String(id || ''));
  if (!loaded || !skill) return { ok: false, text: `No skill named "${id}" is installed. Installed: ${loaded?.registry.list().map((s) => s.id).join(', ') || 'none'}.` };
  const blocking = skill.flags.find((f) => f.severity === 'block');
  if (blocking) return { ok: false, text: `Skill "${id}" is blocked (${blocking.rule}) and is not readable.` };
  const root = fs.realpathSync.native(path.dirname(skill.provenance.origin));
  const target = file ? path.resolve(root, file) : skill.provenance.origin;
  let real: string;
  try { real = fs.realpathSync.native(target); } catch { return { ok: false, text: `File not found in skill "${id}": ${file ?? 'SKILL.md'}.` }; }
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, text: 'That file is outside the skill folder.' };
  if (!/\.(?:md|txt)$/i.test(real)) return { ok: false, text: 'Only .md and .txt files of a skill can be read.' };
  const stat = fs.statSync(real);
  if (stat.size > MAX_SKILL_FILE_CHARS * 4) return { ok: false, text: 'That file is too large to read.' };
  const text = fs.readFileSync(real, 'utf8');
  const start = Math.max(0, Math.floor(offset) || 0);
  const chunk = text.slice(start, start + READ_SKILL_CHUNK);
  const more = start + READ_SKILL_CHUNK < text.length ? `\n\n[continues: read_skill with offset ${start + READ_SKILL_CHUNK}; ${text.length} characters in total]` : '';
  return { ok: true, text: `${chunk}${more}` };
}
