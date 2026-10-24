import { CoreError } from '../domain/errors';
import type { StructuredErrorBody } from '../shared/wireTypes';

export function toHttpError(err: unknown, correlationId: string): { status: number; body: StructuredErrorBody } {
  if (err instanceof CoreError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, correlationId, details: err.details } },
    };
  }
  // Never leak raw messages/stacks from unexpected errors — log server-side (caller's
  // responsibility) and return a generic body to the client.
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'an internal error occurred', correlationId } },
  };
}
