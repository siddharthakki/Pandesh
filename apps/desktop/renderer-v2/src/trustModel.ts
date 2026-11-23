/**
 * Trust Map: what can act for the owner, and how far, read only from the records Core and the host enforce:
 * the chat permission mode and its Auto grants, the workspace folder and its access, the authorized-project registry,
 * paired clients, phone access, each specialist's internet rule, connector grants, the selected model provider and
 * standing routine write grants. Nothing here grants or widens anything; changes happen on the screen each area names.
 * Pure, so the rules are tested without a window.
 */
import type { AgentStatus } from './agentsModel';

/** free = acts without asking you (within the limits shown) · asks = asks you each time · never = cannot. */
export type TrustLevel = 'free' | 'asks' | 'never';
export interface TrustFact { text: string; level: TrustLevel }
export interface TrustArea {
  id: string; name: string; level: TrustLevel; summary: string; facts: TrustFact[];
  /** The screen where the owner changes it. */
  where: { view: string; label: string } | null;
  /** False when the source did not answer: the area says so instead of guessing. */
  known: boolean;
}

export interface TrustInputs {
  permission: { mode: 'ask' | 'auto' | 'plan'; authorizations: Array<{ categories: string[]; workspaceRoot: string | null; expiresAt: string }>; categories: Record<string, string> } | null;
  workspace: { folder: string; access: 'read' | 'read_write' } | null;
  projects: Array<{ name: string; access: 'read' | 'read-write'; paths: string[]; preferredAgents: string[] }> | null;
  pairings: Array<{ label: string; revokedAt: string | null; lastSeenAt: string | null }> | null;
  phone: { access: 'off' | 'lan' | 'tailscale'; pairedCount: number; devices: Array<{ name: string }> } | null;
  agents: AgentStatus[] | null;
  connectors: Array<{ id: string; label: string; state: string; permissions: { read: boolean; draft: boolean; execute: boolean } }> | null;
  provider: 'ollama' | 'openrouter' | 'cloud' | null;
  routines: Array<{ title: string; folder: string | null; status: string; active: { frozen?: { limits?: { maxFiles?: number } } } | null }> | null;
  now: number;
}

const RANK: Record<TrustLevel, number> = { never: 0, asks: 1, free: 2 };
/** An area is as open as its most open real fact. */
const widest = (facts: TrustFact[], fallback: TrustLevel = 'never'): TrustLevel => facts.reduce<TrustLevel>((w, f) => (RANK[f.level] > RANK[w] ? f.level : w), fallback);
const until = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const unknown = (id: string, name: string, where: TrustArea['where'], what: string): TrustArea => ({ id, name, level: 'never', summary: `${what} did not answer, so this is not shown.`, facts: [], where, known: false });

export function buildTrust(i: TrustInputs): TrustArea[] {
  const areas: TrustArea[] = [];

  // Chat: the permission mode Core stores per conversation, plus Auto grants still running.
  if (i.permission) {
    const live = i.permission.authorizations.filter((a) => Date.parse(a.expiresAt) > i.now);
    const facts: TrustFact[] = [{ text: 'Reads and answers in chat without asking', level: 'free' }];
    if (i.permission.mode === 'plan') facts.push({ text: 'Plan only: nothing that changes anything can run in this chat', level: 'never' });
    else facts.push({ text: 'Anything that changes something asks you first', level: 'asks' });
    for (const a of live) facts.push({ text: `Auto until ${until(a.expiresAt)}: ${a.categories.map((c) => i.permission!.categories[c] ?? c).join('; ')}${a.workspaceRoot ? ` (in ${a.workspaceRoot})` : ''}`, level: 'free' });
    const mode = i.permission.mode === 'plan' ? 'Plan only' : i.permission.mode === 'auto' ? 'Auto' : 'Ask';
    areas.push({
      id: 'chat', name: 'Chat', level: live.length ? 'free' : i.permission.mode === 'plan' ? 'never' : 'asks', facts, known: true,
      summary: live.length ? `${mode} mode · ${live.length} Auto grant${live.length === 1 ? '' : 's'} running` : `${mode} mode · every change asks`,
      where: { view: 'permissions', label: 'Change in Settings › Permissions' },
    });
  } else areas.push(unknown('chat', 'Chat', { view: 'permissions', label: 'Open Settings › Permissions' }, 'The chat permission'));

  // Workspace folder (host-enforced read-only or read-write).
  {
    const w = i.workspace;
    const facts: TrustFact[] = !w ? [{ text: 'No folder is open: Pandesh reads no files outside a chat attachment', level: 'never' }]
      : w.access === 'read' ? [{ text: `Reads ${w.folder}`, level: 'free' }, { text: 'Cannot write there: read-only, enforced by Core', level: 'never' }]
      : [{ text: `Reads ${w.folder}`, level: 'free' }, { text: 'Each write or command there asks you first', level: 'asks' }];
    areas.push({ id: 'workspace', name: 'Workspace', level: !w ? 'never' : w.access === 'read' ? 'never' : 'asks', facts, known: true, summary: !w ? 'No folder open' : `${w.access === 'read' ? 'Read only' : 'Read and write, asks'} · ${w.folder}`, where: { view: 'chat', label: 'Choose the folder in Chat' } });
  }

  // Authorized projects: what coding engines may do. Read-write work happens in an isolated copy and reaches the checkout only with your approval.
  if (i.projects) {
    const facts: TrustFact[] = i.projects.map((p) => ({ text: p.access === 'read-write' ? `${p.name}: engines edit an isolated copy; your checkout changes only after you approve` : `${p.name}: read-only work only`, level: p.access === 'read-write' ? 'asks' : 'never' }));
    if (!facts.length) facts.push({ text: 'No project is registered: no coding engine can work on your code', level: 'never' });
    const rw = i.projects.filter((p) => p.access === 'read-write').length;
    areas.push({ id: 'projects', name: 'Projects', level: widest(facts), facts, known: true, summary: `${i.projects.length} registered · ${rw} read-write · ${i.projects.length - rw} read-only`, where: null });
  } else areas.push(unknown('projects', 'Projects', null, 'The project registry'));

  // Paired clients (browser extension, ChatGPT): they can send tasks; dispatching one to an engine asks you.
  if (i.pairings) {
    const active = i.pairings.filter((p) => !p.revokedAt);
    const facts: TrustFact[] = active.map((p) => ({ text: `${p.label} can send tasks; each one waits for your OK before an engine runs it`, level: 'asks' as TrustLevel }));
    if (!facts.length) facts.push({ text: 'No browser or ChatGPT client is paired', level: 'never' });
    areas.push({ id: 'clients', name: 'Paired clients', level: widest(facts), facts, known: true, summary: active.length ? `${active.length} paired · tasks wait for you` : 'None paired', where: { view: 'connections', label: 'Pair or revoke in Connections' } });
  } else areas.push(unknown('clients', 'Paired clients', { view: 'connections', label: 'Open Connections' }, 'The pairing list'));

  // Phone.
  if (i.phone) {
    const off = i.phone.access === 'off';
    const facts: TrustFact[] = off ? [{ text: 'Phone access is off: no phone can reach Pandesh', level: 'never' }]
      : [{ text: `${i.phone.access === 'tailscale' ? 'Tailscale only' : 'Home Wi-Fi and Tailscale'}; ${i.phone.pairedCount} phone${i.phone.pairedCount === 1 ? '' : 's'} paired${i.phone.devices.length ? `: ${i.phone.devices.map((d) => d.name).join(', ')}` : ''}`, level: 'asks' },
        { text: 'A paired phone chats and approves as you; actions still pass the same approval gates', level: 'asks' }];
    areas.push({ id: 'phone', name: 'Phone', level: off ? 'never' : 'asks', facts, known: true, summary: off ? 'Off' : `${i.phone.pairedCount} paired · ${i.phone.access === 'tailscale' ? 'Tailscale only' : 'Wi-Fi + Tailscale'}`, where: { view: 'connections', label: 'Change in Connections' } });
  } else areas.push(unknown('phone', 'Phone', { view: 'connections', label: 'Open Connections' }, 'Phone access'));

  // Specialists' internet and their own always-ask lists.
  if (i.agents) {
    const facts: TrustFact[] = i.agents.filter((a) => a.agent.enabled).map((a) => {
      const e = a.agent.egress;
      const ask = a.agent.alwaysAsk.length ? `; always asks before ${a.agent.alwaysAsk.join(', ').replace(/_/g, ' ')}` : '';
      if (typeof e === 'object') return { text: `${a.agent.name}: reaches ${e.domains.join(', ')} without asking${ask}`, level: 'free' as TrustLevel };
      if (e === 'approval') return { text: `${a.agent.name}: internet only with your approval${ask}`, level: 'asks' as TrustLevel };
      return { text: `${a.agent.name}: no internet${ask}`, level: 'never' as TrustLevel };
    });
    const open = facts.filter((f) => f.level !== 'never').length;
    areas.push({ id: 'internet', name: 'Specialists online', level: widest(facts), facts, known: true, summary: `${open} of ${facts.length} may go online · the rest never`, where: { view: 'team', label: 'Tighten in Team' } });
  } else areas.push(unknown('internet', 'Specialists online', { view: 'team', label: 'Open Team' }, 'The agent registry'));

  // Connected accounts.
  if (i.connectors) {
    const facts: TrustFact[] = i.connectors.map((c) => {
      const p = c.permissions;
      if (!p.read && !p.draft && !p.execute) return { text: `${c.label}: not connected`, level: 'never' as TrustLevel };
      const parts = [p.read && 'reads', p.draft && 'drafts', p.execute && 'can send or change, each time with your OK'].filter(Boolean).join(', ');
      return { text: `${c.label}: ${parts}`, level: (p.draft || p.execute ? 'asks' : 'free') as TrustLevel };
    });
    const on = i.connectors.filter((c) => c.permissions.read || c.permissions.draft || c.permissions.execute).length;
    areas.push({ id: 'accounts', name: 'Accounts', level: widest(facts), facts, known: true, summary: on ? `${on} connected · sends ask you` : 'Nothing connected', where: { view: 'connections', label: 'Connect or disconnect in Connections' } });
  } else areas.push(unknown('accounts', 'Accounts', { view: 'connections', label: 'Open Connections' }, 'The connector list'));

  // Where chat text is processed.
  {
    const cloud = i.provider !== null && i.provider !== 'ollama';
    const facts: TrustFact[] = cloud ? [{ text: 'This chat runs on a cloud model you chose: its messages leave this PC', level: 'free' }, { text: 'Files, mail and memory are never sent with it', level: 'never' }]
      : [{ text: 'Chat runs on local models: nothing leaves this PC', level: 'never' }, { text: 'A cloud model is used only after you choose it', level: 'asks' }];
    areas.push({ id: 'cloud', name: 'Cloud models', level: cloud ? 'free' : 'never', facts, known: i.provider !== null, summary: cloud ? 'A cloud model is selected for chat' : 'Local only', where: { view: 'models', label: 'Change in Settings › Models' } });
  }

  // Standing routine write grants (the only standing write permission).
  if (i.routines) {
    const facts: TrustFact[] = i.routines.map((r) => r.status === 'active'
      ? { text: `${r.title}: writes in ${r.folder} without asking, up to ${r.active?.frozen?.limits?.maxFiles ?? '?'} files a run`, level: 'free' as TrustLevel }
      : { text: `${r.title}: ${r.status === 'stale' ? 'grant no longer matches the routine, so it is not used' : 'no standing write; asks each time'}`, level: 'asks' as TrustLevel });
    if (!facts.length) facts.push({ text: 'No routine works in a folder', level: 'never' });
    const active = i.routines.filter((r) => r.status === 'active').length;
    areas.push({ id: 'routines', name: 'Routines', level: widest(facts), facts, known: true, summary: active ? `${active} standing write grant${active === 1 ? '' : 's'}` : 'No standing write', where: { view: 'automations', label: 'Grant or revoke in Automations' } });
  } else areas.push(unknown('routines', 'Routines', { view: 'automations', label: 'Open Automations' }, 'Routine grants'));

  return areas;
}
