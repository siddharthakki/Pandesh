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
}

export interface ApiResult {
  status: number;
  body: unknown;
}
