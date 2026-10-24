export interface ParsedPatchHunkLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface ParsedPatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedPatchHunkLine[];
}

export interface ParsedFilePatch {
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedPatchHunk[];
}

export class PatchParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line ? `${message} at patch line ${line}` : message);
    this.name = 'PatchParseError';
  }
}

function normalizePatchPath(raw: string): string | null {
  const value = raw.trim().split(/\s+/)[0];
  if (value === '/dev/null') { return null; }
  if (value.startsWith('a/') || value.startsWith('b/')) { return value.slice(2); }
  return value;
}

export function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | undefined;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('--- ')) {
      const next = lines[index + 1];
      if (!next?.startsWith('+++ ')) {
        throw new PatchParseError('Expected +++ file header after --- header', index + 2);
      }
      current = {
        oldPath: normalizePatchPath(line.slice(4)),
        newPath: normalizePatchPath(next.slice(4)),
        hunks: [],
      };
      if (!current.oldPath && !current.newPath) {
        throw new PatchParseError('Patch cannot use /dev/null for both paths', index + 1);
      }
      files.push(current);
      index += 2;
      continue;
    }

    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      if (!current) {
        throw new PatchParseError('Hunk appears before file header', index + 1);
      }
      const hunk: ParsedPatchHunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      index += 1;
      while (index < lines.length) {
        const body = lines[index];
        if (body.startsWith('@@ ') || body.startsWith('--- ') || body.startsWith('diff --git ')) {
          break;
        }
        if (body === '\\ No newline at end of file') {
          index += 1;
          continue;
        }
        const marker = body[0];
        if (marker === ' ') {
          hunk.lines.push({ kind: 'context', text: body.slice(1) });
        } else if (marker === '+') {
          hunk.lines.push({ kind: 'add', text: body.slice(1) });
        } else if (marker === '-') {
          hunk.lines.push({ kind: 'remove', text: body.slice(1) });
        } else if (body === '' && index === lines.length - 1) {
          break;
        } else {
          throw new PatchParseError(`Invalid hunk line prefix: ${marker || '<empty>'}`, index + 1);
        }
        index += 1;
      }
      const oldActual = hunk.lines.filter(item => item.kind !== 'add').length;
      const newActual = hunk.lines.filter(item => item.kind !== 'remove').length;
      if (oldActual !== hunk.oldCount) {
        throw new PatchParseError(
          `Hunk old-count mismatch: header=${hunk.oldCount}, body=${oldActual}`,
          index + 1,
        );
      }
      if (newActual !== hunk.newCount) {
        throw new PatchParseError(
          `Hunk new-count mismatch: header=${hunk.newCount}, body=${newActual}`,
          index + 1,
        );
      }
      current.hunks.push(hunk);
      continue;
    }
    index += 1;
  }

  if (files.length === 0) {
    throw new PatchParseError('Patch contains no file sections');
  }
  for (const file of files) {
    if (file.hunks.length === 0) {
      throw new PatchParseError(`Patch for ${file.newPath ?? file.oldPath} has no hunks`);
    }
    let previousEnd = 0;
    for (const hunk of file.hunks) {
      const start = Math.max(0, hunk.oldStart - 1);
      if (start < previousEnd) {
        throw new PatchParseError(`Overlapping hunks for ${file.newPath ?? file.oldPath}`);
      }
      previousEnd = start + hunk.oldCount;
    }
  }
  return files;
}

export interface AppliedPatchContent {
  content: string;
  hunkRanges: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }>;
}

export function applyParsedPatch(original: string, filePatch: ParsedFilePatch): AppliedPatchContent {
  const hadFinalNewline = original.endsWith('\n');
  const originalLines = original.length === 0
    ? []
    : original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of filePatch.hunks) {
    const expectedStart = Math.max(0, hunk.oldStart - 1);
    if (expectedStart < sourceIndex) {
      throw new PatchParseError('Overlapping or out-of-order hunk application');
    }
    output.push(...originalLines.slice(sourceIndex, expectedStart));
    let cursor = expectedStart;

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push(line.text);
        continue;
      }
      const actual = originalLines[cursor];
      if (actual !== line.text) {
        throw new PatchParseError(
          `Stale patch context at source line ${cursor + 1}: expected ${JSON.stringify(line.text)}, got ${JSON.stringify(actual)}`,
        );
      }
      if (line.kind === 'context') { output.push(actual); }
      cursor += 1;
    }
    sourceIndex = cursor;
  }

  output.push(...originalLines.slice(sourceIndex));
  let content = output.join('\n');
  if (hadFinalNewline || original.length === 0) { content += '\n'; }
  return {
    content,
    hunkRanges: filePatch.hunks.map(hunk => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
    })),
  };
}
