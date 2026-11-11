/**
 * The Video workshop's recipe: what a rendered slideshow was made from, so "make it vertical" renders the same
 * pictures again with one thing changed. Each version is the verified MP4 itself (a Core artifact); its recipe
 * travels in the version's metadata (WorkshopMeta.recipe) and names every picture by its Core artifact id and SHA-256,
 * so a re-render uses exactly the pictures that were approved, or refuses.
 *
 * Pure TypeScript, shared by Core and the window.
 */

export type VideoAspect = 'landscape' | 'vertical' | 'square';

export const VIDEO_ASPECTS: Record<VideoAspect, { width: number; height: number; label: string; ratio: string }> = {
  landscape: { width: 1920, height: 1080, label: 'Landscape', ratio: '16:9' },
  vertical: { width: 1080, height: 1920, label: 'Vertical', ratio: '9:16' },
  square: { width: 1080, height: 1080, label: 'Square', ratio: '1:1' },
};

export const MIN_SCENE_SECONDS = 1.5;
export const MAX_SCENE_SECONDS = 10;
export const MAX_SCENES = 40;

export interface VideoSource { artifactId: string; name: string; sha256: string }

export interface VideoRecipe {
  v: 1;
  kind: 'slideshow';
  title: string;
  aspect: VideoAspect;
  width: number;
  height: number;
  /** 'cover' fills the frame and crops what does not fit; 'contain' shows the whole picture with bars. */
  fit: 'cover' | 'contain';
  fps: 30;
  secondsPerScene: number;
  scenes: Array<VideoSource & { caption: string }>;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA = /^[0-9a-f]{64}$/;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** "vertical", "portrait", "9:16", "reel", "story" → vertical; "square", "1:1" → square; "landscape", "16:9" → landscape. */
export function aspectFromText(text: unknown): VideoAspect | null {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/\b(?:vertical|portrait|upright|9\s*[:x×/]\s*16|reels?|stor(?:y|ies)|tiktok|shorts)\b/.test(t)) return 'vertical';
  if (/\b(?:square|1\s*[:x×/]\s*1)\b/.test(t)) return 'square';
  if (/\b(?:landscape|horizontal|wide(?:screen)?|16\s*[:x×/]\s*9|youtube)\b/.test(t)) return 'landscape';
  return null;
}

/** The seconds each picture is shown for a total length, within the per-scene limits; null when it cannot fit. */
export function secondsForTotal(totalSeconds: number, scenes: number): number | null {
  if (!Number.isFinite(totalSeconds) || scenes < 1) return null;
  const each = totalSeconds / scenes;
  return each >= MIN_SCENE_SECONDS - 1e-9 && each <= MAX_SCENE_SECONDS + 1e-9 ? round3(each) : null;
}

export function recipeDuration(recipe: VideoRecipe): number {
  return round3(recipe.secondsPerScene * recipe.scenes.length);
}

export function parseVideoRecipe(raw: unknown): { ok: true; value: VideoRecipe } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['no recipe'] };
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'slideshow') errors.push('only slideshows can be re-rendered');
  const aspect = (['landscape', 'vertical', 'square'] as const).find((a) => a === r.aspect);
  if (!aspect) errors.push('unknown aspect');
  const seconds = Number(r.secondsPerScene);
  if (!(seconds >= MIN_SCENE_SECONDS - 1e-9 && seconds <= MAX_SCENE_SECONDS + 1e-9)) errors.push(`each picture must be shown ${MIN_SCENE_SECONDS}–${MAX_SCENE_SECONDS} s`);
  const scenes = Array.isArray(r.scenes) ? r.scenes : [];
  if (!scenes.length || scenes.length > MAX_SCENES) errors.push(`a slideshow has 1–${MAX_SCENES} pictures`);
  const clean: VideoRecipe['scenes'] = [];
  for (const s of scenes) {
    const x = (s ?? {}) as Record<string, unknown>;
    if (typeof x.artifactId !== 'string' || !ID.test(x.artifactId) || typeof x.sha256 !== 'string' || !SHA.test(x.sha256)) { errors.push('a picture is missing its id or digest'); break; }
    clean.push({ artifactId: x.artifactId, sha256: x.sha256, name: String(x.name ?? 'picture').slice(0, 120), caption: typeof x.caption === 'string' ? x.caption.slice(0, 70) : '' });
  }
  if (errors.length || !aspect) return { ok: false, errors };
  return {
    ok: true,
    value: {
      v: 1, kind: 'slideshow', title: String(r.title ?? 'Slideshow').slice(0, 120) || 'Slideshow', aspect,
      width: VIDEO_ASPECTS[aspect].width, height: VIDEO_ASPECTS[aspect].height,
      fit: r.fit === 'contain' ? 'contain' : 'cover', fps: 30, secondsPerScene: round3(seconds), scenes: clean,
    },
  };
}

export interface VideoChange {
  aspect?: unknown;
  totalSeconds?: unknown;
  secondsPerScene?: unknown;
  fit?: unknown;
  title?: unknown;
  captions?: unknown;
}

/** One change to a recipe, in plain words; anything it cannot do is refused, never approximated silently. */
export function applyVideoChanges(recipe: VideoRecipe, change: VideoChange): { ok: true; recipe: VideoRecipe; changes: string[] } | { ok: false; errors: string[] } {
  const next: VideoRecipe = { ...recipe, scenes: recipe.scenes.map((s) => ({ ...s })) };
  const changes: string[] = [];
  const errors: string[] = [];
  if (change.aspect !== undefined) {
    const aspect = aspectFromText(change.aspect);
    if (!aspect) errors.push('aspect must be vertical (9:16), square (1:1) or landscape (16:9)');
    else if (aspect !== recipe.aspect) {
      next.aspect = aspect; next.width = VIDEO_ASPECTS[aspect].width; next.height = VIDEO_ASPECTS[aspect].height;
      changes.push(`${VIDEO_ASPECTS[recipe.aspect].label} ${recipe.width}×${recipe.height} → ${VIDEO_ASPECTS[aspect].label} ${next.width}×${next.height}`);
    }
  }
  if (change.totalSeconds !== undefined) {
    const each = secondsForTotal(Number(change.totalSeconds), next.scenes.length);
    if (each === null) errors.push(`${next.scenes.length} picture(s) need ${MIN_SCENE_SECONDS * next.scenes.length}–${MAX_SCENE_SECONDS * next.scenes.length} s in total`);
    else if (each !== recipe.secondsPerScene) { next.secondsPerScene = each; changes.push(`length ${recipeDuration(recipe)} s → ${recipeDuration(next)} s (${each} s per picture)`); }
  } else if (change.secondsPerScene !== undefined) {
    const each = Number(change.secondsPerScene);
    if (!(each >= MIN_SCENE_SECONDS && each <= MAX_SCENE_SECONDS)) errors.push(`each picture is shown ${MIN_SCENE_SECONDS}–${MAX_SCENE_SECONDS} s`);
    else if (round3(each) !== recipe.secondsPerScene) { next.secondsPerScene = round3(each); changes.push(`${recipe.secondsPerScene} s → ${next.secondsPerScene} s per picture`); }
  }
  if (change.fit !== undefined) {
    const fit = change.fit === 'contain' || /\b(?:contain|whole|bars?|letterbox)\b/i.test(String(change.fit)) ? 'contain' : change.fit === 'cover' || /\b(?:cover|fill|crop)\b/i.test(String(change.fit)) ? 'cover' : null;
    if (!fit) errors.push('fit must be cover (fill and crop) or contain (whole picture)');
    else if (fit !== recipe.fit) { next.fit = fit; changes.push(`pictures ${recipe.fit === 'cover' ? 'fill the frame' : 'shown whole'} → ${fit === 'cover' ? 'fill the frame' : 'shown whole'}`); }
  }
  if (typeof change.title === 'string' && change.title.trim() && change.title.trim() !== recipe.title) {
    next.title = change.title.trim().slice(0, 120); changes.push(`title "${recipe.title}" → "${next.title}"`);
  }
  if (change.captions !== undefined) {
    const list = change.captions === 'none' ? next.scenes.map(() => '') : Array.isArray(change.captions) ? change.captions.map((c) => String(c ?? '').slice(0, 70)) : null;
    if (!list || list.length !== next.scenes.length) errors.push(`captions: give one per picture (${next.scenes.length}) or "none"`);
    else { next.scenes.forEach((s, i) => { s.caption = list[i]; }); changes.push(list.some(Boolean) ? 'captions changed' : 'captions removed'); }
  }
  if (errors.length) return { ok: false, errors };
  if (!changes.length) return { ok: false, errors: ['that is already how the video is'] };
  return { ok: true, recipe: next, changes };
}

export function describeRecipe(recipe: VideoRecipe): string {
  return `${recipe.scenes.length} picture(s) × ${recipe.secondsPerScene} s = ${recipeDuration(recipe)} s, ${VIDEO_ASPECTS[recipe.aspect].label} ${recipe.width}×${recipe.height} (${VIDEO_ASPECTS[recipe.aspect].ratio}), pictures ${recipe.fit === 'cover' ? 'fill the frame' : 'shown whole'}: ${recipe.scenes.map((s) => s.name).join(', ')}`;
}
