/**
 * The wake word in v2. The host detects the phrase (openWakeWord in a Node child); this page opens the microphone
 * with the shared capture module (`renderer/voiceCapture.js` → `startWakeMonitor`), streams its 16 kHz frames to the
 * host (`pushWakeAudio`) and, when the host answers with a `wake_detected` voice event, hands over to an ordinary
 * voice turn. Same rules the retired Classic renderer had (ensureWakeMonitor / stopWakeMonitor /
 * syncWakeMonitorFromSnapshot): the wake microphone is open only while the host says the wake word is on and not
 * muted, nothing is being spoken, no task runs and no voice turn is in progress.
 *
 * The status never says "Listening" unless frames are reaching the detector.
 */
import { useEffect, useRef, useState } from 'react';
import { api, errorText, type Snapshot, type VoiceEvent, type WakeWordStatus } from './bridge';

interface WakeFrameMeta { rms?: number; sampleRate?: number; contextSampleRate?: number; framesEmitted?: number }
interface WakeMonitorHandle { stop(): void }
interface WakeCaptureModule {
  startWakeMonitor(opts: {
    onFrame?: (pcm: Int16Array, meta: WakeFrameMeta) => void;
    onReady?: (info: { sampleRate: number; trackLabel?: string }) => void;
    onError?: (err: Error) => void;
  }): WakeMonitorHandle;
  bytesToBase64(bytes: Uint8Array): string;
}

const capture = (): WakeCaptureModule | null => (window as unknown as { jarvisVoiceCapture?: WakeCaptureModule }).jarvisVoiceCapture ?? null;

/** Wait before reopening the wake microphone, so a send that is about to show a running task does not flicker it. */
export const WAKE_REARM_DELAY_MS = 500;
/** As in the Classic UI: a monitor that produced no frame by then is reported as not listening. */
export const WAKE_NO_FRAMES_MS = 2500;
/** After a failure (no microphone, device busy), try again this often while the wake word stays on. */
export const WAKE_RETRY_MS = 15_000;
/** A detection hands the microphone to a voice turn; if no turn starts by then, the wake microphone reopens. */
const HANDOFF_TIMEOUT_MS = 4000;

export type WakeStatusKind = 'unavailable' | 'off' | 'muted' | 'paused' | 'starting' | 'warming' | 'listening' | 'failed';
export interface WakeStatus {
  kind: WakeStatusKind;
  /** What the wake word is doing now, in words for the person. */
  text: string;
  /** For `failed`: why it is not listening. */
  reason?: string;
  phrase: string;
  enabled: boolean;
  muted: boolean;
}

export interface WakeStatusInput {
  wake: WakeWordStatus | null | undefined;
  speaking: boolean;
  running: boolean;
  /** A voice turn is capturing, transcribing or speaking, a message is being sent, or a detection is being handed over. */
  voiceBusy: boolean;
  /** `flowing`: at least one frame reached the detector since the microphone opened. */
  monitor: 'stopped' | 'starting' | 'flowing';
  readyForDetect: boolean;
  failure: string | null;
}

export function wakeStatus(i: WakeStatusInput): WakeStatus {
  const phrase = i.wake?.phrase || 'Hey Jarvis';
  const base = { phrase, enabled: Boolean(i.wake?.enabled), muted: Boolean(i.wake?.muted) };
  if (!i.wake) return { ...base, kind: 'unavailable', text: 'Not reported by the host yet' };
  if (i.wake.capability !== 'available') return { ...base, kind: 'unavailable', text: `Not available on this PC${i.wake.blocker ? ` — ${i.wake.blocker}` : ''}` };
  if (!i.wake.enabled) return { ...base, kind: 'off', text: 'Off' };
  if (i.wake.muted) return { ...base, kind: 'muted', text: 'Muted, not listening' };
  if (i.speaking) return { ...base, kind: 'paused', text: 'Paused while Pandesh speaks' };
  if (i.running) return { ...base, kind: 'paused', text: 'Paused while a task runs' };
  if (i.voiceBusy) return { ...base, kind: 'paused', text: 'Paused during a voice turn' };
  if (i.failure) return { ...base, kind: 'failed', text: `Not listening — ${i.failure}`, reason: i.failure };
  if (i.monitor !== 'flowing') return { ...base, kind: 'starting', text: 'Starting the microphone…' };
  if (!i.readyForDetect) return { ...base, kind: 'warming', text: 'Starting — the detector is warming up' };
  return { ...base, kind: 'listening', text: `Listening for “${phrase}”` };
}

/** getUserMedia failures in plain words; anything else keeps its own message. */
export function micProblem(err: unknown): string {
  const name = String((err as { name?: string })?.name ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'the microphone was not allowed';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no microphone was found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'the microphone could not be opened (another app may be using it)';
  return errorText(err) || 'the microphone could not be opened';
}

function mergeFrames(frames: Int16Array[]): Int16Array {
  if (frames.length === 1) return frames[0];
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const f of frames) { out.set(f, at); at += f.length; }
  return out;
}

export interface WakeWord {
  status: WakeStatus;
  setEnabled(on: boolean): Promise<void>;
  setMuted(on: boolean): Promise<void>;
}

export function useWakeWord(opts: {
  snapshot: Snapshot | null;
  refresh: () => void;
  voiceBusy: boolean;
  /** The host heard the phrase while this page's monitor was feeding it: start a voice turn. */
  onWake: (event: VoiceEvent) => void;
  rearmDelayMs?: number;
  noFramesMs?: number;
  retryMs?: number;
}): WakeWord {
  const { snapshot, voiceBusy } = opts;
  const rearmDelay = opts.rearmDelayMs ?? WAKE_REARM_DELAY_MS;
  const noFramesMs = opts.noFramesMs ?? WAKE_NO_FRAMES_MS;
  const retryMs = opts.retryMs ?? WAKE_RETRY_MS;
  const wake = snapshot?.wakeWord ?? null;

  const [monitorState, setMonitorState] = useState<'stopped' | 'starting' | 'flowing'>('stopped');
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(false);

  const monitor = useRef<WakeMonitorHandle | null>(null);
  /** Bumped on every start and stop: callbacks of an earlier microphone session are dropped. */
  const generation = useRef(0);
  const pending = useRef<Int16Array[]>([]);
  const pushing = useRef(false);
  const noFramesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWakeRef = useRef(opts.onWake);
  onWakeRef.current = opts.onWake;
  const refreshRef = useRef(opts.refresh);
  refreshRef.current = opts.refresh;

  const shouldMonitor = Boolean(wake && wake.capability === 'available' && wake.enabled && !wake.muted)
    && !snapshot?.speaking && !snapshot?.running && !voiceBusy && !handoff;
  const shouldRef = useRef(shouldMonitor);
  shouldRef.current = shouldMonitor;

  /** Close the wake microphone and tell the host it is closed (Classic: stopWakeMonitor). */
  const halt = (captureError?: string) => {
    generation.current += 1;
    if (noFramesTimer.current) { clearTimeout(noFramesTimer.current); noFramesTimer.current = null; }
    const handle = monitor.current;
    monitor.current = null;
    pending.current = [];
    if (handle) { try { handle.stop(); } catch { /* already stopped */ } }
    if (handle || captureError) void api.reportWakeCapture({ captureActive: false, ...(captureError ? { captureError } : {}) }).catch(() => undefined);
    setMonitorState('stopped');
    setReady(false);
  };

  const fail = (gen: number, why: string, hostError: string) => {
    if (gen !== generation.current) return;
    halt(hostError);
    setFailure(why);
  };

  /** Frames go to the host one request at a time, in order (Classic: flushWakePush). */
  const flush = async (gen: number, cap: WakeCaptureModule, meta: WakeFrameMeta) => {
    if (pushing.current) return;
    pushing.current = true;
    try {
      while (gen === generation.current && pending.current.length > 0) {
        const pcm = mergeFrames(pending.current.splice(0));
        const result = await api.pushWakeAudio(cap.bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), {
          rms: meta.rms, sampleRate: meta.sampleRate, contextSampleRate: meta.contextSampleRate, framesEmitted: meta.framesEmitted, captureActive: true,
        });
        if (gen !== generation.current) return;
        setMonitorState('flowing');
        setFailure(null);
        setReady(Boolean(result?.diagnostics?.readyForDetect));
      }
    } catch (err) {
      fail(gen, `the wake detector did not accept the audio (${errorText(err)})`, errorText(err));
    } finally {
      pushing.current = false;
      if (gen === generation.current && pending.current.length > 0) void flush(gen, cap, meta);
    }
  };

  /** Open the wake microphone (Classic: ensureWakeMonitor). */
  const start = () => {
    const cap = capture();
    if (!cap?.startWakeMonitor) { setFailure('the microphone helper did not load'); return; }
    const gen = ++generation.current;
    let sawFrame = false;
    setFailure(null);
    setReady(false);
    setMonitorState('starting');
    let handle: WakeMonitorHandle;
    try {
      handle = cap.startWakeMonitor({
        onReady: (info) => {
          if (gen !== generation.current) return;
          void api.reportWakeCapture({ captureActive: true, sampleRate: info.sampleRate, contextSampleRate: info.sampleRate, trackLabel: info.trackLabel || '' }).catch(() => undefined);
        },
        onFrame: (pcm, meta) => {
          if (gen !== generation.current) return;
          sawFrame = true;
          pending.current.push(pcm);
          void flush(gen, cap, meta ?? {});
        },
        onError: (err) => fail(gen, micProblem(err), String(err?.message || err)),
      });
    } catch (err) {
      fail(gen, micProblem(err), errorText(err));
      return;
    }
    if (gen !== generation.current) { try { handle.stop(); } catch { /* already stopped */ } return; } // failed while opening
    monitor.current = handle;
    noFramesTimer.current = setTimeout(() => {
      noFramesTimer.current = null;
      if (gen !== generation.current || sawFrame) return;
      // Kept open in case frames start late (as in the Classic UI); a frame clears this.
      setFailure('no microphone frames arrived. Check the microphone and that Windows lets apps use it');
      void api.reportWakeCapture({ captureActive: false, captureError: 'no microphone frames received' }).catch(() => undefined);
    }, noFramesMs);
  };

  useEffect(() => {
    if (!shouldMonitor) {
      if (monitor.current) halt();
      if (failure) setFailure(null); // the next time it may listen, it tries again at once
      return undefined;
    }
    if (monitor.current) return undefined;
    if (failure) {
      const t = setTimeout(() => setFailure(null), retryMs);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => { if (shouldRef.current && !monitor.current) start(); }, rearmDelay);
    return () => clearTimeout(t);
  }, [shouldMonitor, failure, monitorState]);

  // A detection hands the microphone to a voice turn; the turn itself then keeps the monitor closed.
  useEffect(() => {
    if (!handoff) return undefined;
    if (voiceBusy) { setHandoff(false); return undefined; }
    const t = setTimeout(() => setHandoff(false), HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [handoff, voiceBusy]);

  useEffect(() => {
    const off = api.onVoiceEvent?.((event) => {
      if (event?.kind === 'wake_detected') {
        // Only a detection from frames this page is still feeding starts a turn (not one that raced a mute or a mic press).
        if (!monitor.current) return;
        console.info(`[voice] wake_detected score=${event.score} wakeDetectMs=${event.wakeDetectMs ?? 'null'} inferenceMs=${event.inferenceMs ?? 'null'} frames=${event.framesReceived ?? '?'} ui=v2`);
        halt();
        setHandoff(true);
        onWakeRef.current(event);
        return;
      }
      if (event?.kind === 'wake_state' || event?.kind === 'speak_stopped' || event?.kind === 'speak_finished' || event?.kind === 'speaking') refreshRef.current();
    });
    return () => { off?.(); halt(); };
  }, []);

  const status = wakeStatus({
    wake,
    speaking: Boolean(snapshot?.speaking),
    running: Boolean(snapshot?.running),
    voiceBusy: voiceBusy || handoff,
    monitor: monitorState,
    readyForDetect: ready,
    failure,
  });

  return {
    status,
    setEnabled: async (on) => { try { await api.setWakeWordEnabled(on); } finally { refreshRef.current(); } },
    setMuted: async (on) => { try { await api.setWakeWordMuted(on); } finally { refreshRef.current(); } },
  };
}
