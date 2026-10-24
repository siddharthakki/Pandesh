/**
 * The compact, one-time prompt shown when the agent has just created or changed a browser-viewable file.
 *
 * Deliberately a transient notification, not a permanent control: with no previewable artifact there is nothing on
 * screen, and the same two actions stay reachable afterwards from the editor title bar of any HTML file and the
 * command palette. It states what happened and offers the next step; it does NOT say the page works. Preview is not
 * validation, and the wording must never imply otherwise.
 */
import * as path from 'path';
import * as vscode from 'vscode';

export const OPEN_PREVIEW_COMMAND = 'ollama-agent.openPreview';
export const OPEN_PREVIEW_EXTERNAL_COMMAND = 'ollama-agent.openPreviewExternal';

const OPEN_PREVIEW = 'Open Preview';
const OPEN_FILE = 'Open File';

/** One offer per artifact per session; a refresh of the same artifact is the Open Preview command again. */
const offered = new Set<string>();

export function offerPreview(workspaceRoot: string, relativePath: string, changeKind: 'created' | 'updated' = 'updated'): void {
  const absolute = path.join(workspaceRoot, relativePath);
  const key = `${workspaceRoot}::${relativePath}`;
  // A later change to the same page is the "keep iterating" case: offer again so the user can refresh the preview.
  const wasOffered = offered.has(key);
  offered.add(key);
  const verb = wasOffered ? 'updated' : changeKind;
  void vscode.window
    .showInformationMessage(`${relativePath} was ${verb}. It has not been tested in a browser.`, OPEN_PREVIEW, OPEN_FILE)
    .then(choice => {
      if (choice === OPEN_PREVIEW) return vscode.commands.executeCommand(OPEN_PREVIEW_COMMAND, vscode.Uri.file(absolute));
      if (choice === OPEN_FILE) return vscode.window.showTextDocument(vscode.Uri.file(absolute));
      return undefined;
    });
}
