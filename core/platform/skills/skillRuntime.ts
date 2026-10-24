/**
 * Universal Skill Runtime (host-neutral, JARVIS-reusable).
 *
 *   Capability = permission     (what governance has granted)
 *   Tool       = executable operation
 *   Skill      = procedure / knowledge / workflow
 *
 * A skill can *describe* a procedure and *declare* what it needs; it can never grant anything. The resolver turns an intent
 * into a handful of compact, relevant skills through:
 *
 *   intent → search → compatibility → trust/provenance → capability → rank → select → compile
 *
 * so thousands of installed skills never reach the model. Governance always outranks skill text: permissions, approvals,
 * path boundaries, network and credential policy and completion guards are enforced elsewhere and are not inputs here.
 */
export type SkillSource = 'builtin' | 'user' | 'workspace' | 'mcp' | 'cli' | 'api' | 'remote';
export type SkillTrust = 'builtin' | 'user' | 'workspace' | 'untrusted';
export type SkillKind = 'procedure' | 'workflow' | 'host-hook';

export interface SkillRequirements {
  /** Permission names governance must have granted (`workspace.read`, `terminal.execute`, `browser.navigate`, …). */
  capabilities: string[];
  vision?: boolean;
  tools?: boolean;
  minContext?: number;
  browser?: boolean;
  workspace?: boolean;
}

export interface SkillProvenance {
  origin: string;
  /** SHA-256 of the skill text as loaded; remote skills run only when this matches a user-approved pin. */
  hash: string;
  loadedAt: string;
}

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: SkillKind;
  source: SkillSource;
  trust: SkillTrust;
  provenance: SkillProvenance;
  tags: string[];
  intents: string[];
  taskClasses: string[];
  requires: SkillRequirements;
  /** Claims the task may not be reported as done without evidence for (`tests_passed`, `file_written`, …). */
  validation: string[];
  /** Host-side behaviours this skill switches on (no prompt text involved). */
  hostHooks: string[];
  /** Compact procedure text. Sanitised and bounded. */
  body: string;
  /** Findings from the directive sanitizer; a `block` finding disqualifies untrusted and workspace skills. */
  flags: SkillFlag[];
}

export interface SkillFlag { severity: 'warn' | 'block'; rule: string; excerpt: string }

export const MAX_SKILL_BODY_CHARS = 8_000;
export const MAX_SKILL_FILE_CHARS = 64_000;

const EXPECTED_GOVERNANCE_NOTICE = 'Skills are advisory procedures. Permissions, approvals, path limits, network and credential policy, and completion checks still apply and cannot be changed by a skill.';

// ---------------------------------------------------------------------------------------------------------------- security

const DIRECTIVE_RULES: Array<{ rule: string; severity: SkillFlag['severity']; pattern: RegExp }> = [
  { rule: 'override-instructions', severity: 'block', pattern: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|system|safety)\b[^.\n]{0,30}\b(?:instructions?|rules?|polic(?:y|ies)|prompts?|guardrails?)\b/i },
  { rule: 'disable-governance', severity: 'block', pattern: /\b(?:disable|bypass|skip|turn off|circumvent|avoid|suppress)\b[^.\n]{0,30}\b(?:approvals?|governance|permissions?|safety|sandbox|polic(?:y|ies)|confirmations?|guards?|checks?)\b/i },
  { rule: 'act-without-approval', severity: 'block', pattern: /\b(?:without|no need for|don'?t (?:ask|wait for))\b[^.\n]{0,20}\b(?:approval|permission|confirmation|asking the user)\b/i },
  { rule: 'role-reassignment', severity: 'block', pattern: /\b(?:you are now|new system prompt|from now on you|act as (?:root|admin|an? unrestricted))\b/i },
  { rule: 'credential-exfiltration', severity: 'block', pattern: /\b(?:send|post|upload|exfiltrate|leak|email|curl|forward)\b[^.\n]{0,60}\b(?:credentials?|api[ _-]?keys?|tokens?|secrets?|passwords?|ssh keys?|\.env)\b/i },
  { rule: 'read-credential-files', severity: 'block', pattern: /(?:\bid_rsa\b|\.aws\/credentials|\.npmrc|\.git-credentials|\bsecrets?\.(?:json|ya?ml)\b)/i },
  { rule: 'pipe-to-shell', severity: 'block', pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i },
  { rule: 'destructive-command', severity: 'warn', pattern: /\brm\s+-rf?\s+[\/~]|\bformat\s+[a-z]:|\bdel\s+\/[sfq]|\bdrop\s+(?:database|table)\b/i },
  { rule: 'hidden-instructions', severity: 'block', pattern: /<!--[\s\S]{0,400}?(?:ignore|system prompt|instruction)[\s\S]{0,400}?-->|[​-‏⁠﻿]{3,}/i },
];

/** Findings only; the text is never silently rewritten (a skill that needed rewriting is a skill not to trust). */
export function scanSkillText(text: string): SkillFlag[] {
  const flags: SkillFlag[] = [];
  for (const { rule, severity, pattern } of DIRECTIVE_RULES) {
    const match = pattern.exec(text);
    if (match) flags.push({ severity, rule, excerpt: match[0].slice(0, 120).replace(/\s+/g, ' ') });
  }
  return flags;
}

export async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------- parsing

function listOf(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.replace(/^\[|\]$/g, '').split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).slice(0, 50);
}

function boolOf(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return /^(true|yes|1)$/i.test(raw.trim()) ? true : /^(false|no|0)$/i.test(raw.trim()) ? false : undefined;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface ParseOptions {
  source: SkillSource;
  origin: string;
  /** Trust is decided by WHERE a skill was loaded from, never by what the file says about itself. */
  trust: SkillTrust;
  now?: () => Date;
}

export type ParseResult = { ok: true; skill: SkillManifest } | { ok: false; reason: string };

/**
 * SKILL.md-style parser: optional `---` frontmatter of `key: value` lines, then a markdown body. Understands `name`,
 * `description`, `version`, `tags`, `intents`, `task-classes`, `requires`, `validation`, `hooks`, `vision`, `tools`,
 * `browser`, `workspace`, `min-context`. A `trust:` (or `source:`) key in the file is ignored by design.
 */
export async function parseSkillMarkdown(text: string, options: ParseOptions): Promise<ParseResult> {
  if (text.length > MAX_SKILL_FILE_CHARS) return { ok: false, reason: `skill file exceeds ${MAX_SKILL_FILE_CHARS} characters` };
  let front: Record<string, string> = {};
  let body = text;
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (kv) front[kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const name = (front.name || heading || '').trim();
  const id = (front.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!name || !SLUG.test(id)) return { ok: false, reason: 'a skill needs a name that yields a valid id (letters, digits, dashes)' };
  const description = (front.description || body.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#'))?.trim() || '').slice(0, 400);
  if (!description) return { ok: false, reason: 'a skill needs a description' };
  const trimmedBody = body.trim().slice(0, MAX_SKILL_BODY_CHARS);
  const requires: SkillRequirements = {
    capabilities: listOf(front.requires ?? front.capabilities),
    ...(boolOf(front.vision) !== undefined ? { vision: boolOf(front.vision) } : {}),
    ...(boolOf(front.tools) !== undefined ? { tools: boolOf(front.tools) } : {}),
    ...(boolOf(front.browser) !== undefined ? { browser: boolOf(front.browser) } : {}),
    ...(boolOf(front.workspace) !== undefined ? { workspace: boolOf(front.workspace) } : {}),
    ...(Number.isFinite(Number(front['min-context'])) && Number(front['min-context']) > 0 ? { minContext: Number(front['min-context']) } : {}),
  };
  const skill: SkillManifest = {
    id, name: name.slice(0, 120), description,
    version: front.version || '0.0.0',
    kind: front.kind === 'workflow' ? 'workflow' : 'procedure',
    source: options.source,
    trust: options.trust,
    provenance: { origin: options.origin, hash: await sha256Hex(text), loadedAt: (options.now?.() ?? new Date()).toISOString() },
    tags: listOf(front.tags),
    intents: listOf(front.intents),
    taskClasses: listOf(front['task-classes'] ?? front.tasks),
    requires,
    validation: listOf(front.validation),
    hostHooks: [],
    body: trimmedBody,
    flags: scanSkillText(`${name}\n${description}\n${trimmedBody}`),
  };
  return { ok: true, skill };
}

// ---------------------------------------------------------------------------------------------------------------- registry

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'this', 'that', 'it', 'is', 'are', 'be', 'my', 'me', 'i', 'we', 'you', 'please', 'can', 'could', 'should', 'would', 'how', 'do', 'does', 'what', 'why', 'when', 'then', 'also', 'into', 'from', 'by', 'at', 'as', 'not', 'any', 'all']);

export function tokens(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 3 && !STOP.has(part)) out.add(part.endsWith('s') && part.length > 4 ? part.slice(0, -1) : part);
  }
  return [...out];
}

const TASK_CLASS_HINTS: Array<[string, RegExp]> = [
  ['debug', /\b(?:debug|bug|crash|error|exception|fail(?:s|ing|ed)?|broken|not working|stack ?trace|reproduce|regression)\b/i],
  ['test', /\b(?:test|tests|spec|coverage|assert|unit|integration|e2e)\b/i],
  ['review', /\b(?:review|audit|critique|inspect|check for|code smell|security review)\b/i],
  ['explain', /\b(?:explain|how does|what is|why does|walk me through|describe|overview|architecture|understand)\b/i],
  ['create', /\b(?:create|add|build|implement|write|generate|scaffold|make)\b/i],
  ['refactor', /\b(?:refactor|rename|restructure|clean ?up|simplify|migrate|port|upgrade)\b/i],
  ['research', /\b(?:research|look up|find out|compare|documentation|docs for|search the web)\b/i],
  ['browser', /\b(?:browser|web ?page|website|url|http|click|screenshot|dom|localhost|web app|login form)\b/i],
  ['data', /\b(?:csv|json|table|spreadsheet|dataset|chart|plot|analy[sz]e data)\b/i],
  ['docs', /\b(?:readme|documentation|changelog|comment|docstring)\b/i],
];

export function classifyTaskClasses(intent: string): string[] {
  const out = TASK_CLASS_HINTS.filter(([, pattern]) => pattern.test(intent)).map(([name]) => name);
  return out.length ? out : ['general'];
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillManifest>();
  private readonly index = new Map<string, Set<string>>();

  get size(): number { return this.skills.size; }
  list(): SkillManifest[] { return [...this.skills.values()]; }
  get(id: string): SkillManifest | undefined { return this.skills.get(id); }

  add(skill: SkillManifest): void {
    if (this.skills.has(skill.id)) this.remove(skill.id);
    this.skills.set(skill.id, skill);
    for (const token of this.searchTokens(skill)) {
      const set = this.index.get(token);
      if (set) set.add(skill.id); else this.index.set(token, new Set([skill.id]));
    }
  }

  remove(id: string): void {
    const skill = this.skills.get(id);
    if (!skill) return;
    for (const token of this.searchTokens(skill)) { const set = this.index.get(token); set?.delete(id); if (set?.size === 0) this.index.delete(token); }
    this.skills.delete(id);
  }

  clear(source?: SkillSource): void {
    for (const skill of [...this.skills.values()]) if (!source || skill.source === source) this.remove(skill.id);
  }

  private searchTokens(skill: SkillManifest): string[] {
    return [...new Set([...tokens(skill.name), ...tokens(skill.description), ...skill.tags.flatMap(tokens), ...skill.intents.flatMap(tokens), ...skill.taskClasses])];
  }

  /** Candidate ids sharing at least one token with the query: cost follows matches, not the number of installed skills. */
  candidates(queryTokens: readonly string[]): string[] {
    const hits = new Map<string, number>();
    for (const token of queryTokens) for (const id of this.index.get(token) ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
    return [...hits.keys()];
  }
}

// ---------------------------------------------------------------------------------------------------------------- resolution

export interface ResolveContext {
  intent: string;
  /** Permission names governance has granted for this task. */
  grantedCapabilities: ReadonlySet<string>;
  model?: { vision?: boolean; tools?: boolean; contextWindow?: number };
  workspaceOpen?: boolean;
  browserAvailable?: boolean;
  /** VS Code Workspace Trust (or equivalent). Workspace-sourced skills are ignored while false. */
  workspaceTrusted?: boolean;
  /** Content hashes the user explicitly approved for remote/MCP/API skills. */
  approvedHashes?: ReadonlySet<string>;
  maxSkills?: number;
  budgetTokens?: number;
}

export type SkillDecision =
  | { id: string; status: 'selected'; score: number; reason: string }
  | { id: string; status: 'skipped'; reason: 'incompatible_task' | 'incompatible_model' | 'workspace_required' | 'browser_unavailable' | 'untrusted' | 'workspace_untrusted' | 'blocked_directive' | 'missing_capability' | 'not_selected_budget'; detail: string };

export interface ResolvedSkills {
  selected: SkillManifest[];
  decisions: SkillDecision[];
  /** Capabilities some otherwise-fitting skill would need. Governance may offer them; the skill is NOT loaded meanwhile. */
  needsCapabilities: string[];
  hostHooks: string[];
  validation: string[];
  /** Compact text for the model, within budget. Empty when nothing was selected. */
  compiled: string;
  compiledTokens: number;
  taskClasses: string[];
}

const tokenEstimate = (text: string): number => Math.ceil(text.length / 3.5);

function trustVerdict(skill: SkillManifest, ctx: ResolveContext): { ok: true } | { ok: false; reason: Extract<SkillDecision, { status: 'skipped' }>['reason']; detail: string } {
  const blocking = skill.flags.find(flag => flag.severity === 'block');
  if (skill.trust === 'builtin') return { ok: true };
  if (blocking) return { ok: false, reason: 'blocked_directive', detail: `${blocking.rule}: "${blocking.excerpt}"` };
  if (skill.trust === 'workspace' && ctx.workspaceTrusted !== true) return { ok: false, reason: 'workspace_untrusted', detail: 'workspace skills load only in a trusted workspace' };
  if (skill.trust === 'untrusted' && !ctx.approvedHashes?.has(skill.provenance.hash)) return { ok: false, reason: 'untrusted', detail: `${skill.source} skill is not validated (hash ${skill.provenance.hash.slice(0, 12)}…)` };
  return { ok: true };
}

export function resolveSkills(registry: SkillRegistry, ctx: ResolveContext): ResolvedSkills {
  const queryTokens = tokens(ctx.intent);
  const taskClasses = classifyTaskClasses(ctx.intent);
  const maxSkills = ctx.maxSkills ?? 3;
  const decisions: SkillDecision[] = [];
  const needs = new Set<string>();
  const scored: Array<{ skill: SkillManifest; score: number }> = [];

  for (const id of registry.candidates([...queryTokens, ...taskClasses])) {
    const skill = registry.get(id)!;
    // compatibility
    if (skill.taskClasses.length > 0 && !skill.taskClasses.some(c => taskClasses.includes(c) || c === 'general')) {
      decisions.push({ id, status: 'skipped', reason: 'incompatible_task', detail: `handles ${skill.taskClasses.join(', ')}; this task looks like ${taskClasses.join(', ')}` });
      continue;
    }
    const r = skill.requires;
    if (r.workspace && !ctx.workspaceOpen) { decisions.push({ id, status: 'skipped', reason: 'workspace_required', detail: 'needs an open workspace' }); continue; }
    if ((r.browser || r.capabilities.some(c => c.startsWith('browser.'))) && !ctx.browserAvailable) { decisions.push({ id, status: 'skipped', reason: 'browser_unavailable', detail: 'needs a browser executor' }); continue; }
    if ((r.vision && ctx.model?.vision !== true) || (r.tools && ctx.model?.tools === false) || (r.minContext && ctx.model?.contextWindow !== undefined && ctx.model.contextWindow < r.minContext)) {
      decisions.push({ id, status: 'skipped', reason: 'incompatible_model', detail: 'the selected model lacks a capability this skill needs' });
      continue;
    }
    // trust / provenance
    const trust = trustVerdict(skill, ctx);
    if (!trust.ok) { decisions.push({ id, status: 'skipped', reason: trust.reason, detail: trust.detail }); continue; }
    // capability (permission) check: a skill never widens what is granted
    const missing = r.capabilities.filter(c => !ctx.grantedCapabilities.has(c));
    if (missing.length > 0) {
      missing.forEach(c => needs.add(c));
      decisions.push({ id, status: 'skipped', reason: 'missing_capability', detail: `requires ${missing.join(', ')} which governance has not granted` });
      continue;
    }
    // rank
    const nameTokens = new Set(tokens(skill.name));
    const tagTokens = new Set([...skill.tags.flatMap(tokens), ...skill.intents.flatMap(tokens)]);
    const descTokens = new Set(tokens(skill.description));
    let score = 0;
    for (const t of queryTokens) score += (nameTokens.has(t) ? 5 : 0) + (tagTokens.has(t) ? 3 : 0) + (descTokens.has(t) ? 1 : 0);
    score += skill.taskClasses.filter(c => taskClasses.includes(c)).length * 2;
    if (skill.intents.some(i => ctx.intent.toLowerCase().includes(i.toLowerCase()))) score += 4;
    score += { builtin: 0.5, user: 0.3, workspace: 0.2, untrusted: 0 }[skill.trust];
    if (score > 0.6) scored.push({ skill, score });
  }

  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  const selected: SkillManifest[] = [];
  const budget = ctx.budgetTokens ?? 700;
  let used = 0;
  for (const { skill, score } of scored) {
    if (selected.length >= maxSkills) { decisions.push({ id: skill.id, status: 'skipped', reason: 'not_selected_budget', detail: `only the top ${maxSkills} skills are loaded` }); continue; }
    const cost = Math.min(tokenEstimate(skill.body), Math.floor(budget / maxSkills)) + 24;
    if (used + cost > budget && selected.length > 0) { decisions.push({ id: skill.id, status: 'skipped', reason: 'not_selected_budget', detail: 'skill budget exhausted' }); continue; }
    used += cost;
    selected.push(skill);
    decisions.push({ id: skill.id, status: 'selected', score, reason: `matched ${taskClasses.join('/')} intent` });
  }
  const compiled = compileSkills(selected, budget);
  return {
    selected,
    decisions,
    needsCapabilities: [...needs].sort(),
    hostHooks: [...new Set(selected.flatMap(s => s.hostHooks))],
    validation: [...new Set(selected.flatMap(s => s.validation))],
    compiled,
    compiledTokens: tokenEstimate(compiled),
    taskClasses,
  };
}

/** Compact, bounded text. Host-hook skills contribute behaviour, not prose. */
export function compileSkills(skills: readonly SkillManifest[], budgetTokens = 700): string {
  const procedural = skills.filter(s => s.body.trim() && s.kind !== 'host-hook');
  if (procedural.length === 0) return '';
  const perSkillChars = Math.max(300, Math.floor((budgetTokens * 3.5) / procedural.length) - 80);
  const parts = procedural.map(skill => {
    let body = skill.body.replace(/^#.*\n+/, '').trim();
    if (body.length > perSkillChars) body = `${body.slice(0, perSkillChars).replace(/\s+\S*$/, '')} …`;
    const needs = skill.validation.length ? `\nBefore reporting done: ${skill.validation.join(', ')} must be evidenced.` : '';
    return `### ${skill.name} (${skill.id}; ${skill.trust})\n${body}${needs}`;
  });
  return `[Skill guidance — ${EXPECTED_GOVERNANCE_NOTICE}]\n${parts.join('\n\n')}`;
}

export const SKILL_GOVERNANCE_NOTICE = EXPECTED_GOVERNANCE_NOTICE;
