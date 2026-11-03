/**
 * Which hosts the host-managed browser may open.
 *
 * One rule, two enforcement points: the Core policy layer decides whether a
 * browser action is allowed at all (before an approval is even requested),
 * and the browser capability decides whether it may actually navigate. They
 * must agree, so the rule lives here once.
 *
 * The browser may open a page that already runs on this machine — the Core's
 * own API, a local app the user started — because driving a real browser is
 * the point. It may NOT open an arbitrary internet URL: the browser runs
 * without a sandbox against a throwaway profile on the user's own machine,
 * so an unbounded URL would be an agent-controlled fetch of the open web.
 */
export const LOOPBACK_BROWSER_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** The hosts the operator explicitly allowed, from `KARKEDIKHA_BROWSER_ALLOWED_HOSTS`. */
export function browserAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.KARKEDIKHA_BROWSER_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export type BrowserTargetUrl =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: string };

/**
 * Resolves a live page URL, or explains why the host is not authorized.
 */
export function resolveBrowserTargetUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): BrowserTargetUrl {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'url is required' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'url must be an absolute http(s) URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `only http and https URLs can be opened (got '${parsed.protocol}')` };
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = browserAllowedHosts(env);
  if (!LOOPBACK_BROWSER_HOSTS.includes(host) && !allowed.includes(host)) {
    return {
      ok: false,
      reason: `host '${host}' is not an authorized browser target; the browser may open loopback pages, or a host listed in KARKEDIKHA_BROWSER_ALLOWED_HOSTS`,
    };
  }
  return { ok: true, url: parsed.toString(), host };
}

/**
 * True for any address the open-web browser must never reach: loopback,
 * private, link-local (including cloud metadata), CGNAT, multicast,
 * unspecified and IPv6 unique-local, plus IPv4-mapped forms of those.
 */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isNonPublicAddress(mapped[1]);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (ip.includes(':')) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return true;
}

/**
 * Parses a URL the open-web browser session may navigate to. Only public
 * http(s) hosts qualify: loopback/private names and IP literals, embedded
 * credentials and every other scheme are refused. DNS is checked separately
 * (and again per request) by the session's network guard.
 */
export function resolvePublicWebUrl(rawUrl: string): BrowserTargetUrl {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'url is required' };
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: 'url must be an absolute http(s) URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `only http and https URLs can be opened (got '${parsed.protocol}')` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
  if (LOOPBACK_BROWSER_HOSTS.includes(host) || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || !host.includes('.') || (isIpLiteral && isNonPublicAddress(host))) {
    return { ok: false, reason: `host '${host}' is a local or private-network address; the web browser only opens public sites` };
  }
  return { ok: true, url: parsed.toString(), host };
}

/** The site key a domain approval covers: the host without a leading 'www.'. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}
