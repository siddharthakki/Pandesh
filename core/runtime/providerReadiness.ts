/**
 * What the model may know about providers and credentials: whether each one is usable for a task, never the key.
 *
 * The secrets live in the desktop host's credential vault (Windows Credential Manager, outside the app and profile
 * folders, so a reinstall or update never touches them) and are pushed to Core's memory only (cloudCredentials.ts).
 * This reads that store's status() and the local model runtime, and answers five separate questions per provider,
 * because "has a key" is not "is reachable" is not "has the model" is not "may be used for this":
 *   1. key configured        2. endpoint reachable        3. requested model available
 *   4. authorized for this task        5. overall: ready / unverified / unavailable
 * Configuration is read from memory; no cloud endpoint is called just to display it (a probe would carry the key to
 * the provider without the owner's yes). What was not checked is said to be unverified, not assumed to work.
 */
import type { CloudCredentialStore } from './cloudCredentials';

export interface ProviderReadinessInput {
  credentials: Pick<CloudCredentialStore, 'providers' | 'status' | 'offerableModel'>;
  /** Local runtime facts, already gathered by a local call (never a cloud call). `models` are installed model names. */
  local: { apiBase: string; activeModel: string; reachable: boolean | null; installedModels: number | null; models?: string[] };
  /** True when a Google/Gmail connection exists (a fact, not a token). */
  googleConnected?: boolean | null;
  /** Narrow the answer: one provider ("ollama", "openrouter", ...), a model name, and whether the task is private. */
  provider?: string;
  model?: string;
  taskPrivate?: boolean;
}

const KNOWN_CLOUD: Array<{ id: string; label: string }> = [
  { id: 'orcarouter', label: 'OrcaRouter (cloud model router)' },
  { id: 'openrouter', label: 'OpenRouter (free model pool)' },
  { id: 'hermes', label: 'Hermes agent profile' },
];

/** A question about which providers or models may be used, and what is configured, verified or authorized. */
export function asksProviderReadiness(text: string): boolean {
  const t = String(text ?? '');
  return /\b(?:providers?|api[- ]?keys?|credentials?|connections?)\b/i.test(t) && /\b(?:configured|verified|authori[sz]ed|available|usable|can you use|set up|connected|ready)\b/i.test(t);
}

/** Host name only: a base URL can carry a path or an account hint that is nobody's business. */
export function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : 'unknown host'; } catch { return 'unknown host'; }
}

function localModelPresent(models: string[] | undefined, wanted: string): boolean | null {
  if (!models) return null;
  const w = wanted.trim().toLowerCase();
  return models.some((m) => { const n = m.toLowerCase(); return n === w || n === `${w}:latest` || n.split(':')[0] === w; });
}

export function describeProviderReadiness(input: ProviderReadinessInput): string {
  const { credentials, local } = input;
  const only = input.provider?.trim().toLowerCase() || '';
  const wantedModel = input.model?.trim() || '';
  const configured = new Set(credentials.providers());
  const offer = credentials.offerableModel();
  const lines: string[] = [];

  if (!only || only === 'ollama' || only === 'local') {
    const reach = local.reachable === null ? 'not checked' : local.reachable ? 'yes' : 'NO';
    const present = wantedModel ? localModelPresent(local.models, wantedModel) : null;
    const status = local.reachable === false ? 'UNAVAILABLE (the local model server does not answer)'
      : wantedModel && present === false ? `UNAVAILABLE for "${wantedModel}" (not installed; ${local.installedModels ?? '?'} other model(s) are)`
        : local.reachable ? 'READY' : 'UNVERIFIED';
    lines.push('LOCAL: Ollama (default for everything private)',
      `- key: not needed. endpoint ${hostOf(local.apiBase)} reachable: ${reach}${local.installedModels !== null ? `, ${local.installedModels} model(s) installed` : ''}.`,
      `- model: ${wantedModel ? `"${wantedModel}" ${present === null ? 'not checked' : present ? 'installed' : 'NOT installed'}; ` : ''}active model ${local.activeModel}.`,
      '- authorized: yes, for any task, private or not.',
      `- status: ${status}.`);
  }

  const ids = [...new Set([...KNOWN_CLOUD.map((k) => k.id), ...configured])].filter((id) => !only || only === id);
  if (ids.length) lines.push('', 'CLOUD (public or redacted work only, and only after the owner says yes for that task)');
  for (const id of ids) {
    const label = KNOWN_CLOUD.find((k) => k.id === id)?.label ?? id;
    const st = credentials.status(id);
    if (!st.configured) {
      lines.push(`- ${label}: key NOT delivered to Core, so UNAVAILABLE. The owner adds it under System > Connections; never ask for one in chat.`);
      continue;
    }
    const verified = offer && offer.provider === id;
    const modelNote = wantedModel
      ? (verified && offer.model.toLowerCase() === wantedModel.toLowerCase() ? `"${wantedModel}" is the model the owner verified as free` : `"${wantedModel}" is UNVERIFIED (Pandesh has not confirmed this provider serves it)`)
      : verified ? `verified free model: ${offer.model}` : 'no model verified';
    const auth = input.taskPrivate ? 'NO: this task is private, so it stays local' : 'not yet: needs the owner\'s yes for this task (never for private content)';
    lines.push(`- ${label}: key configured: yes (endpoint ${hostOf(st.baseUrl)}). endpoint reachable: not checked (no call is made just to show configuration; the owner\'s connection test in System > Connections verifies it). model: ${modelNote}. authorized for this task: ${auth}. status: ${verified && !input.taskPrivate ? 'CONFIGURED, usable only after the owner approves' : 'UNVERIFIED'}.`);
  }
  if (!only) {
    lines.push(offer ? `- Free cloud model the owner chose: ${offer.model} (${offer.provider}); offered only when every local model failed, and only after asking.` : '- No free cloud model is chosen and verified, so Pandesh has nothing to offer when local models fail.');
    if (input.googleConnected !== undefined && input.googleConnected !== null) lines.push('', `GOOGLE: ${input.googleConnected ? 'connected (Gmail/Calendar tools can run, each with its approval rules)' : 'not connected (System > Connections)'}.`);
  }
  lines.push('',
    'RULES: private, personal, business or file content stays on local models. There is no silent cloud fallback: a cloud model runs only when the owner approved that cloud use for this task. A key never appears in prompts, memory, notes, Activity, logs or specialist reports; if you need a provider that is not configured, say which one and where the owner adds it. Keys are kept in the Windows credential vault, so reinstalling Pandesh keeps them; a recovery file (.pandesh-keys, passphrase-protected) can restore them on another PC.');
  return lines.join('\n');
}
