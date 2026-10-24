import { describe, expect, it } from 'vitest';
import { McpRegistry, McpServerDefinition, McpTransport } from '../../mcp/McpRegistry';
import { PolicyEngine } from '../../policy/PolicyEngine';

const transport: McpTransport = {
  invoke: async (_server, tool, args) => ({ tool: tool.name, args }),
};

function localServer(): McpServerDefinition {
  return {
    id: 'local-docs',
    displayName: 'Local Docs',
    transport: 'in-process',
    location: 'local',
    enabled: true,
    tools: [{
      name: 'search',
      description: 'Search local documentation',
      inputSchema: { type: 'object' },
      risk: { readOnly: true, mutating: false, network: false },
    }],
  };
}

describe('Phase 20 MCP registry', () => {
  it('allows explicitly classified local read-only tools', async () => {
    const registry = new McpRegistry(new PolicyEngine());
    registry.register(localServer(), transport);

    const result = await registry.invoke('local-docs', 'search', { query: 'task graph' });
    expect(result).toEqual({ tool: 'search', args: { query: 'task graph' } });
  });

  it('requires remote tools to declare network risk', () => {
    const registry = new McpRegistry(new PolicyEngine());
    const server = localServer();
    server.id = 'remote-docs';
    server.location = 'remote';

    expect(() => registry.register(server, transport)).toThrow(/network risk/i);
  });

  it('asks before network access and remembers rejection', async () => {
    let approvals = 0;
    const registry = new McpRegistry(new PolicyEngine(), {
      approval: async () => {
        approvals += 1;
        return false;
      },
    });
    registry.register({
      id: 'remote-docs',
      displayName: 'Remote Docs',
      transport: 'http',
      location: 'remote',
      enabled: true,
      tools: [{
        name: 'search',
        description: 'Search a remote documentation service',
        inputSchema: { type: 'object' },
        risk: { readOnly: true, mutating: false, network: true },
      }],
    }, transport);

    await expect(registry.invoke('remote-docs', 'search', { query: 'one' })).rejects.toThrow(/not approved/i);
    await expect(registry.invoke('remote-docs', 'search', { query: 'one' })).rejects.toThrow(/previously rejected/i);
    expect(approvals).toBe(1);
  });

  it('blocks destructive external tools before transport execution', async () => {
    let invoked = false;
    const registry = new McpRegistry(new PolicyEngine());
    registry.register({
      id: 'dangerous',
      displayName: 'Dangerous',
      transport: 'in-process',
      location: 'local',
      enabled: true,
      tools: [{
        name: 'destroy',
        description: 'Destructive operation',
        inputSchema: { type: 'object' },
        risk: { readOnly: false, mutating: true, network: false, destructive: true },
      }],
    }, {
      invoke: async () => {
        invoked = true;
        return null;
      },
    });

    await expect(registry.invoke('dangerous', 'destroy', {})).rejects.toThrow(/blocked/i);
    expect(invoked).toBe(false);
  });
});
