import fs from 'fs/promises';
import path from 'path';
import type {
  AgentAdapterKind,
  AgentPermission,
  AgentRole,
  AgentWorkerDefinition,
} from './M19AgentWorkforceRuntime';

const ADAPTERS = new Set<AgentAdapterKind>(['opencode', 'codex', 'claude', 'karkedikha']);
const ROLES = new Set<AgentRole>(['analyst', 'planner', 'implementer', 'reviewer', 'validator', 'repairer']);
const EXTERNAL_ROLES = new Set<AgentRole>(['analyst', 'planner', 'reviewer', 'validator']);
const PERMISSIONS = new Set<AgentPermission>([
  'repository:read',
  'worktree:write',
  'validation:run',
  'github:read',
  'github:comment',
  'github:draft-pr',
  'network:model',
]);
const MUTATING_PERMISSIONS = new Set<AgentPermission>(['worktree:write', 'github:draft-pr']);

export interface WorkforceConfigLoadResult {
  path: string;
  workers: AgentWorkerDefinition[];
  configured: boolean;
}

export async function loadM19WorkforceConfig(repositoryRoot: string): Promise<WorkforceConfigLoadResult> {
  const filePath = path.join(repositoryRoot, '.ollama-agent', 'workforce.json');
  let payload: unknown;
  try {
    payload = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath, workers: [], configured: false };
    }
    throw new Error(`Cannot load M19 workforce configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { workers?: unknown }).workers)) {
    throw new Error('M19 workforce configuration requires a workers array.');
  }
  const workers = (payload as { workers: unknown[] }).workers.map((value, index) => parseWorker(value, index));
  const ids = new Set<string>();
  for (const worker of workers) {
    if (ids.has(worker.id)) throw new Error(`Duplicate M19 worker id: ${worker.id}`);
    ids.add(worker.id);
  }
  return { path: filePath, workers, configured: true };
}

function parseWorker(value: unknown, index: number): AgentWorkerDefinition {
  if (!value || typeof value !== 'object') throw new Error(`M19 worker ${index} must be an object.`);
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, `workers[${index}].id`);
  const adapter = requiredString(record.adapter, `workers[${index}].adapter`) as AgentAdapterKind;
  if (!ADAPTERS.has(adapter)) throw new Error(`Unsupported M19 adapter for ${id}: ${adapter}`);
  const roles = stringArray(record.roles, `workers[${index}].roles`).map(role => {
    if (!ROLES.has(role as AgentRole)) throw new Error(`Unsupported role ${role} for ${id}.`);
    return role as AgentRole;
  });
  const permissions = stringArray(record.permissions, `workers[${index}].permissions`).map(permission => {
    if (!PERMISSIONS.has(permission as AgentPermission)) throw new Error(`Unsupported permission ${permission} for ${id}.`);
    return permission as AgentPermission;
  });
  if (adapter !== 'karkedikha') {
    const mutatingRole = roles.find(role => !EXTERNAL_ROLES.has(role));
    if (mutatingRole) {
      throw new Error(`External worker ${id} cannot use mutating role ${mutatingRole}; repository implementation and repair must run through KarkeDikha.`);
    }
    const mutatingPermission = permissions.find(permission => MUTATING_PERMISSIONS.has(permission));
    if (mutatingPermission) {
      throw new Error(`External worker ${id} cannot hold ${mutatingPermission}; repository mutation and draft-PR delivery remain KarkeDikha-governed.`);
    }
  }
  const modelsRaw = record.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) throw new Error(`M19 worker ${id} requires models.`);
  const models = modelsRaw.map((model, modelIndex) => {
    if (!model || typeof model !== 'object') throw new Error(`M19 worker ${id} model ${modelIndex} must be an object.`);
    const item = model as Record<string, unknown>;
    return {
      model: requiredString(item.model, `${id}.models[${modelIndex}].model`),
      provider: requiredString(item.provider, `${id}.models[${modelIndex}].provider`),
      inputCostPerMillion: nonNegativeNumber(item.inputCostPerMillion ?? 0, `${id}.models[${modelIndex}].inputCostPerMillion`),
      outputCostPerMillion: nonNegativeNumber(item.outputCostPerMillion ?? 0, `${id}.models[${modelIndex}].outputCostPerMillion`),
      maxContextTokens: positiveInteger(item.maxContextTokens, `${id}.models[${modelIndex}].maxContextTokens`),
    };
  });
  return {
    id,
    name: optionalString(record.name) ?? id,
    adapter,
    roles,
    capabilities: stringArray(record.capabilities, `workers[${index}].capabilities`),
    permissions,
    models,
    maxConcurrent: positiveInteger(record.maxConcurrent ?? 1, `${id}.maxConcurrent`),
    heartbeatTimeoutMs: positiveInteger(record.heartbeatTimeoutMs ?? 60_000, `${id}.heartbeatTimeoutMs`),
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  return [...new Set(value.map(item => String(item).trim()))];
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function nonNegativeNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number.`);
  return number;
}
