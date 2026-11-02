import type { CoreDatabase } from '../db/connection';
import type { AuthenticatedPrincipal } from '../security/types';

export interface ApiContext {
  db: CoreDatabase;
  clientId: string;
  actor: string;
  principal: AuthenticatedPrincipal;
  correlationId: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  idempotencyKey?: string;
  /** `X-Panda-Pairing` header: the browser extension's pairing token (resolved by hash in the bridge routes). */
  pairingToken?: string;
}

export interface ApiResult {
  status: number;
  body: unknown;
}
