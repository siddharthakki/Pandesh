import { createHash, randomUUID } from 'crypto';

export type ReviewSeverity = 'info' | 'warning' | 'error' | 'critical';
export type ReviewDecision = 'pending' | 'accepted' | 'rejected' | 'resolved';
export type HunkDecision = 'pending' | 'accepted' | 'rejected';

export interface DiffLine {
  kind: 'context' | 'addition' | 'deletion';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  decision: HunkDecision;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

export interface ReviewFinding {
  id: string;
  source: 'agent' | 'user' | 'pr' | 'ci' | 'security';
  file: string;
  line?: number;
  hunkId?: string;
  severity: ReviewSeverity;
  confidence: number;
  message: string;
  evidence?: string;
  suggestedRepair?: string;
  decision: ReviewDecision;
  threadId?: string;
}

export interface ReviewValidation {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export interface ReviewSessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  files: DiffFile[];
  findings: ReviewFinding[];
  validations: ReviewValidation[];
  repairPasses: number;
  status: 'reviewing' | 'repairing' | 'validated' | 'blocked' | 'completed';
}

export interface ReviewRepairRequest {
  sessionId: string;
  findings: ReviewFinding[];
  allowedFiles: string[];
  pass: number;
  signal: AbortSignal;
}

export interface ReviewRepairResult {
  changedFiles: string[];
  resolvedFindingIds: string[];
  summary: string;
}

export type ReviewRepairExecutor = (request: ReviewRepairRequest) => Promise<ReviewRepairResult>;

export class ReviewWorkflow {
  private readonly session: ReviewSessionSnapshot;
  private controller?: AbortController;

  constructor(diff: string, sessionId: string = randomUUID()) {
    const now = new Date().toISOString();
    this.session = {
      schemaVersion: 1,
      sessionId,
      createdAt: now,
      updatedAt: now,
      files: parseUnifiedDiff(diff),
      findings: [],
      validations: [],
      repairPasses: 0,
      status: 'reviewing',
    };
  }

  ingestFindings(findings: Array<Omit<ReviewFinding, 'decision'>>): ReviewSessionSnapshot {
    for (const finding of findings) {
      validateFinding(finding);
      if (this.session.findings.some(existing => existing.id === finding.id)) throw new Error(`Duplicate review finding: ${finding.id}`);
      if (!this.session.files.some(file => matchesFile(file, finding.file))) throw new Error(`Finding targets file outside diff: ${finding.file}`);
      if (finding.hunkId && !this.session.files.flatMap(file => file.hunks).some(hunk => hunk.id === finding.hunkId)) {
        throw new Error(`Finding targets unknown hunk: ${finding.hunkId}`);
      }
      this.session.findings.push({ ...finding, decision: 'pending' });
    }
    this.touch();
    return this.snapshot();
  }

  decideFinding(id: string, decision: Exclude<ReviewDecision, 'pending'>): ReviewSessionSnapshot {
    const finding = this.session.findings.find(item => item.id === id);
    if (!finding) throw new Error(`Unknown review finding: ${id}`);
    finding.decision = decision;
    this.recalculateStatus();
    this.touch();
    return this.snapshot();
  }

  decideHunk(hunkId: string, decision: Exclude<HunkDecision, 'pending'>): ReviewSessionSnapshot {
    const hunk = this.session.files.flatMap(file => file.hunks).find(item => item.id === hunkId);
    if (!hunk) throw new Error(`Unknown diff hunk: ${hunkId}`);
    hunk.decision = decision;
    this.touch();
    return this.snapshot();
  }

  addValidation(validation: ReviewValidation): ReviewSessionSnapshot {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(validation.id)) throw new Error(`Invalid validation id: ${validation.id}`);
    const existing = this.session.validations.find(item => item.id === validation.id);
    if (existing) Object.assign(existing, validation);
    else this.session.validations.push({ ...validation });
    this.recalculateStatus();
    this.touch();
    return this.snapshot();
  }

  async repair(executor: ReviewRepairExecutor, maxPasses = 2): Promise<ReviewSessionSnapshot> {
    if (this.controller) throw new Error('Review repair is already active.');
    if (this.session.repairPasses >= maxPasses) throw new Error('Review repair pass limit reached.');
    const accepted = this.session.findings.filter(finding => finding.decision === 'accepted');
    if (accepted.length === 0) throw new Error('No accepted findings to repair.');
    const allowedFiles = [...new Set(accepted.map(finding => normalizePath(finding.file)))].sort();
    this.controller = new AbortController();
    this.session.status = 'repairing';
    this.touch();
    try {
      const result = await executor({
        sessionId: this.session.sessionId,
        findings: accepted.map(cloneFinding),
        allowedFiles,
        pass: this.session.repairPasses + 1,
        signal: this.controller.signal,
      });
      if (this.controller.signal.aborted) throw abortError();
      const changed = [...new Set(result.changedFiles.map(normalizePath))];
      const outside = changed.filter(file => !allowedFiles.includes(file));
      if (outside.length > 0) throw new Error(`Review repair changed files outside approved findings: ${outside.join(', ')}`);
      const resolved = new Set(result.resolvedFindingIds);
      for (const finding of accepted) {
        if (resolved.has(finding.id)) finding.decision = 'resolved';
      }
      this.session.repairPasses += 1;
      this.recalculateStatus();
      return this.snapshot();
    } catch (error) {
      this.session.status = 'blocked';
      throw error;
    } finally {
      this.controller = undefined;
      this.touch();
    }
  }

  complete(): ReviewSessionSnapshot {
    const blocking = this.session.findings.some(finding =>
      (finding.severity === 'error' || finding.severity === 'critical') &&
      finding.decision !== 'rejected' && finding.decision !== 'resolved');
    const failedValidation = this.session.validations.some(validation => validation.status === 'failed');
    const undecidedHunks = this.session.files.flatMap(file => file.hunks).some(hunk => hunk.decision === 'pending');
    if (blocking || failedValidation || undecidedHunks) throw new Error('Review cannot complete with blocking findings, failed validation, or undecided hunks.');
    this.session.status = 'completed';
    this.touch();
    return this.snapshot();
  }

  cancelRepair(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    return true;
  }

  snapshot(): ReviewSessionSnapshot {
    return {
      ...this.session,
      files: this.session.files.map(file => ({
        ...file,
        hunks: file.hunks.map(hunk => ({ ...hunk, lines: hunk.lines.map(line => ({ ...line })) })),
      })),
      findings: this.session.findings.map(cloneFinding),
      validations: this.session.validations.map(validation => ({ ...validation })),
    };
  }

  private recalculateStatus(): void {
    if (this.session.status === 'completed') return;
    if (this.session.findings.some(finding => finding.decision === 'accepted')) {
      this.session.status = 'reviewing';
      return;
    }
    if (this.session.findings.every(finding => finding.decision === 'resolved' || finding.decision === 'rejected') &&
      this.session.validations.length > 0 && this.session.validations.every(validation => validation.status !== 'failed')) {
      this.session.status = 'validated';
    }
  }

  private touch(): void {
    this.session.updatedAt = new Date().toISOString();
  }
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = diff.split(/\r?\n/);
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      const oldPath = cleanDiffPath(line.slice(4).trim());
      const next = lines[lines.indexOf(line) + 1];
      file = { oldPath, newPath: next?.startsWith('+++ ') ? cleanDiffPath(next.slice(4).trim()) : oldPath, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (file) file.newPath = cleanDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith('@@')) {
      if (!file) throw new Error('Diff hunk appeared before file header.');
      const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (!match) throw new Error(`Invalid diff hunk header: ${line}`);
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        id: createHash('sha256').update(`${file.oldPath}\0${file.newPath}\0${line}`).digest('hex').slice(0, 20),
        header: line,
        oldStart: oldLine,
        oldCount: Number(match[2] ?? 1),
        newStart: newLine,
        newCount: Number(match[4] ?? 1),
        lines: [],
        decision: 'pending',
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith('diff --git ') || line.startsWith('index ') || line === '\\ No newline at end of file') continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'addition', content: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'deletion', content: line.slice(1), oldLine });
      oldLine += 1;
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      hunk.lines.push({ kind: 'context', content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return files.filter(item => item.hunks.length > 0);
}

function validateFinding(finding: Omit<ReviewFinding, 'decision'>): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(finding.id)) throw new Error(`Invalid finding id: ${finding.id}`);
  if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) throw new Error(`Invalid finding confidence: ${finding.id}`);
  normalizePath(finding.file);
}

function matchesFile(file: DiffFile, target: string): boolean {
  const normalized = normalizePath(target);
  return normalizePath(file.oldPath) === normalized || normalizePath(file.newPath) === normalized;
}

function cleanDiffPath(value: string): string {
  return value.replace(/^(?:a|b)\//, '').replace(/^"|"$/g, '');
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^(?:a|b)\//, '').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Invalid review path: ${value}`);
  }
  return normalized;
}

function cloneFinding(finding: ReviewFinding): ReviewFinding {
  return { ...finding };
}

function abortError(): Error {
  const error = new Error('Review repair cancelled.');
  error.name = 'AbortError';
  return error;
}
