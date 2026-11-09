/** Re-run M9: every fetched research source is kept with its hash, redacted text and an expiry. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { purgeExpiredResearchContent, recordResearchProvenance, researchSourcesForTurn, retentionDays } from '../domain/researchProvenance';

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-rsrc-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  try { (db as any).close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
});

const page = 'Senior Product Manager - Logistics. Delivery Hero, Berlin. '.repeat(50) + 'api_key=sk-live-abcdefghijklmnopqrstuvwxyz123456';

describe('research provenance', () => {
  it('stores each source with the hash of its full text, redacts credential shapes and links it to the turn', () => {
    const now = new Date('2026-11-08T10:00:00.000Z');
    const n = recordResearchProvenance(db, {
      attemptId: 'att_1', conversationId: 'conv_1', toolName: 'web_research', now,
      provenance: { query: 'product manager jobs Germany', retrievedAt: now.toISOString(), sources: [
        { marker: 'S1.1', searchUrl: 'https://user:pw@jobs.example/list?q=pm#top', finalUrl: 'https://jobs.example/list?q=pm', title: 'PM jobs', fullText: page, excerptChars: 4000 },
      ] },
    });
    expect(n).toBe(1);
    const rows = researchSourcesForTurn(db, { attemptId: 'att_other', conversationId: 'conv_1', since: '2026-11-08T09:59:00.000Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].contentSha256).toBe(crypto.createHash('sha256').update(page, 'utf8').digest('hex'));
    expect(rows[0].content).toContain('Delivery Hero');
    expect(rows[0].content).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz123456');
    expect(rows[0].searchUrl).not.toContain('pw@');
    expect(rows[0].marker).toBe('S1.1');
  });

  it('clears the stored text after retention and keeps URL, title and hash', () => {
    const now = new Date('2026-11-08T10:00:00.000Z');
    recordResearchProvenance(db, { attemptId: 'att_1', conversationId: null, toolName: 'governed_research', now, env: { KARKEDIKHA_RESEARCH_RETENTION_DAYS: '7' } as any,
      provenance: { query: 'q', retrievedAt: now.toISOString(), sources: [{ finalUrl: 'https://a.example/x', title: 'A', fullText: 'some public text here', excerptChars: 21 }] } });
    expect(purgeExpiredResearchContent(db, new Date('2026-11-14T10:00:00.000Z'))).toBe(0);
    expect(purgeExpiredResearchContent(db, new Date('2026-11-15T10:00:01.000Z'))).toBe(1);
    const [row] = researchSourcesForTurn(db, { attemptId: 'att_1', since: '2000-01-01' });
    expect(row.content).toBeNull();
    expect(row.finalUrl).toBe('https://a.example/x');
    expect(row.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bounds the retention setting', () => {
    expect(retentionDays({} as any)).toBe(30);
    expect(retentionDays({ KARKEDIKHA_RESEARCH_RETENTION_DAYS: '9999' } as any)).toBe(30);
    expect(retentionDays({ KARKEDIKHA_RESEARCH_RETENTION_DAYS: '0' } as any)).toBe(0);
  });
});
