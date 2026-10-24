import * as path from 'path';
import * as vscode from 'vscode';
import { ToolResult, ToolContext } from './ToolTypes';
import { FileService } from '../services/FileService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import { OutputLimiter } from '../services/OutputLimiter';
import { Config } from '../config/Config';
import { EditingEngine } from '../editing/EditingEngine';
import { EditRequest, EditResult, JsonEditOperation } from '../editing/EditTypes';
import { FileVersionTracker } from '../editing/FileVersionTracker';
import { ModelCapabilityRegistry } from '../models/ModelCapabilityRegistry';

const proposedContents = new Map<string, string>();

async function resolvePath(candidate: string, ctx: ToolContext): Promise<string> {
  return WorkspaceSecurity.resolveInsideWorkspace(
    candidate,
    ctx.workspaceRoot,
    Config.getAllowOutsideWorkspace(),
  );
}

function attribution(ctx: ToolContext, args: Record<string, unknown>) {
  return {
    taskId: ctx.taskId,
    toolCallId: typeof args['toolCallId'] === 'string' ? args['toolCallId'] : undefined,
    iterationId: ctx.iterationId,
    model: ctx.model,
  };
}

function engineFor(ctx: ToolContext): EditingEngine {
  return new EditingEngine(ctx.workspaceRoot, {
    allowOutsideWorkspace: Config.getAllowOutsideWorkspace(),
    maxWholeFileChars: Math.max(Config.getMaxFileReadChars() * 4, 200_000),
  });
}

function capabilities(ctx: ToolContext) {
  const model = ModelCapabilityRegistry.getInstance().getCapabilities(
    ctx.model,
    Config.getProviderType(),
  );
  return {
    structuredOutput: model.structuredOutput,
    tools: model.tools,
    contextWindow: model.contextWindow,
  };
}

function asToolResult(result: EditResult): ToolResult {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? result.diagnostics.map(item => item.message).join('; '),
      blocked: result.diagnostics.some(item => item.source === 'freshness'),
    };
  }
  return {
    ok: true,
    data: result,
    summary: result.preview
      ? `Prepared ${result.strategy} preview for ${result.files.length} file(s)`
      : `Applied ${result.strategy} to ${result.files.length} file(s)`,
  };
}

export async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const candidate = String(args['path'] ?? '');
  if (!candidate) { return { ok: false, error: 'path is required' }; }

  let resolved: string;
  try { resolved = await resolvePath(candidate, ctx); }
  catch (error) { return { ok: false, error: String(error) }; }

  if (!await FileService.exists(resolved)) {
    return { ok: false, error: `File not found: ${resolved}` };
  }

  let content: string;
  try { content = await FileService.readText(resolved); }
  catch (error) { return { ok: false, error: String(error) }; }

  const version = FileVersionTracker.record(resolved, content, {
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
  });
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const characterCount = content.length;
  const { text, truncated } = OutputLimiter.truncate(
    content,
    Config.getMaxFileReadChars(),
    'file',
  );
  return {
    ok: true,
    data: {
      path: resolved,
      content: text,
      truncated,
      totalLines,
      characterCount,
      eof: !truncated,
      sha256: version.hash,
      observedAt: version.observedAt,
    },
    summary: `Read ${resolved}`,
  };
}

export async function readFileRange(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const candidate = String(args['path'] ?? '');
  const startLine = Number(args['startLine']);
  const endLine = Number(args['endLine']);
  if (!candidate) { return { ok: false, error: 'path is required' }; }
  if (!startLine || !endLine) { return { ok: false, error: 'startLine and endLine are required' }; }
  if (startLine > endLine) {
    return { ok: false, error: `startLine (${startLine}) must be <= endLine (${endLine})` };
  }

  let resolved: string;
  try { resolved = await resolvePath(candidate, ctx); }
  catch (error) { return { ok: false, error: String(error) }; }

  try {
    const full = await FileService.readText(resolved);
    const version = FileVersionTracker.record(resolved, full, {
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
    });
    const allLines = full.split(/\r?\n/);
    const totalLines = allLines.length;
    const characterCount = full.length;
    if (startLine > totalLines) {
      return {
        ok: true,
        data: {
          path: resolved,
          startLine,
          endLine,
          content: `EOF already reached. File contains ${totalLines} lines; no unread content remains.`,
          totalLines,
          characterCount,
          eof: true,
          noUnreadContent: true,
          sha256: version.hash,
        },
        summary: `EOF already reached for ${resolved}`,
      };
    }
    const lines = allLines.slice(Math.max(0, startLine - 1), endLine);
    const eof = endLine >= totalLines;
    return {
      ok: true,
      data: {
        path: resolved,
        startLine,
        endLine: Math.min(endLine, totalLines),
        totalLines,
        characterCount,
        eof,
        content: lines.join('\n'),
        sha256: version.hash,
      },
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const request: EditRequest = {
    path: typeof args['path'] === 'string' ? args['path'] : undefined,
    strategy: args['strategy'] as EditRequest['strategy'],
    content: typeof args['content'] === 'string' ? args['content'] : undefined,
    patch: typeof args['patch'] === 'string' ? args['patch'] : undefined,
    search: typeof args['search'] === 'string' ? args['search'] : undefined,
    replace: typeof args['replace'] === 'string' ? args['replace'] : undefined,
    replaceAll: Boolean(args['replaceAll']),
    expectedHash: typeof args['expectedHash'] === 'string' ? args['expectedHash'] : undefined,
    expectedHashes: args['expectedHashes'] && typeof args['expectedHashes'] === 'object'
      ? args['expectedHashes'] as Record<string, string>
      : undefined,
    jsonOperations: Array.isArray(args['jsonOperations'])
      ? args['jsonOperations'] as JsonEditOperation[]
      : undefined,
    preview: Boolean(args['preview']),
    allowUnverifiedOverwrite: Boolean(args['allowUnverifiedOverwrite']),
    attribution: attribution(ctx, args),
  };
  const result = await engineFor(ctx).apply(request, capabilities(ctx));
  if (result.preview && result.proposedContent) {
    for (const [filePath, content] of Object.entries(result.proposedContent)) {
      proposedContents.set(filePath, content);
    }
  }
  return asToolResult(result);
}

export async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return editFile({ ...args, strategy: 'whole_file' }, ctx);
}

export async function replaceInFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return editFile({ ...args, strategy: 'search_replace' }, ctx);
}

export async function applyPatch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return editFile({ ...args, strategy: 'structured_patch' }, ctx);
}

export async function proposeFileChange(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await engineFor(ctx).apply({
    path: String(args['path'] ?? ''),
    content: String(args['content'] ?? ''),
    strategy: 'proposed_diff',
    preview: true,
    expectedHash: typeof args['expectedHash'] === 'string' ? args['expectedHash'] : undefined,
    attribution: attribution(ctx, args),
  }, capabilities(ctx));
  if (!result.ok || !result.proposedContent) { return asToolResult(result); }

  for (const [filePath, content] of Object.entries(result.proposedContent)) {
    proposedContents.set(filePath, content);
    const proposedUri = vscode.Uri.parse(`ollama-agent-proposed:${encodeURIComponent(filePath)}`);
    const existingUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand(
      'vscode.diff',
      existingUri,
      proposedUri,
      `Proposed: ${path.basename(filePath)}`,
    );
  }
  return asToolResult(result);
}

export async function listDirectory(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const candidate = String(args['path'] ?? ctx.workspaceRoot);
  const depth = Math.min(Number(args['depth'] ?? 2), 5);
  let resolved: string;
  try { resolved = await resolvePath(candidate, ctx); }
  catch (error) { return { ok: false, error: String(error) }; }

  try {
    const entries = await FileService.listDir(resolved, depth, Config.getIgnoredDirs());
    const relative = entries.map(entry => entry.replace(ctx.workspaceRoot, '').replace(/^[/\\]/, ''));
    const { lines, truncated } = OutputLimiter.truncateLines(relative, 500);
    return { ok: true, data: { path: resolved, entries: lines, truncated } };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function createDirectory(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const candidate = String(args['path'] ?? '');
  if (!candidate) { return { ok: false, error: 'path is required' }; }
  let resolved: string;
  try { resolved = await resolvePath(candidate, ctx); }
  catch (error) { return { ok: false, error: String(error) }; }

  try { await FileService.createDir(resolved); }
  catch (error) { return { ok: false, error: String(error) }; }
  return {
    ok: true,
    data: { path: resolved, created: true },
    summary: `Created directory ${resolved}`,
  };
}

export function registerProposedContentProvider(context: vscode.ExtensionContext): void {
  const provider = new class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const filePath = decodeURIComponent(uri.path);
      return proposedContents.get(filePath) ?? '';
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('ollama-agent-proposed', provider),
  );
}
