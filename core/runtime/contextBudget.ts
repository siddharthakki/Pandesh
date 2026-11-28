/**
 * Context accounting for local models.
 *
 * Why this exists (production, 2026-11-28): Pandesh estimated prompts as characters / 4. JSON tool definitions and
 * tool results tokenize at about 3 characters per token, so a prompt estimated at 25K tokens was really 32.4K in a
 * 32,768-token window, the model had ~350 tokens left, answered "The", and the turn was recorded as completed.
 *
 * Three small pieces, all pure and deterministic:
 *  - a per-model characters-per-token ratio calibrated from Ollama's real prompt_eval_count,
 *  - a bound for one tool result (what the model sees; the full result stays in the journal),
 *  - a fit step that shrinks the oldest bulky tool results before a call instead of overflowing the window.
 */

/** Conservative until a model has been measured: JSON-heavy prompts measured 2.9–3.2 chars per token. */
export const DEFAULT_CHARS_PER_TOKEN = 3.0;
const MIN_CHARS_PER_TOKEN = 2.0;
const MAX_CHARS_PER_TOKEN = 4.2;

const ratios = new Map<string, number>();

/** Records one real measurement (characters sent, tokens Ollama counted). Smoothed so one odd prompt cannot swing it. */
export function recordPromptCalibration(model: string, totalChars: number, promptTokens: number): void {
  if (!model || !(totalChars > 2_000) || !(promptTokens > 500)) return;
  const observed = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, totalChars / promptTokens));
  const previous = ratios.get(model);
  // Lean low (more tokens per char): under-estimating a prompt is the expensive mistake.
  const next = previous == null ? observed : Math.min(observed, previous * 0.7 + observed * 0.3);
  ratios.set(model, Number(next.toFixed(3)));
}

export function charsPerToken(model: string | undefined): number {
  return (model && ratios.get(model)) || DEFAULT_CHARS_PER_TOKEN;
}

export function estimatePromptTokens(totalChars: number, model: string | undefined): number {
  return Math.ceil(totalChars / charsPerToken(model));
}

/** Test hook. */
export function resetPromptCalibration(): void {
  ratios.clear();
}

/** The most a single tool result may add to the model's context. The complete result is kept in the tool journal. */
export const TOOL_RESULT_MODEL_CAP_CHARS = 12_000;

/**
 * Bounds one tool result for the model. Keeps the start (structure, first items) and a short tail, and says exactly what
 * was left out and how to get it, so the model never mistakes a partial result for a complete one.
 */
export function boundToolResultText(text: string, maxChars = TOOL_RESULT_MODEL_CAP_CHARS): { text: string; omitted: number } {
  if (text.length <= maxChars) return { text, omitted: 0 };
  const tail = Math.min(600, Math.floor(maxChars * 0.1));
  const head = maxChars - tail;
  const omitted = text.length - head - tail;
  const note = `\n[… ${omitted} characters of this result were left out to keep the conversation within the model's window. `
    + 'This is NOT the complete result: narrow the request (a more specific query, one item, one page) to see the rest, and do not claim coverage you have not seen.]\n';
  return { text: `${text.slice(0, head)}${note}${text.slice(text.length - tail)}`, omitted };
}

interface MessageLike { role?: string; content?: unknown }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && typeof part === 'object') {
      const p = part as { type?: string; text?: string; arguments?: unknown };
      if (typeof p.text === 'string') out += p.text;
      else if (p.type === 'toolCall') out += JSON.stringify(p.arguments ?? {});
    }
  }
  return out;
}

export function messagesChars(messages: MessageLike[]): number {
  let n = 0;
  for (const m of messages) n += textOf(m.content).length;
  return n;
}

function withText<T extends MessageLike>(message: T, text: string): T {
  if (typeof message.content === 'string') return { ...message, content: text };
  const parts = Array.isArray(message.content) ? message.content : [];
  let replaced = false;
  const next = parts.map((p) => {
    if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
      if (replaced) return { ...(p as object), text: '' };
      replaced = true;
      return { ...(p as object), text };
    }
    return p;
  }).filter((p) => !(p && typeof p === 'object' && (p as { type?: string; text?: string }).type === 'text' && (p as { text?: string }).text === ''));
  return { ...message, content: replaced ? next : [{ type: 'text', text }, ...next] };
}

function shrinkTo(message: MessageLike, maxChars: number): MessageLike {
  const text = textOf(message.content);
  if (text.length <= maxChars) return message;
  return withText(message, boundToolResultText(text, maxChars).text);
}

export interface FitResult<T> { messages: T[]; fits: boolean; shrunk: number; charsBefore: number; charsAfter: number }

/**
 * Brings the conversation under `maxChars` before a model call, never breaking tool-call / tool-result pairing:
 *  1. oldest bulky tool results shrink to a short excerpt, then
 *  2. the newest tool result shrinks to what is left, then
 *  3. old user/assistant prose is excerpted (the current user message and the last assistant message are untouched).
 * Nothing is dropped, so what the model sees stays internally consistent.
 */
export function fitMessagesToBudget<T extends MessageLike>(messages: T[], maxChars: number): FitResult<T> {
  const charsBefore = messagesChars(messages);
  if (charsBefore <= maxChars) return { messages, fits: true, shrunk: 0, charsBefore, charsAfter: charsBefore };
  const out = messages.slice();
  let shrunk = 0;
  let total = charsBefore;
  const apply = (index: number, limit: number) => {
    const before = textOf(out[index].content).length;
    if (before <= limit) return;
    out[index] = shrinkTo(out[index], limit) as T;
    total -= before - textOf(out[index].content).length;
    shrunk += 1;
  };
  const resultIdx = out.map((m, i) => (m.role === 'toolResult' || m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const lastResult = resultIdx[resultIdx.length - 1];
  for (const i of resultIdx) {
    if (total <= maxChars) break;
    if (i !== lastResult) apply(i, 1_500);
  }
  if (total > maxChars && lastResult != null) {
    const others = total - textOf(out[lastResult].content).length;
    apply(lastResult, Math.max(1_500, maxChars - others));
  }
  const lastUser = out.map((m) => m.role).lastIndexOf('user');
  const lastAssistant = out.map((m) => m.role).lastIndexOf('assistant');
  for (let i = 0; i < out.length && total > maxChars; i += 1) {
    if (i === lastUser || i === lastAssistant || out[i].role === 'toolResult' || out[i].role === 'tool') continue;
    apply(i, 800);
  }
  return { messages: out, fits: total <= maxChars, shrunk, charsBefore, charsAfter: total };
}

/** Words a finished sentence cannot end on: a reply that stops here was cut off (context full, token limit, crash). */
const DANGLING_LAST_WORD = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'their', 'its', 'our',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into', 'than', 'as',
  'and', 'or', 'but', 'so', 'because', 'if', 'while', 'which', 'who', 'whose', 'where', 'when',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
  'based', 'according', 'here', 'there', 'i', 'we', 'you', 'it', 'they',
  'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'von', 'mit', 'für', 'zu', 'im', 'in', 'ist',
]);

/**
 * True when text is evidently cut off mid-sentence: ends on a determiner, preposition, conjunction or auxiliary, on a
 * comma/colon/opening bracket, or inside an open code fence. Deliberately NOT a length rule: "Yes", "No", "€250" and
 * "Done." are complete answers.
 */
export function endsMidSentence(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return false;
  if ((trimmed.match(/```/g)?.length ?? 0) % 2 === 1) return true;
  if (/[,:;(\[{\-–—]$/.test(trimmed)) return true;
  if (/[.!?…)"'»”\]}`*]$/.test(trimmed)) return false;
  // Only a fragment of a few words is judged by its last word; anything longer relies on how the generation ended
  // (token limit, full window), which is a fact and not a guess about language.
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return false;
  return DANGLING_LAST_WORD.has(words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ''));
}

/** The call used (almost) the whole window: whatever came back was limited by the context, not finished by the model. */
export function contextExhausted(promptTokens: number, outputTokens: number, numCtx: number): boolean {
  return numCtx > 0 && promptTokens + outputTokens >= numCtx - 512;
}
