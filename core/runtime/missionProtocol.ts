import { createHash } from 'node:crypto';
import type { MissionObservation } from './missionObservations';

export const MAX_PROTOCOL_RETRIES = 8;

export interface RejectedCallSummary {
  name: string;
  summary: Record<string, unknown>;
}

export function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function summarizeRejectedMissionCall(
  name: string,
  args: Record<string, unknown> = {},
): RejectedCallSummary {
  if (name === 'propose_file_change') {
    const content = typeof args.content === 'string' ? args.content : '';
    return {
      name,
      summary: {
        path: String(args.path ?? ''),
        contentLength: Buffer.byteLength(content, 'utf8'),
        contentDigest: digestText(content),
      },
    };
  }
  if (name === 'propose_text_edit') {
    return {
      name,
      summary: {
        path: String(args.path ?? ''),
        findLength: String(args.find ?? '').length,
        replaceLength: String(args.replace ?? '').length,
      },
    };
  }
  if (name === 'search') {
    return { name, summary: { query: String(args.query ?? ''), path: args.path ?? null } };
  }
  if (name === 'read_file') {
    return {
      name,
      summary: { path: String(args.path ?? ''), startLine: args.startLine ?? null, endLine: args.endLine ?? null },
    };
  }
  if (name === 'run_check') {
    return { name, summary: { check: args.check ?? args.kind ?? null, target: args.target ?? null } };
  }
  if (name === 'finish') {
    return { name, summary: { summaryLength: String(args.summary ?? '').length } };
  }
  if (name === 'ask_user') {
    return { name, summary: { questionLength: String(args.question ?? '').length } };
  }
  return { name, summary: { keys: Object.keys(args) } };
}

export function summarizeRejectedMissionCalls(
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>,
): RejectedCallSummary[] {
  return calls.map((call) => summarizeRejectedMissionCall(call.name, call.arguments ?? {}));
}

/** Parser reasons produced by the tolerant inline parser (core/runtime/inlineToolCalls.ts). */
const INLINE_PARSER_REASON = /^(invalid_json|invalid_escape|unknown_tool|invalid_arguments|too_many_tool_calls|ambiguous_json): /;

export function protocolCorrectionObservation(
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>,
  errors: string[],
): MissionObservation {
  const rejectedCalls = summarizeRejectedMissionCalls(calls);
  const listed = rejectedCalls.map((item) => {
    const parts = Object.entries(item.summary)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    return parts ? `${item.name}(${parts})` : item.name;
  });
  const reason = errors.join('; ') || 'exactly one action is required per turn';
  return {
    action: 'protocol_correction',
    resultCount: calls.length,
    truncated: false,
    ok: false,
    rejectedCalls,
    output: calls.length === 0 && INLINE_PARSER_REASON.test(errors[0] ?? '')
      ? `no action ran: ${errors[0]}. Resend only the corrected tool call; do not re-plan the task.`
      : calls.length === 0
      ? 'no action ran: a prose-only reply is not a mission action. Resend exactly one selected action.'
      : `no action ran: ${reason}. Resend exactly one selected action. Rejected: ${listed.join('; ') || '(unnamed calls)'}.`,
  };
}

export function countProtocolCorrections(ledger: ReadonlyArray<{ observation: { action: string } }>): number {
  return ledger.filter((entry) => entry.observation.action === 'protocol_correction').length;
}
