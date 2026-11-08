import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { createSocialDraft, decideSocialDraft, listSocialDrafts } from '../domain/socialDrafts';

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('Social Studio drafts never publish', () => {
  it('approval only reaches "approved, not published"', () => {
    const d = createSocialDraft(db, { channel: 'instagram', text: 'New kitchen app is live' });
    expect(d.status).toBe('draft');
    expect(decideSocialDraft(db, d.id, { decision: 'approve' }).status).toBe('approved_not_published');
  });
  it('rejection needs a reason; revision with text bumps the revision and returns to draft', () => {
    const d = createSocialDraft(db, { channel: 'linkedin', text: 'v1' });
    expect(() => decideSocialDraft(db, d.id, { decision: 'reject' })).toThrow(/why/);
    expect(decideSocialDraft(db, d.id, { decision: 'reject', note: 'off brand' })).toMatchObject({ status: 'rejected', decisionNote: 'off brand' });
    const e = createSocialDraft(db, { channel: 'unknown-network', text: 'v1' });
    expect(e.channel).toBe('other');
    expect(decideSocialDraft(db, e.id, { decision: 'revise', note: 'shorter' }).status).toBe('needs_revision');
    expect(decideSocialDraft(db, e.id, { decision: 'revise', text: 'v2' })).toMatchObject({ status: 'draft', text: 'v2', revision: 2 });
  });
  it('refuses empty and oversized drafts', () => {
    expect(() => createSocialDraft(db, { channel: 'x', text: '  ' })).toThrow();
    expect(() => createSocialDraft(db, { channel: 'x', text: 'a'.repeat(5001) })).toThrow(/5000/);
    expect(listSocialDrafts(db)).toHaveLength(0);
  });
});
