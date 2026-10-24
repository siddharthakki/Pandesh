/**
 * User-driven provider connection helpers.
 *
 * KarkeDikha only opens a provider's own API-keys page and lets the person sign in and copy a key
 * themselves. It never reads cookies, sessions, password fields, page DOM or tokens, and the
 * clipboard is read only inside an explicit "Paste from clipboard" click — never monitored.
 */
import * as vscode from 'vscode';
import type { ProviderDescriptor } from '../../core/platform/providerCatalog';

export type OpenKeysMode = 'vscode' | 'external';
export type OpenKeysResult = { opened: 'vscode-simple-browser' | 'external'; url: string } | { opened: 'failed'; url: string; reason: string };

/** Only pages named by the catalog descriptor can be opened; arbitrary URLs never pass through here. */
export function providerKeysUrl(descriptor: Pick<ProviderDescriptor, 'apiKeysUrl' | 'signupUrl'>): string {
  const url = descriptor.apiKeysUrl || descriptor.signupUrl;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Provider pages must use https.');
  return parsed.toString();
}

/**
 * Prefers VS Code's built-in Simple Browser. It cannot report that a site refuses to render in
 * a frame, so the Connect panel always offers "Open externally" next to it; a missing Simple
 * Browser command or a thrown error falls back to the system browser here.
 */
export async function openProviderKeysPage(
  descriptor: Pick<ProviderDescriptor, 'apiKeysUrl' | 'signupUrl'>,
  mode: OpenKeysMode,
): Promise<OpenKeysResult> {
  let url: string;
  try {
    url = providerKeysUrl(descriptor);
  } catch (error) {
    return { opened: 'failed', url: '', reason: error instanceof Error ? error.message : String(error) };
  }
  if (mode === 'vscode') {
    try {
      await vscode.commands.executeCommand('simpleBrowser.show', url);
      return { opened: 'vscode-simple-browser', url };
    } catch {
      // Fall through to the system browser.
    }
  }
  try {
    const ok = await vscode.env.openExternal(vscode.Uri.parse(url));
    return ok ? { opened: 'external', url } : { opened: 'failed', url, reason: 'The system browser did not open the page.' };
  } catch (error) {
    return { opened: 'failed', url, reason: error instanceof Error ? error.message : String(error) };
  }
}

const MAX_PASTED_KEY_CHARS = 512;

/**
 * One explicit clipboard read, triggered by a user click. Returns the trimmed text only when it
 * looks like a single API key; otherwise explains why, without echoing the clipboard content.
 */
export async function readKeyFromClipboardOnClick(): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  const text = (await vscode.env.clipboard.readText()).trim();
  if (!text) return { ok: false, reason: 'The clipboard is empty.' };
  if (text.length > MAX_PASTED_KEY_CHARS || /\s/.test(text)) {
    return { ok: false, reason: 'The clipboard does not contain a single API key, so nothing was pasted.' };
  }
  return { ok: true, key: text };
}
