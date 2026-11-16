/**
 * What the mission card shows, derived from Core's mission record (core/api/missionRoutes.ts → MissionView). Pure, so
 * it is tested without a window.
 */
export interface StepEvidence { verified: Array<{ tool: string; count: number }>; unrelated: string[]; failed: string[]; unbacked: string[]; totalCalls: number; modelCalls?: number; seconds?: number }
export interface MissionFile { path: string; bytes: number | null; kind: string; exists: boolean }
export interface StepView {
  id: string; idx: number; agentId: string; kind: 'work' | 'review'; title: string; brief: string;
  status: 'pending' | 'running' | 'succeeded' | 'unverified' | 'failed' | 'skipped' | 'cancelled';
  resultText: string | null; evidence: StepEvidence | null; artifacts: MissionFile[]; error: string | null; startedAt: string | null; completedAt: string | null;
}
export interface MissionView {
  id: string; conversationId: string; objective: string;
  status: 'running' | 'completed' | 'completed_with_issues' | 'failed' | 'cancelled' | 'interrupted';
  workspaceRoot: string | null; resultSummary: string | null; reportMessageId: string | null; cancelRequestedAt: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
  steps: StepView[]; agentNames: Record<string, string>;
  liveActivity: { tool: string; status: string; at: string } | null;
  pendingApprovals: Array<{ approvalId: string; toolName: string; text: string; agentName: string | null; requestedAt: string }>;
}

const DONE = new Set(['succeeded', 'unverified']);

export function missionProgress(m: MissionView): { done: number; total: number; percent: number } {
  const done = m.steps.filter((s) => DONE.has(s.status)).length;
  const total = m.steps.length || 1;
  const running = m.steps.some((s) => s.status === 'running') ? 0.5 : 0;
  return { done, total: m.steps.length, percent: Math.min(100, Math.round(((done + running) / total) * 100)) };
}

/** The card's first words: the phase the mission is in, never a guess about its content. */
export function missionHeadline(m: MissionView): string {
  if (m.status === 'running') {
    if (m.pendingApprovals.length) return 'Mission · waiting for your OK';
    if (m.cancelRequestedAt) return 'Mission · stopping';
    const s = m.steps.find((x) => x.status === 'running');
    if (!s) return 'Mission · starting';
    return `Mission · ${s.kind === 'review' ? 'reviewing' : 'working'} · ${m.agentNames[s.agentId] ?? s.agentId}`;
  }
  if (m.status === 'completed') return 'Mission complete · checked';
  if (m.status === 'completed_with_issues') return 'Mission finished · points to check';
  if (m.status === 'cancelled') return 'Mission cancelled';
  if (m.status === 'interrupted') return 'Mission interrupted';
  return 'Mission stopped';
}

const TOOL_WORDS: Record<string, string> = {
  media_produce_video: 'producing the video', media_inspect: 'inspecting the media file', run_system_diagnostics: 'running system diagnostics',
  system_hardware_telemetry: 'reading hardware telemetry', read_file: 'reading a file', list_directory: 'listing a folder', search_files: 'searching files',
  write_file: 'writing a file', run_checks: 'running checks', web_research: 'searching the web', delegate_to_opencode: 'working with OpenCode',
  delegate_to_coding_agent: 'working with the coding engine', desktop_read_window: 'reading a window', desktop_windows_list: 'listing open windows',
};

export function toolWords(tool: string): string {
  return TOOL_WORDS[tool] ?? tool.replace(/_/g, ' ');
}

function secondsWord(n: number): string {
  return n >= 60 ? `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s` : `${n}s`;
}

export function describeStep(step: StepView, mission: MissionView, now: number): { agent: string; state: string; sub: string; mark: 'done' | 'warn' | 'fail' | 'run' | 'wait' } {
  const agent = mission.agentNames[step.agentId] ?? step.agentId;
  const tools = step.evidence?.verified.map((v) => `${v.tool}${v.count > 1 ? ` ×${v.count}` : ''}`).join(', ');
  switch (step.status) {
    case 'running': {
      const since = step.startedAt ? Math.max(0, Math.round((now - Date.parse(step.startedAt)) / 1000)) : 0;
      const waiting = mission.pendingApprovals.length > 0;
      const live = mission.liveActivity;
      const sub = waiting ? 'paused until you decide' : live ? `${live.status === 'running' || live.status === 'pending' ? 'now' : 'last'}: ${toolWords(live.tool)}` : 'thinking about the brief';
      return { agent, state: secondsWord(since), sub, mark: 'run' };
    }
    case 'succeeded':
      return { agent, state: step.evidence?.seconds ? secondsWord(step.evidence.seconds) : 'done', sub: tools ? `ran ${tools}` : 'done', mark: 'done' };
    case 'unverified':
      return { agent, state: 'not verified', sub: tools ? `ran ${tools}; part of its report is not backed by a tool call` : 'no tool call backs its report: treat it as opinion', mark: 'warn' };
    case 'failed':
      return { agent, state: 'failed', sub: step.error ?? 'did not finish', mark: 'fail' };
    case 'cancelled':
      return { agent, state: 'cancelled', sub: step.error ?? 'stopped', mark: 'warn' };
    case 'skipped':
      return { agent, state: 'not started', sub: step.error ?? 'an earlier step did not finish', mark: 'wait' };
    default:
      return { agent, state: 'waiting', sub: step.kind === 'review' ? 'checks the result independently' : 'starts when the step before it is done', mark: 'wait' };
  }
}

/**
 * Which missions belong on screen: every running one (wherever it was started), and this conversation's finished ones
 * for a while after they end, newest first, at most three.
 */
export function visibleMissions(all: MissionView[], conversationId: string | null, now: number): MissionView[] {
  const keepMs = 30 * 60_000;
  return all
    .filter((m) => m.status === 'running' || (m.conversationId === conversationId && now - Date.parse(m.completedAt ?? m.updatedAt) < keepMs))
    .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3);
}
