/** @vitest-environment jsdom */
/**
 * The wake word in the v2 interface. Before this, v2 never opened the microphone for the wake word: no frame reached
 * the host's openWakeWord detector, yet the route popover said "Listening (Classic UI monitor)". v2 now does what the
 * Classic renderer does (renderer.js: ensureWakeMonitor, stopWakeMonitor, flushWakePush, onVoiceEvent → wake_detected
 * → beginVadUtterance('wake')): it opens the wake microphone only while the wake word is on, unmuted and nothing else
 * needs the microphone, streams the frames to the host, starts an ordinary voice turn when the host hears the phrase,
 * and sends the question with a voice turn id so Core knows it was spoken. It says "Listening" only when frames
 * reach the detector.
 *
 * Renders the real hook, Chat and App against a mocked host bridge (window.desktop) and capture module
 * (window.jarvisVoiceCapture, renderer/voiceCapture.js in the app).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Snap = Record<string, any>;
type VoiceListener = (event: Record<string, unknown>) => void;

const voiceListeners = new Set<VoiceListener>();
function emitVoice(event: Record<string, unknown>) {
  act(() => { for (const l of [...voiceListeners]) l(event); });
}

let currentSnapshot: Snap | null = null;
const bridge = {
  // wake
  pushWakeAudio: vi.fn(async (_pcmBase64: string, _meta?: unknown) => ({ score: 0.02, detected: false, diagnostics: { engineReady: true, readyForDetect: true } as Record<string, unknown> })),
  reportWakeCapture: vi.fn(async (_meta: unknown) => null),
  setWakeWordEnabled: vi.fn(async (_on: boolean) => null),
  setWakeWordMuted: vi.fn(async (_on: boolean) => null),
  onVoiceEvent: (listener: VoiceListener) => { voiceListeners.add(listener); return () => { voiceListeners.delete(listener); }; },
  // the surfaces around it
  onEvent: () => () => undefined,
  getSnapshot: vi.fn(async () => currentSnapshot),
  getUiVariant: vi.fn(async () => ({ variant: 'v2', forcedByEnv: true })),
  getTaskOverview: vi.fn(async () => ({ tasks: [], queued: [] })),
  getAssistantBrief: vi.fn(async () => ({ generatedAt: '2026-11-10T10:00:00.000Z', home: [] })),
  openConversation: vi.fn(async (id: string) => ({ conversation: { id, title: null, preview: null, state: 'open', updatedAt: '', archivedAt: null, pinnedAt: null }, messages: [] })),
  listConversations: vi.fn(async () => []),
  transcribeUtterance: vi.fn(async (_wavBase64: string, _voiceTurnId?: string) => ({ transcript: 'what time is it', engine: 'whisper-base.en' })),
  submitTask: vi.fn(async (_goal: string, _worker?: string, _voiceTurnId?: string) => ({ attemptId: 'att_1', requestId: 'req_1', model: 'gemma4:12b' })),
  speakText: vi.fn(async () => ({ wavBase64: '', engine: 'piper', cancelled: true })),
  stopSpeaking: vi.fn(async () => null),
  markPlaybackFinished: vi.fn(async () => null),
  setVoiceMode: vi.fn(async () => null),
};

interface FakeMonitor { opts: Record<string, any>; stop: ReturnType<typeof vi.fn> }
const monitors: FakeMonitor[] = [];
const captureModule = {
  startWakeMonitor: vi.fn((opts: Record<string, any>) => { const m = { opts, stop: vi.fn() }; monitors.push(m); return m; }),
  startVadUtteranceCapture: vi.fn((_opts?: unknown) => ({ done: Promise.resolve(new Uint8Array(64) as Uint8Array | null), stop: vi.fn(async () => null) })),
  bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
};

let wakeMod: typeof import('../renderer-v2/src/wake');
let Chat: typeof import('../renderer-v2/src/Chat').Chat;
let App: typeof import('../renderer-v2/src/App').App;

beforeAll(async () => {
  // bridge.ts reads window.desktop when it loads; voice.ts / wake.ts read the capture module when they run.
  (window as unknown as { desktop: unknown }).desktop = bridge;
  (window as unknown as { jarvisVoiceCapture: unknown }).jarvisVoiceCapture = captureModule;
  wakeMod = await import('../renderer-v2/src/wake');
  ({ Chat } = await import('../renderer-v2/src/Chat'));
  ({ App } = await import('../renderer-v2/src/App'));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  monitors.length = 0;
  currentSnapshot = null;
});

const h = React.createElement;

function snap(over: Snap = {}, wake: Snap = {}): Snap {
  return {
    coreState: 'connected', running: false, speaking: false, voiceMode: false, model: 'gemma4:12b', modelIsAuto: false,
    provider: 'ollama', selectedInferenceProvider: 'ollama', attemptId: null, awaitingApproval: false, pendingApproval: null,
    workspaceActivities: [], lastTurnOutcome: null, turnOutcomeKind: null, blockedReason: null, selectedConversationId: null,
    activeConversationId: null, installedModels: ['gemma4:12b'], localSpeech: { capability: 'available', engine: 'whisper-base.en' },
    ...over,
    wakeWord: { capability: 'available', engine: 'openWakeWord', blocker: '', phrase: 'Hey Jarvis', enabled: true, muted: false, ...wake },
  };
}

function WakeHarness(props: { snap: Snap; voiceBusy?: boolean; onWake: () => void }) {
  const w = wakeMod.useWakeWord({ snapshot: props.snap as never, refresh: () => undefined, voiceBusy: Boolean(props.voiceBusy), onWake: props.onWake, rearmDelayMs: 0, noFramesMs: 80, retryMs: 60_000 });
  return h('div', null, h('p', { 'data-testid': 'wake-kind' }, w.status.kind), h('p', { 'data-testid': 'wake-text' }, w.status.text));
}
const kind = () => screen.getByTestId('wake-kind').textContent;
const text = () => screen.getByTestId('wake-text').textContent;
const b64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('UI v2 wake word — the microphone for the wake word', () => {
  it('opens only while the wake word is on, unmuted and nothing else needs the microphone, and closes when muted', async () => {
    const onWake = vi.fn();
    const { rerender } = render(h(WakeHarness, { snap: snap({}, { enabled: false }), onWake }));
    expect(text()).toBe('Off');
    rerender(h(WakeHarness, { snap: snap({}, { muted: true }), onWake }));
    expect(text()).toBe('Muted, not listening');
    rerender(h(WakeHarness, { snap: snap({ speaking: true }), onWake }));
    expect(text()).toBe('Paused while Pandesh speaks');
    rerender(h(WakeHarness, { snap: snap({ running: true }), onWake }));
    expect(text()).toBe('Paused while a task runs');
    rerender(h(WakeHarness, { snap: snap(), voiceBusy: true, onWake }));
    expect(text()).toBe('Paused during a voice turn');
    await sleep(30);
    expect(captureModule.startWakeMonitor).not.toHaveBeenCalled();

    rerender(h(WakeHarness, { snap: snap(), onWake }));
    await waitFor(() => expect(captureModule.startWakeMonitor).toHaveBeenCalledTimes(1));
    expect(text()).toBe('Starting the microphone…');

    // Muted from the tray or the Classic UI: the wake microphone closes and the host is told.
    rerender(h(WakeHarness, { snap: snap({}, { muted: true }), onWake }));
    await waitFor(() => expect(monitors[0].stop).toHaveBeenCalled());
    expect(bridge.reportWakeCapture).toHaveBeenLastCalledWith({ captureActive: false });
    expect(text()).toBe('Muted, not listening');
    await sleep(30);
    expect(captureModule.startWakeMonitor).toHaveBeenCalledTimes(1);
  });

  it('streams the frames to the host detector in order and says Listening only once they reach it', async () => {
    render(h(WakeHarness, { snap: snap(), onWake: vi.fn() }));
    await waitFor(() => expect(monitors).toHaveLength(1));
    const m = monitors[0];
    act(() => m.opts.onReady({ sampleRate: 16000, trackLabel: 'Microphone (USB)' }));
    expect(bridge.reportWakeCapture).toHaveBeenCalledWith({ captureActive: true, sampleRate: 16000, contextSampleRate: 16000, trackLabel: 'Microphone (USB)' });
    expect(kind()).toBe('starting');

    // The first push is still in flight when two more frames arrive: they go next, together, in order.
    let release!: (v: unknown) => void;
    bridge.pushWakeAudio.mockImplementationOnce(() => new Promise((r) => { release = r as (v: unknown) => void; }) as never);
    const a = new Int16Array([1, -2, 3]);
    const b = new Int16Array([32767, -32768]);
    const c = new Int16Array([7]);
    const meta = { rms: 0.1, sampleRate: 16000, contextSampleRate: 48000, framesEmitted: 1 };
    act(() => { m.opts.onFrame(a, meta); m.opts.onFrame(b, { ...meta, framesEmitted: 2 }); m.opts.onFrame(c, { ...meta, framesEmitted: 3 }); });
    expect(bridge.pushWakeAudio).toHaveBeenCalledTimes(1);
    expect(bridge.pushWakeAudio).toHaveBeenCalledWith(b64(a), { ...meta, captureActive: true });
    expect(kind()).toBe('starting'); // nothing has reached the detector yet

    await act(async () => { release({ score: 0.01, detected: false, diagnostics: { engineReady: true, readyForDetect: false } }); });
    await waitFor(() => expect(bridge.pushWakeAudio).toHaveBeenCalledTimes(2));
    expect(bridge.pushWakeAudio.mock.calls[1][0]).toBe(b64(new Int16Array([32767, -32768, 7])));
    await waitFor(() => expect(text()).toBe('Listening for “Hey Jarvis”'));
  });

  it('says the detector is warming up until the host reports it ready', async () => {
    bridge.pushWakeAudio.mockResolvedValueOnce({ score: 0, detected: false, diagnostics: { engineReady: true, readyForDetect: false } });
    render(h(WakeHarness, { snap: snap(), onWake: vi.fn() }));
    await waitFor(() => expect(monitors).toHaveLength(1));
    act(() => monitors[0].opts.onFrame(new Int16Array([1]), {}));
    await waitFor(() => expect(text()).toBe('Starting — the detector is warming up'));
  });

  it('a detection closes the wake microphone and starts exactly one voice turn', async () => {
    const onWake = vi.fn();
    render(h(WakeHarness, { snap: snap(), onWake }));
    await waitFor(() => expect(monitors).toHaveLength(1));
    act(() => monitors[0].opts.onFrame(new Int16Array([1, 2]), {}));
    await waitFor(() => expect(kind()).toBe('listening'));

    emitVoice({ kind: 'wake_detected', score: 0.81, wakeDetectMs: 1400, framesReceived: 40 });
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0]).toMatchObject({ kind: 'wake_detected', score: 0.81 });
    expect(monitors[0].stop).toHaveBeenCalled();
    expect(bridge.reportWakeCapture).toHaveBeenLastCalledWith({ captureActive: false });
    expect(text()).toBe('Paused during a voice turn');

    // A second event for the same audio (or one that raced a mute) does not start another turn.
    emitVoice({ kind: 'wake_detected', score: 0.9 });
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('ignores a detection when this page is not feeding the detector', async () => {
    const onWake = vi.fn();
    render(h(WakeHarness, { snap: snap({}, { muted: true }), onWake }));
    emitVoice({ kind: 'wake_detected', score: 0.9 });
    expect(onWake).not.toHaveBeenCalled();
  });

  it('a microphone that cannot be opened is reported as not listening, to the person and to the host', async () => {
    render(h(WakeHarness, { snap: snap(), onWake: vi.fn() }));
    await waitFor(() => expect(monitors).toHaveLength(1));
    act(() => monitors[0].opts.onError(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' })));
    expect(text()).toBe('Not listening — no microphone was found');
    expect(bridge.reportWakeCapture).toHaveBeenLastCalledWith({ captureActive: false, captureError: 'Requested device not found' });
  });

  it('a microphone that gives no frames is reported, and a late frame clears it', async () => {
    render(h(WakeHarness, { snap: snap(), onWake: vi.fn() }));
    await waitFor(() => expect(monitors).toHaveLength(1));
    await waitFor(() => expect(kind()).toBe('failed'));
    expect(text()).toMatch(/^Not listening — no microphone frames arrived/);
    expect(bridge.reportWakeCapture).toHaveBeenCalledWith({ captureActive: false, captureError: 'no microphone frames received' });
    act(() => monitors[0].opts.onFrame(new Int16Array([5]), {}));
    await waitFor(() => expect(kind()).toBe('listening'));
  });

  it('says why it is unavailable instead of offering it', () => {
    const status = wakeMod.wakeStatus({ wake: { capability: 'unavailable_no_local_engine', blocker: 'Missing: hey_jarvis_v0.1.onnx.', phrase: 'Hey Jarvis', enabled: false, muted: false }, speaking: false, running: false, voiceBusy: false, monitor: 'stopped', readyForDetect: false, failure: null });
    expect(status).toMatchObject({ kind: 'unavailable', text: 'Not available on this PC — Missing: hey_jarvis_v0.1.onnx.' });
  });
});

function fakeWake(over: Partial<import('../renderer-v2/src/wake').WakeStatus> = {}) {
  return {
    status: { kind: 'listening' as const, text: 'Listening for “Hey Jarvis”', phrase: 'Hey Jarvis', enabled: true, muted: false, ...over },
    setEnabled: vi.fn(async (_on: boolean) => undefined),
    setMuted: vi.fn(async (_on: boolean) => undefined),
  };
}

function chatProps(over: Record<string, unknown> = {}) {
  return {
    snapshot: snap() as never, snapshotError: null, refresh: vi.fn(), narrow: false, openConversationId: null,
    onOpenPalette: () => undefined, onOpenBoard: () => undefined, ...over,
  };
}

describe('UI v2 wake word — the voice turn it starts', () => {
  it('records the question after the wake word and sends it as spoken, with its voice turn id', async () => {
    let finish!: (wav: Uint8Array | null) => void;
    captureModule.startVadUtteranceCapture.mockImplementationOnce(() => ({ done: new Promise<Uint8Array | null>((r) => { finish = r; }), stop: vi.fn(async () => null) }));
    const onWakeTurnTaken = vi.fn();
    const onVoiceBusy = vi.fn();
    render(h(Chat, chatProps({ wake: fakeWake(), wakeTurn: { id: 1 }, onWakeTurnTaken, onVoiceBusy })));

    await waitFor(() => expect(captureModule.startVadUtteranceCapture).toHaveBeenCalledTimes(1));
    expect(onWakeTurnTaken).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Heard “Hey Jarvis”. Ask your question.')).toBeTruthy();
    await waitFor(() => expect(onVoiceBusy).toHaveBeenLastCalledWith(true));

    await act(async () => { finish(new Uint8Array(64)); });
    await waitFor(() => expect(bridge.submitTask).toHaveBeenCalledTimes(1));
    const turnId = bridge.transcribeUtterance.mock.calls[0][1];
    expect(typeof turnId).toBe('string');
    expect(turnId).toMatch(/^[a-z0-9-]{6,}$/i);
    expect(bridge.transcribeUtterance.mock.calls[0][0]).toBe(Buffer.alloc(64).toString('base64'));
    expect(bridge.submitTask).toHaveBeenCalledWith('what time is it', undefined, turnId);
    await waitFor(() => expect(onVoiceBusy).toHaveBeenLastCalledWith(false));
  });

  it('does not start a second capture while one is already listening', async () => {
    captureModule.startVadUtteranceCapture.mockImplementationOnce(() => ({ done: new Promise<Uint8Array | null>(() => undefined), stop: vi.fn(async () => null) }));
    const props = chatProps({ wake: fakeWake(), wakeTurn: { id: 1 } });
    const { rerender } = render(h(Chat, props));
    await waitFor(() => expect(captureModule.startVadUtteranceCapture).toHaveBeenCalledTimes(1));
    rerender(h(Chat, { ...props, wakeTurn: { id: 2 } }));
    await sleep(20);
    expect(captureModule.startVadUtteranceCapture).toHaveBeenCalledTimes(1);
  });

  it('says so when it heard the wake word but cannot recognise speech on this PC', async () => {
    render(h(Chat, chatProps({ snapshot: snap({ localSpeech: { capability: 'unavailable', blocker: 'Whisper model missing.' } }) as never, wake: fakeWake(), wakeTurn: { id: 1 } })));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Heard the wake word, but local speech recognition is not available: Whisper model missing\./));
    expect(captureModule.startVadUtteranceCapture).not.toHaveBeenCalled();
  });
});

describe('UI v2 wake word — what the interface says', () => {
  it('the route popover says what the wake word is really doing, and Mute / Turn off / Turn on go to the host', async () => {
    const wake = fakeWake();
    const { rerender } = render(h(Chat, chatProps({ wake })));
    expect((screen.getByLabelText('Message Pandesh') as HTMLTextAreaElement).placeholder).toBe('Ask Pandesh… or say “Hey Jarvis”');
    fireEvent.click(screen.getByRole('button', { name: /Local · gemma4:12b/ }));
    const popover = screen.getByRole('dialog', { name: 'How this chat is routed' });
    expect(popover.textContent).toContain('Wake wordListening for “Hey Jarvis”');
    expect(popover.textContent).not.toMatch(/Classic UI monitor/);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(wake.setMuted).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(wake.setEnabled).toHaveBeenCalledWith(false));

    const off = fakeWake({ kind: 'off', text: 'Off', enabled: false });
    rerender(h(Chat, chatProps({ wake: off, snapshot: snap({}, { enabled: false }) as never })));
    expect(screen.getByRole('dialog', { name: 'How this chat is routed' }).textContent).toContain('Wake wordOff');
    expect((screen.getByLabelText('Message Pandesh') as HTMLTextAreaElement).placeholder).toBe('Ask Pandesh…');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(off.setEnabled).toHaveBeenCalledWith(true));
  });

  it('a failed switch is shown, and a wake word that is not listening says why', async () => {
    const wake = fakeWake({ kind: 'failed', text: 'Not listening — no microphone was found', reason: 'no microphone was found' });
    wake.setMuted.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:setWakeWordMuted': Error: desktop session is not started"));
    render(h(Chat, chatProps({ wake })));
    expect(screen.getByRole('alert').textContent).toMatch(/^The wake word is not listening: no microphone was found\./);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Local · gemma4:12b/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Wake word: desktop session is not started/));
  });
});

describe('UI v2 wake word — end to end in the renderer', () => {
  it('on any view, the host hearing the wake word opens the chat and sends the spoken question as spoken', async () => {
    currentSnapshot = snap();
    render(h(App));
    // Away from the chat, the wake word still listens.
    fireEvent.click(await screen.findByRole('button', { name: 'Board — tasks and their real status' }));
    await waitFor(() => expect(captureModule.startWakeMonitor).toHaveBeenCalledTimes(1), { timeout: 3000 });
    act(() => monitors[0].opts.onFrame(new Int16Array([1, 2, 3]), { framesEmitted: 1 }));
    await waitFor(() => expect(bridge.pushWakeAudio).toHaveBeenCalledTimes(1));
    await sleep(10);

    emitVoice({ kind: 'wake_detected', score: 0.77, wakeDetectMs: 900 });
    expect(monitors[0].stop).toHaveBeenCalled();
    await waitFor(() => expect(captureModule.startVadUtteranceCapture).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.submitTask).toHaveBeenCalledTimes(1));
    const turnId = bridge.transcribeUtterance.mock.calls[0][1];
    expect(turnId).toBeTruthy();
    expect(bridge.submitTask).toHaveBeenCalledWith('what time is it', undefined, turnId);
    expect(screen.getByRole('textbox', { name: 'Message Pandesh' })).toBeTruthy(); // the chat is shown
  });
});
