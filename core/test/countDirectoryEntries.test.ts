import { describe, expect, it } from 'vitest';
import { countDirectoryEntries } from '../domain/routineWriteGrants';

const f = (name: string) => ({ name, isFile: () => true, isDirectory: () => false });
const d = (name: string) => ({ name, isFile: () => false, isDirectory: () => true });

describe('directory listing counts', () => {
  it('counts visible entries and says how many hidden ones were left out', () => {
    const r = countDirectoryEntries([f('package.json'), f('README.md'), f('.gitignore'), d('.git')]);
    expect(r).toMatchObject({ fileCount: 2, folderCount: 0, hiddenFileCount: 1, hiddenFolderCount: 1 });
    expect(r.countNote).toContain('1 hidden file(s) and 1 hidden folder(s)');
    expect(r.countNote).toContain('never say there is nothing else');
  });

  it('has no hidden warning when nothing is hidden, and counts hidden entries when asked to include them', () => {
    expect(countDirectoryEntries([f('a'), d('b')]).countNote).not.toContain('NOT counted');
    const all = countDirectoryEntries([f('a'), f('.b'), d('.c')], true);
    expect(all).toMatchObject({ fileCount: 2, folderCount: 1, hiddenFileCount: 0, hiddenFolderCount: 0 });
  });
});
