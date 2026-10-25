import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import {
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_INVOCATION_STATUS_DESCRIPTOR,
  FORGE_INVOKE_MODEL_DESCRIPTOR,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_INVOCATION_START_DESCRIPTOR,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_RESERVATION_METRICS_METHOD,
  FORGE_START_INVOCATION_METHOD,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
} from '../../agent/ForgeCallableSurface';
import { forgePermissionBinding, registerForgeCallableRpc } from '../../agent/ForgeRpcRegistration';
import { createPermissionContext } from '../../tools/PermissionContext';
import { LocalRpcDispatcher } from '../../runtime/LocalRpcServer';

describe('M10.3 governed Forge callable integration', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('documents governed and legacy production invocation paths in the canonical AI OS governance contract', () => {
    const govPath = path.join(process.cwd(), 'AI_OS_GOVERNANCE.md');
    if (!fs.existsSync(govPath)) {
      // AI_OS root docs are omitted in public checkouts
      return;
    }
    const doc = fs.readFileSync(govPath, 'utf8');
    expect(doc).toContain('Permission and Caller Trust');
    expect(doc).toContain('Forge RPC Authorization');
    expect(doc).toContain('Direct legacy in-process transport calls');
    expect(doc).toContain('MCP resources');
  });

  it('authorizes a registered read-only Forge callable with a run and tool bound context', async () => {
    let handlerCalls = 0;
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_INVOCATION_STATUS_DESCRIPTOR, async request => {
      handlerCalls += 1;
      return {
        ok: false,
        method: request.method,
        error: { code: 'not_found', message: 'handler reached' },
      };
    });
    const transport = new LocalForgeCallableTransport(registry);
    const runId = 'invocation:inv-readable';
    const response = await transport.invoke(
      FORGE_GET_INVOCATION_STATUS_METHOD,
      { invocationId: 'inv-readable' },
      {
        requirePermissionContext: true,
        permissionRunId: runId,
        permissionContext: createPermissionContext('workspace-read', 'run-bound', {
          runId,
          toolId: `forge.${FORGE_GET_INVOCATION_STATUS_METHOD}`,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(handlerCalls).toBe(1);
  });

  it('blocks missing permission before the Forge handler runs', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-1', model: 'test-model' },
      {
        requirePermissionContext: true,
        permissionRunId: 'reservation:res-1',
        permissionContext: createPermissionContext('workspace-read', 'run-bound', {
          runId: 'reservation:res-1',
          toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
          approvalGranted: true,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'missing_permission' } });
    expect(calls()).toBe(0);
  });

  it('fails closed when a migrated Forge path has no permission context', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-absent', model: 'test-model' },
      { requirePermissionContext: true, permissionRunId: 'reservation:res-absent' },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_permission_context' } });
    expect(calls()).toBe(0);
  });

  it('rejects stale run-bound Forge contexts before handler dispatch', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-new', model: 'test-model' },
      {
        requirePermissionContext: true,
        permissionRunId: 'reservation:res-new',
        permissionContext: createPermissionContext('model-provider-access', 'run-bound', {
          runId: 'reservation:res-old',
          toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
          approvalGranted: true,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'stale_permission_context' } });
    expect(calls()).toBe(0);
  });

  it('rejects a tool-bound context replayed against another Forge tool', async () => {
    let handlerCalls = 0;
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_INVOCATION_STATUS_DESCRIPTOR, async request => {
      handlerCalls += 1;
      return { ok: false, method: request.method, error: { code: 'not_found', message: 'handler reached' } };
    });
    const transport = new LocalForgeCallableTransport(registry);
    const response = await transport.invoke(
      FORGE_GET_INVOCATION_STATUS_METHOD,
      { invocationId: 'inv-tool' },
      {
        requirePermissionContext: true,
        permissionRunId: 'invocation:inv-tool',
        permissionContext: createPermissionContext('workspace-read', 'run-bound', {
          runId: 'invocation:inv-tool',
          toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'stale_permission_context' } });
    expect(handlerCalls).toBe(0);
  });

  it('rejects an otherwise valid Forge context when the expected tool binding is missing', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-no-tool', model: 'test-model' },
      {
        requirePermissionContext: true,
        permissionRunId: 'reservation:res-no-tool',
        permissionContext: createPermissionContext('model-provider-access', 'run-bound', {
          runId: 'reservation:res-no-tool',
          approvalGranted: true,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_permission_context' } });
    expect(calls()).toBe(0);
  });

  it('keeps approval-required Forge callables blocked without approval', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-approval', model: 'test-model' },
      {
        requirePermissionContext: true,
        permissionRunId: 'reservation:res-approval',
        permissionContext: createPermissionContext('model-provider-access', 'run-bound', {
          runId: 'reservation:res-approval',
          toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    expect(calls()).toBe(0);
  });

  it('allows a correctly approved Forge callable to reach execution exactly once', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-approved', model: 'test-model' },
      {
        requirePermissionContext: true,
        permissionRunId: 'reservation:res-approved',
        permissionContext: createPermissionContext('model-provider-access', 'run-bound', {
          runId: 'reservation:res-approved',
          toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
          approvalGranted: true,
        }),
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls()).toBe(1);
  });

  it('propagates safe denial classifications through the RPC bridge', async () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, async request => ({
      ok: false,
      method: request.method,
      error: { code: 'not_found', message: 'handler reached' },
    }));
    const accessKey = 'm10-3-access-key-000000000001';
    const dispatcher = new LocalRpcDispatcher(accessKey);
    registerForgeCallableRpc(dispatcher, new LocalForgeCallableTransport(registry));

    const response = await dispatcher.dispatch(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'm10-3-denial',
        method: FORGE_INVOKE_MODEL_METHOD,
        params: { model: 'test-model' },
      }),
      accessKey,
    );

    expect(response?.error).toBeUndefined();
    expect(response?.result).toMatchObject({ ok: false, error: { code: 'invalid_permission_context' } });
    expect(JSON.stringify(response)).not.toContain('access-key');
  });

  it('does not accept serialized params as permission context or approval provenance', async () => {
    let handlerCalls = 0;
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, async request => {
      handlerCalls += 1;
      return {
        ok: false,
        method: request.method,
        error: { code: 'not_found', message: 'handler reached' },
      };
    });
    const accessKey = 'm10-3-access-key-000000000002';
    const dispatcher = new LocalRpcDispatcher(accessKey);
    registerForgeCallableRpc(dispatcher, new LocalForgeCallableTransport(registry));

    const response = await dispatcher.dispatch(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'm10-3-smuggled-context',
        method: FORGE_INVOKE_MODEL_METHOD,
        params: {
          reservationId: 'res-smuggled',
          model: 'test-model',
          permissionContext: createPermissionContext('model-provider-access', 'run-bound', {
            runId: 'reservation:res-smuggled',
            toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
            approvalGranted: true,
          }),
          approvalGranted: true,
        },
      }),
      accessKey,
    );

    expect(response?.error).toBeUndefined();
    expect(response?.result).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    expect(handlerCalls).toBe(0);
  });

  it('keeps production AgentRuntime Forge RPC approval-required calls denied without trusted approval', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-m10-3-runtime-'));
    tempRoots.push(root);
    const runtime = new AgentRuntime(root, secretStorage());
    const accessKey = 'm10-3-runtime-access-key-000001';
    const service = runtime.createRpcService(accessKey);

    const response = await service.dispatcher.dispatch(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'm10-3-production-approval',
        method: FORGE_INVOKE_MODEL_METHOD,
        params: {
          reservationId: 'res-production',
          model: 'test-model',
          approvalGranted: true,
          elevationGranted: true,
          permissionContext: createPermissionContext('model-provider-access', 'run-bound', {
            runId: 'reservation:res-production',
            toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
            approvalGranted: true,
            elevationGranted: true,
          }),
        },
      }),
      accessKey,
    );

    expect(response?.error).toBeUndefined();
    expect(response?.result).toMatchObject({ ok: false, error: { code: 'approval_required' } });
  });

  it('allows an explicit test-only host approval decision to execute exactly once', async () => {
    let handlerCalls = 0;
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, async request => {
      handlerCalls += 1;
      return { ok: false, method: request.method, error: { code: 'not_found', message: 'handler reached' } };
    });
    const accessKey = 'm10-3-access-key-000000000003';
    const dispatcher = new LocalRpcDispatcher(accessKey);
    registerForgeCallableRpc(dispatcher, new LocalForgeCallableTransport(registry), {
      approvalGranted: (method, runId) => method === FORGE_INVOKE_MODEL_METHOD && runId === 'reservation:res-approved-rpc',
      elevationGranted: () => false,
    });

    const response = await dispatcher.dispatch(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'm10-3-approved-rpc',
        method: FORGE_INVOKE_MODEL_METHOD,
        params: { reservationId: 'res-approved-rpc', model: 'test-model' },
      }),
      accessKey,
    );

    expect(response?.error).toBeUndefined();
    expect(response?.result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(handlerCalls).toBe(1);
  });

  it('binds start invocation authorization to task, invocation, and reservation together', () => {
    const binding = forgePermissionBinding(FORGE_START_INVOCATION_METHOD, {
      taskId: 'task-a',
      invocationId: 'inv-a',
      reservationId: 'res-a',
    });

    expect(binding).toEqual({
      profileId: 'task-lifecycle-control',
      runId: 'task:task-a:invocation:inv-a:reservation:res-a',
    });
  });

  it('keeps different start reservations on distinct authorization identities', () => {
    const first = forgePermissionBinding(FORGE_START_INVOCATION_METHOD, {
      taskId: 'task-a',
      invocationId: 'inv-a',
      reservationId: 'res-a',
    });
    const second = forgePermissionBinding(FORGE_START_INVOCATION_METHOD, {
      taskId: 'task-a',
      invocationId: 'inv-a',
      reservationId: 'res-b',
    });

    expect(first.runId).toBe('task:task-a:invocation:inv-a:reservation:res-a');
    expect(second.runId).toBe('task:task-a:invocation:inv-a:reservation:res-b');
    expect(first.runId).not.toBe(second.runId);
  });

  it('denies start invocation with a missing reservation before handler execution', async () => {
    let handlerCalls = 0;
    const registry = new ReadOnlyForgeCallableRegistry();
    registry.register(FORGE_INVOCATION_START_DESCRIPTOR, async request => {
      handlerCalls += 1;
      return { ok: false, method: request.method, error: { code: 'not_found', message: 'handler reached' } };
    });
    const accessKey = 'm10-3-access-key-000000000004';
    const dispatcher = new LocalRpcDispatcher(accessKey);
    registerForgeCallableRpc(dispatcher, new LocalForgeCallableTransport(registry), {
      approvalGranted: (method, runId) => method === FORGE_START_INVOCATION_METHOD && runId === 'unreachable-run',
      elevationGranted: () => false,
    });

    const response = await dispatcher.dispatch(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'm10-3-start-missing-reservation',
        method: FORGE_START_INVOCATION_METHOD,
        params: { taskId: 'task-a', invocationId: 'inv-a', goal: 'go' },
      }),
      accessKey,
    );

    expect(response?.result).toMatchObject({ ok: false, error: { code: 'invalid_permission_context' } });
    expect(handlerCalls).toBe(0);
  });

  it('requires all task, invocation, and reservation identities for model-result lookup', () => {
    expect(forgePermissionBinding(FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      taskId: 'task-a',
      invocationId: 'inv-a',
      reservationId: 'res-a',
    }).runId).toBe('task:task-a:invocation:inv-a:reservation:res-a');
    expect(forgePermissionBinding(FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      taskId: 'task-a',
      invocationId: 'inv-a',
    }).runId).toBeUndefined();
  });

  it('binds invoke-model authorization only to the exact reservation', () => {
    expect(forgePermissionBinding(FORGE_INVOKE_MODEL_METHOD, {
      reservationId: 'res-only',
      taskId: 'ignored-task',
      invocationId: 'ignored-invocation',
    }).runId).toBe('reservation:res-only');
  });

  it('uses a host-owned request binding for identity-free callables instead of a static method run id', () => {
    const binding = forgePermissionBinding(FORGE_RESERVATION_METRICS_METHOD, undefined, 'client-a');

    expect(binding).toEqual({
      profileId: 'metadata-state',
      runId: `request:client-a:${FORGE_RESERVATION_METRICS_METHOD}`,
    });
    expect(binding.runId).not.toBe(FORGE_RESERVATION_METRICS_METHOD);
  });

  it('has no permissive default permission profile for future Forge methods', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'agent', 'ForgeRpcRegistration.ts'), 'utf8');
    expect(source).toContain('function assertNever(value: never): never');
    expect(source).not.toContain('default:');
    expect(source).toContain('case FORGE_CAN_START_INVOCATION_METHOD');
  });

  it('leaves direct local transport calls as explicit legacy compatibility', async () => {
    const { transport, calls } = invokeModelTransport();
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'legacy-res', model: 'test-model' },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls()).toBe(1);
  });

  it('binds RPC-created contexts to reservation identity so another run cannot replay them', async () => {
    const { transport, calls } = invokeModelTransport();
    const context = createPermissionContext('model-provider-access', 'run-bound', {
      runId: 'reservation:res-original',
      toolId: `forge.${FORGE_INVOKE_MODEL_METHOD}`,
      approvalGranted: true,
    });
    const response = await transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId: 'res-other', model: 'test-model' },
      {
        requirePermissionContext: true,
        permissionRunId: 'reservation:res-other',
        permissionContext: context,
      },
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'stale_permission_context' } });
    expect(calls()).toBe(0);
  });

  it('continues to require Agent Panel tool permission behavior from M10.2', () => {
    const context = createPermissionContext('workspace-read', 'run-bound', { runId: 'agent-run' });
    expect(context.capabilities).toEqual(['workspace.read']);
  });
});

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

function invokeModelTransport(): { transport: LocalForgeCallableTransport; calls: () => number } {
  let handlerCalls = 0;
  const registry = new ReadOnlyForgeCallableRegistry();
  registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, async request => {
    handlerCalls += 1;
    return {
      ok: false,
      method: request.method,
      error: { code: 'not_found', message: 'handler reached' },
    };
  });
  return {
    transport: new LocalForgeCallableTransport(registry),
    calls: () => handlerCalls,
  };
}
