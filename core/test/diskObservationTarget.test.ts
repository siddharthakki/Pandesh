import { describe, it, expect } from 'vitest';
import { readCoversRequestedTarget, requestedDiskTargets } from '../runtime/assistantStatus';

/**
 * Build 170 R02 follow-up: a successful read of an UNRELATED path must not justify an answer about the folder the
 * question names ("how many files are in rw/inbox" answered after reading docs/notes.txt).
 */
describe('disk observation must cover the requested target', () => {
  const q = 'How many files are in the rw/inbox folder?';
  it('extracts the named path', () => {
    expect(requestedDiskTargets(q)).toContain('rw/inbox');
    expect(requestedDiskTargets('what is in C:\\Temp\\Reports?')).toContain('c:/temp/reports');
    expect(requestedDiskTargets('Is there a notes.txt in docs?')).toContain('notes.txt');
    expect(requestedDiskTargets('How many files are in the Reports folder?')).toContain('reports');
  });
  it('rejects a read of an unrelated path', () => {
    expect(readCoversRequestedTarget(q, [{ dirPath: 'C:\\ws\\docs' }])).toBe(false);
    expect(readCoversRequestedTarget(q, [{ filePath: 'C:\\ws\\docs\\notes.txt' }])).toBe(false);
    expect(readCoversRequestedTarget(q, [{ dirPath: 'C:\\ws\\rw\\inbox-old' }])).toBe(false);
  });
  it('accepts a read of the requested folder, in either slash style, or a child of it', () => {
    expect(readCoversRequestedTarget(q, [{ dirPath: 'C:\\ws\\rw\\inbox' }])).toBe(true);
    expect(readCoversRequestedTarget(q, [{ dirPath: 'C:/ws/rw/inbox/' }])).toBe(true);
    expect(readCoversRequestedTarget(q, [{ path: 'C:/ws/RW/Inbox/a.txt' }])).toBe(true);
  });
  it('demands nothing specific when the request names no target', () => {
    expect(readCoversRequestedTarget('How many files are there?', [{ dirPath: 'C:\\anything' }])).toBe(true);
  });
});
