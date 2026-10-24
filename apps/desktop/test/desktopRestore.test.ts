import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lastWorkspaceFile, readLastWorkspace, writeLastWorkspace } from '../src/host/desktopSessionCursor';

describe('desktop last-workspace cursor', () => {
  it('persists and reloads the last selected repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-desktop-cursor-'));
    try {
      expect(readLastWorkspace(dir)).toBeNull();
      const folder = path.join(dir, 'repo');
      fs.mkdirSync(folder);
      writeLastWorkspace(dir, folder);
      expect(readLastWorkspace(dir)).toBe(path.resolve(folder));
      expect(fs.existsSync(lastWorkspaceFile(dir))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
