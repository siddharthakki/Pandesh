/**
 * The contextual workspace's record of what Pandesh actually did.
 *
 * Built only from real execution: Core's tool-invocation events (their start,
 * their terminal status and the bounded `activity` the tool published — see
 * core/shared/toolActivity.ts) and the host's own capability calls. Nothing
 * here is inferred from a launch: an activity is `completed` only when Core
 * recorded the call as succeeded, and a call that never reported back is
 * closed as failed or cancelled with the task, never as done.
 *
 * Bounded per conversation and kept in a small JSON file in the desktop data
 * folder, so the history survives a reload and a restart. Previews are
 * referenced by Core artifact id, never copied here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeToolActivity, type ToolActivity, type ToolActivityKind } from '../../../../core/shared/toolActivity';
import type { DesktopActivityEvent, DesktopWorkspaceActivity, WorkspaceActivityState } from '../ipc';
import { browserStep } from './missionCockpit';

export const MAX_ACTIVITIES_PER_CONVERSATION = 30;
const MAX_ACTIVITIES_TOTAL = 400;
const MAX_DETAIL_CHARS = 400;

/** Plumbing the person never needs to see as an activity of its own. */
const HIDDEN_TOOLS = new Set(['protocol_correction', 'authorize_mission', 'unknown_tool', 'tool']);

const CODE_TOOLS = new Set([
  'propose_file_change', 'propose_text_edit', 'run_command', 'workspace_validation',
  'run_check', 'static_html_check', 'verify_acceptance', 'write_file', 'run_checks', 'delegate_to_opencode',
]);

export function activityKindForTool(toolName: string, preview?: ToolActivity | null): ToolActivityKind {
  if (preview?.kind) return preview.kind;
  if (toolName.startsWith('browser_') || toolName === 'inspect_page' || toolName === 'web_research') return 'browser';
  if (toolName === 'image_generate') return 'image';
  if (toolName === 'video_generate') return 'video';
  if (toolName === 'build_3d_model' || toolName === 'create_simulation' || toolName === 'create_design' || toolName === 'create_video' || toolName.startsWith('workshop_')) return 'workshop';
  if (CODE_TOOLS.has(toolName)) return 'code';
  if (toolName === 'read_file' || toolName === 'read_file_outside_workspace' || toolName === 'gmail_read_attachment') return 'document';
  return 'tool';
}

function hostOf(value: unknown): string {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return String(value ?? '').slice(0, 80);
  }
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A plain sentence for what the call is doing, from its (Core-projected) arguments. */
export function activityTitle(toolName: string, args: Record<string, unknown> = {}, state: 'running' | 'ok' | 'failed' = 'running'): string {
  const plain = browserStep(toolName, args, state);
  if (plain) return plain;
  const target = clip(args.path ?? args.filePath ?? '', 80);
  switch (toolName) {
    case 'browser_open_site': return `Opening ${hostOf(args.url)}`;
    case 'browser_goto': return `Going to ${hostOf(args.url)}`;
    case 'browser_read': return 'Reading the page';
    case 'browser_click': return typeof args.linkIndex === 'number' ? `Following link ${args.linkIndex}` : 'Clicking on the page';
    case 'browser_scroll': return `Scrolling ${args.direction === 'up' ? 'up' : 'down'}`;
    case 'browser_back': return 'Going back';
    case 'browser_fill': return 'Filling a form field';
    case 'browser_submit': return 'Submitting a form';
    case 'browser_stop': return 'Closing the browser';
    case 'inspect_page': return `Inspecting ${clip(args.url || args.path, 80) || 'a page'}`;
    case 'read_file':
    case 'read_file_outside_workspace': return target ? `Reading ${target}` : 'Reading a file';
    case 'propose_file_change':
    case 'propose_text_edit':
    case 'write_file': return target ? `Editing ${target}` : 'Editing a file';
    case 'run_command':
    case 'run_checks': return `Running ${clip(args.command, 70) || 'a command'}`;
    case 'delegate_to_opencode': return `OpenCode: ${clip(args.objective, 70)}`;
    case 'web_research': return `Searching the web: ${clip(args.query, 70)}`;
    case 'list_directory': return `Listing ${clip(args.path ?? args.dirPath ?? 'a folder', 70)}`;
    case 'workspace_validation': return 'Checking the change';
    case 'run_check': return `Review: ${clip(args.check, 60) || 'check'}`;
    case 'image_generate': return `Generating an image: ${clip(args.prompt, 70)}`;
    case 'video_generate': return `Generating a video: ${clip(args.prompt, 70)}`;
    case 'create_simulation': return `Running a simulation: ${clip(args.title, 60) || 'customer queue'}`;
    case 'build_3d_model': return `Building a 3D model: ${clip(args.description ?? args.title, 70) || 'from parts'}`;
    case 'create_design': return `Designing a page: ${clip(args.description ?? args.title, 70) || 'from the source given'}`;
    case 'create_video': return `Rendering a video: ${clip(args.title, 60) || `${Array.isArray(args.images) ? args.images.length : ''} picture slideshow`.trim()}`;
    case 'workshop_edit': return `Changing the Workshop model${args.workshopTitle ? `: ${clip(args.workshopTitle, 60)}` : ''}`;
    case 'workshop_restore': return 'Undo in the Workshop';
    case 'workshop_export': return 'Exporting the 3D model (GLB)';
    case 'workshop_view': return `Workshop: ${clip(String(args.action ?? 'view').replace(/_/g, ' '), 40)}`;
    case 'workshop_status': return 'Reading the Workshop';
    default: return toolName.replace(/_/g, ' ');
  }
}

function terminalState(status: string | undefined): WorkspaceActivityState | null {
  if (status === 'succeeded') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return null;
}

function isStart(event: DesktopActivityEvent): boolean {
  return event.eventType === 'tool_invocation_started';
}

function isEnd(event: DesktopActivityEvent): boolean {
  return event.eventType === 'tool_invocation_completed' || event.eventType === 'capability_tool_invocation_completed';
}

/** The failure (or check) text Core reported, without the "tool failed: name" prefix. */
function reportedDetail(event: DesktopActivityEvent): string | null {
  const match = /^tool \w+: \S+\s*(.*)$/.exec(event.summary ?? '');
  const text = clip(match?.[1] ?? '', MAX_DETAIL_CHARS);
  return text || null;
}

export class WorkspaceActivityLog {
  private items: DesktopWorkspaceActivity[] = [];
  /** How a running step will read once it ends ("Filled …" / "Could not fill …"), by invocation id. */
  private readonly endTitles = new Map<string, { ok: string; failed: string }>();

  constructor(private readonly file?: string) {
    this.load();
  }

  /** The conversation's activities, oldest first. */
  list(conversationId: string | null | undefined): DesktopWorkspaceActivity[] {
    if (!conversationId) return [];
    return this.items.filter((item) => item.conversationId === conversationId);
  }

  get(id: string): DesktopWorkspaceActivity | undefined {
    return this.items.find((item) => item.id === id);
  }

  /**
   * Folds one runtime event into the log. Returns true when something the
   * workspace shows changed.
   */
  observe(event: DesktopActivityEvent, conversationId: string | null): boolean {
    if ((event.kind === 'result' || event.kind === 'cancelled' || event.kind === 'error') && event.attemptId) {
      return this.settleTask(event.attemptId, event.kind === 'result' ? 'completed' : event.kind === 'cancelled' ? 'cancelled' : 'failed');
    }
    if (event.domain !== 'tool_invocation' || !event.invocationId) return false;
    // Core's completion event names only the invocation; the tool is known from its start.
    const existingStep = this.get(event.invocationId);
    const toolName = existingStep?.capability ?? event.toolName ?? 'tool';
    if (HIDDEN_TOOLS.has(toolName)) return false;
    const preview = sanitizeToolActivity(event.activity) ?? null;
    if (isStart(event)) {
      if (this.get(event.invocationId)) return false;
      if (browserStep(toolName, event.toolArgs ?? {}, 'ok')) {
        this.endTitles.set(event.invocationId, { ok: activityTitle(toolName, event.toolArgs, 'ok'), failed: activityTitle(toolName, event.toolArgs, 'failed') });
        if (this.endTitles.size > 200) this.endTitles.delete(this.endTitles.keys().next().value as string);
      }
      this.add({
        id: event.invocationId,
        conversationId,
        taskId: event.attemptId ?? null,
        capability: toolName,
        kind: activityKindForTool(toolName),
        title: activityTitle(toolName, event.toolArgs),
        state: 'running',
        startedAt: event.at,
        endedAt: null,
        detail: null,
        preview: null,
      });
      return true;
    }
    if (!isEnd(event)) return false;
    const state = terminalState(event.invocationStatus);
    if (!state) return false;
    const existing = existingStep;
    // A failure says why; a success speaks through its preview, or — for a
    // check with nothing to preview — through what Core reported.
    const detail = state !== 'completed' || (CODE_TOOLS.has(toolName) && !preview) ? reportedDetail(event) : null;
    if (existing) {
      const ended = this.endTitles.get(existing.id);
      if (ended && state !== 'cancelled') existing.title = state === 'completed' ? ended.ok : ended.failed;
      this.endTitles.delete(existing.id);
      existing.state = state;
      existing.endedAt = event.at;
      existing.preview = preview ?? existing.preview;
      existing.kind = activityKindForTool(toolName, existing.preview);
      existing.detail = detail;
    } else {
      this.add({
        id: event.invocationId,
        conversationId,
        taskId: event.attemptId ?? null,
        capability: toolName,
        kind: activityKindForTool(toolName, preview),
        title: activityTitle(toolName, event.toolArgs),
        state,
        startedAt: event.at,
        endedAt: event.at,
        detail,
        preview,
      });
    }
    this.save();
    return true;
  }

  /** A capability call the host itself made (outside any Core attempt event stream). */
  begin(input: { id: string; conversationId: string | null; taskId: string | null; capability: string; title: string; kind?: ToolActivityKind }): void {
    if (this.get(input.id)) return;
    this.add({
      id: input.id,
      conversationId: input.conversationId,
      taskId: input.taskId,
      capability: input.capability,
      kind: input.kind ?? activityKindForTool(input.capability),
      title: clip(input.title, 160),
      state: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      detail: null,
      preview: null,
    });
  }

  settle(id: string, state: Exclude<WorkspaceActivityState, 'running'>, input: { preview?: unknown; detail?: string | null } = {}): void {
    const item = this.get(id);
    if (!item) return;
    item.state = state;
    item.endedAt = new Date().toISOString();
    const preview = sanitizeToolActivity(input.preview);
    if (preview) {
      item.preview = preview;
      item.kind = preview.kind;
    }
    item.detail = input.detail ? clip(input.detail, MAX_DETAIL_CHARS) : item.detail;
    this.save();
  }

  /**
   * The task ended. A step that never reported its own end did not succeed:
   * it is closed as cancelled when the task was stopped, and as failed
   * otherwise — never as completed.
   */
  settleTask(taskId: string, outcome: WorkspaceActivityState): boolean {
    let changed = false;
    for (const item of this.items) {
      if (item.taskId !== taskId || item.state !== 'running') continue;
      item.state = outcome === 'cancelled' ? 'cancelled' : 'failed';
      item.endedAt = new Date().toISOString();
      item.detail = outcome === 'cancelled' ? 'Stopped before this step finished.' : 'This step did not report a result.';
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  private add(item: DesktopWorkspaceActivity): void {
    this.items.push(item);
    const mine = this.items.filter((entry) => entry.conversationId === item.conversationId);
    if (mine.length > MAX_ACTIVITIES_PER_CONVERSATION) {
      const drop = new Set(mine.slice(0, mine.length - MAX_ACTIVITIES_PER_CONVERSATION));
      this.items = this.items.filter((entry) => !drop.has(entry));
    }
    if (this.items.length > MAX_ACTIVITIES_TOTAL) this.items = this.items.slice(-MAX_ACTIVITIES_TOTAL);
    this.save();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { items?: unknown };
      if (!Array.isArray(parsed.items)) return;
      this.items = parsed.items.flatMap((raw) => {
        const item = raw as Partial<DesktopWorkspaceActivity>;
        if (typeof item?.id !== 'string' || typeof item.title !== 'string') return [];
        // A step still marked running belongs to a host that is gone; it did
        // not finish while nobody was watching.
        const state: WorkspaceActivityState = item.state === 'completed' || item.state === 'failed' || item.state === 'cancelled' ? item.state : 'failed';
        return [{
          id: item.id,
          conversationId: typeof item.conversationId === 'string' ? item.conversationId : null,
          taskId: typeof item.taskId === 'string' ? item.taskId : null,
          capability: String(item.capability ?? 'tool'),
          kind: activityKindForTool(String(item.capability ?? 'tool'), sanitizeToolActivity(item.preview)),
          title: clip(item.title, 160),
          state,
          startedAt: String(item.startedAt ?? ''),
          endedAt: typeof item.endedAt === 'string' ? item.endedAt : null,
          detail: item.state === 'running' ? 'Pandesh closed before this step finished.' : (typeof item.detail === 'string' ? clip(item.detail, MAX_DETAIL_CHARS) : null),
          preview: sanitizeToolActivity(item.preview) ?? null,
        }];
      }).slice(-MAX_ACTIVITIES_TOTAL);
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, items: this.items }), 'utf8');
      fs.renameSync(temp, this.file);
    } catch {
      // The live view still works; only the history across restarts is lost.
    }
  }
}
