import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mockSession, openEvents, pair, startServer, wavBytes } from './mobileTestKit';

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function pairedServer(session = mockSession()) {
  const s = await startServer(dirs, { session });
  stops.push(() => s.server.stop());
  const { cookie } = await pair(s.base, s.server.getPairingInfo().code);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${s.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify(body) });
  return { ...s, cookie, post };
}

describe('live updates', () => {
  it('a new connection gets hello and the current state at once, then tokens batched and events without tool arguments', async () => {
    const { session, port, cookie } = await pairedServer();
    const events = await openEvents(port, cookie);
    try {
      const hello = await events.waitFor((e) => e.event === 'hello');
      expect(hello.data).toMatchObject({ device: { id: expect.any(String), name: expect.any(String) }, secure: false });
      expect((await events.waitFor((e) => e.event === 'state')).data).toMatchObject({ coreState: 'connected', model: 'gemma4:12b' });

      for (const word of ['The ', 'tide ', 'is ', 'high.']) session.emit({ kind: 'token', at: 'x', attemptId: 'att-9', summary: 'token', text: word });
      session.emit({ kind: 'activity', at: 'x', attemptId: 'att-9', summary: 'Reading', toolName: 'read_file', toolArgs: { path: 'C:\\private\\notes.txt' } });
      session.emit({ kind: 'result', at: 'x', attemptId: 'att-9', summary: 'done', text: 'The tide is high.' });

      const token = await events.waitFor((e) => e.event === 'token');
      expect(token.data).toEqual({ attemptId: 'att-9', text: 'The tide is high.' });
      const activity = await events.waitFor((e) => e.event === 'activity' && e.data.kind === 'activity');
      expect(JSON.stringify(activity.data)).not.toContain('private');
      const result = await events.waitFor((e) => e.event === 'activity' && e.data.kind === 'result');
      expect(result.data.text).toBe('The tide is high.');
      // Tokens arrive before the result that ends them.
      expect(events.events.indexOf(token)).toBeLessThan(events.events.indexOf(result));
      // State follows an event, coalesced.
      await events.waitFor((e) => e.event === 'state' && events.events.indexOf(e) > events.events.indexOf(result));
    } finally {
      events.close();
    }
  });

  it('an unpaired request cannot open the stream', async () => {
    const { base } = await pairedServer();
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });
});

describe('sending from the phone', () => {
  it('a retried send with the same id runs once (the first answer may have been lost on the way)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const session = mockSession({ submitTask: vi.fn(async () => { await gate; return { requestId: 'r', attemptId: 'att-5', model: 'm' }; }) });
    const { post } = await pairedServer(session);
    const body = { message: 'What is the weather?', clientMessageId: 'msg-0123456789' };
    const first = post('/api/submit', body);
    const second = post('/api/submit', body);
    setTimeout(release, 50);
    const [a, b] = await Promise.all([first, second]);
    expect(session.submitTask).toHaveBeenCalledTimes(1);
    expect(await a.json()).toMatchObject({ ok: true, attemptId: 'att-5' });
    expect(await b.json()).toMatchObject({ ok: true, attemptId: 'att-5', repeated: true });
    const third = await post('/api/submit', body);
    expect(await third.json()).toMatchObject({ ok: true, repeated: true });
    expect(session.submitTask).toHaveBeenCalledTimes(1);
  });

  it('while Pandesh works, a send is routed like the PC composer\'s (queued, steered, or Stop) and answers at once', async () => {
    const session = mockSession({ isBusy: vi.fn(() => true) });
    const { post } = await pairedServer(session);
    const res = await post('/api/submit', { message: 'and then email me the summary', clientMessageId: 'msg-busy-000001' });
    expect(await res.json()).toMatchObject({ ok: true, routed: 'queued' });
    expect(session.sendWhileRunning).toHaveBeenCalledWith('and then email me the summary');
    expect(session.submitTask).not.toHaveBeenCalled();
  });

  it('a send Pandesh refuses comes back as an error the phone can show', async () => {
    const session = mockSession({ submitTask: vi.fn(async () => { throw new Error('No models found in Ollama.'); }) });
    const { post } = await pairedServer(session);
    const res = await post('/api/submit', { message: 'hello', clientMessageId: 'msg-fail-000001' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'No models found in Ollama.' });
  });

  it('a spoken message is marked as spoken (voice turn id) for Core', async () => {
    const { session, post } = await pairedServer();
    await (await post('/api/submit', { message: 'remind me at five', voiceTurnId: 'turn-abc123' })).json();
    expect(session.submitTask).toHaveBeenCalledWith('remind me at five', undefined, 'turn-abc123', 'mobile', []);
  });
});

describe('decisions and Stop from the phone', () => {
  it('tool, image and weather approvals each go to their own resolver', async () => {
    const { session, post } = await pairedServer();
    expect((await post('/api/approval', { approvalId: 'ap-1', resolution: 'approved' })).status).toBe(200);
    expect(session.resolvePending).toHaveBeenCalledWith('ap-1', 'approved');
    expect((await post('/api/approval', { approvalId: 'img-1', kind: 'image', resolution: 'approved' })).status).toBe(200);
    expect(session.resolveImageApproval).toHaveBeenCalledWith('img-1', 'approved');
    const wx = await post('/api/approval', { approvalId: 'wx-1', kind: 'weather', resolution: 'something-else' });
    expect(await wx.json()).toMatchObject({ ok: true, state: { coreState: 'connected' } });
    // Anything but an explicit approval is a rejection.
    expect(session.resolveWeatherApproval).toHaveBeenCalledWith('wx-1', 'rejected');
  });

  it('an approval already answered on the PC is reported, not a crash', async () => {
    const session = mockSession({ resolvePending: vi.fn(async () => { throw new Error('no matching pending approval'); }) });
    const { post } = await pairedServer(session);
    const res = await post('/api/approval', { approvalId: 'gone', resolution: 'approved' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer waiting/);
  });

  it('Stop cancels the running task, and says so when nothing runs', async () => {
    const { session, post } = await pairedServer();
    expect((await post('/api/cancel', {})).status).toBe(200);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    session.cancel.mockRejectedValueOnce(new Error('no running task to cancel'));
    const idle = await post('/api/cancel', {});
    expect(idle.status).toBe(409);
    expect(await idle.json()).toEqual({ ok: false, error: 'no running task to cancel' });
  });
});

describe('voice from the phone', () => {
  it('takes a WAV the phone recorded, passes the voice turn, and returns the transcript under both field names', async () => {
    const { session, base, cookie } = await pairedServer();
    const audio = wavBytes();
    const res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Cookie: cookie, 'X-Voice-Turn-Id': 'turn-77' }, body: new Uint8Array(audio) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transcript: 'Transcribed utterance', text: 'Transcribed utterance', review: { required: false } });
    expect(session.transcribeUtteranceWavBase64).toHaveBeenCalledWith(audio.toString('base64'), 'turn-77');
  });

  it('refuses audio that is not WAV (the old page sent webm or mp4 labelled as WAV)', async () => {
    const { session, base, cookie } = await pairedServer();
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0)]);
    const asWav = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Cookie: cookie }, body: webm });
    expect(asWav.status).toBe(400);
    await asWav.text();
    const asWebm = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/webm', Cookie: cookie }, body: webm });
    expect(asWebm.status).toBe(415);
    await asWebm.text();
    expect(session.transcribeUtteranceWavBase64).not.toHaveBeenCalled();
  });
});
