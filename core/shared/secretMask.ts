/**
 * Masks credentials that show up inside text a person may see (a command line, a page or file excerpt, a diff, a
 * URL). Display safety, not a security boundary: it removes the common shapes of tokens and passwords so a preview
 * never repeats one, and says so. It never changes text that holds none.
 *
 * Shared by the activity sanitizer (so new records are clean) and the window (so records saved earlier are clean too).
 */
const MASK = '••••';

const RULES: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, `Bearer ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, MASK],
  [/\b(?:sk-or-v1-|sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, MASK],
  // user:password@host inside a URL
  [/(:\/\/[^\s/:@]+):([^\s/@]+)@/g, (_m, head: string) => `${head}:${MASK}@`],
  // ?token=..., &api_key=... in a URL
  [/([?&](?:access_token|refresh_token|id_token|token|api_?key|key|secret|password|client_secret|code)=)[^&\s"']+/gi, (_m, head: string) => `${head}${MASK}`],
  // Authorization: ..., password = ..., api_key: "...", TOKEN=...
  [/\b((?:authorization|x-api-key|api[-_ ]?key|apikey|client[-_]?secret|secret|access[-_]?token|refresh[-_]?token|token|passw(?:or)?d|pwd)\s*["']?\s*[:=]\s*["']?)(?!Bearer\s)[^\s"',;&]{4,}/gi, (_m, head: string) => `${head}${MASK}`],
];

export interface MaskedText { text: string; masked: boolean }

export function maskSecrets(input: string): MaskedText {
  let text = input;
  let masked = false;
  for (const [re, to] of RULES) {
    text = text.replace(re, (...args) => {
      masked = true;
      return typeof to === 'string' ? to : to(args[0] as string, ...(args.slice(1) as string[]));
    });
  }
  return { text, masked };
}

/** Convenience for places that only need the clean text. */
export const masked = (input: string): string => maskSecrets(input).text;
