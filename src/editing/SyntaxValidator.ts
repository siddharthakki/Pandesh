import * as path from 'path';
import { EditDiagnostic } from './EditTypes';

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
}

function lineColumn(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, Math.max(0, offset));
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function validateBalancedDelimiters(content: string): EditDiagnostic[] {
  const diagnostics: EditDiagnostic[] = [];
  const stack: Array<{ char: string; offset: number }> = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (char === '\n') { lineComment = false; }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) { quote = null; }
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '(' || char === '[' || char === '{') {
      stack.push({ char, offset: index });
      continue;
    }
    if (pairs[char]) {
      const opened = stack.pop();
      if (!opened || opened.char !== pairs[char]) {
        const position = lineColumn(content, index);
        diagnostics.push({
          severity: 'error',
          message: `Unmatched closing delimiter ${char}`,
          line: position.line,
          column: position.column,
          source: 'syntax',
        });
        return diagnostics;
      }
    }
  }

  if (quote) {
    diagnostics.push({
      severity: 'error',
      message: `Unterminated string literal ${quote}`,
      source: 'syntax',
    });
  }
  if (blockComment) {
    diagnostics.push({
      severity: 'error',
      message: 'Unterminated block comment',
      source: 'syntax',
    });
  }
  for (const opened of stack.reverse()) {
    const position = lineColumn(content, opened.offset);
    diagnostics.push({
      severity: 'error',
      message: `Unclosed delimiter ${opened.char}`,
      line: position.line,
      column: position.column,
      source: 'syntax',
    });
  }
  return diagnostics;
}

export function validateEditedContent(filePath: string, content: string): EditDiagnostic[] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json' || extension === '.jsonc') {
    try {
      JSON.parse(extension === '.jsonc' ? stripJsonComments(content) : content);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const offsetMatch = message.match(/position\s+(\d+)/i);
      const position = offsetMatch ? lineColumn(content, Number(offsetMatch[1])) : undefined;
      return [{
        severity: 'error',
        message: `Invalid JSON: ${message}`,
        line: position?.line,
        column: position?.column,
        source: 'syntax',
      }];
    }
  }

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.cs', '.go', '.rs'].includes(extension)) {
    return validateBalancedDelimiters(content);
  }
  return [];
}
