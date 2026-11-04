/**
 * Deterministic file classification for PC organization. Pure: every input (name, size, dates, the first bytes, and —
 * only when the person authorized content reading — a little extracted text) is passed in, so the same file always gets
 * the same category and the tests need no disk.
 *
 * The categories are suggestions for a hierarchy, not hardcoded paths: `destinationFor` maps a category to a folder
 * under the plan's target base, and the person can rename or drop any of them before approving.
 */

export type FileCategory =
  | 'tax' | 'invoices' | 'banking' | 'insurance' | 'contracts' | 'identity' | 'health' | 'housing'
  | 'career' | 'business' | 'ai_models' | 'ai_data' | 'experiments' | 'photos' | 'videos' | 'audio'
  | 'installers' | 'archives' | 'documents' | 'temporary' | 'system' | 'unknown';

export type DetectedType =
  | 'pdf' | 'zip' | 'office_openxml' | 'office_legacy' | 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'mp4' | 'mov' | 'avi' | 'mkv'
  | 'mp3' | 'wav' | 'flac' | 'ogg' | 'exe' | 'msi' | '7z' | 'rar' | 'gzip' | 'gguf' | 'safetensors' | 'text' | 'html' | 'unknown';

/** Identifies a file from its first bytes. Extension-independent, so a renamed or mislabelled file is still recognized. */
export function detectType(head: Uint8Array, ext: string): DetectedType {
  const b = head;
  const ascii = (from: number, len: number) => String.fromCharCode(...Array.from(b.slice(from, from + len)));
  if (b.length >= 4 && ascii(0, 4) === '%PDF') return 'pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) {
    return /^\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(ext) ? 'office_openxml' : 'zip';
  }
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return /^\.msi$/i.test(ext) ? 'msi' : 'office_legacy';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (b.length >= 4 && ascii(0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF') {
    const kind = ascii(8, 4);
    if (kind === 'WEBP') return 'webp';
    if (kind === 'WAVE') return 'wav';
    if (kind === 'AVI ') return 'avi';
  }
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'heic';
    if (brand === 'qt  ') return 'mov';
    return 'mp4';
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'mkv';
  if (b.length >= 3 && (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return 'mp3';
  if (b.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac';
  if (b.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg';
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'exe';
  if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '7z';
  if (b.length >= 4 && ascii(0, 4) === 'Rar!') return 'rar';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length >= 4 && ascii(0, 4) === 'GGUF') return 'gguf';
  if (/^\.safetensors$/i.test(ext) && b.length >= 8) return 'safetensors';
  if (b.length > 0) {
    const sample = ascii(0, Math.min(b.length, 64)).toLowerCase();
    if (/^\s*<(!doctype html|html)/.test(sample)) return 'html';
    if (Array.from(b.slice(0, 64)).every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc2)) return 'text';
  }
  return 'unknown';
}

/** The type the extension claims, so a mismatch ("invoice.pdf" that is really an HTML page) can be flagged. */
const EXT_TYPES: Record<string, DetectedType[]> = {
  '.pdf': ['pdf'], '.jpg': ['jpeg'], '.jpeg': ['jpeg'], '.png': ['png'], '.gif': ['gif'], '.webp': ['webp'], '.heic': ['heic'],
  '.mp4': ['mp4'], '.m4v': ['mp4'], '.mov': ['mov', 'mp4'], '.avi': ['avi'], '.mkv': ['mkv'], '.webm': ['mkv'], '.mp3': ['mp3'], '.wav': ['wav'],
  '.flac': ['flac'], '.ogg': ['ogg'], '.exe': ['exe'], '.msi': ['msi'], '.zip': ['zip'], '.7z': ['7z'], '.rar': ['rar'], '.gz': ['gzip'], '.tgz': ['gzip'],
  '.docx': ['office_openxml'], '.xlsx': ['office_openxml'], '.pptx': ['office_openxml'], '.doc': ['office_legacy'], '.xls': ['office_legacy'],
  '.gguf': ['gguf'],
};

export function typeMismatch(ext: string, detected: DetectedType): boolean {
  const expected = EXT_TYPES[ext.toLowerCase()];
  return Boolean(expected && detected !== 'unknown' && !expected.includes(detected));
}

const TEMP_NAME = /^(~\$|\.~lock\.)|\.(tmp|temp|crdownload|part|partial|download|opdownload)$|^thumbs\.db$|^\.ds_store$/i;
const SYSTEM_NAME = /^(desktop\.ini|thumbs\.db|ntuser\.dat.*|\.ds_store)$/i;

/** Keyword rules, most specific first. Each matches against the file name and, when authorized, extracted text. */
const KEYWORD_RULES: ReadonlyArray<readonly [FileCategory, RegExp]> = [
  ['tax', /\b(steuer\w*|finanzamt|elster|lohnsteuer\w*|einkommensteuer\w*|umsatzsteuer\w*|steuerbescheid|steuererkl\w*|tax[\s_-]?(return|assessment|statement|form)|income[\s_-]?tax|w-?2\b|1099|spendenquittung|zuwendungsbest\w*)/i],
  ['career', /\b(lebenslauf|resume|r[ée]sum[ée]|\bcv\b|curriculum|arbeitsvertrag|employment[\s_-]?(contract|agreement)|offer[\s_-]?letter|arbeitszeugnis|zwischenzeugnis|reference[\s_-]?letter|cover[\s_-]?letter|anschreiben|bewerbung|payslip|pay[\s_-]?slip|gehaltsabrechnung|lohnabrechnung|entgeltabrechnung|salary)/i],
  ['business', /\b(kha[\s_-]?ke[\s_-]?dikha|catering|gewerbe\w*|gewa\s?\d?|speisekarte|men[uü]karte|angebot[\s_-]?nr|kundenauftrag|business[\s_-]?plan)/i],
  ['identity', /\b(passport|reisepass|personalausweis|aufenthalts(titel|erlaubnis)|residence[\s_-]?permit|\bvisa\b|meldebescheinigung|anmeldung|birth[\s_-]?certificate|geburtsurkunde|marriage[\s_-]?certificate|heiratsurkunde|driving[\s_-]?licen[cs]e|f[üu]hrerschein)/i],
  ['insurance', /\b(versicherung\w*|insurance|police[\s_-]?nr|policy[\s_-]?(no|number)|haftpflicht|hausrat|kfz[\s_-]?versicherung)/i],
  ['housing', /\b(mietvertrag|nebenkosten\w*|miete\b|rent(al)?[\s_-]?(agreement|contract)|lease|vermieter|wohnung|hausverwaltung|betriebskosten)/i],
  ['health', /\b(arzt\w*|befund|rezept|prescription|krankenkasse|krankenversicherung|medical|diagnos\w*|hospital|klinik|impf\w*|vaccin\w*)/i],
  ['banking', /\b(kontoauszug\w*|bank[\s_-]?statement|account[\s_-]?statement|sepa[\s_-]?mandat\w*|iban|depot\w*|kreditkarten?abrechnung|credit[\s_-]?card[\s_-]?statement)/i],
  ['contracts', /\b(vertrag\w*|contract|agreement|k[üu]ndigung\w*|vertragsbest[äa]tigung|terms[\s_-]?and[\s_-]?conditions|nda\b)/i],
  ['invoices', /\b(rechnung\w*|invoice|receipt|quittung|beleg|bill\b|zahlungserinnerung|mahnung|order[\s_-]?confirmation|bestellbest[äa]tigung)/i],
];

export interface ClassifyInput {
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  detected: DetectedType;
  /** Extracted text, present only when the person authorized reading contents. Never stored. */
  text?: string;
  /** Lower-cased names of the folders between the scan root and the file, so "Steuer/2024/x.pdf" counts as tax. */
  parentNames?: string[];
  nowMs?: number;
}

export interface Classification {
  category: FileCategory;
  /** Why, in words a person can check: "name contains 'Rechnung'", "JPEG photo". */
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  year: number;
  /** Set when the evidence is too weak to move without asking. */
  ambiguous: boolean;
}

const DOC_TYPES: ReadonlySet<DetectedType> = new Set(['pdf', 'office_openxml', 'office_legacy', 'text', 'html']);
const IMAGE_TYPES: ReadonlySet<DetectedType> = new Set(['jpeg', 'png', 'gif', 'webp', 'heic']);
const VIDEO_TYPES: ReadonlySet<DetectedType> = new Set(['mp4', 'mov', 'avi', 'mkv']);
const AUDIO_TYPES: ReadonlySet<DetectedType> = new Set(['mp3', 'wav', 'flac', 'ogg']);

/** A four-digit year named in the text or file name, else the file's modification year. */
export function yearOf(name: string, text: string | undefined, mtimeMs: number): number {
  const sources = [name, text?.slice(0, 2000) ?? ''];
  for (const s of sources) {
    const m = /(?:^|[^\d])(20[0-3]\d|19[89]\d)(?:[^\d]|$)/.exec(s)
      ?? /(?:^|[^\d])(20[0-3]\d)(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])(?:[^\d]|$)/.exec(s);
    if (m) return Number(m[1]);
  }
  return new Date(mtimeMs).getFullYear();
}

export function classifyFile(input: ClassifyInput): Classification {
  const { name, ext, detected } = input;
  const lower = name.toLowerCase();
  const year = yearOf(name, input.text, input.mtimeMs);
  const base = (category: FileCategory, reason: string, confidence: Classification['confidence'], ambiguous = false): Classification =>
    ({ category, reason, confidence, year, ambiguous });

  if (SYSTEM_NAME.test(name)) return base('system', 'Windows/macOS system file', 'high');
  if (TEMP_NAME.test(name)) return base('temporary', 'temporary or unfinished download', 'high');
  if (detected === 'gguf' || /\.(gguf|safetensors|ckpt|onnx)$/i.test(lower) || (/\.(pt|pth|bin)$/i.test(lower) && input.size > 200 * 1024 * 1024)) {
    return base('ai_models', `${detected === 'gguf' ? 'GGUF model file (verified header)' : 'model weights file'}`, 'high');
  }
  if (/\.(parquet|arrow|jsonl|tfrecord|npz|npy|h5|hdf5)$/i.test(lower)) return base('ai_data', 'dataset file', 'high');
  if (/\.ipynb$/i.test(lower)) return base('experiments', 'Jupyter notebook', 'high');
  if (detected === 'exe' || detected === 'msi' || /\.(msix|msixbundle|appx|appxbundle)$/i.test(lower)) {
    return base('installers', detected === 'exe' || detected === 'msi' ? `Windows installer/program (verified ${detected.toUpperCase()} header)` : 'app package', 'high');
  }
  if (detected === 'zip' || detected === '7z' || detected === 'rar' || detected === 'gzip') return base('archives', `${detected} archive (verified header)`, 'high');
  if (IMAGE_TYPES.has(detected)) return base('photos', `${detected.toUpperCase()} image (verified header)`, 'high');
  if (VIDEO_TYPES.has(detected)) return base('videos', `${detected.toUpperCase()} video (verified header)`, 'high');
  if (AUDIO_TYPES.has(detected)) return base('audio', `${detected.toUpperCase()} audio (verified header)`, 'high');

  // Documents: the name and the folders it already sits in first, then authorized text.
  const context = [lower, ...(input.parentNames ?? [])].join(' / ');
  for (const [category, re] of KEYWORD_RULES) {
    const m = re.exec(context);
    if (m) return base(category, `name or folder mentions "${m[0].trim()}"`, 'high');
  }
  if (input.text) {
    const text = input.text.slice(0, 6000);
    for (const [category, re] of KEYWORD_RULES) {
      const m = re.exec(text);
      if (m) return base(category, `document text mentions "${m[0].trim()}"`, 'medium');
    }
  }
  if (/\.(py|js|ts|mjs|sh|ps1|bat|r|jl)$/i.test(lower)) return base('experiments', 'loose script', 'medium', true);
  if (DOC_TYPES.has(detected) || /\.(pdf|docx?|xlsx?|pptx?|odt|ods|txt|md|csv|rtf)$/i.test(lower)) {
    return base('documents', input.text === undefined ? 'document; contents not read' : 'document with no category keywords', 'low', true);
  }
  return base('unknown', `unrecognized type (${detected})`, 'low', true);
}

/** The suggested folder for a category, relative to the plan's target base. Year-bucketed where people look by year. */
export function destinationFor(category: FileCategory, year: number, overrides: Partial<Record<FileCategory, string>> = {}): string | null {
  const override = overrides[category];
  if (override !== undefined) return override.replace(/\{year\}/g, String(year)) || null;
  switch (category) {
    case 'tax': return `Tax/${year}`;
    case 'invoices': return `Finance/Invoices/${year}`;
    case 'banking': return `Finance/Banking/${year}`;
    case 'insurance': return 'Personal/Insurance';
    case 'contracts': return 'Personal/Contracts';
    case 'identity': return 'Personal/Identity';
    case 'health': return 'Personal/Health';
    case 'housing': return 'Personal/Housing';
    case 'career': return 'Career';
    case 'business': return `Business/${year}`;
    case 'ai_models': return 'AI/Models';
    case 'ai_data': return 'AI/Datasets';
    case 'experiments': return 'Experiments';
    case 'photos': return `Media/Photos/${year}`;
    case 'videos': return `Media/Videos/${year}`;
    case 'audio': return 'Media/Audio';
    case 'installers': return 'Archive/Installers';
    case 'archives': return 'Archive/Compressed';
    case 'documents': return 'Inbox/Documents';
    // Never moved by a plan: temp files are flagged, system files stay, unknowns are asked about.
    case 'temporary': case 'system': case 'unknown': return null;
  }
}

/** Marker files that make a folder a project or application unit. Its inside is never reorganized. */
export const PROJECT_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\.git$/, 'git repository'],
  [/^package\.json$/, 'Node.js project'],
  [/^(pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|pipfile)$/i, 'Python project'],
  [/^pyvenv\.cfg$/, 'Python virtual environment'],
  [/^(cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|cmakelists\.txt|makefile|composer\.json|gemfile|deno\.json)$/i, 'software project'],
  [/\.(sln|csproj|vcxproj|xcodeproj|uproject)$/i, 'IDE solution'],
  [/^(\.vscode|\.idea)$/i, 'editor workspace'],
  [/^node_modules$/, 'Node.js dependencies'],
];

/** Folder names that hold models or app data and must be left exactly where they are. */
export const PROTECTED_DIR_NAMES = /^(comfyui.*|models?|checkpoints|loras?|vae|embeddings|\.ollama|ollama|huggingface|\.cache|appdata|program files.*|windows|\$recycle\.bin|system volume information|onedrive.*|\.ssh|\.gnupg|\.aws|\.azure|\.kube)$/i;
