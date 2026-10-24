import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isWholeWorkspaceQuestion } from './ContextSelector';

/**
 * Situational awareness for ambiguous questions. "What does this do?" names no
 * project, yet a user standing in a project folder means the project. The decision
 * flow is: active workspace -> project evidence -> whole-workspace question ->
 * grounded overview. Only when the workspace offers no plausible referent (or the
 * conversation clearly points elsewhere) does the question stay generic.
 *
 * Git is OPTIONAL: it is reported when present, never required.
 */

const PROJECT_MARKERS = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'pipfile', 'cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'cmakelists.txt', 'makefile', 'gemfile', 'composer.json',
  'mix.exs', 'deno.json', 'tsconfig.json', 'index.html', 'dockerfile', 'pubspec.yaml', 'project.clj',
]);
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h',
  '.hpp', '.rb', '.php', '.swift', '.scala', '.sh', '.ps1', '.html', '.css', '.vue', '.svelte', '.lua', '.dart',
]);
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.ollama-agent', '.vscode', '.idea', 'dist', 'out', 'build', '__pycache__', '.venv', 'venv', 'target']);
const MAX_ENTRIES = 400;
const MAX_DEPTH = 3;

export interface WorkspaceProjectEvidence {
  hasProject: boolean;
  /** A .git entry exists. Informational only; never required. */
  git: boolean;
  markers: string[];
  sourceFileCount: number;
}

/** Bounded, read-only scan: project markers or source files within a few levels. README alone is not a project. */
export async function detectWorkspaceProjectEvidence(root: string | undefined): Promise<WorkspaceProjectEvidence> {
  const evidence: WorkspaceProjectEvidence = { hasProject: false, git: false, markers: [], sourceFileCount: 0 };
  if (!root) return evidence;
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ >= MAX_ENTRIES) return;
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name === '.git' && depth === 0) evidence.git = true;
        if (!SKIPPED_DIRECTORIES.has(name) && depth < MAX_DEPTH) await walk(path.join(dir, name), depth + 1);
      } else if (entry.isFile()) {
        if (name === '.git' && depth === 0) evidence.git = true; // worktrees/submodules use a .git file
        if (depth === 0 && PROJECT_MARKERS.has(name.toLowerCase())) evidence.markers.push(name);
        if (SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) evidence.sourceFileCount += 1;
      }
    }
  };
  await walk(root, 0);
  evidence.hasProject = evidence.markers.length > 0 || evidence.sourceFileCount > 0;
  return evidence;
}

/** What the conversation so far has been about, as far as the panel can tell. */
export type ConversationReferent = 'none' | 'workspace' | 'other';

export interface WorkspaceReferentInput {
  text: string;
  evidence: WorkspaceProjectEvidence;
  /** 'other' = an earlier turn in this conversation was answered without the workspace, so "this" likely points there. */
  conversationReferent: ConversationReferent;
  hasAttachments?: boolean;
}

export type WorkspaceReferentDecision = 'workspace_overview' | 'not_workspace';

export function resolveWorkspaceReferent(input: WorkspaceReferentInput): WorkspaceReferentDecision {
  if (!input.evidence.hasProject) return 'not_workspace'; // empty folder: no plausible referent, stay generic
  if (input.hasAttachments) return 'not_workspace'; // "this" is the attachment
  if (input.conversationReferent === 'other') return 'not_workspace'; // conversation already has another referent
  return isWholeWorkspaceQuestion(input.text) ? 'workspace_overview' : 'not_workspace';
}
