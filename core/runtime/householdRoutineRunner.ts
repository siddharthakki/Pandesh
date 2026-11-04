/**
 * Executes household routines (core/domain/householdRoutines.ts) for the scheduler, or on "Run now".
 *
 * A run is deterministic and model-free. It claims its occurrence in `routine_runs` first (so a restart or a double
 * tick never runs it twice), stays strictly inside the scope frozen on the routine, and ends with a truthful record:
 * succeeded with a summary, or failed with the reason. Unattended runs never create approval cards — nobody is there to
 * answer them — so anything the scope does not cover is written down as a proposal instead.
 */
import { documentReadPolicy } from '../domain/documentReadGrants';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { ConnectorId } from '../shared/wireTypes';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { ScheduledTaskRecord } from '../domain/scheduledTasks';
import { appendMessage, createConversation } from '../domain/conversations';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { enqueueNotification } from '../domain/notificationOutbox';
import { upsertCompanionRecord } from '../domain/companionSync';
import { listOrganizationRules, listPlanMoves } from '../domain/fileOrganization';
import {
  finishRoutineRun, lastSuccessfulRun, startRoutineRun, type HouseholdRoutineKind, type RoutineRun, type RoutineScope,
} from '../domain/householdRoutines';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';
import { nowIso } from '../domain/ids';
import { applyOrganizationPlan, proposeOrganization, validateRoot } from './pcOrganizer';
import { publishBriefing, renderHouseholdBriefing, scanObligationSources, type ConnectorReader } from './householdService';
import { readConnector } from './assistantBrief';

const ACTOR = 'kkd:household_routine';
const READ_TIMEOUT_MS = 60_000;

export interface HouseholdRoutineDeps {
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
  cwd?: string;
  nowMs?: number;
}

const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

async function runFolderCleanup(db: CoreDatabase, task: ScheduledTaskRecord, scope: RoutineScope): Promise<{ summary: string; detail: Record<string, unknown>; markdown: string }> {
  const ops = new Set(scope.operations);
  const sections: string[] = [];
  const detail: Record<string, unknown> = { folders: [] as unknown[] };
  let moved = 0; let proposals = 0; let dupBytes = 0; let tempBytes = 0; let largeTemp = 0;
  for (const raw of scope.folders) {
    const v = validateRoot(raw);
    if (!v.ok) { sections.push(`- ${raw}: not read — ${v.reason}`); (detail.folders as unknown[]).push({ folder: raw, error: v.reason }); continue; }
    const rules = listOrganizationRules(db, v.root);
    const plan = await proposeOrganization(db, { roots: [v.root], targetBase: v.root, rules, origin: 'routine', routineId: task.id, inspectContents: scope.inspectContents === true && ops.has('classify') ? documentReadPolicy(db) : undefined });
    const s = plan.summary as Record<string, any>;
    const planned = listPlanMoves(db, plan.id).length;
    let movedHere = 0;
    let failedHere = 0;
    if (planned && ops.has('apply_approved_rules')) {
      const r = await applyOrganizationPlan(db, plan.id, { actor: `routine:${task.id}`, maxMoves: scope.maxMovesPerRun ?? 100 });
      movedHere = r.verifiedNow; failedHere = r.failedNow.length;
    }
    moved += movedHere;
    proposals += s.ambiguous.count;
    dupBytes += s.duplicates.redundantBytes;
    tempBytes += s.temporary.bytes;
    const bigTemp = (s.temporary.examples as string[]).length && s.temporary.bytes >= 50 * 1024 * 1024 ? s.temporary.files : 0;
    largeTemp += bigTemp;
    sections.push(`- ${v.root}: ${s.scanned.files} files checked; ${movedHere} moved by ${rules.length} approved rule(s)${failedHere ? `, ${failedHere} could not move (retried next run)` : ''}; ${s.ambiguous.count} new file(s) need your decision; ${s.duplicates.redundantFiles} duplicate cop${s.duplicates.redundantFiles === 1 ? 'y' : 'ies'} (${fmtBytes(s.duplicates.redundantBytes)}); ${s.temporary.files} temporary file(s) (${fmtBytes(s.temporary.bytes)}). Plan ${plan.id}${movedHere ? ' (undo with pc_organize_undo)' : ''}.`);
    for (const a of (s.ambiguous.examples as Array<{ path: string; suggested: string | null; reason: string }>).slice(0, 5)) sections.push(`  - proposed: ${path.basename(a.path)} → ${a.suggested ?? 'no suggestion'} (${a.reason})`);
    if (!rules.length) sections.push('  - No approved destinations for this folder yet: approve a plan with "save as rules" and this routine will keep applying them.');
    (detail.folders as unknown[]).push({ folder: v.root, planId: plan.id, moved: movedHere, failed: failedHere, proposals: s.ambiguous.count, duplicates: s.duplicates.redundantFiles, temporary: s.temporary.files });
  }
  const unread = (detail.folders as Array<{ folder: string; error?: string }>).filter((f) => f.error);
  if (unread.length === scope.folders.length) throw new Error(`no folder could be read: ${unread.map((f) => `${f.folder} (${f.error})`).join('; ')}`);
  const summary = `${unread.length ? `not read: ${unread.map((f) => f.folder).join(', ')}; ` : ''}${moved} file(s) moved by approved rules; ${proposals} proposal(s) for you; duplicates ${fmtBytes(dupBytes)} and temporary files ${fmtBytes(tempBytes)} flagged${largeTemp ? ` (${largeTemp} large temporary file(s))` : ''}; 0 bytes deleted.`;
  const markdown = [`## ${task.title}`, summary, '', ...sections, '', `Space recovered this run: 0 bytes (Pandesh never deletes). Recoverable if you remove the flagged copies and temporary files yourself: ${fmtBytes(dupBytes + tempBytes)}.`].join('\n');
  return { summary, detail: { ...detail, moved, proposals, duplicateBytes: dupBytes, temporaryBytes: tempBytes }, markdown };
}

async function runObligationCheck(db: CoreDatabase, task: ScheduledTaskRecord, scope: RoutineScope, deps: HouseholdRoutineDeps, kind: HouseholdRoutineKind): Promise<{ summary: string; detail: Record<string, unknown>; markdown: string; lines: string[] }> {
  const ops = new Set(scope.operations);
  const previous = lastSuccessfulRun(db, task.id);
  const nowMs = deps.nowMs ?? Date.now();
  const lookback = previous ? (scope.lookbackDays ?? 3) : Math.max(30, scope.lookbackDays ?? 3);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const reader: ConnectorReader = async (toolName, args) => {
      const r = await readConnector(db, deps.connectorRegistry ?? new Map(), 'gmail', toolName, args, deps.cwd ?? process.cwd(), controller.signal);
      return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason ?? 'Gmail could not be read' };
    };
    const report = await scanObligationSources(db, {
      gmail: ops.has('read_gmail') && scope.sources.includes('gmail') ? { reader, lookbackDays: lookback } : undefined,
      folders: ops.has('read_folders') ? scope.folders : [],
      // The scope says the routine may use document text; the person's grant, checked now, says where.
      inspectContents: scope.inspectContents === true && (ops.has('read_contents') || kind === 'obligations_check') ? documentReadPolicy(db) : undefined,
      sinceMs: previous && kind === 'obligations_check' ? Date.parse(previous.startedAt) - 86_400_000 : undefined,
      nowMs,
    });
    const briefing = renderHouseholdBriefing(db, report, nowMs, task.title);
    if (ops.has('notify_phone')) publishBriefing(db, task.title, briefing.lines, nowMs);
    const summary = `${report.sourcesRead.gmailMessages} email(s), ${report.sourcesRead.files} file(s) read; ${report.created.length} new and ${report.updated.length} changed obligation(s)${report.unavailable.length ? `; not read: ${report.unavailable.join('; ')}` : ''}.`;
    return {
      summary, markdown: briefing.markdown, lines: briefing.lines,
      detail: { lookbackDays: lookback, sourcesRead: report.sourcesRead, unavailable: report.unavailable, created: report.created.map((o) => o.id), updated: report.updated.map((u) => ({ id: u.obligation.id, changed: u.changed })), unchanged: report.unchanged },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface HouseholdRoutineResult { run: RoutineRun | null; delivered: boolean; reason: string }

/** Runs one occurrence of a household routine. `trigger: 'manual'` is "Run now" from chat or the app. */
export async function runHouseholdRoutine(db: CoreDatabase, broadcaster: EventBroadcaster | null, task: ScheduledTaskRecord, trigger: RoutineRun['trigger'], deps: HouseholdRoutineDeps = {}): Promise<HouseholdRoutineResult> {
  const kind = task.routine as HouseholdRoutineKind;
  const occurrenceKey = trigger === 'manual' ? `${task.id}@manual:${nowIso()}` : `${task.id}@${task.nextRunAt}`;
  const run = startRoutineRun(db, { taskId: task.id, routine: kind, occurrenceKey, trigger });
  if (!run) return { run: null, delivered: false, reason: 'this occurrence already ran' };
  const scope = (task.scope ?? {}) as unknown as RoutineScope;
  let finished: RoutineRun;
  let markdown: string;
  let lines: string[] = [];
  try {
    if (!scope.operations?.length) throw new Error('this routine has no approved scope; edit it and approve what it may do');
    const out: { summary: string; detail: Record<string, unknown>; markdown: string; lines?: string[] } = kind === 'folder_cleanup'
      ? await runFolderCleanup(db, task, scope)
      : await runObligationCheck(db, task, scope, deps, kind);
    markdown = out.markdown;
    lines = out.lines ?? [out.summary];
    finished = finishRoutineRun(db, run.id, { status: 'succeeded', summary: out.summary, detail: out.detail });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markdown = `## ${task.title}\nThis run failed: ${message}\nNothing outside the routine's approved scope was attempted. The next run is scheduled normally.`;
    finished = finishRoutineRun(db, run.id, { status: 'failed', summary: `failed: ${message}`, error: message });
  }
  const conversationId = task.conversationId ?? createConversation(db, { mode: 'saath_kar', title: task.title, actor: ACTOR }).id;
  if (!task.conversationId) db.run('UPDATE scheduled_tasks SET conversationId = ?, updatedAt = ? WHERE id = ?', [conversationId, nowIso(), task.id]);
  const message = appendMessage(db, conversationId, { role: 'assistant', content: `${markdown}\n\n_Routine run ${finished.id} (${trigger}) — ${finished.status}._`, actor: ACTOR, clientId: SCHEDULER_CLIENT_ID });
  db.run('UPDATE scheduled_tasks SET lastRunAt = ?, updatedAt = ? WHERE id = ?', [finished.finishedAt, nowIso(), task.id]);
  enqueueNotification(db, {
    kind: finished.status === 'succeeded' ? 'task_completed' : 'task_failed', sourceId: finished.id,
    title: `${task.title}: ${finished.status === 'succeeded' ? 'done' : 'failed'}`, body: finished.summary ?? '',
  });
  upsertCompanionRecord(db, {
    recordId: `routine:${task.id}`, kind: 'task_status',
    payload: { title: task.title, status: finished.status, summary: finished.summary, finishedAt: finished.finishedAt, trigger, highlights: lines.slice(0, 8).map((l) => l.slice(0, 200)) },
  });
  const event = recordRuntimeEvent(db, {
    domain: 'assistant_routine', entityId: task.id, eventType: finished.status === 'succeeded' ? 'household_routine_completed' : 'household_routine_failed',
    actor: ACTOR, clientId: SCHEDULER_CLIENT_ID, idempotencyKey: `household_routine:${finished.id}`,
    metadata: { runId: finished.id, routine: kind, trigger, conversationId, messageId: message.id, summary: finished.summary, title: task.title, body: finished.summary },
  });
  broadcaster?.publishRuntime(event);
  return { run: finished, delivered: true, reason: finished.status };
}
