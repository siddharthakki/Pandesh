/**
 * The Video workshop's work in Core: take the pictures a person named (files or Core artifacts), keep Core's own
 * copies of them (artifacts with source `workshop_source`, never shown as workshops), and render a slideshow with the
 * existing promo-video pipeline (runtime/mediaProduction.ts: FFprobe inspects, FFmpeg renders, FFprobe and a frame
 * grab verify). A re-render ("make it vertical") reads the same copies back and refuses if any byte changed.
 *
 * Everything runs on this PC. No picture is sent anywhere; captions are only written by a model when asked, and then
 * by a local one.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { getArtifact, registerArtifact } from '../domain/artifacts';
import { WORKSHOP_SOURCE } from '../shared/workshop/model';
import { recipeDuration, type VideoRecipe, type VideoSource } from '../shared/workshop/video';
import { createPromoVideo, resolveImages, type VideoResult } from './mediaProduction';
import type { InventoryProbeDeps } from './capabilityInventory';

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const MAX_PICTURE_BYTES = 60 * 1024 * 1024;

export interface PictureFile { path: string; name: string; sha256: string; bytes: number }

const sha256Of = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The pictures named by path, folder or Core artifact id, with their digests (frozen into the approval). */
export function resolvePictures(db: CoreDatabase, inputs: string[]): { pictures: PictureFile[]; problems: string[] } {
  const pictures: PictureFile[] = [];
  const problems: string[] = [];
  for (const raw of inputs.slice(0, 60)) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (/^art_[\w-]+$/.test(value)) {
      try {
        const a = getArtifact(db, value);
        if (a.kind !== 'image' || a.availability !== 'ready') { problems.push(`${value}: not an available picture`); continue; }
        pictures.push({ path: a.absolutePath, name: a.title || path.basename(a.absolutePath), sha256: a.sha256, bytes: a.byteSize });
      } catch { problems.push(`${value}: no such artifact`); }
      continue;
    }
    const found = resolveImages([value]);
    if (!found.length) { problems.push(`${value}: no picture there`); continue; }
    for (const file of found) {
      const ext = path.extname(file).toLowerCase();
      if (!IMAGE_MIME[ext]) { problems.push(`${path.basename(file)}: not a picture`); continue; }
      const size = fs.statSync(file).size;
      if (size > MAX_PICTURE_BYTES) { problems.push(`${path.basename(file)}: larger than 60 MB`); continue; }
      pictures.push({ path: file, name: path.basename(file), sha256: sha256Of(file), bytes: size });
    }
  }
  return { pictures: pictures.slice(0, 40), problems };
}

/** Core's own copies of the pictures, as artifacts the recipe names by id and digest. */
export function keepPictures(db: CoreDatabase, input: { dataDir: string; workshopId: string; pictures: PictureFile[]; actor: string }): VideoSource[] {
  const dir = path.join(input.dataDir, 'workshop', input.workshopId, 'sources');
  fs.mkdirSync(dir, { recursive: true });
  return input.pictures.map((p, i) => {
    const bytes = fs.readFileSync(p.path);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== p.sha256) throw new Error(`${p.name} changed after it was approved; nothing was rendered`);
    const ext = path.extname(p.path).toLowerCase() || '.png';
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${sha256.slice(0, 12)}${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
    const artifact = registerArtifact(db, {
      conversationId: null, kind: 'image', title: p.name.slice(0, 120), mimeType: IMAGE_MIME[ext] ?? 'image/png', absolutePath: file,
      source: WORKSHOP_SOURCE, metadata: { workshopSource: { workshopId: input.workshopId, originalName: p.name.slice(0, 200) } }, actor: input.actor,
    });
    return { artifactId: artifact.id, name: p.name.slice(0, 120), sha256 };
  });
}

/** The kept copies for a recipe, each checked against its digest. */
export function picturesOf(db: CoreDatabase, recipe: VideoRecipe): string[] {
  return recipe.scenes.map((s) => {
    const a = getArtifact(db, s.artifactId);
    if (a.availability === 'changed') throw new Error(`the copy of ${s.name} changed; nothing was rendered`);
    if (a.availability !== 'ready' || !fs.existsSync(a.absolutePath)) throw new Error(`the copy of ${s.name} is ${a.availability === 'ready' ? 'missing' : a.availability}; nothing was rendered`);
    if (sha256Of(a.absolutePath) !== s.sha256) throw new Error(`the copy of ${s.name} changed; nothing was rendered`);
    return a.absolutePath;
  });
}

export interface RenderedVideo { bytes: Buffer; result: VideoResult; checks: string[]; ok: boolean }

/** Renders a recipe with the promo-video pipeline in a private staging folder, then checks the length exactly. */
export async function renderRecipe(recipe: VideoRecipe, pictures: string[], options: { dataDir: string; onStage?: (stage: string) => void; deps?: InventoryProbeDeps }): Promise<RenderedVideo> {
  const staging = fs.mkdtempSync(path.join(fs.existsSync(options.dataDir) ? options.dataDir : os.tmpdir(), 'workshop-render-'));
  try {
    const output = path.join(staging, 'video.mp4');
    const captions = recipe.scenes.some((s) => s.caption) ? recipe.scenes.map((s) => s.caption) : 'none';
    const result = await createPromoVideo({
      images: pictures, output, secondsPerImage: recipe.secondsPerScene, captions, width: recipe.width, height: recipe.height, fit: recipe.fit, onStage: options.onStage, fadeFromBlack: false,
    }, options.deps ?? {});
    const expected = recipeDuration(recipe);
    const lengthOk = Math.abs(result.durationSec - expected) <= 0.25;
    const sceneCountOk = result.skipped.length === 0;
    const checks = [
      ...result.verification,
      `${lengthOk ? 'PASS' : 'FAIL'} length ${result.durationSec.toFixed(2)} s for ${recipe.scenes.length} × ${recipe.secondsPerScene} s (expected ${expected} s ± 0.25)`,
      `${sceneCountOk ? 'PASS' : 'FAIL'} all ${recipe.scenes.length} picture(s) rendered${result.skipped.length ? `; skipped: ${result.skipped.map((s) => path.basename(s.image)).join(', ')}` : ''}`,
    ];
    return { bytes: fs.readFileSync(output), result, checks, ok: result.verified && lengthOk && sceneCountOk };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* staging */ }
  }
}
