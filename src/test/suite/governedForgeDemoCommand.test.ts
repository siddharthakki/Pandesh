import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import {
  GovernedForgeDemoController,
  RUN_GOVERNED_FORGE_DEMO_COMMAND,
} from '../../activation/GovernedForgeDemoController';
import { registerCommands } from '../../activation/registerCommands';
import { ProviderGateway } from '../../providers/ProviderGateway';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderApiError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
} from '../../providers/ProviderTypes';
import { MockProvider } from '../mocks/MockProvider';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';
import { LocalRpcDispatcher, LocalRpcResponse } from '../../runtime/LocalRpcServer';
import { RpcServiceLifecycle } from '../../runtime/RpcServiceLifecycle';
import { TaskStore } from '../../agent/TaskStore';
import {
  ForgeCallableMethod,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
} from '../../agent/ForgeCallableSurface';
import { registerForgeCallableRpc } from '../../agent/ForgeRpcRegistration';
import packageJson from '../../../package.json';

class ControlledProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly capturedRequests: Array<{
    messages: ChatMessage[];
    tools: ToolDefinition[];
    options: ProviderChatOptions;
  }> = [];
  calls = 0;
  signal?: AbortSignal;
  resolveChat?: (content: string) => void;

  constructor(private readonly honorAbort: boolean) {}

  async healthCheck(): Promise<void> {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'test-model' }];
  }

  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls += 1;
    this.signal = signal;
    this.capturedRequests.push({ messages, tools, options });

    return new Promise<ChatResponse>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      const onAbort = (): void => {
        if (!this.honorAbort || settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error('raw provider cancellation detail'));
      };
      if (this.honorAbort) {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
      this.resolveChat = (content: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({ message: { role: 'assistant', content }, done: true });
      };
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

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

function extensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    secrets: secretStorage(),
  } as vscode.ExtensionContext;
}

function statusBar(): { dispose(): void } {
  return { dispose: () => undefined };
}

function agentPanel(): {
  stop(): void;
  clearSession(): void;
} {
  return {
    stop: () => undefined,
    clearSession: () => undefined,
  };
}

function latestOutput(): string {
  const channels = vscodeMock._outputChannels();
  const channel = channels[channels.length - 1];
  return channel?.content() ?? '';
}

function latestReport(): string {
  const output = latestOutput();
  const reports = output.split('------------------------------------------------------------')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return reports[reports.length - 1] ?? '';
}

function allNotifications(): string {
  return [
    vscodeMock._lastInformationMessage(),
    vscodeMock._lastWarningMessage(),
    vscodeMock._lastErrorMessage(),
  ].filter((value): value is string => typeof value === 'string').join('\n');
}

function rpcMethod(raw: string): string | undefined {
  const parsed = JSON.parse(raw) as { method?: unknown };
  return typeof parsed.method === 'string' ? parsed.method : undefined;
}

function rpcParams(raw: string): unknown {
  const parsed = JSON.parse(raw) as { params?: unknown };
  return parsed.params;
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function approvalKey(method: ForgeCallableMethod, runId: string): string {
  return `${method}\n${runId}`;
}

function installApprovedDemoRpcService(): void {
  vi.spyOn(AgentRuntime.prototype, 'createRpcService').mockImplementation(function (
    this: AgentRuntime,
    accessKey: string,
    requestTimeoutMs?: number,
  ) {
    const approved = new Set<string>();
    const dispatcher = new LocalRpcDispatcher(accessKey, { requestTimeoutMs });
    registerForgeCallableRpc(dispatcher, this.composeGovernedForgeExecution().transport, {
      approvalGranted: (method, runId) => approved.has(approvalKey(method, runId)),
      elevationGranted: () => false,
    });
    const service = new RpcServiceLifecycle(dispatcher);
    const dispatch = service.dispatcher.dispatch.bind(service.dispatcher);
    service.dispatcher.dispatch = async (raw, key, clientId) => {
      const method = rpcMethod(raw);
      const params = rpcParams(raw);
      if (method === FORGE_INVOKE_MODEL_METHOD) {
        const reservationId = maybeString(maybeRecord(params)?.reservationId);
        if (reservationId) {
          approved.add(approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${reservationId}`));
        }
      }
      const response = await dispatch(raw, key, clientId);
      if (method === FORGE_RESERVE_START_INVOCATION_METHOD) {
        const result = maybeRecord(response?.result);
        const reservation = maybeRecord(result?.reservation);
        const reservationId = maybeString(reservation?.reservationId);
        if (reservationId) {
          approved.add(approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${reservationId}`));
        }
      }
      return response;
    };
    return service;
  });
}

function retrievalRpcResponse(result: Record<string, unknown>): LocalRpcResponse {
  return {
    jsonrpc: '2.0',
    id: 'controlled_retrieval',
    result: {
      ok: true,
      method: 'forge.invocation.getModelExecutionResult',
      result,
    },
  };
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

function setNestedEvidenceDuration(
  response: LocalRpcResponse,
  outerKey: 'modelCall' | 'result',
  durationMs: unknown,
): LocalRpcResponse {
  const cloned = cloneRecord(response);
  const result = cloneRecord(cloned.result);
  const payload = cloneRecord(result[outerKey]);
  const evidence = cloneRecord(payload.evidence);
  if (durationMs === undefined) {
    delete evidence.durationMs;
  } else {
    evidence.durationMs = durationMs;
  }
  payload.evidence = evidence;
  result[outerKey] = payload;
  cloned.result = result;
  return cloned as LocalRpcResponse;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await flushMicrotasks();
  }
  throw new Error('Timed out waiting for test condition.');
}

describe('M7.1 governed Forge demo command', () => {
  let root: string;
  let context: vscode.ExtensionContext;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-governed-demo-'));
    context = extensionContext();
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetCommands();
    vscodeMock._setConfig('ollama-agent.chatModel', 'demo-chat-model');
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    installApprovedDemoRpcService();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vscodeMock._resetWindowState();
    vscodeMock._resetCommands();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('registers the command and package contribution', () => {
    registerCommands(context, agentPanel() as never, statusBar() as never, root);

    expect(vscodeMock._registeredCommand(RUN_GOVERNED_FORGE_DEMO_COMMAND)).toBeTypeOf('function');
    expect(context.subscriptions.length).toBeGreaterThan(1);
    expect(packageJson.contributes.commands).toContainEqual({
      command: RUN_GOVERNED_FORGE_DEMO_COMMAND,
      title: 'Run Governed Forge Demo',
      category: 'KarkeDikha',
    });
  });

  it('keeps registration inert', () => {
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create');
    const createRpcSpy = vi.spyOn(AgentRuntime.prototype, 'createRpcService');
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');

    registerCommands(context, agentPanel() as never, statusBar() as never, root);

    expect(gatewaySpy).not.toHaveBeenCalled();
    expect(createRpcSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('does nothing for cancelled or blank input', async () => {
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create');
    const createRpcSpy = vi.spyOn(AgentRuntime.prototype, 'createRpcService');
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue(undefined);
    await controller.run();
    vscodeMock._setInputBoxValue('   ');
    await controller.run();

    expect(gatewaySpy).not.toHaveBeenCalled();
    expect(createRpcSpy).not.toHaveBeenCalled();
    expect(vscodeMock._outputChannels()).toHaveLength(0);
  });

  it('does nothing when disposed while showInputBox is pending', async () => {
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create');
    const createRpcSpy = vi.spyOn(AgentRuntime.prototype, 'createRpcService');
    const withProgressSpy = vi.spyOn(vscode.window, 'withProgress');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let resolveInput: (value: string) => void = () => undefined;
    vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(new Promise(resolve => {
      resolveInput = resolve;
    }));
    const controller = new GovernedForgeDemoController(context, root);

    try {
      const pending = controller.run();
      await flushMicrotasks();
      controller.dispose();
      resolveInput('Valid prompt after disposal');
      await pending;
      await flushMicrotasks();

      expect(vscodeMock._outputChannels()).toHaveLength(0);
      expect(createRpcSpy).not.toHaveBeenCalled();
      expect(gatewaySpy).not.toHaveBeenCalled();
      expect(withProgressSpy).not.toHaveBeenCalled();
      expect(vscodeMock._lastInformationMessage()).toBeUndefined();
      expect(vscodeMock._lastWarningMessage()).toBeUndefined();
      expect(vscodeMock._lastErrorMessage()).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('runs discover, reserve, invoke and retrieve through serialized dispatcher on the happy path', async () => {
    const provider = new MockProvider().enqueueText('original completion');
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const createRpcSpy = vi.spyOn(AgentRuntime.prototype, 'createRpcService');
    const dispatchSpy = vi.spyOn(LocalRpcDispatcher.prototype, 'dispatch');
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Explain governed execution.');

    await controller.run();

    const methods = dispatchSpy.mock.calls.map(call => {
      return rpcMethod(call[0]);
    });
    expect(methods).toEqual([
      'forge.discover',
      'forge.invocation.reserveStart',
      'forge.invocation.invokeModel',
      'forge.invocation.getModelExecutionResult',
    ]);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(provider.capturedRequests).toHaveLength(1);
    expect(provider.capturedRequests[0].messages[0].content).toBe('Explain governed execution.');
    expect(provider.capturedRequests[0].tools).toEqual([]);
    expect(provider.capturedRequests[0].options.model).toBe('demo-chat-model');

    const output = latestReport();
    expect(output).toContain('Model: demo-chat-model');
    expect(output).toContain('Configured provider: ollama');
    expect(output).toContain('Actual provider: ollama');
    expect(output).toContain('Status: completed');
    expect(output).toContain('Prompt characters: 27');
    expect(output).toContain('Invocation: invocation_');
    expect(output).toContain('Task: task_');
    expect(output).toContain('Reservation: forge-start-reservation:');
    expect(output).toContain('Retrieved outcome: completed');
    expect(output).toContain('original completion');
    expect(output).not.toContain('Explain governed execution.');
    expect(output).not.toContain('undefined');
    const accessKey = createRpcSpy.mock.calls[0]?.[0];
    expect(typeof accessKey).toBe('string');
    expect(vscodeMock._outputChannels()[0].name).toBe('KarkeDikha — Governed Forge');
    expect(output).not.toContain(accessKey);
    expect(allNotifications()).not.toContain(accessKey);
  });

  it('uses governed evidence duration in the output report', async () => {
    const provider = new MockProvider().enqueueText('duration completion');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const originalDispatch = LocalRpcDispatcher.prototype.dispatch;
    vi.spyOn(LocalRpcDispatcher.prototype, 'dispatch').mockImplementation(async function (
      this: LocalRpcDispatcher,
      raw: string,
      accessKey: string,
      clientId?: string,
    ) {
      const response = await originalDispatch.call(this, raw, accessKey, clientId);
      const method = rpcMethod(raw);
      if (method === 'forge.invocation.invokeModel') {
        return setNestedEvidenceDuration(response, 'modelCall', 12345);
      }
      if (method === 'forge.invocation.getModelExecutionResult') {
        return setNestedEvidenceDuration(response, 'result', 12345);
      }
      return response;
    });
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Report evidence duration');

    await controller.run();

    const output = latestReport();
    expect(output).toContain('Status: completed');
    expect(output).toContain('Duration: 12345 ms');
  });

  it.each([
    { name: 'missing duration', invokeDuration: undefined, retrievalDuration: undefined },
    { name: 'negative duration', invokeDuration: -1, retrievalDuration: -1 },
    { name: 'non-finite duration', invokeDuration: Number.POSITIVE_INFINITY, retrievalDuration: Number.POSITIVE_INFINITY },
    { name: 'mismatched invoke and retrieval duration', invokeDuration: 10, retrievalDuration: 11 },
  ])('uses the safe internal failure path for $name', async ({ invokeDuration, retrievalDuration }) => {
    const provider = new MockProvider().enqueueText('duration must not leak');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const originalDispatch = LocalRpcDispatcher.prototype.dispatch;
    vi.spyOn(LocalRpcDispatcher.prototype, 'dispatch').mockImplementation(async function (
      this: LocalRpcDispatcher,
      raw: string,
      accessKey: string,
      clientId?: string,
    ) {
      const response = await originalDispatch.call(this, raw, accessKey, clientId);
      const method = rpcMethod(raw);
      if (method === 'forge.invocation.invokeModel') {
        return setNestedEvidenceDuration(response, 'modelCall', invokeDuration);
      }
      if (method === 'forge.invocation.getModelExecutionResult') {
        return setNestedEvidenceDuration(response, 'result', retrievalDuration);
      }
      return response;
    });
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Reject bad duration');

    await controller.run();

    const output = latestReport();
    expect(output).toContain('Status: failed');
    expect(output).toContain('Retrieved outcome: internal_failure');
    expect(output).toContain('Failure code: internal_failure');
    expect(output).not.toContain('duration must not leak');
    expect(vscodeMock._lastErrorMessage()).toBe('KarkeDikha: governed Forge demo failed internally.');
  });

  it('reuses one retained RPC service across sequential runs with unique identities', async () => {
    const provider = new MockProvider()
      .enqueueText('first completion')
      .enqueueText('second completion');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const createRpcSpy = vi.spyOn(AgentRuntime.prototype, 'createRpcService');
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('First prompt');
    await controller.run();
    const firstOutput = latestReport();
    vscodeMock._setInputBoxValue('Second prompt');
    await controller.run();
    const secondOutput = latestReport();

    expect(createRpcSpy).toHaveBeenCalledTimes(1);
    expect(provider.capturedRequests).toHaveLength(2);
    const firstInvocation = /Invocation: (invocation_[^\n]+)/.exec(firstOutput)?.[1];
    const secondInvocation = /Invocation: (invocation_[^\n]+)/.exec(secondOutput)?.[1];
    const firstTask = /Task: (task_[^\n]+)/.exec(firstOutput)?.[1];
    const secondTask = /Task: (task_[^\n]+)/.exec(secondOutput)?.[1];
    expect(firstInvocation).toBeTruthy();
    expect(secondInvocation).toBeTruthy();
    expect(firstInvocation).not.toBe(secondInvocation);
    expect(firstTask).not.toBe(secondTask);
  });

  it('rejects overlapping invocation without starting a second provider call', async () => {
    const provider = new ControlledProvider(false);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Slow prompt');
    const first = controller.run();
    await waitUntil(() => provider.calls === 1);
    await controller.run();

    expect(vscodeMock._lastWarningMessage()).toContain('already running');
    expect(provider.calls).toBe(1);
    provider.resolveChat?.('slow completion');
    await first;
  });

  it('settles progress and becomes reusable while a completed notification remains unresolved', async () => {
    const provider = new MockProvider()
      .enqueueText('first complete')
      .enqueueText('second complete');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(new Promise(() => undefined));
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('First lifecycle prompt');
    await controller.run();

    expect(latestReport()).toContain('Status: completed');
    expect(latestReport()).toContain('first complete');
    expect(vscodeMock._hasActiveProgress()).toBe(false);

    vscodeMock._resetNotifications();
    vscodeMock._setInputBoxValue('Second lifecycle prompt');
    await controller.run();

    expect(vscodeMock._lastWarningMessage()).toBeUndefined();
    expect(latestReport()).toContain('Status: completed');
    expect(latestReport()).toContain('second complete');
  });

  it('becomes reusable while a cancelled notification remains unresolved', async () => {
    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(new Promise(() => undefined));
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Cancel with unresolved notification');
    const pending = controller.run();
    await waitUntil(() => provider.calls === 1);
    vscodeMock._cancelActiveProgress();
    await pending;

    expect(latestReport()).toContain('Status: cancelled');
    const laterProvider = new MockProvider().enqueueText('after unresolved cancel');
    vi.mocked(ProviderGateway.create).mockResolvedValue(laterProvider);
    vscodeMock._setInputBoxValue('Reuse after cancellation');
    await controller.run();

    expect(vscodeMock._lastWarningMessage()).toBeUndefined();
    expect(latestReport()).toContain('after unresolved cancel');
  });

  it('becomes reusable while a governed-failure notification remains unresolved', async () => {
    const provider = new MockProvider();
    vi.spyOn(provider, 'chat').mockRejectedValue(
      new ProviderModelNotFoundError('raw model exception should stay hidden', 'ollama', 'missing-model'),
    );
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(new Promise(() => undefined));
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Fail with unresolved warning');
    await controller.run();

    expect(latestReport()).toContain('Status: failed');
    expect(latestReport()).toContain('Failure code: model_unavailable');
    expect(latestReport()).not.toContain('raw model exception');

    const laterProvider = new MockProvider().enqueueText('after unresolved failure');
    vi.mocked(ProviderGateway.create).mockResolvedValue(laterProvider);
    vscodeMock._setInputBoxValue('Reuse after failure');
    await controller.run();

    expect(latestReport()).toContain('after unresolved failure');
  });

  it('contains rejected terminal notifications without replacing the governed report', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const provider = new MockProvider()
      .enqueueText('valid governed report')
      .enqueueText('reusable after rejected notification');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(vscode.window, 'showInformationMessage').mockRejectedValue(new Error('notification rejected'));
    const controller = new GovernedForgeDemoController(context, root);

    try {
      vscodeMock._setInputBoxValue('Notification rejects');
      await controller.run();
      await flushMicrotasks();

      expect(latestReport()).toContain('Status: completed');
      expect(latestReport()).toContain('valid governed report');
      expect(latestReport()).not.toContain('internal_failure');
      expect(unhandled).toEqual([]);

      vscodeMock._setInputBoxValue('Reuse after notification rejection');
      await controller.run();
      expect(latestReport()).toContain('reusable after rejected notification');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps the concurrent-run guard while provider execution is genuinely active', async () => {
    const provider = new ControlledProvider(false);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(new Promise(() => undefined));
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Active provider call');
    const first = controller.run();
    await waitUntil(() => provider.calls === 1);
    await controller.run();

    expect(vscodeMock._lastWarningMessage()).toContain('already running');
    expect(provider.calls).toBe(1);
    provider.resolveChat?.('active call settled');
    await first;
  });

  it('displays sanitized governed provider failure without raw provider exception text', async () => {
    vi.spyOn(ProviderGateway, 'create').mockRejectedValue(new Error('raw secret provider exception'));
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Fail safely');

    await controller.run();

    const output = latestOutput();
    expect(output).toContain('Status: failed');
    expect(output).toContain('Failure code: provider_failure');
    expect(output).toContain('Failure reason: The governed model provider failed during execution.');
    expect(output).not.toContain('raw secret provider exception');
    expect(vscodeMock._lastWarningMessage()).toContain('governed failure');
  });

  it('prints safe missing-model guidance without raw provider details', async () => {
    const raw = 'raw Ollama response with stack trace, access key sk-live-secret, and prompt THIS_SHOULD_NOT_LEAK';
    const provider = new MockProvider();
    vi.spyOn(provider, 'chat').mockRejectedValue(
      new ProviderModelNotFoundError(raw, 'ollama', 'definitely-not-installed-m7-m8-test:latest'),
    );
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vscodeMock._setConfig('ollama-agent.chatModel', 'definitely-not-installed-m7-m8-test:latest');
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('THIS_SHOULD_NOT_LEAK');

    await controller.run();

    const output = latestReport();
    expect(output).toContain('Failure code: model_unavailable');
    expect(output).toContain('Failure reason: The requested governed model was unavailable.');
    expect(output).toContain(
      'Next action: Install "definitely-not-installed-m7-m8-test:latest" with Ollama or select an installed model in ollama-agent.chatModel.',
    );
    expect(output).not.toContain(raw);
    expect(output).not.toContain('raw Ollama response');
    expect(output).not.toContain('stack trace');
    expect(output).not.toContain('sk-live-secret');
    expect(output).not.toContain('THIS_SHOULD_NOT_LEAK');
    expect(output).not.toContain('Completion:');
  });

  it('prints safe timeout and generic provider-failure guidance', async () => {
    const controller = new GovernedForgeDemoController(context, root);
    const timeoutProvider = new MockProvider();
    vi.spyOn(timeoutProvider, 'chat').mockRejectedValue(new ProviderTimeoutError('raw timeout endpoint', 'ollama', 5));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(timeoutProvider);

    vscodeMock._setInputBoxValue('Timeout prompt');
    await controller.run();

    expect(latestReport()).toContain('Failure code: timeout');
    expect(latestReport()).toContain('Next action: Verify provider responsiveness or increase ollama-agent.requestTimeout.');
    expect(latestReport()).not.toContain('raw timeout endpoint');

    const genericProvider = new MockProvider();
    vi.mocked(ProviderGateway.create).mockResolvedValue(genericProvider);
    vi.spyOn(genericProvider, 'chat').mockRejectedValue(new ProviderApiError('raw provider payload', 'ollama', 500));
    vscodeMock._setInputBoxValue('Generic failure prompt');
    await controller.run();

    expect(latestReport()).toContain('Failure code: provider_failure');
    expect(latestReport()).toContain(
      'Next action: Verify ollama-agent.providerType, ollama-agent.apiBase and provider availability.',
    );
    expect(latestReport()).not.toContain('raw provider payload');
  });

  it('does not add provider guidance to cancellation reports', async () => {
    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Cancel without guidance');
    const pending = controller.run();
    await waitUntil(() => provider.calls === 1);
    vscodeMock._cancelActiveProgress();
    await pending;

    const output = latestReport();
    expect(output).toContain('Status: cancelled');
    expect(output).not.toContain('Next action:');
    expect(output).not.toContain('provider availability');
  });

  it.each([
    {
      name: 'pending retrieval',
      result: {
        found: true,
        ready: false,
        outcome: 'pending',
        reservationId: 'controlled',
        invocationId: 'controlled',
        taskId: 'controlled',
        contractVersion: 1,
        nonExecuting: true,
        sideEffects: 'none',
        checkedAt: '2026-01-01T00:00:00.000Z',
        reasons: [],
      },
    },
    {
      name: 'mismatched model and retrieval status',
      result: {
        found: true,
        ready: true,
        outcome: 'failed',
        reservationId: 'controlled',
        invocationId: 'controlled',
        taskId: 'controlled',
        invoked: true,
        failureCode: 'provider_failure',
        evidence: {
          status: 'failed',
          providerType: 'ollama',
          promptCharacterCount: 20,
          durationMs: 0,
          failureCode: 'provider_failure',
          failureReason: 'The governed model provider failed during execution.',
        },
        contractVersion: 1,
        nonExecuting: true,
        sideEffects: 'none',
        checkedAt: '2026-01-01T00:00:00.000Z',
        reasons: [],
      },
    },
    {
      name: 'malformed retrieval',
      result: {
        found: true,
        ready: true,
        outcome: 'completed',
        reservationId: 'controlled',
        invocationId: 'controlled',
        taskId: 'controlled',
        invoked: true,
        contractVersion: 1,
        nonExecuting: true,
        sideEffects: 'none',
        checkedAt: '2026-01-01T00:00:00.000Z',
        reasons: [],
      },
    },
    {
      name: 'unexpected retrieval completion',
      result: {
        found: true,
        ready: true,
        outcome: 'completed',
        reservationId: 'controlled',
        invocationId: 'controlled',
        taskId: 'controlled',
        invoked: true,
        completion: 'must not be accepted from retrieval',
        evidence: {
          status: 'completed',
          providerType: 'ollama',
          promptCharacterCount: 20,
          durationMs: 0,
        },
        contractVersion: 1,
        nonExecuting: true,
        sideEffects: 'none',
        checkedAt: '2026-01-01T00:00:00.000Z',
        reasons: [],
      },
    },
  ])('uses the safe internal failure path for $name', async ({ result }) => {
    const provider = new MockProvider().enqueueText('strict retrieval completion');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const originalDispatch = LocalRpcDispatcher.prototype.dispatch;
    vi.spyOn(LocalRpcDispatcher.prototype, 'dispatch').mockImplementation(function (
      this: LocalRpcDispatcher,
      raw: string,
      accessKey: string,
      clientId?: string,
    ) {
      if (rpcMethod(raw) === 'forge.invocation.getModelExecutionResult') {
        return Promise.resolve(retrievalRpcResponse(result));
      }
      return originalDispatch.call(this, raw, accessKey, clientId);
    });
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Strict retrieval');

    await controller.run();

    const output = latestReport();
    expect(output).toContain('Status: failed');
    expect(output).toContain('Retrieved outcome: internal_failure');
    expect(output).toContain('Failure code: internal_failure');
    expect(output).not.toContain('strict retrieval completion');
    expect(output).not.toContain('must not be accepted from retrieval');
    expect(vscodeMock._lastErrorMessage()).toBe('KarkeDikha: governed Forge demo failed internally.');
  });

  it('cancels through dispatcher.cancelAll and remains reusable', async () => {
    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Cancel me');
    const pending = controller.run();
    await waitUntil(() => provider.calls === 1);
    vscodeMock._cancelActiveProgress();
    await pending;

    let output = latestReport();
    expect(provider.signal?.aborted).toBe(true);
    expect(output).toContain('Status: cancelled');
    expect(output).toContain('Retrieved outcome: cancelled');
    expect(output).not.toContain('Completion:');
    expect(output).not.toContain('failed internally');

    provider.resolveChat?.('unused after cancel');
    const laterProvider = new MockProvider().enqueueText('after cancellation works');
    vi.mocked(ProviderGateway.create).mockResolvedValue(laterProvider);
    vscodeMock._setInputBoxValue('Run later');
    await controller.run();

    output = latestReport();
    expect(output).toContain('Status: completed');
    expect(output).toContain('after cancellation works');
  });

  it('honors cancellation requested immediately before invokeModel reaches the provider', async () => {
    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const originalDispatch = LocalRpcDispatcher.prototype.dispatch;
    let cancelledFirstInvoke = false;
    vi.spyOn(LocalRpcDispatcher.prototype, 'dispatch').mockImplementation(function (
      this: LocalRpcDispatcher,
      raw: string,
      accessKey: string,
      clientId?: string,
    ) {
      if (!cancelledFirstInvoke && rpcMethod(raw) === 'forge.invocation.invokeModel') {
        cancelledFirstInvoke = true;
        vscodeMock._cancelActiveProgress();
      }
      return originalDispatch.call(this, raw, accessKey, clientId);
    });
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Cancel before provider starts');
    await controller.run();

    let output = latestReport();
    expect(provider.calls).toBe(1);
    expect(provider.signal?.aborted).toBe(true);
    expect(output).toContain('Status: cancelled');
    expect(output).toContain('Retrieved outcome: cancelled');
    expect(output).not.toContain('failed internally');
    expect(vscodeMock._lastErrorMessage()).toBeUndefined();

    const laterProvider = new MockProvider().enqueueText('usable after early cancellation');
    vi.mocked(ProviderGateway.create).mockResolvedValue(laterProvider);
    vscodeMock._setInputBoxValue('Run after early cancellation');
    await controller.run();

    output = latestReport();
    expect(output).toContain('Status: completed');
    expect(output).toContain('usable after early cancellation');
  });

  it('does not print late completion from a non-cooperative provider after cancellation', async () => {
    const provider = new ControlledProvider(false);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const controller = new GovernedForgeDemoController(context, root);

    vscodeMock._setInputBoxValue('Cancel late');
    const pending = controller.run();
    await waitUntil(() => provider.calls === 1);
    vscodeMock._cancelActiveProgress();
    expect(provider.signal?.aborted).toBe(true);

    provider.resolveChat?.('late completion must stay hidden');
    await pending;

    const output = latestReport();
    expect(output).toContain('Status: cancelled');
    expect(output).not.toContain('late completion must stay hidden');
    expect(output).not.toContain('Completion:');
  });

  it('disposes retained service and output channel', async () => {
    const provider = new MockProvider().enqueueText('done');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const stopSpy = vi.spyOn(AgentRuntime.prototype, 'stop');
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Dispose after run');

    await controller.run();
    const channel = vscodeMock._outputChannels()[0];
    controller.dispose();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(channel.disposed).toBe(true);
  });

  it('blocks later RPC work when disposed while discovery is pending', async () => {
    const provider = new ControlledProvider(true);
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const originalDispatch = LocalRpcDispatcher.prototype.dispatch;
    const dispatchedMethods: string[] = [];
    let releaseDiscover: () => void = () => undefined;
    const discoverGate = new Promise<void>(resolve => {
      releaseDiscover = resolve;
    });
    vi.spyOn(LocalRpcDispatcher.prototype, 'dispatch').mockImplementation(async function (
      this: LocalRpcDispatcher,
      raw: string,
      accessKey: string,
      clientId?: string,
    ) {
      const method = rpcMethod(raw);
      if (method) {
        dispatchedMethods.push(method);
      }
      if (method === 'forge.discover') {
        await discoverGate;
      }
      return originalDispatch.call(this, raw, accessKey, clientId);
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const controller = new GovernedForgeDemoController(context, root);

    try {
      vscodeMock._setInputBoxValue('Dispose during discover');
      const pending = controller.run();
      await waitUntil(() => dispatchedMethods.includes('forge.discover'));
      const channel = vscodeMock._outputChannels()[0];

      controller.dispose();
      releaseDiscover();
      await pending;
      await flushMicrotasks();

      expect(dispatchedMethods).toEqual(['forge.discover']);
      expect(gatewaySpy).not.toHaveBeenCalled();
      expect(provider.calls).toBe(0);
      expect(channel.disposed).toBe(true);
      expect(channel.content()).toBe('');
      expect(vscodeMock._lastInformationMessage()).toBeUndefined();
      expect(vscodeMock._lastWarningMessage()).toBeUndefined();
      expect(vscodeMock._lastErrorMessage()).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not introduce public cancellation, network listener, or deliberate task persistence', async () => {
    const provider = new MockProvider().enqueueText('architecture ok');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');
    const createTaskSpy = vi.spyOn(TaskStore.prototype, 'createTask');
    const controller = new GovernedForgeDemoController(context, root);
    vscodeMock._setInputBoxValue('Architecture check');

    await controller.run();

    expect(listenSpy).not.toHaveBeenCalled();
    expect(createTaskSpy).not.toHaveBeenCalled();
    expect(latestOutput()).not.toContain('forge.invocation.cancelModelCall');
  });
});
