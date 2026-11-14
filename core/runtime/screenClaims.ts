/**
 * A reply may say a screenshot was taken only if a capture succeeded this turn, and may say what a screenshot shows
 * only if a local vision model read it this turn. Code-enforced and additive: it only ever returns a correction.
 */

export interface ScreenCall { tool: string; status: string; isError: boolean; text: string }

const TOOK = /\b(?:i(?:'ve|\s+have)?\s+(?:just\s+|now\s+)?(?:taken|took|captured|grabbed)\s+(?:a\s+|the\s+|your\s+)?screenshot|(?:the\s+|your\s+)?screenshot\s+(?:was|has\s+been|is)\s+(?:taken|captured|saved))\b/gi;
const ANALYZED = /\b(?:(?:the|your)\s+screenshot\s+(?:shows|reveals|contains|displays)|in\s+(?:the|your)\s+screenshot|i\s+(?:can\s+)?see\s+(?:in|on)\s+(?:the|your)\s+(?:screenshot|screen)|(?:analy[sz]ed|inspected|looked\s+at|examined)\s+(?:the|your)\s+(?:screenshot|image)|from\s+(?:the|your)\s+screenshot)\b/gi;
const NEGATED_BEFORE = /(?:\bnot\b|n't|\bnever\b|\bcannot\b|\bunable\b|\bno\b|\bwithout\b|\bif\b)[^.!?\n]{0,40}$/i;

function claimed(re: RegExp, reply: string): boolean {
  for (const m of reply.matchAll(re)) {
    const before = reply.slice(Math.max(0, (m.index ?? 0) - 45), m.index ?? 0);
    if (!NEGATED_BEFORE.test(before)) return true;
  }
  return false;
}

/** The correction to append, or null when every claim in the reply is backed by a receipt from this turn. */
export function unbackedScreenClaims(reply: string, calls: readonly ScreenCall[]): string | null {
  const shots = calls.filter((c) => c.tool === 'desktop_screenshot' && c.status === 'completed' && !c.isError);
  const captured = shots.length > 0;
  const inspected = shots.some((c) => /Read on this PC by the local vision model/.test(c.text));
  const problems: string[] = [];
  if (!captured && claimed(TOOK, reply)) problems.push('no screenshot was captured in this turn (there is no successful capture receipt), so the statement that one was taken is not backed');
  if (!inspected && claimed(ANALYZED, reply)) problems.push('no vision model read a screenshot in this turn, so what the reply says the screenshot shows was not observed and must not be trusted');
  return problems.length ? `Correction: ${problems.join('. Also, ')}.` : null;
}
