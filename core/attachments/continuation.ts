/**
 * Attachment continuation: which earlier attachments of a conversation still belong to the current follow-up.
 *
 * "What is the red object?" after "What is in this image?" must resolve the image from the conversation, not ask for a
 * re-upload. Pure and bounded: the newest few ready attachments from the last few user turns, never from another
 * conversation (a New Chat is a new conversation id with no links), never deleted or not-ready ones.
 */
import type { AttachmentRecord } from '../shared/wireTypes';

export const CONTINUATION_WINDOW_USER_TURNS = 4;
export const MAX_CONTINUATION_ATTACHMENTS = 3;
export const MAX_CONTINUATION_IMAGES = 2;
/** Per-attachment bounded text carried forward, much smaller than a first-turn attachment so follow-ups stay cheap. */
export const MAX_CONTINUATION_TEXT_BYTES = 12 * 1024;

export interface ContinuationInput {
  /** Conversation messages in order. The last user message is the current turn and is never a source. */
  messages: ReadonlyArray<{ id: string; role: string }>;
  byMessage: Readonly<Record<string, readonly AttachmentRecord[]>>;
  /** Attachments already sent with the current turn. */
  excludeAttachmentIds?: ReadonlySet<string>;
  windowUserTurns?: number;
  max?: number;
  /** True before the current turn has been appended (the host's pre-submit check): every user message is then an earlier turn. */
  currentTurnNotYetAppended?: boolean;
}

/** An earlier attachment is not carried into a turn that resumes after this long, unless the message points at it. */
export const CONTINUATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const SMALL_TALK = /^\s*(?:hi|hello|hey|hiya|yo|good\s+(?:morning|afternoon|evening|night)|thanks?|thank\s+you|ok(?:ay)?|cool|bye)\b/i;
const ATTACHMENT_REFERENCE = /\b(?:this|that|these|those|attached|attachment|above|earlier|previous|document|doc|file|pdf|invoice|resume|cv|letter|image|picture|photo|screenshot|audio|recording|scan|receipt|contract|report|page)\b/i;
const FRESH_PLUS_EARLIER = /\b(?:earlier|previous|other|first|before|compare|both)\b/i;
const UNRELATED_DOMAIN = /\b(?:calendar|schedule|meeting|weather|remind(?:er)?s?|e-?mail|gmail|inbox|telemetry)\b/i;

/**
 * Whether earlier attachments belong to THIS turn. The latest message is authoritative: a greeting or an unrelated
 * request (calendar, weather, mail) must not drag an old document into the prompt, a newly attached file is what
 * "this document" means, and a conversation resumed after a long gap does not silently keep an old attachment.
 */
export function continuationApplies(input: { message: string; hasFreshAttachment: boolean; newestEarlierCreatedAt?: string }): boolean {
  const text = input.message.trim();
  const refers = ATTACHMENT_REFERENCE.test(text);
  if (input.hasFreshAttachment) return FRESH_PLUS_EARLIER.test(text);
  if (text.length <= 25 && SMALL_TALK.test(text) && !refers) return false;
  if (UNRELATED_DOMAIN.test(text) && !refers) return false;
  const createdMs = input.newestEarlierCreatedAt ? Date.parse(input.newestEarlierCreatedAt) : NaN;
  if (Number.isFinite(createdMs) && Date.now() - createdMs > CONTINUATION_MAX_AGE_MS && !refers) return false;
  return true;
}

export function selectContinuationAttachments(input: ContinuationInput): AttachmentRecord[] {
  const userMessages = input.messages.filter(message => message.role === 'user');
  const earlier = (input.currentTurnNotYetAppended ? userMessages : userMessages.slice(0, -1)).slice(-(input.windowUserTurns ?? CONTINUATION_WINDOW_USER_TURNS));
  const picked: AttachmentRecord[] = [];
  for (const message of earlier) {
    for (const attachment of input.byMessage[message.id] ?? []) {
      if (attachment.status !== 'ready' || attachment.deletedAt) continue;
      if (input.excludeAttachmentIds?.has(attachment.id)) continue;
      picked.push(attachment);
    }
  }
  return picked.slice(-(input.max ?? MAX_CONTINUATION_ATTACHMENTS));
}
