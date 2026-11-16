/**
 * The narrated-video adapter's own logic (timing, subtitles, backdrops, where it writes, what it refuses). The tools it
 * drives (Piper, FFmpeg, ComfyUI) are exercised for real in the acceptance run, not here.
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { backdropFilter, cueTexts, paletteFor, renderNarratedVideoResult, renderSrt, sceneCues, slugify, speakable, twoLines } from '../runtime/narratedVideo';
import { createMediaProductionAdapter, narratedOutputDir } from '../runtime/mediaProduction';
import { BUILTIN_AGENTS, chiefDelegationScope, deriveScope, isToolAllowed } from '../domain/agents';

describe('subtitles follow the narration', () => {
  it('breaks at punctuation into cues of at most two short lines', () => {
    const cues = cueTexts('Once upon a time, in a quiet green meadow, there lived a clever little rabbit named Pip. He loved puzzles.');
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const c of cues) expect(c.length).toBeLessThanOrEqual(76);
    expect(cues.join(' ')).toBe('Once upon a time, in a quiet green meadow, there lived a clever little rabbit named Pip. He loved puzzles.');
    expect(twoLines('there lived a clever little rabbit named Pip in the quiet meadow').split('\n')).toHaveLength(2);
    expect(twoLines('Short line.')).toBe('Short line.');
  });

  it('spreads the cues over the voice, inside the scene', () => {
    const cues = sceneCues('One evening, the stream was too wide to cross. Pip thought, and thought, and then he smiled.', 10.5, 6);
    expect(cues[0].start).toBeCloseTo(10.5, 5);
    expect(cues[cues.length - 1].end).toBeCloseTo(16.5, 5);
    for (let i = 1; i < cues.length; i += 1) expect(cues[i].start).toBeCloseTo(cues[i - 1].end, 5);
    const srt = renderSrt(cues);
    expect(srt).toMatch(/^1\n00:00:10,500 --> /);
    expect(srt.trim().split('\n\n')).toHaveLength(cues.length);
  });

  it('gives the voice plain sentences', () => {
    expect(speakable('**Pip** smiled 😀 and said: [hello](http://x) `ok`')).toBe('Pip smiled and said: hello ok');
    expect(slugify('The Clever Rabbit\'s Moonlit Adventure!')).toBe('the-clever-rabbit-s-moonlit-adventure');
    expect(slugify('***')).toBe('video');
  });
});

describe('drawn backdrop (when no image generator runs)', () => {
  it('picks a palette from the scene and builds one filter per channel', () => {
    expect(paletteFor('a rabbit sleeping under the moon')).toBe('night');
    expect(paletteFor('a meadow at sunset')).toBe('dusk');
    expect(paletteFor('a rabbit by a stream')).toBe('day');
    const f = backdropFilter('night sky', 1920, 1080, 1);
    expect(f.startsWith('format=rgb24,geq=r=')).toBe(true);
    expect(f.split(":g='")).toHaveLength(2);
    expect(f.split(":b='")).toHaveLength(2);
    expect(f).not.toMatch(/NaN|undefined/);
  });
});

describe('the media adapter', () => {
  const adapter = createMediaProductionAdapter({ outputRoot: path.join(os.tmpdir(), 'pandesh-video-out') });

  it('making media asks first; inspecting it does not', () => {
    expect(adapter.classify('media_produce_video')).toBe('consequential');
    expect(adapter.classify('media_create_video')).toBe('consequential');
    expect(adapter.classify('media_inspect')).toBe('read_only');
  });

  it('the approval shows what will happen, not just the tool name', async () => {
    const shown = await adapter.prepare!('media_produce_video', { title: 'Tides', scenes: [{ narration: 'The sea rises and falls twice a day.', visual: 'a beach' }, { narration: '', visual: 'empty' }] });
    expect(shown).toMatchObject({ sceneCount: 1, narrationWords: 8, published: 'nothing is uploaded or published' });
    expect(String(shown.pictures)).toMatch(/started if it is not running/);
  });

  it('writes into the task\'s own folder when it has one, never over an existing folder', () => {
    const own = narratedOutputDir('Tides', path.join(os.tmpdir(), 'some-mission'), 'X:\\elsewhere');
    expect(own.startsWith(path.join(os.tmpdir(), 'some-mission'))).toBe(true);
    const fallback = narratedOutputDir('Tides', process.cwd(), path.join(os.tmpdir(), 'pandesh-video-out'));
    expect(fallback.startsWith(path.join(os.tmpdir(), 'pandesh-video-out'))).toBe(true);
    expect(path.basename(fallback)).toMatch(/^tides-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/);
  });

  it('refuses a call with no narration and a file that is not there', async () => {
    const none = await adapter.run({ id: '1', name: 'media_produce_video', arguments: { title: 'x', scenes: [] } }, { cwd: process.cwd() });
    expect(none).toMatchObject({ status: 'failed', resultCategory: 'media_no_inputs' });
    const missing = await adapter.run({ id: '2', name: 'media_inspect', arguments: { path: path.join(os.tmpdir(), 'no-such-file.mp4') } }, { cwd: process.cwd() });
    expect(missing).toMatchObject({ status: 'failed', resultCategory: 'media_no_inputs' });
  });
});

describe('a technical check is not a look at the content', () => {
  const scenes = [1, 2, 3].map((n) => ({ index: n, narration: 'x', visual: 'y', seconds: 5, narrationFile: `D:\\x\\assets\\narration-0${n}.wav`, imageFile: `D:\\x\\assets\\scene-0${n}.png`, imageSource: 'comfyui' as const }));
  const base = { folder: 'D:\\x', video: 'D:\\x\\a.mp4', subtitles: null, thumbnail: 't', script: 's', metadata: 'm', record: 'r', durationSec: 68, width: 1920, height: 1080, bytes: 1e6, sha256: 'a'.repeat(64), scenes, voice: 'Piper', music: null, visualsBy: { comfyui: 3, backdrop_card: 0, checkpoint: 'x', note: '' }, steps: [], verified: true, verification: ['PASS length'], withinTarget: true };
  it('the production result names every picture nobody has looked at, and what is missing, at the very start', () => {
    const text = renderNarratedVideoResult({ ...base, incomplete: ['the upload sheet has no description', 'the upload sheet has no tags'] });
    const lines = text.split('\n');
    expect(lines[0]).toBe('NOT VERIFIED: what the pictures show (3 pictures: scene-01.png, scene-02.png, scene-03.png)');
    expect(lines[1]).toBe('INCOMPLETE: the upload sheet has no description');
    expect(lines[2]).toBe('INCOMPLETE: the upload sheet has no tags');
    expect(renderNarratedVideoResult({ ...base, incomplete: [] })).not.toMatch(/INCOMPLETE/);
    // Core keeps only the start of a result as evidence: sixteen pictures must still fit before the cut.
    const many = Array.from({ length: 16 }, (_, i) => ({ ...scenes[0], imageFile: `D:\\x\\assets\\scene-${String(i + 1).padStart(2, '0')}.png` }));
    expect(renderNarratedVideoResult({ ...base, scenes: many, incomplete: [] }).split('\n')[0].length).toBeLessThan(330);
  });
});

describe('who may use it', () => {
  const scope = (id: string) => deriveScope(BUILTIN_AGENTS.find((a) => a.id === id)!, 'D:\\work', chiefDelegationScope('D:\\work'));
  it('Studio produces and inspects; the Reviewer only inspects; neither goes online', () => {
    expect(isToolAllowed(scope('studio'), 'media_produce_video').allowed).toBe(true);
    expect(isToolAllowed(scope('studio'), 'media_inspect').allowed).toBe(true);
    expect(isToolAllowed(scope('reviewer'), 'media_inspect').allowed).toBe(true);
    expect(isToolAllowed(scope('reviewer'), 'media_produce_video').allowed).toBe(false);
    expect(isToolAllowed(scope('reviewer'), 'write_file').allowed).toBe(false);
    expect(isToolAllowed(scope('reviewer'), 'system_kill_process').allowed).toBe(false);
    expect(BUILTIN_AGENTS.find((a) => a.id === 'studio')!.egress).toBe('none');
    expect(isToolAllowed(scope('studio'), 'web_research').allowed).toBe(false);
  });
});
