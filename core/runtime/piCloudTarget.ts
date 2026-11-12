/**
 * A whole Pi turn on a free cloud model — history, tools and tool results included — happens only when the user chose
 * it: a cloud model picked before the chat (`cloudChatApproved` frozen at submit), or "yes" to Pandesh's offer after
 * every local model failed (escalation.ts). Before anything is sent, the same refusals as the one-message path apply:
 * the key must have been delivered to Core and the frozen spend policy must prove the model free. No fallback.
 */
import type { AttemptContextRecord } from '../shared/wireTypes';
import { ModelBackendError } from './modelBackend';
import { cloudProviderLabel, refuseCloudProviderBeforeFetch, refuseCloudSpendBeforeFetch } from './attemptModelBackend';
import { sharedCloudCredentials, type CloudCredentialStore } from './cloudCredentials';

export interface PiCloudTarget {
  provider: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** Why this turn may run in the cloud: the user picked it, or approved Pandesh's offer. */
  why: 'picked_before_chat' | 'approved_offer';
}

export function resolvePiCloudTarget(input: { provider: string; context?: AttemptContextRecord; credentials?: CloudCredentialStore }): PiCloudTarget {
  const { provider, context } = input;
  const label = cloudProviderLabel(provider);
  if (!context || context.selectedProvider !== provider) {
    throw new ModelBackendError(`${label} turn refused: the attempt's frozen context does not name this provider. Nothing was sent.`, 'cloud_context_mismatch');
  }
  if (context.modelSelection?.cloudChatApproved !== true) {
    throw new ModelBackendError(`${label} turn refused: you did not choose a cloud model for this chat. Nothing was sent.`, 'cloud_chat_not_approved');
  }
  const credential = refuseCloudProviderBeforeFetch(context, input.credentials ?? sharedCloudCredentials, provider);
  refuseCloudSpendBeforeFetch(context);
  return {
    provider,
    label,
    baseUrl: credential.baseUrl.replace(/\/$/, ''),
    apiKey: credential.apiKey,
    why: context.modelSelection?.cloudChatSource === 'approved_offer' ? 'approved_offer' : 'picked_before_chat',
  };
}

export interface PiCloudCall { provider: string; status: number | 'error'; totalMs: number; promptTokens?: number; outputTokens?: number; error?: string }

/** The fetch a cloud Pi turn uses: plain HTTPS to the provider, with each call's outcome recorded (no body, no key). */
export function createPiCloudFetch(options: { provider: string; fetchFn?: typeof fetch; onCall?: (call: PiCloudCall) => void }): typeof fetch {
  const base = options.fetchFn ?? fetch;
  return (async (input: any, init?: any) => {
    const started = Date.now();
    try {
      const response = await base(input, init);
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (!(init?.body && /"stream"\s*:\s*true/.test(String(init.body)))) {
        try { usage = ((await response.clone().json()) as { usage?: typeof usage }).usage; } catch { /* streaming or not JSON */ }
      }
      options.onCall?.({ provider: options.provider, status: response.status, totalMs: Date.now() - started, promptTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens });
      return response;
    } catch (error) {
      options.onCall?.({ provider: options.provider, status: 'error', totalMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }) as typeof fetch;
}
