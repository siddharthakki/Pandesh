import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { M14Platform } from '../../platform/M14Platform';

describe('M14 customizable agent platform', () => {
  let workspaceRoot: string;
  let userRoot: string;
  let platform: M14Platform;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m14-workspace-'));
    userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m14-user-'));
    platform = new M14Platform({ workspaceRoot, userRoot });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(userRoot, { recursive: true, force: true });
  });

  it('resolves deterministic instruction precedence and nested AGENTS.md scoping', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'src', 'feature'), { recursive: true });
    await fs.writeFile(path.join(userRoot, 'instructions.md'), 'user-level', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'AGENTS.md'), 'root-level', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'src', 'AGENTS.md'), 'nested-level', 'utf8');

    const effective = await platform.resolveInstructions({ targetFiles: ['src/feature/example.ts'], task: 'current task' });
    const identities = effective.sources.map(source => source.identity);

    expect(identities).toEqual([
      'host-safety',
      'managed-policy',
      'user:instructions',
      'repo:AGENTS.md',
      'repo:src/AGENTS.md',
      'current-user-task',
    ]);
  });

  it('excludes oversized, binary, and symlink-escaped instruction sources without logging raw text', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'AGENTS.md'), Buffer.alloc(70 * 1024, 'x'));
    await fs.writeFile(path.join(userRoot, 'instructions.md'), Buffer.from([0, 1, 2, 3]));

    const effective = await platform.resolveInstructions();

    expect(effective.sources.map(source => source.identity)).toEqual(['host-safety', 'managed-policy']);
    expect(effective.diagnostics.map(diagnostic => diagnostic.code)).toContain('source.tooLarge');
    expect(effective.diagnostics.map(diagnostic => diagnostic.code)).toContain('source.binary');
    expect(JSON.stringify(effective.diagnostics)).not.toContain('xxxx');
  });

  it('discovers repository and user skills, validates arguments, and blocks disabled or missing MCP requirements', async () => {
    await writeSkill(userRoot, 'user-skill', { required: ['target'] });
    await writeSkill(workspaceRoot, 'repo-skill', undefined, { enabled: false });
    await writeSkill(workspaceRoot, 'mcp-skill', undefined, { requiredMcpServers: ['docs'] });

    const skills = await platform.listSkills();
    expect(skills.map(skill => skill.manifest.id)).toEqual(['user-skill', 'mcp-skill', 'repo-skill']);
    await expect(platform.runSkill('user-skill', {})).resolves.toMatchObject({ status: 'blocked' });
    await expect(platform.runSkill('repo-skill', {})).resolves.toMatchObject({ status: 'blocked' });
    await expect(platform.runSkill('mcp-skill', {})).resolves.toMatchObject({ status: 'blocked' });
    platform.trustMcpServer('docs', 'trusted-readonly');
    await expect(platform.runSkill('mcp-skill', {})).resolves.toMatchObject({ status: 'ready' });
  });

  it('parses slash command arguments deterministically and keeps shell metacharacters as plain text', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.ollama-agent', 'commands'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, '.ollama-agent', 'commands', 'review.md'), [
      '---',
      'schemaVersion: 1',
      'id: /run-secure-refactor',
      'description: Review safely',
      '---',
      'Review the target.',
    ].join('\n'), 'utf8');

    const commands = await platform.listSlashCommands();
    const parsed = platform.parseSlashCommand('/run-secure-refactor target=src/a.ts extra=$(rm -rf .)');

    expect(commands[0].id).toBe('/run-secure-refactor');
    expect(parsed?.args.target).toBe('src/a.ts');
    expect(parsed?.rawArguments).toContain('$(rm');
  });

  it('retains built-in profiles, rejects invalid permission profiles, and resolves M13 stage profiles safely', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.ollama-agent', 'agents'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, '.ollama-agent', 'agents', 'custom.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'custom-planner',
      displayName: 'Custom Planner',
      baseRole: 'planner',
      model: 'local-planner',
      permissionProfileId: 'read-only',
    }), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, '.ollama-agent', 'agents', 'bad.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'bad',
      displayName: 'Bad',
      baseRole: 'planner',
      permissionProfileId: 'root',
    }), 'utf8');

    const profiles = await platform.listAgentProfiles();
    const stages = await platform.resolveStageProfiles({ planner: 'custom-planner', reviewer: 'missing' });

    expect(profiles.map(profile => profile.id)).toContain('coding-agent');
    expect(profiles.map(profile => profile.id)).toContain('custom-planner');
    expect(profiles.map(profile => profile.id)).not.toContain('bad');
    expect(stages.planner.id).toBe('custom-planner');
    expect(stages.reviewer.id).toBe('reviewer');
  });

  it('routes provider models with visible bounded fallback and blocks fallback after mutation begins', () => {
    const decision = platform.routeModel({
      role: 'implementer',
      model: 'primary',
      fallbackModels: ['fallback-a', 'fallback-b', 'fallback-c', 'ignored'],
      unavailableModels: ['primary'],
      selectedProfileId: 'implementer',
    });

    expect(decision.model).toBe('fallback-a');
    expect(decision.fallbackReason).toContain('Primary model unavailable');
    expect(decision.fallbackChain).toEqual(['fallback-a', 'fallback-b', 'fallback-c']);
    expect(() => platform.routeModel({
      role: 'implementer',
      model: 'primary',
      fallbackModels: ['fallback-a'],
      unavailableModels: ['primary'],
      mutationStarted: true,
    })).toThrow(/mutation/i);
  });

  it('keeps repository MCP servers untrusted and rejects repository self-trust and secrets', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.ollama-agent'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, '.ollama-agent', 'mcp.json'), JSON.stringify({
      servers: [{
        schemaVersion: 1,
        id: 'docs',
        transport: 'stdio',
        command: 'node',
        trustRequirement: 'trusted-governed',
      }, {
        schemaVersion: 1,
        id: 'secret-docs',
        transport: 'stdio',
        command: 'node',
        token: 'secret',
      }],
    }), 'utf8');

    const servers = await platform.listMcpServers();

    expect(servers).toEqual([]);
    expect(platform.getDiagnostics().map(diagnostic => diagnostic.code)).toContain('mcp.repoTrust');
    expect(platform.getDiagnostics().map(diagnostic => diagnostic.code)).toContain('mcp.secret');
  });

  it('rejects executable local extension manifest fields and accepts declarative contributions', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.ollama-agent', 'extensions', 'good'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, '.ollama-agent', 'extensions', 'bad'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, '.ollama-agent', 'extensions', 'good', 'extension.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'good',
      version: '1.0.0',
      contributions: { skills: ['skills'] },
    }), 'utf8');
    await fs.writeFile(path.join(workspaceRoot, '.ollama-agent', 'extensions', 'bad', 'extension.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'bad',
      version: '1.0.0',
      script: 'npm run bad',
    }), 'utf8');

    const extensions = await platform.listLocalExtensions();

    expect(extensions.map(extension => extension.id)).toEqual(['good']);
    expect(platform.getDiagnostics().map(diagnostic => diagnostic.code)).toContain('extension.executable');
  });
});

async function writeSkill(root: string, id: string, argumentsSchema?: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
  const directory = path.join(root, root.includes('oa-m14-user') ? 'skills' : path.join('.ollama-agent', 'skills'), id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'skill.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    displayName: id,
    instructionFile: 'SKILL.md',
    argumentsSchema: argumentsSchema ? { type: 'object', ...argumentsSchema } : undefined,
    ...extra,
  }), 'utf8');
  await fs.writeFile(path.join(directory, 'SKILL.md'), `Instructions for ${id}`, 'utf8');
}
