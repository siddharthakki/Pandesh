import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutor } from '../../tools/ToolExecutor';
import { ToolCall } from '../../tools/ToolTypes';
import {
  StalePermissionContextError,
  createDefaultPermissionContext,
  createPermissionContext,
  grantsFromPermissionContext,
  validateBoundPermissionContext,
  validatePermissionSelectionPayload,
} from '../../tools/PermissionContext';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { AuditService } from '../../services/AuditService';
import { bindPermissionContextToEffectiveRun } from '../../agent/ConversationAwareAgentRuntime';

describe('M10.2 permission context integration', () => {
  it('uses a narrow read-only default permission profile', () => {
    const context = createDefaultPermissionContext();
    expect(context.profileId).toBe('workspace-read');
    expect(context.capabilities).toEqual(['workspace.read']);
    expect(context.approvalGranted).toBe(false);
    expect(context.elevationGranted).toBe(false);
  });

  it('creates valid selected profiles from canonical profile data', () => {
    const context = createPermissionContext('workspace-mutate', 'webview-selection');
    expect(context.profileId).toBe('workspace-mutate');
    expect(context.capabilities).toEqual(['workspace.read', 'workspace.write']);
  });

  it('rejects unknown profile selections', () => {
    expect(validatePermissionSelectionPayload({ profileId: 'not-real' })).toBeUndefined();
  });

  it('rejects malformed webview permission payloads', () => {
    expect(validatePermissionSelectionPayload(null)).toBeUndefined();
    expect(validatePermissionSelectionPayload({ profileId: ['workspace-read'] })).toBeUndefined();
  });

  it('does not allow the webview to inject extra capabilities', () => {
    const selected = validatePermissionSelectionPayload({
      profileId: 'workspace-read',
      capabilities: ['workspace.write', 'sensitive.elevated'],
    });
    expect(selected).toBe('workspace-read');
    expect(createPermissionContext(selected, 'webview-selection').capabilities).toEqual(['workspace.read']);
  });

  it('allows read-only execution under the read-only profile', () => {
    const context = createPermissionContext('workspace-read', 'run-bound', { runId: 'run-1' });
    const decision = ToolRegistry.authorizeGoverned('agent.read_file', grantsFromPermissionContext(context));
    expect(decision).toMatchObject({ ok: true, code: 'allowed' });
  });

  it('denies mutation execution under the read-only profile', () => {
    const context = createPermissionContext('workspace-read', 'run-bound', { runId: 'run-1', approvalGranted: true });
    const decision = ToolRegistry.authorizeGoverned('agent.write_file', grantsFromPermissionContext(context));
    expect(decision).toMatchObject({ ok: false, code: 'missing_permission' });
  });

  it('allows mutation execution under the mutation profile with approval', () => {
    const context = createPermissionContext('workspace-mutate', 'run-bound', { runId: 'run-1', approvalGranted: true });
    const decision = ToolRegistry.authorizeGoverned('agent.write_file', grantsFromPermissionContext(context));
    expect(decision).toMatchObject({ ok: true, code: 'allowed' });
  });

  it('surfaces approval-required decisions before execution', () => {
    const context = createPermissionContext('workspace-mutate', 'run-bound', { runId: 'run-1' });
    const decision = ToolRegistry.authorizeGoverned('agent.write_file', grantsFromPermissionContext(context));
    expect(decision).toMatchObject({ ok: false, code: 'approval_required' });
  });

  it('does not silently retain elevated state for a new run', () => {
    const elevated = createPermissionContext('sensitive-elevated', 'run-bound', {
      runId: 'run-1',
      elevationGranted: true,
    });
    const next = createDefaultPermissionContext();
    expect(elevated.elevationGranted).toBe(true);
    expect(next.profileId).toBe('workspace-read');
    expect(next.elevationGranted).toBe(false);
  });

  it('profile changes do not alter an already bound run context', () => {
    const bound = createPermissionContext('workspace-read', 'run-bound', { runId: 'run-1' });
    const laterSelection = createPermissionContext('workspace-mutate', 'webview-selection');
    expect(validateBoundPermissionContext(bound, 'run-1')).toMatchObject({ ok: true });
    expect(bound.profileId).toBe('workspace-read');
    expect(laterSelection.profileId).toBe('workspace-mutate');
  });

  it('stale or absent permission contexts fail closed', () => {
    expect(validateBoundPermissionContext(undefined, 'run-1')).toMatchObject({
      ok: false,
      code: 'invalid_permission_context',
    });
    const context = createPermissionContext('workspace-read', 'run-bound', { runId: 'run-1' });
    expect(validateBoundPermissionContext(context, 'run-2')).toMatchObject({
      ok: false,
      code: 'stale_permission_context',
    });
  });

  it('rebinds a conversation-bound permission context to the effective follow-up turn', () => {
    const original = createPermissionContext('workspace-read', 'run-bound', {
      runId: 'conversation-1',
    });
    const rebound = bindPermissionContextToEffectiveRun(
      { permissionContext: original },
      'conversation-1_turn_2',
    ).permissionContext!;

    expect(rebound).not.toBe(original);
    expect(rebound.profileId).toBe('workspace-read');
    expect(rebound.runId).toBe('conversation-1_turn_2');
    expect(validateBoundPermissionContext(rebound, 'conversation-1_turn_2')).toMatchObject({ ok: true });
    expect(validateBoundPermissionContext(original, 'conversation-1_turn_2')).toMatchObject({
      ok: false,
      code: 'stale_permission_context',
    });
  });

  it('executor blocks mutation before the tool implementation runs when context is too narrow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm10-permission-'));
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      permissionContext: createPermissionContext('workspace-read', 'run-bound', { runId: 'task-1' }),
      permissionRunId: 'task-1',
    });
    const result = await executor.execute(toolCall('write_file', { path: 'x.txt', content: 'x' }), {
      workspaceRoot: root,
      sessionId: 'task-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      model: 'test',
      mode: 'agent',
    });
    expect(result).toMatchObject({ ok: false, blocked: true, policyViolation: true });
    expect(result.ok ? undefined : result.error).toContain('missing_permission');
  });

  it('allows a read-only tool under a fresh, current run-bound context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm10-permission-'));
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      permissionContext: createPermissionContext('workspace-read', 'run-bound', { runId: 'task-1' }),
      permissionRunId: 'task-1',
    });
    const result = await executor.execute(toolCall('read_file', { path: 'x.txt' }), {
      workspaceRoot: root,
      sessionId: 'task-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      model: 'test',
      mode: 'agent',
    });
    expect(result.ok ? undefined : result.blocked).toBeUndefined();
  });

  it('fails closed with StalePermissionContextError instead of a retryable blocked result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm10-permission-'));
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      // Context bound to a different run than the one actually executing — simulates a
      // context that survived past the run/turn it was minted for.
      permissionContext: createPermissionContext('workspace-read', 'run-bound', { runId: 'task-old' }),
      permissionRunId: 'task-new',
    });
    await expect(
      executor.execute(toolCall('read_file', { path: 'x.txt' }), {
        workspaceRoot: root,
        sessionId: 'task-new',
        taskId: 'task-new',
        turnId: 'turn-1',
        model: 'test',
        mode: 'agent',
      }),
    ).rejects.toBeInstanceOf(StalePermissionContextError);
  });

  it('gives one actionable message on stale context, not a generic denial', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm10-permission-'));
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      permissionContext: createPermissionContext('workspace-read', 'run-bound', { runId: 'task-old' }),
      permissionRunId: 'task-new',
    });
    try {
      await executor.execute(toolCall('read_file', { path: 'x.txt' }), {
        workspaceRoot: root,
        sessionId: 'task-new',
        taskId: 'task-new',
        turnId: 'turn-1',
        model: 'test',
        mode: 'agent',
      });
      expect.unreachable('expected StalePermissionContextError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StalePermissionContextError);
      expect((error as Error).message).toBe(
        'Permissions changed since this run started. Send the request again to continue with the current permissions.',
      );
    }
  });
});

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: args },
  };
}
