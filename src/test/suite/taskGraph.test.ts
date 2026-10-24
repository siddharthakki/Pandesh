import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  FileTaskGraphStorage,
  TASK_GRAPH_SCHEMA_VERSION,
  TaskGraph,
  TaskGraphCoordinator,
  createSingleNodeGraph,
  validateTaskGraph,
} from '../../orchestration/TaskGraph';

describe('Phase 13 task graph', () => {
  let root: string;
  let storage: FileTaskGraphStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-task-graph-'));
    storage = new FileTaskGraphStorage(taskId => path.join(root, taskId));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('validates a DAG and rejects missing dependencies and cycles', () => {
    const valid = graph();
    expect(validateTaskGraph(valid)).toMatchObject({ valid: true, order: ['inspect', 'implement', 'review'] });

    const missing = graph();
    missing.nodes[1].dependencies = ['absent'];
    expect(validateTaskGraph(missing).errors).toContain('Node implement depends on missing node absent.');

    const cyclic = graph();
    cyclic.nodes[0].dependencies = ['review'];
    expect(validateTaskGraph(cyclic).errors).toContain('Task graph contains a dependency cycle.');
  });

  it('persists an editable proposal, approval, ordered execution, and restart state', async () => {
    const coordinator = new TaskGraphCoordinator(storage);
    await coordinator.propose(graph());

    const persistedProposal = await storage.load('phase13');
    expect(persistedProposal?.status).toBe('proposed');
    expect(persistedProposal?.nodes.every(node => node.status === 'proposed')).toBe(true);

    await coordinator.approve('phase13');
    const order: string[] = [];
    const completed = await coordinator.run('phase13', {
      execute: async (node, context) => {
        order.push(node.id);
        if (node.id === 'review') {
          expect([...context.dependencyResults.keys()]).toEqual(['implement']);
        }
        return { summary: `${node.id} done` };
      },
    });

    expect(order).toEqual(['inspect', 'implement', 'review']);
    expect(completed.status).toBe('completed');
    expect(completed.nodes.every(node => node.status === 'completed')).toBe(true);

    const restartedStorage = new FileTaskGraphStorage(taskId => path.join(root, taskId));
    const restarted = await restartedStorage.load('phase13');
    expect(restarted?.status).toBe('completed');
    expect(restarted?.nodes[2].result?.summary).toBe('review done');
  });

  it('keeps a single-agent fallback for small tasks', async () => {
    const graph = createSingleNodeGraph('small_task', 'Change one line');
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ id: 'main', executionMode: 'single' });

    const coordinator = new TaskGraphCoordinator(storage);
    await coordinator.propose(graph);
    await coordinator.approve(graph.taskId);
    const completed = await coordinator.run(graph.taskId, {
      execute: async () => ({ summary: 'done' }),
    });
    expect(completed.status).toBe('completed');
  });
});

function graph(): TaskGraph {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    taskId: 'phase13',
    status: 'proposed',
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: [
      {
        id: 'inspect',
        role: 'researcher',
        objective: 'Inspect the repository',
        dependencies: [],
        allowedPaths: ['src'],
        capabilities: ['search'],
        executionMode: 'sequential',
        mutationPolicy: 'none',
        validation: [],
        status: 'proposed',
      },
      {
        id: 'implement',
        role: 'implementer',
        objective: 'Implement the change',
        dependencies: ['inspect'],
        allowedPaths: ['src'],
        capabilities: ['edit'],
        executionMode: 'sequential',
        mutationPolicy: 'workspace',
        validation: ['npm run compile'],
        status: 'proposed',
      },
      {
        id: 'review',
        role: 'reviewer',
        objective: 'Review the implementation',
        dependencies: ['implement'],
        allowedPaths: ['src'],
        capabilities: ['review'],
        executionMode: 'sequential',
        mutationPolicy: 'none',
        validation: [],
        status: 'proposed',
      },
    ],
  };
}
