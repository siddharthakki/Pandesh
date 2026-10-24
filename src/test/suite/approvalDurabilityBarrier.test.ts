import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { TaskStore } from '../../agent/TaskStore';
import { TaskStoreWriteBarrier } from '../../services/TaskStoreWriteBarrier';

const TASK_ID = 'approval_barrier_task';

describe('approval durability barrier', () => {
  let root: string;
  let store: TaskStore;
  let flow: ApprovalFlow;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-approval-barrier-'));
    store = new TaskStore(root);
    flow = new ApprovalFlow();
    await store.createTask({
      taskId: TASK_ID,
      workspaceId: root,
      workspaceRoot: root,
      userGoal: 'Test durable approvals',
      mode: 'agent',
      model: 'test-model',
      providerType: 'ollama',
    });
  });

  afterEach(async () => {
    await TaskStoreWriteBarrier.drain();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('waits for complete detached approval callback chains', async () => {
    let shownApprovalId: string | undefined;
    let observedUi!: () => void;
    const uiObserved = new Promise<void>(resolve => { observedUi = resolve; });

    flow.onApprovalRequested = (id, toolName, args, riskLevel) => {
      void store.persistApproval(TASK_ID, {
        approvalId: id,
        toolName,
        argsSummary: args,
        policyDecision: 'ask-once',
        riskLevel,
        requestedAt: new Date().toISOString(),
        status: 'pending',
      }).then(async () => {
        await store.updateTask(TASK_ID, { pendingApprovalId: id });
        const task = await store.getTask(TASK_ID);
        if (task?.pendingApprovalId === id) {
          await store.appendEvent(TASK_ID, 'approval_requested', { id });
        }
      });
    };

    flow.onApprovalResolved = (id, resolution) => {
      void store.updateApproval(TASK_ID, id, {
        status: resolution,
        resolvedAt: new Date().toISOString(),
        resolution,
      }).then(async () => {
        await store.updateTask(TASK_ID, { pendingApprovalId: undefined });
        const task = await store.getTask(TASK_ID);
        if (!task?.pendingApprovalId) {
          await store.appendEvent(TASK_ID, 'approval_resolved', { id, resolution });
        }
      });
    };

    flow.setOnRequest(request => {
      void store.getTask(TASK_ID).then(task => {
        shownApprovalId = task?.pendingApprovalId;
        expect(shownApprovalId).toBe(request.id);
        observedUi();
      });
    });

    const approval = flow.requestApproval('write_file', { path: 'x.ts' }, 'test', 'medium');
    await uiObserved;

    const id = shownApprovalId as string;
    expect(flow.respond(id, 'approved')).toBe(true);
    await expect(approval).resolves.toBe('approved');

    expect((await store.getTask(TASK_ID))?.pendingApprovalId).toBeUndefined();
    const eventState = await store.getEvents(TASK_ID);
    expect(eventState.events.map(event => event.type)).toEqual([
      'approval_requested',
      'approval_resolved',
    ]);
    expect(TaskStoreWriteBarrier.pendingCount()).toBe(0);
  });
});
