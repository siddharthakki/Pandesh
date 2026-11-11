/**
 * The Workshop's durable state, all of it in records Core already keeps.
 *
 *  - A workshop version is an artifact (core/domain/artifacts.ts) whose metadata carries `workshop`
 *    (core/shared/workshop/model.ts): immutable file, SHA-256, conversation link, `artifact_registered` event.
 *  - What the Pandesh window has open is a `workshop_focused` runtime event on the conversation, so "make it blue"
 *    resolves to the thing on screen, and survives a restart.
 *  - A view command (rotate, explode, play…) is a `workshop_command_requested` event the host passes to the window;
 *    the window answers with what it really shows (`workshop_command_confirmed`). A tool reports a command as done
 *    only after that answer, the same contract as navigate_to (core/domain/uiNavigation.ts).
 *  - Long work reports real stages as `workshop_progress` events (never invented percentages).
 *
 * Nothing here decides authority: tools that create versions are consequential governed calls
 * (core/runtime/workshopCapability.ts); the window's own edits come through host-only routes.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { ArtifactKind, ArtifactRecord, RuntimeEventRecord } from '../shared/wireTypes';
import { groupWorkshops, sanitizeWorkshopMeta, workshopMetaOf, type WorkshopEngine, type WorkshopMeta, type WorkshopOpKind, type WorkshopSummary, type WorkshopType, type WorkshopViewAction } from '../shared/workshop/model';
import { getArtifact, registerArtifact, rowToArtifact } from './artifacts';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

export const WORKSHOP_COMMAND_CONFIRM_TIMEOUT_MS = 6_000;
const MAX_VERSION_BYTES = 64 * 1024 * 1024;

// ------------------------------------------------------------------------------------------ reading

/**
 * Workshop artifacts, newest first. Images and videos made before the Workshop existed have no metadata entry and
 * count as one-version workshops of their own (their workshop id is the artifact id).
 */
export function listWorkshopArtifacts(db: CoreDatabase, filter: { conversationId?: string | null; workshopId?: string | null; limit?: number } = {}): ArtifactRecord[] {
  const where = ["(json_extract(metadataJson, '$.workshop.workshopId') IS NOT NULL OR kind IN ('image', 'video'))", "source NOT IN ('browser_screenshot', 'user_attachment')"];
  const params: unknown[] = [];
  if (filter.conversationId) { where.push('conversationId = ?'); params.push(filter.conversationId); }
  if (filter.workshopId) { where.push("(json_extract(metadataJson, '$.workshop.workshopId') = ? OR id = ?)"); params.push(filter.workshopId, filter.workshopId); }
  const limit = Math.max(1, Math.min(500, filter.limit ?? 300));
  const rows = db.all<Record<string, unknown>>(`SELECT * FROM artifacts WHERE ${where.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit}`, params);
  return rows.map(rowToArtifact);
}

/** Workshops, most recently changed first. With a conversation, only workshops that have a version there. */
export function listWorkshops(db: CoreDatabase, filter: { conversationId?: string | null; limit?: number } = {}): WorkshopSummary[] {
  const local = listWorkshopArtifacts(db, { conversationId: filter.conversationId ?? null, limit: filter.limit });
  if (!filter.conversationId) return groupWorkshops(local);
  // A workshop continued in another chat keeps all its versions: read each one whole.
  const ids = [...new Set(local.map((a) => workshopMetaOf(a)?.workshopId).filter((id): id is string => Boolean(id)))];
  return ids.flatMap((id) => groupWorkshops(listWorkshopArtifacts(db, { workshopId: id }))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getWorkshop(db: CoreDatabase, workshopId: string): WorkshopSummary {
  const found = groupWorkshops(listWorkshopArtifacts(db, { workshopId })).find((w) => w.workshopId === workshopId);
  if (!found) throw new CoreError('not_found', `workshop '${workshopId}' not found`);
  return found;
}

/** The verified bytes of one version (re-hashed against Core's record before use). */
export function readWorkshopVersion(db: CoreDatabase, artifactId: string): { artifact: ArtifactRecord; meta: WorkshopMeta; bytes: Buffer } {
  const artifact = getArtifact(db, artifactId);
  const meta = workshopMetaOf(artifact);
  if (!meta) throw new CoreError('invalid_request', `artifact '${artifactId}' is not part of a workshop`);
  if (artifact.availability !== 'ready') throw new CoreError('conflict', `version ${artifactId} is ${artifact.availability} on disk; it cannot be opened`);
  const bytes = fs.readFileSync(artifact.absolutePath);
  if (bytes.length !== artifact.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new CoreError('conflict', `version ${artifactId} changed on disk after Core recorded it`);
  }
  return { artifact, meta, bytes };
}

// ------------------------------------------------------------------------------------------ writing

export interface WriteWorkshopVersionInput {
  dataDir: string;
  conversationId: string | null;
  attemptId?: string | null;
  type: WorkshopType;
  /** Omitted for a new workshop. */
  workshopId?: string | null;
  parentArtifactId?: string | null;
  title: string;
  bytes: Buffer;
  extension: string;
  mimeType: string;
  kind: ArtifactKind;
  op: { kind: WorkshopOpKind; summary: string };
  engine: WorkshopEngine;
  verification?: { ok: boolean; checks: string[] };
  notes?: string[];
  exportOf?: string | null;
  actor: string;
  clientId?: string | null;
}

/**
 * Writes one new, immutable version file under `<dataDir>/workshop/<workshopId>/` (never overwriting anything) and
 * registers it as a Core artifact with its workshop metadata.
 */
export function writeWorkshopVersion(db: CoreDatabase, input: WriteWorkshopVersionInput): { artifact: ArtifactRecord; meta: WorkshopMeta } {
  if (!input.bytes.length || input.bytes.length > MAX_VERSION_BYTES) throw new CoreError('invalid_request', `a workshop version must be 1 byte to ${MAX_VERSION_BYTES} bytes`);
  if (!/^[a-z0-9]{1,8}$/.test(input.extension)) throw new CoreError('invalid_request', 'invalid file extension');
  const workshopId = input.workshopId ?? newId('ws');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(workshopId)) throw new CoreError('invalid_request', 'invalid workshop id');
  const meta = sanitizeWorkshopMeta({
    v: 1,
    type: input.type,
    workshopId,
    parentArtifactId: input.parentArtifactId ?? null,
    op: input.op,
    engine: input.engine,
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.notes?.length ? { notes: input.notes } : {}),
    ...(input.exportOf ? { exportOf: input.exportOf } : {}),
  });
  if (!meta) throw new CoreError('invalid_request', 'invalid workshop metadata');
  const dir = path.join(input.dataDir, 'workshop', workshopId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = nowIso().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `${stamp}-${crypto.randomBytes(4).toString('hex')}.${input.extension}`);
  fs.writeFileSync(file, input.bytes, { flag: 'wx' });
  const conversationId = input.conversationId && db.get('SELECT id FROM conversations WHERE id = ?', [input.conversationId]) ? input.conversationId : null;
  const artifact = registerArtifact(db, {
    conversationId,
    attemptId: input.attemptId ?? null,
    kind: input.kind,
    title: input.title.slice(0, 120) || 'Workshop',
    mimeType: input.mimeType,
    absolutePath: file,
    source: 'workshop',
    metadata: { workshop: meta },
    actor: input.actor,
    clientId: input.clientId ?? null,
  });
  return { artifact, meta };
}

// ------------------------------------------------------------------------------------------ what is on screen

export interface WorkshopFocus { workshopId: string | null; artifactId: string | null; open: boolean; at: string }

/** The window opened, switched or closed a workshop in this conversation. */
export function recordWorkshopFocus(db: CoreDatabase, input: { conversationId: string; workshopId: string | null; artifactId: string | null; open: boolean; actor: string; clientId?: string | null }): RuntimeEventRecord {
  if (!db.get('SELECT id FROM conversations WHERE id = ?', [input.conversationId])) throw new CoreError('not_found', `conversation '${input.conversationId}' not found`);
  if (input.workshopId && !listWorkshopArtifacts(db, { workshopId: input.workshopId, limit: 1 }).length) throw new CoreError('not_found', `workshop '${input.workshopId}' not found`);
  return recordRuntimeEvent(db, {
    domain: 'workshop',
    entityId: input.conversationId,
    eventType: 'workshop_focused',
    actor: input.actor,
    clientId: input.clientId ?? null,
    metadata: { workshopId: input.workshopId, artifactId: input.artifactId, open: input.open },
  });
}

export function workshopFocus(db: CoreDatabase, conversationId: string): WorkshopFocus | null {
  const row = db.get<{ metadata: string; createdAt: string }>(
    "SELECT metadata, createdAt FROM runtime_events WHERE domain = 'workshop' AND entityId = ? AND eventType = 'workshop_focused' ORDER BY sequence DESC LIMIT 1",
    [conversationId],
  );
  if (!row) return null;
  const m = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
  return { workshopId: typeof m.workshopId === 'string' ? m.workshopId : null, artifactId: typeof m.artifactId === 'string' ? m.artifactId : null, open: m.open === true, at: row.createdAt };
}

export type WorkshopTarget =
  | { ok: true; workshop: WorkshopSummary; via: 'named' | 'on_screen' | 'only_one' }
  | { ok: false; reason: string; candidates: Array<{ workshopId: string; type: WorkshopType; title: string }> };

/**
 * Which workshop "it" is. In order: the one the request names; the one open in the window; the only one of that
 * type in this conversation. Anything else is ambiguous and is answered with the candidates, never guessed.
 */
export function resolveWorkshopTarget(db: CoreDatabase, input: { conversationId: string | null; named?: string | null; type?: WorkshopType | null }): WorkshopTarget {
  const here = input.conversationId ? listWorkshops(db, { conversationId: input.conversationId }) : [];
  const candidates = (list: WorkshopSummary[]) => list.slice(0, 8).map((w) => ({ workshopId: w.workshopId, type: w.type, title: w.title }));
  const typeOk = (w: WorkshopSummary) => !input.type || w.type === input.type;
  const named = (input.named ?? '').trim();
  if (named) {
    const byId = here.find((w) => w.workshopId === named || w.versions.some((v) => v.artifactId === named));
    if (byId) return typeOk(byId) ? { ok: true, workshop: byId, via: 'named' } : { ok: false, reason: `"${byId.title}" is a ${byId.type} workshop, not ${input.type}`, candidates: candidates(here) };
    const lower = named.toLowerCase();
    const byTitle = here.filter((w) => typeOk(w) && w.title.toLowerCase().includes(lower));
    if (byTitle.length === 1) return { ok: true, workshop: byTitle[0], via: 'named' };
    // An id from another chat ("open the last design") is still a real workshop.
    try {
      const elsewhere = getWorkshop(db, named);
      if (typeOk(elsewhere)) return { ok: true, workshop: elsewhere, via: 'named' };
    } catch { /* not an id */ }
    return { ok: false, reason: byTitle.length > 1 ? `"${named}" matches more than one workshop` : `no workshop here matches "${named}"`, candidates: candidates(byTitle.length > 1 ? byTitle : here) };
  }
  if (input.conversationId) {
    const focus = workshopFocus(db, input.conversationId);
    if (focus?.open && focus.workshopId) {
      try {
        const onScreen = getWorkshop(db, focus.workshopId);
        if (typeOk(onScreen)) return { ok: true, workshop: onScreen, via: 'on_screen' };
      } catch { /* deleted since */ }
    }
  }
  const ofType = here.filter(typeOk);
  if (ofType.length === 1) return { ok: true, workshop: ofType[0], via: 'only_one' };
  if (ofType.length === 0) return { ok: false, reason: input.type ? `this conversation has no ${input.type} workshop yet` : 'this conversation has no workshop yet', candidates: candidates(here) };
  return { ok: false, reason: `this conversation has ${ofType.length} ${input.type ? `${input.type} ` : ''}workshops and none is open in the window, so "it" is ambiguous`, candidates: candidates(ofType) };
}

// ------------------------------------------------------------------------------------------ window commands

export interface WorkshopCommandResult {
  status: 'done' | 'not_done' | 'not_confirmed';
  commandId: string;
  detail: string | null;
  /** What the window reported it shows after the command (bounded, display data only). */
  state: Record<string, unknown> | null;
}

export function workshopCommandConfirmation(db: CoreDatabase, commandId: string): { ok: boolean; detail: string | null; state: Record<string, unknown> | null } | null {
  const row = db.get<{ metadata: string }>(
    "SELECT metadata FROM runtime_events WHERE domain = 'workshop' AND entityId = ? AND eventType = 'workshop_command_confirmed' ORDER BY sequence DESC LIMIT 1",
    [commandId],
  );
  if (!row) return null;
  const m = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
  return { ok: m.ok === true, detail: typeof m.detail === 'string' ? m.detail : null, state: m.state && typeof m.state === 'object' ? m.state as Record<string, unknown> : null };
}

/** Records the window's answer to a command it was asked to carry out. Refuses an id nobody requested. */
export function confirmWorkshopCommand(db: CoreDatabase, input: { commandId: string; ok: boolean; detail?: string | null; state?: Record<string, unknown> | null; actor: string; clientId?: string | null }): RuntimeEventRecord {
  const requested = db.get("SELECT id FROM runtime_events WHERE domain = 'workshop' AND entityId = ? AND eventType = 'workshop_command_requested'", [input.commandId]);
  if (!requested) throw new CoreError('not_found', `workshop command '${input.commandId}' was not requested`);
  let state: Record<string, unknown> | null = input.state && typeof input.state === 'object' ? input.state : null;
  if (state && Buffer.byteLength(JSON.stringify(state), 'utf8') > 6_000) state = { truncated: true };
  return recordRuntimeEvent(db, {
    domain: 'workshop',
    entityId: input.commandId,
    eventType: 'workshop_command_confirmed',
    actor: input.actor,
    clientId: input.clientId ?? null,
    metadata: { ok: input.ok === true, detail: input.detail ? String(input.detail).slice(0, 400) : null, state },
  });
}

/**
 * Asks the Pandesh window to carry out a view command and waits for its answer. Only `done` means the window
 * confirmed it; the caller must never report anything else as done.
 */
export async function requestWorkshopCommand(db: CoreDatabase, input: {
  conversationId: string | null;
  attemptId: string | null;
  workshopId: string;
  artifactId: string | null;
  action: WorkshopViewAction | 'export' | 'inspect';
  args?: Record<string, unknown>;
  actor: string;
  publish?: (event: RuntimeEventRecord) => void;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WorkshopCommandResult> {
  const commandId = newId('wscmd');
  const event = recordRuntimeEvent(db, {
    domain: 'workshop',
    entityId: commandId,
    eventType: 'workshop_command_requested',
    actor: input.actor,
    metadata: { conversationId: input.conversationId, attemptId: input.attemptId, workshopId: input.workshopId, artifactId: input.artifactId, action: input.action, args: input.args ?? {} },
  });
  input.publish?.(event);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (input.timeoutMs ?? WORKSHOP_COMMAND_CONFIRM_TIMEOUT_MS);
  for (;;) {
    const answer = workshopCommandConfirmation(db, commandId);
    if (answer) return { status: answer.ok ? 'done' : 'not_done', commandId, detail: answer.detail, state: answer.state };
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  return { status: 'not_confirmed', commandId, detail: null, state: null };
}

/** A real stage of long work (FFmpeg scene 2 of 3, a ComfyUI job queued…), published at once. */
export function recordWorkshopProgress(db: CoreDatabase, input: { workshopId: string | null; conversationId: string | null; attemptId?: string | null; stage: string; index?: number | null; total?: number | null; actor: string; publish?: (event: RuntimeEventRecord) => void }): void {
  try {
    const event = recordRuntimeEvent(db, {
      domain: 'workshop',
      entityId: input.workshopId ?? input.conversationId ?? 'workshop',
      eventType: 'workshop_progress',
      actor: input.actor,
      metadata: {
        workshopId: input.workshopId, conversationId: input.conversationId, attemptId: input.attemptId ?? null,
        stage: input.stage.slice(0, 200),
        ...(Number.isInteger(input.index) ? { index: input.index } : {}),
        ...(Number.isInteger(input.total) ? { total: input.total } : {}),
      },
    });
    input.publish?.(event);
  } catch {
    // Progress is display only; the work itself is unaffected.
  }
}

/** The time the newest version of a workshop was written, for "nothing changed since" checks. */
export function latestVersion(summary: WorkshopSummary): { artifactId: string; number: number } {
  const v = summary.versions[summary.versions.length - 1];
  return { artifactId: v.artifactId, number: v.number };
}
