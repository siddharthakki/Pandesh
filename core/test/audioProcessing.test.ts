import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeLocalAudioTranscriptionCapability, runLocalTranscription } from '../attachments/audioProcessing';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_SPEECH_FIXTURE = path.join(__dirname, 'fixtures', 'audio', 'quarterly-report-speech.wav');

describe('local audio transcription capability probe', () => {
  it('reports the bundled whisper-base.en engine as available when its model files are present', () => {
    // Uses the real, actually-fetched model directory (no override) — this
    // is the same check the packaged runtime performs.
    const probe = probeLocalAudioTranscriptionCapability({ ...process.env });
    expect(probe.capability).toBe('available');
    expect(probe.engine).toContain('whisper-base.en');
  });

  it('honestly reports unavailable_no_local_engine when the model directory is absent and no external command is configured', () => {
    const probe = probeLocalAudioTranscriptionCapability({
      KARKEDIKHA_ASR_MODEL_DIR: path.join(__dirname, 'fixtures', 'nonexistent-model-dir'),
    });
    expect(probe.capability).toBe('unavailable_no_local_engine');
    expect(probe.engine).toBeNull();
  });

  it('falls back to an external command when the bundled model is absent but KARKEDIKHA_LOCAL_ASR_COMMAND is configured', () => {
    const probe = probeLocalAudioTranscriptionCapability({
      KARKEDIKHA_ASR_MODEL_DIR: path.join(__dirname, 'fixtures', 'nonexistent-model-dir'),
      KARKEDIKHA_LOCAL_ASR_COMMAND: 'some-external-whisper-wrapper',
    });
    expect(probe.capability).toBe('available');
    expect(probe.engine).toBe('some-external-whisper-wrapper');
  });

  it('prefers an explicitly configured external ASR command over the bundled Whisper fallback', () => {
    const probe = probeLocalAudioTranscriptionCapability({
      ...process.env,
      KARKEDIKHA_LOCAL_ASR_COMMAND: 'native-faster-whisper-wrapper',
    });
    expect(probe.capability).toBe('available');
    expect(probe.engine).toBe('native-faster-whisper-wrapper');
  });
});

describe('real local transcription (whisper-base.en via @xenova/transformers)', () => {
  it('transcribes a real speech WAV fixture with plausible word-accurate text and timestamped segments', async () => {
    const probe = probeLocalAudioTranscriptionCapability({ ...process.env });
    expect(probe.capability).toBe('available');
    expect(probe.engine).not.toBeNull();

    const result = await runLocalTranscription(probe.engine!, REAL_SPEECH_FIXTURE);
    expect(result.engine).toContain('whisper-base.en');
    expect(result.segments.length).toBeGreaterThan(0);

    const fullText = result.segments.map((s) => s.text).join(' ').toLowerCase();
    expect(fullText).toContain('quarterly report');
    expect(fullText).toContain('steady growth');

    for (const segment of result.segments) {
      expect(segment.startSeconds).toBeGreaterThanOrEqual(0);
      expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
      expect(segment.text.length).toBeGreaterThan(0);
    }
    // Segment ordinals are stable, source-order, zero-based.
    result.segments.forEach((segment, index) => expect(segment.segmentOrdinal).toBe(index));
  }, 60_000);

  it('fails closed (never fabricates a transcript) for a WAV file it cannot decode', async () => {
    const probe = probeLocalAudioTranscriptionCapability({ ...process.env });
    const badWav = path.join(__dirname, 'fixtures', 'audio', 'not-really-a-wav.wav');
    const fs = await import('node:fs');
    fs.writeFileSync(badWav, Buffer.from('this is not a wav file'));
    try {
      await expect(runLocalTranscription(probe.engine!, badWav)).rejects.toThrow();
    } finally {
      fs.unlinkSync(badWav);
    }
  }, 30_000);
});
