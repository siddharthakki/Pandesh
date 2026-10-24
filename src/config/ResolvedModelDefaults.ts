import type { ModelRole } from '../providers/InferenceTypes';

/**
 * Session-scoped memory of the model Auto-selected for each task role.
 *
 * Many call sites across the codebase (ModelRouter, GovernedCodingExecutor,
 * RoleRunner, LocalAgentEngine, M19AgentWorkforce, several activation
 * controllers — all predating discovery-based routing) read
 * `Config.getChatModel()`/`getAgentModel()`/etc. synchronously and dispatch
 * the returned string directly. Those settings now default to `""` ("Auto" —
 * see Defaults.ts), so without this cache every one of those call sites would
 * dispatch an empty model name whenever the corresponding role is unset.
 *
 * This cache never performs discovery and never invents a model name; it only
 * remembers the last real selection result from whoever already ran
 * discovery (AgentPanel.loadModels / selectModelForTask, via
 * ProductionModelCandidates + selectTaskModel). `Config.ts`'s getters consult
 * it only when the raw setting is empty, so an explicit user setting always
 * still wins, unaffected by anything cached here.
 */
const resolved = new Map<ModelRole, string>();

export const ResolvedModelDefaults = {
  set(role: ModelRole, model: string): void {
    if (model) resolved.set(role, model);
  },
  get(role: ModelRole): string | undefined {
    return resolved.get(role);
  },
  /** Test-only: clears cached state between test cases. */
  clear(): void {
    resolved.clear();
  },
};
