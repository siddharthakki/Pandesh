import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TASK_BUDGETS } from '../../agent/AgentEngineTypes';
import { TaskStore } from '../../agent/TaskStore';
import { ContractEnforcer } from '../../autonomy/TaskContract';
import { TaskContractStore } from '../../autonomy/TaskContractStore';

describe('full-access trusted command contract', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-trusted-command-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('treats the explicit trusted setting as standing approval for non-denied commands', async () => {
    const store = new TaskStore(root);
    const contracts = new TaskContractStore(store);
    const contract = await contracts.ensureTrustedContract('trusted-command-task', {
      goal: 'Maintain the local project autonomously',
      allowedPaths: ['**/*'],
      allowedCommands: [],
      allowSafeCommands: true,
      budgets: DEFAULT_TASK_BUDGETS,
      approvalPolicy: 'in-contract-autonomous',
      checkpointPolicy: 'required',
    }, 'trusted-setting');

    expect(contract.status).toBe('approved');
    expect(contract.allowTrustedCommands).toBe(true);
    expect(new ContractEnforcer().evaluate(contract, {
      toolName: 'run_command',
      paths: [],
      command: 'npm install --package-lock-only',
      mutatesWorkspace: true,
    })).toEqual({
      inContract: true,
      reason: 'Command is covered by the explicit full-access trusted task contract.',
    });
  });

  it('does not grant full command access to a normal user-approved scoped contract by default', async () => {
    const store = new TaskStore(root);
    const contracts = new TaskContractStore(store);
    const proposed = await contracts.propose('scoped-command-task', {
      goal: 'Run only declared validation',
      allowedPaths: ['src/**'],
      allowedCommands: ['npm test'],
      allowSafeCommands: true,
      budgets: DEFAULT_TASK_BUDGETS,
      approvalPolicy: 'supervised',
      checkpointPolicy: 'required',
    });
    const contract = await contracts.approve('scoped-command-task', proposed.contractId, 'user');

    expect(contract.allowTrustedCommands).toBe(false);
    expect(new ContractEnforcer().evaluate(contract, {
      toolName: 'run_command',
      paths: [],
      command: 'npm install --package-lock-only',
      mutatesWorkspace: true,
    }).inContract).toBe(false);
  });
});
