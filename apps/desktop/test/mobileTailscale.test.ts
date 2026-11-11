import { describe, expect, it } from 'vitest';
import type * as os from 'node:os';
import { detectSecureLink, parseServeStatus, pickLanAddress, proxyTargetsPort } from '../src/host/mobileTailscale';

const HOST = 'desktop-1.tailnet-0000.ts.net';

describe('the secure link from `tailscale serve status --json`', () => {
  it('finds the HTTPS name that proxies to the phone server', () => {
    const doc = { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3030' } } } } };
    expect(parseServeStatus(doc, 3030)).toEqual({ state: 'ready', url: `https://${HOST}/`, detail: `Tailscale serves Pandesh at https://${HOST}/` });
  });

  it('reads a foreground `tailscale serve` session and a non-default HTTPS port', () => {
    const doc = { Foreground: { abc: { Web: { [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'localhost:3030' } } } } } } };
    expect(parseServeStatus(doc, 3030)).toMatchObject({ state: 'ready', url: `https://${HOST}:8443/` });
  });

  it('never offers a Funnel (public internet) address as a link', () => {
    const doc = {
      Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3030' } } } },
      AllowFunnel: { [`${HOST}:443`]: true },
    };
    expect(parseServeStatus(doc, 3030)).toMatchObject({ state: 'funnel', url: null });
  });

  it('a serve for another port or path is not Pandesh', () => {
    expect(parseServeStatus({ Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } }, 3030).state).toBe('not-serving');
    expect(parseServeStatus({ Web: { [`${HOST}:443`]: { Handlers: { '/pandesh': { Proxy: 'http://127.0.0.1:3030' } } } } }, 3030).state).toBe('not-serving');
    expect(parseServeStatus({}, 3030).detail).toContain('tailscale serve --bg http://127.0.0.1:3030');
  });

  it('matches the proxy forms Tailscale accepts, on this PC only', () => {
    expect(proxyTargetsPort('http://127.0.0.1:3030', 3030)).toBe(true);
    expect(proxyTargetsPort('http://localhost:3030', 3030)).toBe(true);
    expect(proxyTargetsPort('localhost:3030', 3030)).toBe(true);
    expect(proxyTargetsPort('3030', 3030)).toBe(true);
    expect(proxyTargetsPort('http://192.0.2.10:3030', 3030)).toBe(false);
    expect(proxyTargetsPort('http://127.0.0.1:3031', 3030)).toBe(false);
    expect(proxyTargetsPort('', 3030)).toBe(false);
  });

  it('says plainly when Tailscale is missing, stopped or serving nothing', async () => {
    const enoent = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    expect((await detectSecureLink(3030, async () => { throw enoent; })).state).toBe('not-installed');
    const stopped = Object.assign(new Error('exit 1'), { stderr: 'Tailscale is stopped.' });
    expect((await detectSecureLink(3030, async () => { throw stopped; })).state).toBe('not-running');
    expect((await detectSecureLink(3030, async () => ({ stdout: '{}\n' }))).state).toBe('not-serving');
    expect((await detectSecureLink(3030, async () => ({ stdout: 'garbage' }))).state).toBe('error');
    const ready = await detectSecureLink(3030, async (args) => {
      expect(args).toEqual(['serve', 'status', '--json']);
      return { stdout: JSON.stringify({ Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3030' } } } } }) };
    });
    expect(ready).toMatchObject({ state: 'ready', url: `https://${HOST}/` });
  });
});

describe('the home network address', () => {
  const iface = (address: string, internal = false): os.NetworkInterfaceInfo =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }) as os.NetworkInterfaceInfo;

  it('skips virtual, VPN and Tailscale adapters and prefers a private address', () => {
    expect(pickLanAddress({
      'vEthernet (Default Switch)': [iface('172.20.0.1')],
      Tailscale: [iface('100.64.0.9')],
      Ethernet: [iface('192.0.2.10'), iface('192.168.0.20')],
      'Loopback Pseudo-Interface 1': [iface('127.0.0.1', true)],
    })).toBe('192.168.0.20');
  });

  it('never picks a Tailscale (100.64/10) or link-local address under another name', () => {
    expect(pickLanAddress({ 'Wi-Fi': [iface('100.100.1.2'), iface('169.254.3.4')] })).toBeNull();
    expect(pickLanAddress({ 'Wi-Fi': [iface('100.100.1.2'), iface('10.1.2.3')] })).toBe('10.1.2.3');
  });
});
