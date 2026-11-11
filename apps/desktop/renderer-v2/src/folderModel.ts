/**
 * What the v2 window says about the workspace folder: the chip under the message box, its menu, and the card that asks
 * before a folder becomes the workspace. Pure functions over the host snapshot, shared by FolderControl and the tests.
 * The host checks and stores the choice (apps/desktop/src/host/workspaceAccess.ts); Core enforces a read-only folder.
 */

export type WorkspaceAccess = 'read' | 'read_write';

export interface WorkspaceView {
  folder: string;
  access: WorkspaceAccess;
  grantedAt: string | null;
  source: 'picker' | 'chat' | 'recent' | 'earlier_build';
}
export interface RecentWorkspace { folder: string; access: WorkspaceAccess; lastUsedAt: string }
export interface FolderCheck {
  folder: string;
  state: 'ok' | 'missing' | 'not_a_folder' | 'refused' | 'unreadable';
  reason?: string;
  warning?: string;
  readable: boolean;
  writable: boolean;
}
export interface FolderMention { folder: string; spelled: string; check: FolderCheck; rememberedAccess: WorkspaceAccess | null }

/** A folder waiting for the person's answer: from the menu (no message) or named in a message that is held until then. */
export interface FolderProposal {
  folder: string;
  check: FolderCheck;
  source: 'picker' | 'chat' | 'recent';
  /** The held message (chat only): sent after the answer, or put back in the message box on Cancel. */
  message?: string;
  voiceTurnId?: string;
  read: boolean;
  write: boolean;
}

/** The last part of a path ("site-builder"), or the drive for a drive root ("D:"). */
export function folderName(folder: string): string {
  const trimmed = String(folder ?? '').replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : trimmed || folder;
}

export const ACCESS_LABEL: Record<WorkspaceAccess, string> = { read: 'Read only', read_write: 'Read and write' };

export function accessSentence(access: WorkspaceAccess): string {
  return access === 'read'
    ? 'Pandesh can open, list and search the files here. It does not change anything or run programs here.'
    : 'Pandesh can read the files here and ask to change them. Each change is shown to you for approval first.';
}

/** The chip under the message box: the folder's name, and whether it is read-only. */
export function folderChip(workspace: WorkspaceView | null | undefined): { label: string; title: string; readOnly: boolean } {
  if (!workspace) return { label: 'No folder', title: 'No workspace folder: Pandesh can chat, but cannot open your files. Choose a folder.', readOnly: false };
  const readOnly = workspace.access === 'read';
  return {
    label: readOnly ? `${folderName(workspace.folder)} · read only` : folderName(workspace.folder),
    title: `Workspace: ${workspace.folder} (${ACCESS_LABEL[workspace.access].toLowerCase()}). Click to change.`,
    readOnly,
  };
}

/** One line about where the current access came from, when it is worth saying. */
export function grantNote(workspace: WorkspaceView | null | undefined): string | null {
  if (!workspace) return null;
  if (workspace.source === 'earlier_build') return 'Chosen in an earlier version of Pandesh, where every folder got read and write access. Choose again to decide.';
  return null;
}

/** Recent folders for the menu: newest first, without the current one. */
export function recentChoices(recent: RecentWorkspace[] | null | undefined, current: WorkspaceView | null | undefined): RecentWorkspace[] {
  const key = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  return (recent ?? []).filter((r) => !current || key(r.folder) !== key(current.folder));
}

/**
 * The card for a folder: Read is on (a workspace needs it), Write starts as the person last chose for this folder,
 * otherwise off: Pandesh asks for the least it needs and the person adds Write.
 */
export function proposalFor(check: FolderCheck, source: FolderProposal['source'], remembered: WorkspaceAccess | null, held?: { message: string; voiceTurnId?: string }): FolderProposal {
  return {
    folder: check.folder,
    check,
    source,
    ...(held ? { message: held.message, ...(held.voiceTurnId ? { voiceTurnId: held.voiceTurnId } : {}) } : {}),
    read: true,
    write: remembered === 'read_write',
  };
}

/** What the card's buttons say: the main one sends the held message too; the second sends it without the folder. */
export function proposalActions(p: FolderProposal): { use: string; skip: string | null; cancel: string } {
  const usable = p.check.state === 'ok';
  if (p.message) return { use: usable ? 'Use this folder and send' : '', skip: 'Send without it', cancel: 'Edit message' };
  return { use: usable ? 'Use this folder' : '', skip: null, cancel: usable ? 'Cancel' : 'OK' };
}

/** Why the main button is off, or null when it may be pressed. */
export function proposalProblem(p: FolderProposal): string | null {
  if (p.check.state !== 'ok') return p.check.reason ?? 'Pandesh cannot use this folder.';
  if (!p.read) return 'Pandesh needs Read to use a folder. Untick Write instead to keep it read-only.';
  return null;
}
