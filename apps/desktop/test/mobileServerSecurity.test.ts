import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { openEvents, pair, rawRequest, startServer } from './mobileTestKit';
import { PAIR_CODE_TTL_MS } from '../src/host/mobilePairing';

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function server(options: Parameters<typeof startServer>[1] = {}) {
  const s = await startServer(dirs, options);
  stops.push(() => s.server.stop());
  return s;
}

describe('the page', () => {
  it('never reflects the ?pair= value (the old page wrote it into the HTML: reflected XSS)', async () => {
    const { base } = await server();
    const plain = await (await fetch(`${base}/`)).text();
    const attack = await (await fetch(`${base}/?pair=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E`)).text();
    expect(attack).toBe(plain);
    expect(attack).not.toContain('alert(1)');
  });

  it('is served with a strict CSP, no CORS, and the usual hardening headers', async () => {
    const { base } = await server();
    const res = await fetch(`${base}/`, { headers: { Origin: 'https://attacker.example' } });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('permissions-policy')).toContain('microphone=(self)');
    await res.text();
    const api = await fetch(`${base}/api/status`, { headers: { Origin: 'https://attacker.example' } });
    expect(api.headers.get('access-control-allow-origin')).toBeNull();
    await api.text();
  });

  it('serves only the app files, with the right types and revalidation', async () => {
    const { base } = await server();
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    expect(await manifest.json()).toMatchObject({ name: 'Pandesh', start_url: '/', display: 'standalone' });
    const sw = await (await fetch(`${base}/sw.js`)).text();
    expect(sw).not.toContain('__PANDESH_SHELL_VERSION__');
    expect(sw).toMatch(/var VERSION = '[0-9a-f]{16}';/);
    const icon = await fetch(`${base}/icons/icon-192.png`);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await icon.arrayBuffer()).subarray(1, 4).toString('ascii')).toBe('PNG');
    const page = await fetch(`${base}/app.js`);
    const etag = page.headers.get('etag') ?? '';
    await page.text();
    expect((await fetch(`${base}/app.js`, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    for (const p of ['/../src/main.ts', '/renderer.js', '/icons/../app.js.map', '/secret.json']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(404);
      await r.text();
    }
  });
});

describe('requests that are refused', () => {
  it('a Host that names someone else\'s domain (DNS rebinding)', async () => {
    const { port } = await server();
    expect((await rawRequest(port, { headers: { Host: 'rebind.attacker.example' } })).status).toBe(421);
    expect((await rawRequest(port, { path: '/api/status', headers: { Host: 'rebind.attacker.example:3030' } })).status).toBe(421);
    expect((await rawRequest(port, { headers: { Host: `desktop-1:${port}` } })).status).toBe(200);
  });

  it('anything that came through Tailscale Funnel (the public internet)', async () => {
    const { port } = await server();
    const r = await rawRequest(port, { path: '/api/status', headers: { Host: `127.0.0.1:${port}`, 'Tailscale-Funnel-Request': '?1' } });
    expect(r.status).toBe(403);
    expect(r.body).toContain('Funnel');
  });

  it('a POST from another site, or not sent as JSON', async () => {
    const { server: mobile, base } = await server();
    const code = mobile.getPairingInfo().code;
    const cross = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: JSON.stringify({ code }) });
    expect(cross.status).toBe(403);
    await cross.text();
    const form = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code }) });
    expect(form.status).toBe(415);
    await form.text();
    // The code was not used up by either.
    expect((await pair(base, code)).status).toBe(200);
  });

  it('a body over the limit', async () => {
    const { server: mobile, base } = await server();
    const { cookie } = await pair(base, mobile.getPairingInfo().code);
    const huge = JSON.stringify({ message: 'x'.repeat(70 * 1024) });
    const res = await fetch(`${base}/api/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: huge });
    expect(res.status).toBe(413);
    await res.text();
  });
});

describe('pairing', () => {
  it('a code works once', async () => {
    const { server: mobile, base } = await server();
    const code = mobile.getPairingInfo().code;
    expect((await pair(base, code)).status).toBe(200);
    const again = await pair(base, code);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('wrong_code');
    expect(mobile.getPairingInfo().code).not.toBe(code);
  });

  it('an expired code says so', async () => {
    let t = Date.UTC(2026, 10, 10, 12, 0, 0);
    const { server: mobile, base } = await server({ now: () => t });
    const code = mobile.getPairingInfo().code;
    t += PAIR_CODE_TTL_MS + 1;
    const r = await pair(base, code);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'code_expired' });
  });

  it('five wrong codes, then 429 with Retry-After, even for the right code', async () => {
    const { server: mobile, base, logs } = await server();
    for (let i = 0; i < 5; i += 1) expect((await pair(base, 'ZZZZ-ZZZZ')).status).toBe(401);
    const blocked = await pair(base, mobile.getPairingInfo().code);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_attempts');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(logs.filter((l) => l.startsWith('[MOBILE] pair refused'))).toHaveLength(6);
  });

  it('too many wrong codes in total pause pairing for everyone; the owner can allow it again', async () => {
    const limits = { perClient: 100, perClientWindowMs: 60_000, total: 3, totalWindowMs: 60_000, pauseMs: 60_000 };
    const { server: mobile, base } = await server({ pairLimits: limits });
    for (let i = 0; i < 3; i += 1) await pair(base, 'ZZZZ-ZZZZ');
    const paused = await pair(base, mobile.getPairingInfo().code);
    expect(paused.status).toBe(429);
    expect(paused.body.error).toBe('pairing_paused');
    expect((await mobile.getPairingView()).pairingPausedUntil).not.toBeNull();
    mobile.resumePairing();
    expect((await pair(base, mobile.getPairingInfo().code)).status).toBe(200);
  });

  it('forgetting a phone on the PC ends its live connection and its access at once', async () => {
    const { server: mobile, base, port } = await server();
    const { cookie } = await pair(base, mobile.getPairingInfo().code);
    const events = await openEvents(port, cookie);
    await events.waitFor((e) => e.event === 'hello');
    const [device] = (await mobile.getPairingView()).devices;
    expect(device.connected).toBe(true);
    expect(mobile.forgetDevice(device.id)).toBe(1);
    await events.closed;
    expect((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('a phone can unpair itself', async () => {
    const { server: mobile, base } = await server();
    const { cookie } = await pair(base, mobile.getPairingInfo().code);
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    await out.text();
    expect((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await mobile.getPairingView()).devices).toHaveLength(0);
  });

  it('over the Tailscale proxy (HTTPS) the cookie is Secure and the session says so', async () => {
    const { server: mobile, port } = await server();
    const host = 'desktop-1.tailnet-0000.ts.net';
    const proxied = { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.9', 'Content-Type': 'application/json', Origin: `https://${host}` };
    const r = await rawRequest(port, { method: 'POST', path: '/api/pair', headers: proxied, body: JSON.stringify({ code: mobile.getPairingInfo().code }) });
    expect(r.status).toBe(200);
    const setCookie = String(r.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('; Secure');
    const cookie = setCookie.split(';')[0];
    const s = await rawRequest(port, { path: '/api/session', headers: { Host: host, 'X-Forwarded-Proto': 'https', Cookie: cookie } });
    expect(JSON.parse(s.body)).toMatchObject({ ok: true, secure: true });
  });
});

describe('the PC\'s view of pairing', () => {
  it('carries the secure link with the code when Tailscale serves Pandesh, and never a session token', async () => {
    const { server: mobile, base } = await server({ secureLink: async () => ({ state: 'ready', url: 'https://desktop-1.tailnet-0000.ts.net/', detail: 'ok' }) });
    const { cookie } = await pair(base, mobile.getPairingInfo().code);
    const view = await mobile.getPairingView();
    expect(view.secureUrl).toBe(`https://desktop-1.tailnet-0000.ts.net/?pair=${view.code}`);
    expect(view.devices).toHaveLength(1);
    expect(view.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const token = decodeURIComponent(cookie.slice('kkd_session='.length));
    expect(JSON.stringify(view)).not.toContain(token);
    expect(Object.keys(view)).not.toContain('token');
    // A loopback-only server has no home Wi-Fi link to offer.
    expect(view.url).toBe('');
  });
});
