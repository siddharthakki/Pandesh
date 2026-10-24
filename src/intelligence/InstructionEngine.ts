import * as fs from 'fs/promises';
import * as path from 'path';

export type InstructionScope = 'user' | 'organization' | 'repository' | 'directory' | 'task';

export interface InstructionSource {
  id: string;
  scope: InstructionScope;
  filename?: string;
  content: string;
  precedence: number;
  trusted: boolean;
  directoryDepth: number;
}

export interface ResolvedInstructions {
  schemaVersion: 1;
  targetPath: string;
  generatedAt: string;
  sources: InstructionSource[];
  combined: string;
  totalCharacters: number;
}

export interface InstructionEngineOptions {
  userFiles?: string[];
  organizationFiles?: string[];
  repositoryFilenames?: string[];
  directoryFilenames?: string[];
  maxFiles?: number;
  maxCharacters?: number;
  maxImportDepth?: number;
}

interface PendingSource {
  scope: Exclude<InstructionScope, 'task'>;
  filename: string;
  precedence: number;
  trusted: boolean;
  directoryDepth: number;
}

const DEFAULT_FILENAMES = ['AGENTS.md', 'CLAUDE.md', path.join('.ollama-agent', 'instructions.md')];
const IMPORT_PATTERN = /^\s*@import\s+(?:<([^>]+)>|"([^"]+)"|'([^']+)'|(\S+))\s*$/gm;

export class InstructionEngine {
  private readonly root: string;
  private readonly options: Required<Omit<InstructionEngineOptions, 'userFiles' | 'organizationFiles'>> & Pick<InstructionEngineOptions, 'userFiles' | 'organizationFiles'>;

  constructor(workspaceRoot: string, options: InstructionEngineOptions = {}) {
    this.root = path.resolve(workspaceRoot);
    this.options = {
      userFiles: options.userFiles ?? [],
      organizationFiles: options.organizationFiles ?? [],
      repositoryFilenames: options.repositoryFilenames ?? DEFAULT_FILENAMES,
      directoryFilenames: options.directoryFilenames ?? DEFAULT_FILENAMES,
      maxFiles: options.maxFiles ?? 50,
      maxCharacters: options.maxCharacters ?? 120_000,
      maxImportDepth: options.maxImportDepth ?? 5,
    };
    if (this.options.maxFiles < 1 || this.options.maxFiles > 500) throw new Error('Instruction maxFiles must be between 1 and 500.');
    if (this.options.maxCharacters < 1000 || this.options.maxCharacters > 2_000_000) throw new Error('Instruction maxCharacters is out of range.');
  }

  async resolve(targetPath: string, taskInstruction?: string): Promise<ResolvedInstructions> {
    const absoluteTarget = this.resolveInsideWorkspace(targetPath);
    const pending = this.collectPendingSources(absoluteTarget);
    const loaded: InstructionSource[] = [];
    const seen = new Set<string>();

    for (const source of pending) {
      await this.loadSource(source, loaded, seen, 0);
      if (loaded.length >= this.options.maxFiles) break;
    }

    if (taskInstruction?.trim()) {
      loaded.push({
        id: 'task:inline',
        scope: 'task',
        content: taskInstruction.trim(),
        precedence: 10_000,
        trusted: true,
        directoryDepth: Number.MAX_SAFE_INTEGER,
      });
    }

    const ordered = loaded
      .sort((left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id));
    let totalCharacters = 0;
    const accepted: InstructionSource[] = [];
    for (const source of ordered) {
      if (accepted.length >= this.options.maxFiles) break;
      if (totalCharacters + source.content.length > this.options.maxCharacters) break;
      accepted.push(source);
      totalCharacters += source.content.length;
    }

    const combined = accepted.map(source => {
      const origin = source.filename ? path.relative(this.root, source.filename) || path.basename(source.filename) : source.id;
      return `<!-- instructions:${source.scope}:${origin}:trusted=${source.trusted} -->\n${source.content}`;
    }).join('\n\n');

    return {
      schemaVersion: 1,
      targetPath: path.relative(this.root, absoluteTarget) || '.',
      generatedAt: new Date().toISOString(),
      sources: accepted.map(source => ({ ...source })),
      combined,
      totalCharacters,
    };
  }

  private collectPendingSources(target: string): PendingSource[] {
    const pending: PendingSource[] = [];
    for (const filename of this.options.userFiles ?? []) {
      pending.push({ scope: 'user', filename: path.resolve(filename), precedence: 100, trusted: true, directoryDepth: -2 });
    }
    for (const filename of this.options.organizationFiles ?? []) {
      pending.push({ scope: 'organization', filename: path.resolve(filename), precedence: 200, trusted: true, directoryDepth: -1 });
    }
    for (const relative of this.options.repositoryFilenames) {
      pending.push({ scope: 'repository', filename: path.join(this.root, relative), precedence: 300, trusted: false, directoryDepth: 0 });
    }

    const targetDirectory = path.extname(target) ? path.dirname(target) : target;
    const relative = path.relative(this.root, targetDirectory);
    const parts = relative && relative !== '.' ? relative.split(path.sep).filter(Boolean) : [];
    let current = this.root;
    for (let depth = 0; depth <= parts.length; depth += 1) {
      if (depth > 0) current = path.join(current, parts[depth - 1]);
      if (depth === 0) continue;
      for (const filename of this.options.directoryFilenames) {
        pending.push({
          scope: 'directory',
          filename: path.join(current, filename),
          precedence: 400 + depth,
          trusted: false,
          directoryDepth: depth,
        });
      }
    }
    return pending;
  }

  private async loadSource(
    pending: PendingSource,
    output: InstructionSource[],
    seen: Set<string>,
    importDepth: number,
  ): Promise<void> {
    if (output.length >= this.options.maxFiles || importDepth > this.options.maxImportDepth) return;
    const normalized = path.resolve(pending.filename);
    if (seen.has(normalized)) return;
    seen.add(normalized);

    let content: string;
    try {
      const stat = await fs.stat(normalized);
      if (!stat.isFile()) return;
      content = await fs.readFile(normalized, 'utf8');
    } catch {
      return;
    }

    const imports = parseImports(content);
    const sourceContent = content.replace(IMPORT_PATTERN, '').trim();
    if (sourceContent) {
      output.push({
        id: `${pending.scope}:${normalized}`,
        scope: pending.scope,
        filename: normalized,
        content: sourceContent,
        precedence: pending.precedence,
        trusted: pending.trusted,
        directoryDepth: pending.directoryDepth,
      });
    }

    for (const imported of imports) {
      const importedPath = path.resolve(path.dirname(normalized), imported);
      if (!pending.trusted) this.assertInsideWorkspace(importedPath);
      await this.loadSource({ ...pending, filename: importedPath, precedence: pending.precedence + 0.01 }, output, seen, importDepth + 1);
    }
  }

  private resolveInsideWorkspace(candidate: string): string {
    const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(this.root, candidate);
    this.assertInsideWorkspace(resolved);
    return resolved;
  }

  private assertInsideWorkspace(candidate: string): void {
    const relative = path.relative(this.root, path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Instruction path escapes workspace: ${candidate}`);
    }
  }
}

function parseImports(content: string): string[] {
  const imports: string[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (value?.trim()) imports.push(value.trim());
  }
  return imports;
}
