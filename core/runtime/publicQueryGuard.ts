/**
 * Privacy boundary for public web search (Build 159 audit D2).
 *
 * Private content stays on the machine. Only a short, sanitized public query may be sent to a search engine, and only
 * when the user asked for public research. The audit saw two leaks of the same kind: "Read my CV from the selected
 * folder … Search the public web …" (M9) and "I've put my suppliers' price lists in this folder. Which one is cheapest …"
 * (C1) both sent the ENTIRE prompt verbatim to a public search engine, and M9 never read the CV because the research
 * scope removed every local tool.
 *
 * Pure functions; nothing here performs I/O.
 */

/** The prompt is about the user's own files, folder, documents or personal data (answerable locally). */
export function referencesLocalContent(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(?:this|the\s+selected|the\s+current|my|our|that|these|those)\s+(?:folder|directory|workspace|files?|documents?|attachments?|pdfs?|spreadsheets?|price\s*lists?|invoices?|receipts?|notes?|cv|resume|résumé|letters?|contracts?|statements?|records?)\b/i.test(text)
    || /\b(?:from|in|inside|within)\s+(?:the|this|my)\s+(?:selected\s+)?(?:folder|directory|workspace|project)\b/i.test(text)
    || /\b(?:i(?:'ve| have)\s+(?:put|placed|saved|added|uploaded|attached|dropped))\b/i.test(text)
    || /\b(?:attached|uploaded)\s+(?:file|document|pdf|cv|resume)\b/i.test(text)
    || /\b[\w-]+\.(?:pdf|docx?|xlsx?|csv|md|txt|json|pptx?)\b/i.test(text)
    // Source files and named folders are local work: "fix the bug in pricing.py in the price-tool folder" is not a
    // shopping search for prices (live demo 2026-11-09: the whole prompt was proposed as a web query).
    || /\b[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|html?|css|java|cs|go|rs|rb|php|sh|ps1|ya?ml|toml|ini|sql|ipynb)\b/i.test(text)
    || /\b(?:in|inside|within|from|under)\s+(?:the\s+)?[\w.-]+\s+(?:folder|directory|repo|repository)\b/i.test(text)
    || /\b(?:read|open|check|scan|look\s+(?:at|through))\s+(?:my|the|this)\s+(?:cv|resume|file|folder|documents?|price\s*lists?)\b/i.test(text);
}

/** The user explicitly asked for public web research (permission to search, not to send private text). */
export function explicitlyRequestsWebSearch(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(?:search|look|check|browse|research)\s+(?:on\s+)?(?:the\s+)?(?:public\s+)?(?:web|internet|online)\b|\b(?:web|internet|online)\s+(?:search|research)\b|\blook\s+(?:it\s+)?up\s+online\b|\bsearch\s+online\b/i.test(text);
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+|00)\d[\d\s/-]{6,}\d|\b0\d{2,4}[\s/-]?\d{3,}[\s/-]?\d{2,}\b/;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/;
const LOCAL_PATH = /[A-Za-z]:[\\/]|\\\\[\w.-]+\\|(?:^|\s)~?\/(?:Users|home|mnt)\//;
const CANARY = /(?:PRIVATE|CANARY)_[A-Z0-9_]+/i;
const POSTCODE_STREET = /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]+\b.*\b(?:str(?:asse|aße|\.)|weg|platz|allee)\b|\b[A-ZÄÖÜ][a-zäöüß]+(?:str(?:asse|aße|\.)|weg|platz|allee)\s+\d+/i;
/** First-person / instruction language that belongs to the user's request, not to a search. */
const PERSONAL_INSTRUCTION = /\b(?:my|me|mine|i(?:'ve|'m)?|our)\b|\b(?:keep|private|privately|confidential|selected\s+folder|this\s+folder|read\s+(?:the|my))\b/i;

export const MAX_PUBLIC_QUERY_CHARS = 120;

export type PublicQueryCheck = { ok: true; query: string } | { ok: false; reason: string };

function shingles(text: string, size = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  return out;
}

/**
 * Decides whether `query` may leave the machine. Refused when it carries personal identifiers, a local path, private
 * text read from the user's files this turn (`privateTexts`), or is (most of) the user's own message rather than a
 * search query.
 */
export function checkPublicQuery(query: string, options: { userMessage?: string | null; privateTexts?: readonly string[] } = {}): PublicQueryCheck {
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) return { ok: false, reason: 'empty query' };
  if (EMAIL.test(q)) return { ok: false, reason: 'the query contains an email address' };
  if (PHONE.test(q)) return { ok: false, reason: 'the query contains a phone number' };
  if (IBAN.test(q)) return { ok: false, reason: 'the query contains an account number' };
  if (LOCAL_PATH.test(q)) return { ok: false, reason: 'the query contains a local file path' };
  if (CANARY.test(q)) return { ok: false, reason: 'the query contains a private marker' };
  if (POSTCODE_STREET.test(q)) return { ok: false, reason: 'the query contains a street address' };
  if (q.length > MAX_PUBLIC_QUERY_CHARS) return { ok: false, reason: `the query is longer than ${MAX_PUBLIC_QUERY_CHARS} characters; send a short search query, not the request` };
  const user = (options.userMessage ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  // The (near-)verbatim message is not a search query: a query that IS most of what the user typed is refused.
  if (user && user.length > 40 && user.includes(q.toLowerCase()) && q.length >= 0.8 * user.length) {
    return { ok: false, reason: 'the query is the user\'s own message; send a short public search query instead' };
  }
  if (PERSONAL_INSTRUCTION.test(q)) return { ok: false, reason: 'the query contains personal or instruction wording (my/me/private/folder); send only the public topic' };
  for (const text of options.privateTexts ?? []) {
    if (!text) continue;
    const privateShingles = shingles(text);
    for (const shingle of shingles(q)) {
      if (privateShingles.has(shingle)) return { ok: false, reason: 'the query repeats text read from the user\'s private files' };
    }
  }
  return { ok: true, query: q };
}

/**
 * Derives a short public query from a request by dropping clauses about local files, privacy instructions and
 * first-person wording. Returns null when nothing public remains (the request is local-only).
 */
export function derivePublicQuery(requestText: string): string | null {
  const clauses = requestText
    // "Read my CV from the selected folder and help me find … jobs in Germany" → the CV clause is dropped, the job clause kept.
    .split(/(?<=[.!?;])\s+|,\s*|\s+(?:but|and(?:\s+then)?)\s+(?=(?:help|find|search|look|read|open|check|keep|tell|show|write|make|give|list|compare|summari[sz]e|then)\b)/i)
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => !referencesLocalContent(c) && !/\b(?:keep|private|privately|confidential|don'?t\s+share)\b/i.test(c));
  if (clauses.length === 0) return null;
  const cleaned = clauses
    .join(' ')
    .replace(/\b(?:please|can\s+you|could\s+you|help\s+me(?:\s+to)?|i\s+(?:want|need|would\s+like)\s+to|for\s+me|search\s+(?:the\s+)?(?:public\s+)?(?:web|internet|online)\s+for|look\s+up|find(?:\s+out)?|tell\s+me|show\s+me)\b/gi, ' ')
    .replace(/\b(?:my|me|mine|i|i'm|i've|our|us)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s€$%.+/-]/gu, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
  if (cleaned.length < 4) return null;
  const query = cleaned.slice(0, MAX_PUBLIC_QUERY_CHARS).replace(/\s+\S*$/, (tail) => (cleaned.length > MAX_PUBLIC_QUERY_CHARS ? '' : tail)).trim();
  return checkPublicQuery(query).ok ? query : null;
}
