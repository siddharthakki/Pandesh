/**
 * The execution plan and its per-step truth.
 *
 * The contract under test is the one the assessment said was missing: a
 * failure in one step must never be reported as a global "everything
 * completed", and a plan that names something Pandesh cannot do must be
 * refused BEFORE anything runs.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { GovernedCapabilityRegistry, type GovernedCapabilityAdapter } from '../runtime/governedCapability';
import { createExecutionPlanAdapter, planStepTruth } from '../runtime/executionPlanCapability';
import { listOperatorRuns, listOperatorSteps } from '../domain/operatorRuns';
import { createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';

const dirs: string[] = [];

function openDb(): CoreDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-plan-test-'));
  dirs.push(dir);
  return openCoreDatabase(path.join(dir, 'core.db')).db;
}

/** A conversation with one attempt, so a tool invocation has a home. */
function seedAttempt(db: CoreDatabase, conversationId: string): string {
  const request = createRequest(db, {
    clientId: 'test', currentMessage: 'plan test', requestedMode: 'saath_kar', resolvedMode: 'saath_kar',
    routeReason: 'test', contextPolicy: {}, conversationId, actor: 'test', correlationId: `corr-${conversationId}`,
  });
  return createAttempt(db, { requestId: request.id, kind: 'saath_kar', actor: 'test', clientId: 'test' }).id;
}

function capability(id: string, tool: string, health: 'available' | 'unavailable' = 'available', reason?: string): GovernedCapabilityAdapter {
  return {
    id,
    definitions: () => [{ name: tool, description: tool, parameters: { type: 'object', properties: {} } }],
    classify: () => 'read_only',
    health: () => ({ state: health, reason, checkedAt: new Date().toISOString() }),
    run: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
  };
}

describe('the execution plan', () => {
  it('refuses a plan whose step names a capability Pandesh does not have', async () => {
    const db = openDb();
    const registry = new GovernedCapabilityRegistry().register(capability('browser', 'browser_open_site'));
    const adapter = createExecutionPlanAdapter({ db, registry });
    const result = await adapter.run({
      name: 'declare_execution_plan',
      arguments: {
        goal: 'read two pages and write a note',
        steps: [{ title: 'Read a page', capability: 'not-a-capability' }],
      },
    }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('plan_capability_unknown');
    // Nothing was started: no run exists.
    expect(listOperatorRuns(db).filter((run) => run.workflow === 'model_plan')).toHaveLength(0);
    db.close();
  });

  it('refuses a plan whose capability is not available right now', async () => {
    const db = openDb();
    const registry = new GovernedCapabilityRegistry()
      .register(capability('browser', 'browser_open_site'))
      .register(capability('image-studio', 'image_generate', 'unavailable', 'ComfyUI is not running'));
    const adapter = createExecutionPlanAdapter({ db, registry });
    const result = await adapter.run({
      name: 'declare_execution_plan',
      arguments: {
        goal: 'make an image',
        steps: [{ title: 'Generate the image', capability: 'image-studio' }],
      },
    }, {});
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('plan_capability_unavailable');
    expect(result.output).toContain('ComfyUI is not running');
    expect(listOperatorRuns(db).filter((run) => run.workflow === 'model_plan')).toHaveLength(0);
    db.close();
  });

  it('records a plan durably, with every step the person asked to see', async () => {
    const db = openDb();
    const registry = new GovernedCapabilityRegistry()
      .register(capability('browser', 'browser_open_site'))
      .register(capability('document-tools', 'document_read'));
    const adapter = createExecutionPlanAdapter({ db, registry });
    const result = await adapter.run({
      name: 'declare_execution_plan',
      arguments: {
        goal: 'research the price and write a note',
        steps: [
          { title: 'Open the vendor page', capability: 'browser', input: 'the product page', expectedOutput: 'the price', verification: 'the price is on the page', permission: 'read' },
          { title: 'Write the note', capability: 'document-tools', expectedOutput: 'notes/price.md', verification: 'the file exists on disk', permission: 'approval' },
        ],
      },
    }, {});
    expect(result.status).toBe('succeeded');
    const payload = JSON.parse(result.output);
    expect(payload.steps).toHaveLength(2);

    const runs = listOperatorRuns(db).filter((run) => run.workflow === 'model_plan');
    expect(runs).toHaveLength(1);
    const steps = listOperatorSteps(db, runs[0].id);
    expect(steps.map((step) => step.title)).toEqual(['Open the vendor page', 'Write the note']);
    expect(steps[0].output?.input).toBe('the product page');
    expect(steps[0].output?.verification).toBe('the price is on the page');
    expect(steps[1].output?.permission).toBe('approval');
    expect(steps.every((step) => step.status === 'pending')).toBe(true);
    db.close();
  });

  it('reports a failed step as failed, never as a completed plan', async () => {
    const db = openDb();
    const registry = new GovernedCapabilityRegistry()
      .register(capability('browser', 'browser_open_site'))
      .register(capability('document-tools', 'document_read'));
    const adapter = createExecutionPlanAdapter({ db, registry });
    const conversation = createConversation(db, { mode: 'saath_kar', title: 'plan', actor: 'test' });
    const declared = await adapter.run({
      name: 'declare_execution_plan',
      arguments: {
        goal: 'read then write',
        steps: [
          { title: 'Read the page', capability: 'browser' },
          { title: 'Write the note', capability: 'document-tools' },
        ],
      },
    }, { correlationId: conversation.id });
    const planId = JSON.parse(declared.output).planId;

    // The browser step ran and FAILED; the document step never ran.
    const attemptId = seedAttempt(db, conversation.id);
    const invocation = startToolInvocation(db, {
      attemptId, toolName: 'browser_open_site', argsSummary: {}, actor: 'test', clientId: 'test',
    });
    completeToolInvocation(db, invocation.id, { status: 'failed', exitCode: null, evidence: { output: 'the page did not load' }, actor: 'test', clientId: 'test' });

    const truth = planStepTruth(db, planId, registry);
    expect(truth[0].status).toBe('failed');
    expect(truth[0].error).toContain('browser_open_site');
    expect(truth[1].status).toBe('pending');
    expect(truth.some((step) => step.status === 'succeeded')).toBe(false);

    // And the model-facing status says the same thing.
    const status = await adapter.run({ name: 'execution_plan_status', arguments: {} }, {});
    const payload = JSON.parse(status.output);
    expect(payload.steps[0].status).toBe('failed');
    expect(payload.steps[1].status).toBe('pending');
    db.close();
  });

  it('marks a step succeeded only when its own tool really succeeded', async () => {
    const db = openDb();
    const registry = new GovernedCapabilityRegistry().register(capability('browser', 'browser_open_site'));
    const adapter = createExecutionPlanAdapter({ db, registry });
    const conversation = createConversation(db, { mode: 'saath_kar', title: 'plan', actor: 'test' });
    const declared = await adapter.run({
      name: 'declare_execution_plan',
      arguments: { goal: 'open a page', steps: [{ title: 'Open the page', capability: 'browser' }] },
    }, { correlationId: conversation.id });
    const planId = JSON.parse(declared.output).planId;
    const attemptId = seedAttempt(db, conversation.id);
    const invocation = startToolInvocation(db, {
      attemptId, toolName: 'browser_open_site', argsSummary: {}, actor: 'test', clientId: 'test',
    });
    completeToolInvocation(db, invocation.id, { status: 'succeeded', exitCode: 0, evidence: { output: 'the price is 42' }, actor: 'test', clientId: 'test' });
    const truth = planStepTruth(db, planId, registry);
    expect(truth[0].status).toBe('succeeded');
    expect(truth[0].evidence).toBe('browser_open_site');
    db.close();
  });
});
