export type EditStrategy =
  | 'structured_patch'
  | 'search_replace'
  | 'whole_file'
  | 'json_ast'
  | 'proposed_diff';

export interface EditAttribution {
  taskId?: string;
  sessionId?: string;
  agentId?: string;
  toolCallId?: string;
  iterationId?: string;
  model?: string;
}

export interface JsonEditOperation {
  op: 'set' | 'delete' | 'merge';
  path: string;
  value?: unknown;
}

export interface EditRequest {
  path?: string;
  strategy?: EditStrategy;
  content?: string;
  patch?: string;
  search?: string;
  replace?: string;
  replaceAll?: boolean;
  expectedHash?: string;
  expectedHashes?: Record<string, string>;
  jsonOperations?: JsonEditOperation[];
  preview?: boolean;
  allowUnverifiedOverwrite?: boolean;
  attribution?: EditAttribution;
}

export interface EditDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  column?: number;
  source: 'syntax' | 'freshness' | 'patch' | 'strategy';
}

export interface EditHunkAttribution extends EditAttribution {
  file: string;
  hunkIndex: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface EditFileResult {
  path: string;
  existed: boolean;
  beforeHash?: string;
  afterHash?: string;
  bytesWritten: number;
  created: boolean;
  deleted: boolean;
}

export interface EditResult {
  ok: boolean;
  applied: boolean;
  preview: boolean;
  strategy: EditStrategy;
  files: EditFileResult[];
  diagnostics: EditDiagnostic[];
  hunks: EditHunkAttribution[];
  proposedContent?: Record<string, string>;
  error?: string;
  fallbackUsed?: EditStrategy;
}

export interface EditingModelCapabilities {
  structuredOutput: boolean;
  tools: boolean;
  contextWindow: number;
}
