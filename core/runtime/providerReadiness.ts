/**
 * What the model may know about providers and credentials: whether each one is configured and usable, never the key.
 *
 * The secrets themselves live in the desktop host's credential vault (Windows Credential Manager, outside the app and
 * profile folders, so a reinstall or update never touches them) and are pushed to Core's memory only (cloudCredentials.ts).
 * This reads that store's status() and the local model runtime, and states Pandesh's routing policy in plain words so a
 * specialist can decide what to do without asking for, seeing or repeating a credential.
 */
import type { CloudCredentialStore } from './cloudCredentials';

export interface ProviderReadinessInput {
  credentials: Pick<CloudCredentialStore, 'providers' | 'status' | 'offerableModel'>;
  local: { apiBase: string; activeModel: string; reachable: boolean | null; installedModels: number | null };
  /** True when a Google/Gmail connection exists (a fact, not a token). */
  googleConnected?: boolean | null;
}

const KNOWN_CLOUD: Array<{ id: string; label: string }> = [
  { id: 'orcarouter', label: 'OrcaRouter (cloud model router)' },
  { id: 'openrouter', label: 'OpenRouter (free model pool)' },
  { id: 'hermes', label: 'Hermes agent profile' },
];

/** Host name only: a base URL can carry a path or an account hint that is nobody's business. */
export function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : 'unknown host'; } catch { return 'unknown host'; }
}

export function describeProviderReadiness(input: ProviderReadinessInput): string {
  const { credentials, local } = input;
  const configured = new Set(credentials.providers());
  const lines: string[] = [];
  lines.push('LOCAL (default for everything private)');
  lines.push(`- Ollama at ${hostOf(local.apiBase)}: ${local.reachable === null ? 'not checked' : local.reachable ? 'reachable' : 'NOT reachable'}${local.installedModels !== null ? `, ${local.installedModels} model(s) installed` : ''}; active model ${local.activeModel}.`);
  lines.push('', 'CLOUD (only for public or redacted work, and only after the user says yes)');
  const ids = [...new Set([...KNOWN_CLOUD.map((k) => k.id), ...configured])];
  for (const id of ids) {
    const label = KNOWN_CLOUD.find((k) => k.id === id)?.label ?? id;
    const st = credentials.status(id);
    lines.push(st.configured ? `- ${label}: key present in this session, endpoint ${hostOf(st.baseUrl)}. Usable only for a task the user has allowed to leave this PC.` : `- ${label}: no key delivered to Core. Not usable. The owner adds a key under System > Connections; never ask for one in chat.`);
  }
  const offer = credentials.offerableModel();
  lines.push(offer ? `- Free cloud model the owner chose: ${offer.model} (${offer.provider}). Offered only when every local model failed, and only after asking.` : '- No free cloud model is chosen and verified, so Pandesh has nothing to offer when local models fail.');
  if (input.googleConnected !== undefined && input.googleConnected !== null) lines.push('', `GOOGLE: ${input.googleConnected ? 'connected (Gmail/Calendar tools can run, each with its approval rules)' : 'not connected (System > Connections)'}.`);
  lines.push('',
    'RULES: private, personal, business or file content stays on local models. There is no silent cloud fallback: a cloud model runs only when the owner approved that cloud use for this task. A key never appears in prompts, memory, notes, Activity, logs or specialist reports; if you need a provider that is not configured, say which one and where the owner adds it. Keys are kept in the Windows credential vault, so reinstalling Pandesh keeps them; a recovery file (.pandesh-keys, passphrase-protected) can restore them on another PC.');
  return lines.join('\n');
}
