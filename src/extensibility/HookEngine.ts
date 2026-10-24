export type HookStage =
  | 'session-start'
  | 'prompt'
  | 'plan'
  | 'pre-tool'
  | 'permission'
  | 'post-tool'
  | 'validation'
  | 'compaction'
  | 'stop';

export type HookDecisionType = 'allow' | 'deny' | 'ask' | 'defer' | 'transform' | 'inject';

export interface HookContext<TInput = unknown, TOutput = unknown> {
  stage: HookStage;
  taskId?: string;
  input: TInput;
  output?: TOutput;
  metadata: Record<string, unknown>;
  signal: AbortSignal;
}

export interface HookDecision {
  type: HookDecisionType;
  reason?: string;
  transformedInput?: unknown;
  transformedOutput?: unknown;
  injectedContext?: string[];
  deferUntil?: string;
}

export interface LifecycleHook {
  id: string;
  stage: HookStage;
  priority: number;
  trusted: boolean;
  timeoutMs: number;
  run(context: HookContext): Promise<HookDecision | void>;
}

export interface HookExecutionResult<TInput = unknown, TOutput = unknown> {
  status: 'allowed' | 'denied' | 'approval-required' | 'deferred';
  input: TInput;
  output?: TOutput;
  injectedContext: string[];
  decisions: Array<{ hookId: string; decision: HookDecision }>;
  reason?: string;
  deferUntil?: string;
}

export interface HookEngineOptions {
  maxHooksPerStage?: number;
  maxInjectedCharacters?: number;
}

export class HookEngine {
  private readonly hooks = new Map<HookStage, LifecycleHook[]>();
  private readonly maxHooksPerStage: number;
  private readonly maxInjectedCharacters: number;

  constructor(options: HookEngineOptions = {}) {
    this.maxHooksPerStage = options.maxHooksPerStage ?? 50;
    this.maxInjectedCharacters = options.maxInjectedCharacters ?? 50_000;
  }

  register(hook: LifecycleHook): void {
    validateHook(hook);
    const stageHooks = this.hooks.get(hook.stage) ?? [];
    if (stageHooks.some(existing => existing.id === hook.id)) {
      throw new Error(`Hook already registered for ${hook.stage}: ${hook.id}`);
    }
    if (stageHooks.length >= this.maxHooksPerStage) {
      throw new Error(`Hook limit reached for stage ${hook.stage}.`);
    }
    stageHooks.push(hook);
    stageHooks.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    this.hooks.set(hook.stage, stageHooks);
  }

  unregister(stage: HookStage, id: string): boolean {
    const stageHooks = this.hooks.get(stage);
    if (!stageHooks) return false;
    const index = stageHooks.findIndex(hook => hook.id === id);
    if (index < 0) return false;
    stageHooks.splice(index, 1);
    return true;
  }

  list(stage?: HookStage): LifecycleHook[] {
    if (stage) return [...(this.hooks.get(stage) ?? [])];
    return [...this.hooks.values()].flat().sort((left, right) => left.stage.localeCompare(right.stage) || left.priority - right.priority || left.id.localeCompare(right.id));
  }

  async execute<TInput, TOutput>(
    stage: HookStage,
    input: TInput,
    options: {
      output?: TOutput;
      taskId?: string;
      metadata?: Record<string, unknown>;
      signal?: AbortSignal;
      hardDenied?: boolean;
      hardDenyReason?: string;
    } = {},
  ): Promise<HookExecutionResult<TInput, TOutput>> {
    if (options.hardDenied) {
      return {
        status: 'denied',
        input,
        output: options.output,
        injectedContext: [],
        decisions: [],
        reason: options.hardDenyReason ?? 'Action is denied by immutable policy.',
      };
    }

    const parentSignal = options.signal ?? new AbortController().signal;
    let currentInput: unknown = cloneValue(input);
    let currentOutput: unknown = cloneValue(options.output);
    const injectedContext: string[] = [];
    const decisions: Array<{ hookId: string; decision: HookDecision }> = [];

    for (const hook of this.hooks.get(stage) ?? []) {
      if (parentSignal.aborted) throw abortError();
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      parentSignal.addEventListener('abort', onAbort, { once: true });
      let timer: NodeJS.Timeout | undefined;
      try {
        const decision = await Promise.race([
          hook.run({
            stage,
            taskId: options.taskId,
            input: cloneValue(currentInput),
            output: cloneValue(currentOutput),
            metadata: { ...(options.metadata ?? {}) },
            signal: controller.signal,
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`Hook ${hook.id} timed out after ${hook.timeoutMs}ms.`));
            }, hook.timeoutMs);
          }),
        ]);
        if (!decision) continue;
        validateDecision(decision, hook);
        decisions.push({ hookId: hook.id, decision: cloneDecision(decision) });

        if (decision.type === 'deny') {
          return buildTerminal('denied', decision.reason ?? `Denied by hook ${hook.id}.`);
        }
        if (decision.type === 'ask') {
          return buildTerminal('approval-required', decision.reason ?? `Approval required by hook ${hook.id}.`);
        }
        if (decision.type === 'defer') {
          return {
            ...buildTerminal('deferred', decision.reason ?? `Deferred by hook ${hook.id}.`),
            deferUntil: decision.deferUntil,
          };
        }
        if (decision.type === 'transform') {
          if (decision.transformedInput !== undefined) currentInput = cloneValue(decision.transformedInput);
          if (decision.transformedOutput !== undefined) currentOutput = cloneValue(decision.transformedOutput);
        }
        if (decision.type === 'inject') {
          for (const item of decision.injectedContext ?? []) {
            const nextSize = injectedContext.reduce((sum, value) => sum + value.length, 0) + item.length;
            if (nextSize > this.maxInjectedCharacters) {
              throw new Error(`Hook context injection limit exceeded at ${hook.id}.`);
            }
            injectedContext.push(item);
          }
        }
      } catch (error) {
        return buildTerminal(
          hook.trusted ? 'denied' : 'approval-required',
          `Hook ${hook.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer) clearTimeout(timer);
        parentSignal.removeEventListener('abort', onAbort);
      }
    }

    return {
      status: 'allowed',
      input: currentInput as TInput,
      output: currentOutput as TOutput | undefined,
      injectedContext,
      decisions,
    };

    function buildTerminal(status: HookExecutionResult<TInput, TOutput>['status'], reason: string): HookExecutionResult<TInput, TOutput> {
      return {
        status,
        input: currentInput as TInput,
        output: currentOutput as TOutput | undefined,
        injectedContext: [...injectedContext],
        decisions: decisions.map(entry => ({ hookId: entry.hookId, decision: cloneDecision(entry.decision) })),
        reason,
      };
    }
  }
}

function validateHook(hook: LifecycleHook): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(hook.id)) throw new Error(`Invalid hook id: ${hook.id}`);
  if (!Number.isFinite(hook.priority)) throw new Error(`Invalid hook priority: ${hook.id}`);
  if (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 10 || hook.timeoutMs > 120_000) {
    throw new Error(`Invalid hook timeout: ${hook.id}`);
  }
}

function validateDecision(decision: HookDecision, hook: LifecycleHook): void {
  if (!['allow', 'deny', 'ask', 'defer', 'transform', 'inject'].includes(decision.type)) {
    throw new Error(`Hook ${hook.id} returned an invalid decision.`);
  }
  if (decision.type === 'defer' && (!decision.deferUntil || !Number.isFinite(Date.parse(decision.deferUntil)))) {
    throw new Error(`Hook ${hook.id} returned an invalid deferUntil value.`);
  }
  if (decision.type === 'inject' && !Array.isArray(decision.injectedContext)) {
    throw new Error(`Hook ${hook.id} must provide injectedContext.`);
  }
}

function cloneDecision(decision: HookDecision): HookDecision {
  return {
    ...decision,
    transformedInput: cloneValue(decision.transformedInput),
    transformedOutput: cloneValue(decision.transformedOutput),
    injectedContext: decision.injectedContext ? [...decision.injectedContext] : undefined,
  };
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function abortError(): Error {
  const error = new Error('Hook execution cancelled.');
  error.name = 'AbortError';
  return error;
}
