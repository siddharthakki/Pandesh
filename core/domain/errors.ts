import type { CoreErrorCode } from '../shared/wireTypes';

const STATUS_BY_CODE: Record<CoreErrorCode, number> = {
  unauthenticated: 401,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  revision_mismatch: 409,
  idempotency_key_conflict: 409,
  invalid_transition: 422,
  dependency_violation: 422,
  fence_stale: 409,
  context_missing: 409,
  context_mismatch: 409,
  database_failed: 503,
  internal_error: 500,
};

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: CoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
