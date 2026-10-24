import * as crypto from 'crypto';
import { ToolCall, ToolDefinition } from '../tools/ToolTypes';
import { validateToolArguments } from '../tools/ToolArgumentValidator';
import { ModelProfile, ToolProtocol } from './ModelProfiles';
import { ConservativeTokenCounter } from './ContextBudget';

export type ToolReliabilityCode =
  | 'unsupported_tool_protocol'
  | 'unknown_tool'
  | 'malformed_tool_call'
  | 'tool_call_repair_failed'
  | 'ambiguous_tool_call_candidates'
  | 'duplicate_tool_call'
  | 'tool_loop_detected';

/**
 * Repair telemetry for one assistant response. Never carries candidate text
 * or arguments — only sizes, budget and classification.
 */
export interface ToolRepairReport {
  attempted: boolean;
  candidateTokens?: number;
  budgetTokens: number;
  result?: 'succeeded' | 'failed';
  failure?: ToolReliabilityCode;
}

export interface ToolNormalizationResult {
  ok: boolean;
  calls: ToolCall[];
  textContent: string;
  steps: string[];
  repaired: boolean;
  repair: ToolRepairReport;
  code?: ToolReliabilityCode;
  reason?: string;
}

export interface ToolNormalizationInput {
  content: string;
  nativeCalls: ToolCall[] | undefined;
  tools: ToolDefinition[];
  profile: ModelProfile;
  /**
   * The repair token budget (normally the plan's repair reserve). A repair is
   * attempted at most once per assistant response and only when the single
   * malformed candidate fits within this budget.
   */
  repairBudgetTokens: number;
}

interface EnvelopeCandidate {
  protocol: ToolProtocol;
  step: string;
  /** Raw candidate text (JSON body for JSON-like candidates). */
  text: string;
  /** The full original span to strip from the assistant text. */
  original: string;
  /** For qwen-xml <function=...> blocks: pre-extracted call or structural failure. */
  xmlParsed?: { ok: true; call: ToolCall } | { ok: false; reason: string };
}

const XML_FUNCTION_PATTERN = /<function=([A-Za-z0-9_]+)>\s*([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/g;
const XML_PARAMETER_PATTERN = /<parameter=([A-Za-z0-9_]+)>\s*([\s\S]*?)<\/parameter>/g;
const TOOL_CALL_ENVELOPE_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/gi;

function stripSingleBoundaryNewline(value: string): string {
  let result = value;
  if (result.startsWith('\r\n')) { result = result.slice(2); }
  else if (result.startsWith('\n')) { result = result.slice(1); }
  if (result.endsWith('\r\n')) { result = result.slice(0, -2); }
  else if (result.endsWith('\n')) { result = result.slice(0, -1); }
  return result;
}

/**
 * The single authoritative tool-call normalization path.
 *
 * - Native provider calls are accepted only when the profile allows the
 *   native protocol, every tool name is known, and every argument object
 *   validates against the registered schema; otherwise the complete call set
 *   is rejected — nothing is silently filtered. Provider-assigned IDs are
 *   preserved.
 * - Textual envelopes are parsed only for protocols the profile allows
 *   (`qwen-xml`, `json-envelope`); a recognizable envelope in a protocol the
 *   profile does not allow fails with `unsupported_tool_protocol` instead of
 *   passing as prose. A profile declaring `none` never parses textual calls.
 * - A recognized envelope never degrades into ordinary assistant text: an
 *   unknown tool fails with `unknown_tool`, invalid arguments fail with
 *   `malformed_tool_call`, and an unparseable candidate gets at most one
 *   bounded, deterministic repair attempt before `tool_call_repair_failed`.
 * - Plain natural-language responses with no recognizable tool envelope
 *   remain valid text.
 */
export class ToolCallNormalizer {
  private readonly counter = new ConservativeTokenCounter();

  normalize(input: ToolNormalizationInput): ToolNormalizationResult {
    const { tools, profile } = input;
    const validNames = new Set(tools.map(tool => tool.function.name));
    const steps: string[] = [];
    const repair: ToolRepairReport = { attempted: false, budgetTokens: Math.max(0, Math.floor(input.repairBudgetTokens)) };
    const failure = (
      code: ToolReliabilityCode,
      reason: string,
      textContent: string,
    ): ToolNormalizationResult => ({ ok: false, calls: [], textContent, steps, repaired: false, repair, code, reason });

    // --- Native provider tool calls (Blocker 10) -------------------------
    if (input.nativeCalls && input.nativeCalls.length > 0) {
      steps.push('native_tool_calls');
      if (!profile.toolProtocols.includes('openai-tools')) {
        return failure(
          'unsupported_tool_protocol',
          `Model profile ${profile.id} does not allow native tool calls.`,
          input.content,
        );
      }
      for (const call of input.nativeCalls) {
        if (!validNames.has(call.function.name)) {
          return failure(
            'unknown_tool',
            `Model requested unknown tool "${call.function.name}"; the complete call set was rejected.`,
            input.content,
          );
        }
      }
      const validation = this.validateCalls(input.nativeCalls, tools);
      if (!validation.ok) {
        return failure('malformed_tool_call', validation.reason, input.content);
      }
      steps.push('schema_validated');
      // Provider-assigned tool-call IDs pass through untouched.
      return { ok: true, calls: input.nativeCalls, textContent: input.content, steps, repaired: false, repair };
    }

    // --- Textual envelopes ------------------------------------------------
    if (!input.content.trim() || validNames.size === 0) {
      return { ok: true, calls: [], textContent: input.content, steps, repaired: false, repair };
    }

    let cleaned = input.content;
    for (const tag of profile.reasoningTags) {
      const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi');
      if (pattern.test(cleaned)) {
        cleaned = cleaned.replace(pattern, '').trim();
        steps.push(`removed_${tag}_tag`);
      }
    }

    const candidates = this.extractCandidates(cleaned);
    if (candidates.length === 0) {
      return { ok: true, calls: [], textContent: input.content, steps, repaired: false, repair };
    }

    // Protocol gating (Blocker 8): recognizable output in a protocol the
    // profile does not allow fails closed instead of passing as prose.
    for (const candidate of candidates) {
      if (!profile.toolProtocols.includes(candidate.protocol)) {
        return failure(
          'unsupported_tool_protocol',
          `Model emitted a ${candidate.protocol} tool envelope, but profile ${profile.id} does not allow that protocol.`,
          cleaned,
        );
      }
    }

    const calls: ToolCall[] = [];
    const malformed: EnvelopeCandidate[] = [];
    let textContent = cleaned;

    for (const candidate of candidates) {
      if (candidate.xmlParsed) {
        if (!candidate.xmlParsed.ok) {
          return failure('malformed_tool_call', candidate.xmlParsed.reason, cleaned);
        }
        const call = candidate.xmlParsed.call;
        if (!validNames.has(call.function.name)) {
          return failure(
            'unknown_tool',
            `Model requested unknown tool "${call.function.name}" via ${candidate.protocol}.`,
            cleaned,
          );
        }
        const validation = this.validateCalls([call], tools);
        if (!validation.ok) {
          return failure('malformed_tool_call', validation.reason, cleaned);
        }
        steps.push(candidate.step);
        calls.push(call);
        textContent = textContent.replace(candidate.original, '').trim();
        continue;
      }

      const parsed = this.tryParse(candidate.text);
      if (parsed.ok) {
        const shaped = this.toolShapedCalls(parsed.value);
        if (shaped.length === 0) {
          // Valid JSON that is not tool-shaped (e.g. example data) is prose.
          continue;
        }
        for (const shapedCall of shaped) {
          if (!validNames.has(shapedCall.function.name)) {
            return failure(
              'unknown_tool',
              `Model requested unknown tool "${shapedCall.function.name}"; no valid call may become assistant text.`,
              cleaned,
            );
          }
        }
        const validation = this.validateCalls(shaped, tools);
        if (!validation.ok) {
          return failure('malformed_tool_call', validation.reason, cleaned);
        }
        steps.push(candidate.step);
        calls.push(...shaped);
        textContent = textContent.replace(candidate.original, '').trim();
        continue;
      }

      // Parse failure: recognized malformed only when the raw text looks
      // like a tool envelope; anything else (a code fence, etc.) is prose.
      if (this.looksLikeToolEnvelope(candidate)) {
        malformed.push(candidate);
      }
    }

    if (malformed.length > 1) {
      return failure(
        'ambiguous_tool_call_candidates',
        `Model emitted ${malformed.length} malformed tool envelopes; ambiguous multiple candidates are rejected without repair.`,
        cleaned,
      );
    }

    if (malformed.length === 1) {
      const candidate = malformed[0];
      const candidateTokens = this.counter.count(candidate.text, profile.tokenizer);
      repair.candidateTokens = candidateTokens;
      if (repair.budgetTokens <= 0 || candidateTokens > repair.budgetTokens) {
        repair.result = 'failed';
        repair.failure = 'tool_call_repair_failed';
        return failure(
          'tool_call_repair_failed',
          `Malformed tool envelope (${candidateTokens} tokens) exceeds the repair budget (${repair.budgetTokens} tokens).`,
          cleaned,
        );
      }
      repair.attempted = true;
      const repaired = this.repairOnce(candidate.text);
      if (!repaired.ok) {
        repair.result = 'failed';
        repair.failure = 'tool_call_repair_failed';
        return failure(
          'tool_call_repair_failed',
          'Malformed tool envelope could not be repaired deterministically.',
          cleaned,
        );
      }
      const shaped = this.toolShapedCalls(repaired.value);
      if (shaped.length !== 1) {
        repair.result = 'failed';
        repair.failure = 'tool_call_repair_failed';
        return failure(
          'tool_call_repair_failed',
          'Repaired envelope did not contain exactly one tool call.',
          cleaned,
        );
      }
      if (!validNames.has(shaped[0].function.name)) {
        repair.result = 'failed';
        repair.failure = 'unknown_tool';
        return failure('unknown_tool', `Repaired envelope requested unknown tool "${shaped[0].function.name}".`, cleaned);
      }
      const validation = this.validateCalls(shaped, tools);
      if (!validation.ok) {
        // Repair never invents required arguments; schema validation decides.
        repair.result = 'failed';
        repair.failure = 'malformed_tool_call';
        return failure('malformed_tool_call', validation.reason, cleaned);
      }
      repair.result = 'succeeded';
      steps.push(candidate.step, 'single_json_repair');
      calls.push(...shaped);
      textContent = textContent.replace(candidate.original, '').trim();
      return { ok: true, calls, textContent, steps, repaired: true, repair };
    }

    if (calls.length > 0) {
      return { ok: true, calls, textContent, steps, repaired: false, repair };
    }
    return { ok: true, calls: [], textContent: input.content, steps, repaired: false, repair };
  }

  private extractCandidates(content: string): EnvelopeCandidate[] {
    const result: EnvelopeCandidate[] = [];

    for (const match of content.matchAll(XML_FUNCTION_PATTERN)) {
      result.push({
        protocol: 'qwen-xml',
        step: 'xml_function_block',
        text: match[0],
        original: match[0],
        xmlParsed: this.parseXmlFunctionBlock(match[1], match[2]),
      });
    }

    const withoutFunctions = content.replace(XML_FUNCTION_PATTERN, '');
    for (const match of withoutFunctions.matchAll(TOOL_CALL_ENVELOPE_PATTERN)) {
      result.push({
        protocol: 'qwen-xml',
        step: 'xml_tool_call_envelope',
        text: match[1],
        original: match[0],
      });
    }

    for (const match of content.matchAll(FENCED_JSON_PATTERN)) {
      result.push({ protocol: 'json-envelope', step: 'fenced_json', text: match[1], original: match[0] });
    }

    const trimmed = content.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && result.length === 0) {
      result.push({ protocol: 'json-envelope', step: 'json_envelope', text: trimmed, original: content });
    }

    // Only tool-shaped JSON candidates are recognized as envelopes; plain
    // data JSON in a response remains prose. XML forms are always envelopes.
    return result.filter(candidate =>
      candidate.xmlParsed !== undefined ||
      candidate.step === 'xml_tool_call_envelope' ||
      this.looksLikeToolEnvelope(candidate) ||
      this.parsesToToolShape(candidate.text),
    );
  }

  private parseXmlFunctionBlock(name: string, body: string): EnvelopeCandidate['xmlParsed'] {
    const args: Record<string, unknown> = {};
    let parameterCount = 0;
    for (const parameter of body.matchAll(XML_PARAMETER_PATTERN)) {
      const parameterName = parameter[1];
      if (Object.prototype.hasOwnProperty.call(args, parameterName)) {
        return { ok: false, reason: `Duplicate parameter "${parameterName}" in XML tool block.` };
      }
      args[parameterName] = stripSingleBoundaryNewline(parameter[2]);
      parameterCount += 1;
    }
    const residue = body.replace(XML_PARAMETER_PATTERN, '').trim();
    if (parameterCount === 0) {
      return { ok: false, reason: 'XML tool block contained no parameters.' };
    }
    if (residue.length > 0) {
      return { ok: false, reason: 'XML tool block contained unstructured residue outside parameters.' };
    }
    return { ok: true, call: { function: { name, arguments: args } } };
  }

  private looksLikeToolEnvelope(candidate: EnvelopeCandidate): boolean {
    if (candidate.step === 'xml_tool_call_envelope' || candidate.xmlParsed !== undefined) { return true; }
    return /"(?:name|tool)"\s*:/.test(candidate.text) && /"(?:arguments|parameters|args)"\s*:/.test(candidate.text);
  }

  private parsesToToolShape(text: string): boolean {
    const parsed = this.tryParse(text);
    return parsed.ok && this.toolShapedCalls(parsed.value).length > 0;
  }

  private tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false };
    }
  }

  /** Exactly one deterministic repair transform: strip trailing commas. */
  private repairOnce(text: string): { ok: true; value: unknown } | { ok: false } {
    const repairedText = text.replace(/,\s*([}\]])/g, '$1').trim();
    return this.tryParse(repairedText);
  }

  /**
   * Extracts tool-shaped calls from parsed JSON, preserving names verbatim —
   * unknown names are surfaced to the caller for rejection, never filtered.
   */
  private toolShapedCalls(parsed: unknown): ToolCall[] {
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const calls: ToolCall[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') { continue; }
      const obj = item as Record<string, unknown>;
      const fn = typeof obj['function'] === 'object' && obj['function'] !== null ? obj['function'] as Record<string, unknown> : obj;
      const name = typeof fn['name'] === 'string' ? fn['name'] : typeof obj['tool'] === 'string' ? obj['tool'] : undefined;
      const rawArgs = fn['arguments'] ?? fn['args'] ?? obj['arguments'] ?? obj['parameters'];
      if (!name || rawArgs === undefined) { continue; }
      const args = typeof rawArgs === 'string' ? this.parseArgs(rawArgs) : rawArgs;
      if (!args || typeof args !== 'object' || Array.isArray(args)) { continue; }
      calls.push({ function: { name, arguments: args as Record<string, unknown> } });
    }
    return calls;
  }

  private parseArgs(text: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }

  private validateCalls(calls: ToolCall[], tools: ToolDefinition[]): { ok: true } | { ok: false; reason: string } {
    for (const call of calls) {
      const tool = tools.find(item => item.function.name === call.function.name);
      if (!tool) { return { ok: false, reason: `Unknown tool "${call.function.name}".` }; }
      const validation = validateToolArguments(tool, call.function.arguments);
      if (!validation.ok) { return { ok: false, reason: validation.error }; }
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Progress-aware loop detection (Blocker 12)
// ---------------------------------------------------------------------------

export interface LoopDetectionResult {
  ok: boolean;
  code?: ToolReliabilityCode;
  reason?: string;
  pattern?: string;
}

/** What actually happened when a dispatched tool call ran. */
export interface ToolResultObservation {
  ok: boolean;
  /** True only for a successful call that mutated workspace/task state. */
  mutatedWorkspace: boolean;
  /** Stable failure/result classification (e.g. 'failed', 'blocked', 'requires_approval'). */
  classification: string;
  /** Stable fingerprint of the (possibly summarized) tool result. */
  resultFingerprint: string;
}

interface DispatchEntry {
  fp: string;
  epoch: number;
  observation?: ToolResultObservation;
}

const HISTORY_LIMIT = 24;

/**
 * Deterministic, progress-aware loop detection.
 *
 * Progress epochs advance when a successful call mutates workspace/task
 * state, or when a repeated call's result fingerprint changes (the world is
 * still changing). Within one epoch:
 * - an immediately repeated identical call is blocked (`duplicate_tool_call`);
 * - an A/B/A/B cycle is blocked only when the two A results are identical
 *   (no progress) — with progress the cycle is allowed;
 * - the same failure classification for the same call is blocked once it
 *   reaches the profile's `duplicateCallThreshold`.
 * Epoch advancement resets failure counts, so rereading after a mutation and
 * revalidating after a repair are always allowed. Detection happens before
 * dispatch (or at result recording), so no additional side effect occurs
 * after a loop is detected.
 */
export class ToolLoopDetector {
  private readonly entries: DispatchEntry[] = [];
  private readonly failureCounts = new Map<string, number>();
  private epoch = 0;

  constructor(private readonly duplicateCallThreshold: number = 2) {}

  beforeDispatch(call: ToolCall): LoopDetectionResult {
    const fp = fingerprintToolCall(call);
    const last = this.entries[this.entries.length - 1];
    if (last && last.fp === fp && last.epoch === this.epoch) {
      return {
        ok: false,
        code: 'duplicate_tool_call',
        reason: 'Stopped duplicate tool call: the identical call already ran with no intervening progress.',
        pattern: 'A -> A',
      };
    }

    const len = this.entries.length;
    if (len >= 3) {
      const [a1, b1, a2] = [this.entries[len - 3], this.entries[len - 2], this.entries[len - 1]];
      const sameEpoch = a1.epoch === this.epoch && b1.epoch === this.epoch && a2.epoch === this.epoch;
      const cycle = sameEpoch && a1.fp === a2.fp && b1.fp === fp && a1.fp !== fp;
      const noProgress =
        cycle &&
        a1.observation !== undefined &&
        a2.observation !== undefined &&
        a1.observation.resultFingerprint === a2.observation.resultFingerprint;
      if (noProgress) {
        return {
          ok: false,
          code: 'tool_loop_detected',
          reason: 'Stopped repeating A/B/A/B tool-call cycle: intervening results show no progress.',
          pattern: 'A -> B -> A -> B',
        };
      }
    }

    this.entries.push({ fp, epoch: this.epoch });
    if (this.entries.length > HISTORY_LIMIT) { this.entries.shift(); }
    return { ok: true };
  }

  recordResult(call: ToolCall, observation: ToolResultObservation): LoopDetectionResult {
    const fp = fingerprintToolCall(call);
    let entry: DispatchEntry | undefined;
    let previous: DispatchEntry | undefined;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].fp !== fp) { continue; }
      if (!entry && this.entries[index].observation === undefined) {
        entry = this.entries[index];
        continue;
      }
      if (entry && this.entries[index].observation !== undefined) {
        previous = this.entries[index];
        break;
      }
    }
    if (entry) { entry.observation = observation; }

    if (observation.ok && observation.mutatedWorkspace) {
      this.advanceEpoch();
      return { ok: true };
    }

    if (observation.ok) {
      if (
        previous &&
        previous.epoch === this.epoch &&
        previous.observation &&
        previous.observation.resultFingerprint !== observation.resultFingerprint
      ) {
        // Changed tool result: the world is still changing — reset the
        // no-progress history so continued observation is allowed.
        this.advanceEpoch();
      }
      return { ok: true };
    }

    const key = `${fp}:${observation.classification}`;
    const count = (this.failureCounts.get(key) ?? 0) + 1;
    this.failureCounts.set(key, count);
    if (count >= Math.max(1, this.duplicateCallThreshold)) {
      return {
        ok: false,
        code: 'tool_loop_detected',
        reason: `Stopped repeated failed tool call: the same call failed with the same classification ${count} times without progress.`,
        pattern: 'repeated_failure',
      };
    }
    return { ok: true };
  }

  private advanceEpoch(): void {
    this.epoch += 1;
    this.failureCounts.clear();
  }
}

export function fingerprintToolCall(call: ToolCall): string {
  return crypto.createHash('sha256').update(`${call.function.name}:${stableJson(call.function.arguments)}`).digest('hex');
}

/** Stable fingerprint of a tool result payload; the raw data is never retained. */
export function fingerprintToolResult(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') { return JSON.stringify(value) ?? 'undefined'; }
  if (Array.isArray(value)) { return `[${value.map(stableJson).join(',')}]`; }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}
