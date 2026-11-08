/**
 * Audit D13 / F3: when the person declined an approval, the reply must say so. The tool result says it plainly
 * ("Not written: the user declined file changes…"), but the model rewords it as "not authorized", "requires specific
 * permission" or "system-level protection" — blaming a rule that does not exist and inviting a workaround. Core
 * replaces those sentences with the fact.
 */

const DECLINE_RESULT = /\b(?:the user|you)\s+(?:declined|rejected|did not approve|didn't approve)\b/i;
const ALREADY_SAYS_DECLINED = /\byou\s+(?:declined|rejected|did not approve|didn't approve|chose not to)\b/i;
// After a decline, any sentence that blames protection/authorization or offers a way around it goes (re-run F3:
// "Since this file is marked as protected, I cannot modify it directly. Would you like me to try a different approach").
const MISATTRIBUTION = /\b(?:not\s+(?:been\s+)?authori[sz]ed|unauthori[sz]ed|requires?\s+(?:specific\s+|special\s+|additional\s+|explicit\s+)?permission|permission\s+(?:was\s+)?denied|protected|protection|security\s+(?:restriction|polic(?:y|ies))|blocked\s+by\s+(?:the\s+)?system|cannot\s+modify\s+it\s+directly|different\s+approach|work\s*around|manually)\b/i;

export interface DeclineCheck { text: string; corrected: boolean }

/** `declinedResults` are the outputs of this turn's tools; only a real decline result triggers anything. */
export function enforceDeclineWording(reply: string, declinedResults: string[]): DeclineCheck {
  const declined = declinedResults.find((r) => DECLINE_RESULT.test(r));
  if (!declined || !reply.trim()) return { text: reply, corrected: false };
  if (ALREADY_SAYS_DECLINED.test(reply) && !MISATTRIBUTION.test(reply)) return { text: reply, corrected: false };
  // Drop sentences that blame a protection/authorization rule; keep everything else the reply said.
  const sentences = reply.split(/(?<=[.!?])\s+(?=[A-Z*`"])/);
  const kept = sentences.filter((s) => !MISATTRIBUTION.test(s));
  const nothingChanged = /nothing was (?:changed|written|done|sent|printed)/i.exec(declined)?.[0] ?? 'nothing was changed';
  const statement = `You declined this, so ${nothingChanged.toLowerCase()}.`;
  const rest = kept.join(' ').trim();
  return { text: rest ? `${statement} ${rest}` : statement, corrected: true };
}
