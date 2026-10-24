/**
 * Desktop interaction routing: no-repo chat vs Local Core / mission.
 * Pure helpers — unit-tested; used by desktopSession.submitTask and renderer.
 */

export type DesktopInteractionMode = 'chat' | 'local_core' | 'mission';
export type DesktopTurnOutcome = 'completed' | 'failed' | 'cancelled';
export type DesktopRequestedMode = 'baat_kar' | 'saath_kar';

/**
 * Truthful "what actually happened" label, independent of the coarser
 * completed/failed/cancelled state machine above. `artifact_created` is
 * reserved for the future Core-owned artifact capability (deferred — see
 * AI_OS_ROADMAP.md "Shared artifact subsystem") and is never produced today.
 */
export type DesktopTurnOutcomeKind = 'answered' | 'artifact_created' | 'workspace_changed' | 'blocked_needs_workspace' | 'failed';

export interface DesktopInteractionPlan {
  mode: DesktopInteractionMode;
  requestedMode: DesktopRequestedMode;
  /** When set, refuse submit and show this to the operator (do not call Core). */
  blockReason?: string;
  /** True when `blockReason` specifically means "select a repository", so the
   * caller can surface a Select-folder action rather than a bare error. */
  needsWorkspace?: boolean;
}

/** A request phrased as "write/create/save/generate a file" — deliberately
 * narrow (create-shaped verbs + a file/script noun or a filename-looking
 * token) so an ordinary question about existing code is never misclassified.
 * Editing/fixing an existing file is a separate, already-governed path
 * (`propose_text_edit`) and is not this heuristic's concern. */
const FILE_CREATION_VERB = /\b(write|create|save|generate|make)\b/i;
const FILE_CREATION_NOUN = /\b(file|script|program|module|app|application)\b|\.\w{1,6}(?=[\s,.!?;:]|$)/i;

export function detectFileCreationIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return FILE_CREATION_VERB.test(trimmed) && FILE_CREATION_NOUN.test(trimmed);
}

/** A request phrased as "generate/draw/make/paint/render ... an image/photo/
 * picture/artwork/illustration ..." — deliberately narrow, mirroring
 * `detectFileCreationIntent` above, so an ordinary question is never
 * misclassified as a request to run the governed Image Studio capability. */
const IMAGE_GENERATION_VERB = /\b(generate|create|draw|make|paint|render)\b/i;
const IMAGE_GENERATION_NOUN = /\b(image|photo|picture|artwork|illustration|painting|sketch|portrait|landscape|wallpaper|poster|logo|icon|avatar|scene)\b/i;
const IMAGE_GENERATION_LEADING_PHRASE =
  /^\s*(?:please\s+)?(?:generate|create|draw|make|paint|render)\s+(?:me\s+|us\s+)?(?:an?\s+)?((?:[\w-]+\s+){0,3}?)(?:image|photo|picture|artwork|illustration|painting|sketch|portrait|landscape|wallpaper|poster|logo|icon|avatar|scene)s?\s+(?:of|showing|depicting)?\s*/i;
/** "Imagine <a described scene> ... generate/draw/paint/render that" — a
 * visually-described subject followed by a referential ask to produce it.
 * Deliberately excludes "make"/"create" here (unlike the noun-based check
 * above): "make it work"/"create that file" are common, unrelated coding
 * requests, and requiring the earlier "imagine" keeps this pattern narrow. */
const IMAGE_GENERATION_IMAGINE_REFERENT = /\bimagine\b[\s\S]*?\b(generate|draw|paint|render)\s+(?:that|this|it)\b/i;

export function detectImageGenerationIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (IMAGE_GENERATION_IMAGINE_REFERENT.test(trimmed)) return true;
  return IMAGE_GENERATION_VERB.test(trimmed) && IMAGE_GENERATION_NOUN.test(trimmed);
}

const ANIME_STYLE = /\b(anime|manga|chibi|cel[- ]shaded|cartoon|illustration|kawaii|waifu)\b/i;

const VIDEO_REQUEST = /\b(generate|create|make|render|produce)\b[\s\S]{0,40}\b(video|clip|animation|movie)\b/i;
const ANIMATE_REQUEST = /\banimate\b|\bmake (?:it|this|the image) move\b|\bbring (?:it|this) to life\b/i;
const VARIATIONS_REQUEST = /\b(variations?|versions|alternatives|variants)\b/i;
const EDIT_REQUEST = /\b(change|replace|swap|make|turn|edit|add|remove|put)\b[\s\S]{0,60}\b(background|sky|it|this|image|picture|photo|colou?r|style|scene|lighting|weather|season)\b/i;
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, a: 1, couple: 2 };

export type MediaFollowUp =
  | { kind: 'variations'; count: number }
  | { kind: 'edit' }
  | { kind: 'animate' };

/** Requests that act on the conversation's most recent image (only
 * meaningful when such an image exists). */
export function detectImageFollowUp(text: string): MediaFollowUp | null {
  const t = text.trim();
  if (!t) return null;
  if (ANIMATE_REQUEST.test(t)) return { kind: 'animate' };
  if (VARIATIONS_REQUEST.test(t)) {
    const m = /\b(\d+|one|two|three|four|couple)\b\s+(?:more\s+)?(?:variations?|versions|alternatives|variants)/i.exec(t);
    const raw = m?.[1]?.toLowerCase();
    const count = raw ? (COUNT_WORDS[raw] ?? Number(raw)) : 4;
    return { kind: 'variations', count: Math.min(4, Math.max(1, count || 4)) };
  }
  if (EDIT_REQUEST.test(t) && !/\b(file|code|function|repo|folder)\b/i.test(t)) return { kind: 'edit' };
  return null;
}

export function detectVideoGenerationIntent(text: string): boolean {
  return VIDEO_REQUEST.test(text.trim());
}

/** "Generate a short cinematic clip of X" → "cinematic, X". */
export function extractVideoPrompt(text: string): string {
  const m = /^\s*(?:please\s+)?(?:generate|create|make|render|produce)\s+(?:me\s+)?(?:an?\s+)?((?:[\w-]+\s+){0,3}?)(?:video|clip|animation|movie)\s+(?:of|showing|about)?\s*/i.exec(text.trim());
  if (!m) return text.trim();
  const style = (m[1] ?? '').replace(/\b(short|quick|small|brief|\d+[- ]?(?:s|sec|second)s?)\b/gi, '').trim();
  const subject = text.trim().slice(m[0].length).trim();
  if (!subject) return text.trim();
  return style ? `${style}, ${subject}` : subject;
}

/** Turns an edit instruction into a prompt for image-to-image on top of the
 * original prompt ("change the background to a snowy mountain landscape"). */
export function composeEditPrompt(originalPrompt: string, instruction: string): string {
  const base = originalPrompt.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  const bg = /\b(?:change|replace|swap|make|turn)\s+(?:the\s+)?background\s+(?:to|into|with|for)\s+(.+)/i.exec(instruction);
  if (bg) {
    const scene = bg[1].replace(/[.!]+$/, '');
    const subject = base.replace(/\bin (?:the )?[\w\s]+? at [\w\s]+$/i, '').replace(/\b(?:at )?(?:sunset|sunrise|dusk|dawn|night)\b/gi, '').replace(/[,\s]+$/, '').trim();
    const winter = /\b(snow|snowy|winter|ice|icy)\b/i.test(scene) ? ', winter, snow-covered ground and trees' : '';
    return `${subject}, ${scene} in the background${winter}`;
  }
  return `${base}, ${instruction.replace(/[.!]+$/, '')}`;
}

/** Picks the installed checkpoint that fits the request's style: anime-style
 * prompts use an anime checkpoint; everything else prefers an SDXL photoreal
 * one (far better than the SD 1.5 "general" fallback on a 24 GB GPU). Models
 * that need a special workflow (e.g. Qwen-Image turbo + LoRA) are skipped. */
export function selectImageCheckpoint(prompt: string, checkpoints: Array<{ name: string; category: string }>): string | undefined {
  const usable = checkpoints.filter((c) => /\.(safetensors|ckpt)$/i.test(c.name));
  const byCategory = (category: string) => usable.filter((c) => c.category.toLowerCase() === category);
  const preferXl = (list: Array<{ name: string }>) => list.find((c) => /xl/i.test(c.name)) ?? list[0];
  const wanted = ANIME_STYLE.test(prompt) ? ['anime', 'photoreal', 'general'] : ['photoreal', 'general', 'anime'];
  for (const category of wanted) {
    const pick = preferXl(byCategory(category));
    if (pick) return pick.name;
  }
  return usable[0]?.name ?? checkpoints[0]?.name;
}

/** Strips the instructional lead-in ("generate an image of ...") so the
 * remainder reads as a plain image-generation prompt. Falls back to the
 * original text when stripping would leave nothing. */
export function extractImageGenerationPrompt(text: string): string {
  const trimmed = text.trim();
  const match = IMAGE_GENERATION_LEADING_PHRASE.exec(trimmed);
  if (!match) return trimmed;
  // Keep style words that sat before the noun ("photorealistic image of …").
  const style = (match[1] ?? '').trim();
  const subject = trimmed.slice(match[0].length).trim();
  if (!subject) return trimmed;
  return style ? `${style}, ${subject}` : subject;
}

/** A request asking about weather/temperature/forecast conditions. Plain
 * chat has no tool access at all (see `image_generate`'s identical
 * constraint), so this is routed the same way image-generation requests
 * are: detected here, dispatched directly through the governed
 * `get_weather` capability, never left to the model's own tool-calling. */
const WEATHER_NOUN = /\b(weather|temperature|forecast|rain(?:ing|y)?|snow(?:ing|y)?|humidity)\b/i;
const WEATHER_LOCATION_PHRASE =
  /\b(?:weather|temperature|forecast)\b(?:\s+\w+)*?\s+(?:in|for|at)\s+([a-z][a-z\s.'-]*?)(?=\s+(?:right now|today|currently|now|this week)\b|[?.!]|$)/i;

export function detectWeatherIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return WEATHER_NOUN.test(trimmed);
}

/** Extracts the place name from a weather question ("what's the weather in
 * Ulm?" -> "Ulm"). Returns null when no location phrase is found — the
 * caller must ask the user rather than guess a location. */
export function extractWeatherLocation(text: string): string | null {
  const match = WEATHER_LOCATION_PHRASE.exec(text.trim());
  const location = match?.[1]?.trim();
  return location && location.length <= 200 ? location : null;
}

/**
 * A direct answer to "Which location?" — "Ulm", "in Ulm", "it's Ulm" — has
 * no weather noun of its own, so it never matches `WEATHER_LOCATION_PHRASE`
 * or even routes through weather-intent detection. Callers use this only
 * when a clarification is specifically pending, so a short reply is treated
 * as the place name rather than guessed at from arbitrary chat text.
 */
export function extractBareLocationAnswer(text: string): string | null {
  const stripped = text
    .trim()
    .replace(/^(?:it'?s|it\s+is|in|at|for|near)\s+/i, '')
    .replace(/[?.!]+$/, '')
    .trim();
  if (!stripped || stripped.length > 80) return null;
  // Reject anything that still reads as a full sentence/question rather
  // than a bare place name (a real follow-up question, not an answer).
  if (/[?]/.test(text) || stripped.split(/\s+/).length > 5) return null;
  return stripped;
}

/**
 * Ordinary conversation works without a repository (Core baat_kar chat).
 * Local Core and autonomous mission require a selected folder. A
 * file-creation-shaped request is routed through the existing governed
 * autonomous-mission path whenever a repository is selected — that loop
 * already refuses to report completion without a real, validated,
 * committed mutation (see `missionObservations.ts` `completionRefusal`) —
 * rather than the read-only Local Core path or plain chat, neither of which
 * can create a file, so as not to let either one report false success.
 */
export function planDesktopInteraction(input: {
  hasFolder: boolean;
  workerId: string;
  goalText?: string;
}): DesktopInteractionPlan {
  const worker = (input.workerId || 'local-core').trim();
  const wantsFileCreation = Boolean(input.goalText) && detectFileCreationIntent(input.goalText!);
  if (!input.hasFolder) {
    if (worker === 'autonomous-mission') {
      return {
        mode: 'mission',
        requestedMode: 'saath_kar',
        blockReason: 'Select a repository before starting an autonomous mission.',
        needsWorkspace: true,
      };
    }
    if (wantsFileCreation) {
      return {
        mode: 'chat',
        requestedMode: 'baat_kar',
        blockReason: 'Select a repository to create this file — Jarvis cannot write files without one.',
        needsWorkspace: true,
      };
    }
    // Default worker is local-core; without a folder that path cannot run.
    // Route to ordinary chat instead of submitting a Local Core attempt that
    // immediately fails and historically rendered as "Completed".
    return { mode: 'chat', requestedMode: 'baat_kar' };
  }
  if (worker === 'autonomous-mission' || wantsFileCreation) {
    return { mode: 'mission', requestedMode: 'saath_kar' };
  }
  if (worker === 'local-core') {
    return { mode: 'local_core', requestedMode: 'saath_kar' };
  }
  return { mode: 'mission', requestedMode: 'saath_kar' };
}

/** Maps a terminal turn to the truthful "what happened" label. `mission`
 * mode only ever reports `completed` once a real mutation was approved,
 * validated, and delivered (see `completionRefusal`), so a completed
 * mission turn is safely `workspace_changed`; chat/local_core turns can
 * never mutate anything, so a completed one is always `answered` — never a
 * false claim that a file was written. */
export function classifyTurnOutcomeKind(input: {
  outcome: DesktopTurnOutcome;
  mode: DesktopInteractionMode;
}): DesktopTurnOutcomeKind | null {
  if (input.outcome === 'failed') return 'failed';
  if (input.outcome === 'cancelled') return null;
  if (input.outcome === 'completed') {
    return input.mode === 'mission' ? 'workspace_changed' : 'answered';
  }
  return null;
}

/**
 * Terminal UI state from explicit outcome / event kinds — never from “attempt
 * ended” alone. Failure reasons that omit the word “fail” must still show Failed.
 */
export function deriveTerminalJarvisState(input: {
  lastTurnOutcome?: DesktopTurnOutcome | null;
  terminal: boolean;
  diagnostics?: ReadonlyArray<{ kind?: string; eventType?: string }>;
  finalOutcome?: string | null;
}): 'completed' | 'failed' | 'cancelled' | null {
  if (input.lastTurnOutcome === 'completed') return 'completed';
  if (input.lastTurnOutcome === 'failed') return 'failed';
  if (input.lastTurnOutcome === 'cancelled') return 'cancelled';
  if (!input.terminal) return null;

  const diags = input.diagnostics ?? [];
  if (diags.some((e) => e.kind === 'cancelled' || e.eventType === 'attempt_cancelled')) {
    return 'cancelled';
  }
  if (diags.some((e) => e.kind === 'error' || e.eventType === 'attempt_failed')) {
    return 'failed';
  }
  if (diags.some((e) => e.kind === 'result')) {
    return 'completed';
  }
  // Terminal without a successful result event → failed (do not infer success).
  if (input.finalOutcome) return 'failed';
  return 'failed';
}

/**
 * A send that only asks to stop the running work ("stop", "cancel that", "please halt"). It is routed
 * to cancellation immediately instead of waiting behind the work it is meant to end. Anything that
 * carries more content ("stop using tabs and use spaces") is an instruction, not a Stop.
 */
const STOP_INTENT = /^\s*(?:(?:please|pls)\s+)?(?:stop|cancel|halt|abort|kill)(?:\s+(?:it|that|this|the task|that task|this task|the job|everything|all|now|working|coding|please))*\s*[.!]*\s*$/i;

export function isStopIntent(text: string): boolean {
  return STOP_INTENT.test(text);
}
