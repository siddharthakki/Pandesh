/**
 * The capability explorer's data: one read-only view that keeps four words apart, because blurring them is how
 * Pandesh comes to promise what it cannot do.
 *
 *   installed   it is on this PC (a model Ollama lists, a SKILL.md file, the Agent Reach tool)
 *   usable      it can do the job now (a model that fits the graphics memory and reports the ability, a skill whose
 *               needs are met, a tool that is configured)
 *   authorized  the user's rules let it act. Never a property of a model or a skill: only the approval gates and the
 *               conversation's permission mode decide, and nothing here grants or widens one.
 *
 * It adds no inventory of its own. Models come from `modelAwareness`, skills from the skill registries, Agent Reach
 * from its own config file. This module only classifies; the route supplies the inputs.
 */
import type { ModelSnapshot } from './modelAwareness';
import type { SkillManifest } from '../platform/skills/skillRuntime';

export interface ExplorerModel {
  name: string;
  installed: true;
  loaded: boolean;
  selected: boolean;
  vision: boolean;
  tools: boolean;
  embedding: boolean;
  /** Fits the graphics memory budget; null when its size or the GPU is unknown. */
  fitsGpu: boolean | null;
  /** Models only the owner may pick by hand (modified variants). */
  manualOnly: boolean;
  /** Plain words: what it is good for here, and why not when it is not usable. */
  usable: boolean;
  note: string;
}

export interface ExplorerModels {
  serverAnswering: boolean;
  selected: string | null;
  selectedKind: 'local' | 'cloud' | 'unknown';
  gpu: { name: string; totalVramMb: number } | null;
  models: ExplorerModel[];
}

export function explorerModels(snap: ModelSnapshot): ExplorerModels {
  const gpu = snap.gpu ? { name: snap.gpu.name, totalVramMb: snap.gpu.totalVramMb } : null;
  return {
    serverAnswering: snap.available,
    selected: snap.selected,
    selectedKind: snap.selectedKind,
    gpu,
    models: snap.models.map((m) => {
      const usable = !m.isEmbedding && m.fitsGpu !== false;
      const abilities = [m.canSee ? 'sees images' : null, m.canUseTools ? 'calls tools' : null].filter(Boolean).join(', ');
      const note = m.isEmbedding ? 'Embedding model: used for search, not for chat.'
        : m.fitsGpu === false ? 'Too large for this PC\'s graphics memory at Pandesh\'s context size.'
        : abilities ? `Chat model that ${abilities}.` : 'Chat model (text only; it reports no image or tool ability).';
      return { name: m.name, installed: true as const, loaded: m.loaded, selected: m.selected, vision: m.canSee, tools: m.canUseTools, embedding: m.isEmbedding, fitsGpu: m.fitsGpu, manualOnly: !m.autoEligible, usable, note };
    }),
  };
}

export interface SkillNeed { need: string; status: 'met' | 'missing' | 'checked_per_chat' }
export interface ExplorerSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  /** builtin and user skills are trusted; workspace skills need a trusted workspace; untrusted ones never run unapproved. */
  trust: string;
  installed: true;
  /** ready: nothing known blocks it. blocked: something named in `missing` or `blockedBy` stops it. */
  usable: 'ready' | 'blocked';
  needs: SkillNeed[];
  missing: string[];
  blockedBy: string | null;
  /** Skills never authorize an action; this says so on every row. */
  authorized: 'Every action it leads to still passes the approval gates.';
}

/** What the active local model can do, or undefined when unknown (cloud, or no model chosen). */
export interface ModelAbilities { vision: boolean; tools: boolean }

export function explorerSkill(skill: SkillManifest, model: ModelAbilities | undefined): ExplorerSkill {
  const needs: SkillNeed[] = [];
  const missing: string[] = [];
  const r = skill.requires;
  const abilityNeed = (flag: boolean | undefined, label: string, has: boolean | undefined) => {
    if (!flag) return;
    if (has === undefined) needs.push({ need: label, status: 'checked_per_chat' });
    else if (has) needs.push({ need: label, status: 'met' });
    else { needs.push({ need: label, status: 'missing' }); missing.push(label); }
  };
  abilityNeed(r.vision, 'a model that can see images', model?.vision);
  abilityNeed(r.tools, 'a model that can call tools', model?.tools);
  if (r.minContext) needs.push({ need: `a context window of at least ${r.minContext} tokens`, status: 'checked_per_chat' });
  if (r.browser) needs.push({ need: 'a browser', status: 'checked_per_chat' });
  if (r.workspace) needs.push({ need: 'an open workspace folder', status: 'checked_per_chat' });
  for (const c of r.capabilities ?? []) needs.push({ need: `permission: ${c}`, status: 'checked_per_chat' });

  const block = skill.flags.find((f) => f.severity === 'block');
  let blockedBy: string | null = null;
  if (skill.trust !== 'builtin') {
    if (block) blockedBy = `contains an instruction Pandesh refuses to follow (${block.rule})`;
    else if (skill.trust === 'untrusted') blockedBy = 'not approved: it does not run until you approve its exact content';
    else if (skill.trust === 'workspace') blockedBy = 'a workspace skill: it loads only in a trusted workspace folder';
  }
  const usable = missing.length === 0 && !(blockedBy && skill.trust !== 'workspace') ? 'ready' : 'blocked';
  return { id: skill.id, name: skill.name, description: skill.description, version: skill.version, source: skill.source, trust: skill.trust, installed: true, usable, needs, missing, blockedBy, authorized: 'Every action it leads to still passes the approval gates.' };
}

export interface AgentReachView {
  installed: boolean;
  /** Public sources it reads, with the actions allowed on each. */
  channels: Array<{ channel: string; actions: string[] }>;
  usable: boolean;
  detail: string;
  authorized: string;
}

export function explorerAgentReach(configured: boolean, allowed: Readonly<Record<string, readonly string[]>>): AgentReachView {
  return {
    installed: configured,
    channels: Object.entries(allowed).map(([channel, actions]) => ({ channel, actions: [...actions] })),
    usable: configured,
    detail: configured
      ? 'Installed with its own isolated home. It reads public pages only: no login, no account, nothing posted.'
      : 'Not installed on this PC, so Pandesh cannot read YouTube, Reddit, GitHub or V2EX through it. Web research still works.',
    authorized: 'Asks you for consent before it goes online, and Plan only still shows that consent card. Only a short public query or a public link ever leaves this PC.',
  };
}
