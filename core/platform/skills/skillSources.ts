/**
 * Skill sources. A source turns "somewhere skills live" into SkillManifests with the trust that WHERE they live deserves:
 * built-in (shipped), user (the person installed them), workspace (anyone who can commit to the repository), and
 * mcp/cli/api/remote (external: untrusted until a user-approved content hash pins them).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BUILTIN_SKILLS } from './builtinSkills';
import { parseSkillMarkdown, SkillRegistry, type ParseResult, type SkillManifest, type SkillSource, type SkillTrust } from './skillRuntime';

export interface SkillLoadReport { loaded: number; rejected: Array<{ origin: string; reason: string }> }

const MAX_SKILLS_PER_SOURCE = 500;
const MAX_DEPTH = 3;

export function registerBuiltinSkills(registry: SkillRegistry): void {
  for (const skill of BUILTIN_SKILLS) registry.add(skill);
}

async function findSkillFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_SKILLS_PER_SOURCE || depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_SKILLS_PER_SOURCE) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && (entry.name.toLowerCase() === 'skill.md' || /\.skill\.md$/i.test(entry.name))) {
        found.push(full);
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** Loads every SKILL.md / *.skill.md under `root` with the trust of that source. Bad files are reported, never fatal. */
export async function loadSkillDirectory(
  registry: SkillRegistry,
  root: string,
  source: Extract<SkillSource, 'user' | 'workspace'>,
): Promise<SkillLoadReport> {
  const trust: SkillTrust = source;
  const report: SkillLoadReport = { loaded: 0, rejected: [] };
  for (const file of await findSkillFiles(root)) {
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { report.rejected.push({ origin: file, reason: error instanceof Error ? error.message : String(error) }); continue; }
    const parsed = await parseSkillMarkdown(text, { source, origin: file, trust });
    if (!parsed.ok) { report.rejected.push({ origin: file, reason: parsed.reason }); continue; }
    if (registry.get(parsed.skill.id)?.trust === 'builtin') { report.rejected.push({ origin: file, reason: `id "${parsed.skill.id}" is reserved by a built-in skill` }); continue; }
    registry.add(parsed.skill);
    report.loaded++;
  }
  return report;
}

/** An externally described skill (MCP tool workflow, CLI recipe, API workflow, remote catalog): always untrusted on arrival. */
export async function addExternalSkill(
  registry: SkillRegistry,
  text: string,
  source: Extract<SkillSource, 'mcp' | 'cli' | 'api' | 'remote'>,
  origin: string,
): Promise<ParseResult> {
  const parsed = await parseSkillMarkdown(text, { source, origin, trust: 'untrusted' });
  if (parsed.ok) {
    if (registry.get(parsed.skill.id)?.trust === 'builtin') return { ok: false, reason: `id "${parsed.skill.id}" is reserved by a built-in skill` };
    registry.add(parsed.skill);
  }
  return parsed;
}

export type { SkillManifest };
