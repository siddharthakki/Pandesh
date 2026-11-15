/**
 * Pure rules for the capability explorer. Installed, usable and authorized are three different facts; each row says
 * which one it is talking about, so "installed" is never read as "will work" and "usable" never as "allowed".
 */

import type { ModelFitReport } from '../../../../core/runtime/modelFit';

export type { ModelFitReport };
export interface ExplorerModelRow { name: string; installed: true; loaded: boolean; selected: boolean; vision: boolean; tools: boolean; embedding: boolean; fitsGpu: boolean | null; fit?: ModelFitReport; manualOnly: boolean; usable: boolean; note: string }
export interface ExplorerSkillRow { id: string; name: string; description: string; version: string; source: string; trust: string; usable: 'ready' | 'blocked'; needs: Array<{ need: string; status: 'met' | 'missing' | 'checked_per_chat' }>; missing: string[]; blockedBy: string | null }
export interface AgentReachRow { installed: boolean; channels: Array<{ channel: string; actions: string[] }>; usable: boolean; detail: string; authorized: string }
export interface ExplorerData {
  generatedAt: string;
  models: { serverAnswering: boolean; selected: string | null; selectedKind: string; gpu: { name: string; totalVramMb: number; freeVramMb?: number } | null; models: ExplorerModelRow[] };
  skills: ExplorerSkillRow[];
  rejectedSkills: Array<{ origin: string; reason: string }>;
  skillsFolder: string | null;
  agentReach: AgentReachRow;
}
export interface HubTool { name: string; description: string; capabilityId: string; risk: string; executor: 'governed' | 'native' }
export interface HubCapability { id: string; health: { state: string; reason?: string }; tools: string[] }
export type Mode = 'ask' | 'auto' | 'plan';

/** Selected first, then loaded, then usable chat models, then the rest; embedding models last. */
export function sortModels(rows: ExplorerModelRow[]): ExplorerModelRow[] {
  const rank = (m: ExplorerModelRow) => (m.selected ? 0 : m.loaded ? 1 : m.embedding ? 4 : m.usable ? 2 : 3);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function modelChips(m: ExplorerModelRow): Array<{ label: string; tone: 'ok' | 'muted' | 'warn' }> {
  const chips: Array<{ label: string; tone: 'ok' | 'muted' | 'warn' }> = [];
  if (m.selected) chips.push({ label: 'Selected', tone: 'ok' });
  if (m.embedding) { chips.push({ label: m.loaded ? 'Loaded now' : 'Installed, not loaded', tone: 'muted' }, { label: 'Not for chat', tone: 'warn' }); return chips; }
  // Loaded: Ollama's measured state is the readiness. Not loaded: say so, then what an estimate expects.
  if (m.loaded) chips.push(m.fit ? { label: m.fit.label, tone: m.fit.tone } : { label: 'Loaded now', tone: 'ok' });
  else {
    chips.push({ label: 'Installed, not loaded', tone: 'muted' });
    if (m.fit && m.fit.state !== 'unknown') chips.push({ label: m.fit.label, tone: m.fit.tone });
    else if (!m.usable) chips.push({ label: 'Does not fit', tone: 'warn' });
  }
  return chips;
}

export function abilityText(m: Pick<ExplorerModelRow, 'vision' | 'tools' | 'embedding'>): string {
  if (m.embedding) return 'Embeddings';
  return [m.vision ? 'Vision' : 'No vision', m.tools ? 'Tools' : 'No tools'].join(' · ');
}

export type ToolUsable = { state: 'ready' | 'degraded' | 'not_ready' | 'chat_engine'; text: string };

/** Whether the capability behind a tool is up. Native chat-engine tools have no separate health record. */
export function toolUsable(t: HubTool, caps: HubCapability[]): ToolUsable {
  if (t.executor !== 'governed') return { state: 'chat_engine', text: 'Part of the chat engine' };
  const c = caps.find((x) => x.id === t.capabilityId);
  if (!c) return { state: 'degraded', text: 'No health report' };
  if (c.health.state === 'available') return { state: 'ready', text: 'Ready' };
  return { state: 'not_ready', text: c.health.reason ? `${c.health.state.replace(/_/g, ' ')}: ${c.health.reason}` : c.health.state.replace(/_/g, ' ') };
}

/** What the conversation's permission mode means for a tool that changes things (the tool's own gate always applies). */
export function authorizationText(risk: string, mode: Mode): { text: string; tone: 'ok' | 'ask' | 'blocked' } {
  if (risk === 'read_only') return { text: 'Read only: no approval needed', tone: 'ok' };
  if (mode === 'plan') return { text: 'Changes things: blocked in Plan only', tone: 'blocked' };
  if (mode === 'auto') return { text: 'Changes things: asks, unless your Auto grant covers it', tone: 'ask' };
  return { text: 'Changes things: asks you each time', tone: 'ask' };
}

export interface ToolGroupCounts { total: number; readOnly: number; asks: number; notReady: number }
export function toolCounts(tools: HubTool[], caps: HubCapability[]): ToolGroupCounts {
  let readOnly = 0; let asks = 0; let notReady = 0;
  for (const t of tools) {
    if (t.risk === 'read_only') readOnly += 1; else asks += 1;
    if (toolUsable(t, caps).state === 'not_ready') notReady += 1;
  }
  return { total: tools.length, readOnly, asks, notReady };
}

export const TRUST_WORDS: Record<string, string> = {
  builtin: 'Built in',
  user: 'Yours (from your skills folder)',
  workspace: 'From a workspace folder',
  untrusted: 'Not approved',
};

export function needIcon(status: 'met' | 'missing' | 'checked_per_chat'): string {
  return status === 'met' ? 'Met' : status === 'missing' ? 'Missing' : 'Checked when a chat runs';
}

const GB = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const K = (n: number) => `${Math.round(n / 1024)}K`;

/** The memory facts of one model, each in its own row so capacity, estimate and availability are never merged. */
export function memoryRows(fit: ModelFitReport | undefined): Array<{ label: string; value: string; note?: string }> {
  if (!fit || (fit.state === 'unknown' && !fit.weightsBytes)) return [];
  const rows: Array<{ label: string; value: string; note?: string }> = [];
  if (fit.capacityBytes !== null) rows.push({ label: 'GPU capacity', value: GB(fit.capacityBytes), note: 'total graphics memory' });
  if (fit.budgetBytes !== null) rows.push({ label: 'Budget for one model', value: GB(fit.budgetBytes), note: 'capacity less room for the desktop' });
  if (fit.availableBytes !== null) rows.push({ label: 'Free right now', value: GB(fit.availableBytes), note: 'changes as programs open and close' });
  if (fit.measured) rows.push({ label: 'Measured (loaded)', value: `${GB(fit.measured.vramBytes)} of ${GB(fit.measured.sizeBytes)} on the GPU`, note: fit.measured.contextLength ? `at ${K(fit.measured.contextLength)} context` : 'reported by Ollama' });
  if (fit.weightsBytes !== null) rows.push({ label: 'Model weights', value: GB(fit.weightsBytes), note: 'file size' });
  for (const c of fit.atContext) rows.push({ label: `Estimate at ${K(c.ctx)} context`, value: GB(c.totalBytes), note: `weights + ${GB(c.cacheBytes)} cache + ${GB(fit.runtimeBytes)} runtime${c.ctx === fit.agentCtx ? " · Pandesh's context" : ''}${c.fitsBudget ? '' : ' · over budget'}` });
  return rows;
}

export interface ExplorerSummary {
  models: { installed: number; usable: number; selected: string | null };
  tools: { total: number; ready: number; asks: number; notReady: number };
  skills: { total: number; blocked: number };
}
export function explorerSummary(data: ExplorerData, hub: { tools: HubTool[]; capabilities: HubCapability[] } | null): ExplorerSummary {
  const chat = data.models.models.filter((m) => !m.embedding);
  const states = hub ? hub.tools.map((t) => toolUsable(t, hub.capabilities).state) : [];
  return {
    models: { installed: data.models.models.length, usable: chat.filter((m) => m.usable).length, selected: data.models.selected },
    tools: { total: states.length, ready: states.filter((s) => s === 'ready' || s === 'chat_engine').length, asks: hub ? hub.tools.filter((t) => t.risk !== 'read_only').length : 0, notReady: states.filter((s) => s === 'not_ready').length },
    skills: { total: data.skills.length, blocked: data.skills.filter((s) => s.usable === 'blocked').length },
  };
}

/** Functional category of a tool, from its capability and name. Order matters: the first match wins. */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/network_drive/, 'This PC and models'],
  [/delegate|hermes|calculate|navigate_to|request_tools|resolve_time|declare_execution/, 'Assistant helpers'],
  [/whatsapp|household|jugaad|send_to_phone|phone/, 'Messaging and household'],
  [/revenue|scout|intelligence/, 'Business and monitoring'],
  [/commitment|project/, 'Tasks, reminders and workflows'],
  [/port[-_]|pc[-_]organi|computer-use|desktop_|find_installed_app|listening_ports/, 'This PC and models'],
  [/gmail|google|calendar|drive|email|mail/, 'Email and calendar'],
  [/remind|schedule|routine|mission|task|workflow|plan_|wish|briefing/, 'Tasks, reminders and workflows'],
  [/terminal|shell|git|forge|run_checks|dev_|code|build_|script/, 'Code and terminal'],
  [/browser|web|research|search|weather|fetch|agent_reach|url/, 'Web and research'],
  [/image|video|workshop|design|studio|voice|speech|audio|print|media/, 'Media and creation'],
  [/memory|remember|brain|note|recall|fact|knowledge/, 'Memory and notes'],
  [/workspace|document|file|folder|pdf|read_|write_|list_dir|ocr/, 'Files and documents'],
  [/ollama|system|process|hardware|capability|model|inventory|health|software/, 'This PC and models'],
];
export function toolCategory(t: Pick<HubTool, 'name' | 'capabilityId'> & { group?: string }): string {
  const hay = `${t.capabilityId} ${t.group ?? ''} ${t.name}`.toLowerCase();
  for (const [re, label] of CATEGORY_RULES) if (re.test(hay)) return label;
  return 'Other';
}
export interface ToolGroup { category: string; tools: HubTool[]; asks: number; notReady: number }
export function groupTools(tools: HubTool[], caps: HubCapability[]): ToolGroup[] {
  const map = new Map<string, HubTool[]>();
  for (const t of tools) { const c = toolCategory(t); map.set(c, [...(map.get(c) ?? []), t]); }
  return [...map.entries()].map(([category, list]) => ({ category, tools: list, asks: list.filter((t) => t.risk !== 'read_only').length, notReady: list.filter((t) => toolUsable(t, caps).state === 'not_ready').length }))
    .sort((a, b) => (a.category === 'Other' ? 1 : b.category === 'Other' ? -1 : a.category.localeCompare(b.category)));
}

/**
 * A button on a tool row, only where the app already has a place to fix it: Google's tools open Connections. Nothing
 * here grants, installs or approves anything; the page it opens does the work and Core enforces it.
 */
export function connectAction(t: HubTool, caps: HubCapability[]): { label: string; view: 'connections' } | null {
  if (toolUsable(t, caps).state !== 'not_ready') return null;
  return /gmail|google|calendar|drive/i.test(`${t.capabilityId} ${t.name}`) ? { label: 'Connect Google', view: 'connections' } : null;
}

export interface ActiveGrant { id: string; categories: string[]; expiresAt: string; workspaceRoot: string | null }
/** Grants still running now (an expired one is no authorization). */
export function activeGrants(auths: ActiveGrant[] | undefined, now = Date.now()): ActiveGrant[] {
  return (auths ?? []).filter((a) => Date.parse(a.expiresAt) > now);
}
/**
 * Whether a tool "requires approval" or is "already authorized". Pandesh keeps grants by category, not by tool, so a
 * tool is never marked authorized from here: in Auto with a live grant the row says a grant may cover it, and the
 * gate decides at the moment of use.
 */
export function approvalState(risk: string, mode: Mode, grants: ActiveGrant[]): { text: string; tone: 'ok' | 'ask' | 'blocked'; kind: 'none_needed' | 'asks' | 'may_be_covered' | 'blocked' } {
  if (risk === 'read_only') return { text: 'No approval needed (read only)', tone: 'ok', kind: 'none_needed' };
  if (mode === 'plan') return { text: 'Blocked in Plan only', tone: 'blocked', kind: 'blocked' };
  if (mode === 'auto' && grants.length > 0) return { text: 'Asks, unless an active Auto grant covers it', tone: 'ask', kind: 'may_be_covered' };
  return { text: 'Requires approval each time', tone: 'ask', kind: 'asks' };
}
