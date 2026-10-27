import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';
import { findBundledPiper } from '../src/host/desktopLocalSpeechResponse';
import { probePocketTts } from '../src/host/pocketTts';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const havePiper = Boolean(findBundledPiper(repoRoot));
const havePocket = probePocketTts(repoRoot).ready;

interface Internals { pocketTts: unknown }

let host: DesktopSession;
let dataDir: string;

beforeEach(() => {
  vi.stubEnv('PANDESH_TTS_ENGINE', 'pocket');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-session-'));
  host = new DesktopSession({ productRoot: repoRoot, dataDir });
});

afterEach(() => {
  host.dispose();
  vi.unstubAllEnvs();
});

describe('speakText with Pocket TTS selected', () => {
  it.runIf(havePocket)('speaks through the real managed engine', async () => {
    const result = await host.speakText('Hello from Pandesh.');
    expect(result.engine).toBe('pocket-tts (CPU)');
    const wav = Buffer.from(result.wavBase64, 'base64');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  }, 60_000);

  it.runIf(havePiper)('falls back to Piper when Pocket fails, then skips Pocket during the cooldown', async () => {
    const synthesize = vi.fn().mockRejectedValue(new Error('boom'));
    (host as unknown as Internals).pocketTts = { synthesize, cancel: () => undefined, dispose: async () => undefined };
    const first = await host.speakText('Fallback please.');
    expect(first.engine).toMatch(/piper/);
    await host.speakText('Again.');
    expect(synthesize).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('returns a cancelled result when Stop supersedes synthesis', async () => {
    let release: (v: unknown) => void = () => undefined;
    const synthesize = vi.fn().mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    (host as unknown as Internals).pocketTts = { synthesize, cancel: () => undefined, dispose: async () => undefined };
    const pending = host.speakText('Long answer');
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalled());
    host.stopSpeaking('button');
    release({ wav: Buffer.alloc(100), startMs: 0, firstAudioMs: 0, totalMs: 0 });
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.wavBase64).toBe('');
  });
});
