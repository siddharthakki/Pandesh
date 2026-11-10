/**
 * Phase 2g — voice in v2, reusing the existing local stack: the classic
 * renderer's capture module (`renderer/voiceCapture.js`, loaded before the
 * bundle), the host's local Whisper transcription (`transcribeUtterance`) and
 * local TTS (`speakText` / `stopSpeaking` / `markPlaybackFinished`). No cloud
 * speech, no new dependency.
 */
import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './bridge';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'interrupted' | 'error';

interface CaptureSession { done: Promise<Uint8Array | ArrayBuffer | null>; stop: () => Promise<unknown> }
interface CaptureModule { startVadUtteranceCapture(opts?: { onState?: (s: string) => void }): CaptureSession; bytesToBase64(b: Uint8Array): string }
interface VoiceApi {
  transcribeUtterance(wavBase64: string, voiceTurnId?: string): Promise<{ transcript: string; engine: string; review?: { required: boolean; reasons: string[] } }>;
  speakText(text: string): Promise<{ wavBase64: string; engine: string; cancelled?: boolean }>;
  stopSpeaking(): Promise<unknown>;
  markPlaybackFinished(): Promise<unknown>;
  setVoiceMode(enabled: boolean): Promise<unknown>;
}

const capture = (): CaptureModule | null => (window as unknown as { jarvisVoiceCapture?: CaptureModule }).jarvisVoiceCapture ?? null;
const vapi = api as unknown as VoiceApi;

/** One id per spoken turn: the host logs it with each voice stage and tells Core the message was spoken. */
export function newVoiceTurnId(): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 8); } catch { /* fall through */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function useVoice(opts: { onTranscript: (text: string, needsReview: boolean, reasons: string[], voiceTurnId: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle');
  const [detail, setDetail] = useState('');
  const [heard, setHeard] = useState(false);
  const session = useRef<CaptureSession | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  /** Bumped by Stop listening / Type instead: whatever that capture recorded is discarded, never transcribed or sent. */
  const listenGen = useRef(0);

  useEffect(() => () => { void session.current?.stop(); audio.current?.pause(); }, []);

  const listen = async () => {
    const mod = capture();
    if (!mod) { setState('error'); setDetail('The microphone helper did not load.'); return; }
    stopPlayback(false);
    const mine = ++listenGen.current;
    setHeard(false); setDetail(''); setState('listening');
    try {
      session.current = mod.startVadUtteranceCapture({ onState: (s) => { if (s === 'speech_started') setHeard(true); if (s === 'end_of_speech') setState('transcribing'); } });
      const wav = await session.current.done;
      session.current = null;
      if (mine !== listenGen.current) return; // stopped by the user: discard
      const bytes = wav instanceof Uint8Array ? wav : wav ? new Uint8Array(wav) : null;
      if (!bytes || bytes.length < 44) { setState('idle'); setDetail('No speech was captured.'); return; }
      setState('transcribing');
      const turnId = newVoiceTurnId();
      const r = await vapi.transcribeUtterance(mod.bytesToBase64(bytes), turnId);
      if (mine !== listenGen.current) return;
      setState('idle');
      const text = r.transcript.trim();
      if (!text) { setDetail('Nothing was recognised. Try again or type.'); return; }
      opts.onTranscript(text, Boolean(r.review?.required), r.review?.reasons ?? [], turnId);
    } catch (err) {
      session.current = null;
      if (mine !== listenGen.current) return;
      setState('error'); setDetail(errorText(err));
    }
  };

  const stopListening = async () => { listenGen.current++; const s = session.current; session.current = null; setState('idle'); setDetail('Stopped listening. Nothing was sent.'); if (s) await s.stop().catch(() => undefined); };

  const speak = async (text: string) => {
    const gen = ++generation.current;
    try {
      setState('speaking'); setDetail('');
      const r = await vapi.speakText(text);
      if (gen !== generation.current || r.cancelled) return;
      const bytes = Uint8Array.from(atob(r.wavBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const el = new Audio(url);
      audio.current = el;
      el.onended = () => { if (gen === generation.current) { setState('idle'); audio.current = null; void vapi.markPlaybackFinished().catch(() => undefined); } URL.revokeObjectURL(url); };
      await el.play();
    } catch (err) {
      if (gen === generation.current) { setState('error'); setDetail(`Could not speak: ${errorText(err)}`); }
    }
  };

  const stopPlayback = (markInterrupted = true) => {
    const wasSpeaking = state === 'speaking' || Boolean(audio.current);
    generation.current++;
    audio.current?.pause(); audio.current = null;
    if (wasSpeaking) { void vapi.stopSpeaking().catch(() => undefined); void vapi.markPlaybackFinished().catch(() => undefined); }
    if (markInterrupted && wasSpeaking) setState('interrupted');
  };

  return { state, detail, heard, listen, stopListening, speak, stopSpeaking: () => stopPlayback(true), clear: () => { setState('idle'); setDetail(''); }, setVoiceMode: (on: boolean) => vapi.setVoiceMode(on) };
}
