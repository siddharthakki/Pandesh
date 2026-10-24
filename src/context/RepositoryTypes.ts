import type { RepositoryContextBudget } from './RepositoryContextBudget';

export type ContextRole = 'planner' | 'implementer' | 'reviewer' | 'validator' | 'general';

export type RepositoryIntelligenceState =
  | 'ready'
  | 'indexing'
  | 'stale'
  | 'degraded'
  | 'unavailable'
  | 'paused';

export type RepositoryIntelligenceFailureCode =
  | 'repository_not_found'
  | 'index_unavailable'
  | 'index_initializing'
  | 'index_stale'
  | 'index_corrupt'
  | 'index_schema_mismatch'
  | 'indexing_cancelled'
  | 'file_parse_failed'
  | 'retrieval_failed'
  | 'summary_stale'
  | 'repository_changed_during_retrieval'
  | 'context_package_budget_exhausted';

export interface RepositoryIdentity {
  repositoryRoot: string;
  gitRoot?: string;
  gitCommonDir?: string;
  branch: string;
  headCommit: string;
  worktree: string;
  detached: boolean;
  schemaVersion: number;
}

export interface RepositorySymbol {
  name: string;
  kind: 'class' | 'interface' | 'type' | 'function' | 'method' | 'constant' | 'variable';
  line: number;
  exported?: boolean;
}

export interface RepositoryFileRecord {
  path: string;
  absolutePath: string;
  extension: string;
  language: string;
  size: number;
  modifiedAt: number;
  isTest: boolean;
  isConfig: boolean;
  isGenerated: boolean;
  symbols: RepositorySymbol[];
  imports: string[];
  exports?: string[];
  dependencies: string[];
  linkedTests: string[];
  summary: string;
  contentHash?: string;
  indexedAt?: string;
  stale?: boolean;
  deleted?: boolean;
  parseStatus?: 'structural' | 'lexical' | 'unavailable';
}

export interface RepositoryIndexSnapshot {
  schemaVersion: 2;
  workspaceRoot: string;
  identity: RepositoryIdentity;
  createdAt: string;
  updatedAt: string;
  state: RepositoryIntelligenceState;
  staleReason?: string;
  failureCode?: RepositoryIntelligenceFailureCode;
  files: RepositoryFileRecord[];
  ignoredPatterns: string[];
  truncated: boolean;
  statistics: RepositoryIndexStatistics;
  pins: string[];
  exclusions: string[];
}

export interface RepositoryIndexStatistics {
  files: number;
  symbols: number;
  imports: number;
  tests: number;
  configs: number;
  buildFiles: number;
  markdown: number;
  changedFiles: number;
  deletedFiles: number;
}

export interface ContextHint {
  openFiles?: string[];
  recentFiles?: string[];
  explicitFiles?: string[];
  diagnosticFiles?: Array<{ path: string; severity: 'error' | 'warning' | 'info'; message?: string }>;
  changedFiles?: string[];
}

export interface ContextSelectionRequest {
  query: string;
  role: ContextRole;
  model: string;
  providerType?: string;
  tokenBudget?: number;
  reserveOutputTokens?: number;
  maxFiles?: number;
  hints?: ContextHint;
  /** Model-aware budget plan; the builder never emits more than its budgetChars. */
  budget?: RepositoryContextBudget;
  /** The caller resolved this question as being about the whole workspace (e.g. "what does this do?"). */
  overviewIntent?: boolean;
}

export interface ContextCandidateReason {
  reason: string;
  score: number;
}

export interface SelectedContextFile {
  path: string;
  score: number;
  estimatedTokens: number;
  reasons: ContextCandidateReason[];
  snippet: string;
  truncated: boolean;
}

/** Observable record of every truncation/budget decision for one package. */
export interface RepositoryContextBudgetTelemetry {
  /** Characters across every eligible, relevant candidate file. */
  candidateChars: number;
  /** candidateChars after duplicate content was removed. */
  dedupedChars: number;
  /** The binding character budget for the assembled package. */
  budgetChars: number;
  /** Length of the assembled package actually emitted. */
  selectedChars: number;
  /** Candidates that were ranked but not excerpted (budget, count, duplicates). */
  droppedFiles: number;
  /** Files excluded before ranking as generated/vendored/binary/cache noise. */
  excludedFiles: number;
  selectedFiles: number;
  /** Candidates represented only by their one-line index summary. */
  summarizedFiles: number;
  modelContext: number;
  reservedTokens: number;
  hardMaxChars: number;
  limitedBy: RepositoryContextBudget['limitedBy'] | 'legacy_token_budget';
  overviewQuery: boolean;
  overviewChars: number;
}

export interface ContextSelectionDiagnostics {
  queryTerms: string[];
  providerContextWindow: number;
  inputBudget: number;
  estimatedTokens: number;
  omittedCount?: number;
  packageHash?: string;
  selectedFiles: Array<{
    path: string;
    score: number;
    estimatedTokens: number;
    reasons: ContextCandidateReason[];
  }>;
  rejectedFiles: Array<{ path: string; reason: string; score: number }>;
  inventorySize: number;
  inventoryTruncated: boolean;
  budget?: RepositoryContextBudgetTelemetry;
}

export interface RepositoryContextResult {
  prompt: string;
  files: SelectedContextFile[];
  diagnostics: ContextSelectionDiagnostics;
  index: RepositoryIndexSnapshot;
}

export interface RepositoryIntelligenceStatus {
  state: RepositoryIntelligenceState;
  identity: RepositoryIdentity;
  updatedAt: string;
  staleReason?: string;
  failureCode?: RepositoryIntelligenceFailureCode;
  statistics: RepositoryIndexStatistics;
  selectedFiles: ContextSelectionDiagnostics['selectedFiles'];
  estimatedTokens: number;
  omittedCount: number;
  pins: string[];
  exclusions: string[];
  storage: {
    kind: 'sqlite';
    path: string;
    sqliteAvailable: boolean;
    fts5Available?: boolean;
  };
}
