/**
 * M49.2 — tolerant model-facing syntax, strict canonical execution, for the inline/fallback
 * tool-call path. Native provider `tool_calls` are never parsed here; they share only the
 * name/required-argument gate (`validateNativeToolCalls`).
 *
 *   raw reply -> candidate tool objects -> safe structural normalization -> parse ALL
 *   -> validate ALL names/arguments -> ordered call list (or one precise failure).
 *
 * The whole sequence is accepted or refused as a unit; the caller executes nothing on failure.
 * The only repair is appending up to MAX_APPENDED_CLOSERS missing `}`/`]` when the reply ends
 * outside a string with only object/array delimiters open. No string content, escape, path,
 * tool name, value or field is ever altered or invented.
 */
import type { ModelToolCall, ModelToolDefinition } from './modelBackend';
import { validateToolArguments } from './toolArgumentSchema';

export const MAX_INLINE_TOOL_CALLS = 4;
export const MAX_APPENDED_CLOSERS = 2;

export type InlineToolCallFailureCode =
  | 'invalid_json'
  | 'invalid_escape'
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'too_many_tool_calls'
  | 'ambiguous_json';

export interface StructuralRepairRecord {
  step: 'structural_repair_applied';
  appendedClosers: string;
}

export type InlineToolCallsResult =
  /** Nothing in the reply looks like a tool-call attempt: ordinary prose. */
  | { kind: 'none' }
  | { kind: 'calls'; calls: ModelToolCall[]; structuralRepair?: StructuralRepairRecord }
  | { kind: 'failure'; code: InlineToolCallFailureCode; reason: string };

interface Candidate {
  text: string;
  /** Closers appended to make `text` complete (only for an EOF-truncated object). */
  appended: string;
  /** Set when the object ran off the end and could not be safely completed. */
  unterminated?: string;
}

const ESCAPABLE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

function near(text: string, index: number): string {
  const slice = text.slice(Math.max(0, index - 12), index + 18).replace(/\s+/g, ' ');
  return JSON.stringify(slice);
}

/** First invalid escape inside any JSON string of `text`, or null. Read-only; never rewrites. */
function findInvalidEscape(text: string): number | null {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) { if (ch === '"') inString = true; continue; }
    if (ch === '"') { inString = false; continue; }
    if (ch !== '\\') continue;
    const next = text[i + 1];
    if (next === 'u') {
      if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return i;
      i += 5;
    } else if (next === undefined || !ESCAPABLE.has(next)) {
      return i;
    } else {
      i += 1;
    }
  }
  return null;
}

/** Reads the object starting at `start` with a string-aware delimiter stack. */
function scanObject(content: string, start: number): { end: number; closed: boolean; stack: string[]; inString: boolean; stoppedAtFence: boolean } {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '`' && content.startsWith('```', i)) {
      // A closing code fence ends an object that never closed.
      return { end: i, closed: false, stack, inString, stoppedAtFence: true };
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return { end: i, closed: false, stack: ['mismatch'], inString, stoppedAtFence: false };
      if (stack.length === 0) return { end: i + 1, closed: true, stack, inString, stoppedAtFence: false };
    }
  }
  return { end: content.length, closed: false, stack, inString, stoppedAtFence: false };
}

function looksLikeToolAttempt(text: string, names: Set<string>): boolean {
  const nameMatch = /"(?:name|tool)"\s*:\s*"([^"\\]*)"/.exec(text);
  if (!nameMatch) return /"tool_call"\s*:/.test(text) && /"(?:name|tool)"\s*:/.test(text);
  return names.has(nameMatch[1]) || /"(?:arguments|parameters)"\s*:/.test(text) || /"tool_call"\s*:/.test(text);
}

function extractCandidates(content: string, names: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] !== '{') { i += 1; continue; }
    const scan = scanObject(content, i);
    const raw = content.slice(i, scan.end);
    if (scan.closed) {
      if (looksLikeToolAttempt(raw, names)) out.push({ text: raw, appended: '' });
      i = scan.end;
      continue;
    }
    // Did not close. Only a tool attempt matters; unrelated braces in prose are skipped.
    if (!looksLikeToolAttempt(raw, names)) { i += 1; continue; }
    const rest = content.slice(scan.end);
    const endsReply = scan.stoppedAtFence ? /^```\s*$/.test(rest) : true;
    if (scan.stack[0] === 'mismatch') {
      out.push({ text: raw, appended: '', unterminated: 'mismatched closing delimiter' });
    } else if (scan.inString) {
      out.push({ text: raw, appended: '', unterminated: 'reply ended inside a JSON string' });
    } else if (!endsReply) {
      out.push({ text: raw, appended: '', unterminated: 'object never closed before further text' });
    } else if (scan.stack.length > MAX_APPENDED_CLOSERS) {
      out.push({ text: raw, appended: '', unterminated: `${scan.stack.length} closing delimiters missing at EOF (limit ${MAX_APPENDED_CLOSERS})` });
    } else {
      const closers = [...scan.stack].reverse().join('');
      out.push({ text: raw.replace(/\s+$/, '') + closers, appended: closers });
    }
    i = scan.end;
  }
  return out;
}

/** Schema-validates against the tool's declared parameters; run_command's argv-array `command` is the one dispatch coercion (coerceCommand). */
function validateArguments(tool: ModelToolDefinition, args: Record<string, unknown>): string | null {
  return validateToolArguments(tool, args, {
    accepts: (path, value) => tool.name === 'run_command' && path === 'command' && Array.isArray(value),
  });
}

function toCall(parsed: unknown): { name: unknown; args: unknown } | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const inner = obj.tool_call && typeof obj.tool_call === 'object' ? obj.tool_call as Record<string, unknown> : obj;
  const name = inner.name ?? inner.tool;
  if (name === undefined) return null;
  return { name, args: inner.arguments ?? inner.parameters ?? {} };
}

/**
 * Parses every inline tool object in `content`. XML `<function=...>` replies are not handled here
 * (the existing strict parser keeps that path).
 */
export function parseInlineToolCalls(content: string, tools: ModelToolDefinition[]): InlineToolCallsResult {
  const names = new Set(tools.map((tool) => tool.name));
  const candidates = extractCandidates(content, names);
  if (candidates.length === 0) return { kind: 'none' };

  const fail = (code: InlineToolCallFailureCode, reason: string): InlineToolCallsResult => ({ kind: 'failure', code, reason: `${code}: ${reason}` });
  if (candidates.length > MAX_INLINE_TOOL_CALLS) return fail('too_many_tool_calls', `${candidates.length} > ${MAX_INLINE_TOOL_CALLS}`);

  const calls: ModelToolCall[] = [];
  let appended = '';
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const label = candidates.length > 1 ? ` (tool call ${index + 1} of ${candidates.length})` : '';
    // Escape faults are reported precisely and never repaired.
    const badEscape = findInvalidEscape(candidate.text);
    if (badEscape !== null) return fail('invalid_escape', `JSON string contains an invalid escape near ${near(candidate.text, badEscape)}${label}`);
    if (candidate.unterminated) return fail('invalid_json', `${candidate.unterminated}${label}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail('invalid_json', candidate.appended
        ? `missing closing delimiter(s) at EOF; appending "${candidate.appended}" did not give valid JSON (${message})${label}`
        : `${message}${label}`);
    }
    const shaped = toCall(parsed);
    if (!shaped) return fail('ambiguous_json', `object is not a {"name": ..., "arguments": {...}} tool call${label}`);
    if (typeof shaped.name !== 'string') return fail('ambiguous_json', `tool name is not a string${label}`);
    const tool = tools.find((item) => item.name === shaped.name);
    if (!tool) return fail('unknown_tool', `'${shaped.name}' is not an available tool${label}`);
    let args = shaped.args;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return fail('invalid_arguments', `${tool.name} arguments string is not valid JSON${label}`); }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('invalid_arguments', `${tool.name} arguments must be a JSON object${label}`);
    const problem = validateArguments(tool, args as Record<string, unknown>);
    if (problem) return fail('invalid_arguments', `${problem}${label}`);
    calls.push({ name: tool.name, arguments: args as Record<string, unknown> });
    appended += candidate.appended;
  }
  return {
    kind: 'calls',
    calls,
    ...(appended ? { structuralRepair: { step: 'structural_repair_applied' as const, appendedClosers: appended } } : {}),
  };
}

/**
 * Native provider `tool_calls` are not parsed here, but they get the same unit-level gate before anything runs:
 * every call must name an exposed tool and carry its declared required arguments. One bad call refuses the whole
 * reply, exactly like an inline sequence. Nothing is defaulted, repaired or renamed. Types are not checked
 * (`presenceOnly`): the dispatch layer has always coerced native values leniently. Returns the failure, or null.
 */
export function validateNativeToolCalls(
  calls: readonly ModelToolCall[],
  tools: readonly ModelToolDefinition[],
): { code: InlineToolCallFailureCode; reason: string } | null {
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    const label = calls.length > 1 ? ` (tool call ${index + 1} of ${calls.length})` : '';
    const tool = tools.find((item) => item.name === call.name);
    if (!tool) return { code: 'unknown_tool', reason: `unknown_tool: '${call.name}' is not an available tool${label}` };
    const args = call.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { code: 'invalid_arguments', reason: `invalid_arguments: ${tool.name} arguments must be a JSON object${label}` };
    }
    const problem = validateToolArguments(tool, args, { presenceOnly: true });
    if (problem) return { code: 'invalid_arguments', reason: `invalid_arguments: ${problem}${label}` };
  }
  return null;
}

/** Corrective text: states the actual parser reason and asks only for corrected tool calls. */
export function inlineToolCallCorrection(reason: string): string {
  return `Your last reply contained a tool call that could not be used: ${reason}. No tool call was executed. `
    + 'Reply again with only the corrected tool call(s) as valid JSON ({"name": ..., "arguments": {...}}). Do not restart or re-plan the task.';
}
