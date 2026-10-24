import * as crypto from 'node:crypto';
import { canonicalJson } from './approvalArguments';

/**
 * Runtime-event metadata is a notification, not the authority, and
 * `recordRuntimeEvent` hard-fails above 8 KiB. Raw tool arguments (a
 * `propose_file_change.content`, a `find`/`replace` pair, a big shell
 * command) can be arbitrarily large, so any event that carries them goes
 * through this projection first. The complete arguments stay in
 * `tool_invocations.argsSummary` / the approval's action arguments; the event
 * keeps only enough to correlate (`$bytes` + `$sha256`).
 */
export const EVENT_ARGUMENT_INLINE_MAX_BYTES = 512;
export const EVENT_ARGUMENTS_MAX_BYTES = 3072;

export interface ProjectedEventValue {
  $bytes: number;
  $sha256: string;
}

function digest(text: string): ProjectedEventValue {
  return {
    $bytes: Buffer.byteLength(text, 'utf8'),
    $sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

function projectValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') > EVENT_ARGUMENT_INLINE_MAX_BYTES ? digest(value) : value;
  }
  if (Array.isArray(value)) return value.map(projectValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = projectValue(item);
    return out;
  }
  return value;
}

/**
 * Deterministic, idempotent projection of tool arguments for event metadata.
 * Long strings at any depth become `{ $bytes, $sha256 }`; if the result is
 * still over budget (many mid-sized fields), each remaining top-level field
 * larger than 256 bytes is projected too, and as a last resort the whole
 * object collapses to one digest so the event can never fail the attempt.
 */
export function projectEventArguments(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const projected = projectValue(args ?? {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') <= EVENT_ARGUMENTS_MAX_BYTES) return projected;
  const slim: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(projected)) {
    const json = canonicalJson(item);
    slim[key] = Buffer.byteLength(json, 'utf8') > 256 ? digest(json) : item;
  }
  if (Buffer.byteLength(JSON.stringify(slim), 'utf8') <= EVENT_ARGUMENTS_MAX_BYTES) return slim;
  return { $truncated: true, ...digest(canonicalJson(args ?? {})) };
}
