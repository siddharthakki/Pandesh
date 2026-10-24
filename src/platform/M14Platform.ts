import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { ProviderType } from '../providers/ProviderTypes';
import { FixedMultiAgentStage } from '../orchestration/FixedMultiAgentGraph';
import { ToolRegistry } from '../tools/ToolRegistry';

export type PlatformSourceScope = 'builtin' | 'user' | 'repository' | 'extension';
export type TrustState = 'untrusted' | 'trusted-readonly' | 'trusted-governed';
export type PlatformMode = 'chat' | 'ask' | 'plan' | 'agent';

export interface PlatformPaths {
  workspaceRoot: string;
  userRoot: string;
}

export interface PlatformDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
  fingerprint?: string;
}

export interface InstructionSource {
  identity: string;
  sourceScope: PlatformSourceScope;
  scopePath: string;
  precedence: number;
  fingerprint: string;
  bytes: number;
  text: string;
}

export interface EffectiveInstructions {
  text: string;
  sources: Omit<InstructionSource, 'text'>[];
  diagnostics: PlatformDiagnostic[];
}

export interface SkillManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  description?: string;
  version?: string;
  instructionFile?: string;
  allowedModes?: PlatformMode[];
  preferredAgentProfile?: string;
  requiredToolCapabilities?: string[];
  requiredMcpServers?: string[];
  argumentsSchema?: JsonSchema;
  enabled?: boolean;
  sourceScope?: PlatformSourceScope;
}

export interface SkillDefinition {
  manifest: SkillManifest;
  directory: string;
  sourceScope: PlatformSourceScope;
  instructionsFingerprint: string;
}

export interface SlashCommandDefinition {
  schemaVersion: 1;
  id: string;
  description?: string;
  argumentHint?: string;
  allowedModes?: PlatformMode[];
  preferredAgentProfile?: string;
  requiredSkillIds?: string[];
  requiredMcpServers?: string[];
  enabled?: boolean;
  sourceScope: PlatformSourceScope;
  instructions: string;
  fingerprint: string;
}

export interface AgentProfile {
  schemaVersion: 1;
  id: string;
  displayName: string;
  description?: string;
  baseRole: 'repository-analyst' | 'planner' | 'implementer' | 'reviewer' | 'validator' | 'general-chat' | 'coding-agent';
  instructionFiles?: string[];
  providerType?: ProviderType;
  model?: string;
  fallbackModels?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  requestedStructuredOutput?: boolean;
  permissionProfileId?: string;
  allowedToolCapabilityIds?: string[];
  allowedMcpServerIds?: string[];
  allowedMcpToolIds?: string[];
  allowedSkillIds?: string[];
  repositoryContextRole?: string;
  repositoryContextTokenBudget?: number;
  enabled?: boolean;
  sourceScope?: PlatformSourceScope;
}

export interface McpServerConfig {
  schemaVersion: 1;
  id: string;
  displayName?: string;
  enabled?: boolean;
  transport: 'stdio' | 'local-http';
  command?: string;
  args?: string[];
  url?: string;
  secretReferenceNames?: string[];
  environmentReferenceNames?: string[];
  workingDirectoryPolicy?: 'workspace' | 'server-directory' | 'none';
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  allowedToolIds?: string[];
  allowedResourceIds?: string[];
  allowedPromptIds?: string[];
  trustRequirement?: TrustState;
  sourceScope?: PlatformSourceScope;
}

export interface LocalExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName?: string;
  description?: string;
  sourceScope?: PlatformSourceScope;
  enabled?: boolean;
  contributions?: {
    instructions?: string[];
    skills?: string[];
    commands?: string[];
    agents?: string[];
    mcpServers?: string[];
  };
  manifestFingerprint?: string;
  trustRequirement?: TrustState;
}

export interface RoutingRequest {
  role: AgentProfile['baseRole'];
  selectedProfileId?: string;
  model?: string;
  providerType?: ProviderType;
  fallbackModels?: string[];
  mutationStarted?: boolean;
  unavailableModels?: string[];
}

export interface RoutingDecision {
  providerType: ProviderType;
  model: string;
  fallbackChain: string[];
  fallbackReason?: string;
  attempts: string[];
  evidence: {
    selectedProfileId?: string;
    role: string;
    contextMetadata: 'exact' | 'estimated';
  };
}

export type JsonSchema = Record<string, unknown>;

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 256 * 1024;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

const REPOSITORY_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  '.ollama-agent/instructions.md',
] as const;

const BUILTIN_PROFILES: AgentProfile[] = [
  { schemaVersion: 1, id: 'repository-analyst', displayName: 'Repository Analyst', baseRole: 'repository-analyst', enabled: true, sourceScope: 'builtin' },
  { schemaVersion: 1, id: 'planner', displayName: 'Planner', baseRole: 'planner', enabled: true, sourceScope: 'builtin' },
  { schemaVersion: 1, id: 'implementer', displayName: 'Implementer', baseRole: 'implementer', enabled: true, sourceScope: 'builtin' },
  { schemaVersion: 1, id: 'reviewer', displayName: 'Reviewer', baseRole: 'reviewer', enabled: true, sourceScope: 'builtin' },
  { schemaVersion: 1, id: 'validator', displayName: 'Validator', baseRole: 'validator', enabled: true, sourceScope: 'builtin' },
  { schemaVersion: 1, id: 'general-chat', displayName: 'General Chat', baseRole: 'general-chat', enabled: true, sourceScope: 'builtin' },
  { schemaVersion: 1, id: 'coding-agent', displayName: 'Coding Agent', baseRole: 'coding-agent', enabled: true, sourceScope: 'builtin' },
];

export class M14Platform {
  private diagnostics: PlatformDiagnostic[] = [];
  private instructionCacheKey = '';
  private instructionCache?: EffectiveInstructions;
  private trust = new Map<string, TrustState>();

  constructor(private readonly paths: PlatformPaths) {}

  async reload(): Promise<void> {
    this.diagnostics = [];
    this.instructionCache = undefined;
    this.instructionCacheKey = '';
  }

  getDiagnostics(): PlatformDiagnostic[] {
    return this.diagnostics.map(diagnostic => ({ ...diagnostic }));
  }

  async resolveInstructions(options: {
    targetFiles?: string[];
    profileId?: string;
    skillIds?: string[];
    slashCommandId?: string;
    task?: string;
  } = {}): Promise<EffectiveInstructions> {
    const key = JSON.stringify(options);
    if (this.instructionCache && this.instructionCacheKey === key) {
      return cloneInstructions(this.instructionCache);
    }
    const diagnostics: PlatformDiagnostic[] = [];
    const sources: InstructionSource[] = [];
    sources.push(inMemorySource('host-safety', 'builtin', 1, 'Host safety, authorization, workspace, approval, validation, and output bounds are authoritative.'));
    sources.push(inMemorySource('managed-policy', 'builtin', 2, 'KarkeDikha managed policy: instructions can request behavior but cannot grant permissions or disable safety.'));
    await this.collectUserInstructions(sources, diagnostics);
    await this.collectRepositoryInstructions(sources, diagnostics, options.targetFiles ?? []);
    if (options.profileId) {
      const profile = (await this.listAgentProfiles()).find(candidate => candidate.id === options.profileId);
      if (profile) {
        sources.push(inMemorySource(`agent-profile:${profile.id}`, profile.sourceScope ?? 'builtin', 6, `Selected agent profile: ${profile.displayName}. Base role: ${profile.baseRole}.`));
      }
    }
    if (options.skillIds?.length) {
      const skills = await this.listSkills();
      for (const id of options.skillIds) {
        const skill = skills.find(candidate => candidate.manifest.id === id);
        if (!skill) {
          diagnostics.push({ code: 'skill.missing', severity: 'error', message: `Selected skill is unavailable: ${id}` });
          continue;
        }
        const text = await readBoundedText(path.join(skill.directory, skill.manifest.instructionFile ?? 'SKILL.md'), skill.directory, diagnostics, `skill:${id}`);
        if (text) {
          sources.push(sourceFromText(`skill:${id}`, skill.sourceScope, skill.directory, 7, text));
        }
      }
    }
    if (options.slashCommandId) {
      const command = (await this.listSlashCommands()).find(candidate => candidate.id === options.slashCommandId);
      if (command) {
        sources.push(sourceFromText(`slash-command:${command.id}`, command.sourceScope, command.id, 7, command.instructions));
      }
    }
    if (options.task) {
      sources.push(inMemorySource('current-user-task', 'builtin', 8, options.task));
    }
    sources.sort((left, right) => left.precedence - right.precedence || left.identity.localeCompare(right.identity));
    const bounded: InstructionSource[] = [];
    let total = 0;
    for (const source of sources) {
      total += source.bytes;
      if (total > MAX_TOTAL_INSTRUCTION_BYTES) {
        diagnostics.push({ code: 'instructions.totalTooLarge', severity: 'warning', message: 'Instruction total exceeded the M14 bound; later sources were excluded.', source: source.identity, fingerprint: source.fingerprint });
        break;
      }
      bounded.push(source);
    }
    const result: EffectiveInstructions = {
      text: bounded.map(source => `<!-- ${source.identity} precedence=${source.precedence} fingerprint=${source.fingerprint} -->\n${source.text}`).join('\n\n'),
      sources: bounded.map(({ text: _text, ...source }) => source),
      diagnostics,
    };
    this.instructionCacheKey = key;
    this.instructionCache = cloneInstructions(result);
    return result;
  }

  async listSkills(): Promise<SkillDefinition[]> {
    const roots = [
      { scope: 'user' as const, directory: path.join(this.paths.userRoot, 'skills') },
      { scope: 'repository' as const, directory: path.join(this.paths.workspaceRoot, '.ollama-agent', 'skills') },
    ];
    const skills: SkillDefinition[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      for (const directory of await listDirectories(root.directory)) {
        const manifestPath = path.join(directory, 'skill.json');
        const manifest = await readJsonFile<SkillManifest>(manifestPath, root.directory, this.diagnostics, `skill:${path.basename(directory)}`);
        if (!manifest) continue;
        const validation = validateSkillManifest(manifest, directory);
        if (validation.length > 0) {
          this.diagnostics.push(...validation);
          continue;
        }
        if (seen.has(`${root.scope}:${manifest.id}`)) {
          this.diagnostics.push({ code: 'skill.duplicate', severity: 'error', message: `Duplicate skill id in ${root.scope} scope: ${manifest.id}`, source: manifestPath });
          continue;
        }
        seen.add(`${root.scope}:${manifest.id}`);
        const instructionFile = path.join(directory, manifest.instructionFile ?? 'SKILL.md');
        const text = await readBoundedText(instructionFile, directory, this.diagnostics, `skill:${manifest.id}`);
        if (!text) continue;
        skills.push({ manifest: { ...manifest, sourceScope: root.scope, enabled: manifest.enabled !== false }, directory, sourceScope: root.scope, instructionsFingerprint: fingerprint(text) });
      }
    }
    return skills.sort((left, right) => scopeRank(left.sourceScope) - scopeRank(right.sourceScope) || left.manifest.id.localeCompare(right.manifest.id));
  }

  async runSkill(id: string, args: Record<string, unknown>, mode: PlatformMode = 'agent'): Promise<{ status: 'ready' | 'blocked'; reason?: string; skill?: SkillDefinition }> {
    const skill = (await this.listSkills()).find(candidate => candidate.manifest.id === id);
    if (!skill) return { status: 'blocked', reason: `Unknown skill: ${id}` };
    if (skill.manifest.enabled === false) return { status: 'blocked', reason: `Skill is disabled: ${id}` };
    if (skill.manifest.allowedModes && !skill.manifest.allowedModes.includes(mode)) return { status: 'blocked', reason: `Skill ${id} is not allowed in ${mode} mode.` };
    const argErrors = validateArguments(args, skill.manifest.argumentsSchema);
    if (argErrors.length > 0) return { status: 'blocked', reason: argErrors.join('; ') };
    const missingMcp = (skill.manifest.requiredMcpServers ?? []).filter(serverId => this.trust.get(serverId) === undefined);
    if (missingMcp.length > 0) return { status: 'blocked', reason: `Missing required MCP server trust/configuration: ${missingMcp.join(', ')}` };
    return { status: 'ready', skill };
  }

  async listSlashCommands(): Promise<SlashCommandDefinition[]> {
    const roots = [
      { scope: 'user' as const, directory: path.join(this.paths.userRoot, 'commands') },
      { scope: 'repository' as const, directory: path.join(this.paths.workspaceRoot, '.ollama-agent', 'commands') },
    ];
    const commands: SlashCommandDefinition[] = [];
    for (const root of roots) {
      for (const file of await listFiles(root.directory, ['.md'])) {
        const content = await readBoundedText(file, root.directory, this.diagnostics, `command:${path.basename(file)}`);
        if (!content) continue;
        const parsed = parseFrontMatter(content);
        const id = String(parsed.metadata.id ?? path.basename(file, '.md'));
        if (!/^\/[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) {
          this.diagnostics.push({ code: 'command.invalidId', severity: 'error', message: `Invalid slash command id: ${id}`, source: file });
          continue;
        }
        commands.push({
          schemaVersion: 1,
          id,
          description: stringValue(parsed.metadata.description),
          argumentHint: stringValue(parsed.metadata.argumentHint),
          allowedModes: stringList(parsed.metadata.allowedModes) as PlatformMode[] | undefined,
          preferredAgentProfile: stringValue(parsed.metadata.preferredAgentProfile),
          requiredSkillIds: stringList(parsed.metadata.requiredSkillIds),
          requiredMcpServers: stringList(parsed.metadata.requiredMcpServers),
          enabled: parsed.metadata.enabled !== false,
          sourceScope: root.scope,
          instructions: parsed.body,
          fingerprint: fingerprint(parsed.body),
        });
      }
    }
    return commands.sort((left, right) => scopeRank(left.sourceScope) - scopeRank(right.sourceScope) || left.id.localeCompare(right.id));
  }

  parseSlashCommand(input: string): { id: string; args: Record<string, string>; rawArguments: string } | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return undefined;
    const [id, ...rest] = trimmed.split(/\s+/);
    if (!/^\/[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) throw new Error(`Invalid slash command: ${id}`);
    const rawArguments = rest.join(' ');
    const args: Record<string, string> = {};
    for (const token of rest) {
      const separator = token.indexOf('=');
      if (separator > 0) {
        args[token.slice(0, separator)] = token.slice(separator + 1);
      }
    }
    return { id, args, rawArguments };
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    const roots = [
      { scope: 'user' as const, directory: path.join(this.paths.userRoot, 'agents') },
      { scope: 'repository' as const, directory: path.join(this.paths.workspaceRoot, '.ollama-agent', 'agents') },
    ];
    const profiles = [...BUILTIN_PROFILES];
    for (const root of roots) {
      for (const file of await listFiles(root.directory, ['.json'])) {
        const profile = await readJsonFile<AgentProfile>(file, root.directory, this.diagnostics, `profile:${path.basename(file)}`);
        if (!profile) continue;
        const errors = validateAgentProfile(profile, file);
        if (errors.length > 0) {
          this.diagnostics.push(...errors);
          continue;
        }
        profiles.push({ ...profile, enabled: profile.enabled !== false, sourceScope: root.scope });
      }
    }
    const result = new Map<string, AgentProfile>();
    for (const profile of profiles.sort((left, right) => scopeRank(left.sourceScope ?? 'builtin') - scopeRank(right.sourceScope ?? 'builtin'))) {
      if (!result.has(profile.id)) result.set(profile.id, profile);
    }
    return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async resolveStageProfiles(config: Partial<Record<FixedMultiAgentStage, string>>): Promise<Record<FixedMultiAgentStage, AgentProfile>> {
    const profiles = await this.listAgentProfiles();
    const byId = new Map(profiles.map(profile => [profile.id, profile]));
    const defaults: Record<FixedMultiAgentStage, string> = {
      'repository-analyst': 'repository-analyst',
      planner: 'planner',
      implementer: 'implementer',
      reviewer: 'reviewer',
      validator: 'validator',
    };
    const resolved = {} as Record<FixedMultiAgentStage, AgentProfile>;
    for (const stage of Object.keys(defaults) as FixedMultiAgentStage[]) {
      const requested = config[stage] ?? defaults[stage];
      resolved[stage] = byId.get(requested) ?? byId.get(defaults[stage])!;
    }
    return resolved;
  }

  routeModel(request: RoutingRequest): RoutingDecision {
    const unavailable = new Set(request.unavailableModels ?? []);
    const providerType = request.providerType ?? 'ollama';
    const primary = request.model ?? defaultModelForRole(request.role);
    const fallbackChain = (request.fallbackModels ?? []).filter(Boolean).slice(0, 3);
    const attempts = [primary, ...fallbackChain];
    if (request.mutationStarted && unavailable.has(primary)) {
      throw new Error('Model fallback is not allowed after repository mutation has begun.');
    }
    const selected = attempts.find(model => !unavailable.has(model));
    if (!selected) throw new Error('No configured model is available.');
    return {
      providerType,
      model: selected,
      fallbackChain,
      fallbackReason: selected === primary ? undefined : `Primary model unavailable: ${primary}`,
      attempts: attempts.slice(0, attempts.indexOf(selected) + 1),
      evidence: {
        selectedProfileId: request.selectedProfileId,
        role: request.role,
        contextMetadata: 'estimated',
      },
    };
  }

  async listMcpServers(): Promise<Array<McpServerConfig & { trustState: TrustState }>> {
    const configs = await this.loadMcpConfigs();
    return configs.map(config => ({ ...config, trustState: this.trust.get(config.id) ?? 'untrusted' }));
  }

  trustMcpServer(id: string, state: TrustState): void {
    if (state === 'untrusted') this.trust.delete(id);
    else this.trust.set(id, state);
  }

  async listLocalExtensions(): Promise<LocalExtensionManifest[]> {
    const roots = [
      { scope: 'user' as const, directory: path.join(this.paths.userRoot, 'extensions') },
      { scope: 'repository' as const, directory: path.join(this.paths.workspaceRoot, '.ollama-agent', 'extensions') },
    ];
    const manifests: LocalExtensionManifest[] = [];
    for (const root of roots) {
      for (const directory of await listDirectories(root.directory)) {
        const file = path.join(directory, 'extension.json');
        const manifest = await readJsonFile<LocalExtensionManifest>(file, root.directory, this.diagnostics, `extension:${path.basename(directory)}`);
        if (!manifest) continue;
        const errors = validateExtensionManifest(manifest, directory);
        if (errors.length > 0) {
          this.diagnostics.push(...errors);
          continue;
        }
        manifests.push({ ...manifest, enabled: manifest.enabled !== false, sourceScope: root.scope, manifestFingerprint: fingerprint(JSON.stringify(manifest)) });
      }
    }
    return manifests.sort((left, right) => scopeRank(left.sourceScope ?? 'repository') - scopeRank(right.sourceScope ?? 'repository') || left.id.localeCompare(right.id));
  }

  forgeStatus(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      localOnly: true,
      explicitStartupRequired: true,
      toolCount: ToolRegistry.all().length,
      trustDecisions: [...this.trust.entries()].map(([id, state]) => ({ id, state })),
    };
  }

  private async collectUserInstructions(sources: InstructionSource[], diagnostics: PlatformDiagnostic[]): Promise<void> {
    const text = await readBoundedText(path.join(this.paths.userRoot, 'instructions.md'), this.paths.userRoot, diagnostics, 'user:instructions');
    if (text) sources.push(sourceFromText('user:instructions', 'user', this.paths.userRoot, 3, text));
  }

  private async collectRepositoryInstructions(sources: InstructionSource[], diagnostics: PlatformDiagnostic[], targetFiles: string[]): Promise<void> {
    for (const relative of REPOSITORY_INSTRUCTION_FILES) {
      const text = await readBoundedText(path.join(this.paths.workspaceRoot, relative), this.paths.workspaceRoot, diagnostics, `repo:${relative}`);
      if (text) sources.push(sourceFromText(`repo:${relative}`, 'repository', relative, 4, text));
    }
    for (const file of await listFiles(path.join(this.paths.workspaceRoot, '.cursor', 'rules'), ['.md', '.mdc'])) {
      const text = await readBoundedText(file, this.paths.workspaceRoot, diagnostics, `repo:${path.relative(this.paths.workspaceRoot, file)}`);
      if (text) sources.push(sourceFromText(`repo:${path.relative(this.paths.workspaceRoot, file).replace(/\\/g, '/')}`, 'repository', path.dirname(file), 4, text));
    }
    for (const file of await listNestedAgentFiles(this.paths.workspaceRoot)) {
      if (!targetFiles.some(target => isPathWithin(path.dirname(file), path.resolve(this.paths.workspaceRoot, target)))) continue;
      const text = await readBoundedText(file, this.paths.workspaceRoot, diagnostics, `repo:${path.relative(this.paths.workspaceRoot, file)}`);
      if (text) sources.push(sourceFromText(`repo:${path.relative(this.paths.workspaceRoot, file).replace(/\\/g, '/')}`, 'repository', path.dirname(file), 5, text));
    }
  }

  private async loadMcpConfigs(): Promise<McpServerConfig[]> {
    const configs: McpServerConfig[] = [];
    const candidates = [
      { scope: 'user' as const, file: path.join(this.paths.userRoot, 'mcp.json'), root: this.paths.userRoot },
      { scope: 'repository' as const, file: path.join(this.paths.workspaceRoot, '.ollama-agent', 'mcp.json'), root: this.paths.workspaceRoot },
    ];
    for (const candidate of candidates) {
      const content = await readJsonFile<{ servers?: McpServerConfig[] }>(candidate.file, candidate.root, this.diagnostics, `mcp:${candidate.scope}`);
      for (const server of content?.servers ?? []) {
        const errors = validateMcpServer(server, candidate.scope);
        if (errors.length > 0) {
          this.diagnostics.push(...errors);
          continue;
        }
        configs.push({ ...server, sourceScope: candidate.scope });
      }
    }
    return configs;
  }
}

async function readBoundedText(file: string, root: string, diagnostics: PlatformDiagnostic[], identity: string): Promise<string | undefined> {
  const resolved = await safeResolve(file, root, diagnostics, identity);
  if (!resolved) return undefined;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch {
    return undefined;
  }
  if (bytes.length > MAX_SOURCE_BYTES) {
    diagnostics.push({ code: 'source.tooLarge', severity: 'warning', message: 'M14 source exceeded per-source bound and was excluded.', source: identity, fingerprint: fingerprint(bytes) });
    return undefined;
  }
  if (bytes.includes(0)) {
    diagnostics.push({ code: 'source.binary', severity: 'warning', message: 'Binary M14 source was excluded.', source: identity, fingerprint: fingerprint(bytes) });
    return undefined;
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    diagnostics.push({ code: 'source.invalidUtf8', severity: 'warning', message: 'Non UTF-8 M14 source was excluded.', source: identity, fingerprint: fingerprint(bytes) });
    return undefined;
  }
}

async function readJsonFile<T>(file: string, root: string, diagnostics: PlatformDiagnostic[], identity: string): Promise<T | undefined> {
  const text = await readBoundedText(file, root, diagnostics, identity);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    diagnostics.push({ code: 'json.invalid', severity: 'error', message: 'Invalid JSON manifest/configuration was excluded.', source: identity, fingerprint: fingerprint(text) });
    return undefined;
  }
}

async function safeResolve(file: string, root: string, diagnostics: PlatformDiagnostic[], identity: string): Promise<string | undefined> {
  if (path.isAbsolute(path.relative(root, file)) || path.relative(root, file).startsWith('..')) {
    diagnostics.push({ code: 'path.escape', severity: 'error', message: 'Path escape was rejected.', source: identity });
    return undefined;
  }
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(file);
    if (!isPathWithin(realRoot, realFile)) {
      diagnostics.push({ code: 'path.symlinkEscape', severity: 'error', message: 'Symlink escape was rejected.', source: identity });
      return undefined;
    }
    return realFile;
  } catch {
    return path.resolve(file);
  }
}

async function listFiles(root: string, extensions: string[]): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Array<import('fs').Dirent>;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) result.push(full);
    }
  }
  return result.sort();
}

async function listDirectories(root: string): Promise<string[]> {
  let entries: Array<import('fs').Dirent>;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)).sort();
}

async function listNestedAgentFiles(workspaceRoot: string): Promise<string[]> {
  const all = await listFiles(workspaceRoot, ['.md']);
  return all.filter(file => path.basename(file) === 'AGENTS.md' && path.dirname(file) !== workspaceRoot);
}

function sourceFromText(identity: string, sourceScope: PlatformSourceScope, scopePath: string, precedence: number, text: string): InstructionSource {
  return { identity, sourceScope, scopePath, precedence, fingerprint: fingerprint(text), bytes: Buffer.byteLength(text, 'utf8'), text };
}

function inMemorySource(identity: string, sourceScope: PlatformSourceScope, precedence: number, text: string): InstructionSource {
  return sourceFromText(identity, sourceScope, identity, precedence, text);
}

function fingerprint(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isPathWithin(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateSkillManifest(manifest: SkillManifest, directory: string): PlatformDiagnostic[] {
  const diagnostics: PlatformDiagnostic[] = [];
  if (manifest.schemaVersion !== 1) diagnostics.push({ code: 'skill.schema', severity: 'error', message: 'Unsupported skill schemaVersion.', source: directory });
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(manifest.id ?? '')) diagnostics.push({ code: 'skill.id', severity: 'error', message: 'Invalid skill id.', source: directory });
  const instructionFile = manifest.instructionFile ?? 'SKILL.md';
  if (path.isAbsolute(instructionFile) || instructionFile.includes('..')) diagnostics.push({ code: 'skill.path', severity: 'error', message: 'Skill instruction file must stay inside the skill directory.', source: directory });
  if (containsExecutableField(manifest)) diagnostics.push({ code: 'skill.executable', severity: 'error', message: 'Skill manifests cannot define executable fields.', source: directory });
  if (containsSecret(manifest)) diagnostics.push({ code: 'skill.secret', severity: 'error', message: 'Skill manifests cannot contain embedded secrets.', source: directory });
  return diagnostics;
}

function validateAgentProfile(profile: AgentProfile, source: string): PlatformDiagnostic[] {
  const diagnostics: PlatformDiagnostic[] = [];
  if (profile.schemaVersion !== 1) diagnostics.push({ code: 'profile.schema', severity: 'error', message: 'Unsupported profile schemaVersion.', source });
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(profile.id ?? '')) diagnostics.push({ code: 'profile.id', severity: 'error', message: 'Invalid profile id.', source });
  if (profile.permissionProfileId && !['read-only', 'default', 'trusted-autonomy'].includes(profile.permissionProfileId)) diagnostics.push({ code: 'profile.permission', severity: 'error', message: `Unknown permission profile: ${profile.permissionProfileId}`, source });
  if (containsExecutableField(profile)) diagnostics.push({ code: 'profile.executable', severity: 'error', message: 'Profiles cannot contain executable code fields.', source });
  if (containsSecret(profile)) diagnostics.push({ code: 'profile.secret', severity: 'error', message: 'Profiles cannot contain secrets.', source });
  return diagnostics;
}

function validateMcpServer(server: McpServerConfig, scope: PlatformSourceScope): PlatformDiagnostic[] {
  const diagnostics: PlatformDiagnostic[] = [];
  if (server.schemaVersion !== 1) diagnostics.push({ code: 'mcp.schema', severity: 'error', message: 'Unsupported MCP server schemaVersion.', source: server.id });
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(server.id ?? '')) diagnostics.push({ code: 'mcp.id', severity: 'error', message: 'Invalid MCP server id.', source: server.id });
  if (scope === 'repository' && server.trustRequirement && server.trustRequirement !== 'untrusted') diagnostics.push({ code: 'mcp.repoTrust', severity: 'error', message: 'Repository MCP configuration cannot mark itself trusted.', source: server.id });
  if (containsSecret(server)) diagnostics.push({ code: 'mcp.secret', severity: 'error', message: 'Repository MCP configuration cannot contain raw secrets.', source: server.id });
  return diagnostics;
}

function validateExtensionManifest(manifest: LocalExtensionManifest, directory: string): PlatformDiagnostic[] {
  const diagnostics: PlatformDiagnostic[] = [];
  if (manifest.schemaVersion !== 1) diagnostics.push({ code: 'extension.schema', severity: 'error', message: 'Unsupported extension schemaVersion.', source: directory });
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(manifest.id ?? '')) diagnostics.push({ code: 'extension.id', severity: 'error', message: 'Invalid extension id.', source: directory });
  if (containsExecutableField(manifest)) diagnostics.push({ code: 'extension.executable', severity: 'error', message: 'Extension manifests cannot contribute executable code.', source: directory });
  const contributions = manifest.contributions ?? {};
  for (const values of Object.values(contributions)) {
    for (const value of values ?? []) {
      if (path.isAbsolute(value) || value.includes('..')) diagnostics.push({ code: 'extension.path', severity: 'error', message: 'Extension contribution path escape was rejected.', source: directory });
    }
  }
  return diagnostics;
}

function containsExecutableField(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return /"((command)|(script)|(executable)|(powershell)|(shell)|(javascript)|(typescript)|(binary)|(hook))"/.test(text);
}

function containsSecret(value: unknown): boolean {
  return /(api[_-]?key|token|secret|password)\s*["':=]/i.test(JSON.stringify(value));
}

function validateArguments(args: Record<string, unknown>, schema?: JsonSchema): string[] {
  if (!schema) return [];
  if (schema.type && schema.type !== 'object') return ['Skill arguments schema must be an object schema.'];
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [];
  return required.filter(key => !(key in args)).map(key => `Missing required skill argument: ${key}`);
}

function parseFrontMatter(content: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) return { metadata: {}, body: normalized.trim() };
  const lines = normalized.split(/\r?\n/);
  const metadata: Record<string, unknown> = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') { index += 1; break; }
    const separator = lines[index].indexOf(':');
    if (separator <= 0) continue;
    const key = lines[index].slice(0, separator).trim();
    const raw = lines[index].slice(separator + 1).trim();
    metadata[key] = raw === 'true' ? true : raw === 'false' ? false : raw.includes(',') ? raw.split(',').map(item => item.trim()).filter(Boolean) : raw;
  }
  return { metadata, body: lines.slice(index).join('\n').trim() };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return [value];
  return undefined;
}

function scopeRank(scope: PlatformSourceScope): number {
  return scope === 'builtin' ? 0 : scope === 'user' ? 1 : scope === 'repository' ? 2 : 3;
}

function defaultModelForRole(role: AgentProfile['baseRole']): string {
  return role === 'general-chat' ? 'qwen2.5-coder:14b' : 'qwen3-coder:30b';
}

function cloneInstructions(value: EffectiveInstructions): EffectiveInstructions {
  return {
    text: value.text,
    sources: value.sources.map(source => ({ ...source })),
    diagnostics: value.diagnostics.map(diagnostic => ({ ...diagnostic })),
  };
}
