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
