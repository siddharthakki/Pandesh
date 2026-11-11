/**
 * Phase 2b — specialist agents as Core-enforced definitions
 * (docs/architecture/pandesh-ui-v2/multi_agent_architecture.md §3–§6,
 * review_decisions D4).
 *
 * An agent is not a process and not a model: it is a definition (allowlisted
 * tools, workspace roots, memory scopes, egress, model policy, limits) applied
 * to an ordinary request. Runs happen on demand in the existing executor; an
 * idle agent costs nothing.
 *
 * The effective scope of a run is a stack of LAYERS: the agent's definition,
 * then (for a delegation) every ancestor's effective scope and each explicit
 * grant. A tool / path / memory scope is allowed only when EVERY layer allows
 * it, so delegation is an intersection by construction and can never widen
 * authorization. The scope is frozen into `agent_runs` when the request is
 * created, so a later edit of a definition never changes a run in flight.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { reallyInside } from '../platform/realLocation';

export type MemoryAccess = 'read' | 'read_write';
export type Egress = 'none' | 'approval' | { domains: string[] };

export interface AgentDefinition {
  id: string;
  kind: 'builtin' | 'custom' | 'template';
  name: string;
  role: string;
  version: number;
  /** One or two sentences: what this agent is for. Shown on the Team screen and given to the model. */
  instructions: string;
  /**
   * How this agent works, for the model only (not shown on the Team screen): the working method, what "done"
   * means and what to report back. Written in the shape that makes a specialist reliable: a method that ends in a
   * check, a definition of done, and a report the delegating agent can relay as it is.
   */
  workingRules?: string;
  /** Allowlisted tool names; `prefix_*` matches a family. */
  tools: string[];
  toolDenylist: string[];
  memoryScopes: Array<{ scope: string; access: MemoryAccess }>;
  /** `conversation` = the conversation's selected folder only; [] = no filesystem. */
  workspaceRoots: Array<'conversation' | string>;
  egress: Egress;
  /** Action categories that always ask, on top of the global rules (can only add approvals). */
  alwaysAsk: string[];
  modelPolicy: { localOnly: boolean; models: string[] };
  limits: { maxSteps: number; maxToolCalls: number; maxWallSeconds: number; maxDelegationDepth: number };
  enabled: boolean;
  /** Templates arrive in a later phase and cannot be enabled before their tools exist. */
  availability: 'available' | 'phase3';
}

/** Harmless helpers every agent keeps: time, arithmetic, its own task record, asking for more tools (still gated). */
export const ALWAYS_ALLOWED = new Set(['request_tools', 'get_system_info', 'resolve_time', 'calculate', 'update_task_outcome', 'declare_execution_plan', 'execution_plan_status']);

const LIMITS = { maxSteps: 24, maxToolCalls: 40, maxWallSeconds: 900, maxDelegationDepth: 2 };

const def = (d: Omit<AgentDefinition, 'version' | 'toolDenylist' | 'alwaysAsk' | 'limits' | 'enabled' | 'availability' | 'modelPolicy'> & Partial<AgentDefinition>): AgentDefinition => ({
  version: 1, toolDenylist: [], alwaysAsk: [], limits: { ...LIMITS }, enabled: true, availability: 'available', modelPolicy: { localOnly: true, models: [] }, ...d,
});

export const BUILTIN_AGENTS: AgentDefinition[] = [
  def({
    id: 'chief', kind: 'builtin', name: 'Pandesh', role: 'Chief of Staff — routes, plans, delegates, briefs and reports',
    instructions: 'You are Pandesh, the chief of staff. Answer directly when you can; delegate specialist work to the right agent with a restated brief; report only what evidence supports.',
    workingRules: 'How you work: answer simple questions yourself. Hand over work that needs a specialist\'s tools, and write the brief for a colleague who has not seen this chat: the goal, the facts you already have that it needs, what to return, and what done looks like. Check each result before you pass it on. Report only what the evidence shows, and say which agent did what.',
    tools: ['read_file', 'list_directory', 'search_files', 'memory_recall', 'routine_list', 'list_reminders', 'list_commitments', 'list_scheduled_tasks', 'get_briefing_data', 'dev_stories_status', 'wish_status', 'household_obligations', 'list_projects'],
    memoryScopes: [{ scope: 'user', access: 'read' }, { scope: 'global', access: 'read' }, { scope: 'task', access: 'read_write' }],
    workspaceRoots: ['conversation'], egress: 'none',
  }),
  def({
    id: 'personal', kind: 'builtin', name: 'Personal', role: 'Goals, routines, commitments, reminders and briefings',
    instructions: 'You manage the user\'s commitments, reminders, routines and calendar. Never send, accept or book anything without the user\'s approval.',
    workingRules: 'How you work: check what already exists first (reminders, commitments, the calendar) so you do not create duplicates. Use resolve_time for every date and time. Create, change or draft only what the brief asks; sending, accepting and booking stay with the user. Done means the item exists in a tool result. Report back: what you created or changed, with the date and time the tool stored, and anything waiting for the user\'s approval.',
    tools: ['create_reminder', 'list_reminders', 'dismiss_reminder', 'create_note', 'create_commitment', 'list_commitments', 'update_commitment', 'routine_*', 'schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task', 'calendar_list_events', 'calendar_check_availability', 'calendar_draft_event', 'gmail_search', 'gmail_read_thread', 'gmail_create_draft', 'household_*', 'get_briefing_data', 'list_projects', 'create_project', 'memory_recall', 'memory_remember'],
    toolDenylist: ['gmail_send_draft', 'calendar_delete_event'],
    memoryScopes: [{ scope: 'user', access: 'read_write' }, { scope: 'task', access: 'read_write' }],
    workspaceRoots: [], egress: 'approval', alwaysAsk: ['calendar_write', 'email_send'],
  }),
  def({
    id: 'coding', kind: 'builtin', name: 'Coding', role: 'Repositories, coding engines, tests and previews',
    instructions: 'You change code only inside the selected workspace, run its checks, and report exactly which files changed and which checks passed. Never push or install.',
    workingRules: 'How you work: read the files involved before you change anything, and follow the project\'s own conventions and notes. For a bug, reproduce it first with run_checks, then make the smallest change that fixes it. After every change, run the tests or the program and read the output; if it fails, fix it and run again. Change only what the brief asks: no extra features, refactors or files it did not need. Done means the checks you ran pass in this turn. Report back: the files you changed (full paths), each command with its exit code, what passed, and anything still failing or not done.',
    tools: ['read_file', 'list_directory', 'search_files', 'write_file', 'run_checks', 'delegate_to_opencode', 'delegate_to_coding_agent', 'dev_stories_*', 'dev_story_*', 'get_project_context', 'find_project_roots', 'search_recent_projects', 'port_list_services', 'port_service_health', 'port_check_setup', 'port_allocate', 'browser_open_site', 'browser_read', 'inspect_page', 'hermes_list_skills'],
    toolDenylist: ['read_file_outside_workspace', 'list_directory_outside_workspace', 'system_kill_process', 'port_stop_service'],
    memoryScopes: [{ scope: 'project', access: 'read_write' }, { scope: 'repository', access: 'read_write' }, { scope: 'task', access: 'read_write' }],
    workspaceRoots: ['conversation'], egress: 'none', alwaysAsk: ['install', 'push'],
  }),
  def({
    id: 'research', kind: 'builtin', name: 'Research', role: 'Public research, source verification and comparison',
    instructions: 'You research public sources only, cite every claim, and never send private information in a query.',
    workingRules: 'How you work: start with a short, broad search, then narrow down. Prefer primary sources (the maker, official documentation, public authorities) over blogs and list pages, and open the pages that matter instead of trusting snippets. Stop when the question is answered or the sources run out; do not keep searching for something that is not there. Done means every claim rests on a page you read. Report back: the answer first, then each source as a link, and say plainly what you could not confirm.',
    tools: ['web_research', 'governed_research', 'browser_open_site', 'browser_read', 'inspect_page', 'document_read', 'scout_research_repo', 'scout_list_watches', 'memory_recall', 'memory_remember'],
    memoryScopes: [{ scope: 'global', access: 'read_write' }, { scope: 'task', access: 'read_write' }],
    workspaceRoots: [], egress: 'approval',
  }),
  def({
    id: 'operations', kind: 'builtin', name: 'Operations', role: 'Files, apps, system health, printers and drives',
    instructions: 'You inspect and organise this PC. Every change asks first; you never touch processes Pandesh does not own.',
    workingRules: 'How you work: look before you change: list and read first, and describe what you found with the real paths, sizes and counts your tools returned. Propose a change (move, rename, delete, print) as a short list and let its approval card decide; never work around a refusal. Done means the tool results show the state you report. Report back: what you checked, what you changed and its result, and what still needs the user\'s decision.',
    tools: ['read_file', 'list_directory', 'search_files', 'find_duplicate_files', 'list_system_drives', 'system_list_*', 'system_hardware_telemetry', 'run_system_diagnostics', 'list_printers', 'print_test_page', 'list_network_drives', 'port_list_services', 'port_service_health', 'desktop_windows_list', 'desktop_screenshot', 'request_search_permission',
      // Challenge T13: read-only PC facts the Operations agent was asked for but could not reach.
      'listening_ports', 'software_updates', 'ollama_list_models', 'pc_capability_inventory', 'list_projects'],
    toolDenylist: ['system_kill_process', 'system_stop_service', 'system_start_service', 'ollama_delete_model'],
    memoryScopes: [{ scope: 'task', access: 'read_write' }, { scope: 'global', access: 'read' }],
    workspaceRoots: ['conversation'], egress: 'none',
  }),
  def({
    id: 'voice', kind: 'builtin', name: 'Voice', role: 'Speech in and out for the agent being addressed; owns no data',
    instructions: 'You are the voice channel. You speak on behalf of the addressed agent and hold no data or tools of your own.',
    tools: [], memoryScopes: [], workspaceRoots: [], egress: 'none',
  }),
  // Revenue team (2026-11-09). None of them can send, publish, commit or spend: drafts go to the owner's approval queue,
  // and responses, orders and money are recorded only by the owner (core/domain/revenuePipeline.ts).
  def({
    id: 'sales', kind: 'builtin', name: 'Sales', role: 'Prospects from public sources, qualification, personalised offers (no outreach is sent)',
    instructions: 'You find prospects only in lawful public sources (company websites, public directories, public event listings), record each with its source URL using revenue_record_lead, and write personalised offers and outreach drafts. In Germany unsolicited advertising e-mail or contact-form messages to businesses need prior consent (UWG §7), so draft letters, phone scripts for published business numbers, or replies to published enquiries instead. Never invent customers, prices or testimonials; use only the verified inputs you are given. Nothing is sent: every draft goes to the owner for approval. Keep the catering and digital tracks separate.',
    tools: ['web_research', 'governed_research', 'browser_open_site', 'browser_read', 'inspect_page', 'document_read', 'read_file', 'list_directory', 'search_files', 'write_file', 'revenue_*', 'wish_status', 'memory_recall'],
    toolDenylist: ['gmail_send_draft', 'gmail_create_draft', 'wish_order', 'wish_owner_decision'],
    memoryScopes: [{ scope: 'project', access: 'read' }, { scope: 'task', access: 'read_write' }],
    workspaceRoots: ['conversation'], egress: 'approval', alwaysAsk: ['email_send', 'publish', 'spend', 'commitment'],
  }),
  def({
    id: 'marketing', kind: 'builtin', name: 'Marketing', role: 'Offers, positioning, sample pages and campaign concepts (no paid spend)',
    instructions: 'You write offers, positioning, sample landing pages and campaign concepts as files in the selected folder, then record offers with revenue_record_offer. Use only verified facts and prices you are given; mark anything that still needs the owner’s numbers as TO CONFIRM. No paid advertising and no publishing.',
    tools: ['read_file', 'list_directory', 'search_files', 'write_file', 'revenue_*', 'web_research', 'governed_research', 'memory_recall'],
    toolDenylist: ['gmail_send_draft'],
    memoryScopes: [{ scope: 'project', access: 'read' }, { scope: 'task', access: 'read_write' }],
    workspaceRoots: ['conversation'], egress: 'approval', alwaysAsk: ['publish', 'spend'],
  }),
  def({
    id: 'social', kind: 'builtin', name: 'Social Media', role: 'Post drafts, campaign calendars and visual briefs (every publish asks)',
    instructions: 'You write social-media post drafts, a posting calendar and visual briefs, and record each post with revenue_record_draft (kind social). You never publish; the owner approves and posts.',
    tools: ['read_file', 'list_directory', 'write_file', 'revenue_*', 'memory_recall'],
    memoryScopes: [{ scope: 'task', access: 'read_write' }],
    workspaceRoots: ['conversation'], egress: 'none', alwaysAsk: ['publish'],
  }),
  def({
    id: 'reviewer', kind: 'builtin', name: 'Reviewer', role: 'Checks accuracy, privacy, pricing assumptions, claims and permissions',
    instructions: 'You review business material before the owner sees it: every price traces to a verified input, no invented customers or testimonials, no private personal data, no claim the business cannot back, and nothing that would need consent the owner does not have (UWG §7, GDPR). Report each problem with the file and line. You change nothing.',
    tools: ['read_file', 'list_directory', 'search_files', 'revenue_list', 'memory_recall'],
    memoryScopes: [{ scope: 'task', access: 'read_write' }],
    workspaceRoots: ['conversation'], egress: 'none',
  }),
  ...(['support'] as const).map((id) => def({
    id, kind: 'template', name: 'Customer Support',
    role: 'Customer inquiries from business knowledge only',
    instructions: 'Template: arrives in Phase 3 when its tools and business scopes exist.',
    tools: [], memoryScopes: [], workspaceRoots: [], egress: 'approval',
    enabled: false, availability: 'phase3',
  })),
];

// ---------- scope (pure) ----------

export interface ScopeLayer {
  source: string;
  /** null = this layer does not restrict tools. */
  tools: string[] | null;
  deny: string[];
  /** null = does not restrict paths; [] = no filesystem at all. */
  roots: string[] | null;
  /** null = does not restrict memory. */
  memory: Array<{ scope: string; access: MemoryAccess }> | null;
  egress: Egress | null;
  localOnly: boolean;
  /** A user's recorded OK (approval id) for this delegation's internet use, given in the parent's turn. */
  egressApprovalId?: string | null;
}

export interface EffectiveScope { agentId: string; agentVersion: number; depth: number; layers: ScopeLayer[]; conversationRoot: string | null }

const matches = (patterns: string[], name: string) => patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));

function resolveRoots(roots: Array<'conversation' | string>, conversationRoot: string | null): string[] {
  const out: string[] = [];
  for (const r of roots) {
    if (r === 'conversation') { if (conversationRoot) out.push(path.resolve(conversationRoot)); }
    else out.push(path.resolve(r));
  }
  return out;
}

export function layerFromDefinition(d: AgentDefinition, conversationRoot: string | null): ScopeLayer {
  return { source: `agent:${d.id}@${d.version}`, tools: d.tools, deny: d.toolDenylist, roots: resolveRoots(d.workspaceRoots, conversationRoot), memory: d.memoryScopes, egress: d.egress, localOnly: d.modelPolicy.localOnly };
}

export interface Grant { tools?: string[]; roots?: string[]; memory?: Array<{ scope: string; access: MemoryAccess }>; egress?: Egress; egressApprovalId?: string }

export function layerFromGrant(g: Grant, source: string): ScopeLayer {
  return { source, tools: g.tools ?? null, deny: [], roots: g.roots ? g.roots.map((r) => path.resolve(r)) : null, memory: g.memory ?? null, egress: g.egress ?? null, localOnly: false, egressApprovalId: g.egressApprovalId ?? null };
}

/** Child scope = child definition ∩ every parent layer ∩ explicit grant. */
export function deriveScope(d: AgentDefinition, conversationRoot: string | null, parent?: EffectiveScope | null, grant?: Grant | null): EffectiveScope {
  const depth = parent ? parent.depth + 1 : 0;
  const maxDepth = Math.min(d.limits.maxDelegationDepth, LIMITS.maxDelegationDepth);
  if (depth > maxDepth) throw new CoreError('invalid_request', `delegation depth ${depth} exceeds the limit of ${maxDepth}`);
  const layers = [layerFromDefinition(d, conversationRoot), ...(parent?.layers ?? []), ...(grant ? [layerFromGrant(grant, `grant@${depth}`)] : [])];
  return { agentId: d.id, agentVersion: d.version, depth, layers, conversationRoot: conversationRoot ? path.resolve(conversationRoot) : null };
}

export function isToolAllowed(scope: EffectiveScope, toolName: string): { allowed: true } | { allowed: false; reason: string } {
  for (const l of scope.layers) {
    if (matches(l.deny, toolName)) return { allowed: false, reason: `${toolName} is denied by ${l.source}` };
  }
  if (ALWAYS_ALLOWED.has(toolName)) return { allowed: true };
  for (const l of scope.layers) {
    if (l.tools && !matches(l.tools, toolName)) return { allowed: false, reason: `${toolName} is not in the scope of ${l.source}` };
  }
  return { allowed: true };
}

const PATH_KEYS = ['path', 'filePath', 'file', 'directory', 'dir', 'folder', 'root', 'roots', 'source', 'destination', 'target', 'cwd', 'paths', 'workspace'];
/**
 * Every argument NAMED like a filesystem location is checked, not only the fixed list above: the tools' own parameters
 * are dirPath, searchRoots, searchRoot, projectPath, workspacePath, documentPath, repoPath (Build 161 audit — these
 * skipped the gate), and a model may use file_path or outputFile.
 */
const PATH_KEY_PATTERN = /(?:path|paths|dir|dirs|directory|directories|folder|folders|root|roots|file|files)$/i;
/** Named like a path but not a filesystem location (Windows Task Scheduler folder, e.g. "\\"). */
const NON_FILESYSTEM_PATH_KEYS = new Set(['taskPath']);

function isPathKey(key: string): boolean {
  return !NON_FILESYSTEM_PATH_KEYS.has(key) && (PATH_KEYS.includes(key) || PATH_KEY_PATTERN.test(key));
}

/** Drive-relative ("C:notes.txt"), UNC, rooted, "." / ".." and anything with a separator. */
function looksLikePath(v: string): boolean { return /^(?:[A-Za-z]:|\\\\|\/|\.{1,2}(?:[\\/]|$))/.test(v) || v.includes('\\') || v.includes('/'); }

/**
 * Inside the root where the path really lands, not by its spelling (Build 161 audit): a junction inside an agent's
 * folder that points elsewhere passed this gate and then reached a card that could widen the agent's scope; another
 * spelling of an allowed folder (an 8.3 name) was refused.
 */
function inside(p: string, root: string): boolean {
  return reallyInside(p, root);
}

/** Every path-like argument must resolve inside the allowed roots of every layer that restricts paths. */
export function checkPathArguments(scope: EffectiveScope, args: Record<string, unknown>): { allowed: true } | { allowed: false; reason: string } {
  const candidates: string[] = [];
  for (const k of Object.keys(args).filter(isPathKey)) {
    const v = args[k];
    for (const s of Array.isArray(v) ? v : [v]) {
      if (typeof s !== 'string' || !s.trim()) continue;
      const value = s.trim();
      // A bare name is a path too when it names something in the folder: "link" may be a junction that leads out of it.
      const namesAnEntry = Boolean(scope.conversationRoot) && !/[\r\n]/.test(value) && fs.existsSync(path.resolve(scope.conversationRoot as string, value));
      if (looksLikePath(value) || namesAnEntry) candidates.push(value);
    }
  }
  if (candidates.length === 0) return { allowed: true };
  for (const raw of candidates) {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : scope.conversationRoot ? path.resolve(scope.conversationRoot, raw) : null;
    for (const l of scope.layers) {
      if (l.roots === null) continue;
      if (l.roots.length === 0) return { allowed: false, reason: `${l.source} has no filesystem access` };
      if (!abs || !l.roots.some((r) => inside(abs, r))) return { allowed: false, reason: `${raw} is outside the folders allowed by ${l.source}` };
    }
  }
  return { allowed: true };
}

/** Memory scopes the run may read (or write), intersected across layers. */
export function allowedMemoryScopes(scope: EffectiveScope, access: MemoryAccess): string[] | null {
  let allowed: string[] | null = null;
  for (const l of scope.layers) {
    if (!l.memory) continue;
    const here: string[] = l.memory.filter((m) => access === 'read' || m.access === 'read_write').map((m) => m.scope);
    allowed = allowed === null ? here : allowed.filter((s) => here.includes(s));
  }
  return allowed;
}

/**
 * Internet access of a run, intersected across layers. Default deny: a scope in which no layer authorizes
 * egress has none. `approval` anywhere means every network use still needs the user's OK; domain lists
 * intersect (a child can never reach a domain its parent could not).
 */
export interface EgressVerdict { mode: 'none' | 'any' | 'domains'; domains: string[]; approval: boolean }

export function egressOf(scope: EffectiveScope): EgressVerdict {
  let mode: EgressVerdict['mode'] | null = null;
  let domains: string[] = [];
  let approval = false;
  for (const l of scope.layers) {
    const e = l.egress;
    if (e === null) continue;
    if (e === 'none') return { mode: 'none', domains: [], approval: false };
    if (e === 'approval') { approval = true; if (mode === null) mode = 'any'; continue; }
    const listed = e.domains.map((d) => d.toLowerCase());
    if (mode === 'domains') domains = domains.filter((d) => listed.includes(d));
    else { mode = 'domains'; domains = listed; }
  }
  if (mode === null || (mode === 'domains' && domains.length === 0)) return { mode: 'none', domains: [], approval: false };
  return { mode, domains, approval };
}

/** Legacy shape for the Team UI. */
export function effectiveEgress(scope: EffectiveScope): Egress {
  const v = egressOf(scope);
  if (v.mode === 'none') return 'none';
  if (v.mode === 'domains') return { domains: v.domains };
  return 'approval';
}

/** Tools that reach the internet. A URL argument pointing at this machine is not egress. */
const NETWORK_TOOLS = ['web_research', 'governed_research', 'browser_*', 'inspect_page', 'scout_*', 'gmail_*', 'calendar_*', 'advance_wish', 'weather_*', 'get_weather', 'send_to_phone', 'ollama_pull_model'];
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|[\w-]+\.localhost)$/i;

function urlHosts(args: Record<string, unknown>): string[] {
  const hosts: string[] = [];
  for (const k of ['url', 'href', 'link', 'site', 'address']) {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    try { hosts.push(new URL(/^[a-z]+:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`).hostname.toLowerCase()); } catch { hosts.push(v.trim().toLowerCase()); }
  }
  return hosts;
}

export function isNetworkTool(toolName: string): boolean { return matches(NETWORK_TOOLS, toolName); }

/**
 * True when the user's OK for this run's internet use is already recorded: a grant layer names an approval that
 * Core holds as approved. A grant that merely claims approval without a real approved record counts for nothing.
 */
export function egressPreapproved(db: CoreDatabase, scope: EffectiveScope): boolean {
  for (const l of scope.layers) {
    if (!l.egressApprovalId) continue;
    const row = db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [l.egressApprovalId]);
    if (row?.status === 'approved') return true;
  }
  return false;
}

/**
 * Core's egress gate for one tool call. `needsApproval` means the call is authorized only with the user's
 * recorded OK for this run (the caller asks, or uses an approval already recorded for the run).
 */
export function checkEgress(scope: EffectiveScope, toolName: string, args: Record<string, unknown>): { allowed: true; needsApproval: boolean; network: boolean } | { allowed: false; reason: string } {
  if (!isNetworkTool(toolName)) return { allowed: true, needsApproval: false, network: false };
  const hosts = urlHosts(args);
  // A page on this machine (a local preview) is not internet access.
  if (hosts.length > 0 && hosts.every((h) => LOCAL_HOST.test(h)) && (toolName.startsWith('browser_') || toolName === 'inspect_page')) return { allowed: true, needsApproval: false, network: false };
  const v = egressOf(scope);
  const who = scope.agentId;
  if (v.mode === 'none') return { allowed: false, reason: `the ${who} agent has no internet access in this task${scope.depth > 0 ? ' (its delegation does not authorize any)' : ''}` };
  if (v.mode === 'domains') {
    if (hosts.length === 0) return { allowed: false, reason: `the ${who} agent may only reach ${v.domains.join(', ')}; ${toolName} does not name one of them` };
    const outside = hosts.filter((h) => !v.domains.some((d) => h === d || h.endsWith(`.${d}`)));
    if (outside.length) return { allowed: false, reason: `the ${who} agent may only reach ${v.domains.join(', ')}, not ${outside.join(', ')}` };
  }
  return { allowed: true, needsApproval: v.approval, network: true };
}

/**
 * The layer an ordinary Pandesh turn delegates from. The Chief itself runs with its own (read-mostly) tools, but
 * what it may hand to a specialist is bounded by what the user's turn authorizes: the conversation's folder only,
 * and internet only with the user's OK. Each specialist's own definition still applies on top.
 */
export function chiefDelegationLayer(conversationRoot: string | null): ScopeLayer {
  return { source: 'chief-delegation', tools: null, deny: [], roots: conversationRoot ? [path.resolve(conversationRoot)] : [], memory: null, egress: 'approval', localOnly: true };
}

export function chiefDelegationScope(conversationRoot: string | null): EffectiveScope {
  return { agentId: 'chief', agentVersion: 1, depth: 0, layers: [chiefDelegationLayer(conversationRoot)], conversationRoot: conversationRoot ? path.resolve(conversationRoot) : null };
}

// ---------- persistence ----------

export function listAgentDefinitions(db: CoreDatabase): AgentDefinition[] {
  const rows = db.all<{ id: string; kind: string; version: number; definition: string }>('SELECT id, kind, version, definition FROM agent_definitions');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: AgentDefinition[] = BUILTIN_AGENTS.map((b) => {
    const r = byId.get(b.id);
    if (!r) return b;
    const o = JSON.parse(r.definition) as Partial<AgentDefinition>;
    // Overrides of a built-in may only tighten or toggle: enabled, model policy, extra denials, extra always-ask.
    return { ...b, version: r.version, enabled: b.availability === 'available' ? o.enabled ?? b.enabled : false, modelPolicy: o.modelPolicy ?? b.modelPolicy, toolDenylist: [...new Set([...b.toolDenylist, ...(o.toolDenylist ?? [])])], alwaysAsk: [...new Set([...b.alwaysAsk, ...(o.alwaysAsk ?? [])])] };
  });
  for (const r of rows) if (r.kind === 'custom') out.push({ ...(JSON.parse(r.definition) as AgentDefinition), version: r.version, kind: 'custom' });
  return out;
}

export function getAgentDefinition(db: CoreDatabase, id: string): AgentDefinition {
  const d = listAgentDefinitions(db).find((a) => a.id === id);
  if (!d) throw new CoreError('not_found', `agent '${id}' does not exist`);
  return d;
}

/** Tighten-only override of a built-in (or full replace of a custom agent). Every change bumps the version. */
export function updateAgentDefinition(db: CoreDatabase, id: string, patch: Partial<Pick<AgentDefinition, 'enabled' | 'modelPolicy' | 'toolDenylist' | 'alwaysAsk'>>): AgentDefinition {
  const current = getAgentDefinition(db, id);
  if (current.availability !== 'available' && patch.enabled) throw new CoreError('invalid_request', `${current.name} arrives in Phase 3 and cannot be enabled yet`);
  const row = db.get<{ version: number; definition: string }>('SELECT version, definition FROM agent_definitions WHERE id = ?', [id]);
  const prev = row ? JSON.parse(row.definition) as Partial<AgentDefinition> : {};
  const next = { ...prev, ...patch };
  const version = (row?.version ?? current.version) + 1;
  const now = nowIso();
  db.run(`INSERT INTO agent_definitions (id, kind, version, definition, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET version = excluded.version, definition = excluded.definition, updatedAt = excluded.updatedAt`,
  [id, current.kind === 'custom' ? 'custom' : 'override', version, JSON.stringify(current.kind === 'custom' ? { ...current, ...patch } : next), now, now]);
  return getAgentDefinition(db, id);
}

export interface AgentRunRecord { requestId: string; agentId: string; agentVersion: number; scope: EffectiveScope; handoffId: string | null; createdAt: string }

/** Freezes the agent and its effective scope onto a request. Called inside the submission transaction. */
export function assignAgentRun(db: CoreDatabase, input: { requestId: string; agentId: string; conversationRoot: string | null; parent?: EffectiveScope | null; grant?: Grant | null; handoffId?: string | null }): AgentRunRecord {
  const d = getAgentDefinition(db, input.agentId);
  if (!d.enabled) throw new CoreError('invalid_request', `${d.name} is ${d.availability === 'phase3' ? 'not available until Phase 3' : 'turned off'}`);
  const scope = deriveScope(d, input.conversationRoot, input.parent ?? null, input.grant ?? null);
  const now = nowIso();
  db.run('INSERT INTO agent_runs (requestId, agentId, agentVersion, scope, handoffId, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [input.requestId, d.id, d.version, JSON.stringify(scope), input.handoffId ?? null, now]);
  return { requestId: input.requestId, agentId: d.id, agentVersion: d.version, scope, handoffId: input.handoffId ?? null, createdAt: now };
}

/** The agent scope governing an attempt, or null for an ordinary (non-agent) request. */
export function agentScopeForAttempt(db: CoreDatabase, attemptId: string | null | undefined): EffectiveScope | null {
  if (!attemptId) return null;
  const row = db.get<{ scope: string }>('SELECT r.scope FROM agent_runs r JOIN attempts a ON a.requestId = r.requestId WHERE a.id = ?', [attemptId]);
  return row ? JSON.parse(row.scope) as EffectiveScope : null;
}

export function recordScopeRefusal(db: CoreDatabase, attemptId: string, agentId: string, toolName: string, reason: string): void {
  try { db.run('INSERT INTO agent_scope_refusals (id, attemptId, agentId, toolName, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)', [newId('asr'), attemptId, agentId, toolName, reason.slice(0, 400), nowIso()]); } catch { /* audit is best effort; the refusal itself already happened */ }
}

// ---------- delegation ----------

const UNTRUSTED_TOOLS = ['web_research', 'governed_research', 'browser_read', 'inspect_page', 'gmail_search', 'gmail_read_thread', 'gmail_read_attachment', 'document_read', 'document_ocr', 'read_file', 'read_file_outside_workspace'];

/** A brief must be the parent's own restatement: refuse one that copies 120+ characters of untrusted tool output from the parent turn. */
export function briefCopiesUntrustedContent(db: CoreDatabase, parentAttemptId: string, brief: string): boolean {
  const text = brief.replace(/\s+/g, ' ').trim();
  if (text.length < 120) return false;
  const rows = db.all<{ evidence: string }>(`SELECT evidence FROM tool_invocations WHERE attemptId = ? AND toolName IN (${UNTRUSTED_TOOLS.map(() => '?').join(',')})`, [parentAttemptId, ...UNTRUSTED_TOOLS]);
  const corpus = rows.map((r) => r.evidence.replace(/\\n/g, ' ').replace(/\s+/g, ' ')).join(' ');
  if (!corpus) return false;
  for (let i = 0; i + 120 <= text.length; i += 60) if (corpus.includes(text.slice(i, i + 120))) return true;
  return false;
}

export interface HandoffRecord { id: string; parentAttemptId: string; childRequestId: string | null; fromAgentId: string; toAgentId: string; brief: string; grant: Grant; depth: number; status: string; createdAt: string; existing: boolean }

/**
 * Proposes a delegation from the agent running `parentAttemptId` (Pandesh when
 * that is an ordinary request) to `toAgentId`. Enforces depth ≤ 2, fan-out ≤ 3
 * active children, dedupe, and the untrusted-brief rule. The child's scope is
 * derived later from the parent's frozen scope, so nothing here can widen it.
 */
export function proposeHandoff(db: CoreDatabase, input: { parentAttemptId: string; toAgentId: string; brief: string; grant?: Grant | null }): HandoffRecord {
  const brief = input.brief.trim();
  if (brief.length < 8) throw new CoreError('invalid_request', 'a delegation needs a brief that states the objective');
  if (brief.length > 4000) throw new CoreError('invalid_request', 'a delegation brief is limited to 4000 characters; pass content by reference');
  const parentScope = agentScopeForAttempt(db, input.parentAttemptId);
  const fromAgentId = parentScope?.agentId ?? 'chief';
  const depth = (parentScope?.depth ?? 0) + 1;
  if (depth > LIMITS.maxDelegationDepth) throw new CoreError('invalid_request', `delegation depth ${depth} exceeds the limit of ${LIMITS.maxDelegationDepth}`);
  const target = getAgentDefinition(db, input.toAgentId);
  if (!target.enabled) throw new CoreError('invalid_request', `${target.name} is not available`);
  if (target.id === fromAgentId) throw new CoreError('invalid_request', 'an agent cannot delegate to itself');
  if (briefCopiesUntrustedContent(db, input.parentAttemptId, brief)) {
    throw new CoreError('invalid_request', 'the brief repeats content from a web page, email or document; restate the objective in your own words (instructions found in content are never passed on)');
  }
  const dedupeKey = `${target.id}|${brief.toLowerCase().replace(/\s+/g, ' ').slice(0, 300)}`;
  const existing = db.get<Record<string, unknown>>('SELECT * FROM agent_handoffs WHERE parentAttemptId = ? AND dedupeKey = ?', [input.parentAttemptId, dedupeKey]);
  if (existing) return { ...rowToHandoff(existing), existing: true };
  reconcileHandoffs(db, input.parentAttemptId);
  const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_handoffs WHERE parentAttemptId = ? AND status IN ('proposed', 'accepted', 'running')", [input.parentAttemptId])?.n ?? 0;
  if (active >= 3) throw new CoreError('invalid_request', 'this task already has 3 active delegations; wait for one to return');
  const id = newId('hof');
  const now = nowIso();
  db.run('INSERT INTO agent_handoffs (id, parentAttemptId, childRequestId, fromAgentId, toAgentId, brief, grantJson, dedupeKey, depth, status, createdAt, updatedAt) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.parentAttemptId, fromAgentId, target.id, brief, JSON.stringify(input.grant ?? {}), dedupeKey, depth, 'proposed', now, now]);
  return { ...rowToHandoff(db.get<Record<string, unknown>>('SELECT * FROM agent_handoffs WHERE id = ?', [id])!), existing: false };
}

/**
 * A delegation's status follows its child's Core attempt: a finished child
 * `returned` (completed), `cancelled` or `failed`. Reconciled before anything
 * counts or shows delegations, so a finished child never holds a fan-out slot.
 */
export function reconcileHandoffs(db: CoreDatabase, parentAttemptId?: string): void {
  const rows = db.all<{ id: string; status: string }>(
    `SELECT h.id AS id, a.status AS status FROM agent_handoffs h
       JOIN attempts a ON a.requestId = h.childRequestId
      WHERE h.status IN ('accepted', 'running') ${parentAttemptId ? 'AND h.parentAttemptId = ?' : ''}
        AND a.status IN ('completed', 'failed', 'cancelled')
        AND a.createdAt = (SELECT MAX(a2.createdAt) FROM attempts a2 WHERE a2.requestId = h.childRequestId)`,
    parentAttemptId ? [parentAttemptId] : []);
  for (const r of rows) markHandoff(db, r.id, { status: r.status === 'completed' ? 'returned' : r.status });
}

export function markHandoff(db: CoreDatabase, id: string, patch: { status: string; childRequestId?: string }): void {
  db.run('UPDATE agent_handoffs SET status = ?, childRequestId = COALESCE(?, childRequestId), updatedAt = ? WHERE id = ?', [patch.status, patch.childRequestId ?? null, nowIso(), id]);
}

export function getHandoff(db: CoreDatabase, id: string): HandoffRecord {
  reconcileHandoffs(db);
  const row = db.get<Record<string, unknown>>('SELECT * FROM agent_handoffs WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `delegation '${id}' does not exist`);
  return { ...rowToHandoff(row), existing: true };
}

function rowToHandoff(r: Record<string, unknown>): Omit<HandoffRecord, 'existing'> {
  return { id: String(r.id), parentAttemptId: String(r.parentAttemptId), childRequestId: (r.childRequestId as string) ?? null, fromAgentId: String(r.fromAgentId), toAgentId: String(r.toAgentId), brief: String(r.brief), grant: JSON.parse(String(r.grantJson ?? '{}')) as Grant, depth: Number(r.depth), status: String(r.status), createdAt: String(r.createdAt) };
}

// ---------- status projection for the Team UI ----------

export interface AgentStatus {
  agent: AgentDefinition;
  state: 'idle' | 'working' | 'needs_you' | 'off' | 'phase3';
  activeRuns: number;
  runs: number;
  completed: number;
  failed: number;
  refusals: number;
  lastRun: { attemptId: string; title: string; status: string; at: string } | null;
}

export function agentStatuses(db: CoreDatabase): AgentStatus[] {
  reconcileHandoffs(db);
  return listAgentDefinitions(db).map((agent) => {
    const rows = db.all<{ attemptId: string; status: string; message: string; createdAt: string }>(
      `SELECT a.id AS attemptId, a.status AS status, q.currentMessage AS message, a.createdAt AS createdAt
         FROM agent_runs r JOIN requests q ON q.id = r.requestId JOIN attempts a ON a.requestId = r.requestId
        WHERE r.agentId = ? ORDER BY a.createdAt DESC LIMIT 200`, [agent.id]);
    const active = rows.filter((r) => ['created', 'queued', 'running', 'validating', 'cancelling', 'waiting_for_approval'].includes(r.status));
    const needs = rows.some((r) => r.status === 'waiting_for_approval');
    const refusals = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_scope_refusals WHERE agentId = ?', [agent.id])?.n ?? 0;
    const last = rows[0];
    return {
      agent,
      state: agent.availability === 'phase3' ? 'phase3' : !agent.enabled ? 'off' : needs ? 'needs_you' : active.length ? 'working' : 'idle',
      activeRuns: active.length, runs: rows.length,
      completed: rows.filter((r) => r.status === 'completed').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      refusals,
      lastRun: last ? { attemptId: last.attemptId, title: last.message.slice(0, 120), status: last.status, at: last.createdAt } : null,
    };
  });
}

export function agentHistory(db: CoreDatabase, agentId: string, limit = 30): Array<{ attemptId: string; requestId: string; title: string; status: string; createdAt: string; conversationId: string | null; handoffId: string | null; agentVersion: number }> {
  return db.all(
    `SELECT a.id AS attemptId, r.requestId AS requestId, substr(q.currentMessage, 1, 160) AS title, a.status AS status, a.createdAt AS createdAt, q.conversationId AS conversationId, r.handoffId AS handoffId, r.agentVersion AS agentVersion
       FROM agent_runs r JOIN requests q ON q.id = r.requestId JOIN attempts a ON a.requestId = r.requestId
      WHERE r.agentId = ? ORDER BY a.createdAt DESC LIMIT ?`, [agentId, limit]);
}

export function listScopeRefusals(db: CoreDatabase, agentId: string, limit = 20): Array<{ attemptId: string; toolName: string; reason: string; createdAt: string }> {
  return db.all('SELECT attemptId, toolName, reason, createdAt FROM agent_scope_refusals WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?', [agentId, limit]);
}

const MEMORY_READ_TOOLS = new Set(['memory_recall', 'memory_export', 'memory_impact']);
const MEMORY_WRITE_TOOLS = new Set(['memory_remember', 'memory_correct', 'memory_forget', 'memory_resolve_contradiction']);

/**
 * Memory scope gate for an agent run (Core memory scope types: user, project,
 * task, repository, global): reads only in readable scope types, writes only in
 * writable ones. A recall without a scope is narrowed to the single readable
 * scope, or refused when the agent has several. Returns possibly-narrowed
 * arguments.
 */
export function checkMemoryArguments(db: CoreDatabase, scope: EffectiveScope, toolName: string, args: Record<string, unknown>): { allowed: true; args: Record<string, unknown> } | { allowed: false; reason: string } {
  if (!MEMORY_READ_TOOLS.has(toolName) && !MEMORY_WRITE_TOOLS.has(toolName)) return { allowed: true, args };
  const write = MEMORY_WRITE_TOOLS.has(toolName);
  const allowed = allowedMemoryScopes(scope, write ? 'read_write' : 'read');
  if (allowed === null) return { allowed: true, args };
  if (allowed.length === 0) return { allowed: false, reason: `${scope.agentId} has no ${write ? 'writable' : 'readable'} memory` };
  const verb = write ? 'change' : 'read';
  let scopeType = typeof args.scopeType === 'string' ? args.scopeType : null;
  if (!scopeType && typeof args.memoryId === 'string') {
    scopeType = db.get<{ scopeType: string }>('SELECT scopeType FROM memory_facts WHERE id = ?', [args.memoryId])?.scopeType ?? null;
    if (!scopeType) return { allowed: false, reason: `memory ${args.memoryId} does not exist` };
    if (!allowed.includes(scopeType)) return { allowed: false, reason: `memory ${args.memoryId} is in the ${scopeType} scope, outside what ${scope.agentId} may ${verb}` };
    return { allowed: true, args };
  }
  if (!scopeType) {
    if (allowed.length === 1) return { allowed: true, args: { ...args, scopeType: allowed[0] } };
    return { allowed: false, reason: `say which memory scope to use: ${allowed.join(', ')}` };
  }
  if (!allowed.includes(scopeType)) return { allowed: false, reason: `the ${scopeType} memory scope is outside what ${scope.agentId} may ${verb}` };
  return { allowed: true, args };
}
