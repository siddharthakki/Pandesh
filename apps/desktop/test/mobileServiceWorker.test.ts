import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const swSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile', 'sw.js'), 'utf8').replace('__PANDESH_SHELL_VERSION__', 'v1test');
const ORIGIN = 'https://desktop-1.tailnet-0000.ts.net';

/** A same-origin response as a browser hands it to the worker (type 'basic'; Node's own Response says 'default'). */
function basic(body: string, status = 200): Response {
  const res = new Response(body, { status });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

function loadWorker(network: (req: { url: string }) => Promise<Response>) {
  const listeners: Record<string, (e: any) => void> = {};
  const stores = new Map<string, Map<string, Response>>([['pandesh-shell-old', new Map()], ['someone-else', new Map()]]);
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      addAll: vi.fn(async (reqs: Array<{ url: string }>) => { for (const r of reqs) store.set(new URL(r.url, ORIGIN).pathname, new Response('cached')); }),
      put: vi.fn(async (key: string, res: Response) => { store.set(key, res); }),
    };
  };
  const caches = {
    open: vi.fn(async (name: string) => cacheFor(name)),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async (key: string) => { for (const s of stores.values()) if (s.has(key)) return s.get(key); return undefined; }),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  class FakeRequest { url: string; constructor(url: string) { this.url = new URL(url, ORIGIN).href; } }
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', swSource)(self, caches, network, FakeRequest, Response, URL);
  const fetchEvent = (url: string, init: { method?: string; mode?: string } = {}) => {
    let responded: Promise<Response> | null = null;
    listeners.fetch({ request: { url: new URL(url, ORIGIN).href, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }, respondWith: (p: Promise<Response>) => { responded = p; } });
    return responded as Promise<Response> | null;
  };
  return { listeners, stores, caches, fetchEvent };
}

describe('the phone app service worker', () => {
  it('caches the app shell on install, and only the shell', async () => {
    const w = loadWorker(async () => new Response('net'));
    let done: Promise<unknown> = Promise.resolve();
    w.listeners.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    const shell = [...w.stores.get('pandesh-shell-v1test')!.keys()];
    expect(shell).toEqual(expect.arrayContaining(['/', '/app.js', '/lib.js', '/app.css', '/manifest.webmanifest']));
    expect(shell.some((p) => p.startsWith('/api/'))).toBe(false);
  });

  it('never answers for /api/: conversations, approvals, audio and pairing always go to the PC', () => {
    const w = loadWorker(async () => new Response('net'));
    for (const p of ['/api/messages', '/api/state', '/api/events', '/api/artifacts/a1/content']) expect(w.fetchEvent(p)).toBeNull();
    expect(w.fetchEvent('/api/artifacts/a1/content', { mode: 'navigate' })).toBeNull();
    expect(w.fetchEvent('/api/pair', { method: 'POST' })).toBeNull();
    expect(w.fetchEvent('https://elsewhere.example/app.js')).toBeNull();
  });

  it('a pairing link is cached as the plain page, so no code is ever stored', async () => {
    const w = loadWorker(async () => basic('<html>page</html>'));
    const res = w.fetchEvent('/?pair=ABCD-EFGH', { mode: 'navigate' });
    expect(res).not.toBeNull();
    expect(await (await res!).text()).toBe('<html>page</html>');
    await new Promise((r) => setTimeout(r, 0));
    const keys = [...w.stores.get('pandesh-shell-v1test')!.keys()];
    expect(keys).toEqual(['/']);
    expect(keys.join()).not.toContain('pair');
  });

  it('offline, the cached shell opens (and says it cannot reach the PC from there)', async () => {
    const w = loadWorker(async () => { throw new TypeError('offline'); });
    w.stores.set('pandesh-shell-v1test', new Map([['/', new Response('cached page')]]));
    expect(await (await w.fetchEvent('/', { mode: 'navigate' }))!.text()).toBe('cached page');
    const missing = await w.fetchEvent('/app.css');
    expect(missing!.status).toBe(503);
  });

  it('a new build drops the old shell cache and nothing else', async () => {
    const w = loadWorker(async () => new Response('net'));
    let done: Promise<unknown> = Promise.resolve();
    w.listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(w.caches.delete).toHaveBeenCalledWith('pandesh-shell-old');
    expect(w.caches.delete).not.toHaveBeenCalledWith('someone-else');
  });
});
