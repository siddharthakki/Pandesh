/**
 * Core-owned egress proxy for the open-web browser.
 *
 * The browser is launched with this proxy as its only route out, so the
 * browser never resolves a host itself. For every connection the proxy
 * resolves the name once, refuses it unless every answer is public, and then
 * connects to that exact vetted address. A name that rebinds to a private
 * address after the check has no second lookup to exploit.
 *
 * Fail closed: anything the proxy does not understand is refused.
 */
import http from 'node:http';
import net from 'node:net';
import { promises as dns } from 'node:dns';
import { isNonPublicAddress } from './browserHostPolicy';

/** A host the browser fetches once at launch to prove traffic flows through here. */
export const EGRESS_CANARY_HOST = 'kdk-egress-check.invalid';

export type VettedAddress = { ok: true; address: string } | { ok: false; reason: string };
export type EgressResolver = (host: string) => Promise<Array<{ address: string }>>;

const defaultResolver: EgressResolver = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Resolves a host and returns one address to connect to, only if every answer is public. */
export async function vetHost(host: string, resolve: EgressResolver = defaultResolver): Promise<VettedAddress> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    return isNonPublicAddress(bare) ? { ok: false, reason: `${bare} is a private or local address` } : { ok: true, address: bare };
  }
  let answers: Array<{ address: string }>;
  try {
    answers = await resolve(bare);
  } catch {
    return { ok: false, reason: `${bare} could not be resolved` };
  }
  if (!answers.length) return { ok: false, reason: `${bare} could not be resolved` };
  const bad = answers.find((a) => isNonPublicAddress(a.address));
  if (bad) return { ok: false, reason: `${bare} resolves to a private or local address (${bad.address})` };
  return { ok: true, address: answers[0].address };
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1].toLowerCase(), port };
}

export interface EgressProxy {
  port: number;
  /** True once the browser's canary request has arrived through the proxy. */
  readonly canarySeen: boolean;
  /** Plain-words reasons for connections the proxy refused, drained by the caller. */
  drainRefusals(): string[];
  close(): Promise<void>;
}

export async function startEgressProxy(resolve: EgressResolver = defaultResolver): Promise<EgressProxy> {
  let canarySeen = false;
  let refusals: string[] = [];
  const sockets = new Set<net.Socket>();
  const refuse = (reason: string) => { refusals.push(reason); };

  const server = http.createServer(async (req, res) => {
    // Plain-http forward proxying: the request line carries an absolute URL.
    let target: URL;
    try {
      target = new URL(String(req.url ?? ''));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.hostname === EGRESS_CANARY_HOST) {
      canarySeen = true;
      res.writeHead(204).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(403).end();
      return;
    }
    const vetted = await vetHost(target.hostname, resolve);
    if (!vetted.ok) {
      refuse(vetted.reason);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by Pandesh network guard');
      return;
    }
    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request({
      host: vetted.address,
      port: Number(target.port || 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    const authority = splitHostPort(String(req.url ?? ''), 443);
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const vetted = await vetHost(authority.host, resolve);
    if (!vetted.ok) {
      refuse(vetted.reason);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    // Connect to the address that was vetted, never to the name again.
    const upstream = net.connect(authority.port, vetted.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    upstream.on('error', () => client.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('egress proxy did not bind');
  }
  return {
    port: address.port,
    get canarySeen() { return canarySeen; },
    drainRefusals() {
      const out = refusals;
      refusals = [];
      return out;
    },
    close: () => new Promise<void>((done) => {
      for (const s of sockets) s.destroy();
      server.close(() => done());
    }),
  };
}
