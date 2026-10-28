/**
 * HTTP surface of the master operator (`/v1/operator/*`). Host-only: a model, a tool or a paired browser can neither start a
 * run nor give an approval. Starting a run is one natural-language instruction; everything else is observation and decisions.
 */
import type { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import { CoreError } from '../domain/errors';
import { getOperatorRun, listOperatorEvents, listOperatorRuns, listOperatorSteps } from '../domain/operatorRuns';
import { createResearchEvidenceRunner } from '../runtime/researchCapability';
import { extractPdfFromBytes } from '../attachments/documentExtraction';
import { OllamaModelBackend, type ModelBackend } from '../runtime/modelBackend';
import { OperatorEngine } from '../runtime/operator';
import { probeToolCatalog } from '../runtime/toolCatalog';
import { KandevClient } from '../runtime/kandev/kandevClient';
import type { RuntimeExecutor } from '../runtime/executor';

export interface OperatorRouteOptions {
  dataDir: string;
  executor?: RuntimeExecutor;
  kandev?: KandevClient;
  /** Tests inject a fake; production always gets the local-only Ollama backend, never a cloud one. */
  model?: ModelBackend;
}

const ok = (status: number, payload: unknown): ApiResult => ({ status, body: payload });

function body(ctx: ApiContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new CoreError('invalid_request', 'request body must be a JSON object');
  return ctx.body as Record<string, unknown>;
}

function requireHost(ctx: ApiContext): string {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
  return p.id;
}

export function registerOperatorRoutes(router: Router<ApiContext, ApiResult>, options: OperatorRouteOptions): void {
  const kandev = options.kandev ?? new KandevClient();
  const research = createResearchEvidenceRunner();
  const engines = new WeakMap<object, OperatorEngine>();
  const engineFor = (ctx: ApiContext): OperatorEngine => {
    let e = engines.get(ctx.db);
    if (!e) {
      e = new OperatorEngine({
        db: ctx.db, dataDir: options.dataDir, model: options.model ?? new OllamaModelBackend(), research, extractPdf: extractPdfFromBytes,
        catalog: () => probeToolCatalog({ kandev, nativeAvailable: Boolean(options.executor) }),
        bridge: { db: ctx.db, kandev, dataDir: options.dataDir, executor: options.executor },
      });
      engines.set(ctx.db, e);
      void e.recover().catch(() => undefined);
    }
    return e;
  };

  router.get('/v1/operator/catalog', async (ctx) => {
    requireHost(ctx);
    return ok(200, await probeToolCatalog({ kandev, nativeAvailable: Boolean(options.executor) }));
  });
  router.post('/v1/operator/runs', (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const pre = (b.preApprove ?? {}) as Record<string, unknown>;
    const run = engineFor(ctx).start({
      instruction: String(b.instruction ?? ''),
      executor: typeof b.executor === 'string' ? b.executor : null,
      model: typeof b.model === 'string' ? b.model : null,
      confidential: b.confidential === true,
      folder: typeof b.folder === 'string' ? b.folder : undefined,
      preApprove: { webEgress: pre.webEgress === true, externalTransfer: pre.externalTransfer === true },
    });
    return ok(201, run);
  });
  router.get('/v1/operator/runs', (ctx) => { requireHost(ctx); return ok(200, { runs: listOperatorRuns(ctx.db) }); });
  router.get('/v1/operator/runs/:id', (ctx, match) => {
    requireHost(ctx);
    return ok(200, { run: getOperatorRun(ctx.db, match.params.id), steps: listOperatorSteps(ctx.db, match.params.id), events: listOperatorEvents(ctx.db, match.params.id) });
  });
  router.post('/v1/operator/runs/:id/steps/:idx/decision', async (ctx, match) => {
    const who = requireHost(ctx);
    const decision = body(ctx).decision;
    if (decision !== 'approved' && decision !== 'rejected') throw new CoreError('invalid_request', "'decision' must be 'approved' or 'rejected'");
    return ok(200, await engineFor(ctx).decide(match.params.id, Number(match.params.idx), decision, who));
  });
  router.post('/v1/operator/runs/:id/cancel', async (ctx, match) => {
    const who = requireHost(ctx);
    return ok(200, await engineFor(ctx).cancel(match.params.id, who));
  });
}
