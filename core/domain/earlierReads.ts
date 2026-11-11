/**
 * What the model read earlier in this conversation, carried into the next turn (micro-test cluster C4, D-JOB-1).
 *
 * The conversation history Pi receives holds only user and assistant text; tool results from earlier turns are gone.
 * In Build 163 the model read a job posting in one turn and, two turns later, said "I've reviewed the job posting ...
 * it does not mention a specific application deadline" — the file says "Application deadline: 30 November 2026"
 * (JOB-011; also JOB-010/012/021/024/025, CAT-022, COD-015). This module reads Core's own tool records for the
 * conversation and returns a short, bounded section with the latest content of each file read there, so follow-up
 * questions are answered from what the file said, not from memory of a summary.
 */
import type { CoreDatabase } from '../db/connection';

/** Tools whose successful output is the content of a local file or document. */
const READ_TOOLS = ['read_file', 'document_read', 'document_ocr'] as const;

export interface EarlierRead { tool: string; target: string; at: string; content: string }

export function listEarlierReads(db: CoreDatabase, conversationId: string, options: { excludeRequestId?: string; limit?: number } = {}): EarlierRead[] {
  const rows = db.all<{ toolName: string; argsSummary: string; evidence: string; at: string }>(
    `SELECT ti.toolName AS toolName, ti.argsSummary AS argsSummary, ti.evidence AS evidence, COALESCE(ti.endedAt, ti.startedAt) AS at
       FROM tool_invocations ti
       JOIN attempts a ON a.id = ti.attemptId
       JOIN requests r ON r.id = a.requestId
      WHERE r.conversationId = ? AND r.id != ? AND ti.status = 'succeeded'
        AND ti.toolName IN (${READ_TOOLS.map(() => '?').join(', ')})
      ORDER BY ti.startedAt DESC, ti.rowid DESC
      LIMIT 40`,
    [conversationId, options.excludeRequestId ?? '', ...READ_TOOLS],
  );
  const seen = new Set<string>();
  const out: EarlierRead[] = [];
  for (const row of rows) {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(row.argsSummary) as Record<string, unknown>; } catch { /* summary only */ }
    const target = String(args.filePath ?? args.path ?? args.file ?? '').trim();
    if (!target) continue;
    const key = target.toLowerCase().replace(/\\+/g, '\\');
    if (seen.has(key)) continue; // the latest read of a file wins
    let content = '';
    try {
      const ev = JSON.parse(row.evidence) as { output?: unknown };
      content = typeof ev.output === 'string' ? ev.output : '';
    } catch { content = ''; }
    if (!content.trim() || /^(?:NOT DONE|NOT OPENED|Error)/i.test(content.trim())) continue;
    seen.add(key);
    out.push({ tool: row.toolName, target, at: row.at, content });
    if (out.length >= (options.limit ?? 6)) break;
  }
  return out;
}

/** The prompt section, or '' when nothing was read earlier. Bounded: each file and the whole section are capped. */
export function renderEarlierReadsSection(reads: readonly EarlierRead[], limits: { perFileChars?: number; totalChars?: number } = {}): string {
  if (reads.length === 0) return '';
  const per = limits.perFileChars ?? 1800;
  const total = limits.totalChars ?? 7000;
  const parts: string[] = [];
  let used = 0;
  for (const r of reads) {
    const body = r.content.length > per ? `${r.content.slice(0, per)}\n[... cut; read the file again for the rest]` : r.content;
    const block = `--- ${r.target} (${r.tool}, ${r.at})\n${body}`;
    if (used + block.length > total) break;
    parts.push(block);
    used += block.length;
  }
  if (parts.length === 0) return '';
  return 'FILES READ EARLIER IN THIS CONVERSATION (exact text your tools returned then; it may have changed since). Answer questions about these files from this text or read them again; never say a file lacks something without checking it here or re-reading it:\n' + parts.join('\n');
}
