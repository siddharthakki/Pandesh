/**
 * Implicit specialist routing: the owner describes an outcome ("how much graphics memory is free?") without naming a
 * specialist, and Core hands the request to the one whose job it is, exactly as it already does when the owner says
 * "ask Operations".
 *
 * Deliberately small and conservative, because a small lead model cannot be trusted to choose and a wrong hand-off
 * costs a whole extra agent run:
 *  - only READ-ONLY, local, no-approval work is routed on its own (PC state for Operations); anything that changes
 *    something, goes online or needs the owner's files keeps today's path (the lead model and its tool selection);
 *  - a question about the agents, a negation or a change request is never routed;
 *  - it is a pure function: no model call, no I/O, nothing to authorize. The hand-off itself still passes every Core
 *    gate (the specialist's frozen scope, approvals, Plan Only) because it uses the same `delegate_to_agent` path.
 * Off unless PANDESH_IMPLICIT_SPECIALISTS=1 (so nothing changes for anyone until it is measured and accepted).
 */
import type { SpecialistId } from './agentRouting';

export interface IntentRoute { agent: SpecialistId; rule: string }

/** What the PC is doing or holds: facts only Operations' read-only tools can report. */
const PC_STATE = /\b(?:(?:free|available|used|left|remaining)\s+(?:disk\s+|drive\s+|storage\s+)?(?:space|memory|vram|storage)|disk\s+space|storage\s+(?:space|left|free)|graphics\s+memory|vram|gpu(?:\s+(?:memory|usage|temperature|load))?|cpu\s+(?:usage|load)|ram\b|listening\s+ports?|open\s+ports?|which\s+ports?|installed\s+(?:apps?|programs?|software)|printers?|network\s+drives?|system\s+(?:health|status|info(?:rmation)?|diagnostics?)|(?:pc|computer|machine)\s+(?:health|status|specs?)|hardware\s+(?:info|specs?|telemetry)|ollama\s+models?\s+(?:installed|i\s+have)|which\s+models?\s+(?:are\s+)?installed)\b/i;
const ASKS_FOR_FACT = /\b(?:how\s+(?:much|many|full)|what(?:'s|\s+is|\s+are)?|which|show|list|tell\s+me|check|is\s+there|do\s+i\s+have|report|status\s+of)\b/i;
/** Anything that changes the machine, goes online or is about files: not routed here. */
const NOT_READ_ONLY = /\b(?:delete|remove|uninstall|install|kill|stop|restart|reboot|shut\s*down|format|clean(?:\s*up)?|free\s+up|organi[sz]e|move|rename|print\s+(?:a|the|this)|download|upload|send|email|search\s+the\s+web|look\s+(?:it\s+)?up\s+online)\b/i;
const ABOUT_AGENTS = /\b(?:agents?|specialists?)\b[^.?!]*\b(?:can|could|do|does|work|available)\b/i;
const NEGATED = /\b(?:don'?t|do\s+not|never|without|no\s+need\s+to)\s+(?:\w+\s+){0,3}(?:check|look|list|show|use|ask)\b/i;

export function implicitSpecialistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PANDESH_IMPLICIT_SPECIALISTS === '1';
}

/** The specialist whose job this request is, or null when the lead model should handle it as today. */
export function implicitSpecialistRequest(text: string | null | undefined): IntentRoute | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 400) return null;
  if (NOT_READ_ONLY.test(t) || NEGATED.test(t) || ABOUT_AGENTS.test(t)) return null;
  if (PC_STATE.test(t) && ASKS_FOR_FACT.test(t)) return { agent: 'operations', rule: 'pc_state_read_only' };
  return null;
}
