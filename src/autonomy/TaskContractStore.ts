import * as fs from 'fs/promises';
import * as path from 'path';
import { TaskStore } from '../agent/TaskStore';
import { DEFAULT_TASK_BUDGETS, TaskBudgets } from '../agent/AgentEngineTypes';
import { TaskContract, TaskContractInput } from './TaskContract';

function nowIso(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export class TaskContractStore {
  constructor(private readonly taskStore: TaskStore) {}

  private contractFile(taskId: string): string {
    return path.join(this.taskStore.getTaskDir(taskId), 'contract.json');
  }

  async get(taskId: string): Promise<TaskContract | null> {
    try {
      const raw = await fs.readFile(this.contractFile(taskId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<TaskContract>;
      if (parsed.schemaVersion !== 1 || parsed.taskId !== taskId || !parsed.contractId) {
        return null;
      }
      return {
        ...parsed,
        allowTrustedCommands: parsed.allowTrustedCommands ?? false,
      } as TaskContract;
    } catch {
      return null;
    }
  }

  async propose(taskId: string, input: TaskContractInput): Promise<TaskContract> {
    const timestamp = nowIso();
    const contract: TaskContract = {
      schemaVersion: 1,
      contractId: `contract_${taskId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      goal: input.goal.trim(),
      acceptanceCriteria: unique(input.acceptanceCriteria ?? []),
      allowedPaths: unique(input.allowedPaths?.length ? input.allowedPaths : ['**/*']),
      allowedCommands: unique(input.allowedCommands ?? []),
      allowSafeCommands: input.allowSafeCommands ?? true,
      allowTrustedCommands: input.allowTrustedCommands ?? false,
      budgets: { ...DEFAULT_TASK_BUDGETS, ...input.budgets } as TaskBudgets,
      approvalPolicy: input.approvalPolicy ?? 'supervised',
      checkpointPolicy: input.checkpointPolicy ?? 'required',
      status: 'proposed',
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
    };
    await this.write(contract);
    return contract;
  }

  async approve(
    taskId: string,
    contractId: string,
    approvedBy: NonNullable<TaskContract['approvedBy']>,
  ): Promise<TaskContract> {
    const existing = await this.require(taskId, contractId);
    if (existing.status === 'revoked') {
      throw new Error(`Task contract ${contractId} has been revoked.`);
    }
    const timestamp = nowIso();
    const approved: TaskContract = {
      ...existing,
      status: 'approved',
      approvalPolicy: 'in-contract-autonomous',
      approvedAt: timestamp,
      approvedBy,
      updatedAt: timestamp,
      revision: existing.revision + 1,
    };
    await this.write(approved);
    return approved;
  }

  async revoke(taskId: string, contractId: string): Promise<TaskContract> {
    const existing = await this.require(taskId, contractId);
    const timestamp = nowIso();
    const revoked: TaskContract = {
      ...existing,
      status: 'revoked',
      revokedAt: timestamp,
      updatedAt: timestamp,
      revision: existing.revision + 1,
    };
    await this.write(revoked);
    return revoked;
  }

  async ensureTrustedContract(
    taskId: string,
    input: TaskContractInput,
    approvedBy: NonNullable<TaskContract['approvedBy']> = 'trusted-setting',
  ): Promise<TaskContract> {
    const existing = await this.get(taskId);
    if (existing) { return existing; }
    const proposed = await this.propose(taskId, {
      ...input,
      allowTrustedCommands: input.allowTrustedCommands ?? approvedBy === 'trusted-setting',
      approvalPolicy: 'in-contract-autonomous',
      checkpointPolicy: 'required',
    });
    return this.approve(taskId, proposed.contractId, approvedBy);
  }

  private async require(taskId: string, contractId: string): Promise<TaskContract> {
    const contract = await this.get(taskId);
    if (!contract || contract.contractId !== contractId) {
      throw new Error(`Task contract ${contractId} was not found for task ${taskId}.`);
    }
    return contract;
  }

  private async write(contract: TaskContract): Promise<void> {
    const destination = this.contractFile(contract.taskId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(contract, null, 2), 'utf8');
    await fs.rename(temporary, destination);
  }
}
