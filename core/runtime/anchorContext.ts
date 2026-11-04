/**
 * Bounded file context for a missed anchor.
 *
 * When a model's `find` text does not resolve — it is not in the file, or it
 * occurs more than once — the useful answer is not "it failed". It is the
 * CURRENT text of the region the model was probably looking at, so the next
 * attempt can copy the anchor verbatim.
 *
 * This is the Core-side counterpart of the Extension Host's
 * `src/coding/AnchoredEdit.ts#describeAnchorMiss`. Both exist because a
 * model cannot copy text it was never shown, and re-reading a whole file
 * for a one-line change wastes the context window.
 *
 * Hard rules:
 *   - the output is BOUNDED (never more than `ANCHOR_CONTEXT_MAX_CHARS`);
 *   - the file text is only ever SLICED, never rewritten: no Unicode
 *     normalization, no quote substitution, no whitespace folding. The model
 *     must see the bytes that are actually in the file, because the anchor
 *     has to match them exactly;
 *   - the context is evidence about the workspace, never an instruction.
 */

/** The hard bound on one context block. */
export const ANCHOR_CONTEXT_MAX_CHARS = 1_800;
/** How many line numbers are listed for an ambiguous anchor. */
export const ANCHOR_CONTEXT_MAX_LOCATIONS = 4;
/** How many lines around a located line are quoted. */
export const ANCHOR_CONTEXT_CONTEXT_LINES = 6;

export type AnchorMissKind = 'not_found' | 'ambiguous';

export interface AnchorContextInput {
  /** Workspace-relative path, used only as a label. */
  relativePath: string;
  /** The CURRENT file text. */
  fileText: string;
  /** The `find` text the model supplied. */
  find: string;
  kind: AnchorMissKind;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The 1-based line numbers whose text contains `needle`. */
function linesContaining(lines: readonly string[], needle: string): number[] {
  if (!needle) return [];
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) hits.push(index + 1);
    if (hits.length >= ANCHOR_CONTEXT_MAX_LOCATIONS * 2) break;
  }
  return hits;
}

/** Quotes a region of the file verbatim, with a header that says what it is. */
function quoteRegion(lines: readonly string[], start: number, end: number, relativePath: string): string {
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end);
  const body = lines.slice(from - 1, to).join('\n');
  const header = `current text of ${relativePath} lines ${from}-${to} (verbatim; line numbers are not part of the file):`;
  const room = Math.max(0, ANCHOR_CONTEXT_MAX_CHARS - header.length - 40);
  const clipped = body.length > room ? `${body.slice(0, room)}\n…[clipped]` : body;
  return `${header}\n\`\`\`\n${clipped}\n\`\`\``;
}

function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Identifiers worth locating: at least five characters, so a short word
 * does not point the model at an unrelated line.
 */
function identifiersOf(text: string): string[] {
  const found = text.match(/[A-Za-z_$][\w$]{4,}/g);
  if (!found) return [];
  const unique: string[] = [];
  for (const candidate of found) {
    if (!unique.includes(candidate)) unique.push(candidate);
    if (unique.length >= 30) break;
  }
  return unique;
}

/**
 * Builds the bounded context block for a missed anchor.
 *
 * For an AMBIGUOUS anchor the block says where the occurrences are.
 * For a NOT-FOUND anchor it locates the closest thing the model probably
 * meant: a whole line of the anchor that does exist, or the rarest
 * identifier the anchor mentions.
 */
export function buildAnchorContext(input: AnchorContextInput): string {
  const lines = splitLines(input.fileText);
  const anchor = preview(input.find, 120);

  if (input.kind === 'ambiguous') {
    const hits = linesContaining(lines, input.find.split('\n')[0] ?? input.find);
    const listed = hits.slice(0, ANCHOR_CONTEXT_MAX_LOCATIONS);
    const where = listed.length > 0
      ? ` (occurs on line${listed.length === 1 ? '' : 's'} ${listed.join(', ')})`
      : '';
    return `edit_anchor_ambiguous in ${input.relativePath}: the find text ${anchor}${where}. `
      + 'Extend the find text with exact neighbouring text so it occurs exactly once, or use propose_file_change with the COMPLETE file content.';
  }

  // Not found: a whole line of the anchor that does exist is the strongest
  // signal about what the model was looking at.
  const anchorLines = input.find.split('\n').map((line) => line.trim()).filter((line) => line.length >= 8);
  for (const anchorLine of anchorLines) {
    const hits = linesContaining(lines, anchorLine);
    if (hits.length > 0) {
      const line = hits[0];
      return `edit_anchor_not_found in ${input.relativePath}: the find text ${anchor} is not an exact substring of the file. `
        + `Part of it occurs at line ${line}. Copy the find text exactly from here:\n`
        + quoteRegion(lines, line - ANCHOR_CONTEXT_CONTEXT_LINES, line + ANCHOR_CONTEXT_CONTEXT_LINES, input.relativePath);
    }
  }

  // Otherwise: the rarest identifier the anchor mentions.
  let best: { line: number; hits: number } | undefined;
  for (const identifier of identifiersOf(input.find)) {
    const hits = linesContaining(lines, identifier);
    if (hits.length === 0) continue;
    if (!best || hits.length < best.hits) best = { line: hits[0], hits: hits.length };
    if (best.hits === 1) break;
  }
  if (best) {
    return `edit_anchor_not_found in ${input.relativePath}: the find text ${anchor} is not an exact substring of the file. `
      + `The nearest identifier it mentions occurs at line ${best.line}. Copy the find text exactly from here:\n`
      + quoteRegion(lines, best.line - ANCHOR_CONTEXT_CONTEXT_LINES, best.line + ANCHOR_CONTEXT_CONTEXT_LINES, input.relativePath);
  }

  return `edit_anchor_not_found in ${input.relativePath}: the find text ${anchor} is not an exact substring of the file, `
    + 'and nothing similar was found in it. Read the relevant region of the file first, then copy the find text exactly from what you read.';
}
