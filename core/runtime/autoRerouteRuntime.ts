/**
 * Live Auto reroute: runs after an executor attempt ended `failed` and decides, from durable facts only, whether a
 * bounded successor on another model may continue the SAME objective. Pure policy lives in `platform/autoReroute`;
 * this file supplies the runtime facts (mutation evidence, chain length, frozen spend policy) and creates the successor.
 */
import type { CoreDatabase } from '../db/connection';
import type { AttemptContextRecord, AttemptRecord } from '../shared/wireTypes';
import { getAttempt, rerouteAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { FailureCooldowns, planAutoReroute, DEFAULT_MAX_REROUTES } from '../platform/autoReroute';
import { LOCAL_PROVIDER_ID, modelKey, parseLocalOllamaModels, type ModelDescriptor, type ModelRequirements } from '../platform/modelCatalog';
import { DEFAULT_SPEND_POLICY, type CloudSpendPolicy, type QuotaTracker } from '../platform/cloudRouting';
import { ProviderCatalog } from '../platform/providerCatalog';
import { providerDeclaresNoChat } from '../domain/empiricalRouting';
import { fetchOllamaCatalog, getOllamaCapabilities } from './ollamaCatalog';

/** Host-supplied facts about what could take over right now. Absent => Auto never reroutes (fail closed). */
export interface RerouteEnvironment {
  models: readonly ModelDescriptor[];
  reachableLocalKeys: ReadonlySet<string>;
  connectedProviders: ReadonlySet<string>;
  catalog: ProviderCatalog;
  quota?: QuotaTracker;
}

export type RerouteEnvironmentProvider = () => Promise<RerouteEnvironment | undefined> | RerouteEnvironment | undefined;

export const OLLAMA_ATTEMPT_PROVIDER = 'ollama';

const localCatalog = new ProviderCatalog();

/** Production default: whatever the local Ollama currently serves (embedding models are excluded by kind). */
export async function localRerouteEnvironment(): Promise<RerouteEnvironment | undefined> {
  const installed = await fetchOllamaCatalog();
  if (!installed.reachable) return undefined;
  const all = parseLocalOllamaModels(installed.models.map(name => ({ name })));
  // Provider evidence, not name hints: a model the provider says cannot chat is never a reroute successor.
  const declared = await Promise.all(all.map(async d => [d, await getOllamaCapabilities(d.modelId)] as const));
  const models = declared.filter(([, capabilities]) => !providerDeclaresNoChat(capabilities)).map(([d]) => d);
  return { models, reachableLocalKeys: new Set(models.map(modelKey)), connectedProviders: new Set(), catalog: localCatalog };
}

/** Auto = the model was chosen by routing, not by the user and not forced by a benchmark. Unknown => treated as Manual. */
export function isAutoSelection(context: AttemptContextRecord): boolean {
  const selection = context.modelSelection;
  return Boolean(selection) && selection!.userOverrode === false && selection!.benchmarkForcedModel !== true;
}

function attemptModelKey(provider: string, model: string): string {
  return provider === OLLAMA_ATTEMPT_PROVIDER ? model : `${provider}::${model}`;
}

function chainOf(db: CoreDatabase, attempt: AttemptRecord): AttemptRecord[] {
  const chain: AttemptRecord[] = [attempt];
  let cursor = attempt;
  while (cursor.predecessorAttemptId && chain.length < 16) {
    cursor = getAttempt(db, cursor.predecessorAttemptId);
    chain.push(cursor);
  }
  return chain;
}

export interface AutoRerouteDeps {
  db: CoreDatabase;
  actor: string;
  environment?: RerouteEnvironmentProvider;
  cooldowns: FailureCooldowns;
  /** True for tool names that mutate (workspace mutators + non-read-only governed capabilities). */
  isMutatingTool: (toolName: string) => boolean;
}

/** Returns the successor attempt to run, or undefined when no reroute is permitted. Never throws. */
export async function maybeAutoReroute(deps: AutoRerouteDeps, attemptId: string): Promise<AttemptRecord | undefined> {
  try {
    const attempt = getAttempt(deps.db, attemptId);
    if (attempt.status !== 'failed' || !attempt.failureReason) return undefined;
    // A stopped task is the user's decision; it is never continued on another model.
    if (attempt.cancelRequestedAt) return undefined;
    if (attempt.kind !== 'baat_kar' && attempt.kind !== 'saath_kar') return undefined;
    const context = getAttemptContext(deps.db, attemptId);
    // Every failed Baat/Saath attempt gets exactly one durable decision (rerouted | declined) so a host can tell
    // "a successor is coming" from "this failure is final" without a timer guess.
    const decline = (reason: string): undefined => {
      recordRuntimeEvent(deps.db, {
        domain: 'attempt', entityId: attemptId, eventType: 'attempt_reroute_declined', actor: deps.actor,
        metadata: { reason, fingerprint: null, failedModel: context.selectedModel },
      });
      return undefined;
    };
    if (!isAutoSelection(context)) return decline('Manual selection is exact; no model was substituted.');
    const env = await deps.environment?.();
    if (!env) return decline('No alternative model inventory is available.');

    // Mutation evidence is durable: any mutating tool invocation that was not cleanly refused counts as applied.
    const invoked = deps.db.all<{ toolName: string; status: string }>(
      'SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [attemptId]);
    const mutationApplied = invoked.some(row => deps.isMutatingTool(row.toolName) && row.status !== 'failed' && row.status !== 'cancelled');

    const chain = chainOf(deps.db, attempt);
    // Only Auto reroutes count against the bound; an explicit user Retry in the chain does not consume it.
    const reroutesSoFar = chain.filter(a => Boolean(deps.db.get(
      "SELECT 1 FROM runtime_events WHERE entityId = ? AND eventType = 'attempt_rerouted' LIMIT 1", [a.id]))).length;
    // A model this objective already used never gets a second turn, whatever the fingerprint.
    const used = new Set(chain.map(a => {
      const c = getAttemptContext(deps.db, a.id);
      return attemptModelKey(c.selectedProvider, c.selectedModel);
    }));
    const failedKey = attemptModelKey(context.selectedProvider, context.selectedModel);
    const spend = context.modelSelection?.cloudSpend;
    const policy: CloudSpendPolicy = spend ? { mode: spend.mode, allowCredits: spend.allowCredits } : DEFAULT_SPEND_POLICY;
    const requirements: ModelRequirements = {
      tools: attempt.kind === 'saath_kar' ? true : undefined,
      vision: context.modelSelection?.requiredCapabilities.vision ? true : undefined,
    };
    const decision = planAutoReroute({
      selection: 'auto',
      failureReason: attempt.failureReason,
      mutationApplied,
      failedModelKey: failedKey,
      reroutesSoFar,
      maxReroutes: DEFAULT_MAX_REROUTES,
      models: env.models.filter(d => modelKey(d) === failedKey || !used.has(modelKey(d))),
      reachableLocalKeys: env.reachableLocalKeys,
      connectedProviders: env.connectedProviders,
      catalog: env.catalog,
      policy,
      quota: env.quota,
      requirements,
      cooldowns: deps.cooldowns,
    });
    if (decision.kind !== 'reroute') {
      recordRuntimeEvent(deps.db, {
        domain: 'attempt', entityId: attemptId, eventType: 'attempt_reroute_declined', actor: deps.actor,
        metadata: { reason: decision.reason, fingerprint: decision.fingerprint ?? null, failedModel: context.selectedModel, reroutesSoFar },
      });
      return undefined;
    }
    const next = decision.next;
    const isLocal = next.locality === 'local' || next.provider === LOCAL_PROVIDER_ID;
    return rerouteAttempt(deps.db, {
      predecessorAttemptId: attemptId,
      actor: deps.actor,
      provider: isLocal ? OLLAMA_ATTEMPT_PROVIDER : next.provider,
      model: next.modelId,
      cloudSpend: isLocal ? undefined : { mode: policy.mode, allowCredits: policy.allowCredits, modelFreeness: next.freeness },
      fingerprint: decision.fingerprint,
      reason: decision.reason,
      rerouteIndex: reroutesSoFar + 1,
    });
  } catch {
    try {
      recordRuntimeEvent(deps.db, {
        domain: 'attempt', entityId: attemptId, eventType: 'attempt_reroute_declined', actor: deps.actor,
        metadata: { reason: 'Reroute evaluation failed; the original failure stands.', fingerprint: null },
      });
    } catch { /* the original failure is already durable */ }
    return undefined; // a reroute problem must never mask the original, already-recorded failure
  }
}
