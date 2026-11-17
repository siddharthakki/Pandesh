/**
 * The lead's mission tools (see core/domain/missions.ts and missionRunner.ts).
 *
 * `mission_start` is how the lead hands over work that is too long to wait for: it writes the plan, Core checks every
 * step against the same boundaries a direct hand-off meets (the specialist exists and is on, the brief carries no
 * memory the specialist may not read, nothing it names is outside the specialist's scope, internet use has the
 * person's yes), stores the mission and returns at once. `mission_manage` reads progress, cancels or continues.
 *
 * These are plain tool objects for piAgentEngine; everything that needs the engine's own state comes in as a callback.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { getAgentDefinition, listAgentDefinitions } from '../domain/agents';
import {
  createMission, findMission, getMission, listMissions, reopenMission, requestMissionCancel, similarFinishedMissions,
  RESUMABLE_MISSION_STATUSES, type Mission, type MissionStepInput,
} from '../domain/missions';

/**
 * The specialists a mission can use, read from the agent definitions (built-in, overridden or custom): no list is kept
 * here, so a specialist the owner adds or turns off changes what the lead is offered without a code change. A
 * specialist is usable when it is on, has tools of its own, and at least one of them exists in this build.
 */
export interface RosterEntry { id: string; name: string; role: string; online: boolean; ready: boolean; missing: string[]; maxMinutes: number }

export function missionRoster(db: CoreDatabase, knownToolNames?: readonly string[]): RosterEntry[] {
  const known = knownToolNames ? new Set(knownToolNames) : null;
  const exists = (pattern: string) => !known || (pattern.endsWith('*') ? [...known].some((n) => n.startsWith(pattern.slice(0, -1))) : known.has(pattern));
  return listAgentDefinitions(db)
    .filter((a) => a.id !== 'chief' && a.enabled && a.availability === 'available' && a.tools.length > 0)
    .map((a) => {
      const missing = a.tools.filter((t) => !exists(t));
      return { id: a.id, name: a.name, role: a.role, online: a.egress !== 'none', ready: missing.length < a.tools.length, missing, maxMinutes: Math.round(a.limits.maxWallSeconds / 60) };
    });
}

function rosterText(roster: RosterEntry[]): string {
  return roster.filter((r) => r.ready).map((r) => `${r.id}: ${r.role}${r.online ? ' [may go online, with the user\'s OK]' : ' [local only]'}`).join('; ');
}

export interface MissionToolDeps {
  db: CoreDatabase;
  attemptId: string;
  conversationId: string | null;
  clientId: string;
  workspaceRoot: string | null;
  defaults: { selectedProvider?: string | null; selectedModel?: string | null };
  runner: { start(missionId: string): void; cancel(missionId: string): void };
  /** Core's hand-off checks for one step (memory the agent may not read, targets outside its scope). Null = allowed. */
  checkStep: (agentId: string, brief: string) => string | null;
  /** One approval card; resolves to the approval id, or a refusal text for the model. */
  askInternet: (card: string, agents: string[]) => Promise<{ ok: true; approvalId: string | null } | { ok: false; text: string }>;
  record: (eventType: string, metadata: Record<string, unknown>) => void;
  /** Tool names that exist in this turn's build, for specialist readiness. */
  knownToolNames?: () => string[];
  /** The user asked for an independent check: Core adds the review step whether or not the plan asks for it. */
  forceReview?: boolean;
  /** Test seam: where mission folders are created (default: Documents/Pandesh/Missions, or PANDESH_MISSIONS_DIR). */
  missionsRoot?: string;
}

/**
 * A mission started without a selected folder gets a new, empty folder of its own. Its specialists may read and write
 * there (each write still asks), and a reviewer can open what a maker left. Nothing that already exists on the PC
 * becomes reachable this way: the folder is created here and starts empty.
 */
export function createMissionFolder(objective: string, root?: string): string | null {
  try {
    const base = root ?? process.env.PANDESH_MISSIONS_DIR ?? path.join(os.homedir(), 'Documents', 'Pandesh', 'Missions');
    const slug = objective.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mission';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    let dir = path.join(base, `${stamp}-${slug}`);
    for (let i = 2; fs.existsSync(dir) && i < 50; i += 1) dir = path.join(base, `${stamp}-${slug}-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; details?: Record<string, unknown> };
const text = (t: string, isError = false, details?: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}), ...(details ? { details } : {}) });

const STEP_WORD: Record<string, string> = { pending: 'waiting', running: 'RUNNING', succeeded: 'done', unverified: 'done (not verified)', failed: 'FAILED', skipped: 'not started', cancelled: 'cancelled' };

export function describeMission(db: CoreDatabase, m: Mission, detail: 'line' | 'full' = 'full'): string {
  const name = (id: string) => { try { return getAgentDefinition(db, id).name; } catch { return id; } };
  const done = m.steps.filter((s) => s.status === 'succeeded' || s.status === 'unverified').length;
  const head = `Mission ${m.id.slice(0, 12)} "${m.objective.slice(0, 120)}": ${m.status.replace(/_/g, ' ')} (${done}/${m.steps.length} steps done, started ${m.createdAt.slice(11, 16)} UTC)`;
  if (detail === 'line') {
    const current = m.steps.find((s) => s.status === 'running');
    return `${head}${current ? `; now: step ${current.idx + 1}, ${name(current.agentId)} agent, ${current.title}` : ''}`;
  }
  const lines = [head];
  for (const s of m.steps) {
    const tools = s.evidence?.verified.map((v) => v.tool).join(', ');
    lines.push(`  ${s.idx + 1}. ${name(s.agentId)} · ${s.title}: ${STEP_WORD[s.status] ?? s.status}${s.evidence?.seconds ? ` in ${s.evidence.seconds}s` : ''}${tools ? `; tools run: ${tools}` : ''}${s.error ? `; ${s.error.slice(0, 200)}` : ''}`);
  }
  if (m.resultSummary) lines.push(`  Outcome: ${m.resultSummary}`);
  return lines.join('\n');
}

/**
 * The user asked for work to be done while they keep talking ("meanwhile I want to keep talking to you", "do it in the
 * background", "while that runs"). That is a statement about HOW to work, and only a mission gives it: a direct tool
 * call or a hand-off the lead waits for both hold the conversation. Found live: on the same request a 9B lead started
 * a mission once and worked inline the next time. Core therefore decides the mode from the user's words and offers
 * the turn only the mission tools; the model still decides the plan.
 */
export function wantsBackgroundWork(request: string | null | undefined): boolean {
  const text = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 40) return false;
  if (/\b(?:don't|do not|no need to|not)\b[^.?!]{0,30}\b(?:background|meanwhile)\b/i.test(text)) return false;
  return /\b(?:in the background|as a (?:background )?mission|keep (?:talking|chatting|working) (?:to|with) you|keep (?:talking|chatting)\b|continue (?:talking|chatting|our conversation)|carry on (?:talking|chatting)|while (?:you|that|it|this) (?:works?|runs?|is running|is working))\b|\b(?:meanwhile|in the meantime)\b[^.?!]{0,60}\b(?:talk|chat|ask you|conversation|other things)\b/i.test(text);
}

/** What a turn that was asked to work in the background did about it, from its recorded tool calls. */
export function missionOutcome(calls: ReadonlyArray<{ tool: string; status: string }>): 'started' | 'managed' | 'refused' | 'none' {
  const starts = calls.filter((c) => c.tool === 'mission_start');
  if (starts.some((c) => c.status === 'completed')) return 'started';
  // Continuing a stopped mission is also real background work.
  if (calls.some((c) => c.tool === 'mission_manage' && c.status === 'completed' && /MISSION CONTINUED/.test(resultText(c)))) return 'started';
  if (starts.length) return 'refused';
  // The turn looked at, stopped or tried to continue an existing mission: that is an answer, not a missing start.
  return calls.some((c) => c.tool === 'mission_manage' && c.status === 'completed') ? 'managed' : 'none';
}

/** The reply only asks the user something back (what exactly, which folder): nothing was claimed, so nothing to correct. */
export function onlyAsksBack(reply: string): boolean {
  const text = reply.trim();
  if (!text.endsWith('?')) return false;
  return !/\b(?:i(?:'ve| have)\s+(?:started|launched|begun|kicked off|initiated|assigned|set up)|is (?:now )?(?:running|under way|underway|in progress)|(?:has|have) been (?:started|launched|assigned)|mission (?:started|is running))\b/i.test(text);
}

function resultText(call: unknown): string {
  const r = (call as { result?: { content?: Array<{ text?: string }> } }).result;
  return String(r?.content?.[0]?.text ?? '');
}

/** Why Core refused the last mission_start of the turn (its own words, one line). */
export function lastMissionRefusal(calls: ReadonlyArray<{ tool: string; status: string }>): string | null {
  const last = [...calls].reverse().find((c) => c.tool === 'mission_start' && c.status !== 'completed');
  const text = last ? resultText(last).replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 300) : null;
}

/** Core's one request to a model that answered a background-work request in words. */
export const MISSION_START_REASK = 'Pandesh Core: the user asked for this to be done while they keep talking to you, and you have started nothing: this turn contains no mission_start call, so no specialist is working. Do not answer in words. Call mission_start now with the objective and one to three steps (each: agent, title, brief), and review set to true if the user asked for the work to be checked.';

/**
 * Core's own reply when background work was asked for and no mission exists at the end of the turn. It replaces the
 * model's text: an account of a mission that was never started must not reach the user. (Worded without "in the
 * background", so the promise audit does not add a second correction to a statement that is already Core's.)
 */
export function missionNotStartedReply(model: string, refusal: string | null): string {
  return [
    '**Nothing was started.**',
    refusal
      ? `You asked me to work on this while we keep talking. I planned it, but Pandesh Core refused the plan: ${refusal}`
      : `You asked me to work on this while we keep talking, but the model answering this turn${model ? ` (${model})` : ''} did not hand the work to a specialist, even after Pandesh Core asked it to.`,
    'No specialist is working on it and no report will arrive.',
    refusal ? 'Tell me how to change the request and I will plan it again.' : 'Ask again, or pick another local model in the model menu and repeat the request.',
  ].join(' ');
}

/** What the lead is told about missions at the start of a turn: running ones anywhere, and this conversation's latest. */
export function missionTurnFact(db: CoreDatabase, conversationId: string | null, requestText: string): string | null {
  const parts: string[] = [];
  try {
    const running = listMissions(db, { activeOnly: true, limit: 5 });
    const recent = conversationId ? listMissions(db, { conversationId, limit: 3 }).filter((m) => m.status !== 'running' && Date.now() - Date.parse(m.updatedAt) < 2 * 3600_000) : [];
    if (running.length || recent.length) {
      parts.push('MISSIONS (background work Pandesh Core is running or ran for the user; live records, not memory):');
      for (const m of running) parts.push(`- ${describeMission(db, m, 'line')}${m.conversationId !== conversationId ? ' (started in another conversation)' : ''}`);
      for (const m of recent) parts.push(`- ${describeMission(db, m, 'line')}${m.reportMessageId ? '; its full report is in this conversation' : ''}`);
      parts.push('While a mission runs you stay free: answer the user\'s newest message normally. For "how is it going", "stop it", "continue it" call mission_manage; never guess a mission\'s progress or result.');
    }
    if (requestText.trim().length > 60) {
      const similar = similarFinishedMissions(db, requestText, 1)[0];
      if (similar) parts.push(`A SIMILAR MISSION FINISHED BEFORE (${similar.status.replace(/_/g, ' ')}), with this plan: ${similar.steps.map((s) => `${s.idx + 1}. ${s.agentId}: ${s.title}`).join('; ')}. Reuse the plan if it fits this request.`);
    }
  } catch { return null; }
  return parts.length ? parts.join('\n') : null;
}

export function buildMissionTools(deps: MissionToolDeps): Array<{ name: string; label: string; description: string; parameters: Record<string, unknown>; execute: (toolCallId: string, args: any) => Promise<ToolResult> }> {
  const { db } = deps;
  const roster = () => missionRoster(db, deps.knownToolNames?.());
  const available = () => { const ready = new Set(roster().filter((r) => r.ready).map((r) => r.id)); return listAgentDefinitions(db).filter((a) => ready.has(a.id)); };
  const rosterNow = roster();

  const start = {
    name: 'mission_start',
    label: 'mission_start',
    description: `Start a mission: substantial work that runs in the BACKGROUND while you keep talking to the user. Use it when the work takes more than about a minute, has several parts, needs more than one specialist, or should be checked by a second specialist (inspect something then fix it then review it; research then write; produce a video, a report, a build). You write the plan as ordered steps, each for one specialist. Choose by what the work needs; the specialists available now are: ${rosterText(rosterNow)}. Later steps receive the earlier steps\' results. Give every step real work for that specialist\'s own tools, and keep the plan short (one to three steps is usual): the specialist that gathers the facts also analyses them, so never add a step that only thinks about an earlier step\'s result, and use coding only when code has to be read, changed or run. Do not add a reviewer step yourself. Set review=true to add an independent Reviewer step at the end that checks the real output; do that for anything the user will rely on. The call returns at once; a report is posted in this conversation when the mission ends. For one quick specialist job whose answer the user is waiting for, use delegate_to_agent instead.`,
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'The outcome the user wants, in one or two sentences, including any limit they set (for example: do not publish, do not delete).' },
        steps: {
          type: 'array', minItems: 1, maxItems: 5,
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string', enum: rosterNow.filter((r) => r.ready).map((r) => r.id) },
              title: { type: 'string', description: 'Three to six words naming the step.' },
              brief: { type: 'string', description: 'For a specialist that has not seen this chat: what to do, the facts it needs, what to return, what done looks like. Your own words only.' },
              parallel: { type: 'boolean', description: 'true: this step does not need the result of the step before it and may run at the same time (independent work only).' },
            },
            required: ['agent', 'title', 'brief'],
          },
        },
        review: { type: 'boolean', description: 'true: an independent Reviewer checks the result at the end.' },
      },
      required: ['objective', 'steps'],
    },
    execute: async (_toolCallId: string, args: any): Promise<ToolResult> => {
      if (!deps.conversationId) return text('NOT DONE: a mission needs a conversation to report into.', true);
      const objective = String(args?.objective ?? '').trim();
      const raw: unknown[] = Array.isArray(args?.steps) ? args.steps : [];
      const usable = new Map(available().map((a) => [a.id, a]));
      const steps: MissionStepInput[] = [];
      for (const [i, r] of raw.entries()) {
        const s = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        const agentId = String(s.agent ?? '').trim().toLowerCase();
        const agent = usable.get(agentId);
        if (!agent) return text(`NOT DONE: step ${i + 1} names the agent "${agentId}", which does not exist or is turned off. Available: ${[...usable.keys()].join(', ')}. Call mission_start again with a valid plan.`, true);
        const brief = String(s.brief ?? '').trim();
        const refusal = deps.checkStep(agentId, brief);
        if (refusal) return text(`NOT DONE (refused by Pandesh Core before anything started): step ${i + 1} for the ${agent.name} agent: ${refusal}. Nothing was started. Tell the user exactly that; fix the plan only if the refusal says how.`, true);
        steps.push({ agentId, title: String(s.title ?? '').trim() || `${agent.name} step`, brief, kind: agentId === 'reviewer' ? 'review' : 'work', parallel: s.parallel === true });
      }
      if ((args?.review === true || deps.forceReview === true) && usable.has('reviewer') && steps.length && steps[steps.length - 1].agentId !== 'reviewer') {
        steps.push({
          agentId: 'reviewer', kind: 'review', title: 'Independent review',
          brief: `Independently check the result of this mission against its objective: "${objective.slice(0, 600)}". The mission context lists the files the earlier steps left on disk and their reports. Inspect the real output with your tools (list_directory and read_file for text; media_inspect for a video, audio or image file, with a question naming what must be visible when the content of the pictures matters); do not rely on what the earlier agents say they did. Say which parts you measured, which you looked at, and which you could not check; list anything the objective asked for that is missing or empty. Report the verdict first (ready, fix first, or cannot verify), then each problem with the file it is in, then what you could not check. Change nothing.`,
        });
      }
      const online = [...new Set(steps.filter((s) => usable.get(s.agentId)!.egress !== 'none').map((s) => usable.get(s.agentId)!.name))];
      let egressApprovalId: string | null = null;
      if (online.length) {
        const asked = await deps.askInternet(`Pandesh wants to start a background mission: "${objective.slice(0, 200)}". In it, the ${online.join(' and ')} agent${online.length > 1 ? 's' : ''} may use the internet (public searches and public pages; nothing private is sent).`, online);
        if (!asked.ok) return text(asked.text, true);
        egressApprovalId = asked.approvalId;
      }
      let mission: Mission;
      const ownFolder = deps.workspaceRoot ? null : createMissionFolder(objective, deps.missionsRoot);
      try {
        mission = createMission(db, {
          conversationId: deps.conversationId, parentAttemptId: deps.attemptId, clientId: deps.clientId, objective, steps,
          workspaceRoot: deps.workspaceRoot ?? ownFolder, selectedProvider: deps.defaults.selectedProvider ?? null, selectedModel: deps.defaults.selectedModel ?? null, egressApprovalId,
        });
      } catch (err) {
        if (ownFolder) { try { fs.rmdirSync(ownFolder); } catch { /* not empty or gone */ } }
        return text(`NOT DONE (mission refused by Core): ${err instanceof Error ? err.message : String(err)}. Tell the user exactly that.`, true);
      }
      deps.record('mission_created', { missionId: mission.id, steps: mission.steps.map((s) => ({ agent: s.agentId, title: s.title, kind: s.kind })) });
      deps.runner.start(mission.id);
      const plan = mission.steps.map((s) => `${s.idx + 1}. ${usable.get(s.agentId)?.name ?? s.agentId}: ${s.title}`).join('\n');
      return text(`MISSION STARTED in the background (id ${mission.id}).\n${plan}\n${mission.workspaceRoot ? `Working folder (files the mission makes go here): ${mission.workspaceRoot}\n` : ''}\nThe steps run on their own now, one after another. Progress shows on the mission card in this conversation, anything that needs the user's OK appears there, and Core posts a full report here when it ends. Your turn is finished: tell the user in two or three sentences what you started and who does what, and that they can keep talking to you meanwhile. Do not wait for it, do not call mission_manage now, and do not describe any result: none exists yet.`, false,
        { missionId: mission.id, activity: { kind: 'tool', title: `Mission started: ${mission.steps.length} steps`, excerpt: plan } });
    },
  };

  const manage = {
    name: 'mission_manage',
    label: 'mission_manage',
    description: 'Look at or control a background mission. action "status": progress of each step, the tools that really ran and any failure (use it whenever the user asks how the work is going; never answer that from memory). "cancel": stop it now; finished steps are kept. "continue": pick up a failed, cancelled or interrupted mission from its first unfinished step. Leave "mission" empty for the most recent one.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['status', 'cancel', 'continue'] }, mission: { type: 'string', description: 'A mission id (msn_…); empty = the most recent one.' } },
      required: ['action'],
    },
    execute: async (_toolCallId: string, args: any): Promise<ToolResult> => {
      const action = String(args?.action ?? 'status');
      const wanted = String(args?.mission ?? '').trim();
      let mission: Mission | null = null;
      if (wanted) {
        mission = findMission(db, wanted) ?? listMissions(db, { limit: 50 }).find((m) => m.id.startsWith(wanted)) ?? null;
        if (!mission) return text(`NOT DONE: there is no mission "${wanted}".`, true);
      } else {
        const here = deps.conversationId ? listMissions(db, { conversationId: deps.conversationId, limit: 5 }) : [];
        const all = listMissions(db, { limit: 5 });
        mission = (action === 'continue' ? [...here, ...all].find((m) => RESUMABLE_MISSION_STATUSES.has(m.status)) : null)
          ?? here.find((m) => m.status === 'running') ?? all.find((m) => m.status === 'running') ?? here[0] ?? all[0] ?? null;
        if (!mission) return text('There are no missions yet: nothing is running in the background and none has run.');
      }
      if (action === 'cancel') {
        if (mission.status !== 'running') return text(`Nothing to cancel: ${describeMission(db, mission, 'line')}.`);
        requestMissionCancel(db, mission.id);
        deps.runner.cancel(mission.id);
        deps.record('mission_cancel_requested', { missionId: mission.id });
        return text(`CANCEL REQUESTED for mission ${mission.id}. The step that is running is being stopped; steps that already finished are kept. Tell the user it is stopping; Core posts the final state in this conversation.\n${describeMission(db, getMission(db, mission.id))}`);
      }
      if (action === 'continue') {
        if (!RESUMABLE_MISSION_STATUSES.has(mission.status)) return text(`NOT DONE: ${describeMission(db, mission, 'line')}. Only a failed, cancelled or interrupted mission can be continued.`, true);
        try { mission = reopenMission(db, mission.id); } catch (err) { return text(`NOT DONE: ${err instanceof Error ? err.message : String(err)}`, true); }
        deps.record('mission_continued', { missionId: mission.id });
        deps.runner.start(mission.id);
        return text(`MISSION CONTINUED in the background from its first unfinished step.\n${describeMission(db, mission)}\nTell the user it is running again; do not describe results that do not exist yet.`);
      }
      return text(`${describeMission(db, mission)}\n\nThis is the live record. Report it as it is; a step that is not "done" has produced nothing yet.`);
    },
  };

  return [start, manage];
}
