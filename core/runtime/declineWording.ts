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
const MISATTRIBUTION = /\b(?:(?:do\s+not|don't|did\s+not|didn't)\s+have\s+(?:the\s+|any\s+)?(?:permission|access|authori[sz]ation)|not\s+(?:permitted|allowed)|not\s+(?:been\s+)?authori[sz]ed|unauthori[sz]ed|requires?\s+(?:specific\s+|special\s+|additional\s+|explicit\s+)?permission|permission\s+(?:was\s+)?denied|protected|protection|security\s+(?:restriction|polic(?:y|ies))|blocked\s+by\s+(?:the\s+)?system|cannot\s+modify\s+it\s+directly|different\s+approach|work\s*around|manually)\b/i;

export interface DeclineCheck { text: string; corrected: boolean }

/** `declinedResults` are the outputs of this turn's tools; only a real decline result triggers anything. */
export function enforceDeclineWording(reply: string, declinedResults: string[], options: { otherActionsDone?: boolean } = {}): DeclineCheck {
  const declined = declinedResults.find((r) => DECLINE_RESULT.test(r));
  if (!declined || !reply.trim()) return { text: reply, corrected: false };
  if (ALREADY_SAYS_DECLINED.test(reply) && !MISATTRIBUTION.test(reply)) return { text: reply, corrected: false };
  // Drop sentences that blame a protection/authorization rule; keep everything else the reply said.
  const sentences = reply.split(/(?<=[.!?])\s+(?=[A-Z*`"])/);
  const kept = sentences.filter((s) => !MISATTRIBUTION.test(s));
  const nothingChanged = /nothing was (?:changed|written|done|sent|printed)/i.exec(declined)?.[0] ?? 'nothing was changed';
  // Real-world challenge: a declined extra web search after create_project had worked produced "You declined this, so
  // nothing was changed" — false. When other actions did happen, only the declined step is named.
  const statement = options.otherActionsDone ? 'You declined that step, so it was not done.' : `You declined this, so ${nothingChanged.toLowerCase()}.`;
  const rest = kept.join(' ').trim();
  return { text: rest ? `${statement} ${rest}` : statement, corrected: true };
}

const WEB_ACCESS_DECLINED = /\b(?:the user|you)(?: already)? declined web access for this task\b/i;
const LINK = /https?:\/\/[^\s<>()\[\]"'`]+/gi;

/** What the person reads instead of invented web findings. It states the fact and what is still possible. */
export const WEB_DECLINED_REPLY = 'You declined the web search, so nothing was searched. I have no verified current information for this, '
  + 'so I am not giving headlines, figures or links from memory.\n\n'
  + 'What is possible: ask again and allow the search, paste a link or text you already have, or ask me something that needs no web access.';

export interface UnsourcedLinkCheck { text: string; withheld: string[] }

/**
 * Live finding 2026-11-23 (scratch instance, attempt att_a4bcb293): the person declined a web search; the model then wrote
 * "Here are a few current headlines" with four article links, two of them dated in the future. Nothing had been searched.
 *
 * After a recorded refusal of web access in this turn, a link in the reply that appears in nothing the person wrote and in
 * nothing a tool returned has no source. Removing only the link would leave the invented headline standing, so the reply is
 * replaced by the fact. A reply without such links is left alone: answering from memory and saying so is allowed.
 * `known` is everything that may legitimately contain a link: the person's messages and this turn's successful tool outputs.
 */
export function withholdUnsourcedLinksAfterWebDecline(reply: string, toolResults: string[], known: string[]): UnsourcedLinkCheck {
  if (!toolResults.some((r) => WEB_ACCESS_DECLINED.test(r))) return { text: reply, withheld: [] };
  const haystack = known.join('\n');
  const clean = (u: string) => u.replace(/[.,;:!?*_]+$/, '');
  const withheld = [...new Set((reply.match(LINK) ?? []).map(clean))].filter((u) => !haystack.includes(u));
  if (!withheld.length) return { text: reply, withheld: [] };
  return { text: WEB_DECLINED_REPLY, withheld };
}
