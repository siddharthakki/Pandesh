/**
 * In-memory cloud provider credentials held by the Core process.
 *
 * The host (VS Code extension) owns the secret in SecretStorage and pushes it
 * here over the authenticated local API (`PUT /v1/providers/:provider/credential`).
 * It is deliberately never written to the database, the attempt context, an
 * idempotency record, an event or a log: attempt contexts freeze only the
 * provider and model names. A Core restart forgets it and the host pushes it
 * again when it reconnects.
 */
export const ORCAROUTER_PROVIDER = 'orcarouter';
export const ORCAROUTER_DEFAULT_API_BASE = 'https://api.orcarouter.ai/v1';

export interface CloudProviderCredential {
  baseUrl: string;
  apiKey: string;
}

export interface PreferredCloudModel {
  provider: string;
  model: string;
  verifiedFree: boolean;
}

export interface CloudCredentialStatus {
  configured: boolean;
  baseUrl?: string;
}

export class CloudCredentialStore {
  private readonly entries = new Map<string, CloudProviderCredential>();

  set(provider: string, credential: CloudProviderCredential): void {
    const baseUrl = credential.baseUrl.trim().replace(/\/$/, '');
    const apiKey = credential.apiKey.trim();
    if (!baseUrl || !apiKey) throw new Error('A base URL and an API key are both required');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('The base URL must start with http:// or https://');
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(provider)) throw new Error('Invalid provider id');
    this.entries.set(provider, { baseUrl, apiKey });
  }

  get(provider: string): CloudProviderCredential | undefined {
    return this.entries.get(provider);
  }

  /** Provider ids that currently hold a credential (never the keys). */
  providers(): string[] {
    return [...this.entries.keys()];
  }

  clearAll(): void {
    this.entries.clear();
    this.preferred = undefined;
  }

  private preferred: PreferredCloudModel | undefined;

  /**
   * The free cloud model the user chose in the desktop (not a secret). Pandesh offers this model — and only after
   * asking — when every local model failed a task (escalation.ts). `verifiedFree` comes from the host's verified pool.
   */
  setPreferredModel(model: PreferredCloudModel | undefined): void {
    if (model && (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(model.provider) || !model.model.trim())) throw new Error('Invalid preferred cloud model');
    this.preferred = model ? { provider: model.provider, model: model.model.trim(), verifiedFree: model.verifiedFree === true } : undefined;
  }

  /** The chosen model, only while its key is delivered and it is verified free. */
  offerableModel(): PreferredCloudModel | undefined {
    const p = this.preferred;
    return p && p.verifiedFree && this.entries.has(p.provider) ? { ...p } : undefined;
  }

  clear(provider: string): void {
    this.entries.delete(provider);
  }

  /** Never includes the key. */
  status(provider: string): CloudCredentialStatus {
    const entry = this.entries.get(provider);
    return entry ? { configured: true, baseUrl: entry.baseUrl } : { configured: false };
  }
}

/** Process-wide store; tests pass their own instance instead. */
export const sharedCloudCredentials = new CloudCredentialStore();
