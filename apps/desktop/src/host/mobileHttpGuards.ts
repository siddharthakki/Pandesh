/**
 * Request checks for Pandesh Mobile that do not depend on the session.
 *
 * - Host: a web page anywhere can point its own domain at this PC's address (DNS rebinding) and then talk to this
 *   server as "same origin" from any browser on the network. Such requests carry the attacker's domain in Host, so
 *   only addresses and local names are accepted: IP literals, localhost, single-label and local-only names, and a
 *   Tailscale name when the request came through the local `tailscale serve` proxy.
 * - Origin: a state-changing request from a page on another origin is refused (no CORS is offered either).
 * - Tailscale Funnel would publish this server on the public internet; requests that arrive through it are refused.
 */
import type * as http from 'node:http';
import * as net from 'node:net';

const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost'];

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, '');
  return a === '::1' || a === 'localhost' || /^127\./.test(a);
}

/** Host header → bare lower-case host name (no port, no IPv6 brackets), or null when malformed. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    const inner = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return net.isIP(inner) === 6 ? inner : null;
  }
  const colon = raw.lastIndexOf(':');
  const name = colon >= 0 && /^\d{1,5}$/.test(raw.slice(colon + 1)) ? raw.slice(0, colon) : raw;
  if (!name || name.includes(':') || name.includes('/') || name.includes('@')) return null;
  return name.replace(/\.$/, '');
}

export function isAllowedHost(
  hostHeader: string | undefined,
  opts: { viaLocalProxy: boolean; extraHosts?: readonly string[] },
): boolean {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost') return true;
  if (opts.extraHosts?.some((h) => h.trim().toLowerCase() === name)) return true;
  // Public DNS names always contain a dot; a rebinding attacker needs one.
  if (!name.includes('.')) return /^[a-z0-9-]{1,63}$/.test(name);
  if (LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return true;
  // MagicDNS names: only through the local Tailscale proxy, which is what serves them.
  if (name.endsWith('.ts.net')) return opts.viaLocalProxy;
  return false;
}

/** The requests the local proxy forwarded: from loopback, with forwarding headers. */
export function cameThroughLocalProxy(req: http.IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && (
    typeof req.headers['x-forwarded-for'] === 'string'
    || typeof req.headers['x-forwarded-proto'] === 'string'
    || typeof req.headers['x-forwarded-host'] === 'string'
  );
}

/** HTTPS between the phone and the proxy (`tailscale serve`); this server itself only speaks HTTP. */
export function isSecureRequest(req: http.IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/**
 * Who is asking, for rate limiting. Behind the local proxy every request comes from loopback, so the proxy's own
 * X-Forwarded-For entry (the last one; earlier ones are whatever the client sent) names the phone.
 */
export function clientAddress(req: http.IncomingMessage): string {
  const remote = String(req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/i, '');
  if (!isLoopbackAddress(remote)) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : remote;
}

export function isFunnelRequest(req: http.IncomingMessage): boolean {
  return req.headers['tailscale-funnel-request'] !== undefined;
}

/** A state-changing request must come from this server's own pages: no Origin, or one naming this host. */
export function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [req.headers.host];
  if (isLoopbackAddress(req.socket.remoteAddress)) hosts.push(String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim());
  return hosts.some((h) => typeof h === 'string' && h.trim().toLowerCase() === originHost);
}

export function hasContentType(req: http.IncomingMessage, ...types: string[]): boolean {
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return types.includes(ct);
}

/** Sent on every response. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** The app page: only its own scripts, styles, images and connections. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const PAGE_PERMISSIONS_POLICY = 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()';
