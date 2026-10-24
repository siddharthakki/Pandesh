import * as fs from 'fs/promises';
import * as path from 'path';
import { FileService } from '../services/FileService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import {
  EditDiagnostic,
  EditFileResult,
  EditRequest,
  EditResult,
  EditingModelCapabilities,
  EditStrategy,
  JsonEditOperation,
} from './EditTypes';
import { FileVersionTracker, hashText } from './FileVersionTracker';
import { applyParsedPatch, parseUnifiedPatch } from './PatchParser';
import { validateEditedContent } from './SyntaxValidator';

interface PreparedFile {
  path: string;
  existed: boolean;
  original: string;
  next: string | null;
  beforeHash?: string;
  afterHash?: string;
}

export interface EditingEngineOptions {
  allowOutsideWorkspace?: boolean;
  maxWholeFileChars?: number;
}

export class EditingEngine {
  private readonly maxWholeFileChars: number;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: EditingEngineOptions = {},
  ) {
    this.maxWholeFileChars = options.maxWholeFileChars ?? 500_000;
  }

  async selectStrategy(
    request: EditRequest,
    capabilities: EditingModelCapabilities,
  ): Promise<{ strategy: EditStrategy; fallbackUsed?: EditStrategy }> {
    if (request.strategy) { return { strategy: request.strategy }; }
    if (request.patch?.trim()) { return { strategy: 'structured_patch' }; }
    if (request.jsonOperations?.length) { return { strategy: 'json_ast' }; }
    if (request.search !== undefined) { return { strategy: 'search_replace' }; }
    if (request.preview) { return { strategy: 'proposed_diff' }; }

    if (request.path && request.content !== undefined) {
      const resolved = await this.resolve(request.path);
      const exists = await FileService.exists(resolved);
      const size = exists ? (await fs.stat(resolved)).size : 0;
      if (!capabilities.structuredOutput && exists && size > 30_000) {
        return { strategy: 'proposed_diff', fallbackUsed: 'proposed_diff' };
      }
      return { strategy: 'whole_file' };
    }
    return { strategy: 'proposed_diff', fallbackUsed: 'proposed_diff' };
  }

  async apply(
    request: EditRequest,
    capabilities: EditingModelCapabilities,
  ): Promise<EditResult> {
    const selection = await this.selectStrategy(request, capabilities);
    try {
      const result = selection.strategy === 'structured_patch'
        ? await this.applyStructuredPatch(request)
        : selection.strategy === 'search_replace'
          ? await this.applySearchReplace(request)
          : selection.strategy === 'json_ast'
            ? await this.applyJsonAst(request)
            : await this.applyWholeFile(request, selection.strategy === 'proposed_diff');
      return { ...result, fallbackUsed: selection.fallbackUsed };
    } catch (error) {
      return {
        ok: false,
        applied: false,
        preview: Boolean(request.preview),
        strategy: selection.strategy,
        files: [],
        diagnostics: [{
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
          source: selection.strategy === 'structured_patch' ? 'patch' : 'strategy',
        }],
        hunks: [],
        error: error instanceof Error ? error.message : String(error),
        fallbackUsed: selection.fallbackUsed,
      };
    }
  }

  private async applyWholeFile(request: EditRequest, forcePreview: boolean): Promise<EditResult> {
    if (!request.path) { throw new Error('path is required'); }
    if (request.content === undefined) { throw new Error('content is required'); }
    if (request.content.length > this.maxWholeFileChars) {
      throw new Error(`Whole-file content exceeds ${this.maxWholeFileChars} characters; use a patch or targeted replacement.`);
    }

    const resolved = await this.resolve(request.path);
    const prepared = await this.prepareFile(resolved, request.content, request.expectedHash, request);
    const diagnostics = [
      ...this.freshnessDiagnostics(prepared, request),
      ...validateEditedContent(resolved, request.content),
    ];
    if (diagnostics.some(item => item.severity === 'error')) {
      return this.failure('whole_file', diagnostics);
    }

    const preview = forcePreview || Boolean(request.preview);
    if (!preview) {
      await FileService.atomicWriteText(resolved, request.content);
      this.recordVersion(resolved, request.content, request);
    }
    return {
      ok: true,
      applied: !preview,
      preview,
      strategy: forcePreview ? 'proposed_diff' : 'whole_file',
      files: [this.toFileResult(prepared, preview)],
      diagnostics,
      hunks: [],
      proposedContent: preview ? { [resolved]: request.content } : undefined,
    };
  }

  private async applySearchReplace(request: EditRequest): Promise<EditResult> {
    if (!request.path) { throw new Error('path is required'); }
    if (!request.search) { throw new Error('search is required'); }
    const resolved = await this.resolve(request.path);
    if (!await FileService.exists(resolved)) { throw new Error(`File not found: ${resolved}`); }
    const original = await FileService.readText(resolved);
    const occurrences = original.split(request.search).length - 1;
    if (occurrences === 0) { throw new Error('Search text was not found; source may be stale.'); }
    if (occurrences > 1 && !request.replaceAll) {
      throw new Error(`Search text is ambiguous (${occurrences} occurrences). Set replaceAll=true or provide a more specific block.`);
    }
    const replacement = request.replace ?? '';
    const next = request.replaceAll
      ? original.split(request.search).join(replacement)
      : original.replace(request.search, replacement);
    const prepared = await this.prepareFile(resolved, next, request.expectedHash, request, original);
    const diagnostics = [
      ...this.freshnessDiagnostics(prepared, request),
      ...validateEditedContent(resolved, next),
    ];
    if (diagnostics.some(item => item.severity === 'error')) {
      return this.failure('search_replace', diagnostics);
    }

    const preview = Boolean(request.preview);
    if (!preview) {
      await FileService.atomicWriteText(resolved, next);
      this.recordVersion(resolved, next, request);
    }
    return {
      ok: true,
      applied: !preview,
      preview,
      strategy: 'search_replace',
      files: [this.toFileResult(prepared, preview)],
      diagnostics,
      hunks: [{
        ...request.attribution,
        file: resolved,
        hunkIndex: 0,
        oldStart: this.lineOf(original, request.search),
        oldCount: request.search.split('\n').length,
        newStart: this.lineOf(next, replacement),
        newCount: replacement.split('\n').length,
      }],
      proposedContent: preview ? { [resolved]: next } : undefined,
    };
  }

  private async applyJsonAst(request: EditRequest): Promise<EditResult> {
    if (!request.path) { throw new Error('path is required'); }
    if (!request.jsonOperations?.length) { throw new Error('jsonOperations are required'); }
    const resolved = await this.resolve(request.path);
    const exists = await FileService.exists(resolved);
    const original = exists ? await FileService.readText(resolved) : '{}\n';
    let document: unknown;
    try {
      document = JSON.parse(original);
    } catch (error) {
      throw new Error(`Cannot apply JSON AST edit to invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!document || typeof document !== 'object') { throw new Error('JSON root must be an object or array'); }

    for (const operation of request.jsonOperations) {
      this.applyJsonOperation(document, operation);
    }
    const indentation = original.match(/\n(\s+)\S/)?.[1]?.length ?? 2;
    const next = `${JSON.stringify(document, null, indentation)}\n`;
    const prepared = await this.prepareFile(resolved, next, request.expectedHash, request, original);
    const diagnostics = [
      ...this.freshnessDiagnostics(prepared, request),
      ...validateEditedContent(resolved, next),
    ];
    if (diagnostics.some(item => item.severity === 'error')) {
      return this.failure('json_ast', diagnostics);
    }

    const preview = Boolean(request.preview);
    if (!preview) {
      await FileService.atomicWriteText(resolved, next);
      this.recordVersion(resolved, next, request);
    }
    return {
      ok: true,
      applied: !preview,
      preview,
      strategy: 'json_ast',
      files: [this.toFileResult(prepared, preview)],
      diagnostics,
      hunks: request.jsonOperations.map((_, index) => ({
        ...request.attribution,
        file: resolved,
        hunkIndex: index,
        oldStart: 1,
        oldCount: original.split('\n').length,
        newStart: 1,
        newCount: next.split('\n').length,
      })),
      proposedContent: preview ? { [resolved]: next } : undefined,
    };
  }

  private async applyStructuredPatch(request: EditRequest): Promise<EditResult> {
    if (!request.patch?.trim()) { throw new Error('patch is required'); }
    const parsed = parseUnifiedPatch(request.patch);
    const prepared: PreparedFile[] = [];
    const diagnostics: EditDiagnostic[] = [];
    const hunks: EditResult['hunks'] = [];

    for (const filePatch of parsed) {
      const target = filePatch.newPath ?? filePatch.oldPath;
      if (!target) { throw new Error('Patch target is missing'); }
      const resolved = await this.resolve(target);
      const exists = await FileService.exists(resolved);
      const original = exists ? await FileService.readText(resolved) : '';
      const expected = request.expectedHashes?.[target] ?? request.expectedHash;
      const freshness = await this.prepareFile(resolved, original, expected, request, original);
      diagnostics.push(...this.freshnessDiagnostics(freshness, request));
      if (filePatch.oldPath === null && exists) {
        diagnostics.push({ severity: 'error', message: `Create patch target already exists: ${target}`, source: 'patch' });
        continue;
      }
      if (filePatch.oldPath !== null && !exists) {
        diagnostics.push({ severity: 'error', message: `Patch source does not exist: ${target}`, source: 'patch' });
        continue;
      }

      let next: string | null;
      if (filePatch.newPath === null) {
        next = null;
      } else {
        const applied = applyParsedPatch(original, filePatch);
        next = applied.content;
        diagnostics.push(...validateEditedContent(resolved, next));
        applied.hunkRanges.forEach((range, index) => hunks.push({
          ...request.attribution,
          file: resolved,
          hunkIndex: index,
          ...range,
        }));
      }
      prepared.push({
        path: resolved,
        existed: exists,
        original,
        next,
        beforeHash: exists ? hashText(original) : undefined,
        afterHash: next === null ? undefined : hashText(next),
      });
    }

    if (diagnostics.some(item => item.severity === 'error')) {
      return this.failure('structured_patch', diagnostics, hunks);
    }
    const preview = Boolean(request.preview);
    if (!preview) { await this.commitPreparedFiles(prepared, request); }
    return {
      ok: true,
      applied: !preview,
      preview,
      strategy: 'structured_patch',
      files: prepared.map(file => this.toFileResult(file, preview)),
      diagnostics,
      hunks,
      proposedContent: preview
        ? Object.fromEntries(prepared.filter(file => file.next !== null).map(file => [file.path, file.next as string]))
        : undefined,
    };
  }

  private async commitPreparedFiles(files: PreparedFile[], request: EditRequest): Promise<void> {
    const committed: PreparedFile[] = [];
    try {
      for (const file of files) {
        if (file.next === null) {
          if (file.existed) { await FileService.deleteFile(file.path); }
        } else {
          await FileService.atomicWriteText(file.path, file.next);
          this.recordVersion(file.path, file.next, request);
        }
        committed.push(file);
      }
    } catch (error) {
      for (const file of committed.reverse()) {
        try {
          if (file.existed) { await FileService.atomicWriteText(file.path, file.original); }
          else if (await FileService.exists(file.path)) { await FileService.deleteFile(file.path); }
        } catch { /* checkpoint remains the final recovery path */ }
      }
      throw new Error(`Atomic edit transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async prepareFile(
    filePath: string,
    next: string,
    explicitExpected: string | undefined,
    request: EditRequest,
    suppliedOriginal?: string,
  ): Promise<PreparedFile> {
    const existed = await FileService.exists(filePath);
    const original = suppliedOriginal ?? (existed ? await FileService.readText(filePath) : '');
    return {
      path: filePath,
      existed,
      original,
      next,
      beforeHash: existed ? hashText(original) : undefined,
      afterHash: hashText(next),
    };
  }

  private freshnessDiagnostics(file: PreparedFile, request: EditRequest): EditDiagnostic[] {
    if (!file.existed) { return []; }
    const observed = FileVersionTracker.get(file.path, request.attribution);
    const expected = request.expectedHash ?? observed?.hash;
    if (expected && expected !== file.beforeHash) {
      return [{
        severity: 'error',
        message: `Stale source rejected for ${file.path}. Expected ${expected}, current ${file.beforeHash}. Re-read the file and regenerate the edit.`,
        source: 'freshness',
      }];
    }
    if (!expected && !request.allowUnverifiedOverwrite) {
      return [{
        severity: 'warning',
        message: `No observed source hash was available for ${file.path}; edit was validated against the current on-disk content.`,
        source: 'freshness',
      }];
    }
    return [];
  }

  private applyJsonOperation(root: unknown, operation: JsonEditOperation): void {
    const parts = operation.path
      .replace(/^\//, '')
      .split(/[/.]/)
      .filter(Boolean)
      .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.length === 0) { throw new Error('JSON operation path cannot target the document root'); }
    let cursor: any = root;
    for (const part of parts.slice(0, -1)) {
      const key: string | number = Array.isArray(cursor) ? Number(part) : part;
      if (cursor[key] === undefined) { cursor[key] = {}; }
      if (!cursor[key] || typeof cursor[key] !== 'object') {
        throw new Error(`JSON path segment is not an object: ${part}`);
      }
      cursor = cursor[key];
    }
    const finalPart = parts[parts.length - 1];
    const key: string | number = Array.isArray(cursor) ? Number(finalPart) : finalPart;
    if (operation.op === 'delete') {
      if (Array.isArray(cursor)) { cursor.splice(Number(key), 1); }
      else { delete cursor[key]; }
    } else if (operation.op === 'merge') {
      const current = cursor[key];
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`JSON merge target is not an object: ${operation.path}`);
      }
      if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) {
        throw new Error(`JSON merge value must be an object: ${operation.path}`);
      }
      cursor[key] = { ...current, ...operation.value };
    } else {
      cursor[key] = operation.value;
    }
  }

  private toFileResult(file: PreparedFile, preview: boolean): EditFileResult {
    return {
      path: file.path,
      existed: file.existed,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
      bytesWritten: preview || file.next === null ? 0 : Buffer.byteLength(file.next, 'utf8'),
      created: !file.existed && file.next !== null,
      deleted: file.next === null,
    };
  }

  private failure(
    strategy: EditStrategy,
    diagnostics: EditDiagnostic[],
    hunks: EditResult['hunks'] = [],
  ): EditResult {
    return {
      ok: false,
      applied: false,
      preview: false,
      strategy,
      files: [],
      diagnostics,
      hunks,
      error: diagnostics.find(item => item.severity === 'error')?.message ?? 'Edit validation failed',
    };
  }

  private recordVersion(filePath: string, content: string, request: EditRequest): void {
    FileVersionTracker.record(filePath, content, request.attribution);
  }

  private lineOf(content: string, needle: string): number {
    if (!needle) { return 1; }
    return content.slice(0, Math.max(0, content.indexOf(needle))).split('\n').length;
  }

  private async resolve(candidate: string): Promise<string> {
    return WorkspaceSecurity.resolveInsideWorkspace(
      candidate,
      this.workspaceRoot,
      Boolean(this.options.allowOutsideWorkspace),
    );
  }
}
