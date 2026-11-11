/**
 * Workshop routes for the Pandesh app itself (host only — never a model, a tool or the phone).
 *
 * The window reads workshops, says what it has open (so "it" in chat means the thing on screen), answers the view
 * commands Core asked it to carry out, saves the edits a person makes with the Workshop's own controls, and hands
 * over a GLB it exported. Every write becomes an ordinary Core artifact version (core/domain/workshops.ts); an export
 * is accepted only after Core's own GLB check (core/shared/workshop/glb.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from '../domain/errors';
import { latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import {
  confirmWorkshopCommand,
  getWorkshop,
  listWorkshops,
  readWorkshopVersion,
  recordWorkshopFocus,
  writeWorkshopVersion,
} from '../domain/workshops';
import { verifyGlb, glbNodeNames } from '../shared/workshop/glb';
import { WORKSHOP_MIME } from '../shared/workshop/model';
import { applySceneEdits, parseSceneFile } from '../shared/workshop/scene3d';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}

function body(ctx: ApiContext): Record<string, unknown> {
  if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw new CoreError('invalid_request', 'request body must be a JSON object');
  return ctx.body as Record<string, unknown>;
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function registerWorkshopRoutes(router: Router<ApiContext, ApiResult>, options: { dataDir: string; broadcaster: EventBroadcaster }): void {
  /** Broadcasts what a write recorded (artifact_registered, workshop_focused…) to every connected window. */
  const broadcast = <T>(ctx: ApiContext, fn: () => T): T => {
    const before = latestRuntimeSequence(ctx.db);
    const result = fn();
    for (const event of listRuntimeEventsAfter(ctx.db, before, 200)) options.broadcaster.publishRuntime(event);
    return result;
  };

  router.get('/v1/workshops', (ctx) => {
    requireHost(ctx);
    const conversationId = ctx.query.get('conversationId');
    const recent = ctx.query.get('scope') === 'recent';
    return { status: 200, body: { workshops: listWorkshops(ctx.db, recent ? { limit: 200 } : { conversationId: conversationId || null }) } };
  });

  router.get('/v1/workshops/:id', (ctx, match) => {
    requireHost(ctx);
    return { status: 200, body: { workshop: getWorkshop(ctx.db, match.params.id) } };
  });

  router.post('/v1/conversations/:id/workshop-focus', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    return broadcast(ctx, () => {
      const event = recordWorkshopFocus(ctx.db, {
        conversationId: match.params.id,
        workshopId: str(b.workshopId, 100),
        artifactId: str(b.artifactId, 100),
        open: b.open === true,
        actor: ctx.actor,
        clientId: ctx.clientId,
      });
      return { status: 200, body: { recorded: true, at: event.createdAt } };
    });
  });

  router.post('/v1/workshop-commands/:id/confirm', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    return broadcast(ctx, () => {
      confirmWorkshopCommand(ctx.db, {
        commandId: match.params.id,
        ok: b.ok === true,
        detail: str(b.detail, 400),
        state: b.state && typeof b.state === 'object' && !Array.isArray(b.state) ? b.state as Record<string, unknown> : null,
        actor: ctx.actor,
        clientId: ctx.clientId,
      });
      return { status: 200, body: { recorded: true } };
    });
  });

  /** An edit a person made with the Workshop's own controls (their click is the decision). */
  router.post('/v1/workshops/:id/versions', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    const workshop = getWorkshop(ctx.db, match.params.id);
    const latest = workshop.versions[workshop.versions.length - 1];
    const parentId = str(b.parentArtifactId, 100) ?? latest.artifactId;
    if (parentId !== latest.artifactId) {
      throw new CoreError('conflict', `the workshop has a newer version (v${latest.number}) than the one this edit was made on; reload and try again`);
    }
    if (workshop.type !== '3d') throw new CoreError('invalid_request', `${workshop.type} workshops are not edited through this route`);
    const { bytes } = readWorkshopVersion(ctx.db, latest.artifactId);
    const scene = parseSceneFile(bytes.toString('utf8'));
    if (!scene.ok) throw new CoreError('conflict', `the current version could not be read: ${scene.errors.join('; ')}`);
    const result = applySceneEdits(scene.value, b.edits);
    if (!result.ok) throw new CoreError('invalid_request', result.errors.join('; '));
    const changeText = result.changes.map((c) => `${c.name}: ${c.field} ${c.from ? `${c.from} → ` : ''}${c.to}`).join('; ');
    return broadcast(ctx, () => {
      const { artifact, meta } = writeWorkshopVersion(ctx.db, {
        dataDir: options.dataDir,
        conversationId: str(b.conversationId, 100) ?? workshop.conversationId,
        type: '3d', workshopId: workshop.workshopId, parentArtifactId: latest.artifactId, title: result.scene.title,
        bytes: Buffer.from(JSON.stringify(result.scene, null, 2), 'utf8'), extension: 'json', mimeType: WORKSHOP_MIME.scene, kind: 'document',
        op: { kind: 'edit', summary: `Edited in the Workshop: ${changeText}`.slice(0, 380) },
        engine: { tool: 'workshop window', engine: 'pandesh scene editor', model: null, provider: 'local', costUsd: 0 },
        verification: { ok: true, checks: [`PASS ${result.changes.length} change(s) applied to the named component(s) only`] },
        notes: result.scene.notes,
        actor: ctx.actor, clientId: ctx.clientId,
      });
      return { status: 201, body: { artifact, meta } };
    });
  });

  /**
   * A GLB the window exported with Babylon.js, staged by the host. Core reads it, checks it independently, keeps its
   * own copy as an export of the named version, and removes the staged file.
   */
  router.post('/v1/workshops/:id/exports', (ctx, match) => {
    requireHost(ctx);
    const b = body(ctx);
    const workshop = getWorkshop(ctx.db, match.params.id);
    const sourceId = str(b.sourceArtifactId, 100);
    const source = workshop.versions.find((v) => v.artifactId === sourceId);
    if (!source) throw new CoreError('invalid_request', 'sourceArtifactId must be a version of this workshop');
    if (b.format !== 'glb') throw new CoreError('invalid_request', 'only GLB exports are supported');
    const staged = str(b.stagedPath, 1_000);
    if (!staged || !path.isAbsolute(staged) || !/\.glb$/i.test(staged) || !path.resolve(staged).split(path.sep).includes('workshop-staging')) {
      throw new CoreError('invalid_request', 'stagedPath must be an absolute .glb path in a workshop-staging folder');
    }
    let bytes: Buffer;
    try {
      const stat = fs.statSync(staged);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('not a file of at most 64 MB');
      bytes = fs.readFileSync(staged);
    } catch (err) {
      throw new CoreError('invalid_request', `the staged export could not be read: ${(err as Error).message}`);
    }
    const check = verifyGlb(new Uint8Array(bytes));
    const expectedNames = Array.isArray(b.expectedNodes) ? (b.expectedNodes as unknown[]).map(String).slice(0, 64) : [];
    if (check.ok && expectedNames.length) {
      const names = new Set(glbNodeNames(new Uint8Array(bytes)));
      const missing = expectedNames.filter((n) => !names.has(n));
      check.checks.push(missing.length ? `FAIL ${missing.length} component(s) missing from the GLB nodes: ${missing.slice(0, 5).join(', ')}` : `PASS all ${expectedNames.length} components are nodes in the GLB`);
      if (missing.length) check.ok = false;
    }
    try { fs.rmSync(staged, { force: true }); } catch { /* staging is the host's to clean */ }
    if (!check.ok) return { status: 200, body: { verified: false, checks: check.checks } };
    return broadcast(ctx, () => {
      const { artifact, meta } = writeWorkshopVersion(ctx.db, {
        dataDir: options.dataDir,
        conversationId: str(b.conversationId, 100) ?? source.conversationId,
        type: '3d', workshopId: workshop.workshopId, parentArtifactId: source.artifactId, title: `${workshop.title} (GLB)`,
        bytes, extension: 'glb', mimeType: WORKSHOP_MIME.glb, kind: 'file',
        op: { kind: 'export', summary: `GLB export of version ${source.number}` },
        engine: { tool: 'workshop_export', engine: str(b.engine, 80) ?? 'Babylon.js glTF serializer', model: null, provider: 'local', costUsd: 0 },
        verification: { ok: true, checks: check.checks },
        exportOf: source.artifactId,
        actor: ctx.actor, clientId: ctx.clientId,
      });
      return { status: 201, body: { verified: true, artifact, meta, checks: check.checks, meshes: check.meshes, triangles: check.triangles } };
    });
  });
}
