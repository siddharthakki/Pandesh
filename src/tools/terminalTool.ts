import { ToolResult, ToolContext } from './ToolTypes';
import { CommandService } from '../services/CommandService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import { SecretScanner } from '../services/SecretScanner';
import { OutputLimiter } from '../services/OutputLimiter';
import { Config } from '../config/Config';

// Patterns that indicate the command binary itself was not found (not a script error).
const NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /No such file or directory/i,
  /command not found/i,
  /cannot find the path specified/i,
];

function isNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

function pythonHint(command: string): string {
  const trimmed = command.trim();
  if (/^python3?\s/i.test(trimmed)) {
    const rest = trimmed.replace(/^python3?\s+/i, '');
    return (
      `'python' was not found in PATH. ` +
      `On Windows try: py ${rest}\n` +
      `Or install Python from https://python.org and add it to PATH.`
    );
  }
  return '';
}

export async function runCommand(
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const command = String(args['command'] ?? '');
  if (!command.trim()) { return { ok: false, error: 'command is required' }; }

  const cwdArg = args['cwd'] ? String(args['cwd']) : ctx.workspaceRoot;

  let cwd: string;
  try {
    cwd = await WorkspaceSecurity.resolveInsideWorkspace(cwdArg, ctx.workspaceRoot, Config.getAllowOutsideWorkspace());
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  const start = Date.now();
  const cmdResult = await CommandService.run(command, cwd, Config.getCommandTimeoutMs(), signal);
  const durationMs = Date.now() - start;

  const max = Config.getMaxToolOutputChars();
  const cleanStdout = SecretScanner.redact(cmdResult.stdout).text;
  const cleanStderr = SecretScanner.redact(cmdResult.stderr).text;

  // Build combined output shown in UI — keep stderr prominent
  const combinedParts: string[] = [];
  if (cleanStdout.trim()) { combinedParts.push(cleanStdout.trim()); }
  if (cleanStderr.trim()) { combinedParts.push(`STDERR:\n${cleanStderr.trim()}`); }
  if (cmdResult.timedOut) { combinedParts.push(`[timed out after ${Config.getCommandTimeoutMs() / 1000}s]`); }

  const rawCombined = combinedParts.join('\n');
  const { text: output, truncated } = OutputLimiter.truncate(rawCombined, max, 'command output');

  const succeeded = cmdResult.exitCode === 0 && !cmdResult.timedOut;

  // Produce a clear error message — distinguish "binary not found" from "script error"
  let errorMsg: string | undefined;
  if (!succeeded) {
    if (cmdResult.timedOut) {
      errorMsg = `Command timed out after ${Config.getCommandTimeoutMs() / 1000}s.`;
    } else if (isNotFound(cleanStderr)) {
      const hint = pythonHint(command);
      errorMsg = hint || `Command not found: ${command.split(' ')[0]}. Check that it is installed and in PATH.`;
    } else {
      errorMsg = `Command exited with code ${cmdResult.exitCode}.${cleanStderr ? `\nSTDERR: ${cleanStderr.slice(0, 500)}` : ''}`;
    }
  }

  return {
    ok: succeeded,
    data: {
      command,
      cwd,
      stdout: OutputLimiter.truncate(cleanStdout, max).text,
      stderr: OutputLimiter.truncate(cleanStderr, max).text,
      exitCode: cmdResult.exitCode,
      timedOut: cmdResult.timedOut,
      durationMs,
      output,
      truncated,
    },
    summary: `Ran: ${command} (exit ${cmdResult.exitCode}, ${durationMs}ms)`,
    ...(errorMsg ? { error: errorMsg } : {}),
  } as ToolResult;
}
