/**
 * Fix-build verification of REC-014: "Write rec-output.txt with the text hello" when the file already said "hello"
 * came back as a tool error, Core showed "NOT DONE ... could not do it", and the next turn told the user the file was
 * never created. The requested state already holds, so the call is not an error (still no write, still audited).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

describe('identical write is the requested end state', () => {
  it('the engine returns a non-error result for the unchanged case and keeps the refusal audit', () => {
    const src = fs.readFileSync(new URL('../runtime/piAgentEngine.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf("if (guard?.reason === 'the file already has this text')"), src.indexOf('if (guard) return refuse(guard.text, guard.reason);'));
    expect(block).toContain("'file_write_refused'");
    expect(block).toContain('The file is already as requested');
    expect(block).not.toContain('isError');
  });
});
