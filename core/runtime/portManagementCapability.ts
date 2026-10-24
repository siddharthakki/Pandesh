import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { createPortProcessManager, type PortProcessManager } from './portManager';

export interface PortManagementCapabilityOptions {
  manager?: PortProcessManager;
  dataDir?: string;
}

const READ_ONLY_TOOLS = new Set([
  'port_list_services',
  'port_service_health',
  'port_check_setup',
]);

export function createPortManagementCapabilityAdapter(options: PortManagementCapabilityOptions = {}): GovernedCapabilityAdapter {
  const manager = options.manager ?? createPortProcessManager({ dataDir: options.dataDir ?? process.cwd() });

  function failure(output: string, category: string): ToolExecutionResult {
    return { status: 'failed', exitCode: null, output, resultCategory: category };
  }

  async function listServices(): Promise<ToolExecutionResult> {
    const rows = manager.list();
    if (rows.length === 0) return { status: 'succeeded', exitCode: 0, output: '(no managed services)', resultCategory: 'port_services_listed' };
    const lines = rows.map((r) =>
      `${r.name}: port ${r.port}, pid ${r.pid ?? 'n/a'}, owned=${r.ownedByPandesh}, status=${r.status}${r.lastError ? ` (${r.lastError})` : ''}`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n'), resultCategory: 'port_services_listed' };
  }

  function nonEmptyString(value: unknown, maxChars = 120): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed && trimmed.length <= maxChars ? trimmed : null;
  }

  async function allocate(call: ModelToolCall): Promise<ToolExecutionResult> {
    const name = nonEmptyString(call.arguments.serviceName ?? call.arguments.name);
    if (!name) return failure('serviceName is required', 'invalid_arguments');
    const preferred = typeof call.arguments.preferredPort === 'number' ? call.arguments.preferredPort : null;
    let port: number;
    if (preferred && preferred > 0 && preferred <= 65535) {
      const available = await manager.isPortAvailable(preferred);
      if (!available) return failure(`port ${preferred} is already in use`, 'port_unavailable');
      port = preferred;
    } else {
      port = await manager.allocatePort();
    }
    const pid = typeof call.arguments.pid === 'number' ? call.arguments.pid : null;
    const owned = call.arguments.ownedByPandesh === true || pid !== null;
    const executable = typeof call.arguments.executable === 'string' ? call.arguments.executable : null;
    const healthUrl = typeof call.arguments.healthUrl === 'string' ? call.arguments.healthUrl : null;
    const rec = manager.register({ name, port, pid, ownedByPandesh: owned, executable, healthUrl });
    return {
      status: 'succeeded', exitCode: 0,
      output: `Allocated port ${port} for service '${name}' (pid ${pid ?? 'n/a'})`,
      resultCategory: 'port_allocated',
      normalizedArguments: { serviceName: name, port, pid },
    };
  }

  async function health(call: ModelToolCall): Promise<ToolExecutionResult> {
    const name = nonEmptyString(call.arguments.serviceName ?? call.arguments.name);
    if (!name) return failure('serviceName is required', 'invalid_arguments');
    const r = await manager.healthCheck(name);
    return {
      status: r.healthy ? 'succeeded' : 'failed',
      exitCode: r.healthy ? 0 : 1,
      output: r.healthy ? `Service '${name}' is healthy` : `Service '${name}' is unhealthy: ${r.reason ?? 'unknown'}`,
      resultCategory: r.healthy ? 'port_service_healthy' : 'port_service_unhealthy',
      normalizedArguments: { serviceName: name },
    };
  }

  async function stop(call: ModelToolCall): Promise<ToolExecutionResult> {
    const name = nonEmptyString(call.arguments.serviceName ?? call.arguments.name);
    if (!name) return failure('serviceName is required', 'invalid_arguments');
    const r = await manager.stopOwned(name);
    if (!r.stopped) return failure(r.reason ?? 'could not stop', 'port_stop_failed');
    return { status: 'succeeded', exitCode: 0, output: `Stopped owned service '${name}'`, resultCategory: 'port_service_stopped', normalizedArguments: { serviceName: name } };
  }

  async function cleanup(call: ModelToolCall): Promise<ToolExecutionResult> {
    const killOrphans = call.arguments.killOrphans === true;
    const r = await manager.cleanupOrphans({ killOrphans });
    const lines = [
      `removed stale records: ${r.removed.join(', ') || '(none)'}`,
      `killed owned orphans: ${r.killed.join(', ') || '(none)'}`,
      `kept: ${r.kept.join(', ') || '(none)'}`,
    ];
    if (r.refused.length) {
      lines.push(`refused (ownership not proven): ${r.refused.join(', ')}`);
    }
    if (r.errors.length) lines.push(`errors: ${r.errors.join('; ')}`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n'), resultCategory: 'port_cleanup_done', normalizedArguments: { killOrphans } };
  }

  async function checkSetup(): Promise<ToolExecutionResult> {
    const services = manager.list();
    const lines: string[] = [];
    lines.push(`Managed services: ${services.length}`);
    const stopped: string[] = [];
    for (const s of services) {
      const h = await manager.healthCheck(s.name);
      lines.push(`- ${s.name}: port ${s.port}, pid ${s.pid ?? 'n/a'}, owned=${s.ownedByPandesh}, ${h.healthy ? 'healthy' : 'unhealthy: ' + (h.reason ?? '')}`);
      if (!h.healthy) stopped.push(s.name);
    }
    // A diagnostic must not mutate: the stale records are REPORTED here, and
    // only the explicit `port_cleanup_orphans` tool removes them.
    if (stopped.length) lines.push(`Not healthy (run port_cleanup_orphans to reconcile): ${stopped.join(', ')}`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n'), resultCategory: 'port_setup_checked' };
  }

  return {
    id: 'port-management',
    definitions: () => [
      { name: 'port_list_services', description: 'List Pandesh-managed services with their ports, PIDs, ownership and health status. Read-only.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'port_allocate', description: 'Allocate a port for a named Pandesh-managed service. Uses OS-assigned ports (port 0) by default; never races check-then-bind. Records ownership.', parameters: { type: 'object', properties: { serviceName: { type: 'string' }, preferredPort: { type: 'number' }, pid: { type: 'number' }, ownedByPandesh: { type: 'boolean' }, executable: { type: 'string' }, healthUrl: { type: 'string' } }, required: ['serviceName'] } },
      { name: 'port_service_health', description: 'Check health of a managed service by name.', parameters: { type: 'object', properties: { serviceName: { type: 'string' } }, required: ['serviceName'] } },
      { name: 'port_stop_service', description: 'Stop a Pandesh-owned managed service by name. Refuses to stop services Pandesh does not own.', parameters: { type: 'object', properties: { serviceName: { type: 'string' } }, required: ['serviceName'] } },
      { name: 'port_cleanup_orphans', description: 'Reconcile managed-service records: drop stale PID entries, optionally kill verified owned orphans.', parameters: { type: 'object', properties: { killOrphans: { type: 'boolean' } }, required: [] } },
      { name: 'port_check_setup', description: 'Diagnose Pandesh-managed services and ports: health, stale records, conflicts. Read-only.', parameters: { type: 'object', properties: {}, required: [] } },
    ],
    classify: (toolName) => (READ_ONLY_TOOLS.has(toolName) ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call) => {
      switch (call.name) {
        case 'port_list_services': return listServices();
        case 'port_allocate': return allocate(call);
        case 'port_service_health': return health(call);
        case 'port_stop_service': return stop(call);
        case 'port_cleanup_orphans': return cleanup(call);
        case 'port_check_setup': return checkSetup();
        default: return Promise.resolve(failure(`unknown tool '${call.name}'`, 'invalid_arguments'));
      }
    },
  };
}
