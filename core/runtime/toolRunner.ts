/**
 * Core-owned tool execution (M32 Priority 1b — Saath Kar). The tool *process*
 * lifecycle (spawning, capturing output, killing on cancel) runs inside the
 * Core process, so a Saath Kar attempt's tool work survives the Extension Host
 * going away and its cancellation reaches the real child process.
 *
 * Deliberately Core-safe: node `child_process`/`fs` only, no `vscode`. Tools
 * are intentionally few and bounded — this is a durable execution seam, not a
 * re-implementation of the full Extension-Host tool catalogue.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelToolDefinition, ModelToolCall } from './modelBackend';
import { recoverRepositoryPath, type RepositoryPathRecoveryResult } from './repositoryPathRecovery';
import { isCredentialFilePath, redactSecrets } from '../platform/credentialStore';
import { describeBaseline, missingParentDirectories, readBaselineIdentity, sameBaseline, sha256OfBuffer, type WriteBaselineIdentity } from './writeProposal';
import { resolveAnchoredEdit } from './textEditProposal';
import {
  defaultCommandPolicyEnvelope,
  evaluateGovernedAction,
  type CommandPolicyEnvelope,
} from './commandPolicy';
import { runCommandToolDescription } from './executionEnvironment';
import type { ExecutionGrant } from '../security/types';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';

/** True when `candidate` really resolves (symlinks included) inside `root`. */
function isInsideWorkspace(root: string, candidate: string): boolean {
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** Removes only directories this write created, deepest first, and only while
 * they are still empty — never anything that appeared since. */
function rollbackCreatedDirectories(created: string[]): void {
  for (const dir of [...created].reverse()) {
    try { fs.rmdirSync(dir); } catch { /* not empty or already gone: leave it */ }
  }
}

export interface ToolExecutionContext {
  /** Working directory tool processes run in. */
  cwd: string;
  signal?: AbortSignal;
  /**
   * Frozen task envelope used as the last Core execution fence. Absent means
   * fail-closed defaults (no push/install/network) against `cwd`.
   */
  commandPolicy?: CommandPolicyEnvelope;
  /**
   * M39: the governed-dispatch context an adapter may need to bind durable
   * domain state to the consent and evidence that authorized it. All optional
   * and purely additive — the pre-existing workspace/GitHub/research adapters
   * ignore them entirely, and no adapter may treat them as authority (they
   * are set by `core/domain/capabilityDispatch.ts` alone, never by a caller).
   */
  correlationId?: string;
  attemptId?: string;
  approvalId?: string;
  invocationId?: string;
  /**
   * The pre-image identity this mutation was proposed against, taken from the
   * FROZEN approval (`core/domain/capabilityDispatch.ts`) — never from a
   * caller and never recomputed here. When present, `propose_file_change`
   * re-hashes the real file immediately before writing and refuses the write if the
   * workspace has moved on, so an approval can never be replayed onto bytes
   * the human never saw. Absent means no baseline was captured (an
   * ungoverned local tool call), which behaves exactly as before.
   */
  expectedBaseline?: WriteBaselineIdentity;
  /**
   * Draft-bound Gmail send safety: the canonical digest that was frozen into
   * the `gmail_send_draft` approval at proposal time (see
   * `core/domain/connectorDispatch.ts` and
   * `core/runtime/connectors/gmailDraftDigest.ts`). The Gmail adapter re-reads
   * the live draft from Gmail and recomputes this digest immediately before
   * sending, refusing if it no longer matches. Absent means no approved
   * digest exists for this send — the adapter must refuse, never fall back to
   * trusting caller-supplied content.
   */
  gmailDraftExpectedDigest?: string;
  /**
   * M54 Security Kernel: Authoritative ExecutionGrant required for all
   * consequential actions (run_command, propose_file_change, propose_text_edit).
   * Direct execution without a valid grant is rejected as a security circumvention.
   */
  securityGrant?: ExecutionGrant;
  securityKernel?: LocalAutonomySecurityKernel;
}

export interface ToolExecutionResult {
  status: 'succeeded' | 'failed';
  exitCode: number | null;
  /** Bounded, human/model-readable output (stdout+stderr or file content). */
  output: string;
  /** Stable category and normalized arguments used by bounded loop detection. */
  resultCategory?: string;
  normalizedArguments?: Record<string, unknown>;
  /** Structured repository-boundary/correction evidence persisted by Core. */
  pathRecovery?: RepositoryPathRecoveryResult;
}

export interface ToolRunner {
  /** The tool definitions this runner exposes to the model. */
  definitions(): ModelToolDefinition[];
  run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

interface LineRange { startLine?: number; endLine?: number }

/** A 1-based inclusive line range from the model's arguments; absent unless one was actually asked for. */
function lineRange(args: Record<string, unknown>): LineRange | undefined {
  const pick = (raw: unknown) => {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
  };
  const startLine = pick(args.startLine);
  const endLine = pick(args.endLine);
  if (startLine === undefined && endLine === undefined) return undefined;
  return { ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) };
}

/**
 * The requested lines, bounded like a whole-file read. Starts with a
 * `LINES a-b of N` header giving the absolute range actually returned, so a
 * partial read is never mistaken for a whole file and a bounded one says where
 * to continue.
 */
function readLineRange(text: string, range: LineRange): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const from = range.startLine ?? 1;
  const requestedTo = Math.min(range.endLine ?? total, total);
  if (from > requestedTo) return `LINES ${from}-${from - 1} of ${total}\n(no lines in the requested range; the file has ${total} lines)`;
  const picked: string[] = [];
  let chars = 0;
  for (let n = from; n <= requestedTo; n += 1) {
    if (picked.length > 0 && chars + lines[n - 1].length + 1 > MAX_OUTPUT_CHARS) break;
    picked.push(lines[n - 1]);
    chars += lines[n - 1].length + 1;
  }
  const to = from + picked.length - 1;
  const cut = to < requestedTo ? `\n…[truncated at line ${to}; continue with startLine=${to + 1}]` : '';
  return `LINES ${from}-${to} of ${total}\n${bound(picked.join('\n'))}${cut}`;
}

/** Models emit `command` as a string or as an argv array (`["echo","hi"]`). */
function coerceCommand(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map((p) => String(p)).join(' ');
  return raw === undefined || raw === null ? '' : String(raw);
}

/** The default Core tool set: run a command and read a file, both scoped to cwd. */
export class CoreToolRunner implements ToolRunner {
  constructor(private readonly commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {}

  definitions(): ModelToolDefinition[] {
    return [
      {
        name: 'run_command',
        description: runCommandToolDescription(),
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'The command line to execute.' } },
          required: ['command'],
        },
      },
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file relative to the working directory. Output is bounded; for a large file or a compacted result pass startLine/endLine to read just that range.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the working directory.' },
            startLine: { type: 'integer', description: 'Optional 1-based first line to return.' },
            endLine: { type: 'integer', description: 'Optional 1-based last line to return (inclusive).' },
          },
          required: ['path'],
        },
      },
      {
        name: 'propose_file_change',
        description: 'Propose exact UTF-8 file content for user review. This operation does NOT modify the workspace. KarkeDikha will show the resulting diff and only apply it after explicit user approval. Use this whenever a requested file change is ready for review; prefer it over shell echo/printf when the content must be exact.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the working directory.' },
            content: { type: 'string', description: 'Exact proposed file content, with no implicit quotes or newline.' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'propose_text_edit',
        description: 'Propose an anchored text edit for an existing UTF-8 file: find must occur exactly once in the current file; replace is what it becomes. Core reads the file, verifies the anchor, and computes the resulting content and diff itself. This operation does NOT modify the workspace. KarkeDikha will show the resulting diff and only apply it after explicit user approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the working directory.' },
            find: { type: 'string', description: 'Exact text that must occur exactly once in the current file.' },
            replace: { type: 'string', description: 'Exact replacement text.' },
          },
          required: ['path', 'find', 'replace'],
        },
      },
    ];
  }

  run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const kernel = ctx.securityKernel ?? LocalAutonomySecurityKernel.getInstance();

    if (kernel.isSafeModeActive()) {
      return Promise.resolve({
        status: 'failed',
        exitCode: null,
        output: 'SecurityKernel violation: SAFE_MODE / EXECUTION_DISABLED is currently active. All consequential tool execution is halted.',
        resultCategory: 'security_safe_mode_active',
      });
    }

    const isConsequential = call.name === 'run_command'
      || call.name === 'propose_file_change'
      || call.name === 'propose_text_edit';

    if (isConsequential) {
      if (!ctx.securityGrant) {
        kernel.getJournal().record({
          eventType: 'CIRCUMVENTION_SUSPECTED',
          attemptId: ctx.attemptId,
          executor: 'core:tool_runner',
          capability: call.name === 'run_command' ? 'process' : 'filesystem',
          targetResource: call.name === 'run_command' ? ctx.cwd : String(call.arguments.path ?? ''),
          payload: {
            violation: 'direct_consequential_execution_without_grant',
            toolName: call.name,
            arguments: call.arguments,
          },
        });
        return Promise.resolve({
          status: 'failed',
          exitCode: null,
          output: `SecurityKernel violation: consequential action '${call.name}' requires an authoritative ExecutionGrant. Direct execution bypass is rejected.`,
          resultCategory: 'security_kernel_no_grant',
        });
      }

      const command = call.name === 'run_command' ? coerceCommand(call.arguments.command) : null;
      const targetResource = call.name === 'run_command'
        ? ctx.cwd
        : path.resolve(ctx.cwd, String(call.arguments.path ?? ''));
      const verify = kernel.verifyAndConsumeGrant(ctx.securityGrant, {
        attemptId: ctx.attemptId ?? ctx.securityGrant.attemptId,
        executor: ctx.securityGrant.executor,
        capability: call.name === 'run_command' ? 'process' : 'filesystem',
        workspaceRoot: ctx.cwd,
        targetResource,
        command,
        arguments: call.arguments,
        filesystemScope: ctx.securityGrant.filesystemScope,
        networkScope: ctx.securityGrant.networkScope,
      });

      if (!verify.ok) {
        return Promise.resolve({
          status: 'failed',
          exitCode: null,
          output: `SecurityKernel violation: ${verify.reason}`,
          resultCategory: 'security_kernel_grant_invalid',
        });
      }
    }

    const envelope = ctx.commandPolicy ?? defaultCommandPolicyEnvelope(ctx.cwd);
    const policy = evaluateGovernedAction({
      toolName: call.name,
      arguments: call.arguments,
      envelope,
    });
    if (policy.decision === 'deny') {
      return Promise.resolve({
        status: 'failed',
        exitCode: null,
        output: `Core denied this action: ${policy.reason}`,
        resultCategory: 'command_policy_denied',
        normalizedArguments: policy.normalizedArguments,
      });
    }
    if (call.name === 'run_command') return this.runCommand(coerceCommand(call.arguments.command), ctx, kernel);
    if (call.name === 'read_file') return Promise.resolve(this.readFile(String(call.arguments.path ?? ''), ctx, lineRange(call.arguments)));
    if (call.name === 'propose_file_change') return Promise.resolve(this.writeFile(
      String(call.arguments.path ?? ''),
      String(call.arguments.content ?? ''),
      ctx,
    ));
    if (call.name === 'propose_text_edit') return Promise.resolve(this.applyTextEdit(
      String(call.arguments.path ?? ''),
      String(call.arguments.find ?? ''),
      String(call.arguments.replace ?? ''),
      ctx,
    ));
    return Promise.resolve({ status: 'failed', exitCode: null, output: `unknown tool '${call.name}'` });
  }

  private readFile(rel: string, ctx: ToolExecutionContext, range?: LineRange): ToolExecutionResult {
    const recovery = recoverRepositoryPath({ workspaceRoot: ctx.cwd, requestedPath: rel, target: 'read' });
    const normalizedArguments = { path: recovery.selected ?? recovery.normalized, ...(range ?? {}) };
    if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) {
      const candidates = recovery.candidates.length > 0 ? ` Candidates: ${recovery.candidates.join(', ')}` : '';
      return {
        status: 'failed',
        exitCode: null,
        output: `Repository path blocked: ${recovery.reason}.${candidates}`,
        resultCategory: `path_${recovery.status}`,
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
    if (isCredentialFilePath(recovery.resolvedPath)) {
      return {
        status: 'failed', exitCode: null,
        output: `Refused: "${path.basename(recovery.resolvedPath)}" holds credentials. Credential files are never read into the conversation.`,
        resultCategory: 'credential_file_refused', normalizedArguments, pathRecovery: recovery,
      };
    }
    try {
      const correction = recovery.status === 'corrected'
        ? `PATH_CORRECTION ${JSON.stringify({ original: recovery.original, selected: recovery.selected, confidence: recovery.confidence, reason: recovery.reason, automatic: true })}\n`
        : '';
      const text = fs.readFileSync(recovery.resolvedPath, 'utf8');
      return {
        status: 'succeeded',
        exitCode: 0,
        output: redactSecrets(`${correction}${range ? readLineRange(text, range) : bound(text)}`),
        resultCategory: recovery.status === 'corrected' ? 'path_corrected' : 'read_succeeded',
        normalizedArguments,
        pathRecovery: recovery,
      };
    } catch (err) {
      return {
        status: 'failed', exitCode: null, output: err instanceof Error ? err.message : String(err),
        resultCategory: 'read_failed', normalizedArguments, pathRecovery: recovery,
      };
    }
  }

  private writeFile(rel: string, content: string, ctx: ToolExecutionContext): ToolExecutionResult {
    const recovery = recoverRepositoryPath({ workspaceRoot: ctx.cwd, requestedPath: rel, target: 'write' });
    const normalizedArguments = { path: recovery.selected ?? recovery.normalized, content };
    if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) {
      const candidates = recovery.candidates.length > 0 ? ` Candidates: ${recovery.candidates.join(', ')}` : '';
      return {
        status: 'failed',
        exitCode: null,
        output: `Repository path blocked: ${recovery.reason}.${candidates}`,
        resultCategory: `path_${recovery.status}`,
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
    if (ctx.expectedBaseline) {
      // Immediately before the mutation — not at proposal time, and not at
      // approval time — so nothing can slip in between this check and the
      // write. Covers both baseline kinds: an existing file whose bytes moved,
      // and a new-file proposal whose path has since been created by someone
      // else (which must never be silently overwritten).
      const current = readBaselineIdentity(recovery.resolvedPath);
      if ('error' in current) {
        return {
          status: 'failed',
          exitCode: null,
          output: `Stale proposal: the write target could not be verified against the approved baseline (${current.error}). Nothing was written; re-propose this change.`,
          resultCategory: 'write_stale_baseline',
          normalizedArguments,
          pathRecovery: recovery,
        };
      }
      if (!sameBaseline(current.baseline, ctx.expectedBaseline)) {
        return {
          status: 'failed',
          exitCode: null,
          output: `Stale proposal: '${recovery.selected}' was proposed against ${describeBaseline(ctx.expectedBaseline)} but now has ${describeBaseline(current.baseline)}. Nothing was written — re-read the file and propose the change again against its current content.`,
          resultCategory: 'write_stale_baseline',
          normalizedArguments,
          pathRecovery: recovery,
        };
      }
    }
    // Reached only after approval (and the workspace-boundary check in path
    // recovery). Parents are created here, never at proposal time, and only
    // the ones this call created are ever rolled back.
    const created: string[] = [];
    try {
      for (const dir of missingParentDirectories(recovery.resolvedPath)) {
        fs.mkdirSync(dir);
        created.push(dir);
      }
      if (created.length > 0 && !isInsideWorkspace(ctx.cwd, path.dirname(recovery.resolvedPath))) {
        rollbackCreatedDirectories(created);
        return {
          status: 'failed',
          exitCode: null,
          output: `Repository path blocked: the new parent directory resolves outside the workspace. Nothing was written and the created directories were removed.`,
          resultCategory: 'path_outside_workspace',
          normalizedArguments,
          pathRecovery: recovery,
        };
      }
      fs.writeFileSync(recovery.resolvedPath, content, 'utf8');
      return {
        status: 'succeeded',
        exitCode: 0,
        output: `Wrote ${Buffer.byteLength(content, 'utf8')} byte(s) to ${recovery.selected}.`,
        resultCategory: recovery.status === 'corrected' ? 'path_corrected' : 'write_succeeded',
        normalizedArguments,
        pathRecovery: recovery,
      };
    } catch (err) {
      rollbackCreatedDirectories(created);
      return {
        status: 'failed',
        exitCode: null,
        output: err instanceof Error ? err.message : String(err),
        resultCategory: 'write_failed',
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
  }

  /**
   * `find`/`replace` are the only content the model ever supplies for this
   * tool; the file is read and the resulting content computed HERE, from the
   * live workspace, immediately before writing — never trusted from a
   * caller. This re-verifies the anchor unambiguously even when it was
   * already verified once at proposal time, and (when `ctx.expectedBaseline`
   * is present) refuses the write if the file moved since that proposal was
   * made, exactly like `writeFile`'s stale-baseline protection.
   */
  private applyTextEdit(rel: string, find: string, replace: string, ctx: ToolExecutionContext): ToolExecutionResult {
    const recovery = recoverRepositoryPath({ workspaceRoot: ctx.cwd, requestedPath: rel, target: 'write' });
    const normalizedArguments = { path: recovery.selected ?? recovery.normalized, find, replace };
    if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) {
      const candidates = recovery.candidates.length > 0 ? ` Candidates: ${recovery.candidates.join(', ')}` : '';
      return {
        status: 'failed',
        exitCode: null,
        output: `Repository path blocked: ${recovery.reason}.${candidates}`,
        resultCategory: `path_${recovery.status}`,
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(recovery.resolvedPath);
    } catch (err) {
      return {
        status: 'failed',
        exitCode: null,
        output: `Stale proposal: the anchored edit target could not be read (${err instanceof Error ? err.message : String(err)}). Nothing was written; re-propose this change.`,
        resultCategory: 'write_stale_baseline',
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
    if (ctx.expectedBaseline) {
      const current: WriteBaselineIdentity = { kind: 'file', sha256: sha256OfBuffer(buffer) };
      if (!sameBaseline(current, ctx.expectedBaseline)) {
        return {
          status: 'failed',
          exitCode: null,
          output: `Stale proposal: '${recovery.selected}' was proposed against ${describeBaseline(ctx.expectedBaseline)} but now has ${describeBaseline(current)}. Nothing was written — re-read the file and propose the change again against its current content.`,
          resultCategory: 'write_stale_baseline',
          normalizedArguments,
          pathRecovery: recovery,
        };
      }
    }
    const resolved = resolveAnchoredEdit(buffer.toString('utf8'), find, replace);
    if (!resolved.ok) {
      return {
        status: 'failed',
        exitCode: null,
        output: `Anchored edit refused: ${resolved.reason}. Nothing was written.`,
        resultCategory: 'anchor_unresolved',
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
    try {
      fs.writeFileSync(recovery.resolvedPath, resolved.content, 'utf8');
      return {
        status: 'succeeded',
        exitCode: 0,
        output: `Wrote ${Buffer.byteLength(resolved.content, 'utf8')} byte(s) to ${recovery.selected}.`,
        resultCategory: recovery.status === 'corrected' ? 'path_corrected' : 'write_succeeded',
        normalizedArguments,
        pathRecovery: recovery,
      };
    } catch (err) {
      return {
        status: 'failed',
        exitCode: null,
        output: err instanceof Error ? err.message : String(err),
        resultCategory: 'write_failed',
        normalizedArguments,
        pathRecovery: recovery,
      };
    }
  }

  private runCommand(command: string, ctx: ToolExecutionContext, kernel?: LocalAutonomySecurityKernel): Promise<ToolExecutionResult> {
    const activeKernel = kernel ?? ctx.securityKernel ?? LocalAutonomySecurityKernel.getInstance();
    return new Promise((resolve) => {
      if (!command.trim()) {
        resolve({ status: 'failed', exitCode: null, output: 'empty command', resultCategory: 'command_invalid', normalizedArguments: { command: '' } });
        return;
      }
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
      // Deliberately do NOT pass `signal` to spawn(): Node's built-in signal
      // support only terminates the shell process itself (cmd.exe/sh), not any
      // descendant process that shell launched (e.g. `cmd /c ping ...` spawns
      // ping.exe as a child of cmd.exe) — on Windows that grandchild survives
      // as an orphan. `killTree` below terminates the whole process tree instead.
      let unregisterProc: (() => void) | undefined;
      const spawnedAtMs = Date.now();
      const child = spawn(shell, shellArgs, {
        cwd: ctx.cwd,
        env: createSanitizedChildEnvironment(),
        detached: process.platform !== 'win32',
        // Node's default Windows argv quoting escapes quotes inside the single
        // command string, so cmd.exe receives literal backslashes. The
        // command is already one approved shell program; pass it verbatim.
        windowsVerbatimArguments: process.platform === 'win32',
      });
      if (child.pid) {
        unregisterProc = activeKernel.getSafeModeManager().registerChildProcess(
          child.pid,
          () => killTree(),
          `run_command: ${command.slice(0, 100)}`,
          ctx.attemptId,
          // Provenance: Pandesh started this child at this moment, so the
          // SAFE_MODE kill switch can prove the PID still belongs to it.
          { spawnedAtMs },
        );
      }
      let out = '';
      const append = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT_CHARS * 2) out += chunk.toString('utf8');
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      let settled = false;
      let killedByAbort = false;
      const killTree = () => {
        if (unregisterProc) { unregisterProc(); unregisterProc = undefined; }
        if (!child.pid) return;
        if (process.platform === 'win32') {
          try { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch { /* best-effort */ }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        }
      };
      const onAbort = () => {
        killedByAbort = true;
        killTree();
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (result: ToolExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (unregisterProc) { unregisterProc(); unregisterProc = undefined; }
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({
          ...result,
          resultCategory: result.status === 'succeeded' ? 'command_succeeded' : 'command_failed',
          normalizedArguments: { command: command.replace(/\s+/g, ' ').trim() },
        });
      };
      const timer = setTimeout(() => {
        killTree();
        finish({ status: 'failed', exitCode: null, output: `${bound(out)}\n…[timed out after ${this.commandTimeoutMs}ms]` });
      }, this.commandTimeoutMs);
      timer.unref?.();
      if (ctx.signal?.aborted) onAbort();
      child.on('error', (err) => finish({ status: 'failed', exitCode: null, output: `${bound(out)}\n${err.message}` }));
      child.on('close', (code) => finish({
        status: !killedByAbort && code === 0 ? 'succeeded' : 'failed',
        exitCode: code,
        output: killedByAbort ? `${bound(out)}\n…[aborted]` : bound(out),
      }));
    });
  }
}
