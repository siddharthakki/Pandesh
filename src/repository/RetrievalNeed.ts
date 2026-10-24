/**
 * "Does this objective need repository retrieval at all?" — a pure, conservative decision.
 *
 * A request like "create notes.md, todo.md and plan.md with these contents" already names every target and depends on
 * nothing in the repository. Running host retrieval for it only drags unrelated files into the evidence (and the
 * approval card). Retrieval is skipped ONLY when the objective explicitly names the files to create, uses a creation
 * verb, shows no sign of depending on existing code, and none of the named files already exists. Anything else keeps
 * the normal retrieval path.
 */
export interface RetrievalNeed {
  needed: boolean;
  reason: 'explicit_new_files' | 'default';
  /** Files the objective names (workspace-relative as written). */
  targets: string[];
  /** Why retrieval stays on, when it does. */
  detail?: string;
}

const FILE_TOKEN = /(?<![\w@/])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w-])/g;
const NON_FILE_SUFFIX = /\.(?:com|org|net|io|dev|ai|app|co|edu|gov|ly|me|us|uk)$/i;
const CREATE_VERB = /\b(?:create|write|add|make|generate|scaffold|produce|build|save|put)\b/i;
const EXISTING_CODE_SIGNAL =
  /\b(?:update|modify|change|edit|fix|refactor|rename|extend|existing|current|already|in (?:the|this|my) (?:repo|repository|codebase|project|code|app|workspace)|use (?:the|our)|based on|following (?:the )?(?:existing|same)|like (?:the )?(?:existing|other)|integrate|wire (?:it )?up|hook (?:it )?up|import(?:s|ing)? (?:from|the)|call(?:s|ing)? (?:the|our)|refer(?:s|ring)? to|match(?:es|ing)? (?:the|our)|consistent with|similar to)\b/i;
// A bare camelCase / snake_case identifier or a Class-like name points at code that lives in the repository.
const CODE_IDENTIFIER = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+_[a-z0-9_]+\(/;

export function extractNamedFiles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_TOKEN)) {
    const token = match[1].replace(/^\.\//, '');
    if (NON_FILE_SUFFIX.test(token) || /^\d+(?:\.\d+)+$/.test(token) || /^v?\d/.test(token)) continue;
    if (!seen.has(token.toLowerCase())) { seen.add(token.toLowerCase()); out.push(token); }
  }
  return out;
}

export function assessRetrievalNeed(text: string, options: { fileExists?: (relPath: string) => boolean } = {}): RetrievalNeed {
  const targets = extractNamedFiles(text);
  if (targets.length === 0) return { needed: true, reason: 'default', targets, detail: 'no explicit files named' };
  if (!CREATE_VERB.test(text)) return { needed: true, reason: 'default', targets, detail: 'no creation intent' };
  if (EXISTING_CODE_SIGNAL.test(text)) return { needed: true, reason: 'default', targets, detail: 'the request refers to existing code' };
  // Identifier-like tokens that are not themselves one of the named files point into the repository.
  const withoutFiles = targets.reduce((acc, file) => acc.split(file).join(' '), text);
  if (CODE_IDENTIFIER.test(withoutFiles)) return { needed: true, reason: 'default', targets, detail: 'the request names code identifiers' };
  if (options.fileExists) {
    const existing = targets.filter(file => options.fileExists!(file));
    if (existing.length > 0) return { needed: true, reason: 'default', targets, detail: `${existing.join(', ')} already exist(s)` };
  }
  return { needed: false, reason: 'explicit_new_files', targets };
}
