import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DesktopLastWorkspace {
  folder: string;
  updatedAt: string;
}

export function lastWorkspaceFile(dataDir: string): string {
  return path.join(dataDir, 'last-workspace.json');
}

export function readLastWorkspace(dataDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lastWorkspaceFile(dataDir), 'utf8')) as DesktopLastWorkspace;
    if (typeof raw.folder === 'string' && raw.folder.trim()) return path.resolve(raw.folder);
  } catch {
    // missing or unreadable cursor is not an error
  }
  return null;
}

export function writeLastWorkspace(dataDir: string, folder: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(lastWorkspaceFile(dataDir), `${JSON.stringify({
    folder: path.resolve(folder),
    updatedAt: new Date().toISOString(),
  } satisfies DesktopLastWorkspace, null, 2)}\n`, 'utf8');
}
