/** Normalize a research link before handing it to the OS browser. The
 * renderer cannot request file:, custom protocols, credentials, or local
 * network targets through this channel. */
export function normalizeSafeExternalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('This source link is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Only credential-free HTTPS source links can be opened');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('Local and private-network links cannot be opened here');
  }
  return url.toString();
}

/** Normalize a URL before handing it to the OS browser for launching.
 * Allows safe http: and https: protocols, including local companion/studio services,
 * but forbids credentials and dangerous protocols like file:, javascript:, data:, etc. */
export function normalizeSafeBrowserUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('This link is invalid');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('Only credential-free HTTP and HTTPS links can be opened');
  }
  return url.toString();
}
