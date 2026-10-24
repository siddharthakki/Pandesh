/**
 * Keeps model prose from posing as execution evidence.
 *
 * A model's closing message may describe the change, but test counts and command
 * transcripts it writes are not evidence unless a command Core actually executed
 * produced them (g1: "npm run test passed (4/4)" over a 2-test suite, and a
 * `> delete 1 / Delete #1 ...? (y/n)` session no command ever printed). This is a
 * pure, deterministic filter over the final message and the recorded outputs of
 * executed commands; it never calls a model and never runs anything.
 */

export interface ExecutionClaimReconciliation {
  text: string;
  /** What was withheld, for the quality record. Empty when the message was left untouched. */
  withheld: Array<{ kind: 'test_counts' | 'command_transcript'; claim: string }>;
}

const TEST_COUNT_CLAIM = /\b(\d+)\s*\/\s*(\d+)\b/;
const TEST_CONTEXT = /\b(tests?|specs?|suites?|checks?|passed|passing|pass)\b/i;
const SHELL_PROMPT_LINE = /^\s*(?:>|\$)\s+\S/;
const MAX_CLAIM_ECHO = 160;

interface RecordedCount { passed: number; total: number }

/** Every pass/total pair the recorded output actually reports (node:test, vitest, jest, pytest, mocha). */
export function recordedTestCounts(recorded: readonly string[]): RecordedCount[] {
  const counts: RecordedCount[] = [];
  for (const output of recorded) {
    const text = output.replace(/\x1b\[[0-9;]*m/g, '');
    const nodeTests = /\btests\s+(\d+)\b/i.exec(text);
    const nodePass = /\bpass(?:ed)?\s+(\d+)\b/i.exec(text);
    if (nodeTests && nodePass) counts.push({ passed: Number(nodePass[1]), total: Number(nodeTests[1]) });
    for (const match of text.matchAll(/(\d+)\s+passed\s*\((\d+)\)/gi)) counts.push({ passed: Number(match[1]), total: Number(match[2]) });
    for (const match of text.matchAll(/(\d+)\s+passed,\s*(\d+)\s+total/gi)) counts.push({ passed: Number(match[1]), total: Number(match[2]) });
    for (const match of text.matchAll(/(\d+)\s+passing\b/gi)) counts.push({ passed: Number(match[1]), total: Number(match[1]) });
    const pytest = /=+\s*(\d+)\s+passed\b/i.exec(text);
    if (pytest) counts.push({ passed: Number(pytest[1]), total: Number(pytest[1]) });
  }
  return counts;
}

function echo(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CLAIM_ECHO ? `${flat.slice(0, MAX_CLAIM_ECHO)}…` : flat;
}

const FILE_TOKEN = /[\w.-]+\.(?:html?|css|jsx?|tsx?|mjs|json|md|py|txt|ya?ml|svg|csv|xml|java|go|rs|c|cpp|cs)\b/i;
const CHANGE_DONE_CLAIM = /\bi(?:'ve| have)?\s+(?:now\s+)?(?:updated|edited|modified|added|changed|created|applied|written|rewritten|inserted|fixed|saved)\b|\b(?:has|have|had) been (?:updated|edited|modified|added|changed|created|applied|saved)\b|\bnow (?:has|contains|includes|shows)\b|\b(?:changes|edits) (?:are|were|have been) (?:applied|made|saved)\b|^\W*(?:done|completed|all set)\b/i;
const VALIDATION_DONE_CLAIM = /\bstructural(?:ly)?\s+validat\w*|\bvalidation\s+(?:passed|succeeded|ok)\b|\b(?:validated|verified)\b[^.\n]{0,40}\b(?:file|html|structure|syntax|page)\b|\b(?:html|syntax|structure)\s+(?:check|validation)\s+passed\b/i;

/**
 * Baat Kar offers no tools, so nothing it says can have changed or validated a workspace file. A completion claim naming a
 * file (or a validation result) in its prose is therefore model narration, never execution evidence. Those lines are
 * replaced by an explicit marker and the reply says plainly that nothing was changed.
 */
export function withholdUnexecutedChangeClaims(message: string): { text: string; withheld: string[] } {
  const withheld: string[] = [];
  const out: string[] = [];
  let inFence = false;
  for (const line of message.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }
    const claimsChange = !inFence && FILE_TOKEN.test(line) && CHANGE_DONE_CLAIM.test(line);
    const claimsValidation = !inFence && VALIDATION_DONE_CLAIM.test(line);
    if (claimsChange || claimsValidation) {
      withheld.push(echo(line));
      if (out[out.length - 1] !== UNPERFORMED_MARKER) out.push(UNPERFORMED_MARKER);
      continue;
    }
    out.push(line);
  }
  if (withheld.length === 0) return { text: message, withheld };
  out.push('', '**No file was changed and nothing was validated in this turn.** Baat Kar cannot edit files; the statements above were not performed. Switch to Saath Kar to make the change through the governed edit flow.');
  return { text: out.join('\n'), withheld };
}

const UNPERFORMED_MARKER = '[Unverified: the model claimed a workspace change or validation here; Baat Kar has no tools, so none happened.]';

/**
 * Replaces unsupported execution claims in `message` with an explicit unverified marker. `recorded` must contain only the
 * output of commands that actually ran (validation summaries, run_command results), never model-authored text.
 */
export function reconcileExecutionClaims(message: string, recorded: readonly string[]): ExecutionClaimReconciliation {
  const withheld: ExecutionClaimReconciliation['withheld'] = [];
  const counts = recordedTestCounts(recorded);
  const corpus = recorded.join('\n');
  const lines = message.split('\n');
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    // A shell-session block: the prompt line plus the following lines up to a blank line.
    if (SHELL_PROMPT_LINE.test(line)) {
      let end = index;
      while (end + 1 < lines.length && lines[end + 1].trim() !== '') end += 1;
      const block = lines.slice(index, end + 1);
      const produced = block
        .filter((candidate) => !SHELL_PROMPT_LINE.test(candidate))
        .map((candidate) => candidate.trim())
        .filter(Boolean);
      const supported = produced.length > 0 && produced.every((candidate) => corpus.includes(candidate));
      if (supported) {
        out.push(...block);
      } else {
        withheld.push({ kind: 'command_transcript', claim: echo(block.join(' ')) });
        out.push('[Unverified: the model wrote this example session; it was not captured from any command Core ran, so it is not evidence.]');
      }
      index = end;
      continue;
    }

    const claim = TEST_COUNT_CLAIM.exec(line);
    if (claim && TEST_CONTEXT.test(line)) {
      const passed = Number(claim[1]);
      const total = Number(claim[2]);
      if (!counts.some((count) => count.passed === passed && count.total === total)) {
        withheld.push({ kind: 'test_counts', claim: echo(line) });
        out.push('[Unverified: the model stated a test result that no recorded test run reports. See the recorded validation result for the real counts.]');
        continue;
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), withheld };
}
