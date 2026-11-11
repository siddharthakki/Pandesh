import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROJECT_NOTES_MAX_CHARS, formatProjectNotesSection, readProjectNotes } from '../runtime/projectNotes';

describe('project notes (AGENTS.md / CLAUDE.md in the selected folder)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-notes-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads AGENTS.md first, then CLAUDE.md, and nothing when neither exists', () => {
    expect(readProjectNotes(dir)).toBeNull();
    expect(readProjectNotes(null)).toBeNull();
    expect(readProjectNotes(path.join(dir, 'missing'))).toBeNull();

    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude notes\nRun `npm test`.\n');
    expect(readProjectNotes(dir)).toEqual({ file: 'CLAUDE.md', text: '# Claude notes\nRun `npm test`.', truncated: false });

    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '﻿# Agents\r\nUse pytest -q.\r\n');
    expect(readProjectNotes(dir)).toEqual({ file: 'AGENTS.md', text: '# Agents\nUse pytest -q.', truncated: false });
  });

  it('skips an empty file and a folder of the same name', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '   \n');
    fs.mkdirSync(path.join(dir, 'CLAUDE.md'));
    expect(readProjectNotes(dir)).toBeNull();
  });

  it('keeps long notes within the budget, at a line break, and says where the rest is', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- rule ${i}: keep functions small and test every change`);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), lines.join('\n'));
    const notes = readProjectNotes(dir)!;
    expect(notes.truncated).toBe(true);
    expect(notes.text.length).toBeLessThanOrEqual(PROJECT_NOTES_MAX_CHARS);
    expect(notes.text.endsWith('test every change')).toBe(true);
    const section = formatProjectNotesSection(notes);
    expect(section).toContain('PROJECT NOTES (AGENTS.md');
    expect(section).toContain('not permissions');
    expect(section).toContain('read it with read_file');
  });

  it('reads at most 64 KB of a huge file', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x'.repeat(5 * 1024 * 1024));
    const notes = readProjectNotes(dir)!;
    expect(notes.truncated).toBe(true);
    expect(notes.text.length).toBe(PROJECT_NOTES_MAX_CHARS);
  });
});
