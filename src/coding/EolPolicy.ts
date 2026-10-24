/**
 * Line-ending vocabulary for delivery evidence.
 *
 * KarkeDikha validates and records exact bytes: the governed mutation writes the approved content byte for byte and
 * evidence compares it byte for byte. Git, however, may legitimately render the same logical text differently on
 * checkout (`core.autocrlf=true`, the Git for Windows default, or `.gitattributes`). Two byte sequences that differ
 * only in line endings are *logically equivalent* but not *byte identical*; conflating the two is how a task could
 * pass in its worktree and then fail in the tree the user actually receives.
 *
 * Nothing here rewrites content. These helpers only classify, so a mismatch can be reported precisely. Repositories
 * are never normalised and user line endings are never changed.
 */

export type EolStyle = 'none' | 'lf' | 'crlf' | 'mixed';

/** Whether the text has no line breaks, only `\n`, only `\r\n`, or a mixture (a lone `\r` counts as mixed). */
export function detectEol(input: string | Buffer): EolStyle {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  let crlf = 0;
  let lf = 0;
  let other = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 13) {
      if (text.charCodeAt(index + 1) === 10) { crlf += 1; index += 1; } else { other += 1; }
    } else if (char === 10) {
      lf += 1;
    }
  }
  if (other > 0 || (crlf > 0 && lf > 0)) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** True when the two contents are not byte identical but become identical once CRLF is read as LF. */
export function isEolOnlyDifference(left: string | Buffer, right: string | Buffer): boolean {
  const a = typeof left === 'string' ? Buffer.from(left, 'utf8') : left;
  const b = typeof right === 'string' ? Buffer.from(right, 'utf8') : right;
  if (a.equals(b)) return false;
  return normalizeEol(a.toString('utf8')) === normalizeEol(b.toString('utf8'));
}

export interface EolDifference {
  path: string;
  validated: EolStyle;
  delivered: EolStyle;
}

/** One sentence for a user or log: names the files and says which side has which ending. */
export function describeEolDifferences(differences: readonly EolDifference[], gitPolicy?: string): string {
  if (differences.length === 0) return '';
  const shown = differences.slice(0, 5).map(item => `${item.path} (validated ${item.validated}, delivered ${item.delivered})`);
  const more = differences.length > shown.length ? ` and ${differences.length - shown.length} more` : '';
  const policy = gitPolicy ? ` This repository's Git settings (${gitPolicy}) render these files differently on checkout.` : '';
  return `The delivered checkout differs from the validated worktree only in line endings: ${shown.join(', ')}${more}.${policy}`;
}

/** Task text that is itself about line endings: then an EOL change is the request, not an accident. */
const EOL_INTENT = /\b(line[- ]?endings?|eol|crlf|lf|newlines?|dos2unix|unix2dos)\b/i;

export interface ConformedContent {
  content: string;
  /** True when the proposed content was rewritten to keep the existing file's line endings. */
  conformed: boolean;
}

/**
 * Keeps an existing CRLF file CRLF when a model replaces it with LF-only text.
 *
 * Models routinely drop `\r`. Writing that content verbatim would flip every line of a CRLF file, producing a
 * whole-file diff in a repository without autocrlf. The rule is deliberately narrow so it can never surprise:
 *
 *  - the existing file is *consistently* CRLF (no mixed endings, no lone CR);
 *  - the proposed content is *consistently* LF (it has line breaks and none of them is CR-based);
 *  - the task text does not itself concern line endings (an explicit EOL conversion is honoured as asked).
 *
 * Anything else — mixed files, new files, content that already carries CRLF, single-line content — is returned
 * untouched. Applied once, at binding time, so approval, mutation, evidence and recovery all see the same bytes.
 */
export function conformContentToExistingEol(content: string, existing: Buffer, taskText = ''): ConformedContent {
  if (EOL_INTENT.test(taskText)) return { content, conformed: false };
  if (detectEol(existing) !== 'crlf' || detectEol(content) !== 'lf') return { content, conformed: false };
  return { content: content.replace(/\n/g, '\r\n'), conformed: true };
}
