import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export type SkillScope = 'bundled' | 'user' | 'repository';

export interface SkillToolDeclaration {
  name: string;
  access: 'read' | 'write' | 'network' | 'destructive';
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  scope: SkillScope;
  directory: string;
  checksum: string;
  trusted: boolean;
  tags: string[];
  tools: SkillToolDeclaration[];
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  references: string[];
  scripts: string[];
  assets: string[];
}

export interface SkillRegistryOptions {
  roots: Array<{ scope: SkillScope; directory: string; trusted: boolean }>;
  maxSkills?: number;
  maxInstructionCharacters?: number;
}

export interface SkillSelectionRequest {
  query: string;
  requiredTags?: string[];
  allowedAccess?: SkillToolDeclaration['access'][];
  limit?: number;
}

interface ParsedSkillFile {
  metadata: Record<string, string>;
  instructions: string;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillSummary>();
  private readonly maxSkills: number;
  private readonly maxInstructionCharacters: number;

  constructor(private readonly options: SkillRegistryOptions) {
    this.maxSkills = options.maxSkills ?? 200;
    this.maxInstructionCharacters = options.maxInstructionCharacters ?? 80_000;
  }

  async refresh(): Promise<SkillSummary[]> {
    const discovered: SkillSummary[] = [];
    for (const root of this.options.roots) {
      const directory = path.resolve(root.directory);
      for (const filename of await findSkillFiles(directory)) {
        if (discovered.length >= this.maxSkills) break;
        const parsed = parseSkillFile(await fs.readFile(filename, 'utf8'));
        const relativeDirectory = path.relative(directory, path.dirname(filename));
        const id = parsed.metadata['id'] || `${root.scope}:${relativeDirectory || path.basename(path.dirname(filename))}`;
        validateSkillId(id);
        const summary: SkillSummary = {
          id,
          name: parsed.metadata['name'] || path.basename(path.dirname(filename)),
          description: parsed.metadata['description'] || firstParagraph(parsed.instructions),
          version: parsed.metadata['version'] || '0.0.0',
          scope: root.scope,
          directory: path.dirname(filename),
          checksum: await checksumDirectory(path.dirname(filename)),
          trusted: root.trusted,
          tags: splitList(parsed.metadata['tags']),
          tools: parseTools(parsed.metadata['tools']),
        };
        discovered.push(summary);
      }
    }
    discovered.sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.id.localeCompare(right.id));
    this.skills.clear();
    for (const summary of discovered) {
      if (this.skills.has(summary.id)) throw new Error(`Duplicate skill id: ${summary.id}`);
      this.skills.set(summary.id, summary);
    }
    return this.list();
  }

  list(): SkillSummary[] {
    return [...this.skills.values()].map(cloneSummary);
  }

  select(request: SkillSelectionRequest): SkillSummary[] {
    const queryTerms = tokenize(request.query);
    const requiredTags = new Set((request.requiredTags ?? []).map(value => value.toLowerCase()));
    const allowedAccess = new Set(request.allowedAccess ?? ['read']);
    const limit = Math.max(1, Math.min(request.limit ?? 5, 20));

    return [...this.skills.values()]
      .filter(skill => [...requiredTags].every(tag => skill.tags.map(value => value.toLowerCase()).includes(tag)))
      .filter(skill => skill.tools.every(tool => allowedAccess.has(tool.access)))
      .map(skill => ({ skill, score: scoreSkill(skill, queryTerms) }))
      .filter(entry => entry.score > 0 || queryTerms.length === 0)
      .sort((left, right) => right.score - left.score || scopeRank(left.skill.scope) - scopeRank(right.skill.scope) || left.skill.id.localeCompare(right.skill.id))
      .slice(0, limit)
      .map(entry => cloneSummary(entry.skill));
  }

  async load(id: string, expectedChecksum?: string): Promise<LoadedSkill> {
    const summary = this.skills.get(id);
    if (!summary) throw new Error(`Unknown skill: ${id}`);
    const actualChecksum = await checksumDirectory(summary.directory);
    if (actualChecksum !== summary.checksum) throw new Error(`Skill changed after registration: ${id}`);
    if (expectedChecksum && expectedChecksum !== actualChecksum) throw new Error(`Skill checksum mismatch: ${id}`);

    const filename = path.join(summary.directory, 'SKILL.md');
    const parsed = parseSkillFile(await fs.readFile(filename, 'utf8'));
    if (parsed.instructions.length > this.maxInstructionCharacters) {
      throw new Error(`Skill instructions exceed limit: ${id}`);
    }
    return {
      ...cloneSummary(summary),
      instructions: parsed.instructions,
      references: await listRelativeFiles(summary.directory, 'references'),
      scripts: await listRelativeFiles(summary.directory, 'scripts'),
      assets: await listRelativeFiles(summary.directory, 'assets'),
    };
  }
}

async function findSkillFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Array<import('fs').Dirent>;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name === 'SKILL.md') result.push(full);
    }
  }
  return result.sort();
}

function parseSkillFile(content: string): ParsedSkillFile {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { metadata: {}, instructions: normalized.trim() };
  }
  const lines = normalized.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { index += 1; break; }
    const separator = lines[index].indexOf(':');
    if (separator <= 0) continue;
    metadata[lines[index].slice(0, separator).trim().toLowerCase()] = lines[index].slice(separator + 1).trim();
  }
  return { metadata, instructions: lines.slice(index).join('\n').trim() };
}

function parseTools(value?: string): SkillToolDeclaration[] {
  if (!value) return [];
  return splitList(value).map(item => {
    const [name, rawAccess] = item.split('@').map(part => part.trim());
    const access = (rawAccess || 'read') as SkillToolDeclaration['access'];
    if (!['read', 'write', 'network', 'destructive'].includes(access)) throw new Error(`Invalid skill tool access: ${item}`);
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(name)) throw new Error(`Invalid skill tool name: ${name}`);
    return { name, access };
  });
}

function scoreSkill(skill: SkillSummary, terms: string[]): number {
  const haystack = `${skill.id} ${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) + (skill.trusted ? 0.1 : 0);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_.-]+/).filter(term => term.length > 1))];
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function firstParagraph(content: string): string {
  return content.split(/\n\s*\n/)[0]?.replace(/^#+\s*/, '').trim().slice(0, 500) || 'No description.';
}

async function checksumDirectory(directory: string): Promise<string> {
  const files = await walkFiles(directory);
  const hash = createHash('sha256');
  for (const filename of files) {
    hash.update(path.relative(directory, filename).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(await fs.readFile(filename));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function walkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Array<import('fs').Dirent>;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

async function listRelativeFiles(root: string, child: string): Promise<string[]> {
  const directory = path.join(root, child);
  return (await walkFiles(directory)).map(filename => path.relative(root, filename).replace(/\\/g, '/'));
}

function validateSkillId(id: string): void {
  if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(id)) throw new Error(`Invalid skill id: ${id}`);
}

function scopeRank(scope: SkillScope): number {
  return scope === 'bundled' ? 0 : scope === 'user' ? 1 : 2;
}

function cloneSummary(skill: SkillSummary): SkillSummary {
  return { ...skill, tags: [...skill.tags], tools: skill.tools.map(tool => ({ ...tool })) };
}
