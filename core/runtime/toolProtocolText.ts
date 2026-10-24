/**
 * Final-answer projection guard: internal tool-call protocol markup is never user-facing prose.
 *
 * A model can print its native tool protocol (`<tool_call>...</tool_call>`, `<function=name>...</function>`) as
 * message content even when no tool was offered (Baat Kar) or after the one bounded correction turn was spent
 * (Saath Kar). Parse/validate-before-execute is untouched: this only decides what may be PRESENTED as the answer.
 * Nothing here ever executes, repairs or validates a call.
 *
 * Only the two protocol wrappers are recognised. Other angle brackets (HTML, generics, comparisons) and anything
 * inside a fenced code block or inline code span is left exactly as written.
 */

export interface ProjectedAssistantText {
  text: string;
  /** True when protocol markup was removed from the text. */
  strippedProtocol: boolean;
}

// Complete blocks first; an unterminated opener (reply cut off mid-call) consumes to the end of the reply.
const PROTOCOL_BLOCK = /<tool_call>[\s\S]*?<\/tool_call>|<function=[A-Za-z0-9_]+>[\s\S]*?<\/function>(?:\s*<\/tool_call>)?|<tool_call>[\s\S]*$|<function=[A-Za-z0-9_]+>[\s\S]*$/gi;
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;

export function projectAssistantText(content: string): ProjectedAssistantText {
  if (!/<tool_call>|<function=/i.test(content)) return { text: content, strippedProtocol: false };
  // Protect code regions from stripping by swapping them for placeholders, then restore them.
  const protectedSpans: string[] = [];
  const masked = content.replace(CODE_SPAN, (span) => `\u0000${protectedSpans.push(span) - 1}\u0000`);
  let strippedProtocol = false;
  const stripped = masked.replace(PROTOCOL_BLOCK, () => { strippedProtocol = true; return ''; });
  if (!strippedProtocol) return { text: content, strippedProtocol: false };
  const text = stripped.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => protectedSpans[Number(index)]).trim();
  return { text, strippedProtocol: true };
}
