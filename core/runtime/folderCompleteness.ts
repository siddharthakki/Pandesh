/**
 * Task-aware evidence completeness (audit C1).
 *
 * When the person asks a question about a folder's documents as a set ("which of the price lists in this folder is
 * cheapest?"), an answer built from some of them is a wrong answer that happens to look right. The turn keeps a
 * ledger of the documents it discovered (by listing a folder inside the authorized workspace), read, and wrote.
 *
 * Only RELEVANT evidence is required, never "every file everywhere":
 *   - only when the request is about the folder's files as a set (scope + comparison words);
 *   - only folders the turn itself listed (so only what the workspace authorization already let it see);
 *   - only document types (text, tables, PDFs, office files) — no images, archives, binaries;
 *   - not the output the request asks for ("a note called rice_order.txt") or earlier copies of it;
 *   - not files over a size cap, and not at all when a folder holds more documents than a small cap
 *     (reading a large folder is a task of its own; the reply must then state its coverage instead).
 */
import * as path from 'node:path';

const FOLDER_SCOPE = /\b(?:this|the|my|selected|that)\s+folder\b|\b(?:these|those|all\s+(?:of\s+)?(?:the\s+|my\s+)?|every|each)\s*(?:files?|documents?|price\s*lists?|lists?|invoices?|quotes?|offers?|reports?|statements?|receipts?|suppliers?)\b/i;
const ACROSS_FILES = /\b(?:which(?:\s+one)?|compare|comparison|cheapest|cheaper|best|lowest|highest|most|least|all|every|each|total|sum|summari[sz]e|overview|rank|differences?)\b/i;

/** The request is about the folder's documents as a set, so every relevant one has to be examined. */
export function requiresWholeFolder(requestText: string): boolean {
  return FOLDER_SCOPE.test(requestText) && ACROSS_FILES.test(requestText);
}

const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.pdf', '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.html', '.htm']);
export const MAX_DOCUMENTS_PER_FOLDER = 12;
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** A file the request asks to PRODUCE: "a note called rice_order.txt", "save it as summary.md". Input files are not matched. */
const OUTPUT_FILE = /\b(?:called|named|save[sd]?\s+(?:it\s+|this\s+|that\s+)?(?:as|to|into)|write\s+(?:it\s+)?(?:to|into))\s+[`"']?([\w-]+(?:\.[\w-]+)*\.(?:md|markdown|txt|csv|tsv|json|pdf|docx?|odt|rtf|xlsx?|ods|html?))\b/gi;

export function requestedOutputFiles(requestText: string): string[] {
  return [...new Set([...requestText.matchAll(OUTPUT_FILE)].map((m) => m[1]))];
}

const key = (file: string) => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Stems of the files the request asks to produce ("rice_order" for "a note called rice_order.txt"). */
export function requestedOutputStems(requestText: string): string[] {
  return requestedOutputFiles(requestText).map((name) => name.toLowerCase().split('.')[0]);
}

export interface ListedEntry { name: string; size?: number; isDirectory?: boolean }

export class FolderReadLedger {
  private readonly listed = new Map<string, string[]>();
  private readonly skippedFolders = new Map<string, number>();
  private readonly read = new Set<string>();
  private readonly written = new Set<string>();
  private readonly writtenPaths = new Map<string, string>();
  private readonly outputStems: string[];

  constructor(requestText = '') {
    this.outputStems = requestedOutputStems(requestText);
  }

  noteListed(directory: string, entries: ListedEntry[]): void {
    const documents = entries.filter((entry) => (
      !entry.isDirectory
      && DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      && !(typeof entry.size === 'number' && entry.size > MAX_DOCUMENT_BYTES)
      && !this.outputStems.includes(entry.name.toLowerCase().split('.')[0])
    ));
    if (documents.length > MAX_DOCUMENTS_PER_FOLDER) {
      this.skippedFolders.set(directory, documents.length);
      this.listed.set(key(directory), []);
      return;
    }
    this.listed.set(key(directory), documents.map((entry) => path.join(directory, entry.name)));
  }

  noteRead(file: string): void { this.read.add(key(file)); }

  hasListed(directory: string): boolean { return this.listed.has(key(directory)); }

  noteWritten(file: string): void { this.written.add(key(file)); this.writtenPaths.set(key(file), path.resolve(file)); }

  writtenFiles(): string[] { return [...this.writtenPaths.values()]; }

  /** Relevant documents that were neither read nor written by this turn (the target of a pending write excluded). */
  unread(except?: string): string[] {
    const skip = except ? key(except) : null;
    const out: string[] = [];
    for (const files of this.listed.values()) {
      for (const file of files) {
        const k = key(file);
        if (k !== skip && !this.read.has(k) && !this.written.has(k)) out.push(file);
      }
    }
    return out;
  }

  /** Folders whose documents were too many to require; the answer must say it did not examine them all. */
  oversizedFolders(): Array<{ directory: string; documents: number }> {
    return [...this.skippedFolders].map(([directory, documents]) => ({ directory, documents }));
  }
}

export function unreadFilesNotice(unread: string[]): string {
  return unread.map((file) => path.basename(file)).join(', ');
}
