import type {
  DesktopActivityEvent,
  DesktopApprovalCard,
  MissionCockpitView,
  CockpitCheckpoint,
  CockpitCurrentAction,
  CockpitMetrics,
  CockpitPhase,
} from '../ipc';
import { CLOUD_COST_BASELINE, estimateCloudCostUsd } from './cloudCostBaseline';
import { MISSION_WALL_CLOCK_MS, INVESTIGATION_ALLOWANCE, IMPLEMENTATION_ALLOWANCE } from '../../../../core/runtime/missionBudget';

export const COCKPIT_VISIBLE_LIMIT = 12;
export const MISSION_ABSOLUTE_MS = MISSION_WALL_CLOCK_MS;

export interface CockpitProjectionInput {
  requestId: string | null;
  attemptId: string | null;
  running: boolean;
  terminal: boolean;
  pendingApproval: DesktopApprovalCard | null;
  approvedApproval: DesktopApprovalCard | null;
  startedAt: string | null;
  nowMs: number;
  /** Frozen OpenRouter cap for this attempt; null when local-only. */
  spendCapUsd?: number | null;
}

const HIDDEN = /^(token|snapshot|Host ready)$/i;

export function emptyMissionCockpit(): MissionCockpitView {
  return {
    requestId: null,
    attemptId: null,
    running: false,
    terminal: false,
    phase: 'investigation',
    currentAction: null,
    startedAt: null,
    elapsedMs: 0,
    remainingAbsoluteMs: MISSION_ABSOLUTE_MS,
    productiveUsed: 0,
    phaseAllowance: INVESTIGATION_ALLOWANCE,
    repairCycle: 0,
    filesRead: [],
    filesChanged: [],
    validationStatus: 'Not run',
    verificationStatus: 'Not run',
    checkpoints: [],
    diagnostics: [],
    metrics: emptyCockpitMetrics(),
    finalOutcome: null,
    authState: 'none',
    pendingApproval: null,
    approvedApproval: null,
  };
}

export function projectMissionCockpit(
  events: readonly DesktopActivityEvent[],
  input: CockpitProjectionInput,
): MissionCockpitView {
  const attemptId = input.attemptId;
  const scoped = pairToolEvents(events.filter((event) => belongsToAttempt(event, attemptId)
    && (!event.requestId || event.requestId === input.requestId)));
  const diagnostics = scoped.filter((event) => event.kind !== 'token' && event.summary !== 'token');
  const awaitingApproval = Boolean(input.pendingApproval);
  const endedAt = (input.terminal && !awaitingApproval) ? [...diagnostics].reverse().find(isTerminalEvent)?.at : undefined;
  const clockMs = endedAt ? Date.parse(endedAt) : input.nowMs;
  const checkpoints = coalesceCheckpoints(diagnostics, clockMs, awaitingApproval);
  const visible = checkpoints.slice(-COCKPIT_VISIBLE_LIMIT);
  const filesRead = unique(diagnostics.flatMap((event) => readPath(event)));
  const filesChanged = unique(diagnostics.flatMap((event) => changedPath(event)));
  const startedAt = input.startedAt ?? diagnostics[0]?.at ?? null;
  const elapsedMs = startedAt ? duration(startedAt, new Date(clockMs).toISOString()) : 0;
  const phase = inferPhase(diagnostics);
  const productiveUsed = countProductive(diagnostics);
  const currentAction = inferCurrentAction(diagnostics);
  const repairCycle = countRepairs(diagnostics);
  const finalOutcome = (input.terminal && !awaitingApproval) ? terminalOutcome(diagnostics) : null;

  return {
    requestId: input.requestId,
    attemptId,
    running: input.running,
    terminal: input.terminal && !awaitingApproval,
    phase,
    currentAction: input.running ? currentAction : null,
    startedAt,
    elapsedMs,
    remainingAbsoluteMs: Math.max(0, MISSION_ABSOLUTE_MS - elapsedMs),
    productiveUsed,
    phaseAllowance: phase === 'investigation' ? INVESTIGATION_ALLOWANCE : IMPLEMENTATION_ALLOWANCE,
    repairCycle,
    filesRead,
    filesChanged,
    validationStatus: lastStatus(diagnostics, 'workspace_validation', 'Not run'),
    verificationStatus: lastStatus(diagnostics, 'verify_acceptance', 'Not run'),
    checkpoints: visible,
    diagnostics,
    metrics: {
      ...projectMetrics(diagnostics),
      spendCapUsd: input.spendCapUsd ?? null,
    },
    finalOutcome,
    authState: input.pendingApproval ? 'pending' : input.approvedApproval ? 'collapsed' : 'none',
    pendingApproval: input.pendingApproval,
    approvedApproval: input.approvedApproval,
  };
}

function isTerminalEvent(event: DesktopActivityEvent): boolean {
  return event.kind === 'result' || event.kind === 'cancelled' || event.kind === 'error'
    || event.eventType === 'attempt_failed' || event.eventType === 'attempt_cancelled';
}

function isToolStart(event: DesktopActivityEvent): boolean {
  return event.eventType === 'tool_invocation_started' || event.summary.startsWith('tool start:');
}

function isToolEnd(event: DesktopActivityEvent): boolean {
  return event.eventType === 'tool_invocation_completed' || /^tool (succeeded|failed|cancelled):/.test(event.summary);
}

function status(event: DesktopActivityEvent): string {
  return event.invocationStatus || event.summary.match(/^tool (succeeded|failed|cancelled):/)?.[1] || '';
}

// Core completion events carry invocation identity, but omit the tool name and arguments.
// Legacy recordings lack identity and contain sequential tool pairs.
function pairToolEvents(events: readonly DesktopActivityEvent[]): DesktopActivityEvent[] {
  const starts = new Map<string, DesktopActivityEvent>();
  return events.map((event) => {
    const key = event.invocationId ?? 'legacy';
    if (isToolStart(event)) starts.set(key, event);
    if (!isToolEnd(event)) return event;
    const start = starts.get(key);
    starts.delete(key);
    return start ? { ...event, toolName: toolName(start), toolArgs: toolArguments(start) } : event;
  });
}

function belongsToAttempt(event: DesktopActivityEvent, attemptId: string | null): boolean {
  if (!attemptId) return false;
  if (event.attemptId !== attemptId) return false;
  return true;
}

function isHostLifecycle(summary: string): boolean {
  if (/^Core approval (approved|rejected)/.test(summary)) return false;
  return /^(Core |Host ready|Repository |Authorized task scope|\{)/.test(summary)
    || HIDDEN.test(summary)
    || summary === 'snapshot';
}

function coalesceCheckpoints(events: readonly DesktopActivityEvent[], nowMs: number, awaitingApproval = false): CockpitCheckpoint[] {
  const out: CockpitCheckpoint[] = [];
  let openModel: DesktopActivityEvent | null = null;
  const openTools = new Map<string, DesktopActivityEvent>();

  const push = (item: CockpitCheckpoint) => {
    const previous = out[out.length - 1];
    if (previous && sameGroup(previous, item)) {
      previous.count = (previous.count ?? 1) + (item.count ?? 1);
      previous.endedAt = item.endedAt ?? item.at;
      previous.durationMs = (previous.durationMs ?? 0) + (item.durationMs ?? 0);
      if (item.outcome === 'cached') previous.outcome = 'cached';
      return;
    }
    out.push(item);
  };

  for (const event of events) {
    if (shouldHide(event)) continue;
    if (isTerminalEvent(event)) {
      openModel = null;
      openTools.clear();
    }

    if (event.eventType === 'model_invocation_started' || event.summary === 'model_invocation:model_invocation_started') {
      openModel = event;
      continue;
    }
    if (event.eventType === 'model_invocation_completed' || event.summary === 'model_invocation:model_invocation_completed') {
      const started = openModel ?? event;
      openModel = null;
      push({
        id: `model:${started.at}`,
        at: started.at,
        endedAt: event.at,
        durationMs: duration(started.at, event.at),
        title: 'AI response',
        detail: tokenDetail(event),
        outcome: status(event) === 'failed' || status(event) === 'cancelled' ? 'failed' : 'ok',
      });
      continue;
    }

    if (event.eventType === 'tool_invocation_started' || event.summary.startsWith('tool start:')) {
      openTools.set(event.invocationId ?? 'legacy', event);
      continue;
    }
    if (event.eventType === 'tool_invocation_completed' || /^tool (succeeded|failed|cancelled):/.test(event.summary)) {
      const key = event.invocationId ?? 'legacy';
      const started = openTools.get(key) ?? event;
      openTools.delete(key);
      const name = toolName(started) || toolName(event);
      const target = toolTarget(started) || toolTarget(event);
      const failed = status(event) === 'failed' || status(event) === 'cancelled';
      const cached = toolArguments(event).cached === true;
      push({
        id: `tool:${name}:${target}:${started.at}`,
        at: started.at,
        endedAt: event.at,
        durationMs: duration(started.at, event.at),
        title: humanTool(name, target),
        detail: toolDetail(event.summary),
        outcome: failed ? 'failed' : cached ? 'cached' : 'ok',
      });
      continue;
    }

    if (/Waiting for .+ approval/.test(event.summary) || event.kind === 'approval') {
      push({ id: `auth:${event.at}`, at: event.at, title: 'Waiting for authorization', detail: event.summary });
      continue;
    }
    if (/Core approval approved|resumed /.test(event.summary)) {
      push({ id: `auth-ok:${event.at}`, at: event.at, title: 'Authorization approved', outcome: 'ok' });
      continue;
    }
    if (/^Submitted |^submitted /.test(event.summary)) {
      push({ id: `submit:${event.at}`, at: event.at, title: 'Mission submitted', detail: event.summary });
      continue;
    }
    if (event.kind === 'error' || event.kind === 'cancelled' || event.kind === 'result') {
      if (awaitingApproval && event.kind === 'result') {
        // A task awaiting approval must never record a "Mission completed" checkpoint.
        continue;
      }
      push({
        id: `term:${event.at}`,
        at: event.at,
        title: event.kind === 'result' ? 'Mission completed' : event.summary,
        // Never the full model/tool response here — the event stream stays a
        // bounded operational summary (requirement: "never place complete
        // model prose, code, ... in the event list"). The complete text is
        // `cockpit.finalOutcome`, rendered only in the conversation pane
        // (renderer.js `renderConversationResult`); the activity row for
        // this checkpoint gets a "View response" action instead (`item.id`
        // starts with `term:`).
        detail: event.kind === 'result' ? undefined : event.text,
        outcome: event.kind === 'result' ? 'ok' : 'failed',
      });
      continue;
    }
    if (event.eventType === 'attempt_failed' || event.summary === 'attempt attempt_failed') {
      push({ id: `fail:${event.at}`, at: event.at, title: 'Mission failed', outcome: 'failed' });
    }
  }

  if (openModel) {
    push({
      id: `model-open:${openModel.at}`,
      at: openModel.at,
      durationMs: Math.max(0, nowMs - Date.parse(openModel.at)),
      title: 'AI response',
      outcome: 'running',
    });
  }
  for (const openTool of openTools.values()) {
    const name = toolName(openTool);
    push({
      id: `tool-open:${openTool.at}`,
      at: openTool.at,
      durationMs: Math.max(0, nowMs - Date.parse(openTool.at)),
      title: humanTool(name, toolTarget(openTool)),
      outcome: 'running',
    });
  }

  return out;
}

function shouldHide(event: DesktopActivityEvent): boolean {
  if (event.kind === 'token' || event.summary === 'token' || event.summary === 'snapshot') return true;
  if (isHostLifecycle(event.summary)) return true;
  if (event.eventType === 'attempt_transitioned' || /^attempt attempt_transitioned/.test(event.summary)) return true;
  if (/^sent (approved|rejected) to Core$/.test(event.summary)) return true;
  if (/In-scope Core gate auto-authorized/.test(event.summary)) return true;
  return false;
}

function sameGroup(previous: CockpitCheckpoint, next: CockpitCheckpoint): boolean {
  return previous.title === next.title
    && previous.outcome === next.outcome && previous.detail === next.detail;
}

function duration(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function toolName(event: DesktopActivityEvent): string {
  if (event.toolName && event.toolName !== 'unknown_tool') return event.toolName;
  const started = event.summary.match(/^tool start: ([^\s{]+)/);
  if (started) return started[1];
  const done = event.summary.match(/^tool \w+: ([^\s]+)/);
  return done?.[1] && done[1] !== 'unknown_tool' ? done[1] : 'tool';
}

function toolArguments(event: DesktopActivityEvent): Record<string, unknown> {
  if (event.toolArgs) return event.toolArgs;
  const json = event.summary.match(/\{.*\}/);
  if (!json) return {};
  try {
    return JSON.parse(json[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toolTarget(event: DesktopActivityEvent): string {
  const args = toolArguments(event);
  return String(args.path ?? args.query ?? args.check ?? '');
}

function humanTool(name: string, target: string): string {
  const label = name === 'read_file' ? 'Read'
    : name === 'search' ? 'Search'
    : name === 'propose_file_change' ? 'Edit'
    : name === 'propose_text_edit' ? 'Anchored edit'
    : name === 'workspace_validation' ? 'Validate'
    : name === 'verify_acceptance' ? 'Verify page'
    : name === 'run_check' ? 'Review'
    : name === 'protocol_correction' ? 'Protocol correction'
    : name;
  return target ? `${label} ${target}` : label;
}

function toolDetail(summary: string): string | undefined {
  const failed = summary.match(/tool failed: \S+\s+(.*)$/);
  if (failed) return failed[1].slice(0, 180);
  return undefined;
}

function tokenDetail(event: DesktopActivityEvent): string | undefined {
  const prompt = event.promptTokens;
  const completion = event.completionTokens;
  if (typeof prompt !== 'number' && typeof completion !== 'number') return undefined;
  const promptLabel = typeof prompt === 'number' ? `${prompt} prompt tokens` : 'prompt tokens unavailable';
  const generatedLabel = typeof completion === 'number' ? `${completion} generated` : 'generated unavailable';
  return `${promptLabel} / ${generatedLabel}`;
}

export function emptyCockpitMetrics(): CockpitMetrics {
  return {
    aiResponses: 0,
    promptTokens: null,
    generatedTokens: null,
    generationRate: null,
    cloudCostAvoidedUsd: null,
    actualSpendUsd: null,
    spendCapUsd: null,
    comparison: { ...CLOUD_COST_BASELINE },
  };
}

function usableCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Derives run metrics from completed AI responses. A measurement the backend
 * did not report stays null so it can be shown as "unavailable"; it is never
 * defaulted to zero, and end-to-end time is never presented as generation time.
 */
export function projectMetrics(events: readonly DesktopActivityEvent[]): CockpitMetrics {
  const completions = events.filter((event) => event.eventType === 'model_invocation_completed'
    || event.summary === 'model_invocation:model_invocation_completed');

  let promptTokens: number | null = null;
  let generatedTokens: number | null = null;
  let generationMs = 0;
  let generationTokens = 0;
  let endToEndMs = 0;
  let actualSpendUsd: number | null = null;
  let sawCost = false;

  for (const event of completions) {
    const prompt = usableCount(event.promptTokens);
    const generated = usableCount(event.completionTokens);
    if (prompt !== null) promptTokens = (promptTokens ?? 0) + prompt;
    if (generated !== null) generatedTokens = (generatedTokens ?? 0) + generated;

    const reportedGeneration = usableCount(event.generationMs);
    if (reportedGeneration !== null && reportedGeneration > 0 && generated !== null) {
      generationMs += reportedGeneration;
      generationTokens += generated;
    }
    const duration = usableCount(event.durationMs);
    if (duration !== null) endToEndMs += duration;
    const cost = usableCount(event.costUsd);
    if (cost !== null) {
      sawCost = true;
      actualSpendUsd = (actualSpendUsd ?? 0) + cost;
    }
  }

  let generationRate: CockpitMetrics['generationRate'] = null;
  if (generationMs > 0 && generationTokens > 0) {
    generationRate = { tokensPerSecond: generationTokens / (generationMs / 1000), basis: 'generation' };
  } else if (endToEndMs > 0 && (generatedTokens ?? 0) > 0) {
    // The backend did not report generation time, so this rate includes prompt
    // evaluation and queueing and is labelled end-to-end, not generation.
    generationRate = { tokensPerSecond: (generatedTokens ?? 0) / (endToEndMs / 1000), basis: 'end-to-end' };
  }

  return {
    aiResponses: completions.length,
    promptTokens,
    generatedTokens,
    generationRate,
    cloudCostAvoidedUsd: estimateCloudCostUsd(completions.map((event) => ({
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
    }))),
    actualSpendUsd: sawCost ? actualSpendUsd : null,
    spendCapUsd: null,
    comparison: { ...CLOUD_COST_BASELINE },
  };
}

function readPath(event: DesktopActivityEvent): string[] {
  if (!isToolEnd(event) || status(event) !== 'succeeded' || toolName(event) !== 'read_file') return [];
  const target = toolTarget(event);
  return target ? [target] : [];
}

/**
 * Paths this mission changed.
 *
 * A succeeded `propose_file_change` is the direct signal, but Core executes an
 * auto-authorized in-scope mutation under its own attempt, so that event never
 * reaches the mission attempt's activity stream and cannot be the only source.
 * The mission attempt does receive the post-mutation validation and the passing
 * diff review, both of which name the mutated paths on Core's own authority —
 * and the reviewed manifest is exactly what delivery is allowed to commit.
 *
 * Core's structured check evidence is preferred when present. The output match
 * below is the fallback for records written before Core persisted it, and is
 * the only reason this still reads prose at all.
 */
function changedPath(event: DesktopActivityEvent): string[] {
  if (!isToolEnd(event) || status(event) !== 'succeeded') return [];
  const name = toolName(event);
  if (name === 'propose_file_change' || name === 'propose_text_edit' || name === 'workspace_validation') {
    const target = toolTarget(event);
    return target ? [target] : [];
  }
  if (name !== 'run_check') return [];
  const check = event.check;
  if (check) {
    if (check.status !== 'passed') return [];
    if (check.kind !== 'diff_review' && check.kind !== 'commit') return [];
    return [...(check.reviewedPaths ?? [])];
  }
  const reviewed = /diff review passed for (.+)$/.exec(event.summary.trim());
  return reviewed ? reviewed[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function inferPhase(events: readonly DesktopActivityEvent[]): CockpitPhase {
  let phase: CockpitPhase = 'investigation';
  for (const event of events) {
    if (changedPath(event).length && phase === 'investigation') phase = 'implementation';
    if (isRepairFeedback(event)) phase = 'repair';
  }
  return phase;
}

function countProductive(events: readonly DesktopActivityEvent[]): number {
  return events.filter((event) => {
    if (!isToolEnd(event) || status(event) === 'cancelled') return false;
    if (['protocol_correction', 'workspace_validation', 'verify_acceptance', 'authorize_mission'].includes(toolName(event))) return false;
    if (toolArguments(event).cached === true) return false;
    return true;
  }).length;
}

function countRepairs(events: readonly DesktopActivityEvent[]): number {
  return events.filter(isRepairFeedback).length;
}

function isRepairFeedback(event: DesktopActivityEvent): boolean {
  return isToolEnd(event) && status(event) === 'failed'
    && ['workspace_validation', 'verify_acceptance'].includes(toolName(event));
}

function inferCurrentAction(events: readonly DesktopActivityEvent[]): CockpitCurrentAction | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.eventType === 'model_invocation_started' || event.summary === 'model_invocation:model_invocation_started') {
      if (!events.slice(i + 1).some((item) => item.eventType === 'model_invocation_completed'
        && (!event.invocationId || item.invocationId === event.invocationId))) {
        return { title: 'AI response', startedAt: event.at };
      }
    }
    if (event.eventType === 'tool_invocation_started' || event.summary.startsWith('tool start:')) {
      if (!events.slice(i + 1).some((item) => isToolEnd(item)
        && (!event.invocationId || item.invocationId === event.invocationId))) {
        return { title: humanTool(toolName(event), toolTarget(event)), startedAt: event.at };
      }
    }
  }
  return null;
}

function lastStatus(events: readonly DesktopActivityEvent[], tool: string, fallback: string): string {
  let last: DesktopActivityEvent | null = null;
  for (const event of events) {
    if (toolName(event) === tool && (isToolStart(event) || isToolEnd(event))) last = event;
  }
  if (!last) return fallback;
  if (isToolStart(last)) return 'Running';
  if (status(last) === 'failed') return `Failed: ${toolDetail(last.summary) ?? tool}`;
  if (status(last) === 'cancelled') return 'Cancelled';
  return status(last) === 'succeeded' ? 'Passed' : 'Unknown';
}

function terminalOutcome(events: readonly DesktopActivityEvent[]): string {
  const last = [...events].reverse().find((event) => event.kind === 'error' || event.kind === 'cancelled' || event.kind === 'result'
    || event.eventType === 'attempt_failed');
  if (last?.kind === 'result') return last.text || last.summary;
  if (last?.kind === 'cancelled') return last.summary;
  if (last?.kind === 'error') return last.summary;
  return last?.summary || '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
