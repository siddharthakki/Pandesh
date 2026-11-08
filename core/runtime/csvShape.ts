/**
 * A CSV the user asked for must open as one table: a header and rows with the same columns (re-run M3: the model
 * wrote "---" separator lines, which a spreadsheet or parser reads as one-column rows). Returns why the text is not
 * such a table, or null when it is. Quoted fields (RFC 4180) may contain commas, quotes and line breaks.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r' && text[i + 1] === '\n') continue;
    if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function csvShapeProblem(text: string): string | null {
  const rows = parseCsvRows(text.replace(/^﻿/, ''));
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].trim() === '') rows.pop();
  if (rows.length === 0) return 'the file has no rows';
  const width = rows[0].length;
  if (width < 2) return `the header row ("${rows[0].join(',').slice(0, 60)}") has only one column`;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].length !== width) {
      const shown = rows[i].join(',').slice(0, 60);
      return `row ${i + 1} ("${shown}") has ${rows[i].length} field${rows[i].length === 1 ? '' : 's'} but the header has ${width}`;
    }
  }
  return null;
}
