/**
 * What an authenticated JUGAAD phone may ask of Pandesh, beyond the existing record sync. Every call arrives through the
 * companion envelope (TLS + per-device key + nonce replay protection) and is resolved to the phone's household before anything
 * else happens. The surface is small and fixed:
 *
 *   household.info                    which household this phone is in
 *   doc.put {uploadId,name,size,sha256,offset,data}   resumable upload; on completion a tracked intake task starts
 *   doc.status {taskId}               state of an intake task this phone started
 *   doc.search {q,limit}              full-text search inside this household's index
 *   doc.list {limit}                  recent documents in this household
 *
 * Tasks run on the existing Panda bridge lifecycle with a deterministic service and `authority: 'host'` but NO consent: an
 * external executor can never be reached from here, and there is no cloud fallback anywhere in the path.
 */
import type { CoreDatabase } from '../../db/connection';
import { CoreError } from '../../domain/errors';
import { createPairingCode, getBridgeTask, listBridgeTasks, listPairings, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../../domain/pandaBridge';
import { dispatchBridgeTask, type BridgeRuntime } from '../kandev/pandaBridge';
import { bridgeServices } from '../kandev/bridgeServices';
import { KandevClient } from '../kandev/kandevClient';
import { getDocument, listDocuments, openHouseholdIndex, searchDocuments } from './documentIndex';
import { householdOfDevice, loadHouseholds } from './households';
import { putChunk, type UploadParams } from './uploads';

/** One internal bridge pairing per phone. Its token is never kept, so nobody can present it: it only owns that phone's tasks. */
export function devicePairing(db: CoreDatabase, deviceId: string): BridgePairing {
  const label = `JUGAAD:${deviceId}`;
  const found = listPairings(db).find(p => p.label === label && !p.revokedAt);
  if (found) return found;
  return redeemPairingCode(db, { code: createPairingCode(db).code, label }).pairing;
}

export interface GatewayContext { db: CoreDatabase; dataDir: string; runtime?: BridgeRuntime }

function runtimeOf(ctx: GatewayContext): BridgeRuntime {
  return ctx.runtime ?? { db: ctx.db, kandev: new KandevClient(), dataDir: ctx.dataDir, services: bridgeServices(ctx.dataDir) };
}

/** Starts (idempotently) the intake task for a file that finished uploading. */
export async function startIntake(ctx: GatewayContext, deviceId: string, householdId: string, inboxName: string): Promise<{ taskId: string; state: string }> {
  const pairing = devicePairing(ctx.db, deviceId);
  const { task } = submitBridgeTask(ctx.db, pairing, {
    clientRequestId: `intake:${householdId}:${inboxName}`.slice(0, 100),
    instruction: JSON.stringify({ householdId, file: inboxName }),
    sourceRef: { kind: 'chatgpt', title: 'JUGAAD document intake' },
  });
  const { task: running } = await dispatchBridgeTask(runtimeOf(ctx), task.id, { executor: 'service:jugaad.ingest', decidedBy: `jugaad:${deviceId}`, taskClass: 'document.ingest', authority: 'host' });
  return { taskId: running.id, state: running.status };
}

export async function handleJugaadRpc(ctx: GatewayContext, deviceId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const hid = householdOfDevice(ctx.dataDir, deviceId);
  if (method === 'household.info') {
    const h = hid ? loadHouseholds(ctx.dataDir).households.find(x => x.id === hid) : null;
    return { household: h ? { id: h.id, name: h.name } : null };
  }
  if (!hid) throw new CoreError('forbidden', 'this phone is not attached to a household; attach it in Pandesh first');
  const index = openHouseholdIndex(ctx.dataDir, hid);
  switch (method) {
    case 'doc.put': {
      const r = putChunk(ctx.db, ctx.dataDir, hid, params as unknown as UploadParams);
      if (r.status !== 'complete') return r;
      const started = await startIntake(ctx, deviceId, hid, r.inboxName);
      return { status: 'complete', received: r.received, taskId: started.taskId, taskState: started.state };
    }
    case 'doc.status': {
      const taskId = String(params.taskId ?? '');
      const task = (() => { try { return getBridgeTask(ctx.db, taskId); } catch { return null; } })();
      // A phone sees only tasks its own pairing started; any other id looks exactly like an unknown one.
      if (!task || task.pairingId !== devicePairing(ctx.db, deviceId).id) throw new CoreError('not_found', 'task not found');
      const ev = (() => { try { return task.result?.evidence ? JSON.parse(task.result.evidence) : null; } catch { return null; } })() as { documentId?: string } | null;
      return { taskId: task.id, status: task.status, detail: task.statusDetail, verification: task.result?.verification ?? null, documentId: ev?.documentId ?? null, updatedAt: task.updatedAt };
    }
    case 'doc.search': return { hits: searchDocuments(index, String(params.q ?? ''), Number(params.limit) || 10) };
    case 'doc.list': return { documents: listDocuments(index, Number(params.limit) || 50).map(d => ({ id: d.id, name: d.name, type: d.typeLabel, bytes: d.bytes, addedAt: d.addedAt, fields: d.fields })) };
    case 'doc.get': {
      const d = getDocument(index, String(params.documentId ?? ''));
      if (!d) throw new CoreError('not_found', 'document not found');
      return { document: { id: d.id, name: d.name, type: d.typeLabel, bytes: d.bytes, addedAt: d.addedAt, textSource: d.textSource, textChars: d.textChars, fields: d.fields } };
    }
    case 'tasks.recent': return { tasks: listBridgeTasks(ctx.db, { pairingId: devicePairing(ctx.db, deviceId).id, limit: 20 }).map(t => ({ taskId: t.id, status: t.status, detail: t.statusDetail, updatedAt: t.updatedAt })) };
    default: throw new CoreError('invalid_request', `unknown method ${method}`);
  }
}

export const JUGAAD_METHODS = new Set(['household.info', 'doc.put', 'doc.status', 'doc.search', 'doc.list', 'doc.get', 'tasks.recent']);
