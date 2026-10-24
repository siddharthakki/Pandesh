import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { probeDesktopLocalSpeech, stripNonSpeechHallucinations, transcribeDesktopUtterance } from '../src/host/desktopLocalSpeech';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const originalExternalAsr = process.env.KARKEDIKHA_LOCAL_ASR_COMMAND;

afterEach(() => {
  if (originalExternalAsr == null) delete process.env.KARKEDIKHA_LOCAL_ASR_COMMAND;
  else process.env.KARKEDIKHA_LOCAL_ASR_COMMAND = originalExternalAsr;
});

describe('stripNonSpeechHallucinations', () => {
  it('strips Whisper non-speech captions hallucinated on silence/ambient noise', () => {
    expect(stripNonSpeechHallucinations('[MUSIC]')).toBe('');
    expect(stripNonSpeechHallucinations('[Music]')).toBe('');
    expect(stripNonSpeechHallucinations('(music)')).toBe('');
    expect(stripNonSpeechHallucinations('[BLANK_AUDIO]')).toBe('');
    expect(stripNonSpeechHallucinations('[Applause]')).toBe('');
    expect(stripNonSpeechHallucinations('[Silence]')).toBe('');
  });

  it('leaves real speech untouched, including speech that mentions music', () => {
    expect(stripNonSpeechHallucinations('Hey Jarvis, what is the weather today?'))
      .toBe('Hey Jarvis, what is the weather today?');
    expect(stripNonSpeechHallucinations('play some music')).toBe('play some music');
  });

  it('strips a hallucinated tag while keeping real speech around it', () => {
    expect(stripNonSpeechHallucinations('Hey Jarvis [MUSIC] what time is it')).toBe('Hey Jarvis  what time is it');
  });
});

describe('desktop local speech host probe', () => {
  it('reports availability when whisper model and runtime exist in the dev tree', () => {
    const status = probeDesktopLocalSpeech(repoRoot);
    if (status.capability === 'available') {
      expect(status.engine).toMatch(/whisper/i);
      expect(status.blocker).toBe('');
    } else {
      expect(status.blocker.length).toBeGreaterThan(20);
      expect(status.blocker).toMatch(/whisper|transformers|ASR|model/i);
    }
  });

  it('reports unavailable with a concrete blocker when the model directory is missing', () => {
    const status = probeDesktopLocalSpeech(path.join(repoRoot, '.tmp', 'no-whisper-here'));
    expect(status.capability).toBe('unavailable_no_local_engine');
    expect(status.engine).toBeNull();
    expect(status.blocker).toMatch(/whisper-base.en model files are missing/i);
  });

  it('allows an explicitly configured native ASR command without requiring the bundled WASM runtime', () => {
    process.env.KARKEDIKHA_LOCAL_ASR_COMMAND = 'native-faster-whisper-wrapper';
    const status = probeDesktopLocalSpeech(path.join(repoRoot, '.tmp', 'native-asr-only'));
    expect(status.capability).toBe('available');
    expect(status.engine).toBe('native-faster-whisper-wrapper');
    expect(status.blocker).toBe('');
  });

  it('transcribes the Core speech fixture locally when the host ASR stack is present', async () => {
    const status = probeDesktopLocalSpeech(repoRoot);
    if (status.capability !== 'available') {
      expect(status.blocker.length).toBeGreaterThan(10);
      return;
    }
    const fixture = path.join(repoRoot, 'core', 'test', 'fixtures', 'audio', 'quarterly-report-speech.wav');
    const bytes = await fs.readFile(fixture);
    const { transcript, engine } = await transcribeDesktopUtterance(repoRoot, bytes);
    expect(engine).toMatch(/whisper/i);
    expect(transcript.toLowerCase()).toMatch(/quarterly/);
  }, 180_000);
});
