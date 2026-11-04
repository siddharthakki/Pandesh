/**
 * Safe repair for malformed JSON tool-call arguments.
 *
 * Models routinely emit tool-call arguments that strict JSON rejects:
 *
 *   - a LITERAL newline inside a string value, because the model "wrote" the
 *     multi-line `find` anchor of an anchored edit across several lines;
 *   - `\'`, which JSON does not define but which is what many models emit
 *     when they escape an apostrophe.
 *
 * Both are repaired here, and ONLY these two. The repair is deliberately
 * narrow because the arguments carry the model's intended file content: a
 * broad "make it parse" transformation could silently change what the model
 * asked to write.
 *
 * WHAT THIS MODULE NEVER DOES
 * ----------------------------
 *   - no Unicode normalization (NFC, NFKC, or any other folding);
 *   - no smart-quote / curly-quote substitution;
 *   - no stripping or transliteration of non-ASCII characters;
 *   - no whitespace folding;
 *   - no repair of an escape that a language could give a meaning to
 *     (`\d`, `\s`, `\w`, `\.`, `\[`, ...): those are reported, not guessed.
 *
 * The rule is simple: a repair may only make the JSON express what the
 * model plainly wrote, never what it might have meant.
 */

/** One repair that was applied, for the audit trail. */
export interface AppliedRepair {
  kind: 'control_character_escaped' | 'single_quote_escape_removed';
  /** How many occurrences of this kind were repaired. */
  count: number;
}

export interface JsonEscapeRepairResult {
  /** The repaired text, or null when nothing could be repaired. */
  text: string | null;
  /** What was repaired. Empty when nothing was. */
  applied: AppliedRepair[];
}

const CONTROL_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/**
 * Repairs the two safe classes of malformed JSON.
 *
 * The scan is string-aware: a character is only rewritten when it is inside
 * a JSON string literal, so a `"` or `\` in the surrounding structure is
 * never touched.
 */
export function repairJsonStringEscapes(text: string): JsonEscapeRepairResult {
  let out = '';
  let inString = false;
  let escaped = false;
  let controlCount = 0;
  let singleQuoteCount = 0;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      // Already inside an escape sequence: copy it verbatim, except for the
      // one escape JSON does not define and no language gives a meaning to.
      if (ch === "'") {
        out += "'";
        singleQuoteCount += 1;
        escaped = false;
        continue;
      }
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    const control = CONTROL_ESCAPES[ch];
    if (control !== undefined) {
      out += control;
      controlCount += 1;
      continue;
    }
    if (ch < ' ') {
      // Any other control character (e.g. U+0000) is escaped numerically so
      // the JSON stays valid and the byte is preserved exactly.
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      controlCount += 1;
      continue;
    }

    out += ch;
  }

  const applied: AppliedRepair[] = [];
  if (controlCount > 0) applied.push({ kind: 'control_character_escaped', count: controlCount });
  if (singleQuoteCount > 0) applied.push({ kind: 'single_quote_escape_removed', count: singleQuoteCount });
  if (applied.length === 0) return { text: null, applied: [] };
  return { text: out, applied };
}

/**
 * Parses JSON, applying the safe repairs only when the strict parse fails.
 *
 * Returns the parsed value, or null when the text cannot be parsed even
 * after the safe repairs — the caller then reports the fault precisely.
 */
export function parseJsonWithSafeRepair(text: string): { value: unknown; applied: AppliedRepair[] } | null {
  try {
    return { value: JSON.parse(text), applied: [] };
  } catch {
    // fall through to the repair
  }
  const repaired = repairJsonStringEscapes(text);
  if (!repaired.text) return null;
  try {
    const value = JSON.parse(repaired.text);
    return { value, applied: repaired.applied };
  } catch {
    return null;
  }
}
