/**
 * Runtime half of the intent kernel: picks the model that takes over, resumes an
 * intent through the domain layer, and starts the successor on the executor.
 *
 * Policy (what may run) lives in `core/domain/intents.ts`; this file only
 * supplies facts about the live host (which models are installed) and starts
 * execution. It adds no second execution path: the successor is an ordinary
 * attempt run by `RuntimeExecutor.execute`, behind the same workspace
 * confinement and approval gates as any other attempt.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import {
  latestIntentAttempt,
  listOpenIntents,
  resumeIntent,
  settleIntentAfterAttempt,
  usedModels,
  type IntentRecord,
  type ResumeOutcome,
} from '../domain/intents';
import { getAttemptContext } from '../domain/attemptContext';
import { modelKey } from '../platform/modelCatalog';
import type { RerouteEnvironmentProvider } from './autoRerouteRuntime';
import { getOllamaCapabilities } from './ollamaCatalog';
import type { RuntimeExecutor } from './executor';

const ACTOR = 'core:intent-kernel';

export interface IntentRecoveryDeps {
  db: CoreDatabase;
  broadcaster: EventBroadcaster;
  executor: Pick<RuntimeExecutor, 'execute'>;
  environment?: RerouteEnvironmentProvider;
  /** Provider-declared capabilities for a model whose tool support is not already known. Defaults to Ollama's `/api/show`. */
  probeCapabilities?: (model: string) => Promise<readonly string[] | undefined>;
  log?: (message: string) => void;
}

/**
 * The model that should take over `intent`: the operator's explicit choice
 * (`KARKEDIKHA_INTENT_RESUME_MODEL`) when it is unused, otherwise an installed
 * local model that has not worked on this intent and that supports tools.
 * Declared tool support wins; a model whose support is unknown is accepted only
 * if the provider's own capability list says so. A model that declares no tool
 * support is never chosen. Returns undefined when nothing qualifies — recovery
 * then stops rather than guessing.
 */
export async function chooseResumeModel(
  deps: Pick<IntentRecoveryDeps, 'db' | 'environment' | 'probeCapabilities'>,
  intent: IntentRecord,
): Promise<string | undefined> {
  const latest = latestIntentAttempt(deps.db, intent.requestId);
  if (!latest) return undefined;
  const provider = getAttemptContext(deps.db, latest.id).selectedProvider;
  const used = usedModels(deps.db, intent.requestId);
  const explicit = process.env.KARKEDIKHA_INTENT_RESUME_MODEL?.trim();
  if (explicit) return used.has(`${provider}::${explicit}`) ? undefined : explicit;
  const env = await deps.environment?.();
  if (!env) return undefined;
  const eligible = env.models.filter((m) =>
    m.kind === 'generative'
    && m.tools !== false
    && env.reachableLocalKeys.has(modelKey(m))
    && !used.has(`${provider}::${m.modelId}`));
  const declared = eligible.find((m) => m.tools === true);
  if (declared) return declared.modelId;
  const probe = deps.probeCapabilities ?? getOllamaCapabilities;
  for (const m of eligible) {
    if ((await probe(m.modelId))?.includes('tools')) return m.modelId;
  }
  return undefined;
}

function publishSince(deps: IntentRecoveryDeps, sequenceBefore: number): void {
  for (const event of listRuntimeEventsAfter(deps.db, sequenceBefore, 200)) deps.broadcaster.publishRuntime(event);
}

/** Resumes an intent on `model` and starts the successor. The successor runs in the background. */
export function resumeAndExecute(deps: IntentRecoveryDeps, intentId: string, model: string, reason?: string): ResumeOutcome {
  const before = latestRuntimeSequence(deps.db);
  const outcome = resumeIntent(deps.db, { intentId, model, actor: ACTOR, reason });
  publishSince(deps, before);
  if (outcome.kind === 'resumed') {
    void deps.executor.execute(outcome.successor.id).catch((err: unknown) => {
      deps.log?.(`intent ${intentId}: successor ${outcome.successor.id} failed to run: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return outcome;
}

/**
 * Boot recovery. By the time this runs, `failDeadExecutorAttemptsOnBoot` has
 * already settled attempts a dead executor left behind as `failed` (never
 * replayed). For each still-open intent whose chain ends in such an attempt:
 * check the workspace first (the work may have finished), and only if it has not,
 * hand the intent to a different model. Nothing here ever throws.
 */
export async function recoverIntentsOnBoot(deps: IntentRecoveryDeps): Promise<Array<{ intentId: string; result: string }>> {
  const report: Array<{ intentId: string; result: string }> = [];
  for (const intent of listOpenIntents(deps.db)) {
    try {
      const latest = latestIntentAttempt(deps.db, intent.requestId);
      if (!latest) continue;
      const before = latestRuntimeSequence(deps.db);
      const settled = settleIntentAfterAttempt(deps.db, latest.id, ACTOR);
      publishSince(deps, before);
      if (settled?.intent.status === 'verified') { report.push({ intentId: intent.id, result: 'verified without a resume' }); continue; }
      if (latest.status !== 'failed' || latest.cancelRequestedAt) continue;
      const model = await chooseResumeModel(deps, intent);
      if (!model) { report.push({ intentId: intent.id, result: 'no unused tool-capable model available; left for a person' }); continue; }
      const outcome = resumeAndExecute(deps, intent.id, model, 'Core restarted while the intent was running; continuing from checkpoint');
      report.push({ intentId: intent.id, result: outcome.kind === 'resumed' ? `resumed on ${model} as ${outcome.successor.id}` : outcome.kind });
    } catch (err) {
      report.push({ intentId: intent.id, result: `recovery error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const line of report) deps.log?.(`intent recovery: ${line.intentId}: ${line.result}`);
  return report;
}
