/**
 * Deterministic intent router: recognises plain, routine operations in a task's instruction and names the existing
 * registered service (or workflow) that does them. A model is for interpretation, reasoning, planning and exceptions; listing a
 * folder, hashing a file or reading a PDF's text layer is not one of those.
 *
 * Conservative on purpose: anything that asks for explanation, judgement or change, anything ambiguous, and anything whose
 * operands cannot be named exactly returns null and goes to the model as before. Nothing here executes; the bridge dispatches
 * the chosen service through the registry, with its roots, permissions, receipt and cancellation.
 */

/** The task's own workspace folder; the bridge replaces this marker with the real path before the service runs. */
export const WORKSPACE_MARKER = '@workspace';

export type DeterministicIntent =
  | { kind: 'service'; taskClass: string; args: Record<string, unknown>; reason: string }
  | { kind: 'workflow'; workflowId: string; input: Record<string, unknown>; reason: string };

/** Words that ask for thinking or for change: the request is not a plain operation, whatever else it mentions. */
const INTERPRETATION = /\b(why|explain|summari[sz]e|analy[sz]e|compare|recommend|decide|plan|refactor|improve|review|rewrite|translate|debug|fix|implement|create|build|delete|remove|rename|move|install|uninstall|upload|send|email|post|buy|pay)\b/i;

const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>|?*]*[^\s"'`<>|?*.,;:!]/;
const QUOTED = /["'`]([^"'`]{2,260})["'`]/;

/** The operand path: a quoted or Windows path in the text, else the task's own workspace when the text says "the (authorized) workspace". */
function operandPath(text: string): string | null {
  const q = QUOTED.exec(text);
  if (q && /[\\/]|\.\w{1,6}$/.test(q[1]!)) return q[1]!;
  const w = WINDOWS_PATH.exec(text);
  if (w) return w[0];
  if (/\b(the |this |my )?(authori[sz]ed |task |current )?(workspace|folder|directory)\b/i.test(text) && /\b(authori[sz]ed|workspace)\b/i.test(text)) return WORKSPACE_MARKER;
  return null;
}

export function classifyInstruction(instruction: string): DeterministicIntent | null {
  const text = instruction.trim().replace(/\s+/g, ' ');
  if (!text || text.length > 600) return null;
  // The instruction may be (JSON) args for a service already: the existing explicit path handles that; leave it alone.
  if (text.startsWith('{')) return null;

  // Workflows by name (runs the existing router; never invents steps).
  if (/\b(daily[- ]brief|morning brief)\b/i.test(text) && !/\b(why|explain|compare|plan)\b/i.test(text)) {
    return { kind: 'workflow', workflowId: 'daily-brief', input: {}, reason: 'a daily brief is the registered daily-brief workflow: collect from Pandesh records, then an optional local-model summary' };
  }
  const wf = /\brun (?:the )?(?:workflow )?(verify[- ]file|extract[- ]document)\b/i.exec(text);
  if (wf) {
    const p = operandPath(text);
    if (p) return { kind: 'workflow', workflowId: wf[1]!.toLowerCase().replace(/\s+/g, '-'), input: { path: p }, reason: `named workflow ${wf[1]}` };
  }

  if (INTERPRETATION.test(text)) return null;

  // Service health.
  if (/\b(health ?check|service status|status of (?:the )?(?:services|pandesh|core)|is (?:ollama|kandev|pandesh|the core|the model server) (?:up|running|healthy|reachable|ok))\b/i.test(text)) {
    return { kind: 'service', taskClass: 'service.health', args: {}, reason: 'a health check reads state; nothing to interpret' };
  }

  // Tailscale connection state (read-only status; never up/down/login).
  if (/\b(?:is )?tailscale\b.*\b(?:up|connected|running|online|status|reachable)\b|\b(?:tailscale|tailnet) status\b|\bwhich (?:tailscale )?(?:peers|devices) are (?:online|connected)\b/i.test(text)) {
    return { kind: 'service', taskClass: 'network.status', args: {}, reason: 'Tailscale status is read from the local client; nothing to interpret' };
  }

  // Search over Pandesh's own records.
  const search = /\bsearch (?:my |the |pandesh'?s? )?(conversations?|chats?|notes?|second brain|brain|memory|records)(?: for| about)?\s+(.{2,120})$/i.exec(text);
  if (search) {
    const scope = /conversation|chat/i.test(search[1]!) ? 'conversations' : 'brain';
    return { kind: 'service', taskClass: 'search.records', args: { query: search[2]!.replace(/[.?!]+$/, '').trim(), scope }, reason: `full-text search of ${scope}` };
  }

  const p = operandPath(text);

  // PDF operations.
  if (/\bpdf\b/i.test(text) && p) {
    if (/\b(ocr|scanned?)\b/i.test(text)) return { kind: 'service', taskClass: 'ocr.pdf', args: { path: p }, reason: 'OCR of a PDF through the approved OCR module' };
    if (/\b(how many pages|page count|number of pages|pages? in)\b/i.test(text)) return { kind: 'service', taskClass: 'pdf.info', args: { path: p }, reason: 'page count read by Poppler' };
    if (/\b(text|extract|read|contents?)\b/i.test(text)) return { kind: 'workflow', workflowId: 'extract-document', input: { path: p }, reason: 'text layer first, OCR only if the PDF has none' };
  }

  // File type detection.
  if (p && /\b(what (?:kind|type) of file|file type|detect (?:the )?(?:file )?type|mime type|what is this file)\b/i.test(text)) {
    return { kind: 'service', taskClass: 'document.detect', args: { path: p }, reason: 'file type from content signatures' };
  }

  // Hash / checksum.
  if (p && p !== WORKSPACE_MARKER && /\b(sha-?256|sha256|hash|checksum)\b/i.test(text)) {
    return { kind: 'service', taskClass: 'filesystem.hash', args: { path: p }, reason: 'SHA-256 computed from the file bytes' };
  }

  // Metadata.
  if (p && p !== WORKSPACE_MARKER && /\b(file size|how (?:big|large)|size of|last modified|when was .* modified|metadata|file info)\b/i.test(text)) {
    return { kind: 'service', taskClass: 'filesystem.metadata', args: { path: p }, reason: 'size and times read from the file system' };
  }

  // Listing and counting.
  if (p && /\b(list|show|count|how many)\b/i.test(text) && /\b(files?|filenames?|file names?|folders?|directories|directory|entries|items)\b/i.test(text)) {
    return { kind: 'service', taskClass: 'filesystem.list', args: { path: p }, reason: 'a directory listing and its counts are computed exactly by the file system service' };
  }

  return null;
}
