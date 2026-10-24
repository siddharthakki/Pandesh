import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PIPER_TTS_FEASIBILITY,
  probeDesktopLocalSpeechResponse,
} from '../src/host/desktopLocalSpeechResponse';
import { probeDesktopWakeWord } from '../src/host/desktopWakeWord';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('Piper TTS probe', () => {
  it('reports unavailable with staging instructions when Piper is not present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-no-piper-'));
    const status = probeDesktopLocalSpeechResponse(empty, {});
    expect(status.capability).toBe('unavailable_no_local_engine');
    expect(status.engine).toBeNull();
    expect(status.blocker).toMatch(/fetch-piper/i);
    expect(PIPER_TTS_FEASIBILITY.decision).toBe('intentional_voice_dependency');
  });

  it('reports available only when a local TTS override command is configured', () => {
    const status = probeDesktopLocalSpeechResponse(repoRoot, {
      KARKEDIKHA_LOCAL_TTS_COMMAND: 'C:\\Tools\\local-tts.cmd',
    });
    expect(status.capability).toBe('available');
    expect(status.engine).toBe('C:\\Tools\\local-tts.cmd');
    expect(status.blocker).toBe('');
  });

  it('reports available when a staged piper.exe and onnx voice exist under productRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-piper-'));
    const voices = path.join(root, 'runtime', 'piper', 'voices');
    fs.mkdirSync(voices, { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime', 'piper', 'piper.exe'), 'fake');
    fs.writeFileSync(path.join(voices, 'en_US-test.onnx'), 'fake');
    const status = probeDesktopLocalSpeechResponse(root, {});
    expect(status.capability).toBe('available');
    expect(status.engine).toMatch(/piper/i);
    expect(status.voices).toEqual(['en_US-test.onnx']);
    expect(status.blocker).toBe('');
  });
});

describe('openWakeWord probe', () => {
  it('reports available when hey_jarvis models are staged in the repo', () => {
    const status = probeDesktopWakeWord(repoRoot);
    if (fs.existsSync(path.join(repoRoot, 'models', 'openwakeword', 'hey_jarvis_v0.1.onnx'))) {
      expect(status.capability).toBe('available');
      expect(status.phrase).toMatch(/Hey Jarvis/i);
      expect(status.enabled).toBe(false);
    } else {
      expect(status.capability).toBe('unavailable_no_local_engine');
      expect(status.blocker).toMatch(/fetch-openwakeword/i);
    }
  });

  it('reports unavailable when models are missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-no-oww-'));
    const status = probeDesktopWakeWord(empty);
    expect(status.capability).toBe('unavailable_no_local_engine');
    expect(status.blocker).toMatch(/openWakeWord|fetch-openwakeword/i);
  });
});
