/**
 * Real-world challenge (2026-11-09): regressions for defects seen live in the baseline, with paraphrases so the
 * repair is general rather than tied to one prompt.
 */
import { describe, expect, it } from 'vitest';
import { withholdUnsupportedActionClaims } from '../runtime/actionClaims';

const kinds = (text: string, tools: string[]) => withholdUnsupportedActionClaims(text, tools).withheld.map((w) => w.kind);

describe('claim guard: a nearby word is not the object of the claim', () => {
  it.each([
    // Baseline T3 (memory write mentioning a project).
    ['I have recorded the review meeting for **Project Cedar** on Friday, November 13, 2026, at 10:00 AM in the Blue Room.', ['memory_remember']],
    ['I have saved the details of the Project Cedar review meeting.', ['memory_remember']],
    // Baseline T12 (a report built from meeting notes).
    ['I have created the HTML summary report based on the meeting notes and invoices.', ['read_file', 'write_file']],
    ['I have generated a summary of the meeting decisions and saved it as report.html.', ['write_file']],
    ['I created a dashboard listing your project tasks.', ['write_file']],
  ])('no false withhold: %s', (text, tools) => {
    expect(kinds(text.replace(/\*\*/g, ''), tools as string[])).toEqual([]);
  });

  it.each([
    ['I have scheduled the review meeting for Friday at 10 AM.', 'calendar'],
    ['I have added a new event to your calendar for tomorrow.', 'calendar'],
    ['The meeting has been moved to Monday.', 'calendar'],
    ['I have initiated the creation of the Pandesh Alpha Playground project.', 'project'],
    ['I have created the Home Office project with four tasks.', 'project'],
    ['Your new project has been created.', 'project'],
  ])('still withheld without a tool: %s', (text, kind) => {
    expect(kinds(text, ['read_file'])).toContain(kind);
  });
});
