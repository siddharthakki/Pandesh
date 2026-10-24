import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCredentialFilePath, redactSecrets } from '../platform/credentialStore';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_LIST_ENTRIES = 500;

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

function resolveRequestedPath(raw: unknown): { path: string; error?: ToolExecutionResult } {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { path: '', error: failure('path is required', 'invalid_arguments') };
  return { path: path.resolve(trimmed) };
}

function listDirectory(target: string): ToolExecutionResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return failure(`Cannot list "${target}": ${error instanceof Error ? error.message : String(error)}`, 'filesystem_path_unavailable');
  }
  const shown = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = shown.map((entry) => `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${entry.name}`);
  const omitted = entries.length - shown.length;
  const output = bound(lines.join('\n') || '(empty directory)') + (omitted > 0 ? `\n…[${omitted} more entries omitted]` : '');
  return {
    status: 'succeeded', exitCode: 0, output,
    resultCategory: 'filesystem_directory_listed',
    normalizedArguments: { path: target },
  };
}

function readFileOutsideWorkspace(target: string): ToolExecutionResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return failure(`Cannot read "${target}": ${error instanceof Error ? error.message : String(error)}`, 'filesystem_path_unavailable');
  }
  if (!stat.isFile()) {
    return failure(`"${target}" is not a file`, 'filesystem_not_a_file');
  }
  if (isCredentialFilePath(target)) {
    return failure(`"${path.basename(target)}" holds credentials. Credential files are never read into the conversation.`, 'filesystem_credential_file_refused');
  }
  if (stat.size > MAX_FILE_BYTES) {
    return failure(`"${target}" is ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit`, 'filesystem_file_too_large');
  }
  let content: string;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return failure(`Cannot read "${target}": ${error instanceof Error ? error.message : String(error)}`, 'filesystem_read_failed');
  }
  return {
    status: 'succeeded', exitCode: 0, output: redactSecrets(bound(content)),
    resultCategory: 'filesystem_file_read',
    normalizedArguments: { path: target },
  };
}

/**
 * Read-only filesystem access outside the selected workspace. The existing
 * `read_file`/`propose_*` tools (`core/runtime/toolRunner.ts`) are
 * deliberately sandboxed to the workspace root via `recoverRepositoryPath` —
 * this capability is the explicit escape hatch for "read this file/folder
 * elsewhere on disk," gated per-call by the same approval mechanism as any
 * other consequential action (confirmed scope: read-only, approval-gated per
 * path, never a write). The human sees the exact resolved absolute path in
 * the approval card before anything is read.
 */
export function createFilesystemCapabilityAdapter(): GovernedCapabilityAdapter {
  function redactArguments(_toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const { path: target, error } = resolveRequestedPath(args.path);
    if (error) return args;
    return { ...args, path: target };
  }

  async function run(call: ModelToolCall): Promise<ToolExecutionResult> {
    const { path: target, error } = resolveRequestedPath(call.arguments.path);
    if (error) return error;
    if (call.name === 'list_directory_outside_workspace') return listDirectory(target);
    if (call.name === 'read_file_outside_workspace') return readFileOutsideWorkspace(target);
    return failure(`unknown tool '${call.name}'`, 'invalid_arguments');
  }

  return {
    id: 'filesystem',
    definitions: () => [
      {
        name: 'list_directory_outside_workspace',
        description: 'List the entries (files and subfolders) of a directory anywhere on the local filesystem, outside the selected workspace. Read-only, but consequential: requires approval showing the exact path before it runs.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute directory path.' } }, required: ['path'] },
      },
      {
        name: 'read_file_outside_workspace',
        description: 'Read a UTF-8 text file anywhere on the local filesystem, outside the selected workspace (up to 2MB). Read-only, but consequential: requires approval showing the exact path before it runs.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path.' } }, required: ['path'] },
      },
    ],
    classify: () => 'consequential',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    redactArguments,
    run,
  };
}
