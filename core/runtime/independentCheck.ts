/**
 * "…and have someone else check it": an independent check is a second agent looking at the real result with its own
 * tools. The agent that did the work re-reading its own output is not one, whatever it calls it.
 *
 * Found on the Jarvis pass (2026-11-16): asked to fix failing tests "and get the fix independently checked", the lead
 * fixed the bug, re-ran the tests itself and reported "Independent verification completed". Nothing in Core required
 * a second agent, so the claim stood. Core now decides this from the request and from the recorded calls: when an
 * independent check was asked for, work was done in the turn, and no reviewer took part, Core hands the result to the
 * Reviewer itself and attaches what it found (or says plainly that no independent check happened).
 *
 * Pure functions; the engine does the hand-off.
 */

const CHECK = '(?:check\\w*|review\\w*|verif\\w*|validat\\w*|audit\\w*|look(?:ed|s)? (?:at|over)|sign(?:ed)? off|inspect\\w*)';
const OTHER = '(?:independent(?:ly)?|second|another|different|separate|someone else|somebody else|other)';
const WHO = '(?:specialist|agent|reviewer|person|pair of eyes|opinion|set of eyes|expert)';

const PATTERNS: RegExp[] = [
  new RegExp(`\\bindependent(?:ly)?\\s+(?:\\w+\\s+){0,2}?${CHECK}`, 'i'),
  new RegExp(`\\b${CHECK}\\s+(?:\\w+\\s+){0,4}?independently\\b`, 'i'),
  new RegExp(`\\b${OTHER}\\s+${WHO}\\b[^.?!]{0,60}\\b${CHECK}`, 'i'),
  new RegExp(`\\b${CHECK}\\b[^.?!]{0,40}\\bby\\s+(?:a\\s+|an\\s+|the\\s+)?(?:${OTHER}\\s+)?(?:${WHO}|reviewer)\\b`, 'i'),
  new RegExp(`\\b(?:have|get|let|ask)\\s+(?:a\\s+|an\\s+|the\\s+|your\\s+)?(?:${OTHER}\\s+${WHO}|reviewer|someone else|somebody else)\\s+(?:to\\s+)?${CHECK}`, 'i'),
  /\bsecond opinion\b/i,
];

/** The request asks for the work to be checked by someone other than whoever does it. */
export function asksForIndependentCheck(request: string | null | undefined): boolean {
  const text = String(request ?? '').replace(/\s+/g, ' ');
  if (!text) return false;
  // "don't bother having it reviewed", "no need for an independent check"
  if (/\b(?:no need|don't|do not|without|skip)\b[^.?!]{0,30}\b(?:independent|second|review|reviewer)/i.test(text)) return false;
  return PATTERNS.some((p) => p.test(text));
}

export interface TurnCall { tool: string; status: string; args?: unknown }

/** Whether a reviewer other than the doer took part in this turn. */
export function reviewerTookPart(calls: readonly TurnCall[]): boolean {
  return calls.some((c) => c.status === 'completed' && c.tool === 'delegate_to_agent' && String((c.args as { agent?: unknown } | undefined)?.agent ?? '') === 'reviewer')
    || calls.some((c) => c.status === 'completed' && c.tool === 'mission_start');
}

const WRITE_TOOL = /^(?:write_file|edit_file|apply_patch)$|^propose_|file_change/;

/** The brief Core writes for the Reviewer: what was asked, what the turn changed and ran. Facts from the records only. */
export function independentCheckBrief(request: string, calls: readonly TurnCall[]): string {
  const arg = (c: TurnCall, ...keys: string[]) => { const a = (c.args ?? {}) as Record<string, unknown>; for (const k of keys) if (typeof a[k] === 'string' && a[k]) return String(a[k]); return ''; };
  const changed = [...new Set(calls.filter((c) => c.status === 'completed' && WRITE_TOOL.test(c.tool)).map((c) => arg(c, 'filePath', 'path', 'file')).filter(Boolean))].slice(0, 8);
  const checks = [...new Set(calls.filter((c) => c.tool === 'run_checks').map((c) => arg(c, 'command')).filter(Boolean))].slice(0, 3);
  const tools = [...new Set(calls.filter((c) => c.status === 'completed' && !WRITE_TOOL.test(c.tool) && c.tool !== 'run_checks').map((c) => c.tool))].slice(0, 8);
  return [
    `Independently check work that Pandesh's lead just did for this request from the user: "${request.replace(/\s+/g, ' ').slice(0, 500)}".`,
    changed.length ? `Files it changed: ${changed.join(', ')}.` : 'It recorded no file change.',
    checks.length ? `Checks it ran itself: ${checks.join(' ; ')}.` : '',
    tools.length ? `Other tools it used: ${tools.join(', ')}.` : '',
    'Open the changed files and whatever they must satisfy (tests, the request, the data) with your own tools, and judge whether the work is correct and complete. Do not rely on what the lead says it did.',
    'Report the verdict first (ready, fix first, or cannot verify), then each problem with its file and line, then what you could not check. Change nothing.',
  ].filter(Boolean).join(' ').slice(0, 3_800);
}

/** The reviewer's own words out of a delegation result (without the instructions addressed to the lead). */
export function reviewerReport(delegationResult: string): { ledger: string; report: string } {
  const split = delegationResult.split(/\n\nRESULT FROM THE [A-Z ]+ AGENT[^\n]*\n/);
  const ledger = (split[0] ?? '').replace(/^CORE EVIDENCE LEDGER[^\n]*\n/, '').replace(/\nThe report below is the agent's own text[^\n]*/, '').trim();
  const report = (split[1] ?? delegationResult).replace(/\n\nReport this to the user, saying the [^\n]*$/, '').trim();
  return { ledger, report };
}
