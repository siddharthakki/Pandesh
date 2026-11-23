/**
 * Agents: Pandesh specialists, Kandev coding engines and the review gate, from Core's own records only:
 * /v1/agents (registry + Core's state per agent), /v1/bridge/executors (what Kandev has installed and can run, GPU lanes)
 * and the same bridge activity Home and Missions read. Pure, so it is tested without a window.
 */
import type { BridgeActivityItem } from './Missions';
import { eventLine } from './jarvisModel';

export interface AgentStatus {
  agent: { id: string; name: string; role: string; enabled: boolean; availability: string; egress: string | { domains: string[] }; alwaysAsk: string[]; modelPolicy: { localOnly: boolean; models: string[] } };
  state: 'idle' | 'working' | 'needs_you' | 'off' | 'phase3'; activeRuns: number; runs: number; completed: number; failed: number; refusals: number;
  lastRun: { attemptId: string; title: string; status: string; at: string } | null;
}
export interface ExecutorInfo { id: string; label: string; kind: string; dispatchable: boolean; available: boolean; reason: string | null; external: boolean; usesLocalGpu: boolean; models: string[] }
export interface ExecutorListing { kandev: { running: boolean }; hardware: { gpu: { name: string; totalVramMb: number; freeVramMb: number } | null; gpuLanes: number }; executors: ExecutorInfo[] }

const DONE = new Set(['completed', 'failed', 'cancelled']);
/** The coding engines Pandesh drives, in the order the owner thinks of them. Others Kandev lists are shown as "not driven yet". */
export const PRIMARY_ENGINES = ['claude', 'opencode', 'hermes', 'antigravity'];

export interface EngineView {
  id: string; label: string; where: string;
  /** available | busy | waiting_gpu | not_installed | unavailable | not_driven */
  status: 'available' | 'busy' | 'waiting_gpu' | 'not_installed' | 'unavailable' | 'not_driven';
  statusText: string; reason: string | null; live: boolean;
  tasks: Array<{ id: string; title: string; stateLabel: string; eventText: string; live: boolean }>;
  primary: boolean;
}
export interface SpecialistView { id: string; name: string; role: string; state: AgentStatus['state']; stateText: string; activeRuns: number; runs: number; completed: number; failed: number; refusals: number; lastRun: AgentStatus['lastRun']; egress: string; alwaysAsk: string[]; localOnly: boolean }
export interface ReviewGate { awaitingOwner: Array<{ id: string; title: string; summary: string }>; independent: number; humanReviewed: number; workerOnly: number; failedChecks: number }
export interface GpuLane { name: string | null; lanes: number; busy: number; queued: number; freeVramMb: number | null; totalVramMb: number | null }

const STATE_TEXT: Record<AgentStatus['state'], string> = { working: 'Working', needs_you: 'Needs you', idle: 'Idle', off: 'Turned off', phase3: 'Not available yet' };

export function buildAgents(agents: AgentStatus[], listing: ExecutorListing | null, bridge: BridgeActivityItem[], now: number): {
  chief: SpecialistView | null; specialists: SpecialistView[]; reviewer: SpecialistView | null; engines: EngineView[]; gate: ReviewGate; gpu: GpuLane; kandevRunning: boolean | null;
} {
  const toView = (s: AgentStatus): SpecialistView => ({
    id: s.agent.id, name: s.agent.name, role: s.agent.role, state: s.agent.enabled ? s.state : 'off', stateText: STATE_TEXT[s.agent.enabled ? s.state : 'off'],
    activeRuns: s.activeRuns, runs: s.runs, completed: s.completed, failed: s.failed, refusals: s.refusals, lastRun: s.lastRun,
    egress: typeof s.agent.egress === 'string' ? s.agent.egress : `only ${s.agent.egress.domains.join(', ')}`, alwaysAsk: s.agent.alwaysAsk, localOnly: s.agent.modelPolicy.localOnly,
  });
  const views = agents.map(toView);
  const chief = views.find((v) => v.id === 'chief') ?? null;
  const reviewer = views.find((v) => v.id === 'reviewer') ?? null;
  const specialists = views.filter((v) => v.id !== 'chief' && v.id !== 'reviewer');

  const live = bridge.filter((b) => !DONE.has(b.state));
  const engines: EngineView[] = (listing?.executors ?? []).filter((e) => e.kind === 'acp').map((e) => {
    const mine = live.filter((b) => b.executor === e.id);
    const tasks = mine.map((b) => { const ev = eventLine(b, now); return { id: b.id, title: b.instruction, stateLabel: b.stateLabel, eventText: ev.text, live: ev.live && b.state === 'running' }; });
    const waitingGpu = mine.some((b) => b.state === 'waiting_for_model');
    let status: EngineView['status'];
    let statusText: string;
    if (!e.dispatchable) { status = 'not_driven'; statusText = 'Installed in Kandev, not driven by Pandesh yet'; }
    else if (!e.available) { status = /not.?installed/i.test(e.reason ?? '') ? 'not_installed' : 'unavailable'; statusText = status === 'not_installed' ? 'Not installed on this PC' : 'Unavailable'; }
    else if (mine.some((b) => b.state === 'running')) { status = 'busy'; statusText = `Working on ${mine.length} task${mine.length === 1 ? '' : 's'}`; }
    else if (waitingGpu) { status = 'waiting_gpu'; statusText = 'Waiting for the local GPU'; }
    else if (mine.length) { status = 'busy'; statusText = mine[0].stateLabel; }
    else { status = 'available'; statusText = 'Available · no task'; }
    return {
      id: e.id, label: e.label, where: e.usesLocalGpu ? 'Local GPU' : e.external ? 'Cloud' : 'This PC', status, statusText,
      // Only a reason that adds something beyond the status line (Kandev's raw "not_installed …" repeats it).
      reason: e.available || status === 'not_installed' || status === 'not_driven' ? null : e.reason, live: tasks.some((t) => t.live), tasks, primary: PRIMARY_ENGINES.includes(e.id),
    };
  }).sort((a, b) => (Number(b.primary) - Number(a.primary)) || (PRIMARY_ENGINES.indexOf(a.id) - PRIMARY_ENGINES.indexOf(b.id)));

  const recent = bridge.filter((b) => now - Date.parse(b.lastEventAt ?? b.createdAt) < 24 * 3600_000 && !(b.executor ?? '').startsWith('service:'));
  const gate: ReviewGate = {
    awaitingOwner: bridge.filter((b) => b.codeChange?.awaitingReview).map((b) => ({ id: b.id, title: b.instruction, summary: b.outcome?.summary ?? `${b.codeChange?.changedFiles.length ?? 0} files changed` })),
    independent: recent.filter((b) => b.state === 'completed' && b.verification === 'independent').length,
    humanReviewed: recent.filter((b) => b.state === 'completed' && b.verification === 'human-reviewed').length,
    workerOnly: recent.filter((b) => b.state === 'completed' && b.verification === 'worker-only').length,
    failedChecks: recent.filter((b) => b.state === 'failed').length,
  };

  const gpuExecs = new Set((listing?.executors ?? []).filter((e) => e.usesLocalGpu).map((e) => e.id));
  const gpu: GpuLane = {
    name: listing?.hardware.gpu?.name ?? null, lanes: listing?.hardware.gpuLanes ?? 0,
    busy: live.filter((b) => gpuExecs.has(b.executor ?? '') && b.state === 'running').length,
    queued: live.filter((b) => b.state === 'waiting_for_model').length,
    freeVramMb: listing?.hardware.gpu?.freeVramMb ?? null, totalVramMb: listing?.hardware.gpu?.totalVramMb ?? null,
  };
  return { chief, specialists, reviewer, engines, gate, gpu, kandevRunning: listing ? listing.kandev.running : null };
}
