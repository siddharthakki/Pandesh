/**
 * Recent artifact / file referent continuation (host side).
 *
 * Live UAT: Saath created uat-m51-multifile/weather.html; the next turn, "add a login page to this html", retrieved an
 * unrelated OnboardingView.ts, because "this html" was resolved by repository search instead of by what the conversation just
 * produced. The authoritative result of the previous turn (its TaskResult artifacts: real paths verified on disk) is the
 * referent of "this html", "that file", "it", "the page", "modify it".
 *
 * Rules:
 *  - the book holds only authoritative artifacts (assembled from Core/host evidence, never from model prose);
 *  - a unique recent artifact binds without asking; genuine ambiguity asks once; an explicit path in the message wins over any
 *    pronoun;
 *  - a bound referent replaces broad retrieval: the pack is that file, whole when it fits the budget;
 *  - scope is one conversation: New Chat clears it, History reopen never reactivates it, and a file that no longer exists on
 *    disk is dropped rather than bound.
 *
 * Pure apart from the optional filesystem reader passed to the pack builder.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Artifact, TaskResult } from '../../core/platform/artifacts/taskResult';

export interface RecentArtifact {
  /** Workspace-relative path with forward slashes. */
  path: string;
  type: Artifact['type'];
  title: string;
  hash?: string;
  origin: { taskId: string; surface: 'saath_kar' | 'karke_dikha' };
  /** Monotonic: artifacts of the same task share it, later tasks have a larger one. */
  sequence: number;
}

export type ReferentResolution =
  | { status: 'none' }
  | { status: 'bound'; artifact: RecentArtifact; phrase: string }
  | { status: 'ambiguous'; candidates: RecentArtifact[]; phrase: string };

const MAX_RECENT_ARTIFACTS = 8;

const TYPE_WORDS: Array<{ words: RegExp; test: (artifact: RecentArtifact) => boolean }> = [
  { words: /^(?:html?|web\s?page|webpage|page|site|website|web\s?app)$/i, test: a => a.type === 'html' || /\.html?$/i.test(a.path) },
  { words: /^(?:css|stylesheet|style\s?sheet)$/i, test: a => /\.css$/i.test(a.path) },
  { words: /^(?:js|javascript|script)$/i, test: a => /\.(?:m?js|cjs)$/i.test(a.path) },
  { words: /^(?:ts|typescript)$/i, test: a => /\.tsx?$/i.test(a.path) },
  { words: /^(?:py|python)$/i, test: a => /\.py$/i.test(a.path) },
  { words: /^(?:json)$/i, test: a => a.type === 'json' || /\.json$/i.test(a.path) },
  { words: /^(?:markdown|md|readme)$/i, test: a => a.type === 'markdown' || /\.(?:md|markdown)$/i.test(a.path) },
  { words: /^(?:svg)$/i, test: a => a.type === 'svg' || /\.svg$/i.test(a.path) },
  { words: /^(?:csv|spreadsheet|table)$/i, test: a => a.type === 'table' || /\.(?:csv|tsv)$/i.test(a.path) },
  { words: /^(?:image|picture|png|jpe?g)$/i, test: a => a.type === 'image' },
];

const DETERMINER = '(?:this|that|the|my|our|the\\s+same|the\\s+new|the\\s+above|the\\s+generated|the\\s+created|the\\s+latest|the\\s+last)';
const TYPED_REFERENT = new RegExp(`\\b${DETERMINER}\\s+(?:new\\s+|generated\\s+|created\\s+)?(html?|web\\s?page|webpage|page|site|website|web\\s?app|css|stylesheet|style\\s?sheet|js|javascript|script|ts|typescript|py|python|json|markdown|md|readme|svg|csv|spreadsheet|table|image|picture|png|jpe?g|file|document|doc)\\b`, 'i');
const PRONOUN_REFERENT = /\b(?:it|this|that)\b/i;
const REFERRING_VERB = /\b(?:add|change|modify|update|edit|fix|make|remove|delete|rename|style|refactor|rewrite|improve|extend|tweak|adjust|redo|rework|enhance|open|show|preview|run|check|review|explain|describe|continue|finish|complete|append|insert|replace|move|translate|convert)\b/i;
const EXPLICIT_PATH = /(?:^|[\s"'`(])((?:[A-Za-z]:)?[\w@.\-/\\]*[\w@\-]\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s"'`),.;:!?])/g;

/** True when the message names a file itself: an explicit path beats any pronoun. */
export function namesExplicitFile(text: string): boolean {
  EXPLICIT_PATH.lastIndex = 0;
  for (const match of String(text ?? '').matchAll(EXPLICIT_PATH)) {
    const token = match[1];
    if (/^\d+\.\d+$/.test(token) || /^(?:e\.g|i\.e)\.?$/i.test(token) || /^https?:/i.test(token)) continue;
    if (/\.(?:com|org|net|io|dev|ai)$/i.test(token)) continue;
    return true;
  }
  return false;
}

function normalizePath(raw: string): string {
  return String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export class RecentArtifactBook {
  private readonly byConversation = new Map<string, RecentArtifact[]>();
  private readonly seenTasks = new Set<string>();
  private sequence = 0;

  /** Records the artifacts of one finished task. A path recorded again moves to the newest batch. */
  record(conversationId: string, taskId: string, surface: RecentArtifact['origin']['surface'], artifacts: readonly Artifact[]): void {
    if (!conversationId) return;
    // A task result is re-assembled on every status poll; it is one batch, recorded once.
    const seenKey = `${conversationId}
${taskId}`;
    if (this.seenTasks.has(seenKey)) return;
    const usable = artifacts.filter(artifact => artifact.path && !/^(?:[A-Za-z]:|\/)/.test(artifact.path));
    if (usable.length === 0) return;
    this.seenTasks.add(seenKey);
    const sequence = ++this.sequence;
    const paths = new Set(usable.map(artifact => normalizePath(artifact.path!)));
    const kept = (this.byConversation.get(conversationId) ?? []).filter(existing => !paths.has(existing.path));
    const added: RecentArtifact[] = usable.map(artifact => ({
      path: normalizePath(artifact.path!),
      type: artifact.type,
      title: artifact.title,
      ...(artifact.hash ? { hash: artifact.hash } : {}),
      origin: { taskId, surface },
      sequence,
    }));
    this.byConversation.set(conversationId, [...kept, ...added].slice(-MAX_RECENT_ARTIFACTS));
  }

  recordResult(conversationId: string, taskId: string, surface: RecentArtifact['origin']['surface'], result: Pick<TaskResult, 'artifacts'>): void {
    this.record(conversationId, taskId, surface, result.artifacts);
  }

  list(conversationId: string): RecentArtifact[] {
    return [...(this.byConversation.get(conversationId) ?? [])];
  }

  clear(conversationId?: string): void {
    if (conversationId === undefined) { this.byConversation.clear(); this.seenTasks.clear(); }
    else {
      this.byConversation.delete(conversationId);
      for (const key of [...this.seenTasks]) if (key.startsWith(`${conversationId}
`)) this.seenTasks.delete(key);
    }
  }

  /** Drops artifacts the filesystem no longer has (a deleted or moved file is not a referent). */
  prune(conversationId: string, exists: (relativePath: string) => boolean): void {
    const current = this.byConversation.get(conversationId);
    if (!current) return;
    const live = current.filter(artifact => exists(artifact.path));
    if (live.length === 0) this.byConversation.delete(conversationId);
    else this.byConversation.set(conversationId, live);
  }

  /**
   * What "this html", "that file", "it", "the page" or "modify it" refers to. `none` when the message does not refer to a
   * recent artifact (or names a file itself), `bound` when exactly one fits, `ambiguous` when several do.
   */
  resolve(conversationId: string, text: string): ReferentResolution {
    const artifacts = this.byConversation.get(conversationId) ?? [];
    if (artifacts.length === 0) return { status: 'none' };
    const message = String(text ?? '').trim();
    if (!message || namesExplicitFile(message)) return { status: 'none' };

    const typed = TYPED_REFERENT.exec(message);
    let phrase: string | undefined;
    let predicate: ((artifact: RecentArtifact) => boolean) | undefined;
    if (typed) {
      phrase = typed[0].trim();
      const word = typed[1].toLowerCase();
      predicate = TYPE_WORDS.find(entry => entry.words.test(word))?.test; // 'file' / 'document' have no type: any artifact
    } else if (PRONOUN_REFERENT.test(message) && REFERRING_VERB.test(message)) {
      const pronoun = PRONOUN_REFERENT.exec(message)!;
      // A pronoun only refers to the artifact when it is the object of the request: short, directive messages.
      if (message.length > 160) return { status: 'none' };
      phrase = pronoun[0];
    }
    if (!phrase) return { status: 'none' };

    const newest = Math.max(...artifacts.map(artifact => artifact.sequence));
    const latestBatch = artifacts.filter(artifact => artifact.sequence === newest);
    const pick = (pool: RecentArtifact[]): RecentArtifact[] => (predicate ? pool.filter(predicate) : pool);
    let candidates = pick(latestBatch);
    if (candidates.length === 0 && predicate) candidates = pick(artifacts);
    if (candidates.length === 0) return { status: 'none' };
    const distinct = [...new Map(candidates.map(artifact => [artifact.path, artifact])).values()];
    return distinct.length === 1
      ? { status: 'bound', artifact: distinct[0], phrase }
      : { status: 'ambiguous', candidates: distinct, phrase };
  }
}

export function ambiguousReferentQuestion(candidates: readonly RecentArtifact[]): string {
  const names = candidates.slice(0, 5).map(candidate => candidate.path);
  return `Which file do you mean: ${names.join(', ')}? Name it and I'll continue with that one.`;
}

export interface ArtifactPack {
  prompt: string;
  selectedFiles: Array<{ path: string; estimatedTokens: number; complete: boolean }>;
  estimatedTokens: number;
  packageHash: string;
}

const CHARS_PER_TOKEN = 4;

/**
 * The context pack for a bound referent: that one file, whole when it fits `budgetChars`, otherwise its head with an explicit
 * statement of what is missing. No retrieval is involved. Returns undefined when the file cannot be read under the workspace.
 */
export function buildArtifactPack(input: {
  workspaceRoot: string;
  artifact: RecentArtifact;
  phrase: string;
  budgetChars: number;
  readText?: (absolutePath: string) => string | undefined;
}): ArtifactPack | undefined {
  const absolute = path.resolve(input.workspaceRoot, input.artifact.path);
  const relative = path.relative(path.resolve(input.workspaceRoot), absolute);
  if (!input.artifact.path || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  let text: string | undefined;
  try {
    text = (input.readText ?? (file => (fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : undefined)))(absolute);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const header = [
    `Referent resolved by the host from this conversation's own results (not a guess): the user's "${input.phrase}" is ${input.artifact.path}, produced earlier in this conversation.`,
    'Treat it as the primary target of this request. Do not search the repository for another file unless the user asks for one.',
  ].join('\n');
  const open = `----- BEGIN ${input.artifact.path} (${total} lines, sha256 ${sha.slice(0, 12)}) -----`;
  const close = `----- END ${input.artifact.path} -----`;
  const overhead = header.length + open.length + close.length + 260;
  const room = Math.max(2_000, Math.min(input.budgetChars, 90_000) - overhead);

  let included = lines;
  let complete = true;
  if (text.length > room) {
    let chars = 0;
    let count = 0;
    for (const line of lines) {
      if (count > 0 && chars + line.length + 1 > room) break;
      chars += line.length + 1;
      count += 1;
    }
    included = lines.slice(0, count);
    complete = false;
  }
  const note = complete
    ? ''
    : `\n[Only lines 1-${included.length} of ${total} are included. Use read_file with startLine=${included.length + 1} to read the rest, and propose_text_edit with an anchor taken from the lines you have seen.]`;
  const prompt = `${header}\n${open}\n${included.join('\n')}\n${close}${note}`;
  const estimatedTokens = Math.min(65_536, Math.ceil(prompt.length / CHARS_PER_TOKEN));
  return {
    prompt,
    selectedFiles: [{ path: input.artifact.path, estimatedTokens, complete }],
    estimatedTokens,
    packageHash: crypto.createHash('sha256').update(prompt, 'utf8').digest('hex'),
  };
}
