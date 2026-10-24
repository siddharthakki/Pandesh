/**
 * EvidenceLedger (host-neutral, JARVIS-reusable): the record of what was actually observed or done.
 *
 * A model's claim ("tests passed", "file exists", "objective complete") is checked against this
 * ledger and never the other way round. Nothing here is written from model prose: entries come
 * from tool results and host-owned checks only.
 */
export type EvidenceKind =
  | 'file_read'
  | 'file_written'
  | 'file_listed'
  | 'command_run'
  | 'test_run'
  | 'build_run'
  | 'browser_observation'
  | 'attachment'
  | 'user_statement';

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  /** Normalised subject: a path for file evidence, the command for command evidence, a URL for browser evidence. */
  subject: string;
  /** Short factual summary produced by the host. */
  summary: string;
  ok?: boolean;
  exitCode?: number;
  /** Bounded excerpt used for `file_contains`-style checks. */
  excerpt?: string;
  /** Content hash when known, so a later change invalidates "file contains" evidence. */
  contentHash?: string;
  at: number;
  /** KNOWN = observed directly; DERIVED = computed from observations (graph, diff). */
  tier: 'KNOWN' | 'DERIVED';
}

export type ClaimKind = 'tests_passed' | 'build_succeeded' | 'file_exists' | 'file_contains' | 'file_written' | 'command_succeeded' | 'objective_complete';

export interface Claim {
  kind: ClaimKind;
  subject?: string;
  /** For file_contains: the text asserted to be present. */
  text?: string;
  /** For objective_complete: files/targets the objective requires. */
  requiredTargets?: string[];
}

export interface ClaimVerdict {
  claim: Claim;
  verified: boolean;
  /** Ids of the entries that support (or, for failures, contradict) the claim. */
  evidenceIds: string[];
  reason: string;
}

export function normalizeSubject(subject: string): string {
  return subject.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

export class EvidenceLedger {
  private readonly entries: EvidenceEntry[] = [];
  private nextId = 1;
  constructor(private readonly now: () => number = () => Date.now(), private readonly maxEntries = 2000) {}

  record(entry: Omit<EvidenceEntry, 'id' | 'at' | 'tier'> & { tier?: EvidenceEntry['tier'] }): EvidenceEntry {
    const full: EvidenceEntry = {
      ...entry,
      id: `ev-${this.nextId++}`,
      at: this.now(),
      tier: entry.tier ?? 'KNOWN',
      subject: entry.kind === 'command_run' || entry.kind === 'test_run' || entry.kind === 'build_run' || entry.kind === 'browser_observation'
        ? entry.subject.trim()
        : normalizeSubject(entry.subject),
      excerpt: entry.excerpt?.slice(0, 4000),
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return full;
  }

  all(): readonly EvidenceEntry[] { return this.entries; }
  get(id: string): EvidenceEntry | undefined { return this.entries.find(entry => entry.id === id); }
  forSubject(subject: string): EvidenceEntry[] {
    const key = normalizeSubject(subject);
    return this.entries.filter(entry => normalizeSubject(entry.subject) === key);
  }

  /** The latest write to a path, if any; later writes supersede earlier file evidence. */
  private lastWrite(subject: string): EvidenceEntry | undefined {
    return [...this.forSubject(subject)].reverse().find(entry => entry.kind === 'file_written' && entry.ok !== false);
  }

  verify(claim: Claim): ClaimVerdict {
    const unverified = (reason: string, evidenceIds: string[] = []): ClaimVerdict => ({ claim, verified: false, evidenceIds, reason });
    const verified = (reason: string, evidenceIds: string[]): ClaimVerdict => ({ claim, verified: true, evidenceIds, reason });
    switch (claim.kind) {
      case 'tests_passed':
      case 'build_succeeded': {
        const kind = claim.kind === 'tests_passed' ? 'test_run' : 'build_run';
        const runs = this.entries.filter(entry => entry.kind === kind && (!claim.subject || entry.subject.includes(claim.subject)));
        const last = runs.at(-1);
        if (!last) return unverified(`No recorded ${kind === 'test_run' ? 'test' : 'build'} run.`);
        if (last.ok !== true || (last.exitCode !== undefined && last.exitCode !== 0)) {
          return unverified(`The most recent recorded ${kind === 'test_run' ? 'test' : 'build'} run failed (${last.summary}).`, [last.id]);
        }
        // A write after the last green run means the result no longer describes the current files.
        const laterWrite = this.entries.find(entry => entry.kind === 'file_written' && entry.at >= last.at && entry.id !== last.id && Number(entry.id.slice(3)) > Number(last.id.slice(3)));
        if (laterWrite) return unverified(`Files changed after the last passing run (${laterWrite.subject}); it must be re-run.`, [last.id, laterWrite.id]);
        return verified(`Recorded passing run: ${last.summary}.`, [last.id]);
      }
      case 'command_succeeded': {
        const run = [...this.entries].reverse().find(entry => entry.kind === 'command_run' && (!claim.subject || entry.subject.includes(claim.subject)));
        if (!run) return unverified('No recorded command run.');
        return run.ok === true && (run.exitCode === undefined || run.exitCode === 0)
          ? verified(`Recorded successful command: ${run.summary}.`, [run.id])
          : unverified(`The recorded command did not succeed (${run.summary}).`, [run.id]);
      }
      case 'file_exists': {
        if (!claim.subject) return unverified('No file named.');
        const write = this.lastWrite(claim.subject);
        const read = this.forSubject(claim.subject).find(entry => (entry.kind === 'file_read' || entry.kind === 'file_listed') && entry.ok !== false);
        const evidence = write ?? read;
        return evidence ? verified(`Observed via ${evidence.kind}.`, [evidence.id]) : unverified(`No recorded read, listing or write of ${claim.subject}.`);
      }
      case 'file_written': {
        if (!claim.subject) return unverified('No file named.');
        const write = this.lastWrite(claim.subject);
        return write ? verified('A write to this file was recorded.', [write.id]) : unverified(`No recorded write to ${claim.subject}.`);
      }
      case 'file_contains': {
        if (!claim.subject || !claim.text) return unverified('A file and the asserted text are both required.');
        const needle = claim.text.toLowerCase();
        const candidates = this.forSubject(claim.subject).filter(entry => (entry.kind === 'file_read' || entry.kind === 'file_written') && entry.excerpt !== undefined);
        const latest = candidates.at(-1);
        if (!latest) return unverified(`No recorded content of ${claim.subject} to check against.`);
        return latest.excerpt!.toLowerCase().includes(needle)
          ? verified('The recorded content includes the text.', [latest.id])
          : unverified('The recorded content does not include that text.', [latest.id]);
      }
      case 'objective_complete': {
        const targets = (claim.requiredTargets ?? []).map(normalizeSubject);
        if (targets.length === 0) return unverified('No required targets were identified, so completion cannot be shown.');
        const missing: string[] = [];
        const ids: string[] = [];
        for (const target of targets) {
          const write = this.lastWrite(target);
          if (write) ids.push(write.id); else missing.push(target);
        }
        return missing.length === 0
          ? verified(`Every required target has a recorded write (${targets.length}).`, ids)
          : unverified(`No recorded write for: ${missing.join(', ')}.`, ids);
      }
    }
  }

  verifyAll(claims: readonly Claim[]): ClaimVerdict[] { return claims.map(claim => this.verify(claim)); }
}

/**
 * Extracts checkable claims from assistant prose. Conservative: it only recognises explicit, common phrasings and
 * never invents a subject. Unrecognised prose yields no claims, which is not the same as "verified".
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  if (/\b(all\s+)?tests?\s+(are\s+)?(pass(ed|ing)?|green|succeed(ed)?)\b/i.test(text)) claims.push({ kind: 'tests_passed' });
  if (/\b(build|compil(e|ation)|typecheck)\s+(is\s+|was\s+)?(succeed(ed)?|success(ful)?|pass(ed)?|clean)\b/i.test(text)) claims.push({ kind: 'build_succeeded' });
  const created = /\b(?:created|wrote|written|added)\s+(?:the\s+)?(?:file\s+)?[`"']?([\w./\\-]+\.[A-Za-z0-9]{1,8})[`"']?/gi;
  for (const match of text.matchAll(created)) claims.push({ kind: 'file_written', subject: match[1] });
  return claims;
}
