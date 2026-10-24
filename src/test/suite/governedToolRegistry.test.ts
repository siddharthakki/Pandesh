import { describe, expect, it } from 'vitest';
import {
  FORGE_INVOKE_MODEL_DESCRIPTOR,
  FORGE_INVOCATION_START_DESCRIPTOR,
  FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR,
  ReadOnlyForgeCallableRegistry,
} from '../../agent/ForgeCallableSurface';
import {
  GovernedToolDefinition,
  GovernedToolRegistry,
} from '../../tools/GovernedToolRegistry';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { listPermissionProfiles } from '../../tools/PermissionProfiles';

describe('governed tool registry and permission authorization', () => {
  it('registers and lists tools deterministically', () => {
    const registry = new GovernedToolRegistry();
    registry.register(definition('zeta', 'workspace-read', ['workspace.read']));
    registry.register(definition('alpha', 'workspace-read', ['workspace.read']));

    expect(registry.list().map(tool => tool.id)).toEqual(['alpha', 'zeta']);
    expect(registry.resolve('alpha')?.name).toBe('alpha');
  });

  it('rejects duplicate tool identifiers', () => {
    const registry = new GovernedToolRegistry();
    registry.register(definition('same', 'workspace-read', ['workspace.read']));
    expect(() => registry.register(definition('same', 'workspace-read', ['workspace.read']))).toThrow('already registered');
  });

  it('rejects unknown tools with a typed result', () => {
    const registry = new GovernedToolRegistry();
    expect(registry.authorize('missing', { profiles: ['workspace-read'] })).toEqual({
      ok: false,
      code: 'unknown_tool',
      toolId: 'missing',
    });
  });

  it('allows read-only tools under a read-only profile', () => {
    const result = ToolRegistry.authorizeGoverned('agent.read_file', { profiles: ['workspace-read'] });
    expect(result).toMatchObject({ ok: true, code: 'allowed', toolId: 'agent.read_file' });
  });

  it('rejects mutation tools without mutation permission', () => {
    const result = ToolRegistry.authorizeGoverned('agent.write_file', {
      profiles: ['workspace-read'],
      approvalGranted: true,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'missing_permission',
      toolId: 'agent.write_file',
      missingCapabilities: ['workspace.write'],
    });
  });

  it('allows mutation tools with mutation permission and approval state', () => {
    const result = ToolRegistry.authorizeGoverned('agent.write_file', {
      profiles: ['workspace-mutate'],
      approvalGranted: true,
    });
    expect(result).toMatchObject({ ok: true, code: 'allowed', toolId: 'agent.write_file' });
  });

  it('returns approval required separately from missing permission', () => {
    const result = ToolRegistry.authorizeGoverned('agent.write_file', {
      profiles: ['workspace-mutate'],
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'approval_required',
      toolId: 'agent.write_file',
    });
  });

  it('does not expose mutable registry metadata', () => {
    const first = ToolRegistry.resolveGoverned('agent.read_file');
    expect(first).toBeDefined();
    if (!first) {
      throw new Error('missing governed read_file');
    }
    expect(() => {
      (first.requiredCapabilities as string[]).push('workspace.write');
    }).toThrow();
    const second = ToolRegistry.resolveGoverned('agent.read_file');
    expect(second?.requiredCapabilities).toEqual(['workspace.read']);
  });

  it('exposes correct production tool permission metadata', () => {
    const tools = ToolRegistry.governed();
    expect(tools.map(tool => tool.id)).toEqual([...tools.map(tool => tool.id)].sort());
    expect(ToolRegistry.resolveGoverned('agent.read_file')).toMatchObject({
      permissionProfile: 'workspace-read',
      sideEffect: 'none',
      readOnly: true,
      approvalRequired: false,
      riskLevel: 'safe',
    });
    expect(ToolRegistry.resolveGoverned('agent.run_command')).toMatchObject({
      permissionProfile: 'process-validation',
      sideEffect: 'process-execution',
      approvalRequired: true,
      riskLevel: 'high',
    });
  });

  it('registers Forge callables as governed tools with existing side-effect metadata', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR, async request => ({
      ok: false,
      method: request.method,
      error: { code: 'not_found', message: 'unused' },
    }));
    registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, async request => ({
      ok: false,
      method: request.method,
      error: { code: 'not_found', message: 'unused' },
    }));
    registry.register(FORGE_INVOCATION_START_DESCRIPTOR, async request => ({
      ok: false,
      method: request.method,
      error: { code: 'not_found', message: 'unused' },
    }));

    expect(registry.discoverGovernedTools().map(tool => tool.id)).toEqual([
      'forge.forge.invocation.invokeModel',
      'forge.forge.invocation.start',
      'forge.forge.scheduler.snapshot',
    ]);
    expect(registry.authorizeGovernedTool('forge.forge.scheduler.snapshot', { profiles: ['workspace-read'] }))
      .toMatchObject({ ok: true, code: 'allowed' });
    expect(registry.authorizeGovernedTool('forge.forge.invocation.invokeModel', { profiles: ['model-provider-access'] }))
      .toMatchObject({ ok: false, code: 'approval_required' });
    expect(registry.authorizeGovernedTool('forge.forge.invocation.invokeModel', {
      profiles: ['model-provider-access'],
      approvalGranted: true,
    })).toMatchObject({ ok: true, code: 'allowed' });
    expect(registry.authorizeGovernedTool('forge.forge.invocation.start', {
      profiles: ['workspace-read'],
      approvalGranted: true,
    })).toMatchObject({ ok: false, code: 'missing_permission', missingCapabilities: ['task.lifecycle'] });
  });

  it('defines immutable deterministic permission profiles', () => {
    const profiles = listPermissionProfiles();
    expect(profiles.map(profile => profile.id)).toEqual([...profiles.map(profile => profile.id)].sort());
    expect(() => {
      (profiles[0].capabilities as string[]).push('workspace.write');
    }).toThrow();
  });
});

function definition(
  id: string,
  permissionProfile: GovernedToolDefinition['permissionProfile'],
  requiredCapabilities: GovernedToolDefinition['requiredCapabilities'],
): GovernedToolDefinition {
  return {
    id,
    name: id,
    description: id,
    surface: 'agent-tool',
    inputContract: { type: 'object' },
    outputContract: { type: 'ToolResult' },
    sideEffect: 'none',
    permissionProfile,
    requiredCapabilities,
    runtime: { transport: 'in-process', identity: id, version: '1' },
    approvalRequired: false,
    elevationRequired: false,
    readOnly: true,
  };
}
