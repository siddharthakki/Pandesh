/**
 * ArtifactInput: one contract for everything a person hands to the agent (files, dropped files, pasted images, screenshots).
 *
 * Replaces per-type attachment handling with a single classification table, limits and rejection messages, so every host
 * (VS Code today, JARVIS later) accepts and explains inputs the same way. An input never claims more than was verified:
 * extracted text exists only when an extractor produced it, `requiresVision` follows the *content* type, and the hash and
 * provenance are recorded at capture time.
 */
export type InputType = 'code' | 'text' | 'markdown' | 'json' | 'csv' | 'log' | 'image' | 'pdf' | 'document' | 'audio' | 'unknown';
/** The Core attachment kind an input maps to. */
export type CoreAttachmentKind = 'text' | 'image' | 'document' | 'audio';

export interface InputSupportEntry { type: InputType; mimeType: string; kind: CoreAttachmentKind; language?: string }

const code = (language: string, mime = 'text/plain'): InputSupportEntry => ({ type: 'code', mimeType: mime, kind: 'text', language });
const text = (type: InputType, mime: string): InputSupportEntry => ({ type, mimeType: mime, kind: 'text' });

/** Single source of truth for what can be attached today. A format listed here must have real handling in Core. */
export const INPUT_SUPPORT: Readonly<Record<string, InputSupportEntry>> = {
  '.ts': code('typescript'), '.tsx': code('typescript'), '.js': code('javascript'), '.jsx': code('javascript'), '.mjs': code('javascript'), '.cjs': code('javascript'),
  '.py': code('python'), '.java': code('java'), '.kt': code('kotlin'), '.c': code('c'), '.h': code('c'), '.cpp': code('cpp'), '.hpp': code('cpp'), '.cs': code('csharp'),
  '.go': code('go'), '.rs': code('rust'), '.rb': code('ruby'), '.php': code('php'), '.swift': code('swift'), '.sh': code('shell'), '.ps1': code('powershell'),
  '.sql': code('sql'), '.html': code('html'), '.css': code('css'), '.xml': code('xml'), '.yaml': code('yaml'), '.yml': code('yaml'), '.toml': code('toml'),
  '.txt': text('text', 'text/plain'), '.md': text('markdown', 'text/markdown'), '.markdown': text('markdown', 'text/markdown'),
  '.json': text('json', 'application/json'), '.csv': text('csv', 'text/csv'), '.log': text('log', 'text/plain'),
  '.png': { type: 'image', mimeType: 'image/png', kind: 'image' }, '.jpg': { type: 'image', mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { type: 'image', mimeType: 'image/jpeg', kind: 'image' }, '.gif': { type: 'image', mimeType: 'image/gif', kind: 'image' }, '.webp': { type: 'image', mimeType: 'image/webp', kind: 'image' },
  '.pdf': { type: 'pdf', mimeType: 'application/pdf', kind: 'document' },
  '.docx': { type: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' },
  '.wav': { type: 'audio', mimeType: 'audio/wav', kind: 'audio' }, '.mp3': { type: 'audio', mimeType: 'audio/mpeg', kind: 'audio' },
  '.ogg': { type: 'audio', mimeType: 'audio/ogg', kind: 'audio' }, '.flac': { type: 'audio', mimeType: 'audio/flac', kind: 'audio' },
};

export const INPUT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFilesPerMessage: 8,
  /** Dropped/pasted bytes cross the webview boundary, so they are held to a tighter bound than files read from disk. */
  maxDroppedBytes: 5 * 1024 * 1024,
} as const;

export interface ArtifactInput {
  id: string;
  name: string;
  type: InputType;
  mimeType: string;
  origin: { kind: 'file' | 'dropped' | 'clipboard' | 'screenshot' | 'generated' | 'url'; ref?: string };
  size: number;
  /** Where the original lives (path or URI), when it has a stable home. */
  reference?: string;
  permissions: { read: boolean; write: boolean };
  language?: string;
  /** Present only when an extractor actually produced text. */
  extractedText?: string;
  /** Present for images that travel as bytes. */
  binary?: { encoding: 'base64'; data: string };
  hash?: string;
  provenance: { source: string; capturedAt: string };
  requiresVision: boolean;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function classifyInput(name: string): InputSupportEntry | undefined {
  return INPUT_SUPPORT[extensionOf(name)];
}

export type InputCheck = { ok: true; support: InputSupportEntry } | { ok: false; message: string };

/** Pure admission check with a message a person can act on. Content sniffing still happens in Core from the bytes. */
export function checkInput(name: string, size: number, options: { dropped?: boolean; countInMessage?: number } = {}): InputCheck {
  const support = classifyInput(name);
  if (!support) {
    const ext = extensionOf(name);
    return { ok: false, message: `${ext ? `"${ext}" files are` : 'Files without an extension are'} not supported yet. Supported: code and text files, Markdown, JSON, CSV, logs, images (PNG/JPEG/GIF/WebP), PDF and DOCX documents, and WAV/MP3/OGG/FLAC audio.` };
  }
  if (size <= 0) return { ok: false, message: `${name} is empty.` };
  const limit = options.dropped ? INPUT_LIMITS.maxDroppedBytes : INPUT_LIMITS.maxBytes;
  if (size > limit) return { ok: false, message: `${name} is ${(size / 1048576).toFixed(1)} MB; the limit is ${limit / 1048576} MB${options.dropped ? ' for dropped files (use the attach button for larger ones)' : ''}.` };
  if ((options.countInMessage ?? 0) >= INPUT_LIMITS.maxFilesPerMessage) return { ok: false, message: `At most ${INPUT_LIMITS.maxFilesPerMessage} files can be attached to one message.` };
  return { ok: true, support };
}

export function buildInput(args: {
  id: string; name: string; size: number; support: InputSupportEntry; origin: ArtifactInput['origin'];
  reference?: string; hash?: string; extractedText?: string; base64?: string; writable?: boolean; now?: () => Date;
}): ArtifactInput {
  return {
    id: args.id,
    name: args.name,
    type: args.support.type,
    mimeType: args.support.mimeType,
    origin: args.origin,
    size: args.size,
    ...(args.reference ? { reference: args.reference } : {}),
    permissions: { read: true, write: args.writable === true },
    ...(args.support.language ? { language: args.support.language } : {}),
    ...(args.extractedText !== undefined ? { extractedText: args.extractedText } : {}),
    ...(args.base64 ? { binary: { encoding: 'base64' as const, data: args.base64 } } : {}),
    ...(args.hash ? { hash: args.hash } : {}),
    provenance: { source: args.origin.kind, capturedAt: (args.now?.() ?? new Date()).toISOString() },
    requiresVision: args.support.type === 'image',
  };
}

export interface InputRequirements { requiresVision: boolean; needsExtraction: boolean; count: number }

/** What a set of inputs demands of routing. A single image makes the whole turn require a vision-capable model. */
export function inputRequirements(inputs: ReadonlyArray<Pick<ArtifactInput, 'type' | 'requiresVision'>>): InputRequirements {
  return {
    requiresVision: inputs.some(i => i.requiresVision),
    needsExtraction: inputs.some(i => i.type === 'pdf' || i.type === 'document' || i.type === 'audio'),
    count: inputs.length,
  };
}

/** The supported extensions grouped for a file picker. */
export function pickerFilters(): Record<string, string[]> {
  const group = (types: InputType[]): string[] => Object.entries(INPUT_SUPPORT).filter(([, v]) => types.includes(v.type)).map(([ext]) => ext.slice(1));
  return {
    'Text & Code': group(['code', 'text', 'markdown', 'json', 'csv', 'log']),
    Images: group(['image']),
    Documents: group(['pdf', 'document']),
    Audio: group(['audio']),
    'All Files': ['*'],
  };
}
