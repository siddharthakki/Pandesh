/**
 * Conversation referent safety. "Explain this project" / "that file" may only resolve to something the conversation
 * actually established (the user named it, or an earlier host answer identified it unambiguously). A retrieval hit is
 * never a referent. Pure; no model involved.
 */

const PROJECT_NOUN = '(?:project|app|application|package|module|service|folder|directory|sub-?project)';

/** "this project", "that app", "the same package", "the previous project". */
export function hasProjectDeixis(question: string): boolean {
  return new RegExp(`\\b(?:this|that|the same|the above|the previous|the aforementioned)\\s+${PROJECT_NOUN}\\b`, 'i').test(String(question ?? ''));
}

/** "that file", "the same file", "the file above". */
export function hasFileDeixis(question: string): boolean {
  return /\b(?:that|the same|the above|the previous|the aforementioned)\s+file\b|\bthe file (?:above|from before|we (?:just )?(?:discussed|looked at))\b/i.test(String(question ?? ''));
}

/**
 * A project the user explicitly named in this very message: its workspace-relative path, or its folder name as a
 * whole word when exactly one project has that name. Returns the deepest/longest unambiguous match.
 */
export function matchNamedProject(question: string, projectPaths: readonly string[]): string | undefined {
  const q = String(question ?? '').toLowerCase().replace(/\\/g, '/');
  const candidates = projectPaths.filter(p => p !== '.');
  const byBase = new Map<string, string[]>();
  for (const p of candidates) {
    const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  const boundary = (needle: string) => new RegExp(`(?:^|[^\\w./-])${needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=$|[^\\w./-])`, 'i');
  const hits: string[] = [];
  for (const p of candidates) {
    if (p.includes('/') && boundary(p.toLowerCase()).test(q)) hits.push(p);
  }
  for (const [base, paths] of byBase) {
    if (base.length >= 3 && paths.length === 1 && boundary(base).test(q)) hits.push(paths[0]);
  }
  const unique = [...new Set(hits)].sort((a, b) => b.length - a.length);
  return unique[0];
}

/** The deterministic clarification the model is told to ask instead of guessing. */
export function clarificationPacket(input: { what: 'project' | 'file'; workspaceName: string; projectCount: number; candidates: readonly string[] }): string {
  const list = input.candidates.length > 0 ? ` Candidates in this workspace include: ${input.candidates.slice(0, 6).map(c => `\`${c}\``).join(', ')}.` : '';
  return `Clarification needed (host decision; no repository content was retrieved). The user's message refers to "this ${input.what}" (or similar), `
    + `but nothing in this conversation has established which ${input.what} that is: none was named in the message, and no earlier answer identified one. `
    + `${input.what === 'project' ? `The workspace "${input.workspaceName}" contains ${input.projectCount} recognised projects.` : `The workspace is "${input.workspaceName}".`}${list} `
    + `Do NOT choose a ${input.what}, do NOT answer about any specific one, and do NOT guess from anything you have seen. `
    + `Reply with ONE short clarifying question asking which ${input.what} they mean. Do not say you lack access to the workspace.`;
}
