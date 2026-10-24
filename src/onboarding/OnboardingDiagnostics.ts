/**
 * "Copy diagnostics" text for the Setup screen. Built only from the structured readiness snapshot — never from
 * process.env, SecretStorage or raw settings — so a key or token has no path into it. A final redaction pass is
 * defence in depth for a secret that arrives inside an otherwise-innocent string (an endpoint with userinfo, an
 * error detail echoing a header).
 */
import type { AdvancedSettingsSnapshot, ModelSummary, OnboardingReadiness } from './OnboardingReadiness';
import { formatBuildIdentity } from './BuildIdentity';

/** Removes URL userinfo and query strings from an endpoint so it is safe to display and copy. */
export function sanitizeEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return endpoint.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '');
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[redacted]'), text);
}

function describeModel(model: ModelSummary): string {
  const parts = [
    model.state,
    model.contextTokens ? `ctx ${model.contextTokens}` : 'ctx unknown',
    `reasoning ${model.reasoning}`,
    `tools ${model.tools}`,
    `structured ${model.structuredOutput}`,
    `vision ${model.vision}`,
    `profile ${model.profileStatus}${model.probedAt ? ` (${model.probedAt})` : ''}`,
  ];
  return `  - ${model.name}: ${parts.join(', ')}`;
}

export function buildDiagnosticsText(readiness: OnboardingReadiness): string {
  const advanced = readiness.advanced;
  const lines: string[] = ['KarkeDikha diagnostics'];
  if (readiness.build) {
    lines.push(`Build: ${formatBuildIdentity(readiness.build)}`);
    if (readiness.build.builtAt) lines.push(`Built at: ${readiness.build.builtAt}`);
  }
  lines.push(`Overall: ${readiness.overall}`);
  lines.push(
    `Provider: ${readiness.provider.label} (${readiness.provider.providerType}) at ${sanitizeEndpoint(readiness.provider.apiBase) || 'unknown endpoint'} — ${readiness.provider.reachable ? 'reachable' : 'unreachable'}`,
  );
  lines.push(`Core runtime: ${readiness.coreRuntime.state}`);
  lines.push('Modes:');
  for (const mode of readiness.modes) {
    const choice = mode.selection === 'manual' ? `manual ${mode.manualModel}` : 'auto';
    lines.push(`  - ${mode.label}: ${choice} → ${mode.model ?? 'none'} (${mode.ready ? 'ready' : 'not ready'})`);
  }
  lines.push(`Models (${readiness.models.length}):`);
  for (const model of readiness.models) lines.push(describeModel(model));
  if (readiness.system) lines.push(`System readiness: ${readiness.system.badge} — ${readiness.system.subline}`);
  const pool = readiness.cloudPool;
  if (pool) {
    lines.push(`Cloud pool: ${pool.connectedCount} connected, ${pool.availableCount} available; spend ${pool.spendMode}${pool.allowCredits ? ' + credits' : ''}; use free cloud ${pool.useFreeCloud ? 'on' : 'off'}; catalog ${pool.catalogVersion}`);
    for (const provider of pool.providers.filter(item => item.connected)) {
      lines.push(`  - ${provider.id}: ${provider.enabled ? 'enabled' : 'off'}${provider.modelCount !== undefined ? `, ${provider.modelCount} models (${provider.freeCount ?? 0} free)` : ''}${provider.quotaExhausted ? ', quota exhausted' : ''}${provider.error ? `, error ${provider.error.kind}` : ''}`);
    }
  }
  const policy = readiness.cloudFallback.policy === 'local-only' ? 'local-only' : 'local-first-cloud-fallback';
  lines.push(`Data policy: ${policy}; cloud fallback ${readiness.cloudFallback.configured ? 'configured' : 'not configured'}`);
  if (advanced) {
    lines.push('Advanced:');
    lines.push(`  context: ${advanced.context.kind}${advanced.context.tokens ? ` ${advanced.context.tokens}` : ''}`);
    lines.push(`  output reservation (internal): ${advanced.outputReservation.kind}${advanced.outputReservation.tokens ? ` ${advanced.outputReservation.tokens}` : ''}`);
    lines.push('  output cap on the wire (num_predict): not sent');
    lines.push(`  automatic context recovery ceiling: ${advanced.recoveryCeiling.tokens} (${advanced.recoveryCeiling.source})`);
  }
  return redactSecrets(lines.join('\n'));
}
