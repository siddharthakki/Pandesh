import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
} from '../agent/ForgeCallableSurface';
import { FORGE_DISCOVER_RPC_METHOD } from '../agent/ForgeRpcRegistration';
import { AgentRuntime } from '../agent/AgentRuntime';
import { Config } from '../config/Config';
import { LocalRpcResponse } from '../runtime/LocalRpcServer';
import { RpcServiceLifecycle } from '../runtime/RpcServiceLifecycle';

export const RUN_GOVERNED_FORGE_DEMO_COMMAND = 'ollama-agent.runGovernedForgeDemo' as const;
export const GOVERNED_FORGE_DEMO_TITLE = 'Run Governed Forge Demo' as const;

const OUTPUT_CHANNEL_NAME = 'KarkeDikha — Governed Forge';
const REQUIRED_METHODS = [
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
] as const;

type GovernedStatus = 'completed' | 'failed' | 'cancelled';

interface DemoService {
  runtime: AgentRuntime;
  service: RpcServiceLifecycle;
  accessKey: string;
}

interface ModelCallResult {
  status: GovernedStatus;
  invoked: boolean;
  durationMs: number;
  completion?: string;
  evidenceProvider?: string;
  promptCharacterCount?: number;
  failureCode?: string;
  failureReason?: string;
}

interface RetrievalResult {
  outcome: GovernedStatus;
  status: GovernedStatus;
  durationMs: number;
  evidenceProvider?: string;
  promptCharacterCount?: number;
  failureCode?: string;
  failureReason?: string;
}

interface DemoReport {
  runId: string;
  model: string;
  configuredProvider: string;
  actualProvider: string;
  status: GovernedStatus;
  durationMs: number;
  promptCharacters: number;
  invocationId: string;
  taskId: string;
  reservationId: string;
  retrievedOutcome: string;
  completion?: string;
  failureCode?: string;
  failureReason?: string;
}

export class GovernedForgeDemoController implements vscode.Disposable {
  private demoService?: DemoService;
  private outputChannel?: vscode.OutputChannel;
  private running = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
  ) {}

  async run(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      await vscode.window.showWarningMessage('KarkeDikha: governed Forge demo is already running.');
      return;
    }

    this.running = true;
    try {
      const prompt = await vscode.window.showInputBox({
        title: 'KarkeDikha — Governed Forge Demo',
        placeHolder: 'Ask the configured local model a question',
        ignoreFocusOut: true,
      });
      const trimmedPrompt = prompt?.trim();
      if (!trimmedPrompt || this.disposed) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running Governed Forge Demo',
          cancellable: true,
        },
        async (_progress, token) => this.runWithProgress(trimmedPrompt, token),
      );
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    const runtime = this.demoService?.runtime;
    this.demoService = undefined;
    runtime?.stop();
    this.outputChannel?.dispose();
    this.outputChannel = undefined;
  }

  private async runWithProgress(prompt: string, token: vscode.CancellationToken): Promise<void> {
    if (this.disposed) {
      return;
    }
    const output = this.getOutputChannel();
    const runId = randomId('run');
    const invocationId = randomId('invocation');
    const taskId = randomId('task');
    const clientId = 'governed-forge-demo';
    const started = Date.now();
    const model = Config.getChatModel();
    const configuredProvider = Config.getProviderType();
    let reservationId = 'unavailable';
    let tokenListener: vscode.Disposable | undefined;
    let cancellationRequested = token.isCancellationRequested;

    try {
      const demo = this.getDemoService();
      tokenListener = token.onCancellationRequested(() => {
        cancellationRequested = true;
        demo.service.dispatcher.cancelAll();
      });

      await this.discoverRequiredMethods(demo, clientId);
      reservationId = await this.reserveStart(demo, clientId, invocationId, taskId, prompt);
      const modelCall = await this.invokeModel(
        demo,
        clientId,
        reservationId,
        model,
        token,
        () => cancellationRequested,
      );
      const retrieval = await this.retrieveResult(
        demo,
        clientId,
        reservationId,
        invocationId,
        taskId,
        modelCall.status,
      );
      if (modelCall.durationMs !== retrieval.durationMs) {
        throw new Error('Governed evidence duration mismatch.');
      }

      const report: DemoReport = {
        runId,
        model,
        configuredProvider,
        actualProvider: retrieval.evidenceProvider ?? modelCall.evidenceProvider ?? 'unavailable',
        status: retrieval.status,
        durationMs: retrieval.durationMs,
        promptCharacters: retrieval.promptCharacterCount ?? modelCall.promptCharacterCount ?? prompt.length,
        invocationId,
        taskId,
        reservationId,
        retrievedOutcome: retrieval.outcome,
        completion: retrieval.status === 'completed' ? modelCall.completion : undefined,
        failureCode: retrieval.failureCode ?? modelCall.failureCode,
        failureReason: retrieval.failureReason ?? modelCall.failureReason,
      };

      if (this.disposed) {
        return;
      }
      this.appendReport(output, report);
      output.show(true);
      if (this.disposed) {
        return;
      }
      this.showTerminalNotification(retrieval.status);
    } catch {
      if (this.disposed) {
        return;
      }
      this.appendUnexpectedFailure(output, {
        runId,
        model,
        configuredProvider,
        durationMs: Date.now() - started,
        promptCharacters: prompt.length,
        invocationId,
        taskId,
        reservationId,
      });
      output.show(true);
      if (this.disposed) {
        return;
      }
      this.showInternalFailureNotification();
    } finally {
      tokenListener?.dispose();
    }
  }

  private getDemoService(): DemoService {
    if (this.disposed) {
      throw new Error('Governed Forge demo controller is disposed.');
    }
    if (!this.demoService) {
      const accessKey = crypto.randomBytes(32).toString('hex');
      const runtime = new AgentRuntime(this.workspaceRoot, this.context.secrets);
      const service = runtime.createRpcService(accessKey, Config.getRequestTimeoutMs());
      this.demoService = { runtime, service, accessKey };
    }
    return this.demoService;
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return this.outputChannel;
  }

  private async discoverRequiredMethods(demo: DemoService, clientId: string): Promise<void> {
    const result = await this.dispatch(demo, clientId, FORGE_DISCOVER_RPC_METHOD);
    if (!Array.isArray(result)) {
      throw new Error('Invalid Forge discovery response.');
    }
    const methods = new Set<string>();
    for (const descriptor of result) {
      const record = objectRecord(descriptor);
      const id = record?.id;
      if (typeof id === 'string') {
        methods.add(id);
      }
    }
    for (const required of REQUIRED_METHODS) {
      if (!methods.has(required)) {
        throw new Error('Required Forge method is unavailable.');
      }
    }
  }

  private async reserveStart(
    demo: DemoService,
    clientId: string,
    invocationId: string,
    taskId: string,
    goal: string,
  ): Promise<string> {
    const result = await this.dispatch(demo, clientId, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal,
      prepared: true,
    });
    const response = objectRecord(result);
    if (!response || response.ok !== true) {
      throw new Error('Forge reservation failed.');
    }
    const reservation = objectRecord(response.reservation);
    if (!reservation || reservation.accepted !== true || typeof reservation.reservationId !== 'string') {
      throw new Error('Forge reservation was not accepted.');
    }
    return reservation.reservationId;
  }

  private async invokeModel(
    demo: DemoService,
    clientId: string,
    reservationId: string,
    model: string,
    token: vscode.CancellationToken,
    cancellationRequested: () => boolean,
  ): Promise<ModelCallResult> {
    const pending = this.dispatch(demo, clientId, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model,
    });
    if (token.isCancellationRequested || cancellationRequested()) {
      demo.service.dispatcher.cancelAll();
    }
    const result = await pending;
    const response = objectRecord(result);
    if (!response || response.ok !== true) {
      throw new Error('Forge model invocation failed.');
    }
    const modelCall = objectRecord(response.modelCall);
    if (!modelCall) {
      throw new Error('Invalid Forge model invocation response.');
    }
    return parseModelCall(modelCall);
  }

  private async retrieveResult(
    demo: DemoService,
    clientId: string,
    reservationId: string,
    invocationId: string,
    taskId: string,
    modelStatus: GovernedStatus,
  ): Promise<RetrievalResult> {
    const result = await this.dispatch(demo, clientId, FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId,
      taskId,
    });
    const response = objectRecord(result);
    if (!response || response.ok !== true) {
      throw new Error('Forge model result retrieval failed.');
    }
    const lookup = objectRecord(response.result);
    if (!lookup) {
      throw new Error('Invalid Forge model result lookup response.');
    }
    return parseRetrieval(lookup, modelStatus);
  }

  private async dispatch(
    demo: DemoService,
    clientId: string,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error('Governed Forge demo controller is disposed.');
    }
    const request = {
      jsonrpc: '2.0',
      id: randomId('rpc'),
      method,
      params,
    };
    const response = await demo.service.dispatcher.dispatch(
      JSON.stringify(request),
      demo.accessKey,
      clientId,
    );
    return parseRpcSuccess(response);
  }

  private appendReport(output: vscode.OutputChannel, report: DemoReport): void {
    output.appendLine('------------------------------------------------------------');
    output.appendLine('Governed Forge Demo');
    output.appendLine(`Run: ${report.runId}`);
    output.appendLine(`Model: ${report.model}`);
    output.appendLine(`Configured provider: ${report.configuredProvider}`);
    output.appendLine(`Actual provider: ${report.actualProvider}`);
    output.appendLine(`Status: ${report.status}`);
    output.appendLine(`Duration: ${report.durationMs} ms`);
    output.appendLine(`Prompt characters: ${report.promptCharacters}`);
    output.appendLine(`Invocation: ${report.invocationId}`);
    output.appendLine(`Task: ${report.taskId}`);
    output.appendLine(`Reservation: ${report.reservationId}`);
    output.appendLine(`Retrieved outcome: ${report.retrievedOutcome}`);
    if (report.completion) {
      output.appendLine('');
      output.appendLine('Completion:');
      output.appendLine(report.completion);
    }
    if (report.failureCode) {
      output.appendLine(`Failure code: ${report.failureCode}`);
    }
    if (report.failureReason) {
      output.appendLine(`Failure reason: ${report.failureReason}`);
    }
    const nextAction = safeNextAction(report.failureCode, report.configuredProvider, report.model);
    if (nextAction) {
      output.appendLine(`Next action: ${nextAction}`);
    }
    output.appendLine('------------------------------------------------------------');
  }

  private appendUnexpectedFailure(
    output: vscode.OutputChannel,
    partial: Omit<DemoReport, 'actualProvider' | 'status' | 'retrievedOutcome'>,
  ): void {
    this.appendReport(output, {
      ...partial,
      actualProvider: 'unavailable',
      status: 'failed',
      retrievedOutcome: 'internal_failure',
      failureCode: 'internal_failure',
      failureReason: 'The governed demo failed before a safe terminal result was available.',
    });
  }

  private showTerminalNotification(status: GovernedStatus): void {
    if (this.disposed) {
      return;
    }
    const notification = status === 'failed'
      ? vscode.window.showWarningMessage('KarkeDikha: governed Forge demo finished with governed failure.')
      : vscode.window.showInformationMessage(
        status === 'completed'
          ? 'KarkeDikha: governed Forge demo completed.'
          : 'KarkeDikha: governed Forge demo cancelled.',
      );
    void notification.then(undefined, () => undefined);
  }

  private showInternalFailureNotification(): void {
    if (this.disposed) {
      return;
    }
    void vscode.window.showErrorMessage('KarkeDikha: governed Forge demo failed internally.')
      .then(undefined, () => undefined);
  }
}

function parseRpcSuccess(response: LocalRpcResponse | null): unknown {
  if (!response || response.error || response.result === undefined) {
    throw new Error('Local RPC request failed.');
  }
  return response.result;
}

function parseModelCall(modelCall: Record<string, unknown>): ModelCallResult {
  const evidence = objectRecord(modelCall.evidence);
  const status = governedStatus(evidence?.status);
  const durationMs = evidenceDuration(evidence);
  const completion = typeof modelCall.completion === 'string' ? modelCall.completion : undefined;
  const invoked = modelCall.invoked;
  if (typeof invoked !== 'boolean') {
    throw new Error('Invalid governed model invocation state.');
  }
  if (status === 'completed' && (!invoked || !completion)) {
    throw new Error('Invalid completed governed model invocation.');
  }
  if ((status === 'failed' || status === 'cancelled') && (invoked || completion !== undefined)) {
    throw new Error('Invalid terminal governed model invocation.');
  }
  return {
    status,
    invoked,
    durationMs,
    completion,
    evidenceProvider: stringValue(evidence?.providerType),
    promptCharacterCount: numberValue(evidence?.promptCharacterCount),
    failureCode: stringValue(modelCall.failureCode) ?? stringValue(evidence?.failureCode),
    failureReason: stringValue(evidence?.failureReason),
  };
}

function parseRetrieval(lookup: Record<string, unknown>, modelStatus: GovernedStatus): RetrievalResult {
  if (lookup.found !== true || lookup.ready !== true) {
    throw new Error('Governed result retrieval was not terminal.');
  }
  if ('completion' in lookup) {
    throw new Error('Governed result retrieval unexpectedly contained completion.');
  }
  const evidence = objectRecord(lookup.evidence);
  if (!evidence) {
    throw new Error('Governed result retrieval lacked evidence.');
  }
  const outcome = governedStatus(lookup.outcome);
  const evidenceStatus = governedStatus(evidence.status);
  const durationMs = evidenceDuration(evidence);
  if (outcome !== evidenceStatus || outcome !== modelStatus) {
    throw new Error('Governed result retrieval did not match invocation status.');
  }
  return {
    outcome,
    status: evidenceStatus,
    durationMs,
    evidenceProvider: stringValue(evidence.providerType),
    promptCharacterCount: numberValue(evidence.promptCharacterCount),
    failureCode: stringValue(lookup.failureCode) ?? stringValue(evidence.failureCode),
    failureReason: stringValue(evidence.failureReason),
  };
}

function governedStatus(value: unknown): GovernedStatus {
  const status = governedStatusOrUndefined(value);
  if (!status) {
    throw new Error('Invalid governed status.');
  }
  return status;
}

function governedStatusOrUndefined(value: unknown): GovernedStatus | undefined {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function evidenceDuration(evidence: Record<string, unknown> | undefined): number {
  const durationMs = evidence?.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('Invalid governed evidence duration.');
  }
  return durationMs;
}

function safeNextAction(
  failureCode: string | undefined,
  configuredProvider: string,
  model: string,
): string | undefined {
  if (failureCode === 'model_unavailable') {
    if (configuredProvider === 'ollama') {
      return `Install "${model}" with Ollama or select an installed model in ollama-agent.chatModel.`;
    }
    if (configuredProvider === 'openai-compatible') {
      return `Verify that "${model}" is exposed by the configured provider or change ollama-agent.chatModel.`;
    }
  }
  if (failureCode === 'timeout') {
    return 'Verify provider responsiveness or increase ollama-agent.requestTimeout.';
  }
  if (failureCode === 'provider_failure') {
    return 'Verify ollama-agent.providerType, ollama-agent.apiBase and provider availability.';
  }
  return undefined;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
