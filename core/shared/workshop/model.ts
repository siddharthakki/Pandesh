/**
 * The Workshop: where what Pandesh makes can be seen, inspected, refined and taken away.
 *
 * One small contract shared by Core, the desktop host and the window. A workshop is a line of versions of ONE thing
 * (a 3D scene, a simulation, a design, an image or a video). Every version is an ordinary Core artifact
 * (core/domain/artifacts.ts): an immutable file with a SHA-256 digest, linked to its conversation. The
 * workshop-specific facts travel in that artifact's metadata under `workshop`. There is no second store, no second
 * event stream and no second approval path: the Workshop is a way of looking at artifacts Core already governs.
 *
 * Pure TypeScript with no Node or DOM imports, so the window can use the same rules as Core.
 */

export type WorkshopType = '3d' | 'simulation' | 'design' | 'image' | 'video';
export const WORKSHOP_TYPES: readonly WorkshopType[] = ['3d', 'simulation', 'design', 'image', 'video'];

export const WORKSHOP_TYPE_LABEL: Record<WorkshopType, string> = {
  '3d': '3D',
  simulation: 'Simulation',
  design: 'Design',
  image: 'Image',
  video: 'Video',
};

/** Media types of the files a workshop version is stored as. */
export const WORKSHOP_MIME = {
  scene: 'application/vnd.pandesh.scene+json',
  simulation: 'application/vnd.pandesh.simulation+json',
  design: 'text/html',
  glb: 'model/gltf-binary',
  mp4: 'video/mp4',
} as const;

/** How a version came to be. `generate`/`refine` are model-made pixels; `render` is an FFmpeg render. */
export type WorkshopOpKind = 'create' | 'edit' | 'restore' | 'export' | 'generate' | 'refine' | 'render';
const OP_KINDS: readonly WorkshopOpKind[] = ['create', 'edit', 'restore', 'export', 'generate', 'refine', 'render'];

export interface WorkshopEngine {
  /** The Pandesh tool or window action that wrote the version. */
  tool: string;
  /** The engine behind it (three.js export, FFmpeg, ComfyUI checkpoint…), when there is one. */
  engine?: string | null;
  /** The language model that proposed the change, when one did. */
  model?: string | null;
  /** Where the work ran. Workshop tools only run locally today. */
  provider: 'local' | 'cloud';
  /** Money spent, when known. Local work is 0; null means "not reported". */
  costUsd: number | null;
}

/** The `workshop` entry of an artifact's metadata. */
export interface WorkshopMeta {
  v: 1;
  type: WorkshopType;
  /** Shared by every version of one thing. */
  workshopId: string;
  /** The version this one was made from; null for the first. */
  parentArtifactId: string | null;
  op: { kind: WorkshopOpKind; summary: string };
  engine: WorkshopEngine;
  /** What Core itself checked about the file (never the model's own claim). */
  verification?: { ok: boolean; checks: string[] };
  /** Honest notes shown with the version, e.g. "the whole image was regenerated; pixels were not preserved". */
  notes?: string[];
  /** Set on an export: the version it was exported from. */
  exportOf?: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function isWorkshopType(value: unknown): value is WorkshopType {
  return typeof value === 'string' && (WORKSHOP_TYPES as readonly string[]).includes(value);
}

/** Bounds and checks a `workshop` metadata entry; returns null when it is not a usable one. */
export function sanitizeWorkshopMeta(raw: unknown): WorkshopMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isWorkshopType(r.type)) return null;
  if (typeof r.workshopId !== 'string' || !ID.test(r.workshopId)) return null;
  const op = (r.op && typeof r.op === 'object' ? r.op : {}) as Record<string, unknown>;
  const kind = OP_KINDS.includes(op.kind as WorkshopOpKind) ? (op.kind as WorkshopOpKind) : 'create';
  const engineRaw = (r.engine && typeof r.engine === 'object' ? r.engine : {}) as Record<string, unknown>;
  const cost = typeof engineRaw.costUsd === 'number' && Number.isFinite(engineRaw.costUsd) && engineRaw.costUsd >= 0 ? engineRaw.costUsd : null;
  const meta: WorkshopMeta = {
    v: 1,
    type: r.type,
    workshopId: r.workshopId,
    parentArtifactId: typeof r.parentArtifactId === 'string' && ID.test(r.parentArtifactId) ? r.parentArtifactId : null,
    op: { kind, summary: text(op.summary, 400) ?? kind },
    engine: {
      tool: text(engineRaw.tool, 80) ?? 'unknown',
      engine: text(engineRaw.engine, 120),
      model: text(engineRaw.model, 120),
      provider: engineRaw.provider === 'cloud' ? 'cloud' : 'local',
      costUsd: cost,
    },
  };
  const verification = r.verification as Record<string, unknown> | undefined;
  if (verification && typeof verification === 'object' && Array.isArray(verification.checks)) {
    meta.verification = {
      ok: verification.ok === true,
      checks: verification.checks.map((c) => text(c, 240)).filter((c): c is string => Boolean(c)).slice(0, 12),
    };
  }
  if (Array.isArray(r.notes)) {
    const notes = r.notes.map((n) => text(n, 300)).filter((n): n is string => Boolean(n)).slice(0, 6);
    if (notes.length) meta.notes = notes;
  }
  if (typeof r.exportOf === 'string' && ID.test(r.exportOf)) meta.exportOf = r.exportOf;
  return meta;
}

/** The artifact fields the Workshop reads. Matches `ArtifactRecord` without importing Core's wire types. */
export interface WorkshopArtifactLike {
  id: string;
  conversationId: string | null;
  kind: 'image' | 'video' | 'document' | 'file';
  title: string;
  mimeType: string;
  createdAt: string;
  byteSize: number;
  source: string;
  availability: 'ready' | 'missing' | 'changed' | 'unreadable';
  metadata?: Record<string, unknown>;
}

/**
 * The workshop entry of an artifact. An image or video made before the Workshop existed (no metadata entry) is a
 * one-version workshop of its own, so every picture and clip Pandesh ever made can still be opened.
 */
export function workshopMetaOf(artifact: WorkshopArtifactLike): WorkshopMeta | null {
  const meta = sanitizeWorkshopMeta(artifact.metadata?.workshop);
  if (meta) return meta;
  if (artifact.kind === 'image' && artifact.mimeType.startsWith('image/') && artifact.source !== 'browser_screenshot' && artifact.source !== 'user_attachment') {
    return legacyMeta(artifact, 'image');
  }
  if (artifact.kind === 'video' && artifact.mimeType.startsWith('video/')) return legacyMeta(artifact, 'video');
  return null;
}

function legacyMeta(artifact: WorkshopArtifactLike, type: 'image' | 'video'): WorkshopMeta {
  const md = artifact.metadata ?? {};
  const model = typeof md.checkpoint === 'string' ? md.checkpoint : null;
  return {
    v: 1,
    type,
    workshopId: artifact.id,
    parentArtifactId: null,
    op: { kind: 'generate', summary: typeof md.prompt === 'string' ? md.prompt.slice(0, 400) : artifact.title },
    engine: { tool: artifact.source, engine: model, model: null, provider: 'local', costUsd: 0 },
  };
}

export interface WorkshopVersion {
  artifactId: string;
  /** 1-based, in the order the versions were made. */
  number: number;
  createdAt: string;
  title: string;
  mimeType: string;
  kind: WorkshopArtifactLike['kind'];
  byteSize: number;
  availability: WorkshopArtifactLike['availability'];
  conversationId: string | null;
  meta: WorkshopMeta;
}

export interface WorkshopSummary {
  workshopId: string;
  type: WorkshopType;
  /** The latest version's title. */
  title: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  latestArtifactId: string;
  versions: WorkshopVersion[];
  /** Files exported from versions (a GLB of a 3D version), newest last. Not versions themselves. */
  exports: WorkshopVersion[];
}

/**
 * Groups artifacts into workshops, versions in the order they were made. Exports are kept apart from versions:
 * an exported GLB is a copy of one version, not a new state of the thing.
 */
export function groupWorkshops(artifacts: readonly WorkshopArtifactLike[]): WorkshopSummary[] {
  const groups = new Map<string, Array<{ artifact: WorkshopArtifactLike; meta: WorkshopMeta }>>();
  const exportsBy = new Map<string, Array<{ artifact: WorkshopArtifactLike; meta: WorkshopMeta }>>();
  for (const artifact of artifacts) {
    const meta = workshopMetaOf(artifact);
    if (!meta) continue;
    const target = meta.op.kind === 'export' ? exportsBy : groups;
    const list = target.get(meta.workshopId) ?? [];
    list.push({ artifact, meta });
    target.set(meta.workshopId, list);
  }
  const byTime = (a: { artifact: WorkshopArtifactLike }, b: { artifact: WorkshopArtifactLike }) => a.artifact.createdAt.localeCompare(b.artifact.createdAt) || a.artifact.id.localeCompare(b.artifact.id);
  const toVersion = ({ artifact, meta }: { artifact: WorkshopArtifactLike; meta: WorkshopMeta }, index: number): WorkshopVersion => ({
    artifactId: artifact.id,
    number: index + 1,
    createdAt: artifact.createdAt,
    title: artifact.title,
    mimeType: artifact.mimeType,
    kind: artifact.kind,
    byteSize: artifact.byteSize,
    availability: artifact.availability,
    conversationId: artifact.conversationId,
    meta,
  });
  const out: WorkshopSummary[] = [];
  for (const [workshopId, list] of groups) {
    list.sort(byTime);
    const versions: WorkshopVersion[] = list.map(toVersion);
    const exported = (exportsBy.get(workshopId) ?? []).sort(byTime).map(toVersion);
    const latest = versions[versions.length - 1];
    out.push({
      workshopId,
      type: latest.meta.type,
      title: latest.title,
      conversationId: versions[0].conversationId,
      createdAt: versions[0].createdAt,
      updatedAt: latest.createdAt,
      latestArtifactId: latest.artifactId,
      versions,
      exports: exported,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** "v3 of 5" style label for a version. */
export function versionLabel(summary: WorkshopSummary, artifactId: string): string {
  const v = summary.versions.find((x) => x.artifactId === artifactId);
  return v ? `v${v.number} of ${summary.versions.length}` : 'unknown version';
}

/**
 * Commands the window carries out on what it shows. They change only the view (camera, explode, labels, playback,
 * which version is on screen), never a file, so they are read-only for Ask / Auto / Plan Only.
 */
export const WORKSHOP_VIEW_ACTIONS = [
  'open', 'close', 'fullscreen', 'exit_fullscreen',
  'show_version', 'compare',
  // 3D
  'rotate', 'stop_rotation', 'explode', 'assemble', 'labels_on', 'labels_off', 'reset_camera', 'camera', 'focus', 'isolate', 'show_all',
  // Simulation
  'play', 'pause', 'reset', 'speed', 'show_metric',
  // Design
  'device', 'show_code',
  // Image / video
  'zoom', 'fit',
] as const;
export type WorkshopViewAction = typeof WORKSHOP_VIEW_ACTIONS[number];

export function isWorkshopViewAction(value: unknown): value is WorkshopViewAction {
  return typeof value === 'string' && (WORKSHOP_VIEW_ACTIONS as readonly string[]).includes(value);
}

/** A window command as the host hands it to the window. */
export interface WorkshopCommand {
  id: string;
  workshopId: string;
  artifactId: string | null;
  action: WorkshopViewAction | 'export';
  args: Record<string, unknown>;
}
