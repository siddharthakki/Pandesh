/**
 * Software-build intent. A request to BUILD software ("build an app that takes an image and
 * generates instructions") merely mentions media words; it is not a media request. Keyword
 * shortcuts for image/video generation consult this first so the build intent always wins.
 * Pure and deterministic; looks only at the current request text.
 */

const BUILD_VERB = String.raw`(?:build|builds|building|create|make|develop|write|code|implement|program|design|scaffold|prototype|ship|set up|spin up)`;
const SOFTWARE_NOUN = String.raw`(?:app|apps|application|applications|web ?app|web ?site|website|site|program|script|tool|utility|plugin|plug-in|extension|add-on|addon|api|backend|frontend|service|software|bot|chatbot|cli|library|package|module|component|dashboard|game|extension|widget|pipeline|server|microservice|sdk|mvp)`;
// "app icon", "tool logo", "website mockup": the noun describes a picture, not software.
const PICTURE_TAIL = String.raw`(?!\s+(?:icons?|logos?|mock-?ups?|screenshots?|illustrations?|images?|pictures?|photos?|wallpapers?|posters?|banners?|artwork|avatars?|graphics?|designs? image)\b)`;

const BUILD_INTENT = new RegExp(
  String.raw`\b${BUILD_VERB}\b(?:\s+(?:me|us))?\s+(?:(?:an?|the|my|our|some|this|that)\s+)?(?:[\w-]+\s+){0,4}?${SOFTWARE_NOUN}\b${PICTURE_TAIL}`,
  'i',
);
const NEED_INTENT = new RegExp(
  String.raw`\b(?:i|we)\s+(?:need|want|would like|'d like)\s+(?:an?|the)\s+(?:[\w-]+\s+){0,3}?${SOFTWARE_NOUN}\s+(?:that|which|to|for|where)\b`,
  'i',
);
const CODE_VERB_OBJECT = /\b(?:write|implement|code)\b[^.\n!?]{0,40}\b(?:function|class|endpoint|script|program|code|algorithm)\b/i;

export function hasSoftwareBuildIntent(text: string): boolean {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  return BUILD_INTENT.test(t) || NEED_INTENT.test(t) || CODE_VERB_OBJECT.test(t);
}

export type RequestedOutcome = 'software' | 'media' | 'other';

/** What was ASKED for, as far as the request text says. */
export function requestedOutcomeOf(text: string): RequestedOutcome {
  return hasSoftwareBuildIntent(text) ? 'software' : 'other';
}

export interface DeliveredOutcomeCheck {
  satisfied: boolean;
  reason: string;
}

/**
 * Requested vs delivered. Generated media (images, videos) never satisfies a request to build
 * software; only a workspace/code change, a file, or an explicit plan does.
 */
export function checkDeliveredOutcome(requestText: string, delivered: ReadonlyArray<{ kind: string }>): DeliveredOutcomeCheck {
  if (requestedOutcomeOf(requestText) !== 'software') return { satisfied: true, reason: 'no software outcome was requested' };
  if (delivered.length === 0) return { satisfied: false, reason: 'nothing was delivered for the requested software build' };
  const onlyMedia = delivered.every((item) => item.kind === 'image' || item.kind === 'video' || item.kind === 'audio');
  if (onlyMedia) return { satisfied: false, reason: 'only generated media was delivered; a software build was requested, so the request is not satisfied' };
  return { satisfied: true, reason: 'non-media output was delivered' };
}
