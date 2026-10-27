import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  finalizeStreamedWav,
  PocketTtsCancelled,
  PocketTtsEngine,
  probePocketTts,
} from '../src/host/pocketTts';
import { probeDesktopLocalSpeechResponse } from '../src/host/desktopLocalSpeechResponse';

const fake = path.join(__dirname, 'fixtures', 'fakePocketTts.cjs');
const engines: PocketTtsEngine[] = [];

function makeEngine(extra: string[] = []): PocketTtsEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-tts-test-'));
  fs.mkdirSync(path.join(dir, 'data', 'pocket-tts'), { recursive: true });
  const engine = new PocketTtsEngine({
    productRoot: dir,
    dataDir: path.join(dir, 'data'),
    startTimeoutMs: 10_000,
    exeOverride: { exe: process.execPath, args: (port) => [fake, String(port), path.join(dir, 'crash.marker'), ...extra] },
  });
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('Pocket TTS engine', () => {
  it('streams a WAV and rewrites placeholder sizes', async () => {
    const engine = makeEngine();
    const r = await engine.synthesize('Hello there');
    expect(r.wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(r.wav.readUInt32LE(40)).toBe(r.wav.length - 44);
    expect(r.wav.readUInt32LE(4)).toBe(r.wav.length - 8);
    expect(r.wav.readUInt32LE(24)).toBe(24000);
    expect(r.firstAudioMs).toBeGreaterThanOrEqual(0);
  });

  it('starts on demand once and reuses the warm engine', async () => {
    const engine = makeEngine();
    expect(engine.running).toBe(false);
    const first = await engine.synthesize('one');
    const second = await engine.synthesize('two');
    expect(engine.starts).toBe(1);
    expect(first.startMs).toBeGreaterThan(0);
    expect(second.startMs).toBeLessThan(first.startMs);
  });

  it('a newer request cancels the one in flight and speech stays sequential', async () => {
    const engine = makeEngine();
    await engine.synthesize('warm up');
    const outcome = engine.synthesize('SLOW sentence').then(() => 'done', (e) => e);
    await new Promise((r) => setTimeout(r, 120));
    const next = await engine.synthesize('quick');
    expect(await outcome).toBeInstanceOf(PocketTtsCancelled);
    expect(next.wav.length).toBeGreaterThan(44);
  });

  it('cancel() rejects the in-flight request without stopping the engine', async () => {
    const engine = makeEngine();
    const outcome = engine.synthesize('SLOW sentence').then(() => 'done', (e) => e);
    await new Promise((r) => setTimeout(r, 400));
    engine.cancel();
    expect(await outcome).toBeInstanceOf(PocketTtsCancelled);
    expect(engine.running).toBe(true);
    expect((await engine.synthesize('after')).wav.length).toBeGreaterThan(44);
  });

  it('recovers from an engine crash mid-request by restarting once', async () => {
    const engine = makeEngine();
    await engine.synthesize('warm');
    const pid = engine.pid!;
    const r = await engine.synthesize('CRASH now');
    expect(r.wav.length).toBeGreaterThan(44);
    expect(engine.starts).toBe(2);
    expect(engine.pid).not.toBe(pid);
  });

  it('reports a startup failure with the engine output', async () => {
    const engine = makeEngine(['fail-start']);
    await expect(engine.synthesize('hi')).rejects.toThrow(/exited during startup.*cannot load model/);
    expect(engine.running).toBe(false);
  });

  it('dispose kills the engine process', async () => {
    const engine = makeEngine();
    await engine.synthesize('hi');
    const pid = engine.pid!;
    await engine.dispose();
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(false);
    await expect(engine.synthesize('again')).rejects.toBeInstanceOf(PocketTtsCancelled);
  });
});

describe('Pocket TTS provisioning', () => {
  it('rejects non-WAV payloads', () => {
    expect(() => finalizeStreamedWav(Buffer.from('not a wav'))).toThrow(/not a WAV/);
  });

  it('is not ready when unstaged and falls back to the Piper status', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-none-'));
    const probe = probePocketTts(empty);
    expect(probe.ready).toBe(false);
    expect(probe.blocker).toMatch(/fetch-pocket-tts/);
    const status = probeDesktopLocalSpeechResponse(empty, {}, 'pocket');
    expect(status.engine).toBeNull();
    expect(status.blocker).toMatch(/Piper/);
  });

  it('reports pocket available when a staged tree matches the manifest sizes', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    if (!probePocketTts(repoRoot).ready) return; // dev machine without staged assets
    const status = probeDesktopLocalSpeechResponse(repoRoot, {}, 'pocket');
    expect(status.engine).toBe('pocket-tts (CPU)');
    expect(status.voices).toEqual(['charles']);
  });
});
