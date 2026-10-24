import {
  ForgeCallableDescriptor,
  ForgeCallableResponse,
  FORGE_INVOKE_MODEL_METHOD,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
} from './ForgeCallableSurface';
import { ReadOnlyForgeInvocationAdapter } from './ForgeInvocationAdapter';
import { SerializablePermissionContext } from '../tools/PermissionContext';

/**
 * In-process invocation metadata carried beside, never inside, serialized
 * Forge params. This deliberately stays outside ForgeCallableRequest and all
 * public callable request contracts.
 */
export interface LocalForgeInvocationContext {
  signal?: AbortSignal;
  permissionContext?: SerializablePermissionContext;
  permissionRunId?: string;
  requirePermissionContext?: boolean;
}

/**
 * Structural boundary used by RPC registration. A plain
 * LocalForgeCallableTransport remains assignable for existing tests and
 * non-cancelling callers; production composition supplies the cancellation-
 * aware implementation below.
 */
export interface ForgeRpcCallableTransport {
  discover(): ForgeCallableDescriptor[];
  invoke(
    method: string,
    params?: unknown,
    context?: LocalForgeInvocationContext,
  ): Promise<ForgeCallableResponse>;
}

/**
 * Local-only bridge from an RPC request signal to the adapter-owned governed
 * model-call controller. The signal is never added to serialized params and
 * the adapter remains the sole owner of the provider-facing AbortController.
 *
 * Every concurrent caller attaches its own signal before awaiting the shared
 * in-flight adapter promise. Aborting any caller therefore cancels the one
 * logical execution while the adapter's existing in-flight promise map still
 * guarantees exactly one provider dispatch.
 */
export class CancellationAwareForgeCallableTransport extends LocalForgeCallableTransport {
  constructor(
    registry: ReadOnlyForgeCallableRegistry,
    private readonly adapter: ReadOnlyForgeInvocationAdapter,
  ) {
    super(registry);
  }

  override async invoke(
    method: string,
    params?: unknown,
    context?: LocalForgeInvocationContext,
  ): Promise<ForgeCallableResponse> {
    const signal = context?.signal;
    const reservationId = method === FORGE_INVOKE_MODEL_METHOD
      ? reservationIdFrom(params)
      : undefined;

    if (!signal || !reservationId) {
      return super.invoke(method, params, context);
    }

    let awaiting = true;
    const forwardCancellation = (): void => {
      if (awaiting) {
        this.adapter.cancelModelCall(reservationId);
      }
    };

    signal.addEventListener('abort', forwardCancellation, { once: true });
    try {
      // Start the normal callable path first. Async execution reaches the
      // adapter-owned controller before this call returns its promise; an
      // already-aborted external signal is then forwarded immediately.
      const result = super.invoke(method, params, context);
      if (signal.aborted) {
        forwardCancellation();
      }
      return await result;
    } finally {
      awaiting = false;
      signal.removeEventListener('abort', forwardCancellation);
    }
  }
}

function reservationIdFrom(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const reservationId = (params as Record<string, unknown>)['reservationId'];
  return typeof reservationId === 'string' && reservationId.length > 0
    ? reservationId
    : undefined;
}
