/**
 * What the phone needs from the desktop snapshot, and nothing more: no paths beyond the workspace folder's name,
 * no tool arguments, no credentials. The approval wording matches the v2 conversation (renderer-v2/src/Chat.tsx),
 * so a decision reads the same on the phone and on the PC.
 */
import * as path from 'node:path';
import type { DesktopActivityEvent, DesktopSnapshot } from '../ipc';

export type PhoneDecisionKind = 'tool' | 'image' | 'weather';

export interface PhoneDecision {
  kind: PhoneDecisionKind;
  approvalId: string;
  title: string;
  rows: Array<[string, string]>;
  detail: string;
  allowLabel: string;
}

export interface PhoneState {
  coreState: 'connected' | 'connecting' | 'offline';
  model: string;
  running: boolean;
  attemptId: string | null;
  conversationId: string | null;
  /** The step running now (newest first), for the "working" line. */
  activity: { title: string; kind: string; startedAt: string } | null;
  decision: PhoneDecision | null;
  lastTurnOutcome: 'completed' | 'failed' | 'cancelled' | null;
  blockedReason: string | null;
  /** The workspace folder's name only, never its full path. */
  workspace: string | null;
}

const TOOL_WORDS: Record<string, { title: string; allow: string; why?: string }> = {
  delegate_to_agent: { title: 'Let an agent use the internet', allow: 'Allow internet for this task', why: 'The agent will go online (public web only)' },
  run_checks: { title: 'Run a command in this folder', allow: 'Allow running this command', why: 'It runs code in this folder' },
  delegate_to_opencode: { title: 'Let OpenCode work in this folder', allow: 'Allow OpenCode in this folder', why: 'OpenCode can create and change files and run commands there' },
  delegate_to_coding_agent: { title: 'Let a coding agent work in this folder', allow: 'Allow this coding agent here', why: 'It can create and change files there; the card says whether it runs locally or in the cloud' },
  authorize_mission: { title: 'Change files in this folder', allow: 'Allow file changes in this folder' },
  write_file: { title: 'Write a file', allow: 'Allow writing this file' },
  run_command: { title: 'Run a command', allow: 'Allow running this command' },
  run_check: { title: 'Run a check', allow: 'Allow running this check' },
  send_email: { title: 'Send an email', allow: 'Allow sending this email' },
  gmail_send: { title: 'Send an email', allow: 'Allow sending this email' },
  web_research: { title: 'Search the web', allow: 'Allow this web search', why: 'It goes online (public web only)' },
  governed_research: { title: 'Search the web', allow: 'Allow this web search', why: 'It goes online (public web only)' },
};

function humanize(id: string): string {
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function phoneDecision(s: DesktopSnapshot | null | undefined): PhoneDecision | null {
  if (!s) return null;
  if (s.pendingApproval) {
    const a = s.pendingApproval;
    const named = TOOL_WORDS[a.toolName];
    const title = named?.title ?? (a.scope || humanize(a.toolName));
    const rows: Array<[string, string]> = [['Action', title], ['Tool', a.toolName]];
    if (a.paths?.length) rows.push(['Affects', a.paths.join('\n')]);
    const why = named?.why ?? (/^(?:write_file|authorize_mission|propose_)/.test(a.toolName) ? 'It changes files'
      : /^(?:run_|delegate_to_opencode)/.test(a.toolName) ? 'It runs code'
        : /^(?:browser_|inspect_page|gmail_|calendar_)/.test(a.toolName) ? 'It acts outside this PC'
          : a.gate === 'mutation' ? 'It acts outside this chat' : a.gate);
    if (why) rows.push(['Why it asks', why]);
    return { kind: 'tool', approvalId: a.approvalId, title, rows, detail: a.detail ?? '', allowLabel: named?.allow ?? `Allow: ${title}` };
  }
  if (s.pendingImageApproval) {
    return {
      kind: 'image',
      approvalId: s.pendingImageApproval.approvalId,
      title: 'Generate image',
      rows: [['Action', 'Generate an image locally (ComfyUI)']],
      detail: s.pendingImageApproval.request?.prompt ?? '',
      allowLabel: 'Generate image',
    };
  }
  if (s.pendingWeatherApproval) {
    return {
      kind: 'weather',
      approvalId: s.pendingWeatherApproval.approvalId,
      title: 'Look up weather',
      rows: [['Action', 'Fetch the weather forecast over the network']],
      detail: '',
      allowLabel: 'Look up weather',
    };
  }
  return null;
}

export function phoneState(s: DesktopSnapshot): PhoneState {
  const running = Boolean(s.running);
  const activities = Array.isArray(s.workspaceActivities) ? s.workspaceActivities : [];
  let activity: PhoneState['activity'] = null;
  if (running) {
    for (let i = activities.length - 1; i >= 0; i -= 1) {
      const a = activities[i];
      if (a && a.state === 'running') {
        activity = { title: String(a.title ?? ''), kind: String(a.kind ?? ''), startedAt: String(a.startedAt ?? '') };
        break;
      }
    }
  }
  const folder = typeof s.folder === 'string' && s.folder.trim() ? path.win32.basename(s.folder.replace(/[\\/]+$/, '')) : null;
  return {
    coreState: s.coreState === 'connected' ? 'connected' : s.coreState === 'starting' || s.coreState === 'reconnecting' ? 'connecting' : 'offline',
    model: s.modelIsAuto ? 'Auto' : (s.model || 'Auto'),
    running,
    attemptId: s.attemptId ?? null,
    conversationId: s.selectedConversationId ?? s.activeConversationId ?? null,
    activity,
    decision: phoneDecision(s),
    lastTurnOutcome: s.lastTurnOutcome ?? null,
    blockedReason: s.blockedReason ?? null,
    workspace: folder,
  };
}

const EVENT_TEXT_KINDS = new Set(['result', 'conversation_message', 'error', 'cancelled']);

/** A session event as the phone sees it: no tool arguments, check details or token counts. */
export function phoneEvent(e: DesktopActivityEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: e.kind, at: e.at, summary: typeof e.summary === 'string' ? e.summary.slice(0, 500) : '' };
  if (e.attemptId) out.attemptId = e.attemptId;
  if (e.conversationId) out.conversationId = e.conversationId;
  if (e.eventType) out.eventType = e.eventType;
  if (e.toolName) out.toolName = e.toolName;
  if (e.messageRole) out.messageRole = e.messageRole;
  if (e.clientOrigin) out.clientOrigin = e.clientOrigin;
  if (EVENT_TEXT_KINDS.has(e.kind) && typeof e.text === 'string') out.text = e.text;
  return out;
}
