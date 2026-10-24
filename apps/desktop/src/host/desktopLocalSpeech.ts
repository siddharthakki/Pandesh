import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  probeLocalAudioTranscriptionCapability,
  runLocalTranscription,
  type AudioCapabilityProbe,
} from '../../../../core/attachments/audioProcessing';
import type { LocalProcessingCapability } from '../../../../core/shared/wireTypes';
import { voiceTranscriptReview, type VoiceTranscriptReview } from './voiceTranscript';

export interface DesktopLocalSpeechStatus {
  capability: LocalProcessingCapability;
  engine: string | null;
  /** Empty when speech is ready; otherwise the exact operator-facing blocker. */
  blocker: string;
}

export function buildDesktopAsrEnv(productRoot: string): NodeJS.ProcessEnv {
  const modelDir = path.join(productRoot, 'models', 'whisper-base-en');
  return {
    ...process.env,
    KARKEDIKHA_ASR_MODEL_DIR: modelDir,
  };
}

function externalAsrCommandConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KARKEDIKHA_LOCAL_ASR_COMMAND?.trim());
}

/**
 * Whisper hallucinates bracketed/parenthesized non-speech captions —
 * [MUSIC], (music), [BLANK_AUDIO], [Applause], [Silence] — when fed silence
 * or low-energy ambient noise, an artifact of its caption-heavy training
 * data. Strip them so a quiet room doesn't get submitted as a real task.
 */
const NON_SPEECH_HALLUCINATION_RE = /[([][^\])]*\b(music|blank[_ ]?audio|silence|applause|noise|inaudible|no speech)\b[^\])]*[)\]]/gi;

export function stripNonSpeechHallucinations(text: string): string {
  return text.replace(NON_SPEECH_HALLUCINATION_RE, '').trim();
}

function asrRuntimeResolvable(productRoot: string): boolean {
  const candidates = [
    path.join(productRoot, 'runtime-assets', 'node_modules', '@xenova', 'transformers', 'package.json'),
    path.join(productRoot, 'node_modules', '@xenova', 'transformers', 'package.json'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function describeSpeechBlocker(
  probe: AudioCapabilityProbe,
  productRoot: string,
  runtimePresent: boolean,
): string {
  if (probe.capability === 'available') {
    if (externalAsrCommandConfigured()) return '';
    if (!runtimePresent) {
      return [
        'Local Whisper model files are present but the @xenova/transformers WASM runtime is missing.',
        `Expected runtime-assets under ${path.join(productRoot, 'runtime-assets', 'node_modules')}`,
        'or a dev install at repo node_modules. Run scripts/stage-asr-runtime-assets.mjs before packaging.',
      ].join(' ');
    }
    return '';
  }
  if (probe.capability === 'unavailable_no_local_engine') {
    const command = process.env.KARKEDIKHA_LOCAL_ASR_COMMAND?.trim();
    if (command) {
      return `Configured KARKEDIKHA_LOCAL_ASR_COMMAND=${command} but the command is not reachable from this host.`;
    }
    return [
      'Bundled whisper-base.en model files are missing.',
      `Expected under ${path.join(productRoot, 'models', 'whisper-base-en', 'Xenova', 'whisper-base.en')}.`,
      'Run scripts/fetch-whisper-model.mjs from the repository root.',
    ].join(' ');
  }
  return `Local speech recognition unavailable (${probe.capability}).`;
}

/** Host probe only — microphone permission is decided in the renderer on explicit press. */
export function probeDesktopLocalSpeech(productRoot: string): DesktopLocalSpeechStatus {
  const env = buildDesktopAsrEnv(productRoot);
  const probe = probeLocalAudioTranscriptionCapability(env);
  const runtimePresent = asrRuntimeResolvable(productRoot) || externalAsrCommandConfigured(env);
  let capability = probe.capability;
  if (capability === 'available' && !runtimePresent) {
    capability = 'unavailable_no_local_engine';
  }
  const blocker = describeSpeechBlocker(probe, productRoot, runtimePresent);
  return {
    capability,
    engine: capability === 'available' ? probe.engine : null,
    blocker,
  };
}

export async function transcribeDesktopUtterance(
  productRoot: string,
  wavBytes: Buffer,
): Promise<{ transcript: string; engine: string; review: VoiceTranscriptReview }> {
  const env = buildDesktopAsrEnv(productRoot);
  const probe = probeLocalAudioTranscriptionCapability(env);
  const runtimePresent = asrRuntimeResolvable(productRoot) || externalAsrCommandConfigured(env);
  if (probe.capability !== 'available' || !probe.engine || !runtimePresent) {
    throw new Error(describeSpeechBlocker(probe, productRoot, runtimePresent) || 'local speech recognition unavailable');
  }
  const tmp = path.join(os.tmpdir(), `jarvis-voice-${process.pid}-${Date.now()}.wav`);
  await fs.promises.writeFile(tmp, wavBytes);
  try {
    const result = await runLocalTranscription(probe.engine, tmp, env);
    const raw = result.segments.map((segment) => segment.text).join(' ').trim();
    const review = voiceTranscriptReview(stripNonSpeechHallucinations(raw));
    return { transcript: review.text, engine: result.engine, review };
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}
