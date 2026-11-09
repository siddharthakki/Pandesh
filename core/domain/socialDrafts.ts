/**
 * Phase 2f — Social Studio drafts. A draft is text for a channel and the
 * user's decision on it. There is no publishing integration: an approved
 * draft stays "approved, not published" until a connector exists (Phase 3).
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export type DraftStatus = 'draft' | 'approved_not_published' | 'rejected' | 'needs_revision';
export const SOCIAL_CHANNELS = ['instagram', 'linkedin', 'facebook', 'x', 'tiktok', 'youtube', 'other'] as const;
export interface SocialDraft { id: string; channel: string; text: string; status: DraftStatus; decisionNote: string | null; decidedAt: string | null; revision: number; createdAt: string; updatedAt: string }

export function listSocialDrafts(db: CoreDatabase): SocialDraft[] {
  return db.all<SocialDraft>('SELECT * FROM social_drafts ORDER BY updatedAt DESC LIMIT 200');
}

export function createSocialDraft(db: CoreDatabase, input: { channel: string; text: string }): SocialDraft {
  const text = String(input.text ?? '').trim();
  if (!text) throw new CoreError('invalid_request', 'a draft needs text');
  if (text.length > 5000) throw new CoreError('invalid_request', 'a draft is limited to 5000 characters');
  const channel = (SOCIAL_CHANNELS as readonly string[]).includes(input.channel) ? input.channel : 'other';
  const id = newId('sdr'); const now = nowIso();
  db.run("INSERT INTO social_drafts (id, channel, text, status, revision, createdAt, updatedAt) VALUES (?, ?, ?, 'draft', 1, ?, ?)", [id, channel, text, now, now]);
  return db.get<SocialDraft>('SELECT * FROM social_drafts WHERE id = ?', [id])!;
}

export function decideSocialDraft(db: CoreDatabase, id: string, input: { decision: 'approve' | 'reject' | 'revise'; note?: string; text?: string }): SocialDraft {
  const d = db.get<SocialDraft>('SELECT * FROM social_drafts WHERE id = ?', [id]);
  if (!d) throw new CoreError('not_found', 'draft not found');
  const note = input.note?.trim() || null;
  const now = nowIso();
  if (input.decision === 'reject' && !note) throw new CoreError('invalid_request', 'say why the draft is rejected');
  if (input.decision === 'revise') {
    const text = input.text?.trim();
    if (text) db.run("UPDATE social_drafts SET text = ?, status = 'draft', decisionNote = ?, revision = revision + 1, updatedAt = ? WHERE id = ?", [text, note, now, id]);
    else db.run("UPDATE social_drafts SET status = 'needs_revision', decisionNote = ?, decidedAt = ?, updatedAt = ? WHERE id = ?", [note, now, now, id]);
  } else {
    db.run('UPDATE social_drafts SET status = ?, decisionNote = ?, decidedAt = ?, updatedAt = ? WHERE id = ?', [input.decision === 'approve' ? 'approved_not_published' : 'rejected', note, now, now, id]);
  }
  return db.get<SocialDraft>('SELECT * FROM social_drafts WHERE id = ?', [id])!;
}
