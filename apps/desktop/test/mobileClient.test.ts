/**
 * The phone app (renderer/mobile) in a fresh jsdom per test, against a fake PC: fetch and EventSource are scripted.
 * Covers pairing, live state, safe rendering, approvals, sending with retries, reconnect + resync, lost pairing,
 * streaming replies and the microphone on a plain-http link.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const dir = path.join(__dirname, '..', 'renderer', 'mobile');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const libJs = fs.readFileSync(path.join(dir, 'lib.js'), 'utf8');
const appJs = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown } | 'network-error';
type Route = (call: Call) => Reply | Promise<Reply>;

class FakeEventSource {
  readyState = 0;
  onerror: ((e: unknown) => void) | null = null;
  private listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { this.readyState = 1; for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); }
  fail() { this.readyState = 2; this.onerror?.({}); }
}

const opened: JSDOM[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.window.close(); });

function boot(routes: Record<string, Route>, url = 'http://192.0.2.10:3030/') {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  opened.push(dom);
  const w = dom.window as any;
  const calls: Call[] = [];
  const sources: FakeEventSource[] = [];
  w.fetch = async (input: string, init: any = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(input, w.location.href);
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    const call = { method, path: u.pathname, body, headers: init.headers || {} };
    calls.push(call);
    const route = routes[`${method} ${u.pathname}`];
    const out = route ? await route(call) : { status: 404, body: { error: 'Not found' } };
    if (out === 'network-error') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  w.EventSource = class extends FakeEventSource { constructor(u: string) { super(u); sources.push(this); } };
  w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = () => undefined;
  w.eval(libJs);
  w.eval(appJs);
  const doc: Document = w.document;
  const el = (id: string) => doc.getElementById(id) as HTMLElement;
  return { w, doc, el, calls, sources };
}

async function until(pred: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const state = (over: Record<string, unknown> = {}) => ({
  coreState: 'connected', model: 'gemma4:12b', running: false, attemptId: null, conversationId: 'c1',
  activity: null, decision: null, lastTurnOutcome: null, blockedReason: null, workspace: 'example-app', ...over,
});
const paired = (messages: unknown[] = [], extra: Record<string, Route> = {}): Record<string, Route> => ({
  'GET /api/session': () => ({ body: { ok: true, device: { id: 'd1', name: 'Android · Chrome' }, secure: false } }),
  'GET /api/messages': () => ({ body: { conversationId: 'c1', messages } }),
  'GET /api/state': () => ({ body: state() }),
  ...extra,
});

async function goLive(app: ReturnType<typeof boot>, st = state()) {
  await until(() => app.sources.length > 0);
  const source = app.sources[app.sources.length - 1];
  source.emit('hello', { device: { id: 'd1', name: 'Android · Chrome' }, secure: false });
  source.emit('state', st);
  await until(() => !app.el('view-chat').hidden);
  return source;
}

describe('pairing', () => {
  it('a pairing link pairs at once, takes the code out of the address, and goes live', async () => {
    const app = boot({
      'GET /api/session': () => ({ status: 401, body: { ok: false } }),
      'POST /api/pair': () => ({ body: { ok: true, device: { id: 'd1', name: 'Android · Chrome' } } }),
      'GET /api/messages': () => ({ body: { conversationId: 'c1', messages: [] } }),
      'GET /api/state': () => ({ body: state() }),
    }, 'http://192.0.2.10:3030/?pair=abcd-efgh');
    expect(app.w.location.search).toBe('');
    await until(() => app.calls.some((c) => c.path === '/api/pair'));
    expect(app.calls.find((c) => c.path === '/api/pair')!.body).toEqual({ code: 'ABCDEFGH' });
    expect(app.calls.find((c) => c.path === '/api/pair')!.headers['Content-Type']).toBe('application/json');
    await goLive(app);
    expect(app.sources[0].url).toBe('/api/events');
    expect(app.el('conn-pill').textContent).toBe('Live');
    expect(app.el('view-pair').hidden).toBe(true);
    expect(app.el('brand-sub').textContent).toBe('gemma4:12b · home Wi-Fi');
    await until(() => app.calls.some((c) => c.path === '/api/messages'));
  });

  it('a wrong code shows the PC\'s reason and keeps the pairing screen', async () => {
    const app = boot({
      'GET /api/session': () => ({ status: 401, body: { ok: false } }),
      'POST /api/pair': () => ({ status: 401, body: { ok: false, error: 'wrong_code', message: 'That code is not right. Check the code on your PC.' } }),
    });
    await until(() => !app.el('view-pair').hidden);
    const input = app.el('pair-code') as HTMLInputElement;
    input.value = 'wxyz2345';
    input.dispatchEvent(new app.w.Event('input'));
    expect(input.value).toBe('WXYZ-2345');
    app.el('pair-form').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
    await until(() => app.el('pair-msg').textContent!.includes('not right'));
    expect(app.el('pair-msg').className).toContain('error');
    expect(app.sources).toHaveLength(0);
  });
});

describe('the conversation', () => {
  it('renders replies as text and safe links only (no HTML, no javascript: links)', async () => {
    const app = boot(paired([
      { id: 'u1', role: 'user', content: 'hi <b>there</b>', createdAt: '2026-11-10T10:00:00Z' },
      { id: 'a1', role: 'assistant', content: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) **bold** [ok](https://example.com/)', createdAt: '2026-11-10T10:00:01Z' },
    ]));
    await goLive(app);
    await until(() => app.el('messages').children.length === 2);
    const list = app.el('messages');
    expect(list.querySelectorAll('img')).toHaveLength(0);
    expect(list.querySelector('b')).toBeNull();
    expect(Array.from(list.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://example.com/']);
    expect(list.querySelector('strong')!.textContent).toBe('bold');
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(list.textContent).toContain('hi <b>there</b>');
    expect(app.el('hero').hidden).toBe(true);
  });

  it('a decision waiting on the PC shows its own words; Allow sends that answer for that approval', async () => {
    const decision = { kind: 'tool', approvalId: 'ap-1', title: 'Search the web', rows: [['Action', 'Search the web'], ['Why it asks', 'It goes online (public web only)']], detail: 'tide times', allowLabel: 'Allow this web search' };
    const app = boot(paired([], {
      'GET /api/state': () => ({ body: state({ running: true, attemptId: 'att-1', decision }) }),
      'POST /api/approval': () => ({ body: { ok: true, state: state() } }),
    }));
    await goLive(app, state({ running: true, attemptId: 'att-1', decision }));
    const box = app.el('decision');
    await until(() => !box.hidden);
    expect(box.querySelector('.decision-title')!.textContent).toBe('Search the web');
    expect(box.querySelector('.decision-detail')!.textContent).toBe('tide times');
    expect(app.el('status-text').textContent).toBe('Waiting for your OK');
    const allow = Array.from(box.querySelectorAll('button')).find((b) => b.textContent === 'Allow this web search')!;
    allow.click();
    await until(() => app.calls.some((c) => c.path === '/api/approval'));
    expect(app.calls.find((c) => c.path === '/api/approval')!.body).toEqual({ approvalId: 'ap-1', kind: 'tool', resolution: 'approved' });
    await until(() => box.hidden);
  });

  it('a send that hits a network error is retried with the same id, so the PC runs it once', async () => {
    let submits = 0;
    let messages: unknown[] = [];
    const app = boot(paired([], {
      'GET /api/messages': () => ({ body: { conversationId: 'c1', messages } }),
      'POST /api/submit': () => { submits += 1; return submits === 1 ? 'network-error' : { body: { ok: true, attemptId: 'att-3', requestId: 'r', model: 'm' } }; },
    }));
    await goLive(app);
    const input = app.el('input') as HTMLTextAreaElement;
    input.value = 'What is on my calendar?';
    input.dispatchEvent(new app.w.Event('input'));
    expect((app.el('send-btn') as HTMLButtonElement).disabled).toBe(false);
    app.el('composer').dispatchEvent(new app.w.Event('submit', { cancelable: true }));
    expect(app.el('outbox').textContent).toContain('What is on my calendar?');
    await until(() => submits === 2, 5000);
    const bodies = app.calls.filter((c) => c.path === '/api/submit').map((c) => c.body);
    expect(bodies[0].clientMessageId).toMatch(/^[0-9a-f]{24}$/);
    expect(bodies[1].clientMessageId).toBe(bodies[0].clientMessageId);
    expect(bodies[1].message).toBe('What is on my calendar?');
    // Once the PC lists the message, the phone's own copy gives way to it.
    messages = [{ id: 'u9', role: 'user', content: 'What is on my calendar?', createdAt: '2026-11-10T10:00:00Z' }];
    await until(() => app.el('outbox').children.length === 0 && app.el('messages').children.length === 1, 5000);
  });

  it('streams a reply as it is written, then reloads the conversation when it is done', async () => {
    const running = state({ running: true, attemptId: 'att-1' });
    const app = boot(paired([], { 'GET /api/state': () => ({ body: running }) }));
    const source = await goLive(app, running);
    const before = app.calls.filter((c) => c.path === '/api/messages').length;
    source.emit('token', { attemptId: 'att-1', text: 'The tide ' });
    source.emit('token', { attemptId: 'att-1', text: 'is high.' });
    // The phone connected while this reply was already being written, so it marks the missed start.
    await until(() => app.el('live').textContent === '… The tide is high.');
    expect(app.el('live').querySelector('.caret')).not.toBeNull();
    // A reply that starts while the phone is connected has no such mark.
    source.emit('token', { attemptId: 'att-2', text: 'Next.' });
    await until(() => app.el('live').textContent === '… The tide is high.Next.');
    source.emit('activity', { kind: 'result', attemptId: 'att-1', text: 'The tide is high.', summary: 'done' });
    await until(() => app.calls.filter((c) => c.path === '/api/messages').length > before);
  });
});

describe('the connection', () => {
  it('after a dropped stream it reconnects, and resyncs messages and state', async () => {
    const app = boot(paired());
    const first = await goLive(app);
    const messagesBefore = app.calls.filter((c) => c.path === '/api/messages').length;
    first.fail();
    expect(app.el('conn-pill').textContent).toBe('Reconnecting…');
    expect(app.el('banner').hidden).toBe(false);
    await until(() => app.sources.length === 2, 5000);
    app.sources[1].emit('hello', { device: { id: 'd1', name: 'Android · Chrome' }, secure: false });
    app.sources[1].emit('state', state());
    await until(() => app.el('conn-pill').textContent === 'Live');
    await until(() => app.calls.filter((c) => c.path === '/api/messages').length > messagesBefore);
    expect(app.el('banner').hidden).toBe(true);
  });

  it('coming back to the app with a dead stream reconnects at once', async () => {
    const app = boot(paired());
    const first = await goLive(app);
    first.readyState = 2;
    app.doc.dispatchEvent(new app.w.Event('visibilitychange'));
    await until(() => app.sources.length === 2, 1500);
  });

  it('a phone the PC forgot is sent back to pairing, with a plain reason', async () => {
    let pairedNow = true;
    const app = boot(paired([], {
      'GET /api/session': () => (pairedNow ? { body: { ok: true, device: { id: 'd1', name: 'Android · Chrome' } } } : { status: 401, body: { ok: false } }),
    }));
    const first = await goLive(app);
    pairedNow = false;
    first.fail();
    await until(() => !app.el('view-pair').hidden, 5000);
    expect(app.el('pair-msg').textContent).toContain('not paired any more');
    expect(app.el('tabbar').hidden).toBe(true);
  });

  it('a PC that cannot be reached at start shows what to check, and keeps trying', async () => {
    const app = boot({ 'GET /api/session': () => 'network-error' });
    await until(() => !app.el('view-offline').hidden);
    expect(app.el('conn-pill').textContent).toBe('Offline');
    expect(app.el('view-offline').textContent).toContain('Tailscale');
    const before = app.calls.length;
    await until(() => app.calls.length > before, 3000);
  });
});

describe('voice', () => {
  it('on a plain http:// link the microphone explains why it is off instead of failing', async () => {
    const app = boot(paired());
    await goLive(app);
    app.el('mic-btn').click();
    await until(() => !app.el('composer-note').hidden);
    expect(app.el('composer-note').textContent).toContain('secure link');
    expect(app.calls.some((c) => c.path === '/api/voice/transcribe')).toBe(false);
  });
});
