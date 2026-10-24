/**
 * Host-owned autonomous mission actions. The model may request exactly one of
 * these per turn; Core decodes, executes, and returns a bounded observation.
 * The model cannot invent tools or widen path scope.
 */
export const MISSION_ACTIONS = [
  'search',
  'read_file',
  'propose_file_change',
  'propose_text_edit',
  'run_check',
  'finish',
  'ask_user',
] as const;

export type MissionActionName = (typeof MISSION_ACTIONS)[number];

export const MISSION_CHECK_KINDS = ['test', 'diff', 'status', 'commit'] as const;
export type MissionCheckKind = (typeof MISSION_CHECK_KINDS)[number];

export type MissionAction =
  | { action: 'search'; query: string; path?: string }
  | { action: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { action: 'propose_file_change'; path: string; content: string }
  | { action: 'propose_text_edit'; path: string; find: string; replace: string }
  | { action: 'run_check'; check: MissionCheckKind; target?: string }
  | { action: 'finish'; summary: string }
  | { action: 'ask_user'; question: string };

export type MissionDecodeResult =
  | { ok: true; action: MissionAction; extraRejected: number }
  | { ok: false; errors: string[]; extraRejected: number };

export function isMissionActionName(value: string): value is MissionActionName {
  return (MISSION_ACTIONS as readonly string[]).includes(value);
}

function asPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function decodeOne(name: string, args: Record<string, unknown>): MissionAction | string {
  if (!isMissionActionName(name)) return `unknown action '${name}'`;
  if (name === 'search') {
    const query = String(args.query ?? '').trim();
    if (!query) return 'search requires a non-empty query';
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
    return { action: 'search', query, path };
  }
  if (name === 'read_file') {
    const path = String(args.path ?? '').trim();
    if (!path) return 'read_file requires a path';
    const startLine = asPositiveInt(args.startLine);
    const endLine = asPositiveInt(args.endLine);
    if (startLine && endLine && endLine < startLine) return 'read_file endLine must be >= startLine';
    return { action: 'read_file', path, startLine, endLine };
  }
  if (name === 'propose_file_change') {
    const path = String(args.path ?? '').trim();
    if (!path) return 'propose_file_change requires a path';
    if (typeof args.content !== 'string') return 'propose_file_change requires content';
    return { action: 'propose_file_change', path, content: args.content };
  }
  if (name === 'propose_text_edit') {
    const path = String(args.path ?? '').trim();
    if (!path) return 'propose_text_edit requires a path';
    if (typeof args.find !== 'string' || args.find === '') return 'propose_text_edit requires non-empty find text';
    if (typeof args.replace !== 'string') return 'propose_text_edit requires replace text';
    return { action: 'propose_text_edit', path, find: args.find, replace: args.replace };
  }
  if (name === 'run_check') {
    const check = String(args.check ?? args.kind ?? '').trim() as MissionCheckKind;
    if (!(MISSION_CHECK_KINDS as readonly string[]).includes(check)) {
      return `run_check requires check to be one of ${MISSION_CHECK_KINDS.join(', ')}`;
    }
    const target = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : undefined;
    return { action: 'run_check', check, target };
  }
  if (name === 'finish') {
    const summary = String(args.summary ?? '').trim();
    if (!summary) return 'finish requires a summary';
    return { action: 'finish', summary };
  }
  const question = String(args.question ?? '').trim();
  if (!question) return 'ask_user requires a question';
  return { action: 'ask_user', question };
}

/**
 * Exactly one mission action is accepted. Extra tool calls are counted and
 * rejected without execution.
 */
export function decodeMissionTurn(calls: Array<{ name: string; arguments?: Record<string, unknown> }>): MissionDecodeResult {
  const extraRejected = Math.max(0, calls.length - 1);
  if (calls.length === 0) {
    return { ok: false, errors: ['exactly one action is required per turn'], extraRejected: 0 };
  }
  const first = calls[0];
  const decoded = decodeOne(first.name, first.arguments ?? {});
  if (typeof decoded === 'string') {
    return { ok: false, errors: [decoded], extraRejected };
  }
  if (calls.length > 1) {
    return { ok: false, errors: [`exactly one action is required per turn; rejected ${extraRejected} extra call(s)`], extraRejected };
  }
  return { ok: true, action: decoded, extraRejected: 0 };
}

export const MISSION_TOOL_DEFINITIONS = [
  {
    name: 'search',
    description: 'Search workspace files for a query. Optional path scopes the search inside the repository.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a workspace file. Optional startLine/endLine (1-based, inclusive) return a ranged excerpt with fingerprint.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'propose_file_change',
    description: 'Propose exact file content for Core mutation approval. Does not write until approved.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'propose_text_edit',
    description: 'Propose an anchored text edit for an existing file: find must occur exactly once in the current file; replace is what it becomes. Core reads the file, verifies the anchor, and computes the resulting content and diff itself for approval — never send full file content. Does not modify the workspace until approved. Prefer this over propose_file_change for a small change to an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'run_check',
    description: 'Run a typed repository check: test, diff, status, or local commit. Never a free-form shell command.',
    parameters: {
      type: 'object',
      properties: {
        check: { type: 'string', description: 'test | diff | status | commit' },
        target: { type: 'string', description: 'Optional workspace-relative test file for check=test.' },
      },
      required: ['check'],
    },
  },
  {
    name: 'finish',
    description: 'Request completion. Core completes only when approved mutation, passing validation, passing diff review, and a local commit SHA are evidenced.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
  {
    name: 'ask_user',
    description: 'Pause for a clarifying question. Does not complete the mission.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
] as const;
