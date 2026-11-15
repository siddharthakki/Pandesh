/**
 * Pure rules for the capability explorer. Installed, usable and authorized are three different facts; each row says
 * which one it is talking about, so "installed" is never read as "will work" and "usable" never as "allowed".
 */

export interface ExplorerModelRow { name: string; installed: true; loaded: boolean; selected: boolean; vision: boolean; tools: boolean; embedding: boolean; fitsGpu: boolean | null; manualOnly: boolean; usable: boolean; note: string }
export interface ExplorerSkillRow { id: string; name: string; description: string; version: string; source: string; trust: string; usable: 'ready' | 'blocked'; needs: Array<{ need: string; status: 'met' | 'missing' | 'checked_per_chat' }>; missing: string[]; blockedBy: string | null }
export interface AgentReachRow { installed: boolean; channels: Array<{ channel: string; actions: string[] }>; usable: boolean; detail: string; authorized: string }
export interface ExplorerData {
  generatedAt: string;
  models: { serverAnswering: boolean; selected: string | null; selectedKind: string; gpu: { name: string; totalVramMb: number } | null; models: ExplorerModelRow[] };
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
  chips.push(m.loaded ? { label: 'Loaded now', tone: 'ok' } : { label: 'Installed, not loaded', tone: 'muted' });
  if (!m.usable) chips.push({ label: m.embedding ? 'Not for chat' : 'Does not fit', tone: 'warn' });
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
