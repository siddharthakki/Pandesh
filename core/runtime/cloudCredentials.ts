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
