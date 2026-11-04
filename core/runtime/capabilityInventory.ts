/**
 * The capability inventory: what this Windows PC can really do, found by probing it.
 *
 * Every item comes from a check that ran just now — an executable that answered its version flag, an Ollama model that
 * reported its own capabilities, a ComfyUI server that answered `/system_stats`, a drive whose free space was read, an
 * Android device that `adb` listed, a connector whose grant is on record. Nothing is assumed from a list of "usual" tools:
 * a utility found on disk that does not answer is reported as installed-but-unverified, and one that is absent is missing.
 *
 * The inventory is the one source both chat and the operator use to decide what is achievable (PC organization, media
 * production, Wish-to-Reality offerings). When a needed capability is missing, it names a vetted utility and the exact
 * winget package, and `pc_install_utility` installs it only after the person approves that exact package.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { ConnectorId } from '../shared/wireTypes';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import { listConnectorStatuses } from '../domain/connectors';
import { notificationCapability } from '../domain/notificationOutbox';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { DEFAULT_OLLAMA_URL } from './modelBackend';
import { detectGpu } from './hardwareCapacity';
import { resolveHostBrowserBin } from './hostBrowserBin';
import { nowIso } from '../domain/ids';

export type InventoryStatus = 'working' | 'installed_unverified' | 'unreachable' | 'missing' | 'not_connected';

/** What a piece of work needs. A capability is available when at least one item providing it is `working`. */
export type CapabilityKey =
  | 'video_production' | 'audio_processing' | 'image_editing' | 'image_generation' | 'image_metadata'
  | 'vision_model' | 'chat_model' | 'embedding_model' | 'ocr' | 'pdf_text' | 'office_documents' | 'archives'
  | 'python' | 'node' | 'data_analysis' | 'browser_automation' | 'web_research' | 'coding_agent' | 'version_control'
  | 'gmail' | 'calendar' | 'messaging' | 'printing' | 'android_device' | 'scheduler' | 'notifications' | 'storage'
  | 'gpu' | 'containers' | 'media_download' | 'software_install' | 'companion_phone';

export interface InventoryItem {
  id: string;
  category: 'media' | 'documents' | 'runtime' | 'ai' | 'agents' | 'web' | 'accounts' | 'devices' | 'system';
  label: string;
  status: InventoryStatus;
  detail: string;
  version?: string;
  location?: string;
  /** What using it requires, in Pandesh's own permission terms. */
  permission: 'none' | 'approval_per_use' | 'connector_grant' | 'device_pairing';
  provides: CapabilityKey[];
}

export interface Recommendation { capability: CapabilityKey; utility: string; label: string; wingetId: string; why: string }

export interface CapabilitySummary { key: CapabilityKey; available: boolean; providers: string[]; recommendation: Recommendation | null }

export interface CapabilityInventory {
  probedAt: string;
  host: { os: string; cpu: string; cores: number; ramGb: number };
  items: InventoryItem[];
  capabilities: CapabilitySummary[];
}

interface ExecutableSpec {
  id: string;
  label: string;
  names: string[];
  versionArgs: string[] | null;
  provides: CapabilityKey[];
  category: InventoryItem['category'];
  known?: string[];
  wingetId?: string;
}

const EXECUTABLES: ExecutableSpec[] = [
  { id: 'ffmpeg', label: 'FFmpeg', names: ['ffmpeg'], versionArgs: ['-version'], provides: ['video_production', 'audio_processing'], category: 'media', wingetId: 'Gyan.FFmpeg' },
  { id: 'ffprobe', label: 'FFprobe (media inspection)', names: ['ffprobe'], versionArgs: ['-version'], provides: ['video_production'], category: 'media', wingetId: 'Gyan.FFmpeg' },
  { id: 'imagemagick', label: 'ImageMagick', names: ['magick'], versionArgs: ['-version'], provides: ['image_editing'], category: 'media', wingetId: 'ImageMagick.ImageMagick' },
  { id: 'exiftool', label: 'ExifTool', names: ['exiftool'], versionArgs: ['-ver'], provides: ['image_metadata'], category: 'media', wingetId: 'OliverBetz.ExifTool' },
  { id: 'yt-dlp', label: 'yt-dlp', names: ['yt-dlp'], versionArgs: ['--version'], provides: ['media_download'], category: 'media' },
  { id: 'tesseract', label: 'Tesseract OCR', names: ['tesseract'], versionArgs: ['--version'], provides: ['ocr'], category: 'documents', known: ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe'], wingetId: 'UB-Mannheim.TesseractOCR' },
  { id: 'pdftotext', label: 'Poppler pdftotext', names: ['pdftotext'], versionArgs: ['-v'], provides: ['pdf_text'], category: 'documents', wingetId: 'oschwartz10612.Poppler' },
  { id: 'libreoffice', label: 'LibreOffice', names: ['soffice'], versionArgs: ['--version'], provides: ['office_documents'], category: 'documents', known: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe'], wingetId: 'TheDocumentFoundation.LibreOffice' },
  { id: 'pandoc', label: 'Pandoc', names: ['pandoc'], versionArgs: ['--version'], provides: ['office_documents'], category: 'documents', wingetId: 'JohnMacFarlane.Pandoc' },
  { id: '7zip', label: '7-Zip', names: ['7z'], versionArgs: null, provides: ['archives'], category: 'documents', known: ['C:\\Program Files\\7-Zip\\7z.exe'], wingetId: '7zip.7zip' },
  { id: 'tar', label: 'Windows tar (zip/tar)', names: ['tar'], versionArgs: ['--version'], provides: ['archives'], category: 'documents', known: ['C:\\Windows\\System32\\tar.exe'] },
  { id: 'python', label: 'Python', names: ['python'], versionArgs: ['--version'], provides: ['python', 'data_analysis'], category: 'runtime', wingetId: 'Python.Python.3.12' },
  { id: 'node', label: 'Node.js', names: ['node'], versionArgs: ['--version'], provides: ['node', 'data_analysis'], category: 'runtime', wingetId: 'OpenJS.NodeJS.LTS' },
  { id: 'git', label: 'Git', names: ['git'], versionArgs: ['--version'], provides: ['version_control'], category: 'runtime', wingetId: 'Git.Git' },
  { id: 'gh', label: 'GitHub CLI', names: ['gh'], versionArgs: ['--version'], provides: ['version_control'], category: 'runtime' },
  { id: 'docker', label: 'Docker', names: ['docker'], versionArgs: ['--version'], provides: ['containers'], category: 'runtime' },
  { id: 'winget', label: 'winget (Windows Package Manager)', names: ['winget'], versionArgs: ['--version'], provides: ['software_install'], category: 'system' },
  { id: 'adb', label: 'Android Debug Bridge', names: ['adb'], versionArgs: ['version'], provides: [], category: 'devices' },
  { id: 'claude', label: 'Claude Code', names: ['claude'], versionArgs: ['--version'], provides: ['coding_agent'], category: 'agents' },
  { id: 'opencode', label: 'OpenCode', names: ['opencode'], versionArgs: ['--version'], provides: ['coding_agent'], category: 'agents' },
  { id: 'hermes', label: 'Hermes agent', names: ['hermes'], versionArgs: ['--version'], provides: ['coding_agent'], category: 'agents' },
  { id: 'vscode', label: 'VS Code', names: ['code'], versionArgs: null, provides: [], category: 'agents' },
];

/** Vetted utilities Pandesh may offer to install, keyed by the capability that is missing. Only these ids can be installed. */
export const INSTALLABLE_UTILITIES: Record<string, Recommendation> = {
  ffmpeg: { capability: 'video_production', utility: 'ffmpeg', label: 'FFmpeg', wingetId: 'Gyan.FFmpeg', why: 'encodes video and audio; needed to turn pictures into a video' },
  imagemagick: { capability: 'image_editing', utility: 'imagemagick', label: 'ImageMagick', wingetId: 'ImageMagick.ImageMagick', why: 'resizes, crops and converts images in bulk' },
  exiftool: { capability: 'image_metadata', utility: 'exiftool', label: 'ExifTool', wingetId: 'OliverBetz.ExifTool', why: 'reads photo dates and camera data for sorting media' },
  tesseract: { capability: 'ocr', utility: 'tesseract', label: 'Tesseract OCR', wingetId: 'UB-Mannheim.TesseractOCR', why: 'reads text from scanned documents' },
  poppler: { capability: 'pdf_text', utility: 'poppler', label: 'Poppler (pdftotext)', wingetId: 'oschwartz10612.Poppler', why: 'extracts text and pages from PDFs' },
  libreoffice: { capability: 'office_documents', utility: 'libreoffice', label: 'LibreOffice', wingetId: 'TheDocumentFoundation.LibreOffice', why: 'converts Word/Excel files to PDF and back' },
  pandoc: { capability: 'office_documents', utility: 'pandoc', label: 'Pandoc', wingetId: 'JohnMacFarlane.Pandoc', why: 'converts Markdown/HTML into Word documents' },
  '7zip': { capability: 'archives', utility: '7zip', label: '7-Zip', wingetId: '7zip.7zip', why: 'opens and creates .7z/.rar/.zip archives' },
};

const RECOMMEND_FOR: Partial<Record<CapabilityKey, string>> = {
  video_production: 'ffmpeg', audio_processing: 'ffmpeg', image_editing: 'imagemagick', image_metadata: 'exiftool', ocr: 'tesseract',
  pdf_text: 'poppler', office_documents: 'libreoffice', archives: '7zip',
};

export interface ExecResult { code: number | null; stdout: string; stderr: string }
export type ExecRunner = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export interface InventoryProbeDeps {
  db?: CoreDatabase;
  connectors?: Map<ConnectorId, ConnectorAdapter>;
  exec?: ExecRunner;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  ollamaUrl?: string;
  comfyUrl?: string;
  /** A generic, data-free reachability check of the web search endpoint. Off in tests. */
  probeWeb?: boolean;
  /** Paired JUGAAD phones, reported by the companion module. */
  companionDevices?: () => number;
  scheduledRoutines?: () => number;
}

export const defaultExec: ExecRunner = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : null) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
  });
});

/** Directories that hold executables beyond PATH: WinGet's per-package folders and links, scoop shims, the Android SDK. */
function extraSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  const local = env.LOCALAPPDATA;
  if (local) {
    dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of fs.readdirSync(packages, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        const root = path.join(packages, pkg.name);
        dirs.push(root);
        // Portable packages unpack as <pkg>\<versioned dir>\bin\tool.exe or <pkg>\<versioned dir>\tool.exe.
        try {
          for (const sub of fs.readdirSync(root, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            dirs.push(path.join(root, sub.name), path.join(root, sub.name, 'bin'), path.join(root, sub.name, 'Library', 'bin'));
          }
        } catch { /* unreadable package */ }
      }
    } catch { /* no WinGet packages */ }
    dirs.push(path.join(local, 'Android', 'Sdk', 'platform-tools'));
  }
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) if (sdk) dirs.push(path.join(sdk, 'platform-tools'));
  if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, 'scoop', 'shims'));
  return dirs;
}

/** First match for an executable name on PATH, in the extra directories, or at a known install path. */
export function resolveExecutable(names: string[], env: NodeJS.ProcessEnv = process.env, known: string[] = []): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const pathDirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...extraSearchDirs(env)]) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch {
          // Store-installed tools (winget, python) are App Execution Aliases: reparse points stat cannot follow, but they run.
          if (/[\\/]WindowsApps$/i.test(dir) && ext === '.exe') { try { fs.lstatSync(candidate); return candidate; } catch { /* absent */ } }
        }
      }
    }
  }
  for (const k of known) { try { if (fs.statSync(k).isFile()) return k; } catch { /* absent */ } }
  return null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? '';
}

async function probeExecutable(spec: ExecutableSpec, deps: Required<Pick<InventoryProbeDeps, 'exec' | 'env'>>): Promise<InventoryItem> {
  const location = resolveExecutable(spec.names, deps.env, spec.known ?? []);
  const base = { id: spec.id, category: spec.category, label: spec.label, provides: spec.provides, permission: 'approval_per_use' as const };
  if (!location) return { ...base, status: 'missing', detail: spec.wingetId ? `not found; installable as winget package ${spec.wingetId}` : 'not found on this PC' };
  // Script shims (.cmd/.bat) need a shell to run; Pandesh never runs them through one just to read a version.
  if (!spec.versionArgs || /\.(cmd|bat|ps1)$/i.test(location)) {
    return { ...base, status: 'installed_unverified', detail: 'found on disk; not started by the inventory', location };
  }
  const r = await deps.exec(location, spec.versionArgs, 6_000);
  const text = firstLine(r.stdout) || firstLine(r.stderr);
  if (r.code === 0 || (text && r.code !== null)) return { ...base, status: 'working', detail: 'answered its version check', version: text, location };
  return { ...base, status: 'installed_unverified', detail: `found, but the version check failed (${firstLine(r.stderr) || 'no output'})`, location };
}

async function probeOllama(deps: InventoryProbeDeps, fetchFn: typeof fetch): Promise<InventoryItem[]> {
  const base = (deps.ollamaUrl ?? deps.env?.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  let models: Array<{ name: string; size?: number }>;
  try {
    const res = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = ((await res.json()) as { models?: Array<{ name: string; size?: number }> }).models ?? [];
  } catch (err) {
    return [{ id: 'ollama', category: 'ai', label: 'Ollama (local models)', status: 'unreachable', permission: 'none', provides: [], detail: `not reachable at ${base}: ${err instanceof Error ? err.message : String(err)}` }];
  }
  const items: InventoryItem[] = [{ id: 'ollama', category: 'ai', label: 'Ollama (local models)', status: 'working', permission: 'none', provides: [], detail: `${models.length} models installed at ${base}` }];
  const shown = await Promise.all(models.slice(0, 40).map(async (m) => {
    try {
      const res = await fetchFn(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model: m.name }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4_000) });
      const body = res.ok ? await res.json() as { capabilities?: string[] } : {};
      return { m, caps: body.capabilities ?? null };
    } catch { return { m, caps: null }; }
  }));
  for (const { m, caps } of shown) {
    const embedding = caps ? caps.includes('embedding') : /embed|rerank/i.test(m.name);
    const vision = caps ? caps.includes('vision') : /\bvl\b|vision|llava/i.test(m.name);
    const provides: CapabilityKey[] = embedding ? ['embedding_model'] : vision ? ['chat_model', 'vision_model'] : ['chat_model'];
    items.push({
      id: `ollama:${m.name}`, category: 'ai', label: m.name, status: 'working', permission: 'none', provides,
      detail: `${caps ? `reports ${caps.join(', ')}` : 'capabilities not reported'}${m.size ? `; ${(m.size / 1e9).toFixed(1)} GB` : ''}`,
    });
  }
  return items;
}

async function probeComfy(deps: InventoryProbeDeps, fetchFn: typeof fetch): Promise<InventoryItem> {
  const base = (deps.comfyUrl ?? deps.env?.KARKEDIKHA_COMFYUI_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
  try {
    const res = await fetchFn(`${base}/system_stats`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { system?: { comfyui_version?: string }; devices?: Array<{ name?: string; vram_total?: number }> };
    const device = body.devices?.[0];
    return {
      id: 'comfyui', category: 'ai', label: 'ComfyUI', status: 'working', permission: 'approval_per_use', provides: ['image_generation'],
      version: body.system?.comfyui_version, location: base,
      detail: `server answering at ${base}${device?.name ? ` on ${device.name.replace(/^cuda:\d+\s*/, '').slice(0, 60)}` : ''}`,
    };
  } catch (err) {
    return { id: 'comfyui', category: 'ai', label: 'ComfyUI', status: 'unreachable', permission: 'approval_per_use', provides: ['image_generation'], detail: `no server at ${base} (${err instanceof Error ? err.message : String(err)}); start ComfyUI to generate images` };
  }
}

async function probeWebReach(fetchFn: typeof fetch, env: NodeJS.ProcessEnv): Promise<InventoryItem> {
  const target = env.KARKEDIKHA_SEARXNG_URL ?? 'https://html.duckduckgo.com/html/';
  try {
    const res = await fetchFn(target, { method: 'GET', signal: AbortSignal.timeout(4_000), redirect: 'manual' });
    const ok = res.status < 500;
    return { id: 'web_research', category: 'web', label: 'Web research', status: ok ? 'working' : 'unreachable', permission: 'approval_per_use', provides: ['web_research'], detail: ok ? `search endpoint reachable (${new URL(target).hostname}); each run asks before sending queries` : `HTTP ${res.status}` };
  } catch (err) {
    return { id: 'web_research', category: 'web', label: 'Web research', status: 'unreachable', permission: 'approval_per_use', provides: ['web_research'], detail: `no route to the search endpoint (${err instanceof Error ? err.message : String(err)})` };
  }
}

/** Parses `adb devices -l`. Pure. */
export function parseAdbDeviceList(stdout: string): Array<{ serial: string; state: string; model: string | null }> {
  const out: Array<{ serial: string; state: string; model: string | null }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|authorizing)\b(.*)$/.exec(line.trim());
    if (m) out.push({ serial: m[1], state: m[2], model: /\bmodel:(\S+)/.exec(m[3])?.[1]?.replace(/_/g, ' ') ?? null });
  }
  return out;
}

async function probeDevices(adbItem: InventoryItem | undefined, deps: Required<Pick<InventoryProbeDeps, 'exec'>>): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  if (adbItem?.status === 'working' && adbItem.location) {
    const r = await deps.exec(adbItem.location, ['devices', '-l'], 6_000);
    for (const d of parseAdbDeviceList(r.stdout)) {
      const emulator = d.serial.startsWith('emulator-');
      items.push({
        id: `android:${d.serial}`, category: 'devices', label: `${emulator ? 'Android emulator' : 'Android phone'} ${d.model ?? d.serial}`,
        status: d.state === 'device' ? 'working' : 'unreachable', permission: 'device_pairing', provides: d.state === 'device' ? ['android_device'] : [],
        detail: d.state === 'device' ? `connected over adb (${d.serial})` : `adb reports ${d.state}`,
      });
    }
  }
  const gpu = detectGpu();
  items.push(gpu
    ? { id: 'gpu', category: 'devices', label: gpu.name, status: 'working', permission: 'none', provides: ['gpu'], detail: `${Math.round(gpu.totalVramMb / 1024)} GB VRAM, ${Math.round(gpu.freeVramMb / 1024)} GB free now` }
    : { id: 'gpu', category: 'devices', label: 'GPU', status: 'missing', permission: 'none', provides: [], detail: 'no NVIDIA GPU reported by nvidia-smi' });
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      try {
        if (!fs.existsSync(root)) continue;
        const st = fs.statfsSync(root);
        const total = st.blocks * st.bsize; const free = st.bavail * st.bsize;
        items.push({ id: `drive:${letter}`, category: 'devices', label: `Drive ${letter}:`, status: 'working', permission: 'approval_per_use', provides: ['storage'], detail: `${(free / 1e9).toFixed(0)} GB free of ${(total / 1e9).toFixed(0)} GB` });
      } catch { /* not ready (card reader, disconnected network drive) */ }
    }
  }
  return items;
}

async function probePrinters(exec: ExecRunner): Promise<InventoryItem> {
  if (process.platform !== 'win32') return { id: 'printers', category: 'devices', label: 'Printers', status: 'missing', permission: 'approval_per_use', provides: [], detail: 'printer discovery is Windows-only' };
  const script = '@(Get-CimInstance Win32_Printer | ForEach-Object { $_.Name + "|" + [string]$_.PrinterStatus + "|" + $_.WorkOffline }) -join "`n"';
  const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
  const printers = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split('|')[0]);
  const physical = printers.filter((p) => !/pdf|xps|onenote|fax/i.test(p));
  return {
    id: 'printers', category: 'devices', label: 'Printers', status: r.code === 0 && printers.length ? 'working' : 'missing', permission: 'approval_per_use', provides: r.code === 0 && printers.length ? ['printing'] : [],
    detail: r.code === 0 ? `${printers.length} installed (${physical.length} physical${physical.length ? `: ${physical.slice(0, 4).join(', ')}` : ''})` : 'printer list could not be read',
  };
}

function probeOffice(): InventoryItem | null {
  for (const root of ['C:\\Program Files\\Microsoft Office\\root\\Office16', 'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16']) {
    const found = ['WINWORD.EXE', 'EXCEL.EXE', 'POWERPNT.EXE'].filter((f) => fs.existsSync(path.join(root, f)));
    if (found.length) return { id: 'msoffice', category: 'documents', label: 'Microsoft Office', status: 'installed_unverified', permission: 'approval_per_use', provides: ['office_documents'], location: root, detail: `${found.map((f) => f.replace('.EXE', '').toLowerCase()).join(', ')} installed (not started by the inventory)` };
  }
  return null;
}

function probeAccounts(deps: InventoryProbeDeps): InventoryItem[] {
  const items: InventoryItem[] = [];
  if (deps.db && deps.connectors) {
    for (const c of listConnectorStatuses(deps.db, deps.connectors)) {
      const connected = c.state === 'connected' || c.state === 'degraded';
      const provides: CapabilityKey[] = !connected ? [] : c.id === 'gmail' ? ['gmail'] : c.id === 'google_calendar' ? ['calendar'] : c.id === 'whatsapp' ? ['messaging'] : ['printing'];
      const grants = Object.entries(c.permissions).filter(([, v]) => v).map(([k]) => k).join('/') || 'no grants';
      const whatsappNote = c.id === 'whatsapp' ? ' — personal WhatsApp chats have no official API; Pandesh never scrapes a WhatsApp Web session' : '';
      items.push({
        id: `connector:${c.id}`, category: 'accounts', label: c.label, status: connected ? 'working' : 'not_connected', permission: 'connector_grant', provides,
        detail: `${c.state}${connected ? `; granted: ${grants}` : c.reason ? `: ${c.reason}` : ''}${whatsappNote}`,
      });
    }
    const channel = notificationCapability(deps.db);
    items.push({ id: 'notifications', category: 'system', label: 'Desktop notifications', status: channel.canNotify ? 'working' : 'not_connected', permission: 'none', provides: channel.canNotify ? ['notifications'] : [], detail: channel.statement });
    const routines = deps.scheduledRoutines?.() ?? 0;
    items.push({ id: 'scheduler', category: 'system', label: 'Durable scheduler', status: 'working', permission: 'approval_per_use', provides: ['scheduler'], detail: `Core's SQLite scheduler; ${routines} active scheduled task(s)` });
  }
  const phones = deps.companionDevices?.();
  if (phones !== undefined) {
    items.push({ id: 'jugaad', category: 'devices', label: 'JUGAAD phone companion', status: phones > 0 ? 'working' : 'not_connected', permission: 'device_pairing', provides: phones > 0 ? ['companion_phone'] : [], detail: phones > 0 ? `${phones} paired phone(s)` : 'no phone paired; pair it from Pandesh to sync Important Dates' });
  }
  const browser = resolveHostBrowserBin();
  items.push(browser
    ? { id: 'browser', category: 'web', label: 'Managed browser (Edge/Chrome)', status: 'working', permission: 'approval_per_use', provides: ['browser_automation'], location: browser, detail: 'found; opened headless by the governed browser capability' }
    : { id: 'browser', category: 'web', label: 'Managed browser', status: 'missing', permission: 'approval_per_use', provides: [], detail: 'no Edge or Chrome executable found' });
  return items;
}

const ALL_KEYS: CapabilityKey[] = [
  'video_production', 'audio_processing', 'image_editing', 'image_generation', 'image_metadata', 'vision_model', 'chat_model', 'embedding_model',
  'ocr', 'pdf_text', 'office_documents', 'archives', 'python', 'node', 'data_analysis', 'browser_automation', 'web_research', 'coding_agent',
  'version_control', 'gmail', 'calendar', 'messaging', 'printing', 'android_device', 'scheduler', 'notifications', 'storage', 'gpu',
  'containers', 'media_download', 'software_install', 'companion_phone',
];

export function summarizeCapabilities(items: InventoryItem[]): CapabilitySummary[] {
  return ALL_KEYS.map((key) => {
    const providers = items.filter((i) => i.status === 'working' && i.provides.includes(key)).map((i) => i.label);
    const rec = providers.length === 0 && RECOMMEND_FOR[key] ? INSTALLABLE_UTILITIES[RECOMMEND_FOR[key]!] : null;
    return { key, available: providers.length > 0, providers, recommendation: rec };
  });
}

let cached: { at: number; inventory: CapabilityInventory } | null = null;
const CACHE_MS = 60_000;

/** Probes the PC. Results are cached for a minute so one turn that needs the inventory twice probes once. */
export async function probeCapabilityInventory(deps: InventoryProbeDeps = {}, options: { refresh?: boolean } = {}): Promise<CapabilityInventory> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.inventory;
  const exec = deps.exec ?? defaultExec;
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const executables = await Promise.all(EXECUTABLES.map((spec) => probeExecutable(spec, { exec, env })));
  const [models, comfy, printers, devices, web] = await Promise.all([
    probeOllama(deps, fetchFn),
    probeComfy(deps, fetchFn),
    probePrinters(exec),
    probeDevices(executables.find((e) => e.id === 'adb'), { exec }),
    deps.probeWeb === false ? Promise.resolve(null) : probeWebReach(fetchFn, env),
  ]);
  const office = probeOffice();
  const items: InventoryItem[] = [...executables, ...(office ? [office] : []), ...models, comfy, printers, ...devices, ...(web ? [web] : []), ...probeAccounts(deps)];
  const inventory: CapabilityInventory = {
    probedAt: nowIso(),
    host: { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model?.trim() ?? 'unknown', cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 1e9) },
    items,
    capabilities: summarizeCapabilities(items),
  };
  cached = { at: Date.now(), inventory };
  return inventory;
}

/** True when every capability is available; the reasons name what is missing and what would supply it. */
export function checkRequirements(inventory: CapabilityInventory, needs: CapabilityKey[]): { ok: boolean; missing: CapabilitySummary[] } {
  const missing = needs.map((k) => inventory.capabilities.find((c) => c.key === k)!).filter((c) => !c?.available);
  return { ok: missing.length === 0, missing };
}

/** The working executable that provides a capability, preferring the given ids. */
export function workingExecutable(inventory: CapabilityInventory, id: string): string | null {
  const item = inventory.items.find((i) => i.id === id && i.status === 'working');
  return item?.location ?? null;
}

const STATUS_MARK: Record<InventoryStatus, string> = { working: 'WORKING', installed_unverified: 'FOUND (unverified)', unreachable: 'NOT RESPONDING', missing: 'MISSING', not_connected: 'NOT CONNECTED' };

export function renderInventory(inv: CapabilityInventory, category?: string): string {
  const lines = [`PC capability inventory (probed ${inv.probedAt}) — ${inv.host.os}, ${inv.host.cpu}, ${inv.host.cores} threads, ${inv.host.ramGb} GB RAM`];
  const groups = new Map<string, InventoryItem[]>();
  for (const item of inv.items) {
    if (category && item.category !== category) continue;
    if (item.id.startsWith('ollama:')) continue;
    groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  }
  for (const [cat, items] of groups) {
    lines.push('', `## ${cat}`);
    for (const i of items) lines.push(`- ${i.label}: ${STATUS_MARK[i.status]}${i.version ? ` — ${i.version}` : ''} — ${i.detail}`);
  }
  if (!category || category === 'ai') {
    const models = inv.items.filter((i) => i.id.startsWith('ollama:'));
    if (models.length) {
      lines.push('', '## local models');
      const vision = models.filter((m) => m.provides.includes('vision_model')).map((m) => m.label);
      const chat = models.filter((m) => m.provides.includes('chat_model') && !m.provides.includes('vision_model')).map((m) => m.label);
      const embed = models.filter((m) => m.provides.includes('embedding_model')).map((m) => m.label);
      lines.push(`- chat: ${chat.join(', ') || 'none'}`, `- vision: ${vision.join(', ') || 'none'}`, `- embedding: ${embed.join(', ') || 'none'}`);
    }
  }
  const available = inv.capabilities.filter((c) => c.available).map((c) => c.key);
  const missing = inv.capabilities.filter((c) => !c.available);
  lines.push('', `Capabilities available: ${available.join(', ')}`);
  if (missing.length) {
    lines.push(`Not available: ${missing.map((c) => c.key).join(', ')}`);
    const recs = missing.filter((c) => c.recommendation);
    for (const c of recs) lines.push(`- to add ${c.key}: ${c.recommendation!.label} (${c.recommendation!.why}) — winget ${c.recommendation!.wingetId}; Pandesh can install it with your approval (pc_install_utility utility="${c.recommendation!.utility}")`);
  }
  return lines.join('\n');
}

const ok = (output: string, category: string, extra: Partial<ToolExecutionResult> = {}): ToolExecutionResult => ({ status: 'succeeded', exitCode: 0, output, resultCategory: category, ...extra });
const failed = (output: string, category: string): ToolExecutionResult => ({ status: 'failed', exitCode: null, output, resultCategory: category });

/**
 * The inventory as a governed capability. Reading the inventory is read-only; installing a utility is consequential and
 * limited to the vetted winget packages above, so an approval always names the exact package that will be installed.
 */
export function createCapabilityInventoryAdapter(deps: InventoryProbeDeps): GovernedCapabilityAdapter {
  async function install(utility: string): Promise<ToolExecutionResult> {
    const rec = INSTALLABLE_UTILITIES[utility];
    if (!rec) return failed(`"${utility}" is not one of the utilities Pandesh can install (${Object.keys(INSTALLABLE_UTILITIES).join(', ')}).`, 'install_not_vetted');
    const winget = resolveExecutable(['winget'], deps.env ?? process.env);
    if (!winget) return failed('winget is not available on this PC, so nothing was installed.', 'install_unavailable');
    const r = await (deps.exec ?? defaultExec)(winget, ['install', '--id', rec.wingetId, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 15 * 60_000);
    const inv = await probeCapabilityInventory(deps, { refresh: true });
    const now = inv.capabilities.find((c) => c.key === rec.capability);
    const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-6).join('\n');
    if (now?.available) return ok(`Installed ${rec.label} (${rec.wingetId}). Verified: ${rec.capability} is now provided by ${now.providers.join(', ')}.\n${tail}`, 'install_verified');
    return failed(`winget ran for ${rec.wingetId} (exit ${r.code ?? 'none'}) but ${rec.capability} is still not available — it may need a new terminal or a restart of Pandesh to appear on PATH.\n${tail}`, 'install_unverified');
  }

  return {
    id: 'capability-inventory',
    definitions: () => [
      {
        name: 'pc_capability_inventory',
        description: 'Probe this PC for what it can really do: installed tools (FFmpeg, OCR, PDF, Office, archives, Python, Node), local AI models (chat, vision, embedding), ComfyUI, coding agents, browser, printers, drives, GPU, Android devices, connected accounts, the scheduler and the JUGAAD phone. Read-only. Use it before planning media, document or business work, and when the user asks what tools are available.',
        parameters: { type: 'object', properties: { category: { type: 'string', enum: ['media', 'documents', 'runtime', 'ai', 'agents', 'web', 'accounts', 'devices', 'system'], description: 'Optional: show one category only.' }, refresh: { type: 'boolean', description: 'Probe again instead of using the last minute\'s result.' } } },
      },
      {
        name: 'wish_production_options',
        description: 'Wish-to-Reality: list the deliverables this PC can genuinely produce for a paying customer right now (promo videos, one-page websites, document digitization, AI imagery, conversions), each checked against the live capability inventory, with honest production cost, limitations and the human work still needed. Read-only; never contacts anyone.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'pc_install_utility',
        description: `Install one vetted utility with winget after the user approves the exact package, then verify it works. Allowed: ${Object.entries(INSTALLABLE_UTILITIES).map(([k, v]) => `${k} (${v.wingetId})`).join(', ')}. Only offer this when a task needs a missing capability.`,
        parameters: { type: 'object', properties: { utility: { type: 'string', enum: Object.keys(INSTALLABLE_UTILITIES) } }, required: ['utility'] },
      },
    ],
    classify: (toolName) => (toolName === 'pc_install_utility' ? 'consequential' : 'read_only'),
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    async run(call: ModelToolCall): Promise<ToolExecutionResult> {
      const args = call.arguments ?? {};
      if (call.name === 'pc_capability_inventory') {
        const inv = await probeCapabilityInventory(deps, { refresh: args.refresh === true });
        return ok(renderInventory(inv, typeof args.category === 'string' ? args.category : undefined), 'capability_inventory');
      }
      if (call.name === 'pc_install_utility') return install(String(args.utility ?? ''));
      if (call.name === 'wish_production_options') {
        const { assessOfferings, renderOfferings } = await import('./productionOfferings');
        return ok(renderOfferings(assessOfferings(await probeCapabilityInventory(deps))), 'wish_production_options');
      }
      return failed(`unknown tool '${call.name}'`, 'invalid_arguments');
    },
  };
}
