/**
 * The Video workshop: each version is the verified MP4, carrying the recipe it was rendered from. A re-render ("make
 * it vertical") uses Core's own copies of the same pictures, checked by SHA-256, and refuses if any changed. The
 * end-to-end tests render with the real FFmpeg and are skipped where it is not installed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { listArtifacts } from '../domain/artifacts';
import { listWorkshops, readWorkshopVersion, recordWorkshopFocus } from '../domain/workshops';
import { createWorkshopCapabilityAdapter } from '../runtime/workshopCapability';
import { sanitizeWorkshopMeta } from '../shared/workshop/model';
import { VIDEO_ASPECTS, aspectFromText, applyVideoChanges, parseVideoRecipe, recipeDuration, secondsForTotal, type VideoRecipe } from '../shared/workshop/video';

const SHA = 'a'.repeat(64);
const recipe = (over: Partial<VideoRecipe> = {}): VideoRecipe => ({
  v: 1, kind: 'slideshow', title: 'Biryani promo', aspect: 'landscape', width: 1920, height: 1080, fit: 'cover', fps: 30, secondsPerScene: 1.667,
  scenes: ['one.png', 'two.png', 'three.png'].map((name, i) => ({ artifactId: `art_${i}`, name, sha256: SHA, caption: '' })),
  ...over,
});

describe('a video recipe', () => {
  it('reads the shape the person asked for', () => {
    expect(['Make it vertical', 'portrait please', '9:16', 'for Instagram reels', 'a story'].map(aspectFromText)).toEqual(['vertical', 'vertical', 'vertical', 'vertical', 'vertical']);
    expect(['square', '1:1'].map(aspectFromText)).toEqual(['square', 'square']);
    expect(['landscape', '16:9', 'widescreen'].map(aspectFromText)).toEqual(['landscape', 'landscape', 'landscape']);
    expect(aspectFromText('make it nicer')).toBeNull();
  });

  it('splits a total length over the pictures, within 1.5–10 s each', () => {
    expect(secondsForTotal(5, 3)).toBe(1.667);
    expect(secondsForTotal(4, 3)).toBeNull();
    expect(secondsForTotal(31, 3)).toBeNull();
    expect(recipeDuration(recipe())).toBe(5.001);
  });

  it('changes one thing at a time and says what changed', () => {
    const vertical = applyVideoChanges(recipe(), { aspect: 'vertical' });
    expect(vertical.ok && vertical.recipe).toMatchObject({ aspect: 'vertical', width: 1080, height: 1920, secondsPerScene: 1.667 });
    expect(vertical.ok && vertical.changes).toEqual(['Landscape 1920×1080 → Vertical 1080×1920']);
    const same = applyVideoChanges(recipe(), { aspect: 'landscape' });
    expect(same.ok === false && same.errors[0]).toMatch(/^that is already how the video is \(Landscape 1920×1080, 5\.001 s\)/);
    // Nothing named is not "already so": it says what can be changed.
    const none = applyVideoChanges(recipe(), {});
    expect(none.ok === false && none.errors[0]).toMatch(/^no change was named: give aspect/);
    expect(applyVideoChanges(recipe(), { aspect: 'diagonal' }).ok).toBe(false);
    const longer = applyVideoChanges(recipe(), { totalSeconds: 9 });
    expect(longer.ok && longer.recipe.secondsPerScene).toBe(3);
    expect(applyVideoChanges(recipe(), { captions: ['a', 'b'] }).ok).toBe(false);
  });

  it('accepts only a complete recipe whose pictures are named by id and digest', () => {
    expect(parseVideoRecipe(recipe()).ok).toBe(true);
    expect(parseVideoRecipe({ ...recipe(), scenes: [{ artifactId: 'art_1', name: 'x' }] }).ok).toBe(false);
    expect(parseVideoRecipe({ ...recipe(), secondsPerScene: 0.2 }).ok).toBe(false);
    expect(parseVideoRecipe({ ...recipe(), kind: 'generated' }).ok).toBe(false);
    // The size always follows the shape, whatever the stored numbers say.
    const odd = parseVideoRecipe({ ...recipe(), aspect: 'square', width: 7, height: 9 });
    expect(odd.ok && [odd.value.width, odd.value.height]).toEqual([1080, 1080]);
  });

  it('travels in the version metadata only as plain JSON under 16 KB', () => {
    const base = { type: 'video', workshopId: 'ws_1', op: { kind: 'render', summary: 's' }, engine: { tool: 't', provider: 'local', costUsd: 0 } };
    expect(sanitizeWorkshopMeta({ ...base, recipe: recipe() })?.recipe).toMatchObject({ aspect: 'landscape' });
    expect(sanitizeWorkshopMeta({ ...base, recipe: { big: 'x'.repeat(17_000) } })?.recipe).toBeUndefined();
    expect(sanitizeWorkshopMeta({ ...base, recipe: ['not', 'an', 'object'] })?.recipe).toBeUndefined();
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0 && spawnSync('ffprobe', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0;

function probe(file: string): { width: number; height: number; codec: string; duration: number } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout) as { streams: Array<{ width: number; height: number; codec_name: string }>; format: { duration: string } };
  return { width: j.streams[0].width, height: j.streams[0].height, codec: j.streams[0].codec_name, duration: Number(j.format.duration) };
}

describe.skipIf(!hasFfmpeg)('the Video workshop through the governed tools (real FFmpeg)', () => {
  let dir: string; let db: CoreDatabase; let conversationId: string; let pictures: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-video-ws-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
    const inputs = path.join(dir, 'inputs');
    fs.mkdirSync(inputs);
    pictures = ['0xC0392B', '0x27AE60', '0x2980B9'].map((color, i) => {
      const file = path.join(inputs, `picture-${i + 1}.png`);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=1200x800`, '-frames:v', '1', file]);
      expect(r.status).toBe(0);
      return file;
    });
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ctx = () => ({ cwd: dir, correlationId: conversationId, attemptId: 'att_test' });

  it('renders a five-second slideshow of three pictures, then "make it vertical" renders v2 from the same pictures', async () => {
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, commandTimeoutMs: 200 });
    const args = await adapter.prepare!('create_video', { images: pictures, totalSeconds: 5, title: 'Biryani promo' }, { correlationId: conversationId });
    expect((args.sources as unknown[]).length).toBe(3);
    const card = adapter.redactArguments!('create_video', args) as Record<string, unknown>;
    expect(card.sources).toMatch(/^3 picture\(s\): picture-1\.png \(\d+ KB\), picture-2\.png/);
    expect(card.sourcesSha256).toMatch(/^[0-9a-f]{64}$/);

    const created = await adapter.run({ name: 'create_video', arguments: args }, ctx());
    expect(created.status).toBe('succeeded');
    expect(created.output).toMatch(/^CREATED: version 1 of a new video: 1920×1080 h264, 5\.0\d s/);
    const [w] = listWorkshops(db, { conversationId });
    expect(w).toMatchObject({ type: 'video', title: 'Biryani promo' });
    const v1 = readWorkshopVersion(db, w.latestArtifactId);
    expect(v1.artifact.mimeType).toBe('video/mp4');
    const p1 = probe(v1.artifact.absolutePath);
    expect(p1).toMatchObject({ width: 1920, height: 1080, codec: 'h264' });
    expect(Math.abs(p1.duration - 5)).toBeLessThan(0.1);
    expect(v1.meta.verification?.checks.every((c) => c.startsWith('PASS'))).toBe(true);
    // Core's own copies of the pictures are artifacts, never workshops of their own.
    const sources = listArtifacts(db).filter((x) => x.source === 'workshop_source');
    expect(sources).toHaveLength(3);
    expect(listWorkshops(db, {}).map((x) => x.workshopId)).toEqual([w.workshopId]);

    recordWorkshopFocus(db, { conversationId, workshopId: w.workshopId, artifactId: w.latestArtifactId, open: true, actor: 'window' });
    const vertical = await adapter.run({ name: 'workshop_edit', arguments: { aspect: 'vertical', summary: 'Make it vertical' } }, ctx());
    expect(vertical.status).toBe('succeeded');
    expect(vertical.output).toMatch(/^CHANGED: Landscape 1920×1080 → Vertical 1080×1920\. Rendered again from the same 3 picture\(s\): 1080×1920, 5\.0\d s/);
    const after = listWorkshops(db, { conversationId })[0];
    expect(after.versions).toHaveLength(2);
    const v2 = readWorkshopVersion(db, after.latestArtifactId);
    const p2 = probe(v2.artifact.absolutePath);
    expect(p2).toMatchObject({ width: 1080, height: 1920, codec: 'h264' });
    expect(Math.abs(p2.duration - 5)).toBeLessThan(0.1);
    expect(v2.meta.parentArtifactId).toBe(v1.artifact.id);
    expect(readWorkshopVersion(db, v1.artifact.id).artifact.sha256).toBe(v1.artifact.sha256);

    // A copy that changed is refused, and nothing new is saved.
    fs.appendFileSync(sources[0].absolutePath, Buffer.from([0]));
    const tampered = await adapter.run({ name: 'workshop_edit', arguments: { aspect: 'square' } }, ctx());
    expect(tampered.status).toBe('failed');
    expect(tampered.output).toMatch(/changed; nothing was rendered/);
    expect(listWorkshops(db, { conversationId })[0].versions).toHaveLength(2);
  }, 120_000);

  it('refuses when a picture changed after the approval', async () => {
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, commandTimeoutMs: 200 });
    const args = await adapter.prepare!('create_video', { images: pictures, totalSeconds: 6 }, { correlationId: conversationId });
    fs.appendFileSync(pictures[1], Buffer.from([1, 2, 3]));
    const r = await adapter.run({ name: 'create_video', arguments: args }, ctx());
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/changed or disappeared after it was approved/);
    expect(listWorkshops(db, { conversationId })).toHaveLength(0);
  }, 60_000);

  it('says plainly when the length cannot work, and when there are no pictures', async () => {
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, commandTimeoutMs: 200 });
    const tooShort = await adapter.run({ name: 'create_video', arguments: { images: pictures, totalSeconds: 2 } }, ctx());
    expect(tooShort.output).toMatch(/3 picture\(s\) can make a video of 4\.5–30 s/);
    const none = await adapter.run({ name: 'create_video', arguments: { images: [path.join(dir, 'missing.png')] } }, ctx());
    expect(none.output).toMatch(/no pictures found/);
    expect(Object.keys(VIDEO_ASPECTS)).toEqual(['landscape', 'vertical', 'square']);
  });
});
