/**
 * What "a test reaching a real model" means, kept apart from the setup file that applies it so it can be tested.
 *
 * 2026-11-11: four local runs of the Core suite loaded qwen3-coder:swift-27b (21 GB of VRAM, context 65,536) on the
 * owner's own Ollama and stalled a live Pandesh run on the same PC for half an hour. core/test/backgroundTaskDelegation
 * runs the chat engine with no model and no fake Ollama, so it fell back to the engine default on 127.0.0.1:11434;
 * hermesEngine, opencodeEngine, piAgentEngine, piAgentWorkspaceDiscovery and projectContext.live leave the address unset
 * too. CI never saw it: GitHub's runner has no Ollama, only a stub that lists models.
 *
 * So a test may read what the local Ollama has (its version, tags, running models, a model's details), but a request
 * that could load, run, download, copy or delete a model is refused as if Ollama were not running, exactly as on CI.
 * An intentional live run opts in with any *_LIVE_* flag (KKD_LIVE_VISION=1, PANDESH_OLLAYA_LIVE=1,
 * RUN_LIVE_AGENT_TESTS=1, ...) or with PANDESH_TESTS_ALLOW_REAL_OLLAMA=1.
 */

/** The ports a real Ollama listens on here: Pandesh's models (11434) and the Ollaya decision models (11435). */
export const REAL_OLLAMA_PORTS: ReadonlySet<string> = new Set(['11434', '11435']);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/** Requests that only read what is installed or running. Everything else on a real Ollama port is refused. */
const READ_ONLY_PATH = /^\/(?:api\/(?:version|tags|ps|show)\/?)?$/;

/** True when the run opted in to real models (a live test run). */
export function liveModelsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PANDESH_TESTS_ALLOW_REAL_OLLAMA === '1') return true;
  return Object.entries(env).some(([name, value]) => /(?:^|_)LIVE(?:_|$)/.test(name) && Boolean(value) && !/^(?:0|false|no|off)$/i.test(String(value)));
}

/** True when this URL is a request that could load or change a model on the real local Ollama. */
export function isRealModelCall(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (!LOOPBACK_HOSTS.has(host) || !REAL_OLLAMA_PORTS.has(port)) return false;
  return !READ_ONLY_PATH.test(parsed.pathname);
}

type Dispatch = (this: unknown, options: { origin?: string | URL | null; path?: string }, handler: unknown) => boolean;

/**
 * Makes undici's Agent refuse a dispatch to a real model before any socket opens (ollamaStreamTransport.ts streams chat
 * through its own Agent, which the global fetch never sees). Patches the class once; returns true when it did so now.
 */
export function guardUndiciAgent(agentClass: { prototype: object }, env: NodeJS.ProcessEnv = process.env): boolean {
  const prototype = agentClass.prototype as { dispatch: Dispatch } & Record<symbol, unknown>;
  const guarded = Symbol.for('pandesh.tests.noRealModels.undici');
  if (liveModelsAllowed(env) || prototype[guarded]) return false;
  const dispatch = prototype.dispatch;
  prototype.dispatch = function guardedDispatch(this: unknown, options, handler) {
    const origin = String(options?.origin ?? '').replace(/\/$/, '');
    if (origin && isRealModelCall(`${origin}${options.path ?? ''}`)) throw refusedConnection(new URL(origin).host);
    return dispatch.call(this, options, handler);
  };
  prototype[guarded] = true;
  return true;
}

/** The error a refused request raises: shaped like "Ollama is not running", so code paths behave as they do on CI. */
export function refusedConnection(target: string): Error & { code: string; syscall: string } {
  return Object.assign(
    new Error(`connect ECONNREFUSED ${target} (refused by the test setup: tests never load a real model; see src/test/setup/realModelGuard.ts)`),
    { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect' },
  );
}
