/**
 * Messages the user spoke rather than typed.
 *
 * Voice input is transcribed on this PC by a small local recognizer (whisper-base.en, no vocabulary biasing), and it
 * mishears names. A measured round trip (Piper speech into the product's own recognizer, 2026-11-10) never
 * recognised a short place name — it came out as common words such as "on" or "all", and "weather in <city>" once
 * came out as "whether or not" — and turned "Ollama" into "Alama", "Ollaya" into "all air" and "Pandesh" into
 * "Pandish". In the owner's own voice test "Pandesh" very likely became "punishment", and the model refused a request
 * that only looked harmful because of that one word. Common words cannot be corrected back safely, so the model is
 * told the message was spoken and asks about an odd word instead of acting on it or refusing.
 *
 * How a message was entered is recorded by Core with the request (frozen on its attempt), never inferred from text.
 */
export type InputModality = 'text' | 'voice';

/** The request field a client sends; anything but "voice" is typed text. */
export function parseInputModality(value: unknown): InputModality {
  return value === 'voice' ? 'voice' : 'text';
}

/** Reads the modality Core froze into a request's tool permission policy. */
export function inputModalityOf(policy: Record<string, unknown> | null | undefined): InputModality {
  return policy?.inputModality === 'voice' ? 'voice' : 'text';
}

/** Product words the recognizer gets wrong, with what it was heard as (measured, or seen in a real voice test). */
export const KNOWN_MISHEARINGS: ReadonlyArray<{ word: string; heardAs: string[] }> = [
  { word: 'Pandesh', heardAs: ['Pandish', 'Pan-dish', 'punishment'] },
  { word: 'Ollama', heardAs: ['Alama', 'Alana'] },
  { word: 'Ollaya', heardAs: ['all air', 'Ollair'] },
];

export const SPOKEN_INPUT_PROMPT_SECTION = `SPOKEN MESSAGE (the user's latest message was spoken and transcribed on this PC by a small speech recognizer):
- The transcript can contain misheard words, above all names. Known confusions: ${KNOWN_MISHEARINGS.map((m) => `"${m.word}" heard as ${m.heardAs.map((h) => `"${h}"`).join(', ')}`).join('; ')}. A place name can come out as a short common word ("on", "all") and "weather in <place>" as "whether or not".
- If a word looks odd, out of place, alarming or harmful in context, it was probably misheard: ask "Did you mean …?" with your best guess, in one short sentence, before acting on it.
- Never refuse, warn or lecture because of one strange word in a spoken message; ask first, and decide only after the user confirms what they said.
- Do not repeat a misheard word back as if the user meant it.`;

/** The prompt section for this turn: present only when the message was spoken. */
export function spokenInputPromptSection(modality: InputModality): string {
  return modality === 'voice' ? SPOKEN_INPUT_PROMPT_SECTION : '';
}
