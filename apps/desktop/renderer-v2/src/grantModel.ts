/** Standing write permission as the owner sees it: pure text and decisions, no I/O (tested in apps/desktop/test). */
export interface GrantRow {
  taskId: string; title: string; instruction: string; dailyTime: string | null; folder: string; access: string | null; grantable: boolean;
  status: 'none' | 'active' | 'stale';
  active: { id: string; grantedAt: string; frozen: { operations?: string[]; limits?: Record<string, number> } } | null;
}
export interface GrantCatalog { routines: GrantRow[]; operations: string[]; caps: Record<string, number>; defaults: Record<string, number> }

export const OPERATION_LABEL: Record<string, string> = { write_file: 'Create or replace a file' };
export const NEVER_COVERED = 'Never covered: shell commands, installing software, deleting files, sending messages, calendar changes, anything outside the folder.';

const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(b % (1024 * 1024) ? 1 : 0)} MB` : `${Math.round(b / 1024)} KB`);
export function describeLimits(l: Record<string, number> | undefined): string {
  if (!l) return 'default limits';
  const parts: string[] = [];
  if (l.maxFiles != null) parts.push(`up to ${l.maxFiles} files per run`);
  if (l.maxBytesPerFile != null) parts.push(`${kb(l.maxBytesPerFile)} per file`);
  if (l.maxTotalBytes != null) parts.push(`${kb(l.maxTotalBytes)} in total`);
  return parts.join(', ') || 'default limits';
}
export function operationsOf(row: GrantRow, cat: GrantCatalog): string[] { return row.active?.frozen.operations ?? cat.operations; }
export function statusLabel(row: GrantRow): { text: string; tone: 'ok' | 'warn' | 'off' } {
  if (!row.grantable) return { text: 'Not available: the routine has no writable folder', tone: 'off' };
  if (row.status === 'active') return { text: 'Standing permission is on', tone: 'ok' };
  if (row.status === 'stale') return { text: 'Permission ended: the routine changed since it was granted. Grant again to renew.', tone: 'warn' };
  return { text: 'No standing permission: each write asks you', tone: 'off' };
}
/** What the owner confirms before Core freezes it. */
export function confirmText(row: GrantRow, cat: GrantCatalog): string[] {
  return [
    `Routine: ${row.title}`,
    `Folder: ${row.folder}`,
    `Allowed: ${cat.operations.map((o) => OPERATION_LABEL[o] ?? o).join(', ')}`,
    `Limits: ${describeLimits(cat.defaults)}`,
    NEVER_COVERED,
    'If the routine, its folder or its model changes, the permission ends and asks again. You can take it back at any time.',
  ];
}
