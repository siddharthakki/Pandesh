import { describe, it, expect } from 'vitest';
import {
  ReadOnlySubAgentPool,
  ReadOnlySubAgentTask,
  assertReadOnlyTool,
  isReadOnlyCommand,
} from '../../orchestration/ReadOnlySubAgentPool';

function task(id: string): ReadOnlySubAgentTask {
  return {
    id,
    role: 'reviewer',
    objective: `Inspect ${id}`,
    context: [`context-${id}`],
    maxModelCalls: 2,
    maxOutputBytes: 10_000,
  };
}

describe('Phase 14 read-only sub-agents', () => {
  it('blocks mutating tools, shell operators, and mutating commands', () => {
    expect(() => assertReadOnlyTool('write_file', { path: 'src/a.ts' })).toThrow(/cannot use/i);
    expect(() => assertReadOnlyTool('run_command', { command: 'npm install' })).toThrow(/not allowed/i);
    expect(() => assertReadOnlyTool('run_command', { command: 'git status && rm file' })).toThrow(/not allowed/i);
    expect(isReadOnlyCommand('git diff -- src/a.ts')).toBe(true);
    expect(isReadOnlyCommand('Get-ChildItem src')).toBe(true);
  });

  it('runs bounded tasks concurrently while serializing one-GPU model calls', async () => {
    const pool = new ReadOnlySubAgentPool({ concurrency: 3, modelConcurrency: 1 });
    let activeTasks = 0;
    let maxActiveTasks = 0;
    let activeModels = 0;
    let maxActiveModels = 0;

    const batch = await pool.run([task('a'), task('b'), task('c')], {
      execute: async (input, context) => {
        activeTasks += 1;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        context.assertToolAllowed('read_file', { path: 'src/a.ts' });
        await context.withModelSlot(async () => {
          activeModels += 1;
          maxActiveModels = Math.max(maxActiveModels, activeModels);
          await new Promise(resolve => setTimeout(resolve, 20));
          activeModels -= 1;
        });
        activeTasks -= 1;
        return {
          summary: `done ${input.id}`,
          findings: [{ severity: 'warning', file: 'src/a.ts', message: 'Same finding' }],
          modelCalls: 1,
          outputBytes: 100,
        };
      },
    });

    expect(maxActiveTasks).toBeGreaterThan(1);
    expect(maxActiveModels).toBe(1);
    expect(batch.results.map(result => result.taskId)).toEqual(['a', 'b', 'c']);
    expect(batch.findings).toHaveLength(1);
    expect(batch.cancelled).toBe(false);
  });

  it('cancels all child work through one batch signal', async () => {
    const pool = new ReadOnlySubAgentPool({ concurrency: 2, modelConcurrency: 1 });
    const running = pool.run([task('a'), task('b')], {
      execute: async (_input, context) => {
        await new Promise<void>(resolve => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { summary: 'cancelled', findings: [], modelCalls: 0, outputBytes: 0 };
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(pool.cancel()).toBe(true);
    const result = await running;
    expect(result.cancelled).toBe(true);
  });
});
