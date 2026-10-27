/**
 * HTTP surface of the Panda bridge (`/v1/bridge/*`).
 *
 * Two kinds of caller, told apart by proof rather than by a client-chosen header:
 * - the paired browser extension, presenting its pairing token (`X-Panda-Pairing`, resolved by hash on every request, so a
 *   revoked pairing stops working at once). It may relay a task, watch it, pause/resume/cancel it, and start it on a *local*
 *   executor. It can never authorise sending task data to an external model.
 * - the Pandesh host (verified host token): creates pairing codes, revokes pairings, sees every task, and is the only
 *   caller whose consent counts for an external executor.
 */
import type { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import { CoreError } from '../domain/errors';
import {
  authenticatePairing, createPairingCode, getBridgeTask, listBridgeTasks, listCheckpoints, listPairings, redeemPairingCode, revokePairing,
  submitBridgeTask, toBridgeTaskView, type BridgePairing, type BridgeTaskRecord, type BridgeTransferConsent,
} from '../domain/pandaBridge';
import { KandevClient } from '../runtime/kandev/kandevClient';
import {
  cancelBridgeTask, discoverExecutors, dispatchBridgeTask, pauseBridgeTask, refreshBridgeTask, resumeBridgeTask, type BridgeRuntime,
} from '../runtime/kandev/pandaBridge';
import type { RuntimeExecutor } from '../runtime/executor';

export interface BridgeRouteOptions {
  dataDir: string;
  executor?: RuntimeExecutor;
  kandev?: KandevClient;
}

function body(ctx: ApiContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new CoreError('invalid_request', 'request body must be a JSON object');
  return ctx.body as Record<string, unknown>;
}

function isHost(ctx: ApiContext): boolean {
  const p = ctx.principal;
  return Boolean(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool);
}

function requireHost(ctx: ApiContext): void {
  if (!isHost(ctx)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}

type Caller = { kind: 'host' } | { kind: 'extension'; pairing: BridgePairing };

/** A verified host, or a currently valid pairing. Anything else is refused before any data is read. */
function caller(ctx: ApiContext): Caller {
  if (isHost(ctx)) return { kind: 'host' };
  return { kind: 'extension', pairing: authenticatePairing(ctx.db, ctx.pairingToken) };
}

function owned(c: Caller, task: BridgeTaskRecord): BridgeTaskRecord {
  if (c.kind === 'extension' && task.pairingId !== c.pairing.id) throw new CoreError('not_found', `task '${task.id}' not found`);
  return task;
}

const ok = (status: number, payload: unknown): ApiResult => ({ status, body: payload });

export function registerBridgeRoutes(router: Router<ApiContext, ApiResult>, options: BridgeRouteOptions): void {
  const kandev = options.kandev ?? new KandevClient();
  const runtime = (ctx: ApiContext): BridgeRuntime => ({ db: ctx.db, kandev, dataDir: options.dataDir, executor: options.executor });
  const view = (ctx: ApiContext, task: BridgeTaskRecord) => toBridgeTaskView(task, listCheckpoints(ctx.db, task.id));

  // --- pairing ---
  router.post('/v1/bridge/pairing-codes', (ctx) => {
    requireHost(ctx);
    return ok(201, createPairingCode(ctx.db));
  });
  router.get('/v1/bridge/pairings', (ctx) => {
    requireHost(ctx);
    return ok(200, { pairings: listPairings(ctx.db) });
  });
  router.post('/v1/bridge/pairings/:id/revoke', (ctx, match) => {
    requireHost(ctx);
    return ok(200, revokePairing(ctx.db, match.params.id, 'revoked in Pandesh'));
  });
  // The native host relays the extension's code; the code itself is the proof, so only the Core bearer token is needed.
  router.post('/v1/bridge/pair', (ctx) => {
    const b = body(ctx);
    const { pairing, token } = redeemPairingCode(ctx.db, { code: String(b.code ?? ''), label: typeof b.label === 'string' ? b.label : undefined, extensionId: typeof b.extensionId === 'string' ? b.extensionId : undefined });
    return ok(201, { pairingId: pairing.id, label: pairing.label, token });
  });
  router.delete('/v1/bridge/pairing', (ctx) => {
    const c = caller(ctx);
    if (c.kind !== 'extension') throw new CoreError('invalid_request', 'only a paired browser can unpair itself; use the pairing id to revoke from Pandesh');
    return ok(200, revokePairing(ctx.db, c.pairing.id, 'unpaired from the browser'));
  });
  router.get('/v1/bridge/status', async (ctx) => {
    const c = caller(ctx);
    const listing = await discoverExecutors(kandev, { nativeAvailable: Boolean(options.executor) });
    return ok(200, {
      paired: true, caller: c.kind, pairing: c.kind === 'extension' ? { id: c.pairing.id, label: c.pairing.label } : null,
      executors: listing.executors.filter(e => e.available).length, kandevRunning: listing.kandev.running,
    });
  });

  // --- executors ---
  router.get('/v1/bridge/executors', async (ctx) => {
    caller(ctx);
    return ok(200, await discoverExecutors(kandev, { nativeAvailable: Boolean(options.executor) }));
  });

  // --- tasks ---
  router.post('/v1/bridge/tasks', (ctx) => {
    const c = caller(ctx);
    if (c.kind !== 'extension') throw new CoreError('invalid_request', 'tasks are relayed by a paired browser');
    const b = body(ctx);
    const context = b.context && typeof b.context === 'object' ? (b.context as { text?: unknown; userConfirmed?: unknown }) : undefined;
    const { task, duplicate } = submitBridgeTask(ctx.db, c.pairing, {
      clientRequestId: String(b.clientRequestId ?? ''),
      instruction: typeof b.instruction === 'string' ? b.instruction : '',
      sourceRef: b.sourceRef && typeof b.sourceRef === 'object' ? (b.sourceRef as Record<string, never>) : undefined,
      ...(context ? { context: { text: String(context.text ?? ''), userConfirmed: context.userConfirmed === true } } : {}),
      markedConfidential: b.markedConfidential === true,
    });
    return ok(duplicate ? 200 : 201, { taskId: task.id, duplicate, task: view(ctx, task) });
  });
  router.get('/v1/bridge/tasks', (ctx) => {
    const c = caller(ctx);
    const limit = Number(ctx.query.get('limit') ?? 50);
    const tasks = listBridgeTasks(ctx.db, { ...(c.kind === 'extension' ? { pairingId: c.pairing.id } : {}), limit: Number.isFinite(limit) ? limit : 50 });
    return ok(200, { tasks: tasks.map(t => toBridgeTaskView(t)) });
  });
  router.get('/v1/bridge/tasks/:id', async (ctx, match) => {
    const c = caller(ctx);
    owned(c, getBridgeTask(ctx.db, match.params.id));
    const task = await refreshBridgeTask(runtime(ctx), match.params.id);
    return ok(200, view(ctx, task));
  });
  router.post('/v1/bridge/tasks/:id/dispatch', async (ctx, match) => {
    const c = caller(ctx);
    owned(c, getBridgeTask(ctx.db, match.params.id));
    const b = body(ctx);
    const consent: BridgeTransferConsent | undefined = b.consent && typeof b.consent === 'object'
      ? {
          externalTransfer: (b.consent as Record<string, unknown>).externalTransfer === true,
          confidentialOverride: (b.consent as Record<string, unknown>).confidentialOverride === true,
          includeContext: (b.consent as Record<string, unknown>).includeContext === true,
        }
      : undefined;
    try {
      const { task, started } = await dispatchBridgeTask(runtime(ctx), match.params.id, {
        executor: String(b.executor ?? ''),
        model: typeof b.model === 'string' && b.model ? b.model : null,
        consent,
        decidedBy: c.kind === 'host' ? ctx.principal.id : `extension:${c.pairing.id}`,
        authority: c.kind === 'host' ? 'host' : 'extension',
      });
      return ok(started ? 202 : 200, { started, task: view(ctx, task) });
    } catch (err) {
      if (!(err instanceof CoreError)) console.error(`[karkedikha-core ${new Date().toISOString()}] panda-bridge dispatch ${match.params.id} failed:`, err instanceof Error ? err.stack ?? err.message : err);
      throw err;
    }
  });
  const control = (action: 'pause' | 'resume' | 'cancel') => async (ctx: ApiContext, match: { params: Record<string, string> }) => {
    const c = caller(ctx);
    owned(c, getBridgeTask(ctx.db, match.params.id));
    const who = c.kind === 'host' ? 'Pandesh' : `browser ${c.pairing.label}`;
    const rt = runtime(ctx);
    try {
      const task = action === 'pause' ? await pauseBridgeTask(rt, match.params.id, who)
        : action === 'resume' ? await resumeBridgeTask(rt, match.params.id, who)
          : await cancelBridgeTask(rt, match.params.id, who);
      return ok(200, view(ctx, task));
    } catch (err) {
      // The HTTP error is deliberately generic for unexpected failures; the cause belongs in Core's log.
      if (!(err instanceof CoreError)) console.error(`[karkedikha-core ${new Date().toISOString()}] panda-bridge ${action} ${match.params.id} failed:`, err instanceof Error ? err.stack ?? err.message : err);
      throw err;
    }
  };
  router.post('/v1/bridge/tasks/:id/pause', control('pause'));
  router.post('/v1/bridge/tasks/:id/resume', control('resume'));
  router.post('/v1/bridge/tasks/:id/cancel', control('cancel'));
}
