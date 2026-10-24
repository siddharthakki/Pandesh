export class OutputLimiter {
  static truncate(text: string, maxChars: number, label = 'output'): { text: string; truncated: boolean } {
    if (text.length <= maxChars) {
      return { text, truncated: false };
    }
    const half = Math.floor(maxChars / 2);
    const truncated =
      text.slice(0, half) +
      `\n\n... [${label} truncated: ${text.length} chars total, showing first and last ${half} chars] ...\n\n` +
      text.slice(text.length - half);
    return { text: truncated, truncated: true };
  }

  static truncateLines(lines: string[], maxLines: number): { lines: string[]; truncated: boolean } {
    if (lines.length <= maxLines) {
      return { lines, truncated: false };
    }
    return {
      lines: [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`],
      truncated: true,
    };
  }
}
