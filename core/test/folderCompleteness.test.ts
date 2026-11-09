import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FolderReadLedger, MAX_DOCUMENTS_PER_FOLDER, requestedOutputFiles, requestedOutputStems, requiresSourceEvidence, requiresWholeFolder } from '../runtime/folderCompleteness';

// Verbatim C1 prompt from the Build 159 independent audit.
const C1 = "I've put my suppliers' price lists in this folder. Which one is cheapest for basmati rice if I need 20 kg? Write me a short note called rice_order.txt saying who to order from and what it will cost in total.";
const DIR = path.resolve('/ws/c1_suppliers');
// The C1 folder as the audit's re-run listed it (rice_order.txt from an earlier run, the renamed baseline copy).
const C1_LISTING = [
  { name: 'grosshandel_mueller.md', size: 205 },
  { name: 'non_rice_items.txt', size: 68 },
  { name: 'rice_order.audit-baseline.txt', size: 48 },
  { name: 'rice_order.txt', size: 83 },
  { name: 'spice_route.csv', size: 126 },
  { name: 'ulm_asia_markt.txt', size: 200 },
];

describe('requiresWholeFolder', () => {
  it('applies to questions about a folder\'s documents as a set', () => {
    expect(requiresWholeFolder(C1)).toBe(true);
    expect(requiresWholeFolder('Compare all the invoices and tell me the total')).toBe(true);
  });

  it('does not apply to single-file or non-comparative requests', () => {
    expect(requiresWholeFolder('Write a note called todo.txt in this folder')).toBe(false);
    expect(requiresWholeFolder('Read ulm_asia_markt.txt and tell me the rice price')).toBe(false);
    expect(requiresWholeFolder('Which is the capital of France?')).toBe(false);
  });
});

describe('requiresSourceEvidence (M4 fresh re-run: invented figures in a "verified" PDF)', () => {
  it('applies when the output is built from a local document the request refers to', () => {
    expect(requiresSourceEvidence('Now turn that catering estimate into a professional one-page PDF report with the revenue, costs and profit. Save it in the same workspace and show me where I can open it.')).toBe(true);
    expect(requiresSourceEvidence('Summarise my price lists into a table')).toBe(true);
  });

  it('does not apply to requests that do not depend on a local document', () => {
    expect(requiresSourceEvidence('Write a short poem about rain')).toBe(false);
    expect(requiresSourceEvidence('Create a reminder for Tuesday at 14:00')).toBe(false);
    expect(requiresSourceEvidence('What is the capital of Australia?')).toBe(false);
    // The document named is the output, not a source.
    expect(requiresSourceEvidence('Write the data file')).toBe(false);
  });
});

describe('FolderReadLedger (C1: task-aware evidence completeness)', () => {
  it('in the C1 re-run, the skipped price list is the relevant evidence still missing', () => {
    const ledger = new FolderReadLedger(C1);
    ledger.noteListed(DIR, C1_LISTING);
    ledger.noteRead(path.join(DIR, 'grosshandel_mueller.md'));
    ledger.noteRead(path.join(DIR, 'ulm_asia_markt.txt'));
    // The requested output (rice_order.txt) and an earlier copy of it are not evidence; the decoy-looking
    // non_rice_items.txt cannot be judged irrelevant without reading it, so it counts.
    expect(ledger.unread().map((f) => path.basename(f))).toEqual(['non_rice_items.txt', 'spice_route.csv']);
    ledger.noteRead(path.join(DIR, 'spice_route.csv'));
    ledger.noteRead(path.join(DIR, 'non_rice_items.txt'));
    expect(ledger.unread()).toEqual([]);
  });

  it('extracts the requested output, never an input file the request names', () => {
    expect(requestedOutputStems(C1)).toEqual(['rice_order']);
    expect(requestedOutputFiles(C1)).toEqual(['rice_order.txt']);
    expect(requestedOutputFiles('Compare offer_a.pdf and offer_b.pdf in this folder and save it as summary.md')).toEqual(['summary.md']);
    expect(requestedOutputFiles('Read ulm_asia_markt.txt and tell me the rice price')).toEqual([]);
  });

  it('never requires images, folders, oversized files, or the file being written', () => {
    const ledger = new FolderReadLedger('Compare the offers in this folder');
    ledger.noteListed(DIR, [
      { name: 'photo.jpg', size: 10 },
      { name: 'archive', isDirectory: true },
      { name: 'huge.csv', size: 50 * 1024 * 1024 },
      { name: 'offer_a.pdf', size: 1000 },
      { name: 'summary.md', size: 10 },
    ]);
    expect(ledger.unread(path.join(DIR, 'summary.md')).map((f) => path.basename(f))).toEqual(['offer_a.pdf']);
    ledger.noteWritten(path.join(DIR, 'summary.md'));
    expect(ledger.unread().map((f) => path.basename(f))).toEqual(['offer_a.pdf']);
  });

  it('a large folder is not read automatically; it is reported as a coverage limit instead', () => {
    const ledger = new FolderReadLedger('Summarise all the reports in this folder');
    ledger.noteListed(DIR, Array.from({ length: MAX_DOCUMENTS_PER_FOLDER + 1 }, (_, i) => ({ name: `r${i}.txt`, size: 10 })));
    expect(ledger.unread()).toEqual([]);
    expect(ledger.oversizedFolders()).toEqual([{ directory: DIR, documents: MAX_DOCUMENTS_PER_FOLDER + 1 }]);
  });

  it('only folders the turn listed are in scope', () => {
    const ledger = new FolderReadLedger(C1);
    expect(ledger.unread()).toEqual([]);
  });
});
