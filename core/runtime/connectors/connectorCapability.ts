/**
 * Jarvis Connector Foundation — one generic `ConnectorCapabilityAdapter`
 * factory shared by Gmail, Google Calendar, WhatsApp, and Printer (see
 * `connectorDefinitions.ts` for the four per-connector configs). Mirrors
 * `githubCapability.ts`'s shape (injectable executor, cached health, bounded
 * timeout, redaction) rather than inventing a new adapter pattern.
 *
 * Foundation-slice honesty (requirement #8, no live email/calendar/WhatsApp/
 * print action): `probe`/`executor` are optional. Production wiring
 * (`connectorDefinitions.ts`) supplies neither, so `health()` can never report
 * `available` (there is no real probe to succeed) and `run()` can never
 * perform a live action — both fail closed with a typed, evidence-safe reason
 * rather than a silent no-op. Tests inject a fake `probe`/`executor` to prove
 * the governed mechanism (permission gate, approval, idempotency, cancellation)
 * works once a real integration is wired in behind the same seam.
 */
import type { ModelToolDefinition, ModelToolCall } from '../modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from '../toolRunner';
import type { CapabilityHealth, CapabilityRisk } from '../governedCapability';
import type { ConnectorId, ConnectorActionTier, ConnectorCapabilityAdapter } from './connectorTypes';

const MAX_ARG_STRING_CHARS = 4_000;

/** Last line of defense: bounds long text fields and strips anything shaped
 * like a credential/token before arguments can ever reach durable evidence.
 * Real secrets never flow through tool arguments in this design (they live in
 * `process.env[credentialEnvVar]`, read only inside the adapter), but this
 * keeps the guarantee structural rather than trusting every future caller. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    let text = value
      .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
      .replace(/(-{5}BEGIN[\s\S]*?-{5}END[^-]*-{5})/g, '[redacted-key-block]');
    if (text.length > MAX_ARG_STRING_CHARS) text = `${text.slice(0, MAX_ARG_STRING_CHARS)}\n…[truncated]`;
    out[key] = text;
  }
  return out;
}

function deniedResult(resultCategory: string, message: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output: message, resultCategory };
}

export interface ConnectorToolSpec {
  name: string;
  tier: ConnectorActionTier;
  description: string;
  parameters: ModelToolDefinition['parameters'];
}

export interface ConnectorProbeResult {
  ok: boolean;
  reason?: string;
}

export type ConnectorProbe = (signal: AbortSignal) => Promise<ConnectorProbeResult>;

export type ConnectorPrepareResult =
  | { ok: true; arguments: Record<string, unknown>; presentation?: Record<string, unknown> }
  | { ok: false; reason: string };
export type ConnectorPrepare = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ConnectorPrepareResult>;
export type ConnectorExecutor = (toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;

export interface ConnectorAdapterConfig {
  connectorId: ConnectorId;
  label: string;
  /** Env var Core reads to decide whether this connector has a credential.
   * Desktop injects it into Core's spawn env only when a stored, decrypted
   * credential exists (`apps/desktop/src/host/connectorCredentials.ts`) —
   * the raw secret is never passed as a tool argument or persisted by Core. */
  credentialEnvVar: string;
  tools: ConnectorToolSpec[];
  /** Live "is this connected right now" check that complements the spawn-time
   * credential env var. Needed for credentials Desktop only learns after Core
   * started (a Google sign-in pushes an access token into the running Core;
   * env is fixed at spawn). Either signal makes the connector configured. */
  isConnected?: () => boolean;
  /** Why the connector is not configured when it is not, if more specific than the generic message. */
  notConfiguredReason?: () => string | undefined;
  /** Optional pre-dispatch hook: may rewrite the arguments the human approves (e.g. bind a
   * fetched etag) and supply the plain-language card text. Returning `denied` stops before
   * any approval exists. Read-tier tools skip it. */
  prepare?: ConnectorPrepare;
  probe?: ConnectorProbe;
  executor?: ConnectorExecutor;
  probeTimeoutMs?: number;
}

export type ConnectorAdapter = ConnectorCapabilityAdapter & {
  probeHealth(signal?: AbortSignal): Promise<CapabilityHealth>;
  /** Present only for connectors that bind live state into an approval before it is shown. */
  prepare?: ConnectorPrepare;
};

export function createConnectorCapabilityAdapter(config: ConnectorAdapterConfig): ConnectorAdapter {
  const toolTier = new Map<string, ConnectorActionTier>(config.tools.map((tool) => [tool.name, tool.tier]));
  let cachedProbeHealth: CapabilityHealth | null = null;

  function isConfigured(): boolean {
    return Boolean(process.env[config.credentialEnvVar]?.trim()) || Boolean(config.isConnected?.());
  }

  function currentHealth(): CapabilityHealth {
    if (!isConfigured()) {
      return { state: 'authorization_required', reason: config.notConfiguredReason?.() ?? `${config.label} credential is not configured`, checkedAt: new Date().toISOString() };
    }
    if (!config.probe) {
      return { state: 'unavailable', reason: `${config.label} live probe is not implemented in this foundation slice`, checkedAt: new Date().toISOString() };
    }
    return cachedProbeHealth ?? { state: 'unavailable', reason: `${config.label} has not been probed yet`, checkedAt: new Date().toISOString() };
  }

  async function probeHealth(signal?: AbortSignal): Promise<CapabilityHealth> {
    if (!isConfigured()) {
      cachedProbeHealth = null;
      return currentHealth();
    }
    if (!config.probe) return currentHealth();
    const timeoutMs = config.probeTimeoutMs ?? 8_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const result = await config.probe(controller.signal);
      cachedProbeHealth = result.ok
        ? { state: 'available', checkedAt: new Date().toISOString() }
        : { state: 'unavailable', reason: result.reason ?? `${config.label} probe failed`, checkedAt: new Date().toISOString() };
    } catch (err) {
      cachedProbeHealth = {
        state: controller.signal.aborted ? 'unavailable' : 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
    return cachedProbeHealth;
  }

  function tierOf(toolName: string): ConnectorActionTier {
    const tier = toolTier.get(toolName);
    if (!tier) throw new Error(`connector '${config.connectorId}' has no tool '${toolName}'`);
    return tier;
  }

  return {
    id: config.connectorId,
    connectorId: config.connectorId,
    definitions: (): ModelToolDefinition[] => config.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    tier: tierOf,
    classify: (toolName: string): CapabilityRisk => (tierOf(toolName) === 'read' ? 'read_only' : 'consequential'),
    health: currentHealth,
    isConfigured,
    redactArguments: (_toolName: string, args: Record<string, unknown>) => redactArgs(args),
    run: async (call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
      if (!isConfigured()) {
        return deniedResult('connector_not_configured', `${config.label} is not configured; no action was taken`);
      }
      if (!config.executor) {
        return deniedResult('connector_not_implemented', `${config.label} live execution is not implemented in this foundation slice; no action was taken`);
      }
      return config.executor(call.name, call.arguments, ctx);
    },
    probeHealth,
    ...(config.prepare ? { prepare: config.prepare } : {}),
  };
}
