/**
 * Explicit single-choice requests ("which one would you prioritize", "pick one", "choose one").
 *
 * M10 controlled trials (frozen prompt, gemma4:12b, 5 new conversations per build): with every tool in the prompt the
 * model named one option 5/5; with the task-aware tool list (smaller system prompt) it named one 2/5 and otherwise merged
 * two options into a "combined" priority. The request asked for one, so that turn's prompt now says so explicitly.
 */
const SINGLE_CHOICE = /\b(?:which\s+one|which\s+(?:single|one)\s+\w+|pick\s+(?:one|a\s+single|just\s+one)|choose\s+(?:one|a\s+single|just\s+one)|select\s+(?:one|a\s+single)|(?:only|just)\s+one\s+(?:of|option|feature|thing|choice)|the\s+(?:single|one)\s+(?:most|best|top)\b|which\s+(?:feature|option|choice|item|approach|one)\s+(?:would|should)\s+(?:you|i|we)\s+(?:prioriti[sz]e|pick|choose|recommend|start\s+with))/i;

export function asksForSingleChoice(text: string): boolean {
  return SINGLE_CHOICE.test(text ?? '');
}

export const SINGLE_CHOICE_RULE = '\n\nONE CHOICE: the user asked you to choose one. Name exactly one option as your answer in the first sentence, '
  + 'and give your reasons for it. Do not merge several options into a combined choice; you may mention what would come next only after the single choice is clear.';
