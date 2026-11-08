/**
 * Research provenance (re-run M9).
 *
 * Every web source a research tool fetched is recorded with its URLs, title, the SHA-256 of the full readable text and
 * that text itself (credential-shaped strings redacted, bounded, and cleared after a retention window). This is what
 * lets a citation be rebuilt after the fact and lets Core check a reply's named claims against what was actually
 * retrieved, instead of against the short excerpt the model saw.
 *
 * Only public web content is stored here; queries pass Core's public-query check before they leave the machine.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { redactSecrets } from '../platform/credentialStore';

/** Readable text kept per source. */
export const MAX_STORED_SOURCE_CHARS = 64_000;
/** How long the page text is kept; URL, title and hash are kept for the life of the conversation. */
export const DEFAULT_SOURCE_RETENTION_DAYS = 30;

export interface ResearchSourceInput {
  marker?: string | null;
  searchUrl?: string | null;
  finalUrl: string;
  title?: string | null;
  /** The full readable text extracted from the page (before the excerpt cut). */
  fullText: string;
  /** How many characters of it the model was shown. */
  excerptChars: number;
}

export interface ResearchProvenance {
  query: string;
  retrievedAt: string;
  sources: ResearchSourceInput[];
}

/**
 * Credential shapes that public pages can carry by mistake, on top of the shared `redactSecrets` set (M9 audit: the
 * shared set redacted 1 of 7 representative synthetic secrets — GitHub, AWS, Slack, JWT, PEM keys and token query
 * parameters were stored as-is).
 */
const RESEARCH_SECRET_SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  // ?access_token=…, &api_key=…, &sig=… — keep the parameter name, drop the value
  [/([?&;](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|auth|signature|sig|session|sessionid|code)=)[^&#\s"'<>]+/gi, '$1[redacted]'],
  [/\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)["']?[^\s"'<>&,;]{6,}/gi, '$1[redacted]'],
];

export function redactResearchText(text: string): string {
  let out = redactSecrets(String(text ?? ''));
  for (const [shape, replacement] of RESEARCH_SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KARKEDIKHA_RESEARCH_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 0 && raw <= 365 ? raw : DEFAULT_SOURCE_RETENTION_DAYS;
}

/** Strips URL credentials and fragment; query strings stay (they identify the page) but credential shapes are redacted. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.hash = '';
    return redactResearchText(u.toString());
  } catch {
    return redactResearchText(String(url)).slice(0, 2_000);
  }
}

export function recordResearchProvenance(db: CoreDatabase, input: {
  attemptId: string;
  conversationId?: string | null;
  invocationId?: string | null;
  toolName: string;
  provenance: ResearchProvenance;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): number {
  const now = input.now ?? new Date();
  const expires = new Date(now.getTime() + retentionDays(input.env) * 86_400_000).toISOString();
  let written = 0;
  for (const source of input.provenance.sources) {
    const full = String(source.fullText ?? '');
    const sha = crypto.createHash('sha256').update(full, 'utf8').digest('hex');
    const stored = redactResearchText(full.slice(0, MAX_STORED_SOURCE_CHARS));
    db.run(
      `INSERT INTO research_turn_sources (id, attemptId, conversationId, invocationId, toolName, query, marker, searchUrl, finalUrl, title,
         contentSha256, contentChars, excerptChars, content, retrievedAt, contentExpiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `rsrc_${crypto.randomUUID()}`, input.attemptId, input.conversationId ?? null, input.invocationId ?? null, input.toolName,
        redactResearchText(input.provenance.query).slice(0, 500), source.marker ?? null, source.searchUrl ? safeUrl(source.searchUrl) : null,
        safeUrl(source.finalUrl), source.title ? redactResearchText(source.title).slice(0, 500) : null,
        sha, full.length, source.excerptChars, stored, input.provenance.retrievedAt || now.toISOString(), expires,
      ],
    );
    written += 1;
  }
  return written;
}

/** Clears page text past its retention; returns how many rows were cleared. */
export function purgeExpiredResearchContent(db: CoreDatabase, now: Date = new Date()): number {
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM research_turn_sources WHERE content IS NOT NULL AND contentExpiresAt <= ?', [now.toISOString()])?.n ?? 0;
  if (before > 0) db.run('UPDATE research_turn_sources SET content = NULL WHERE content IS NOT NULL AND contentExpiresAt <= ?', [now.toISOString()]);
  return before;
}

export interface StoredResearchSource {
  marker: string | null;
  finalUrl: string;
  searchUrl: string | null;
  title: string | null;
  content: string | null;
  contentSha256: string;
  retrievedAt: string;
}

/** Sources retrieved for this turn: by the attempt itself, or in its conversation since the turn started (governed calls run on the conversation's anchor attempt). */
export function researchSourcesForTurn(db: CoreDatabase, input: { attemptId: string; conversationId?: string | null; since: string }): StoredResearchSource[] {
  return db.all<StoredResearchSource>(
    `SELECT marker, finalUrl, searchUrl, title, content, contentSha256, retrievedAt FROM research_turn_sources
      WHERE attemptId = ? OR (conversationId IS NOT NULL AND conversationId = ? AND retrievedAt >= ?)
      ORDER BY retrievedAt`,
    [input.attemptId, input.conversationId ?? null, input.since],
  );
}
