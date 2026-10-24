import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentMode } from '../tools/ToolTypes';
import { ExternalToolRisk, PolicyDecision, PolicyEngine } from '../policy/PolicyEngine';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ExternalToolRisk;
}

export interface McpServerDefinition {
  id: string;
  displayName: string;
  transport: 'stdio' | 'http' | 'in-process';
  location: 'local' | 'remote';
  enabled: boolean;
  tools: McpToolDefinition[];
}

export interface McpTransport {
  invoke(
    server: Readonly<McpServerDefinition>,
    tool: Readonly<McpToolDefinition>,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface McpApprovalRequest {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  decision: PolicyDecision;
}

export type McpApproval = (request: McpApprovalRequest) => Promise<boolean>;

export interface McpInvocationRecord {
  schemaVersion: 1;
  invocationId: string;
  serverId: string;
  toolName: string;
  action: PolicyDecision['action'];
  status: 'completed' | 'failed' | 'denied' | 'cancelled';
  startedAt: string;
  completedAt: string;
  error?: string;
}

export interface McpAuditStorage {
  append(record: McpInvocationRecord): Promise<void>;
}

export interface McpRegistryOptions {
  approval?: McpApproval;
  auditStorage?: McpAuditStorage;
}

function nowIso(): string {
  return new Date().toISOString();
}

function invocationId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validateName(label: string, value: string): void {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function cloneServer(server: McpServerDefinition): McpServerDefinition {
  return {
    ...server,
    tools: server.tools.map(tool => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
      risk: { ...tool.risk },
    })),
  };
}

export class FileMcpAuditStorage implements McpAuditStorage {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  append(record: McpInvocationRecord): Promise<void> {
    const write = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      await fs.appendFile(this.filename, `${JSON.stringify(record)}\n`, 'utf8');
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}

export class McpRegistry {
  private readonly servers = new Map<string, McpServerDefinition>();
  private readonly transports = new Map<string, McpTransport>();
  private readonly approval?: McpApproval;
  private readonly auditStorage?: McpAuditStorage;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly policy: PolicyEngine,
    options: McpRegistryOptions = {},
  ) {
    this.approval = options.approval;
    this.auditStorage = options.auditStorage;
  }

  register(server: McpServerDefinition, transport: McpTransport): void {
    validateName('MCP server id', server.id);
    if (this.servers.has(server.id)) {
      throw new Error(`MCP server is already registered: ${server.id}`);
    }
    const toolNames = new Set<string>();
    for (const tool of server.tools) {
      validateName('MCP tool name', tool.name);
      if (toolNames.has(tool.name)) {
        throw new Error(`Duplicate MCP tool ${tool.name} on server ${server.id}.`);
      }
      toolNames.add(tool.name);
      if (server.location === 'remote' && !tool.risk.network) {
        throw new Error(`Remote MCP tool ${server.id}.${tool.name} must declare network risk.`);
      }
      if (tool.risk.readOnly && tool.risk.mutating) {
        throw new Error(`MCP tool ${server.id}.${tool.name} cannot be both read-only and mutating.`);
      }
    }
    this.servers.set(server.id, cloneServer(server));
    this.transports.set(server.id, transport);
  }

  unregister(serverId: string): boolean {
    this.transports.delete(serverId);
    return this.servers.delete(serverId);
  }

  listServers(): McpServerDefinition[] {
    return [...this.servers.values()].map(cloneServer).sort((left, right) => left.id.localeCompare(right.id));
  }

  listTools(serverId?: string): Array<{ serverId: string; tool: McpToolDefinition }> {
    const selected = serverId ? [this.requireServer(serverId)] : [...this.servers.values()];
    return selected
      .flatMap(server => server.tools.map(tool => ({
        serverId: server.id,
        tool: { ...tool, inputSchema: { ...tool.inputSchema }, risk: { ...tool.risk } },
      })))
      .sort((left, right) => `${left.serverId}.${left.tool.name}`.localeCompare(`${right.serverId}.${right.tool.name}`));
  }

  async invoke(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    mode: AgentMode = 'agent',
  ): Promise<unknown> {
    const server = this.requireServer(serverId);
    if (!server.enabled) {
      throw new Error(`MCP server is disabled: ${serverId}`);
    }
    const tool = server.tools.find(value => value.name === toolName);
    if (!tool) {
      throw new Error(`Unknown MCP tool: ${serverId}.${toolName}`);
    }
    const transport = this.transports.get(serverId);
    if (!transport) {
      throw new Error(`MCP transport is unavailable: ${serverId}`);
    }

    const qualifiedName = `mcp:${serverId}:${toolName}`;
    const decision = this.policy.evaluateExternalTool(qualifiedName, args, tool.risk, mode);
    const id = invocationId();
    const startedAt = nowIso();
    if (decision.action === 'deny') {
      await this.auditStorage?.append({
        schemaVersion: 1,
        invocationId: id,
        serverId,
        toolName,
        action: decision.action,
        status: 'denied',
        startedAt,
        completedAt: nowIso(),
        error: decision.reason,
      });
      throw new Error(decision.reason);
    }
    if (decision.action === 'ask-once') {
      const approved = await this.approval?.({ serverId, toolName, args: { ...args }, decision });
      if (!approved) {
        this.policy.recordRejection(decision.fingerprint);
        await this.auditStorage?.append({
          schemaVersion: 1,
          invocationId: id,
          serverId,
          toolName,
          action: decision.action,
          status: 'denied',
          startedAt,
          completedAt: nowIso(),
          error: 'MCP invocation was not approved.',
        });
        throw new Error('MCP invocation was not approved.');
      }
    }

    const controller = new AbortController();
    this.activeControllers.set(id, controller);
    try {
      const result = await transport.invoke(server, tool, args, controller.signal);
      await this.auditStorage?.append({
        schemaVersion: 1,
        invocationId: id,
        serverId,
        toolName,
        action: decision.action,
        status: 'completed',
        startedAt,
        completedAt: nowIso(),
      });
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      await this.auditStorage?.append({
        schemaVersion: 1,
        invocationId: id,
        serverId,
        toolName,
        action: decision.action,
        status: cancelled ? 'cancelled' : 'failed',
        startedAt,
        completedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.activeControllers.delete(id);
    }
  }

  cancelAll(): void {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  private requireServer(serverId: string): McpServerDefinition {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }
}
