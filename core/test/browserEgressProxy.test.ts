import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EGRESS_CANARY_HOST, startEgressProxy, vetHost, type EgressProxy } from '../runtime/browserEgressProxy';

describe('browser egress proxy', () => {
  let proxy: EgressProxy | undefined;
  afterEach(async () => { await proxy?.close(); proxy = undefined; });

  it('refuses a name when any answer is private, and pins a public answer', async () => {
    expect(await vetHost('rebind.example', async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }])).toMatchObject({ ok: false });
    expect(await vetHost('meta.example', async () => [{ address: '169.254.169.254' }])).toMatchObject({ ok: false });
    expect(await vetHost('10.0.0.5')).toMatchObject({ ok: false });
    expect(await vetHost('nx.example', async () => { throw new Error('ENOTFOUND'); })).toMatchObject({ ok: false });
    expect(await vetHost('ok.example', async () => [{ address: '93.184.216.34' }])).toEqual({ ok: true, address: '93.184.216.34' });
  });

  it('connects only to the vetted address, so a later rebind cannot reach the private host', async () => {
    // A "rebinding" resolver: public the first time, loopback afterwards.
    let calls = 0;
    proxy = await startEgressProxy(async () => (++calls === 1 ? [{ address: '203.0.113.9' }] : [{ address: '127.0.0.1' }]));
    const connect = (host: string) => new Promise<string>((resolve) => {
      const socket = net.connect(proxy!.port, '127.0.0.1', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
      socket.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); socket.destroy(); });
      socket.on('error', () => resolve('error'));
      socket.setTimeout(3000, () => { resolve('timeout'); socket.destroy(); });
    });
    // First lookup is public: the proxy dials 203.0.113.9 (TEST-NET, unroutable), never loopback.
    await connect('rebind.example');
    // Second lookup rebinds to loopback: refused before any connection.
    expect(await connect('rebind.example')).toBe('HTTP/1.1 403 Forbidden');
    expect(proxy.drainRefusals().join(' ')).toMatch(/private or local address \(127\.0\.0\.1\)/);
  }, 10_000);

  it('answers the launch canary itself and refuses loopback forwarding', async () => {
    proxy = await startEgressProxy(async () => [{ address: '127.0.0.1' }]);
    const get = (url: string) => new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port: proxy!.port, path: url }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    });
    expect(await get(`http://${EGRESS_CANARY_HOST}/`)).toBe(204);
    expect(proxy.canarySeen).toBe(true);
    expect(await get('http://localhost:9/')).toBe(403);
  });
});
