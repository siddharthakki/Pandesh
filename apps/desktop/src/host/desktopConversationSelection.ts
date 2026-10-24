import * as fs from 'node:fs';
import * as path from 'node:path';

/** Jarvis Conversations rail Checkpoint 1 — persists which conversation is
 * selected so it restores across a Desktop restart. Mirrors
 * `desktopModelSelection.ts`'s exact shape/location convention: a small JSON
 * file in the same operator data directory, read on startup, written on
 * every explicit selection change. Core's `conversations` table remains the
 * single source of truth for the conversation itself — this file stores only
 * a pointer to it. */

export interface DesktopSelectedConversation {
  conversationId: string;
  updatedAt: string;
}

export function selectedConversationFile(dataDir: string): string {
  return path.join(dataDir, 'selected-conversation.json');
}

export function readSelectedConversation(dataDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(selectedConversationFile(dataDir), 'utf8')) as DesktopSelectedConversation;
    if (typeof raw.conversationId === 'string' && raw.conversationId.trim()) return raw.conversationId.trim();
  } catch {
    // missing selection is fine — falls back to normal lazy-create-on-submit behavior
  }
  return null;
}

export function writeSelectedConversation(dataDir: string, conversationId: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(selectedConversationFile(dataDir), `${JSON.stringify({
    conversationId,
    updatedAt: new Date().toISOString(),
  } satisfies DesktopSelectedConversation, null, 2)}\n`, 'utf8');
}

export function clearSelectedConversation(dataDir: string): void {
  try {
    fs.rmSync(selectedConversationFile(dataDir));
  } catch {
    // already absent is fine
  }
}
