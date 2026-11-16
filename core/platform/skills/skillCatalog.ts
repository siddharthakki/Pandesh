/**
 * Skill discovery for the model: one place that answers "is there a skill for this?" across the built-in skills and the
 * person's own skills folder, says what each one IS (readable advice, a workflow, or a built-in behaviour that already
 * runs), what it depends on, and why one that looks right cannot be used. Also holds drafts of proposed skills.
 *
 * A skill is text. Finding or reading one grants nothing: tools, approvals, paths and network rules are Core's. Nothing
 * here installs, downloads or runs a skill, and a proposed skill is written to a drafts folder that is never loaded.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SkillRegistry, resolveSkills, type SkillManifest } from './skillRuntime';
import { registerBuiltinSkills } from './skillSources';
import { loadUserSkills, skillsDir } from './skillService';
import { maskSecrets } from '../../shared/secretMask';

export const SKILL_DRAFTS_DIR = 'skill-proposals';
const MAX_DRAFT_CHARS = 6_000;

export function draftsDir(dataDir: string): string { return path.join(dataDir, SKILL_DRAFTS_DIR); }

function kindLabel(s: SkillManifest): string {
  if (s.kind === 'host-hook') return 'built-in behaviour (already runs by itself; nothing to read or call)';
  if (s.kind === 'workflow') return 'workflow (advice for several steps; each step still needs its own tool and approval)';
  return 'procedure (advice you read and follow; it is not a tool and grants nothing)';
}

async function mergedRegistry(dataDir: string | undefined): Promise<{ registry: SkillRegistry; userCount: number; rejected: number }> {
  const registry = new SkillRegistry();
  const all = new SkillRegistry();
  registerBuiltinSkills(all);
  // Built-in behaviours (cloud budget, evidence checks) run by themselves; they are not procedures to find or read.
  for (const s of all.list()) if (s.kind !== 'host-hook') registry.add(s);
  const user = await loadUserSkills(dataDir);
  let userCount = 0;
  for (const s of user?.registry.list() ?? []) { registry.add(s); userCount++; }
  return { registry, userCount, rejected: user?.report.rejected.length ?? 0 };
}

export interface FindSkillOptions { workspaceOpen?: boolean; max?: number }

/** Ranked skills for a task, with the reason a close match was left out. Returns plain text for the model. */
export async function findSkills(dataDir: string | undefined, task: string, opts: FindSkillOptions = {}): Promise<string> {
  const query = String(task ?? '').trim();
  if (!query) return 'Say what the task is, in a few words, and I will look for a skill that fits.';
  const { registry, userCount, rejected } = await mergedRegistry(dataDir);
  // Discovery only: capabilities are listed as "Needs", not enforced here (reading a skill grants nothing, and the
  // tools the skill mentions stay governed by Core when they are called).
  const declared = new Set(registry.list().flatMap((s) => s.requires.capabilities));
  const resolved = resolveSkills(registry, {
    intent: query, grantedCapabilities: declared, workspaceOpen: opts.workspaceOpen, minScore: 2,
    maxSkills: Math.min(5, Math.max(1, opts.max ?? 3)), budgetTokens: 6_000,
  });
  const lines: string[] = [];
  for (const s of resolved.selected) {
    const needs = s.requires.capabilities.length ? ` Needs: ${s.requires.capabilities.join(', ')}.` : '';
    const checks = s.validation.length ? ` Before reporting done, evidence: ${s.validation.join(', ')}.` : '';
    const from = s.source === 'builtin' ? 'built in' : `${s.trust} skill, hash ${s.provenance.hash.slice(0, 8)}`;
    lines.push(`- ${s.id} — ${s.name} [${from}]: ${s.description.replace(/\s+/g, ' ').slice(0, 200)}\n  What it is: ${kindLabel(s)}.${needs}${checks}`);
  }
  const blocked = resolved.decisions.filter((d) => d.status === 'skipped' && d.reason !== 'incompatible_task' && d.reason !== 'not_selected_budget' && d.reason !== 'incompatible_model');
  for (const d of blocked.slice(0, 3)) {
    lines.push(`- ${d.id} looked related but cannot be used: ${d.detail}`);
  }
  const drafts = listDrafts(dataDir).filter((d) => query.toLowerCase().split(/\W+/).some((w) => w.length > 3 && d.id.includes(w)));
  for (const d of drafts.slice(0, 2)) lines.push(`- ${d.id} is a DRAFT proposed earlier (not active; the owner has to review it and move it into the skills folder).`);
  const scope = `Searched ${registry.size - userCount} built-in and ${userCount} installed skill(s)${rejected ? `, ${rejected} installed file(s) were rejected` : ''}.`;
  if (lines.length === 0) {
    return `No skill fits "${query.slice(0, 80)}". ${scope}\nWork from the tools you have. If this is a procedure worth keeping, finish the task first, then propose_skill with what actually worked. Do not download or install a skill from the internet.`;
  }
  const combine = resolved.selected.length >= 2 && resolved.selected.every((s) => s.kind !== 'host-hook')
    ? '\nSeveral fit: read the best one first; use a second only for a step the first does not cover.' : '';
  return `${lines.join('\n')}${combine}\n${scope} Read one with read_skill (id). A skill never grants a tool or permission: if you lack a tool it mentions, say so or use request_tools.`;
}

/** The text of a built-in skill (its procedure), for read_skill. Null when the id is not built in. */
export function readBuiltinSkill(id: string): string | null {
  const registry = new SkillRegistry();
  registerBuiltinSkills(registry);
  const s = registry.get(String(id ?? ''));
  if (!s) return null;
  if (s.kind === 'host-hook') return `"${s.id}" is a built-in behaviour: ${s.description}\nIt is applied by Pandesh Core automatically. There is no procedure to follow.`;
  const needs = s.requires.capabilities.length ? `\nNeeds: ${s.requires.capabilities.join(', ')}.` : '';
  const checks = s.validation.length ? `\nBefore reporting done, evidence: ${s.validation.join(', ')}.` : '';
  return `# ${s.name} (${s.id}, built in)\n${s.description}\n\n${s.body.trim()}${needs}${checks}`;
}

function listDrafts(dataDir: string | undefined): Array<{ id: string }> {
  if (!dataDir) return [];
  try {
    return fs.readdirSync(draftsDir(dataDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ id: e.name }));
  } catch { return []; }
}

const SKILL_ID = /^[a-z][a-z0-9-]{2,48}$/;

export interface SkillProposal { id: string; name: string; description: string; body: string; evidence?: string; source?: string }

/**
 * Stores a proposed new or improved skill as a draft the owner can review. The drafts folder is not the skills folder,
 * so a draft is never loaded or offered until the owner moves it. Secrets are masked, a draft never overwrites one, and
 * a skill that tries to give itself permissions or tells the model to ignore its rules is refused.
 */
export function proposeSkill(dataDir: string | undefined, p: SkillProposal): { ok: boolean; text: string } {
  if (!dataDir) return { ok: false, text: 'No Pandesh data folder is available, so the draft was not saved.' };
  const id = String(p.id ?? '').trim().toLowerCase();
  if (!SKILL_ID.test(id)) return { ok: false, text: 'The id must be 3-49 characters: lower-case letters, digits and hyphens, starting with a letter (e.g. check-invoice-totals).' };
  const name = String(p.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const description = String(p.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const body = String(p.body ?? '').trim();
  if (!name || description.length < 20) return { ok: false, text: 'A skill needs a name and a description of at least 20 characters saying when to use it.' };
  if (body.length < 80) return { ok: false, text: 'The body is too short to be a procedure: give the steps, the check that proves it worked, and when not to use it.' };
  if (/\b(?:ignore|disregard|override)\b[^.\n]{0,40}\b(?:instructions?|rules?|polic(?:y|ies)|approval)/i.test(body) || /\b(?:without|skip|bypass)\b[^.\n]{0,20}\b(?:approval|asking|permission)/i.test(body)) {
    return { ok: false, text: 'Refused: a skill cannot tell Pandesh to skip approvals or ignore its rules. Rewrite the steps so every consequential action still asks.' };
  }
  const dir = path.join(draftsDir(dataDir), id);
  if (fs.existsSync(dir) || fs.existsSync(path.join(skillsDir(dataDir), id))) return { ok: false, text: `A skill or draft named "${id}" already exists. Choose another id (for an improvement, add a suffix such as ${id}-v2).` };
  const masked = maskSecrets(body.slice(0, MAX_DRAFT_CHARS));
  const front = [
    '---', `name: ${name}`, `description: ${description}`, 'version: 0.1.0', 'kind: procedure', 'trust: draft — proposed by Pandesh, not reviewed',
    ...(p.source ? [`source: ${String(p.source).replace(/\s+/g, ' ').slice(0, 200)}`] : []), '---', '',
  ].join('\n');
  const evidence = p.evidence ? `\n\n## Evidence this worked\n${maskSecrets(String(p.evidence).slice(0, 1_500)).text}\n` : '';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${front}${masked.text}${evidence}`, 'utf8');
  return { ok: true, text: `Draft saved as "${id}" in the skill-proposals folder${masked.masked ? ' (secret-looking text was masked)' : ''}. It is NOT active: the owner reviews it and, if it is good, moves the folder into the skills folder. Tell the user it exists and what it covers; do not call it installed.` };
}
