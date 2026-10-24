/**
 * Attachment retention across a blocked turn (host side).
 *
 * Core links a turn's attachments to its user message inside the same transaction that creates the attempt. When the turn
 * is refused BEFORE that point (no vision-capable model could be selected, Core rejected an image submitted to a text-only
 * selection, Core was unreachable) the transaction never commits: the attachment is uploaded, ready and conversation-scoped,
 * but linked to no message, and the composer already cleared its chip. "Resume" then arrives as a text-only turn and the
 * assistant truthfully reports that no image is present.
 *
 * This keeps the authoritative attachment identity (ids Core already issued, never bytes) and the original objective text for
 * exactly that case, and re-presents them when the user says resume/continue/retry. A turn that DID commit needs nothing
 * here: its attachments are linked and Core's own continuation (core/attachments/continuation.ts) carries them.
 *
 * Scope: one conversation. New Chat clears everything; reopening a conversation from History does not reactivate a retention
 * (History stays inert); a new upload, or the turn finally committing, replaces/consumes it.
 */
import { classifyControlAcknowledgement } from '../orchestration/ConversationContinuity';

export interface RetainedAttachmentTurn {
  /** The original objective the attachments belonged to (what "resume" continues). */
  text: string;
  attachmentIds: string[];
  /** Why the turn did not commit; shown to the user when the attachments are carried. */
  reason: string;
}

const TRY_AGAIN = /^(?:please\s+)?(?:try\s+again|go\s+again|do\s+it\s+again|re-?send|send\s+it\s+again)\s*[.!]?$/i;

/** Bare resume / continue / retry: the message carries no objective of its own. */
export function isBareResumeIntent(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  const ack = classifyControlAcknowledgement(trimmed);
  return ack === 'confirm_continue' || ack === 'retry' || TRY_AGAIN.test(trimmed);
}

export class AttachmentRetention {
  private readonly byConversation = new Map<string, RetainedAttachmentTurn>();

  retain(conversationId: string, turn: RetainedAttachmentTurn): void {
    if (!conversationId || turn.attachmentIds.length === 0) return;
    this.byConversation.set(conversationId, { text: turn.text, attachmentIds: [...turn.attachmentIds], reason: turn.reason });
  }

  peek(conversationId: string): RetainedAttachmentTurn | undefined {
    return this.byConversation.get(conversationId);
  }

  /** The turn committed (or a newer upload replaced the old one): nothing is left to carry. */
  consume(conversationId: string): void {
    this.byConversation.delete(conversationId);
  }

  clear(conversationId?: string): void {
    if (conversationId === undefined) this.byConversation.clear();
    else this.byConversation.delete(conversationId);
  }

  /**
   * What the next turn should actually submit. Explicit new attachments always win and drop the old retention. A bare
   * resume/continue/retry re-presents the retained objective with the SAME attachments; anything else is left untouched
   * (a different request must not silently inherit an old image).
   */
  resolve(conversationId: string, text: string, incomingAttachmentIds: readonly string[]): { text: string; attachmentIds: string[]; carried: boolean; reason?: string } {
    if (incomingAttachmentIds.length > 0) {
      this.byConversation.delete(conversationId);
      return { text, attachmentIds: [...incomingAttachmentIds], carried: false };
    }
    const retained = this.byConversation.get(conversationId);
    if (!retained || !isBareResumeIntent(text)) return { text, attachmentIds: [], carried: false };
    return { text: retained.text, attachmentIds: [...retained.attachmentIds], carried: true, reason: retained.reason };
  }
}
