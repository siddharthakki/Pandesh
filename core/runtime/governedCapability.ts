/**
 * M38 — Core-owned governed capability fabric.
 *
 * Generalizes the existing `ToolRunner` seam (core/runtime/toolRunner.ts) so
 * more than one capability (workspace shell/filesystem, external services)
 * can be dispatched through the same Core-owned execution path without a
 * second runtime, approval system, or evidence store. A `GovernedCapabilityRegistry`
 * *is* a `ToolRunner` — it is a drop-in replacement for `executor.ts`'s
 * `this.toolRunner`, so tool-call evidence keeps flowing through the existing
 * `startToolInvocation`/`completeToolInvocation` (core/domain/toolInvocations.ts)
 * path unchanged.
 *
 * Consequential capability actions do not invent a new approval mechanism:
 * they rely on the attempt already having passed its existing 'mutation'
 * approval gate (core/domain/approvals.ts) before the model loop is allowed
 * to call tools at all. This module adds capability-scoped risk
 * classification and health so a denied/unavailable capability fails closed
 * here, before any adapter (including a shell-based one) can execute it.
 */
import type { ModelToolDefinition, ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult, ToolRunner } from './toolRunner';
import { CoreToolRunner } from './toolRunner';

/** Inspectable capability health. A capability already known to be
 * unavailable/rate-limited/cancelling must never be dispatched to. */
export type CapabilityHealthState =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'authorization_required'
  | 'rate_limited'
  | 'cancelling'
  | 'stale';

export interface CapabilityHealth {
  state: CapabilityHealthState;
  reason?: string;
  checkedAt: string;
}

/** Read-only calls never mutate external state. Consequential calls do, and
 * must only run once the owning attempt's existing mutation-approval gate
 * has already been satisfied — the registry itself does not grant authority,
 * it only ever narrows it (fail closed on missing/denied approval upstream). */
export type CapabilityRisk = 'read_only' | 'consequential';

export interface GovernedCapabilityAdapter {
  /** Stable capability identity, e.g. 'workspace', 'research', 'github', 'mcp'. */
  readonly id: string;
  definitions(): ModelToolDefinition[];
  /** Risk classification for a specific tool call this adapter owns. */
  classify(toolName: string): CapabilityRisk;
  /** Cheap, synchronous-or-cached health snapshot; never blocks on network I/O. */
  health(): CapabilityHealth;
  /**
   * M39 (optional): the evidence-safe projection of this call's arguments.
   * `dispatchCapability` applies it BEFORE the approval summary and the
   * `tool_invocations.argsSummary` are written, so a capability that can
   * receive credential-shaped input (memory) never lets a raw secret reach
   * durable governed evidence. Adapters that cannot receive secrets omit it
   * and behave exactly as before.
   */
  redactArguments?(toolName: string, args: Record<string, unknown>): Record<string, unknown>;
  /**
   * M39 (optional): the evidence-safe projection of this call's arguments.
   * `dispatchCapability` applies it BEFORE the approval summary and the
   * `tool_invocations.argsSummary` are written, so a capability that can
   * receive credential-shaped input (memory) never lets a raw secret reach
   * durable governed evidence. Adapters that cannot receive secrets omit it
   * and behave exactly as before.
   */
  redactArguments?(toolName: string, args: Record<string, unknown>): Record<string, unknown>;
  /**
   * P0 (optional): the adapter's own enrichment of this call's arguments,
   * computed BEFORE the approval summary and its digest are written.
   *
   * It exists so an adapter can freeze a fact it verified at request time
   * into the approval. The clearest case is a process termination: the
   * adapter reads the target's creation time and executable path, so the
   * approval binds "this exact process", and execution can re-verify it
   * instead of trusting a bare PID that may have been recycled.
   */
  prepare?(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface CapabilityDeniedResult extends ToolExecutionResult {
  status: 'failed';
  resultCategory: 'capability_unavailable' | 'capability_unknown_tool';
}

function deniedResult(category: CapabilityDeniedResult['resultCategory'], message: string, toolName: string): CapabilityDeniedResult {
  return {
    status: 'failed',
    exitCode: null,
    output: message,
    resultCategory: category,
    normalizedArguments: { toolName },
  };
}

/**
 * Normalizes N capability adapters behind one `ToolRunner`. Tool-name
 * ownership is resolved once at registration time so dispatch is O(1) and
 * unambiguous — two adapters may never claim the same tool name.
 */
export class GovernedCapabilityRegistry implements ToolRunner {
  private readonly adaptersByTool = new Map<string, GovernedCapabilityAdapter>();
  private readonly adapters: GovernedCapabilityAdapter[] = [];

  register(adapter: GovernedCapabilityAdapter): this {
    for (const def of adapter.definitions()) {
      if (this.adaptersByTool.has(def.name)) {
        throw new Error(`governed capability conflict: tool '${def.name}' is already owned by capability '${this.adaptersByTool.get(def.name)!.id}'`);
      }
      this.adaptersByTool.set(def.name, adapter);
    }
    this.adapters.push(adapter);
    return this;
  }

  definitions(): ModelToolDefinition[] {
    return this.adapters.flatMap((adapter) => adapter.definitions());
  }

  /** Capability health, keyed by capability id — the fabric's discovery surface. */
  healthSnapshot(): Record<string, CapabilityHealth> {
    const snapshot: Record<string, CapabilityHealth> = {};
    for (const adapter of this.adapters) snapshot[adapter.id] = adapter.health();
    return snapshot;
  }

  /** Risk classification for a tool call, or `undefined` if no adapter owns it. */
  classify(toolName: string): { capabilityId: string; risk: CapabilityRisk } | undefined {
    const adapter = this.adaptersByTool.get(toolName);
    if (!adapter) return undefined;
    return { capabilityId: adapter.id, risk: adapter.classify(toolName) };
  }

  /** Evidence-safe arguments for a tool call: the owning adapter's own
   * projection when it declares one, otherwise the arguments unchanged. */
  redactArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const adapter = this.adaptersByTool.get(toolName);
    return adapter?.redactArguments ? adapter.redactArguments(toolName, args) : args;
  }

  /** The owning adapter's request-time enrichment, when it declares one. */
  async prepare(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const adapter = this.adaptersByTool.get(toolName);
    if (!adapter?.prepare) return args;
    const res = await adapter.prepare(toolName, args);
    if (res && typeof res === 'object' && 'ok' in res && 'arguments' in res && res.arguments && typeof res.arguments === 'object' && !Array.isArray(res.arguments)) {
      return res.arguments as Record<string, unknown>;
    }
    return res;
  }

  async run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const adapter = this.adaptersByTool.get(call.name);
    if (!adapter) return deniedResult('capability_unknown_tool', `no governed capability owns tool '${call.name}'`, call.name);
    const health = adapter.health();
    if (health.state === 'unavailable' || health.state === 'rate_limited' || health.state === 'cancelling' || health.state === 'authorization_required') {
      return deniedResult(
        'capability_unavailable',
        `capability '${adapter.id}' is ${health.state}${health.reason ? `: ${health.reason}` : ''}; the call was not dispatched`,
        call.name,
      );
    }
    try {
      return await adapter.run(call, ctx);
    } catch (error) {
      // A capability adapter that throws instead of returning a structured
      // failure must not take down the whole attempt loop uncaught (M42 —
      // recovery audit finding #3). Bounded so a raw exception/stack trace
      // can't flood evidence the way an unbounded provider message could.
      const message = error instanceof Error ? error.message : String(error);
      const bounded = message.length > 500 ? `${message.slice(0, 500)}…` : message;
      return {
        status: 'failed',
        exitCode: null,
        output: `capability '${adapter.id}' threw instead of returning a result: ${bounded}`,
        resultCategory: 'capability_threw',
      };
    }
  }
}

/**
 * Wraps the existing `CoreToolRunner` (shell + filesystem, cwd-scoped) as the
 * 'workspace' governed capability. Behavior, bounding, and cancellation are
 * unchanged — this only adds capability id/health/risk on top of the
 * pre-existing implementation so it can sit in the registry beside new
 * external-service adapters. `read_file` is read-only; `run_command` and
 * `propose_file_change` can mutate the workspace and are classified consequential.
 */
export function createWorkspaceCapabilityAdapter(runner: CoreToolRunner = new CoreToolRunner()): GovernedCapabilityAdapter {
  return {
    id: 'workspace',
    definitions: () => runner.definitions(),
    classify: (toolName) => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, ctx) => runner.run(call, ctx),
  };
}
