/**
 * M38 — Core-owned governed GitHub capability.
 *
 * Replaces the ungoverned `execFile('gh', ...)` shell-out in
 * `src/organization/GhEngineeringIntegration.ts` (`GhCliCommandRunner`) as
 * the dispatch path for *new* external-service GitHub actions reached from
 * chat: that runner has no per-call risk classification, no health check,
 * and no cancellation. This adapter is deliberately narrow (read an issue,
 * comment on an issue) rather than a general `gh` passthrough — a general
 * passthrough would recreate the same shell-based bypass this milestone is
 * closing.
 *
 * Consequential calls (`github_comment_on_issue`) do not invent a new
 * approval mechanism: the calling attempt must already have passed its
 * existing Core 'mutation' approval gate (core/domain/approvals.ts) before
 * the model loop may call tools at all (see governedCapability.ts). This
 * adapter adds capability-scoped idempotency (a durable marker embedded in
 * the comment body) so a retried/duplicated approval cannot post twice.
 */
import { execFile } from 'node:child_process';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';
import type { ModelToolDefinition, ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';
import type { CapabilityHealth, GovernedCapabilityAdapter } from './governedCapability';

const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const IDEMPOTENCY_MARKER_PREFIX = '<!-- karkedikha:idempotency:';

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

/** Strips anything that looks like a token/credential before it can ever
 * reach durable evidence. `gh` output should not contain secrets, but this
 * is the fabric's last line of defense, not the only one. */
function redact(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-token]')
    .replace(/(authorization:\s*)(bearer\s+)?\S+/gi, '$1[redacted]')
    .replace(/(-{5}BEGIN[\s\S]*?-{5}END[^-]*-{5})/g, '[redacted-key-block]');
}

export type GithubCommandExecutor = (args: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }) =>
  Promise<{ stdout: string; stderr: string; code: number | null }>;

const defaultExecutor: GithubCommandExecutor = (args, opts) => {
  const kernel = LocalAutonomySecurityKernel.getInstance();
  if (kernel.isSafeModeActive()) {
    return Promise.resolve({
      stdout: '',
      stderr: 'SecurityKernel violation: SAFE_MODE / EXECUTION_DISABLED is currently active.',
      code: 1,
    });
  }
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      {
        cwd: opts.cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        timeout: opts.timeoutMs,
        signal: opts.signal,
        env: createSanitizedChildEnvironment(),
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? ''), code });
      },
    );
  });
};

export interface GithubCapabilityOptions {
  /** Restricts every call to exactly this `owner/repo` — never accepts a
   * repository argument from model/tool-call input. */
  repository: string;
  cwd: string;
  commandTimeoutMs?: number;
  executor?: GithubCommandExecutor;
}

function idempotencyMarker(number: number, body: string): string {
  // A short, stable hash of the intended write — not cryptographic, just
  // collision-resistant enough to dedupe the same (issue, body) pair.
  let h = 0;
  const input = `${number}:${body}`;
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return `${IDEMPOTENCY_MARKER_PREFIX}${(h >>> 0).toString(16)} -->`;
}

export function createGithubCapabilityAdapter(options: GithubCapabilityOptions): GovernedCapabilityAdapter {
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const exec = options.executor ?? defaultExecutor;
  let cachedHealth: CapabilityHealth = { state: 'available', checkedAt: new Date().toISOString() };

  async function probeHealth(): Promise<CapabilityHealth> {
    try {
      const result = await exec(['auth', 'status'], { cwd: options.cwd, timeoutMs: 8_000 });
      cachedHealth = result.code === 0
        ? { state: 'available', checkedAt: new Date().toISOString() }
        : { state: 'authorization_required', reason: redact(bound(result.stderr || result.stdout)), checkedAt: new Date().toISOString() };
    } catch (err) {
      cachedHealth = { state: 'unavailable', reason: err instanceof Error ? err.message : String(err), checkedAt: new Date().toISOString() };
    }
    return cachedHealth;
  }

  async function readIssue(numberRaw: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const number = Number(numberRaw);
    if (!Number.isInteger(number) || number <= 0) {
      return { status: 'failed', exitCode: null, output: 'github_read_issue requires a positive integer issue number', resultCategory: 'github_invalid_arguments' };
    }
    const result = await exec(
      ['issue', 'view', String(number), '--repo', options.repository, '--json', 'number,title,body,state,url,comments'],
      { cwd: options.cwd, timeoutMs, signal: ctx.signal },
    );
    const output = redact(bound(result.stdout || result.stderr));
    return {
      status: result.code === 0 ? 'succeeded' : 'failed',
      exitCode: result.code,
      output,
      resultCategory: result.code === 0 ? 'github_read_succeeded' : 'github_read_failed',
      normalizedArguments: { repository: options.repository, number },
    };
  }

  async function commentOnIssue(numberRaw: unknown, bodyRaw: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const number = Number(numberRaw);
    const body = String(bodyRaw ?? '');
    if (!Number.isInteger(number) || number <= 0 || !body.trim()) {
      return { status: 'failed', exitCode: null, output: 'github_comment_on_issue requires a positive integer number and a non-empty body', resultCategory: 'github_invalid_arguments' };
    }
    const marker = idempotencyMarker(number, body);

    // Idempotency is a precondition for the write, not best-effort diagnostics.
    // If Core restarted after GitHub accepted the comment but before terminal
    // evidence was stored, this read is the only safe way to distinguish
    // "already applied" from "not yet applied". Any failed or malformed read
    // therefore fails closed and performs zero mutation.
    const existing = await exec(
      ['issue', 'view', String(number), '--repo', options.repository, '--json', 'comments'],
      { cwd: options.cwd, timeoutMs, signal: ctx.signal },
    );
    if (existing.code !== 0) {
      return {
        status: 'failed',
        exitCode: existing.code,
        output: redact(bound(existing.stderr || existing.stdout || 'GitHub idempotency check failed; no comment was posted.')),
        resultCategory: 'github_idempotency_check_failed',
        normalizedArguments: { repository: options.repository, number },
      };
    }

    let parsed: { comments?: Array<{ body?: string }> };
    try {
      parsed = JSON.parse(existing.stdout) as { comments?: Array<{ body?: string }> };
      if (parsed.comments !== undefined && !Array.isArray(parsed.comments)) throw new Error('comments is not an array');
    } catch (error) {
      return {
        status: 'failed',
        exitCode: null,
        output: redact(bound(`GitHub idempotency check returned malformed data; no comment was posted: ${error instanceof Error ? error.message : String(error)}`)),
        resultCategory: 'github_idempotency_check_failed',
        normalizedArguments: { repository: options.repository, number },
      };
    }

    const alreadyPosted = (parsed.comments ?? []).some((comment) => typeof comment.body === 'string' && comment.body.includes(marker));
    if (alreadyPosted) {
      return {
        status: 'succeeded',
        exitCode: 0,
        output: redact(`comment already posted (idempotent no-op): ${marker}`),
        resultCategory: 'github_write_deduplicated',
        normalizedArguments: { repository: options.repository, number },
      };
    }

    const result = await exec(
      ['issue', 'comment', String(number), '--repo', options.repository, '--body', `${body}\n\n${marker}`],
      { cwd: options.cwd, timeoutMs, signal: ctx.signal },
    );
    const output = redact(bound(result.stdout || result.stderr));
    return {
      status: result.code === 0 ? 'succeeded' : 'failed',
      exitCode: result.code,
      output,
      resultCategory: result.code === 0 ? 'github_write_succeeded' : 'github_write_failed',
      normalizedArguments: { repository: options.repository, number, bodyLength: body.length },
    };
  }

  const definitions: ModelToolDefinition[] = [
    {
      name: 'github_read_issue',
      description: `Read an issue (title, body, state, comments) from the governed repository ${options.repository}. Read-only.`,
      parameters: {
        type: 'object',
        properties: { number: { type: 'number', description: 'Issue number.' } },
        required: ['number'],
      },
    },
    {
      name: 'github_comment_on_issue',
      description: `Post a comment on an issue in the governed repository ${options.repository}. Consequential — requires prior mutation approval on this attempt. Idempotent: retrying with the same issue and body will not duplicate the comment.`,
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number.' },
          body: { type: 'string', description: 'Comment body (Markdown).' },
        },
        required: ['number', 'body'],
      },
    },
  ];

  return {
    id: 'github',
    definitions: () => definitions,
    classify: (toolName) => (toolName === 'github_read_issue' ? 'read_only' : 'consequential'),
    health: () => cachedHealth,
    run: async (call: ModelToolCall, ctx: ToolExecutionContext) => {
      if (call.name === 'github_read_issue') return readIssue(call.arguments.number, ctx);
      if (call.name === 'github_comment_on_issue') return commentOnIssue(call.arguments.number, call.arguments.body, ctx);
      return { status: 'failed', exitCode: null, output: `unknown github tool '${call.name}'`, resultCategory: 'github_invalid_arguments' };
    },
    // Exposed for capability-discovery/health-probe callers; not part of the
    // GovernedCapabilityAdapter contract itself.
    probeHealth,
  } as GovernedCapabilityAdapter & { probeHealth: typeof probeHealth };
}
