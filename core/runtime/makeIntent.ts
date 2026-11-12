/**
 * Does a request ask Pandesh to make something outside the chat (a file, an app, an image, a reminder…)? Only then
 * can a turn end "with nothing built" and be handed to a stronger model.
 *
 * The verb alone is not enough: "Write a haiku about autumn in Ulm" is answered by writing the haiku in the reply.
 * Build 165 counted it as an unbuilt file, escalated twice and a 27B model tried to save haiku_autumn_ulm.txt
 * (owner test, 2026-11-12).
 */
const MAKE_VERB = /\b(?:build|create|make|write|generate|draft|fix|add|delete|install|organi[sz]e|save|open)\b/i;

/** Things that are written in the reply itself. */
const TEXT_FORM = /\b(?:haiku|poem|poetry|limerick|verse|lyrics|song|rhyme|story|joke|riddle|summary|paragraph|sentence|essay|email|e-mail|message|reply|answer|letter|note to|tweet|post|caption|description|bio|slogan|tagline|title|headline|outline|list|explanation|definition|translation|recipe|toast|speech|wish|greeting|quote|example)s?\b/i;

/** Signs that the result must exist outside the chat. */
const ARTIFACT = /\b(?:file|folder|directory|document|docx?|pdf|spreadsheet|xlsx?|csv|slides?|deck|app|application|website|web\s*page|page|script|program|code|project|repo(?:sitory)?|widget|dashboard|component|function|image|picture|photo|video|reminder|task|event|calendar|label|filter|draft in|gmail|send|save|install|delete|fix|organi[sz]e|open)\b|\.[a-z0-9]{1,5}\b/i;

export function asksToMakeSomething(requestText: string): boolean {
  const text = String(requestText ?? '');
  if (!MAKE_VERB.test(text)) return false;
  // "Write a haiku / a poem / an email text" without anything that must be saved or sent is a chat answer.
  if (TEXT_FORM.test(text) && !ARTIFACT.test(text)) return false;
  return true;
}
