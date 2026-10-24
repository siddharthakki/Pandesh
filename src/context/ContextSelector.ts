import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { ModelCapabilityRegistry } from '../models/ModelCapabilityRegistry';
import { TokenBudget } from '../models/TokenBudget';
import { REPOSITORY_CONTEXT_MAX_SELECTED_FILES } from '../../core/shared/wireTypes';
import {
  REPOSITORY_CONTEXT_CHARS_PER_TOKEN,
  REPOSITORY_CONTEXT_HARD_MAX_CHARS,
} from './RepositoryContextBudget';
import {
  ContextCandidateReason,
  ContextSelectionRequest,
  RepositoryContextBudgetTelemetry,
  RepositoryContextResult,
  RepositoryFileRecord,
  RepositoryIndexSnapshot,
  SelectedContextFile,
} from './RepositoryTypes';

interface ScoredCandidate {
  file: RepositoryFileRecord;
  score: number;
  reasons: ContextCandidateReason[];
}

const CONTEXT_HEADER = [
  '## Automatically selected repository context',
  'Treat these snippets as context only. Re-read a file before editing and use its returned SHA-256 freshness token.',
].join('\n');

const TRUNCATION_SUFFIX = '\n… [context truncated; use read_file/read_file_range for exact content]';

// Ceiling on the total graph-expansion bonus a single candidate may collect.
// Repository fan-in is unbounded, so an uncapped per-seed bonus let hub files
// with zero query relevance outscore files that matched the query directly.
// One strong path-term match is worth 24, so the whole structural signal is
// held to that: still useful for ordering, never able to beat direct relevance.
const GRAPH_EXPANSION_CAP = 24;

function normalize(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}

function identifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9$]+/g) ?? [];
}

function queryTerms(query: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'make', 'fix',
    'add', 'change', 'update', 'please', 'agent', 'file', 'code', 'implement',
    'where', 'what', 'does', 'how', 'are', 'was', 'were', 'implemented',
  ]);
  return [...new Set(identifierTokens(query)
    .filter(term => term.length >= 3 && !stop.has(term)))]
    .slice(0, 30);
}

function referencedPaths(query: string): string[] {
  const matches = query.match(/(?:[A-Za-z]:[\\/]|\.\.?[\\/]|[\w.-]+[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z0-9]+/g) ?? [];
  return [...new Set(matches.map(normalize))];
}

function roleWeight(file: RepositoryFileRecord, role: ContextSelectionRequest['role']): number {
  if (role === 'planner') {
    return file.isConfig ? 8 : file.path.toLowerCase().includes('readme') ? 10 : 0;
  }
  if (role === 'implementer') {
    return file.isTest ? 2 : file.isConfig ? 3 : file.isGenerated ? -20 : 6;
  }
  if (role === 'reviewer') {
    return file.isTest ? 7 : file.isConfig ? 4 : 3;
  }
  if (role === 'validator') {
    return file.isTest ? 10 : file.isConfig ? 8 : 1;
  }
  return file.isGenerated ? -10 : 1;
}

function fitToTokenBudget(text: string, maxTokens: number, suffix = ''): {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
} {
  if (maxTokens <= 0) {
    return { text: '', estimatedTokens: 0, truncated: text.length > 0 };
  }

  const fullTokens = TokenBudget.estimateTokens(text);
  if (fullTokens <= maxTokens) {
    return { text, estimatedTokens: fullTokens, truncated: false };
  }

  const suffixTokens = TokenBudget.estimateTokens(suffix);
  if (suffixTokens >= maxTokens) {
    return { text: '', estimatedTokens: 0, truncated: true };
  }

  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, midpoint)}${suffix}`;
    if (TokenBudget.estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return {
    text: best,
    estimatedTokens: TokenBudget.estimateTokens(best),
    truncated: true,
  };
}

// Directories whose contents are dependencies, environments, caches or build
// output rather than the project's own source. Excluded before ranking unless
// the user named or pinned the file. Covers indexes built before the index
// itself learned to skip them.
const NOISE_DIRECTORIES = new Set([
  '.git', 'node_modules', 'bower_components', 'jspm_packages', 'vendor',
  '.venv', 'venv', 'virtualenv', '.virtualenv', 'site-packages', '.tox', '.nox', '.eggs',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis',
  'dist', 'build', 'out', 'target', 'coverage', '.nyc_output',
  '.cache', '.parcel-cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.angular',
  '.gradle', '.dart_tool', 'Pods', 'DerivedData', '.terraform',
  '.idea', '.vscode', '.vs', '.vscode-test', '.ollama-agent',
]);

// Hidden directories that still describe the project (CI, dev containers).
const PROJECT_HIDDEN_DIRECTORIES = new Set(['.github', '.gitlab', '.circleci', '.devcontainer', '.config', '.husky']);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tif', '.tiff', '.psd', '.svgz',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war', '.whl', '.vsix',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib', '.class', '.pyc', '.pyo', '.pyd', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.sqlite', '.sqlite3', '.db', '.mo', '.pkl', '.npy', '.onnx', '.gguf', '.safetensors',
]);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'poetry.lock', 'pipfile.lock', 'cargo.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'packages.lock.json',
]);

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'pipfile', 'requirements.txt',
  'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'composer.json', 'gemfile', 'cmakelists.txt', 'makefile', 'dockerfile', 'docker-compose.yml',
  'docker-compose.yaml', 'tsconfig.json', 'deno.json', 'pubspec.yaml', 'mix.exs', 'project.clj',
]);

const ENTRYPOINT_STEMS = new Set([
  'main', 'index', 'app', 'server', '__main__', 'cli', 'manage', 'wsgi', 'asgi', 'program',
  'startup', 'bootstrap', 'extension', 'routes', 'router', 'urls',
]);

// File stems that conventionally hold a project's domain model and request
// surface across frameworks and languages; favoured for overview questions.
const ARCHITECTURE_STEMS = new Set([
  'models', 'model', 'schema', 'schemas', 'entities', 'domain', 'types',
  'views', 'controllers', 'controller', 'services', 'service', 'api', 'handlers', 'store',
]);

const OVERVIEW_DOC = /^(readme|architecture|status|overview|design|contributing)(\.[a-z]+)?$/i;

const OVERVIEW_TOPIC = /\b(architecture|architectural|overview|structure[ds]?|components?|modules?|layout|organi[sz]ed|organi[sz]ation|codebase|current state|walk ?through|high[- ]level|big picture)\b/i;
const OVERVIEW_ANCHORED = /\bexplain (this|the) (repo|repository|project|codebase|workspace)\b|\bwhat (does|is) this (repo|repository|project|codebase)\b|\binspect (this|the) (repo|repository|project|codebase|workspace)\b/i;
// A bare "this"/"here" (no noun after it) names whatever the user is standing in: "What does this do?",
// "How does this work?", "Where does this start?", "Explain this to me.", "What's going on here?".
const OVERVIEW_BARE_DEICTIC = /^\s*(?:so\s+)?(?:(?:what|how|where|why)(?:\s+(?:does|do|is|are|did|will)|['’]s)?\s+(?:this(?:\s+(?:do|does|work|works|start|starts|begin|begins|run|runs|mean|means|for|about|is|all|thing))?|(?:going on )?here|going on(?: here)?)|(?:please\s+)?(?:explain|walk me through|describe)\s+(?:this|all this)(?:\s+to me)?)[^a-z0-9]*$/i;

export function isRepositoryOverviewQuery(query: string): boolean {
  return OVERVIEW_TOPIC.test(query) || OVERVIEW_ANCHORED.test(query);
}

/**
 * The question is about the whole thing the user is standing in, not about a named topic.
 * Narrower than `isRepositoryOverviewQuery` (no bare topic words like "structure"), so it is
 * safe to combine with workspace evidence to pick the overview reading of an ambiguous question.
 */
export function isWholeWorkspaceQuestion(query: string): boolean {
  return OVERVIEW_ANCHORED.test(query) || OVERVIEW_BARE_DEICTIC.test(query);
}

function segmentsOf(relativePath: string): string[] {
  return relativePath.split('/').filter(Boolean);
}

export function isManifestPath(relativePath: string): boolean {
  const basename = segmentsOf(relativePath).pop()?.toLowerCase() ?? '';
  return MANIFEST_NAMES.has(basename) || /^requirements[-_.\w]*\.txt$/.test(basename) || /\.(csproj|fsproj|sln)$/.test(basename);
}

export function isEntrypointPath(relativePath: string): boolean {
  const segments = segmentsOf(relativePath);
  if (segments.length > 3) return false;
  const basename = segments[segments.length - 1] ?? '';
  const stem = basename.replace(/\.[^.]+$/, '').toLowerCase();
  const extension = extensionOf(relativePath);
  // A markup index page is an entrypoint only near the root (a static site's
  // index.html), not every template directory's index page.
  if (/^\.(html?|css|scss|less)$/.test(extension) && segments.length > 2) return false;
  return ENTRYPOINT_STEMS.has(stem) && !BINARY_EXTENSIONS.has(extension);
}

export function isArchitecturePath(relativePath: string): boolean {
  const segments = segmentsOf(relativePath);
  const stem = (segments[segments.length - 1] ?? '').replace(/\.[^.]+$/, '').toLowerCase();
  return ARCHITECTURE_STEMS.has(stem) || segments.slice(0, -1).some(segment => segment.toLowerCase() === 'models');
}

function extensionOf(relativePath: string): string {
  const match = /\.[^./]+$/.exec(relativePath);
  return match ? match[0].toLowerCase() : '';
}

const BINARY_REASON = 'excluded: binary file';

/** Why a file must never be excerpted, or undefined when it may be. */
export function noiseReason(file: RepositoryFileRecord): string | undefined {
  const segments = segmentsOf(file.path);
  const directories = segments.slice(0, -1);
  const basename = (segments[segments.length - 1] ?? '').toLowerCase();
  const noisyDirectory = directories.find(segment => NOISE_DIRECTORIES.has(segment));
  if (noisyDirectory) return `excluded: ${noisyDirectory}/ is dependency, cache or build output`;
  if (BINARY_EXTENSIONS.has(extensionOf(file.path))) return BINARY_REASON;
  if (file.parseStatus === 'unavailable' && file.size > 0) return 'excluded: no readable text content';
  if (LOCKFILES.has(basename)) return 'excluded: dependency lockfile';
  if (/\.min\.(js|css)$|\.(js|css)\.map$|\.map$/i.test(basename)) return 'excluded: minified or source-map output';
  return undefined;
}

function isToolingHiddenPath(relativePath: string): boolean {
  return segmentsOf(relativePath).slice(0, -1)
    .some(segment => segment.startsWith('.') && !PROJECT_HIDDEN_DIRECTORIES.has(segment));
}

/** Windows around query-term matches kept when a file must be truncated. */
const MAX_QUERY_TERM_WINDOWS = 8;

export class ContextSelector {
  constructor(private readonly workspaceRoot: string) {}

  async select(
    index: RepositoryIndexSnapshot,
    request: ContextSelectionRequest,
  ): Promise<RepositoryContextResult> {
    const terms = queryTerms(request.query);
    const overviewQuery = request.overviewIntent === true || isRepositoryOverviewQuery(request.query);
    const pinned = new Set((index.pins ?? []).map(normalize));
    const explicit = new Set([
      ...referencedPaths(request.query),
      ...(request.hints?.explicitFiles ?? []).map(normalize),
      ...pinned,
    ]);
    const open = new Set((request.hints?.openFiles ?? []).map(normalize));
    const recent = new Set((request.hints?.recentFiles ?? []).map(normalize));
    const changed = new Set((request.hints?.changedFiles ?? []).map(normalize));
    const diagnosticMap = new Map(
      (request.hints?.diagnosticFiles ?? []).map(item => [normalize(item.path), item]),
    );

    const capabilities = ModelCapabilityRegistry.getInstance().getCapabilities(
      request.model,
      request.providerType,
    );
    const providerWindow = capabilities.contextWindow > 0
      ? capabilities.contextWindow
      : 8192;
    const reserve = request.reserveOutputTokens ?? Math.min(4096, Math.floor(providerWindow * 0.25));
    // The character cap is the binding limit: it comes from the model-aware
    // plan when the caller has one, and is never above the hard ceiling that
    // keeps the package valid for Core, whatever token budget was requested.
    const charCap = Math.max(
      1,
      Math.min(REPOSITORY_CONTEXT_HARD_MAX_CHARS, request.budget?.budgetChars ?? REPOSITORY_CONTEXT_HARD_MAX_CHARS),
    );
    const capTokens = Math.floor(charCap / REPOSITORY_CONTEXT_CHARS_PER_TOKEN);
    // A supplied plan already resolved the dispatch window and every
    // reservation, so it is authoritative; the registry-only estimate is the
    // fallback for callers without one.
    const tokenCeiling = request.budget ? capTokens : Math.min(providerWindow - reserve, capTokens);
    const inputBudget = Math.max(
      Math.min(512, capTokens),
      Math.min(request.tokenBudget ?? tokenCeiling, tokenCeiling),
    );
    const maxFiles = Math.min(request.maxFiles ?? REPOSITORY_CONTEXT_MAX_SELECTED_FILES, REPOSITORY_CONTEXT_MAX_SELECTED_FILES);

    const exclusions = index.exclusions ?? [];
    const liveFiles = index.files.filter(file =>
      !file.deleted &&
      !file.stale &&
      !exclusions.some(exclusion => file.path === exclusion || file.path.startsWith(`${exclusion.replace(/\/$/, '')}/`)),
    );
    // Dependency, cache, build-output and binary files are never excerpted.
    // A file the user named or pinned is still honoured unless it is binary.
    let excludedFiles = 0;
    const currentFiles = liveFiles.filter(file => {
      const reason = noiseReason(file);
      if (!reason) return true;
      if (explicit.has(file.path) && reason !== BINARY_REASON) return true;
      excludedFiles += 1;
      return false;
    });
    const byPath = new Map(currentFiles.map(file => [file.path, file]));
    const scored = currentFiles.map(file => this.scoreFile(
      file,
      terms,
      explicit,
      open,
      recent,
      changed,
      diagnosticMap,
      pinned,
      request.role,
      overviewQuery,
    ));

    const candidateByPath = new Map(scored.map(candidate => [candidate.file.path, candidate]));
    const directSeeds = scored.filter(candidate => candidate.score >= 10);

    // Collect expansion edges first, deduplicated per (candidate, seed, edge
    // kind), so a seed that lists the same dependency twice cannot pay the same
    // candidate twice.
    const graphEdges = new Map<string, Map<string, ContextCandidateReason>>();
    const recordEdge = (target: string, key: string, reason: string, score: number) => {
      if (!candidateByPath.has(target)) { return; }
      const edges = graphEdges.get(target) ?? new Map<string, ContextCandidateReason>();
      if (!edges.has(key)) { edges.set(key, { reason, score }); }
      graphEdges.set(target, edges);
    };

    for (const seed of directSeeds) {
      for (const dependency of seed.file.dependencies) {
        recordEdge(dependency, `dependency:${seed.file.path}`, `direct dependency of ${seed.file.path}`, 8);
      }
      for (const linkedTest of seed.file.linkedTests) {
        const testScore = request.role === 'validator' ? 14 : 7;
        recordEdge(linkedTest, `test:${seed.file.path}`, `linked test for ${seed.file.path}`, testScore);
      }
    }

    // Award the strongest edges first and stop at GRAPH_EXPANSION_CAP, so a
    // candidate's structural bonus stays bounded no matter how many seeds point
    // at it. The recorded reasons still sum to the bonus actually applied.
    for (const [target, edges] of graphEdges) {
      const candidate = candidateByPath.get(target);
      if (!candidate) { continue; }
      let awarded = 0;
      const ranked = [...edges.values()]
        .sort((left, right) => right.score - left.score || left.reason.localeCompare(right.reason));
      for (const edge of ranked) {
        const remaining = GRAPH_EXPANSION_CAP - awarded;
        if (remaining <= 0) { break; }
        const value = Math.min(edge.score, remaining);
        candidate.score += value;
        candidate.reasons.push({ reason: edge.reason, score: value });
        awarded += value;
      }
    }

    const selected: SelectedContextFile[] = [];
    const selectedBlocks: string[] = [];
    const rejected: Array<{ path: string; reason: string; score: number }> = [];
    const roleLine = `Selection role: ${request.role}.`;
    const basePrompt = `${CONTEXT_HEADER}\n${roleLine}`;

    // A file the user named explicitly (or pinned) is offered the context
    // budget before generic relevance ranking fills it. Without this, a hub
    // file with high incidental term overlap can outscore the named file and
    // exhaust the budget, so the named file is dropped silently and the model
    // truthfully refuses a question the repository could have answered.
    const isExplicit = (candidate: ScoredCandidate): boolean =>
      explicit.has(candidate.file.path) || pinned.has(candidate.file.path);
    const ordered = scored
      .filter(candidate => candidate.score > 0)
      .sort((left, right) =>
        Number(isExplicit(right)) - Number(isExplicit(left))
        || right.score - left.score
        || left.file.path.localeCompare(right.file.path));

    // Identical content (vendored copies, duplicated READMEs/metadata) is
    // excerpted once; a later copy is named as a one-line pointer to the
    // excerpted original, so no bytes repeat and no file silently disappears.
    const candidateChars = ordered.reduce((sum, candidate) => sum + candidate.file.size, 0);
    const firstPathByHash = new Map<string, string>();
    const duplicateOf = new Map<string, string>();
    for (const candidate of ordered) {
      const hash = candidate.file.contentHash;
      if (!hash) continue;
      const original = firstPathByHash.get(hash);
      if (original && !isExplicit(candidate)) duplicateOf.set(candidate.file.path, original);
      else if (!original) firstPathByHash.set(hash, candidate.file.path);
    }
    const unique = ordered;
    const dedupedChars = ordered
      .filter(candidate => !duplicateOf.has(candidate.file.path))
      .reduce((sum, candidate) => sum + candidate.file.size, 0);

    // Repository summary first: it is what keeps a whole-repository question
    // answerable when the repository is far larger than the budget.
    const overviewBudget = overviewQuery
      ? Math.min(12_000, Math.floor(charCap * 0.25))
      : Math.min(3_000, Math.floor(charCap * 0.08));
    const overview = this.renderOverview(index, excludedFiles, overviewBudget);
    // Headroom for the explicit-omission notice assembled after the loop.
    const noticeReserve = explicit.size > 0
      ? Math.min(2_000, 200 + [...explicit].reduce((sum, item) => sum + item.length + 2, 0))
      : 0;
    let usedChars = basePrompt.length + 1 + (overview ? overview.length + 1 : 0) + noticeReserve;
    let usedTokens = TokenBudget.estimateTokens(request.query)
      + TokenBudget.estimateTokens(basePrompt)
      + TokenBudget.estimateTokens(overview);
    // No single non-explicit file may take most of the package: a giant file
    // is excerpted, never dumped whole at the expense of everything else.
    // A whole-repository question keeps room to name the relevant files that
    // did not fit as excerpts, so the answer can still account for them.
    const summaryReserve = overviewQuery ? Math.min(6_000, Math.floor(charCap * 0.12)) : 0;
    const excerptCap = charCap - summaryReserve;
    const perFileChars = Math.max(1_500, Math.floor(charCap * 0.25));
    const explicitFileChars = Math.max(perFileChars, Math.floor(charCap * 0.5));
    const seenSnippets = new Set<string>();

    for (const candidate of unique) {
      if (selected.length >= maxFiles) {
        rejected.push({ path: candidate.file.path, reason: 'max file count reached', score: candidate.score });
        continue;
      }

      const original = duplicateOf.get(candidate.file.path);
      if (original && selected.some(item => item.path === original)) {
        const pointer = `\n### ${candidate.file.path}\nIdentical content to ${original}; not repeated.`;
        if (usedChars + pointer.length + 1 > excerptCap) {
          rejected.push({ path: candidate.file.path, reason: `duplicate content of ${original}`, score: candidate.score });
          continue;
        }
        const pointerTokens = TokenBudget.estimateTokens(pointer);
        selected.push({
          path: candidate.file.path,
          score: candidate.score,
          estimatedTokens: pointerTokens,
          reasons: [...candidate.reasons, { reason: `duplicate content of ${original}`, score: 0 }],
          snippet: '',
          truncated: true,
        });
        selectedBlocks.push(pointer);
        usedChars += pointer.length + 1;
        usedTokens += pointerTokens;
        continue;
      }

      const reasonsText = candidate.reasons
        .map(reason => `${reason.reason} (+${reason.score})`)
        .join(', ');
      const framePrefix = `\n### ${candidate.file.path}\nReasons: ${reasonsText}\n\`\`\`\n`;
      const frameSuffix = '\n```';
      const frameTokens = TokenBudget.estimateTokens(`${framePrefix}${frameSuffix}`);
      const charsLeft = excerptCap - usedChars - framePrefix.length - frameSuffix.length - 1;
      const remainingForSnippet = Math.min(
        inputBudget - usedTokens - frameTokens,
        Math.floor(charsLeft / REPOSITORY_CONTEXT_CHARS_PER_TOKEN),
      );
      if (remainingForSnippet < 20) {
        rejected.push({ path: candidate.file.path, reason: 'token budget exhausted', score: candidate.score });
        continue;
      }

      const snippet = await this.readSnippet(
        candidate.file,
        request.role,
        remainingForSnippet,
        terms,
        isExplicit(candidate) ? explicitFileChars : perFileChars,
      );
      const snippetKey = crypto.createHash('sha256').update(snippet.text, 'utf8').digest('hex');
      if (snippet.text && seenSnippets.has(snippetKey) && !isExplicit(candidate)) {
        rejected.push({ path: candidate.file.path, reason: 'duplicate snippet', score: candidate.score });
        continue;
      }
      const fitted = fitToTokenBudget(snippet.text, remainingForSnippet, TRUNCATION_SUFFIX);
      if (!fitted.text) {
        rejected.push({ path: candidate.file.path, reason: 'file does not fit remaining token budget', score: candidate.score });
        continue;
      }

      const block = `${framePrefix}${fitted.text}${frameSuffix}`;
      const blockTokens = TokenBudget.estimateTokens(block);
      if (usedTokens + blockTokens > inputBudget || usedChars + block.length + 1 > excerptCap) {
        rejected.push({ path: candidate.file.path, reason: 'file does not fit remaining token budget', score: candidate.score });
        continue;
      }

      seenSnippets.add(snippetKey);
      selected.push({
        path: candidate.file.path,
        score: candidate.score,
        estimatedTokens: fitted.estimatedTokens,
        reasons: candidate.reasons,
        snippet: fitted.text,
        truncated: snippet.truncated || fitted.truncated,
      });
      selectedBlocks.push(block);
      usedChars += block.length + 1;
      usedTokens += blockTokens;
    }

    for (const explicitPath of explicit) {
      if (!byPath.has(explicitPath) && !selected.some(item => item.path === explicitPath)) {
        rejected.push({ path: explicitPath, reason: 'explicit path not found in inventory', score: 100 });
      }
    }

    // Never let an explicitly requested file go missing silently: name it so
    // the answer can report a precise grounding failure instead of quietly
    // degrading into ungrounded chat.
    const omittedExplicit = [...explicit].filter(path =>
      !selected.some(item => item.path === path)
      && rejected.some(item => item.path === path));
    const omissionNotice = omittedExplicit.length
      ? `\nExplicitly requested file(s) that could NOT be included in this package: ${omittedExplicit.join(', ')}. `
        + 'Say so plainly instead of answering from assumption.'
      : '';

    // The overview only stands alone for a whole-repository question; for a
    // specific question with no relevant excerpt the package stays empty so
    // the caller's no-evidence contract still applies.
    const includeOverview = Boolean(overview) && (selected.length > 0 || overviewQuery);

    // Relevant files that did not fit as excerpts still appear by their
    // one-line index summary while budget remains, so a large repository
    // degrades into summaries rather than silently losing them.
    const summaryHeader = '\n### Other relevant files (index summaries only; read a file before relying on its details)';
    const summaryLines: string[] = [];
    if (includeOverview) {
      let summaryChars = usedChars - noticeReserve + omissionNotice.length;
      for (const item of rejected) {
        const file = byPath.get(item.path);
        if (!file || item.reason.startsWith('duplicate')) continue;
        const line = `- ${file.path}: ${file.summary.replace(/\s+/g, ' ').slice(0, 160)}`;
        const needed = line.length + 1 + (summaryLines.length === 0 ? summaryHeader.length + 1 : 0);
        if (summaryChars + needed > charCap) break;
        summaryLines.push(line);
        summaryChars += needed;
      }
    }

    const sections = [
      `${basePrompt}${omissionNotice}`,
      ...(includeOverview ? [overview] : []),
      ...selectedBlocks,
      ...(summaryLines.length ? [`${summaryHeader}\n${summaryLines.join('\n')}`] : []),
    ];
    let prompt = selected.length === 0 && !includeOverview ? '' : sections.join('\n');
    if (prompt.length > charCap) {
      // The accounting above keeps this unreachable; the cap is an invariant,
      // so it is enforced here rather than assumed.
      prompt = `${prompt.slice(0, Math.max(0, charCap - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`.slice(0, charCap);
    }
    const exactPromptTokens = TokenBudget.estimateTokens(request.query)
      + TokenBudget.estimateTokens(prompt);
    const estimatedTokens = Math.min(inputBudget, exactPromptTokens);
    const packageHash = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');

    const budget: RepositoryContextBudgetTelemetry = {
      candidateChars,
      dedupedChars,
      budgetChars: charCap,
      selectedChars: prompt.length,
      droppedFiles: rejected.filter(item => byPath.has(item.path)).length,
      excludedFiles,
      selectedFiles: selected.length,
      summarizedFiles: summaryLines.length,
      modelContext: request.budget?.modelContext ?? providerWindow,
      reservedTokens: request.budget?.reservedTokens ?? reserve,
      hardMaxChars: request.budget?.hardMaxChars ?? REPOSITORY_CONTEXT_HARD_MAX_CHARS,
      limitedBy: request.budget?.limitedBy ?? 'legacy_token_budget',
      overviewQuery,
      overviewChars: includeOverview ? overview.length : 0,
    };

    const diagnostics = {
      queryTerms: terms,
      providerContextWindow: request.budget?.modelContext ?? providerWindow,
      inputBudget,
      estimatedTokens,
      omittedCount: rejected.length,
      packageHash,
      selectedFiles: selected.map(file => ({
        path: file.path,
        score: file.score,
        estimatedTokens: file.estimatedTokens,
        reasons: file.reasons,
      })),
      rejectedFiles: rejected,
      inventorySize: index.files.length,
      inventoryTruncated: index.truncated,
      budget,
    };

    return { prompt, files: selected, diagnostics, index };
  }

  /**
   * A compact, index-derived description of the whole workspace: size,
   * languages, top-level layout, manifests and likely entrypoints. Built from
   * index metadata only (no file reads) and bounded to `maxChars`.
   */
  private renderOverview(index: RepositoryIndexSnapshot, excludedCount: number, maxChars: number): string {
    if (maxChars < 200) return '';
    const files = index.files.filter(file => !file.deleted && !file.stale);
    const eligible = files.filter(file => !noiseReason(file));
    const languages = new Map<string, number>();
    for (const file of eligible) languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
    const languageText = [...languages.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([language, count]) => `${language} ${count}`)
      .join(', ');

    const directories = new Map<string, number>();
    const rootFiles: string[] = [];
    for (const file of eligible) {
      const segments = segmentsOf(file.path);
      if (segments.length === 1) rootFiles.push(segments[0]);
      else directories.set(segments[0], (directories.get(segments[0]) ?? 0) + 1);
    }
    const layout = [
      ...[...directories.entries()]
        .sort((left, right) => Number(left[0].startsWith('.')) - Number(right[0].startsWith('.')) || left[0].localeCompare(right[0]))
        .map(([directory, count]) => `${directory}/ (${count} file${count === 1 ? '' : 's'})`),
      ...rootFiles.sort((left, right) => left.localeCompare(right)),
    ];
    const manifests = eligible.filter(file => isManifestPath(file.path)).map(file => file.path).sort();
    const entrypoints = eligible
      .filter(file => isEntrypointPath(file.path) && !isToolingHiddenPath(file.path) && !file.isTest)
      .map(file => file.path)
      .sort((left, right) => segmentsOf(left).length - segmentsOf(right).length || left.localeCompare(right));

    const excludedText = excludedCount
      ? `; ${excludedCount} dependency/cache/build/binary file(s) are not excerpted`
      : '';
    const lines = [
      '\n### Repository overview (from the repository index)',
      eligible.length === 0
        ? `The workspace has no indexable source or text files${files.length ? ` (${files.length} indexed file(s) are dependency, cache, build or binary content)` : ''}.`
        : `Indexed files: ${eligible.length}${index.truncated ? ' (inventory truncated)' : ''}${excludedText}.`
          + (languageText ? ` Languages: ${languageText}.` : ''),
      layout.length ? `Top-level layout: ${layout.join(', ')}` : '',
      manifests.length ? `Manifests/config: ${manifests.slice(0, 20).join(', ')}` : '',
      entrypoints.length ? `Likely entrypoints: ${entrypoints.slice(0, 20).join(', ')}` : '',
    ].filter(Boolean);
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars - 2)} …` : text;
  }

  private scoreFile(
    file: RepositoryFileRecord,
    terms: string[],
    explicit: Set<string>,
    open: Set<string>,
    recent: Set<string>,
    changed: Set<string>,
    diagnostics: Map<string, { severity: 'error' | 'warning' | 'info'; message?: string }>,
    pinned: Set<string>,
    role: ContextSelectionRequest['role'],
    overviewQuery = false,
  ): ScoredCandidate {
    const reasons: ContextCandidateReason[] = [];
    let score = 0;
    const add = (reason: string, value: number) => {
      if (value === 0) { return; }
      score += value;
      reasons.push({ reason, score: value });
    };

    if (explicit.has(file.path)) { add('explicit reference', 200); }
    if (pinned.has(file.path)) { add('user pinned', 200); }
    if (open.has(file.path)) { add('open in editor', 10); }
    if (recent.has(file.path)) { add('recently modified', 4); }
    if (changed.has(file.path)) { add('Git changed file', 8); }
    const diagnostic = diagnostics.get(file.path);
    if (diagnostic) {
      add(
        `diagnostic ${diagnostic.severity}`,
        diagnostic.severity === 'error' ? 45 : diagnostic.severity === 'warning' ? 25 : 10,
      );
    }
    add(`role ${role}`, roleWeight(file, role));

    const pathTokens = new Set(identifierTokens(file.path));
    const symbolTokens = new Set(identifierTokens([
      ...file.symbols.map(symbol => symbol.name),
      ...(file.exports ?? []),
    ].join(' ')));
    const summaryTokens = new Set(identifierTokens(file.summary));
    for (const term of terms) {
      if (pathTokens.has(term)) { add(`path matches ${term}`, 24); }
      else if (symbolTokens.has(term)) { add(`symbol or export matches ${term}`, 20); }
      else if (summaryTokens.has(term)) { add(`content summary matches ${term}`, 7); }
    }
    if (file.isGenerated) { add('generated file penalty', -30); }
    if (file.size > 512_000) { add('large file penalty', -8); }
    // Agent/IDE tool state (.idea-style hidden folders, saved plans) describes
    // the tooling, not the project.
    if (isToolingHiddenPath(file.path)) { add('tooling directory penalty', -25); }
    if (overviewQuery) {
      // A whole-repository question is answered from what defines the project
      // (manifests, entrypoints, top-level docs, config) before feature code.
      const depth = segmentsOf(file.path).length - 1;
      const basename = segmentsOf(file.path).pop() ?? '';
      if (isManifestPath(file.path) && depth <= 1) { add('project manifest', 40); }
      if (depth === 0 && OVERVIEW_DOC.test(basename)) { add('top-level project document', 35); }
      if (isEntrypointPath(file.path) && !file.isTest) { add('likely entrypoint', 30); }
      if (isArchitecturePath(file.path) && !file.isTest) { add('domain model or request surface', 18); }
      if (file.isConfig) { add('project configuration', 10); }
      if (file.isTest) { add('test file (overview)', -10); }
      if (depth >= 3) { add('deeply nested (overview)', -6); }
    }
    return { file, score, reasons };
  }

  private async readSnippet(
    file: RepositoryFileRecord,
    role: ContextSelectionRequest['role'],
    remainingTokens: number,
    terms: readonly string[] = [],
    maxFileChars = Number.POSITIVE_INFINITY,
  ): Promise<{ text: string; truncated: boolean }> {
    // Roles that produce or check a complete CodingProposal need to see whole
    // files: a truncated view of the file being replaced forces the model to
    // invent the remainder, which then fails real validation. The remaining
    // token budget still bounds the total.
    const maxChars = Math.max(
      80,
      Math.min(
        remainingTokens * 4,
        role === 'implementer' ? 32_000 : role === 'reviewer' || role === 'validator' ? 24_000 : 8_000,
        maxFileChars,
      ),
    );
    try {
      const content = await fs.readFile(file.absolutePath, 'utf8');
      if (content.length <= maxChars) { return { text: content, truncated: false }; }

      const symbolLines = new Set(file.symbols.slice(0, 10).map(symbol => symbol.line));
      const lines = content.split('\n');
      const headerLines = Math.min(60, lines.length);
      // Windows are collected as line ranges and emitted in file order, so a
      // truncated file never reads as a reordered file. Query-term windows
      // matter for structured files (a package.json's "scripts" block sits far
      // past any header) and for files with no indexed symbols at all: without
      // them a truncated view is the head of the file and nothing else, and the
      // evidence the user actually asked about is silently dropped.
      const ranges: Array<[number, number]> = [[0, headerLines]];
      for (const symbolLine of symbolLines) {
        ranges.push([Math.max(headerLines, symbolLine - 4), Math.min(lines.length, symbolLine + 18)]);
      }
      if (terms.length) {
        let matched = 0;
        for (let lineNumber = headerLines; lineNumber < lines.length && matched < MAX_QUERY_TERM_WINDOWS; lineNumber += 1) {
          const lowered = lines[lineNumber].toLowerCase();
          if (!terms.some(term => lowered.includes(term))) { continue; }
          ranges.push([Math.max(headerLines, lineNumber - 2), Math.min(lines.length, lineNumber + 20)]);
          matched += 1;
          lineNumber += 20;
        }
      }
      const merged: Array<[number, number]> = [];
      for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
        if (start >= end) { continue; }
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) { last[1] = Math.max(last[1], end); } else { merged.push([start, end]); }
      }
      const joined = merged.map(([start, end]) => lines.slice(start, end).join('\n')).join('\n\n…\n\n');
      return {
        text: joined.slice(0, maxChars),
        truncated: true,
      };
    } catch {
      return { text: file.summary, truncated: false };
    }
  }
}
