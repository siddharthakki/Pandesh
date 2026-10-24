import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads a stylesheet with its relative `@import url('./x.css')` rules inlined, in import order, the way the
 * webview's effective stylesheet is assembled. `media/chat-layout-fixes.css` became an import shim over
 * `chat-layout-base.css` and `chat-governed-neon.css`; static CSS assertions (and jsdom, which does not resolve
 * imports) must look at the resolved text, not the shim. Only local relative imports are followed.
 */
export function readResolvedCss(file: string, seen: Set<string> = new Set()): string {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return '';
  seen.add(resolved);
  const source = fs.readFileSync(resolved, 'utf8');
  return source.replace(/@import\s+url\(\s*['"]?(\.[^'")]+)['"]?\s*\)\s*;/g, (_match, target: string) =>
    readResolvedCss(path.resolve(path.dirname(resolved), target), seen));
}
