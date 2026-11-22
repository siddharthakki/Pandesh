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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Router } from './router';
import type { ApiContext, ApiResult } from './context';
import { CoreError } from '../domain/errors';
import {
  authenticatePairing, createPairingCode, getBridgeTask, listBridgeTasks, listCheckpoints, listPairings, redeemPairingCode, revokePairing,
  submitBridgeTask, toBridgeTaskView, type BridgePairing, type BridgeTaskRecord, type BridgeTransferConsent,
} from '../domain/pandaBridge';
import { KandevClient } from '../runtime/kandev/kandevClient';
import { listApprovalEvents, listPendingApprovals, pendingApproval, type ExternalApprovalRequest } from '../domain/bridgeApprovals';
import {
  approveBridgeChange, rejectBridgeChange, bridgeChangeDiff, cancelBridgeTask, decideExternalApproval, deliverBridgeChange, discoverExecutors, dispatchBridgeTask, pauseBridgeTask, refreshBridgeTask, resumeBridgeTask, type BridgeRuntime,
} from '../runtime/kandev/pandaBridge';
import { bridgeServices } from '../runtime/kandev/bridgeServices';
import { activityItem } from '../runtime/kandev/bridgeActivity';
import { allDeclarations, BUILTIN_WORKFLOWS, routeTask, trackRecords } from '../runtime/kandev/capabilityRegistry';
import { planWorkflow, runWorkflow } from '../runtime/kandev/workflowRouter';
import { newId } from '../domain/ids';
import { loadProjects, registerProject, removeProject, resolveProject } from '../domain/projectRegistry';
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

/** What a paired browser may know about an approval waiting in Pandesh: that it exists and for which agent, nothing about the project or paths. */
const approvalSummary = (a: ExternalApprovalRequest) => ({ requestId: a.requestId, executor: a.executor, agentLabel: a.agentLabel, expiresAt: a.expiresAt });

export function registerBridgeRoutes(router: Router<ApiContext, ApiResult>, options: BridgeRouteOptions): void {
  const kandev = options.kandev ?? new KandevClient();
  const runtime = (ctx: ApiContext): BridgeRuntime => ({ db: ctx.db, kandev, dataDir: options.dataDir, executor: options.executor, services: bridgeServices(options.dataDir) });
  // The browser card shows the same real state, reason, active time and heartbeat as Pandesh's own activity list.
  const view = (ctx: ApiContext, task: BridgeTaskRecord) => {
    const pending = task.status === 'awaiting_executor' ? pendingApproval(ctx.db, task.id) : null;
    const base = toBridgeTaskView(task, listCheckpoints(ctx.db, task.id));
    // The worker's full event log stays on this PC: a paired client (ChatGPT, a browser) gets the last few lines, as before.
    const forClient = caller(ctx).kind === 'extension' && base.result ? { ...base, result: { ...base.result, activity: base.result.activity.slice(-3) } } : base;
    return { ...forClient, activity: activityItem(ctx.db, task, 'Browser'), ...(pending ? { approval: approvalSummary(pending) } : {}) };
  };

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

  // --- authorized projects (the owner's registry; only the Pandesh app reads or changes it) ---
  router.get('/v1/bridge/projects', (ctx) => {
    requireHost(ctx);
    return ok(200, { projects: loadProjects(options.dataDir) });
  });
  router.post('/v1/bridge/projects', (ctx) => {
    requireHost(ctx);
    const b = body(ctx);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    const project = registerProject(options.dataDir, {
      name: String(b.name ?? ''), path: String(b.path ?? ''), aliases: list(b.aliases), capabilities: list(b.capabilities), preferredAgents: list(b.preferredAgents),
      access: b.access === 'read-write' ? 'read-write' : 'read', asAdditionalPath: b.asAdditionalPath === true, authorizedBy: ctx.principal.id,
    });
    return ok(201, { project });
  });
  router.delete('/v1/bridge/projects/:id', (ctx, match) => {
    requireHost(ctx);
    if (!removeProject(options.dataDir, match.params.id)) throw new CoreError('not_found', 'project not found');
    return ok(200, { removed: true });
  });
  router.post('/v1/bridge/projects/resolve', (ctx) => {
    requireHost(ctx);
    return ok(200, resolveProject(loadProjects(options.dataDir), String(body(ctx).instruction ?? '')));
  });

  // --- executors ---
  router.get('/v1/bridge/executors', async (ctx) => {
    caller(ctx);
    return ok(200, await discoverExecutors(kandev, { nativeAvailable: Boolean(options.executor) }));
  });

  // --- capability registry and workflow router ---
  const listing = (ctx: ApiContext) => discoverExecutors(kandev, { nativeAvailable: Boolean(options.executor), services: bridgeServices(options.dataDir) });
  router.get('/v1/bridge/capabilities', async (ctx) => {
    caller(ctx);
    const l = await listing(ctx);
    const records = trackRecords(ctx.db);
    return ok(200, {
      executors: l.executors,
      declarations: allDeclarations(bridgeServices(options.dataDir)).map(d => ({
        ...d,
        track: Object.fromEntries(Object.keys(d.classes).map(c => [c, records.get(`${d.executor}|${c}`) ?? null])),
      })),
      workflows: BUILTIN_WORKFLOWS.map(w => ({ id: w.id, label: w.label, steps: w.steps.map(s => ({ name: s.name, taskClass: s.taskClass })) })),
    });
  });
  router.post('/v1/bridge/route', async (ctx) => {
    const c = caller(ctx);
    const b = body(ctx);
    if (typeof b.taskClass !== 'string' || !b.taskClass) throw new CoreError('invalid_request', "'taskClass' is required");
    const decision = routeTask(
      { taskClass: b.taskClass, readOnly: b.readOnly === true, deterministicOnly: b.deterministicOnly === true, allowExternal: c.kind === 'host' && b.allowExternal === true },
      await listing(ctx), allDeclarations(bridgeServices(options.dataDir)), trackRecords(ctx.db),
    );
    return ok(200, decision);
  });
  const workflowById = (id: string) => {
    const w = BUILTIN_WORKFLOWS.find(x => x.id === id);
    if (!w) throw new CoreError('not_found', `workflow '${id}' not found`);
    return w;
  };
  router.post('/v1/bridge/workflows/:id/plan', async (ctx, match) => {
    caller(ctx);
    return ok(200, { workflow: match.params.id, steps: await planWorkflow(runtime(ctx), workflowById(match.params.id)) });
  });
  // JUGAAD, the browser and the phone are all paired clients: their workflow tasks are owned by their pairing.
  router.post('/v1/bridge/workflows/:id/run', async (ctx, match) => {
    const c = caller(ctx);
    if (c.kind !== 'extension') throw new CoreError('invalid_request', 'workflows are run by a paired client (browser, JUGAAD, phone)');
    const b = body(ctx);
    const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
    const runId = typeof b.runId === 'string' && /^[\w.:-]{6,60}$/.test(b.runId) ? b.runId : newId('wfrun');
    const run = await runWorkflow(runtime(ctx), c.pairing, workflowById(match.params.id), input, { runId, decidedBy: `extension:${c.pairing.id}` });
    return ok(200, run);
  });

  // --- unified activity: the host (Pandesh UI) sees every relayed task in one list, in the same vocabulary as missions ---
  router.get('/v1/bridge/activity', (ctx) => {
    requireHost(ctx);
    const labels = new Map(listPairings(ctx.db).map(p => [p.id, p.label]));
    const items = listBridgeTasks(ctx.db, { limit: 50 }).map(t => activityItem(ctx.db, t, labels.get(t.pairingId) ?? 'Browser'));
    const live = (i: { state: string }) => !['completed', 'failed', 'cancelled'].includes(i.state);
    items.sort((a, b) => (Number(live(b)) - Number(live(a))) || b.createdAt.localeCompare(a.createdAt));
    return ok(200, { items });
  });
  // Where the running Pandesh application lives, so "Open in Pandesh" works without per-install configuration. The Core
  // inherits this from the desktop host that started it; nothing is guessed from the file system.
  router.get('/v1/bridge/app-target', (ctx) => {
    caller(ctx);
    const root = process.env.KARKEDIKHA_DESKTOP_PRODUCT_ROOT?.trim();
    const exe = root ? path.join(root, 'electron', 'Pandesh.exe') : null;
    // The packaged executable is Electron itself: it needs the app directory as its first argument, or the relaunch never reaches
    // the single-instance handler (found on the Build 187 install: Open in Pandesh did nothing).
    const appDir = root ? path.join(root, 'app') : null;
    const found = exe && fs.existsSync(exe) && appDir && fs.existsSync(appDir);
    return ok(200, { exe: found ? exe : null, args: found ? [appDir] : [] });
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
      ...(typeof b.intent === 'string' ? { intent: b.intent } : {}),
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
      const { task, started, approval } = await dispatchBridgeTask(runtime(ctx), match.params.id, {
        executor: String(b.executor ?? ''),
        model: typeof b.model === 'string' && b.model ? b.model : null,
        consent,
        ...(typeof b.taskClass === 'string' && b.taskClass ? { taskClass: b.taskClass } : {}),
        // Only the Pandesh host can open routing to external executors; a paired browser or JUGAAD never can.
        ...(c.kind === 'host' && b.allowExternal === true ? { allowExternal: true } : {}),
        decidedBy: c.kind === 'host' ? ctx.principal.id : `extension:${c.pairing.id}`,
        authority: c.kind === 'host' ? 'host' : 'extension',
      });
      // `approval`: a cloud agent was requested; the owner decides in the Pandesh app. Nothing has started.
      return ok(started ? 202 : 200, { started, task: view(ctx, task), ...(approval ? { approval: approvalSummary(approval) } : {}) });
    } catch (err) {
      if (!(err instanceof CoreError)) console.error(`[karkedikha-core ${new Date().toISOString()}] panda-bridge dispatch ${match.params.id} failed:`, err instanceof Error ? err.stack ?? err.message : err);
      throw err;
    }
  });
  // --- external-agent approvals: the owner's decision, made in the Pandesh app only ---
  router.get('/v1/bridge/approvals', (ctx) => { requireHost(ctx); return ok(200, { approvals: listPendingApprovals(ctx.db) }); });
  router.post('/v1/bridge/tasks/:id/approval', async (ctx, match) => {
    requireHost(ctx);
    getBridgeTask(ctx.db, match.params.id);
    const b = body(ctx);
    const decision = b.decision === 'approve' ? 'approve' : b.decision === 'refuse' ? 'refuse' : null;
    if (!decision) throw new CoreError('invalid_request', "decision must be 'approve' or 'refuse'");
    try {
      const { task, started } = await decideExternalApproval(runtime(ctx), match.params.id, { requestId: String(b.requestId ?? ''), decision, by: ctx.principal.id, confidentialOverride: b.confidentialOverride === true });
      return ok(started ? 202 : 200, { started, task: view(ctx, task) });
    } catch (err) {
      if (!(err instanceof CoreError)) console.error(`[karkedikha-core ${new Date().toISOString()}] panda-bridge approval ${match.params.id} failed:`, err instanceof Error ? err.stack ?? err.message : err);
      throw err;
    }
  });
  router.get('/v1/bridge/tasks/:id/audit', (ctx, match) => {
    requireHost(ctx);
    getBridgeTask(ctx.db, match.params.id);
    return ok(200, { taskId: match.params.id, approvalEvents: listApprovalEvents(ctx.db, match.params.id), checkpoints: listCheckpoints(ctx.db, match.params.id) });
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
  // A5: only the owner, in the Pandesh window, approves a reviewed change or brings it into their checkout. A paired client never can.
  router.post('/v1/bridge/tasks/:id/approve-change', async (ctx, match) => {
    requireHost(ctx);
    return ok(200, view(ctx, await approveBridgeChange(runtime(ctx), match.params.id, 'Pandesh')));
  });
  // The owner does not approve the reviewed change: nothing is committed or delivered, and the task ends with that reason.
  router.post('/v1/bridge/tasks/:id/reject-change', async (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    return ok(200, view(ctx, await rejectBridgeChange(runtime(ctx), match.params.id, 'Pandesh', typeof b.note === 'string' ? b.note : undefined)));
  });
  // Read-only diff of an A5 change for the owner's review. Host only: the diff holds project source.
  router.get('/v1/bridge/tasks/:id/diff', async (ctx, match) => {
    requireHost(ctx);
    return ok(200, await bridgeChangeDiff(runtime(ctx), match.params.id));
  });
  router.post('/v1/bridge/tasks/:id/deliver', (ctx, match) => {
    requireHost(ctx);
    const delivered = deliverBridgeChange(runtime(ctx), match.params.id, 'Pandesh');
    return ok(200, { delivered, task: view(ctx, getBridgeTask(ctx.db, match.params.id)) });
  });
  router.post('/v1/bridge/tasks/:id/pause', control('pause'));
  router.post('/v1/bridge/tasks/:id/resume', control('resume'));
  router.post('/v1/bridge/tasks/:id/cancel', control('cancel'));
}
