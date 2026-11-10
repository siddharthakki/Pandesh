import { describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import { PairAttemptLimiter } from '../src/host/mobileRateLimit';
import {
  clientAddress,
  hostnameOf,
  isAllowedHost,
  isFunnelRequest,
  isSecureRequest,
  originAllowed,
} from '../src/host/mobileHttpGuards';

function req(headers: Record<string, string>, remoteAddress = '192.0.2.50'): http.IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as http.IncomingMessage;
}

describe('pairing attempts are limited per client and in total', () => {
  const limits = { perClient: 5, perClientWindowMs: 5 * 60_000, total: 20, totalWindowMs: 15 * 60_000, pauseMs: 15 * 60_000 };

  it('five wrong codes from one client, then a wait; a success clears that client', () => {
    let t = 0;
    const lim = new PairAttemptLimiter(limits, () => t);
    for (let i = 0; i < 5; i += 1) {
      expect(lim.check('a').allowed).toBe(true);
      lim.recordFailure('a');
      t += 1000;
    }
    const gate = lim.check('a');
    expect(gate).toMatchObject({ allowed: false, reason: 'client' });
    if (!gate.allowed) expect(gate.retryAfterMs).toBeGreaterThan(4 * 60_000);
    expect(lim.check('b').allowed).toBe(true);
    t += 5 * 60_000;
    expect(lim.check('a').allowed).toBe(true);
    lim.recordFailure('a');
    lim.recordSuccess('a');
    expect(lim.check('a').allowed).toBe(true);
  });

  it('twenty wrong codes in total pause pairing for everyone until the owner allows it again', () => {
    let t = 0;
    const lim = new PairAttemptLimiter(limits, () => t);
    for (let i = 0; i < 20; i += 1) { lim.recordFailure(`client-${i}`); t += 100; }
    expect(lim.check('someone-new')).toMatchObject({ allowed: false, reason: 'paused' });
    expect(lim.pausedUntilMs()).toBeGreaterThan(t);
    lim.resume();
    expect(lim.pausedUntilMs()).toBeNull();
    expect(lim.check('someone-new').allowed).toBe(true);
  });

  it('the pause ends by itself', () => {
    let t = 0;
    const lim = new PairAttemptLimiter(limits, () => t);
    for (let i = 0; i < 20; i += 1) lim.recordFailure(`c${i}`);
    t += 15 * 60_000 + 1;
    expect(lim.check('x').allowed).toBe(true);
  });
});

describe('Host check (DNS rebinding)', () => {
  it('reads the host name out of the Host header', () => {
    expect(hostnameOf('192.0.2.10:3030')).toBe('192.0.2.10');
    expect(hostnameOf('[::1]:3030')).toBe('::1');
    expect(hostnameOf('Desktop-1.local.')).toBe('desktop-1.local');
    expect(hostnameOf('')).toBeNull();
    expect(hostnameOf('[nope]')).toBeNull();
    expect(hostnameOf('a@b')).toBeNull();
  });

  it('accepts addresses, localhost and local names; refuses public names', () => {
    const lan = { viaLocalProxy: false };
    for (const ok of ['192.0.2.10:3030', '127.0.0.1:3030', '[::1]:3030', 'localhost:3030', 'desktop-1:3030', 'desktop-1.local', 'pc.lan', 'pc.home.arpa', 'pc.internal']) {
      expect(isAllowedHost(ok, lan)).toBe(true);
    }
    for (const bad of ['attacker.example:3030', 'rebind.example.com', 'evil.ts.net.example.com', undefined, '']) {
      expect(isAllowedHost(bad, lan)).toBe(false);
    }
  });

  it('accepts a Tailscale name only through the local proxy', () => {
    expect(isAllowedHost('desktop-1.tailnet-0000.ts.net', { viaLocalProxy: true })).toBe(true);
    expect(isAllowedHost('desktop-1.tailnet-0000.ts.net', { viaLocalProxy: false })).toBe(false);
  });

  it('accepts extra names the owner configured', () => {
    expect(isAllowedHost('pandesh.example', { viaLocalProxy: false, extraHosts: ['pandesh.example'] })).toBe(true);
  });
});

describe('Origin, client address, HTTPS and Funnel', () => {
  it('a POST from another site is refused; this server\'s own page is accepted', () => {
    expect(originAllowed(req({ host: '192.0.2.10:3030' }))).toBe(true);
    expect(originAllowed(req({ host: '192.0.2.10:3030', origin: 'http://192.0.2.10:3030' }))).toBe(true);
    expect(originAllowed(req({ host: '192.0.2.10:3030', origin: 'https://attacker.example' }))).toBe(false);
    expect(originAllowed(req({ host: '192.0.2.10:3030', origin: 'null' }))).toBe(false);
    expect(originAllowed(req({ host: '192.0.2.10:3030', origin: 'not a url' }))).toBe(false);
  });

  it('behind the local proxy, the forwarded host counts as this server', () => {
    const viaProxy = { host: '127.0.0.1:3030', origin: 'https://desktop-1.tailnet-0000.ts.net', 'x-forwarded-host': 'desktop-1.tailnet-0000.ts.net' };
    expect(originAllowed(req(viaProxy, '127.0.0.1'))).toBe(true);
    // A forwarded host from anywhere else is not trusted.
    expect(originAllowed(req(viaProxy, '192.0.2.50'))).toBe(false);
  });

  it('rate limits by the proxy\'s own X-Forwarded-For entry, and only behind loopback', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '198.51.100.7' }, '192.0.2.50'))).toBe('192.0.2.50');
    expect(clientAddress(req({ 'x-forwarded-for': 'spoofed, 100.64.0.9' }, '127.0.0.1'))).toBe('100.64.0.9');
    expect(clientAddress(req({}, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
  });

  it('HTTPS only through the local proxy; Funnel requests are recognised', () => {
    expect(isSecureRequest(req({ 'x-forwarded-proto': 'https' }, '127.0.0.1'))).toBe(true);
    expect(isSecureRequest(req({ 'x-forwarded-proto': 'https' }, '192.0.2.50'))).toBe(false);
    expect(isSecureRequest(req({}, '127.0.0.1'))).toBe(false);
    expect(isFunnelRequest(req({ 'tailscale-funnel-request': '?1' }))).toBe(true);
    expect(isFunnelRequest(req({}))).toBe(false);
  });
});
