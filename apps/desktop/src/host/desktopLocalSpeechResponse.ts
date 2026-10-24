/**
 * Piper TTS for Jarvis Desktop speech responses.
 * Stages under productRoot/runtime/piper/ via scripts/fetch-piper.mjs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { LocalProcessingCapability } from '../../../../core/shared/wireTypes';

export interface DesktopLocalSpeechResponseStatus {
  capability: LocalProcessingCapability;
  engine: string | null;
  /** Empty when local TTS is ready; otherwise the exact operator-facing blocker. */
  blocker: string;
  voices: string[];
}

const PIPER_BUNDLE_BLOCKER = [
  'Piper TTS is not staged in this Desktop build.',
  'Run: node scripts/fetch-piper.mjs',
  'Expected runtime/piper/piper.exe and runtime/piper/voices/*.onnx.',
  'Optional override: KARKEDIKHA_LOCAL_TTS_COMMAND (argv: textFile wavOut).',
].join(' ');

export function findBundledPiper(productRoot: string): { exe: string; model: string } | null {
  const exe = path.join(productRoot, 'runtime', 'piper', 'piper.exe');
  if (!fs.existsSync(exe)) return null;
  const voicesDir = path.join(productRoot, 'runtime', 'piper', 'voices');
  if (!fs.existsSync(voicesDir)) return null;
  const models = fs.readdirSync(voicesDir).filter((name) => name.endsWith('.onnx'));
  if (models.length === 0) return null;
  return { exe, model: path.join(voicesDir, models[0]) };
}

/** Host probe — does not synthesize. */
export function probeDesktopLocalSpeechResponse(
  productRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopLocalSpeechResponseStatus {
  const override = env.KARKEDIKHA_LOCAL_TTS_COMMAND?.trim();
  if (override) {
    return {
      capability: 'available',
      engine: override,
      blocker: '',
      voices: [],
    };
  }

  const bundled = findBundledPiper(productRoot);
  if (bundled) {
    return {
      capability: 'available',
      engine: `piper (${path.basename(bundled.exe)})`,
      blocker: '',
      voices: [path.basename(bundled.model)],
    };
  }

  return {
    capability: 'unavailable_no_local_engine',
    engine: null,
    blocker: PIPER_BUNDLE_BLOCKER,
    voices: [],
  };
}

/**
 * Synthesize text to a mono WAV file. Returns absolute path to the WAV.
 */
export function synthesizeDesktopSpeech(
  productRoot: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): { wavPath: string; engine: string } {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('speech text is required');

  const outDir = path.join(os.tmpdir(), 'karkedikha-tts');
  fs.mkdirSync(outDir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const textPath = path.join(outDir, `${id}.txt`);
  const wavPath = path.join(outDir, `${id}.wav`);
  fs.writeFileSync(textPath, trimmed, 'utf8');

  const override = env.KARKEDIKHA_LOCAL_TTS_COMMAND?.trim();
  if (override) {
    const result = spawnSync(override, [textPath, wavPath], {
      stdio: 'pipe',
      windowsHide: true,
      env,
      shell: process.platform === 'win32',
    });
    if (result.status !== 0 || !fs.existsSync(wavPath)) {
      throw new Error(`TTS override failed: ${result.stderr?.toString() || `exit ${result.status}`}`);
    }
    return { wavPath, engine: override };
  }

  const bundled = findBundledPiper(productRoot);
  if (!bundled) throw new Error(PIPER_BUNDLE_BLOCKER);

  const result = spawnSync(bundled.exe, [
    '--model', bundled.model,
    '--output_file', wavPath,
  ], {
    input: trimmed,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: path.dirname(bundled.exe),
    env: {
      ...env,
      ESPEAK_DATA_PATH: path.join(path.dirname(bundled.exe), 'espeak-ng-data'),
    },
  });
  if (result.status !== 0 || !fs.existsSync(wavPath)) {
    throw new Error(`Piper failed: ${result.stderr?.toString() || result.stdout?.toString() || `exit ${result.status}`}`);
  }
  return { wavPath, engine: `piper (${path.basename(bundled.model)})` };
}

export const PIPER_TTS_FEASIBILITY = {
  windowsBinaryZipMb: 21.4,
  typicalEnUsVoiceOnnxMb: 60,
  decision: 'intentional_voice_dependency',
  blocker: PIPER_BUNDLE_BLOCKER,
} as const;
