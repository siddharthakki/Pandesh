import { FileService } from '../services/FileService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import { EditRequest, EditResult, EditingModelCapabilities } from './EditTypes';
import {
  EditingEngine as BaseEditingEngine,
  EditingEngineOptions,
} from './BaseEditingEngine';
import { hashText } from './FileVersionTracker';
import { parseUnifiedPatch } from './PatchParser';

export type { EditingEngineOptions } from './BaseEditingEngine';

/**
 * Adds per-file freshness enforcement for multi-file patches while preserving
 * the core multi-strategy implementation in BaseEditingEngine.
 */
export class EditingEngine extends BaseEditingEngine {
  constructor(
    private readonly strictWorkspaceRoot: string,
    private readonly strictOptions: EditingEngineOptions = {},
  ) {
    super(strictWorkspaceRoot, strictOptions);
  }

  async apply(
    request: EditRequest,
    capabilities: EditingModelCapabilities,
  ): Promise<EditResult> {
    if (request.patch?.trim() && request.expectedHashes) {
      try {
        for (const filePatch of parseUnifiedPatch(request.patch)) {
          const target = filePatch.newPath ?? filePatch.oldPath;
          if (!target) { continue; }
          const expected = request.expectedHashes[target]
            ?? request.expectedHashes[target.replace(/\\/g, '/')];
          if (!expected) { continue; }
          const resolved = await WorkspaceSecurity.resolveInsideWorkspace(
            target,
            this.strictWorkspaceRoot,
            Boolean(this.strictOptions.allowOutsideWorkspace),
          );
          const current = await FileService.exists(resolved)
            ? await FileService.readText(resolved)
            : '';
          const actual = hashText(current);
          if (actual !== expected) {
            return {
              ok: false,
              applied: false,
              preview: Boolean(request.preview),
              strategy: 'structured_patch',
              files: [],
              diagnostics: [{
                severity: 'error',
                message: `Stale source rejected for ${target}. Expected ${expected}, current ${actual}. Re-read all patch targets and regenerate the patch.`,
                source: 'freshness',
              }],
              hunks: [],
              error: `Stale source rejected for ${target}`,
            };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          applied: false,
          preview: Boolean(request.preview),
          strategy: 'structured_patch',
          files: [],
          diagnostics: [{ severity: 'error', message, source: 'freshness' }],
          hunks: [],
          error: message,
        };
      }
    }
    return super.apply(request, capabilities);
  }
}
