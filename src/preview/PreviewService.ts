/**
 * Opens a browser-viewable artifact for the user inside VS Code.
 *
 * PREVIEW IS NOT VALIDATION. Opening a page proves only that it can be shown; it says nothing about whether it
 * works. Nothing here reports, records or implies a validation result, and nothing in the validation path depends on
 * a preview having been opened. The two stay separate on purpose.
 *
 * What VS Code lets an extension do (verified against the documented, stable surface only):
 *  - open an http(s) URL through the built-in Simple Browser commands (`simpleBrowser.api.open` /
 *    `simpleBrowser.show`). On VS Code versions that ship the Integrated Browser these commands themselves hand
 *    localhost URLs to it (setting `simpleBrowser.useIntegratedBrowser`, default on), so the preview lands in the
 *    Integrated Browser without this code naming any undocumented command id; otherwise it opens the Simple Browser
 *    view beside the editor;
 *  - open a URL in the external browser (`env.openExternal`).
 * There is NO stable extension API to drive or inspect VS Code's Integrated Browser (navigate it programmatically,
 * read its console or DOM, select an element, take a screenshot). So this opens and refreshes the preview, and that is
 * all it claims to do. The browser-feedback seam (`PreviewFeedbackSeam`) is declared for later, empty today, and no
 * undocumented command id is used to fake it.
 *
 * External-browser use is a fallback only: when the in-editor browser is unavailable, or when the user asks for it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StaticPreviewServer } from './StaticPreviewServer';

/** The bits of VS Code this needs, injected so the behaviour is testable without a window. */
export interface PreviewHost {
  /** Resolves when the command ran; rejects when it does not exist or fails. */
  executeCommand(command: string, ...args: unknown[]): PromiseLike<unknown>;
  openExternal(url: string): PromiseLike<boolean>;
  /** Placement for the in-editor browser: beside the source, without stealing focus. */
  placement: { viewColumn: number; preserveFocus: boolean };
}

export type PreviewOpenResult =
  | { outcome: 'opened'; where: 'editor-browser'; url: string }
  | { outcome: 'opened'; where: 'external-browser'; url: string; reason: 'editor_browser_unavailable' | 'requested' }
  | { outcome: 'refused'; reason: 'outside_workspace' | 'not_previewable' | 'not_found' };

const PREVIEWABLE = /\.html?$/i;

export function isPreviewablePath(relativePath: string): boolean {
  return PREVIEWABLE.test(relativePath);
}

/** The previewable artifacts among changed paths, in order, de-duplicated. A change set with none yields none. */
export function previewableArtifacts(changedPaths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of changedPaths) {
    const normalized = raw.replace(/\\/g, '/');
    if (isPreviewablePath(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Declared seam for future browser-derived evidence. Every field is something the Integrated Browser would have to
 * expose to an extension, which it does not do today; nothing populates this yet. Keeping the shape here means a
 * later capability can fill it in without changing the preview flow.
 */
export interface PreviewFeedbackSeam {
  loadResult?: 'loaded' | 'failed';
  consoleErrors?: string[];
  viewport?: { width: number; height: number };
  /** A bounded description of an element the user selected in the preview. */
  selectedElement?: { selector: string; text?: string };
}

export class PreviewService {
  private readonly servers = new Map<string, StaticPreviewServer>();

  constructor(private readonly host: PreviewHost) {}

  /**
   * Opens `absolutePath` (an HTML file inside `workspaceRoot`) in the editor's browser. A second call for the same
   * file reuses the server and simply shows the current bytes again: that is the "refresh" path, so iterating on
   * the same project ("add dark mode", "make the cards smaller") needs no new setup.
   */
  async open(
    workspaceRoot: string,
    absolutePath: string,
    options: { external?: boolean; fileExists?: (file: string) => boolean } = {},
  ): Promise<PreviewOpenResult> {
    const relative = path.relative(workspaceRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { outcome: 'refused', reason: 'outside_workspace' };
    if (!isPreviewablePath(relative)) return { outcome: 'refused', reason: 'not_previewable' };
    const exists = options.fileExists ?? ((file: string) => fs.existsSync(file));
    if (!exists(absolutePath)) return { outcome: 'refused', reason: 'not_found' };

    const server = await this.serverFor(workspaceRoot);
    const url = server.urlFor(relative);
    if (options.external) {
      await this.host.openExternal(url);
      return { outcome: 'opened', where: 'external-browser', url, reason: 'requested' };
    }
    if (await this.openInEditorBrowser(url)) return { outcome: 'opened', where: 'editor-browser', url };
    await this.host.openExternal(url);
    return { outcome: 'opened', where: 'external-browser', url, reason: 'editor_browser_unavailable' };
  }

  dispose(): void {
    for (const server of this.servers.values()) server.dispose();
    this.servers.clear();
  }

  private async serverFor(root: string): Promise<StaticPreviewServer> {
    const existing = this.servers.get(root);
    if (existing?.isOpen) return existing;
    const server = await StaticPreviewServer.start(root);
    server.onClose = () => { if (this.servers.get(root) === server) this.servers.delete(root); };
    this.servers.set(root, server);
    return server;
  }

  /** Documented commands only, most specific first. Any failure falls through to the next, then to false. */
  private async openInEditorBrowser(url: string): Promise<boolean> {
    const attempts: Array<() => PromiseLike<unknown>> = [
      () => this.host.executeCommand('simpleBrowser.api.open', url, this.host.placement),
      () => this.host.executeCommand('simpleBrowser.show', url),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        return true;
      } catch {
        // command missing (Simple Browser disabled) or failed; try the next documented route
      }
    }
    return false;
  }
}
