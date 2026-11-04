/**
 * PC organization: scan authorized folders, propose a reviewed plan, apply it in verified batches, undo it exactly.
 *
 * - Scanning reads names, sizes, dates and the first bytes of each file (to identify its real type). File contents are
 *   read only when the person authorized it for this scan, and only derived facts (a category, a year) are kept.
 * - Projects, repositories, virtual environments, model and app-data folders are detected and kept whole. A project
 *   folder may be moved as one unit only when the person explicitly includes units; model and app-data folders never.
 * - Nothing is deleted. Duplicates and temporary files are flagged; redundant copies may be moved to an archive folder
 *   only when the person includes that option.
 * - Every move is journaled before it happens (core/domain/fileOrganization.ts), verified after (existence, size and a
 *   SHA-256 where it was taken), and undone in reverse. A cross-drive move copies, verifies the copy, then removes the
 *   original — the original is never removed before its copy is proven identical.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from '../domain/errors';
import { nowIso } from '../domain/ids';
import {
  classifyFile, destinationFor, detectType, PROJECT_MARKERS, PROTECTED_DIR_NAMES, typeMismatch,
  type FileCategory,
} from '../domain/fileClassification';
import {
  createOrganizationPlan, getOrganizationPlan, listOrganizationPlans, listPlanMoves, moveCounts, updateMove, updatePlan, upsertOrganizationRule,
  type OrganizationMove, type OrganizationPlan, type OrganizationRule,
} from '../domain/fileOrganization';
import { extractPdfFromBytes } from '../attachments/documentExtraction';
import { isCredentialFilePath } from '../platform/credentialStore';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';

const MAX_FILES = 20_000;
const MAX_DEPTH = 6;
const HEAD_BYTES = 16;
const MAX_CONTENT_READS = 200;
const PDF_READ_LIMIT = 15 * 1024 * 1024;
const HASH_LIMIT = 256 * 1024 * 1024;
const DUPLICATE_HASH_BUDGET = 4 * 1024 * 1024 * 1024;
const DEFAULT_BATCH = 200;

export interface ScannedFile {
  path: string;
  root: string;
  rel: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  detected: ReturnType<typeof detectType>;
  mismatch: boolean;
  category: FileCategory;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  ambiguous: boolean;
  year: number;
  contentRead: boolean;
  sha256?: string;
}

export interface ScannedUnit {
  path: string;
  root: string;
  kind: string;
  /** Model and app-data folders are protected: never part of any move. */
  protected: boolean;
  active: boolean;
  entries: number;
}

export interface ScanResult {
  roots: string[];
  files: ScannedFile[];
  units: ScannedUnit[];
  folders: Array<{ root: string; folder: string; files: number; bytes: number }>;
  truncated: boolean;
  contentReads: number;
  elapsedMs: number;
}

const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`;
const sameVolume = (a: string, b: string) => path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
const within = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * A root a person may authorize. Drive roots, Windows and program folders, AppData, credential folders and Pandesh's
 * own data are refused, so an over-broad request fails before anything is read.
 */
export function validateRoot(raw: string, env: NodeJS.ProcessEnv = process.env): { ok: true; root: string } | { ok: false; reason: string } {
  const trimmed = String(raw ?? '').trim().replace(/^"|"$/g, '');
  if (!trimmed) return { ok: false, reason: 'an empty folder path' };
  const home = env.USERPROFILE ?? os.homedir();
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, home).replace(/^%USERPROFILE%/i, home);
  const named: Record<string, string> = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures', videos: 'Videos', music: 'Music' };
  const resolved = named[expanded.toLowerCase()] ? path.join(home, named[expanded.toLowerCase()]) : path.resolve(expanded);
  if (path.parse(resolved).root.toLowerCase() === path.join(resolved, path.sep).toLowerCase()) return { ok: false, reason: `${resolved} is a whole drive; name the folders to organize` };
  const lower = resolved.toLowerCase();
  const forbidden = [env.SystemRoot ?? 'C:\\Windows', env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramData ?? 'C:\\ProgramData', env.APPDATA, env.LOCALAPPDATA, env.KARKEDIKHA_DATA_DIR]
    .filter((p): p is string => Boolean(p)).map((p) => path.resolve(p).toLowerCase());
  // A folder inside the user's temp directory is the user's to organize; the temp directory itself is in use by programs.
  const temp = path.resolve(env.TEMP ?? env.TMP ?? os.tmpdir()).toLowerCase();
  if (lower === temp) return { ok: false, reason: `${resolved} is the system temporary folder, which running programs use` };
  const inUserTemp = lower.startsWith(`${temp}${path.sep}`);
  for (const f of forbidden) if (!inUserTemp && (lower === f || lower.startsWith(`${f}${path.sep}`))) return { ok: false, reason: `${resolved} is a system, program or application-data folder` };
  if (resolved.toLowerCase() === path.resolve(home).toLowerCase()) return { ok: false, reason: 'the whole user profile is too broad; name folders such as Downloads, Documents or Desktop' };
  if (/[\\/](\.ssh|\.gnupg|\.aws|\.azure|\.kube)([\\/]|$)/i.test(resolved)) return { ok: false, reason: `${resolved} holds credentials` };
  try { if (!fs.statSync(resolved).isDirectory()) return { ok: false, reason: `${resolved} is not a folder` }; } catch { return { ok: false, reason: `${resolved} does not exist` }; }
  return { ok: true, root: resolved };
}

function readHead(file: string): Uint8Array {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return new Uint8Array(buf.subarray(0, n));
  } catch { return new Uint8Array(0); } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function readContentText(file: string, detected: string, size: number): Promise<string | undefined> {
  try {
    if (detected === 'pdf' && size <= PDF_READ_LIMIT) {
      const doc = await extractPdfFromBytes(new Uint8Array(fs.readFileSync(file)));
      return doc.sections.slice(0, 3).map((s) => s.text).join('\n').slice(0, 6000);
    }
    if (detected === 'text' && size <= 1024 * 1024 && /\.(txt|md|csv|json|xml|eml)$/i.test(file)) {
      const fd = fs.openSync(file, 'r');
      try { const buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, 8192, 0); return buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
    }
  } catch { /* unreadable: classified by name */ }
  return undefined;
}

function unitKind(dir: string, entries: fs.Dirent[]): { kind: string; protected: boolean } | null {
  const name = path.basename(dir);
  if (PROTECTED_DIR_NAMES.test(name)) return { kind: /comfy|model|checkpoint|lora|vae|embedding|ollama|huggingface/i.test(name) ? 'AI model folder' : 'application or system data', protected: true };
  for (const e of entries) for (const [re, kind] of PROJECT_MARKERS) if (re.test(e.name)) return { kind, protected: kind === 'Python virtual environment' || kind === 'Node.js dependencies' };
  const exes = entries.filter((e) => e.isFile() && /\.exe$/i.test(e.name)).length;
  const dlls = entries.filter((e) => e.isFile() && /\.dll$/i.test(e.name)).length;
  if (exes >= 1 && dlls >= 3) return { kind: 'portable application', protected: true };
  if (entries.some((e) => e.isFile() && /\.(gguf|safetensors)$/i.test(e.name)) && entries.length > 1) return { kind: 'AI model folder', protected: true };
  return null;
}

function isActiveUnit(dir: string): boolean {
  for (const probe of ['.git/index', '.git/HEAD', 'package.json']) {
    try { if (Date.now() - fs.statSync(path.join(dir, probe)).mtimeMs < 14 * 86_400_000) return true; } catch { /* absent */ }
  }
  return false;
}

/** Walks the authorized roots. Read-only; bounded by file count and depth. */
export async function scanRoots(roots: string[], options: { inspectContents?: boolean; nowMs?: number } = {}): Promise<ScanResult> {
  const started = Date.now();
  const files: ScannedFile[] = [];
  const units: ScannedUnit[] = [];
  const folderStats = new Map<string, { root: string; folder: string; files: number; bytes: number }>();
  let truncated = false;
  let contentReads = 0;
  const pending: Array<{ root: string; dir: string; depth: number }> = roots.map((root) => ({ root, dir: root, depth: 0 }));
  while (pending.length) {
    const { root, dir, depth } = pending.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (dir !== root) {
      const unit = unitKind(dir, entries);
      if (unit) { units.push({ path: dir, root, kind: unit.kind, protected: unit.protected, active: isActiveUnit(dir), entries: entries.length }); continue; }
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (/^(\$recycle\.bin|system volume information)$/i.test(e.name)) continue;
        if (depth < MAX_DEPTH) pending.push({ root, dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (files.length >= MAX_FILES) { truncated = true; break; }
      if (isCredentialFilePath(full)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      const ext = path.extname(e.name).toLowerCase();
      const head = readHead(full);
      const detected = detectType(head, ext);
      const rel = path.relative(root, full);
      const parentNames = path.dirname(rel) === '.' ? [] : path.dirname(rel).split(path.sep).map((s) => s.toLowerCase());
      let text: string | undefined;
      if (options.inspectContents && contentReads < MAX_CONTENT_READS && (detected === 'pdf' || detected === 'text')) {
        text = await readContentText(full, detected, st.size);
        if (text !== undefined) contentReads += 1;
      }
      const c = classifyFile({ name: e.name, ext, size: st.size, mtimeMs: st.mtimeMs, detected, text, parentNames, nowMs: options.nowMs });
      files.push({
        path: full, root, rel, name: e.name, ext, size: st.size, mtimeMs: Math.floor(st.mtimeMs), detected, mismatch: typeMismatch(ext, detected),
        category: c.category, reason: c.reason, confidence: c.confidence, ambiguous: c.ambiguous, year: c.year, contentRead: text !== undefined,
      });
      const top = parentNames[0] ?? '(top level)';
      const key = `${root}|${top}`;
      const fstat = folderStats.get(key) ?? { root, folder: top, files: 0, bytes: 0 };
      fstat.files += 1; fstat.bytes += st.size;
      folderStats.set(key, fstat);
    }
    if (truncated) break;
  }
  return { roots, files, units, folders: [...folderStats.values()].sort((a, b) => b.bytes - a.bytes), truncated, contentReads, elapsedMs: Date.now() - started };
}

/** Groups files with identical content. Size first, then SHA-256 within a bounded hashing budget. */
export async function findDuplicates(files: ScannedFile[]): Promise<{ sets: ScannedFile[][]; hashedBytes: number; budgetExceeded: boolean }> {
  const bySize = new Map<number, ScannedFile[]>();
  for (const f of files) if (f.size > 0 && f.category !== 'system' && f.category !== 'temporary') bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  let hashedBytes = 0;
  let budgetExceeded = false;
  const sets: ScannedFile[][] = [];
  for (const group of [...bySize.values()].filter((g) => g.length > 1).sort((a, b) => b[0].size - a[0].size)) {
    if (hashedBytes + group[0].size * group.length > DUPLICATE_HASH_BUDGET) { budgetExceeded = true; continue; }
    const byHash = new Map<string, ScannedFile[]>();
    for (const f of group) {
      try { f.sha256 = await sha256File(f.path); hashedBytes += f.size; } catch { continue; }
      byHash.set(f.sha256, [...(byHash.get(f.sha256) ?? []), f]);
    }
    // The keeper is the copy that looks original: not named "copy"/"Kopie"/"(2)", then the oldest, then the shortest name.
    const copyish = (f: ScannedFile) => (/\b(copy|kopie|duplicate)\b|\(\d+\)|[-_ ]\d$/i.test(path.basename(f.name, f.ext)) ? 1 : 0);
    for (const same of byHash.values()) if (same.length > 1) sets.push(same.sort((a, b) => copyish(a) - copyish(b) || a.mtimeMs - b.mtimeMs || a.name.length - b.name.length));
  }
  return { sets, hashedBytes, budgetExceeded };
}

export interface ProposeInput {
  roots: string[];
  targetBase?: string;
  inspectContents?: boolean;
  /** Folder names per category, relative to the target base ("" leaves that category in place). */
  hierarchy?: Partial<Record<FileCategory, string>>;
  origin?: OrganizationPlan['origin'];
  routineId?: string | null;
  /** Routine mode: only categories with an approved rule become moves; everything else is reported. */
  rules?: OrganizationRule[];
  nowMs?: number;
  /** Installers and archives older than this count as obsolete downloads. */
  obsoleteAfterDays?: number;
}

type PlannedMove = Omit<OrganizationMove, 'planId' | 'idx' | 'finalPath' | 'status' | 'error' | 'batch' | 'movedAt' | 'undoneAt'>;

/** Scans and builds a plan. Read-only: the plan is written to Core's journal, the disk is not touched. */
export async function proposeOrganization(db: CoreDatabase, input: ProposeInput, env: NodeJS.ProcessEnv = process.env): Promise<OrganizationPlan> {
  const roots: string[] = [];
  for (const raw of input.roots) {
    const v = validateRoot(raw, env);
    if (!v.ok) throw new CoreError('invalid_request', `Pandesh will not organize ${raw}: ${v.reason}.`);
    if (!roots.some((r) => r.toLowerCase() === v.root.toLowerCase())) roots.push(v.root);
  }
  if (roots.length === 0) throw new CoreError('invalid_request', 'name at least one folder to organize');
  for (const a of roots) for (const b of roots) if (a !== b && within(a, b)) throw new CoreError('invalid_request', `${a} is inside ${b}; name each folder once`);
  const documents = roots.find((r) => path.basename(r).toLowerCase() === 'documents');
  const targetBase = input.targetBase ? path.resolve(input.targetBase) : (documents ?? roots[0]);
  const tv = validateRoot(fs.existsSync(targetBase) ? targetBase : path.dirname(targetBase), env);
  if (!tv.ok) throw new CoreError('invalid_request', `the target folder is not allowed: ${tv.reason}`);

  const scan = await scanRoots(roots, { inspectContents: input.inspectContents, nowMs: input.nowMs });
  const dup = await findDuplicates(scan.files);
  const redundant = new Set<string>();
  for (const set of dup.sets) for (const f of set.slice(1)) redundant.add(f.path);

  const ruleFor = new Map<string, OrganizationRule>();
  for (const r of input.rules ?? []) ruleFor.set(`${r.sourceRoot}|${r.category}`, r);
  const routineMode = input.rules !== undefined;
  const nowMs = input.nowMs ?? Date.now();
  const obsoleteMs = (input.obsoleteAfterDays ?? 60) * 86_400_000;

  const moves: PlannedMove[] = [];
  const stays: Array<{ path: string; why: string }> = [];
  const ambiguous: Array<{ path: string; category: FileCategory; reason: string; suggested: string | null }> = [];
  const taken = new Set<string>();
  const reserve = (dir: string, name: string): string => {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let candidate = path.join(dir, name);
    for (let n = 2; taken.has(candidate.toLowerCase()) || fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
    taken.add(candidate.toLowerCase());
    return candidate;
  };

  for (const f of scan.files) {
    if (redundant.has(f.path)) {
      if (!routineMode) moves.push({ fromPath: f.path, toPath: reserve(path.join(targetBase, 'Archive', 'Duplicates'), f.name), size: f.size, mtimeMs: f.mtimeMs, sha256: f.sha256 ?? null, category: 'duplicate', reason: 'identical copy of an older file (same SHA-256); optional', ruleId: null });
      continue;
    }
    let rel: string | null;
    let ruleId: string | null = null;
    if (routineMode) {
      // An unattended run is never less careful than a person's plan: a file whose content contradicts its name is asked about.
      if (f.mismatch) { ambiguous.push({ path: f.path, category: f.category, reason: `its extension says ${f.ext} but it is really ${f.detected}`, suggested: destinationFor(f.category, f.year, input.hierarchy) }); continue; }
      const rule = ruleFor.get(`${f.root.toLowerCase()}|${f.category}`);
      if (!rule) {
        if (f.category !== 'system' && f.category !== 'temporary') ambiguous.push({ path: f.path, category: f.category, reason: `${f.reason}; no approved rule for "${f.category}" in this folder`, suggested: destinationFor(f.category, f.year, input.hierarchy) });
        continue;
      }
      rel = rule.destination.replace(/\{year\}/g, String(f.year));
      ruleId = rule.id;
    } else {
      rel = destinationFor(f.category, f.year, input.hierarchy);
    }
    if (rel === null) { stays.push({ path: f.path, why: f.category === 'temporary' ? 'temporary or unfinished download (flagged, not moved)' : f.category === 'system' ? 'system file' : `not recognized (${f.reason})` }); continue; }
    if (!routineMode && (f.ambiguous || f.mismatch)) { ambiguous.push({ path: f.path, category: f.category, reason: f.mismatch ? `its extension says ${f.ext} but it is really ${f.detected}` : f.reason, suggested: rel }); continue; }
    const base = routineMode ? f.root : targetBase;
    const destDir = path.join(base, rel);
    if (path.dirname(f.path).toLowerCase() === destDir.toLowerCase()) { stays.push({ path: f.path, why: 'already in its folder' }); continue; }
    const obsolete = (f.category === 'installers' || f.category === 'archives') && nowMs - f.mtimeMs > obsoleteMs;
    moves.push({ fromPath: f.path, toPath: reserve(destDir, f.name), size: f.size, mtimeMs: f.mtimeMs, sha256: f.sha256 ?? null, category: f.category, reason: `${f.reason}${obsolete ? `; obsolete download (${Math.floor((nowMs - f.mtimeMs) / 86_400_000)} days old)` : ''}`, ruleId });
  }
  if (!routineMode) {
    for (const u of scan.units) {
      if (u.protected) continue;
      if (u.kind === 'git repository' || /project|solution|workspace/.test(u.kind)) {
        const destDir = path.join(targetBase, 'Projects');
        if (path.dirname(u.path).toLowerCase() === destDir.toLowerCase()) continue;
        moves.push({ fromPath: u.path, toPath: reserve(destDir, path.basename(u.path)), size: 0, mtimeMs: 0, sha256: null, category: 'unit', reason: `${u.kind}${u.active ? ' (changed in the last 14 days — active)' : ''}; moved whole, only if you include project folders`, ruleId: null });
      }
    }
  }

  const byCategory: Record<string, { files: number; bytes: number; destination: string }> = {};
  for (const m of moves) {
    const key = String(m.category);
    const base = routineMode ? (roots.find((r) => within(m.fromPath, r)) ?? targetBase) : targetBase;
    const dest = path.relative(base, path.dirname(m.toPath)) || '.';
    const entry = byCategory[key] ?? { files: 0, bytes: 0, destination: key === 'unit' ? 'Projects' : dest.split(path.sep).join('/').replace(/\/\d{4}$/, '/{year}') };
    entry.files += 1; entry.bytes += m.size;
    byCategory[key] = entry;
  }
  const hierarchy = [...new Set(moves.map((m) => path.relative(targetBase, path.dirname(m.toPath))))].filter((d) => !d.startsWith('..')).sort();
  const temp = scan.files.filter((f) => f.category === 'temporary');
  const redundantFiles = dup.sets.flatMap((s) => s.slice(1));
  const crossVolume = moves.filter((m) => !sameVolume(m.fromPath, m.toPath)).length;
  const risks: string[] = [];
  if (crossVolume) risks.push(`${crossVolume} move(s) cross drives: each file is copied, its SHA-256 verified, and only then is the original removed`);
  const activeUnits = scan.units.filter((u) => !u.protected && u.active);
  if (activeUnits.length) risks.push(`${activeUnits.length} project folder(s) changed in the last 14 days; moving them can break editors, terminals or build paths — they are excluded unless you include project folders`);
  if (scan.units.some((u) => u.protected)) risks.push(`${scan.units.filter((u) => u.protected).length} model, environment or application folder(s) are never moved`);
  if (scan.truncated) risks.push(`the scan stopped at ${MAX_FILES} files; run it again on narrower folders for the rest`);
  if (scan.files.some((f) => f.mismatch)) risks.push(`${scan.files.filter((f) => f.mismatch).length} file(s) have an extension that does not match their real type`);
  risks.push('a file open in another program cannot be moved; it is reported and stays where it is');

  const summary: Record<string, unknown> = {
    inspectContents: input.inspectContents === true,
    contentReads: scan.contentReads,
    scanned: { files: scan.files.length, bytes: scan.files.reduce((s, f) => s + f.size, 0), units: scan.units.length, elapsedMs: scan.elapsedMs, truncated: scan.truncated },
    inventory: scan.folders.slice(0, 30),
    byCategory,
    hierarchy,
    stays: { count: stays.length, examples: stays.slice(0, 15) },
    ambiguous: { count: ambiguous.length, examples: ambiguous.slice(0, 25) },
    units: scan.units.slice(0, 40).map((u) => ({ path: u.path, kind: u.kind, protected: u.protected, active: u.active })),
    duplicates: { sets: dup.sets.length, redundantFiles: redundantFiles.length, redundantBytes: redundantFiles.reduce((s, f) => s + f.size, 0), budgetExceeded: dup.budgetExceeded, examples: dup.sets.slice(0, 8).map((s) => ({ keep: s[0].path, copies: s.slice(1).map((f) => f.path), bytes: s[0].size })) },
    temporary: { files: temp.length, bytes: temp.reduce((s, f) => s + f.size, 0), examples: temp.slice(0, 8).map((f) => f.path) },
    mismatches: scan.files.filter((f) => f.mismatch).slice(0, 10).map((f) => ({ path: f.path, realType: f.detected })),
    obsoleteDownloads: moves.filter((m) => /obsolete download/.test(m.reason)).length,
    crossVolumeMoves: crossVolume,
    risks,
  };
  return createOrganizationPlan(db, { origin: input.origin ?? 'chat', roots, targetBase, summary, moves, routineId: input.routineId ?? null });
}

export interface ApplyOptions {
  actor: string;
  /** Approval binds the plan to this digest; a plan that changed since is refused. */
  expectedDigest?: string;
  categories?: string[];
  includeUnits?: boolean;
  archiveDuplicates?: boolean;
  batchSize?: number;
  saveRules?: boolean;
  /** Stop after this many moves (routines). */
  maxMoves?: number;
}

export interface ApplyReport {
  plan: OrganizationPlan;
  counts: ReturnType<typeof moveCounts>;
  movedNow: number;
  verifiedNow: number;
  skippedNow: Array<{ path: string; why: string }>;
  failedNow: Array<{ path: string; why: string }>;
  batches: number;
  rulesSaved: number;
  remaining: number;
}

function selected(m: OrganizationMove, opts: ApplyOptions): boolean {
  if (m.category === 'unit') return opts.includeUnits === true;
  if (m.category === 'duplicate') return opts.archiveDuplicates === true;
  return !opts.categories?.length || opts.categories.includes(m.category);
}

function dirEntryCount(dir: string): number { try { return fs.readdirSync(dir).length; } catch { return -1; } }

/** Verifies a row that reached the disk (a recovered `moved` row): at the destination, gone from the source, same size and hash. */
async function verifyMovedRow(db: CoreDatabase, m: OrganizationMove): Promise<boolean> {
  const at = m.finalPath ?? m.toPath;
  try {
    if (fs.existsSync(m.fromPath)) throw new Error('the source still exists');
    if (!fs.existsSync(at)) throw new Error('not at the destination');
    if (m.category !== 'unit') {
      if (fs.statSync(at).size !== m.size) throw new Error('size changed');
      if (m.sha256 && m.size <= HASH_LIMIT && (await sha256File(at)) !== m.sha256) throw new Error('content hash changed');
    }
    updateMove(db, m.planId, m.idx, { status: 'verified', error: null });
    return true;
  } catch (err) {
    updateMove(db, m.planId, m.idx, { status: 'failed', error: `recovered move not verified: ${err instanceof Error ? err.message : String(err)}` });
    return false;
  }
}

/** Settles a row left `moving` by an interrupted apply, by looking at the disk. */
function recoverMoving(db: CoreDatabase, m: OrganizationMove): OrganizationMove['status'] {
  const at = m.finalPath;
  const srcExists = fs.existsSync(m.fromPath);
  const dstExists = Boolean(at && fs.existsSync(at));
  if (!srcExists && dstExists) { updateMove(db, m.planId, m.idx, { status: 'moved', movedAt: nowIso() }); return 'moved'; }
  if (srcExists && dstExists && m.category !== 'unit') {
    // Interrupted mid-copy across drives: the partial copy is not trusted; the original is intact.
    try { if (fs.statSync(at!).size !== fs.statSync(m.fromPath).size) fs.unlinkSync(at!); } catch { /* reported below */ }
  }
  updateMove(db, m.planId, m.idx, { status: 'planned', finalPath: null });
  return 'planned';
}

async function moveOne(db: CoreDatabase, m: OrganizationMove, batch: number): Promise<{ ok: true } | { ok: false; skipped: boolean; why: string }> {
  let st: fs.Stats;
  try { st = fs.statSync(m.fromPath); } catch {
    updateMove(db, m.planId, m.idx, { status: 'skipped', error: 'the source is gone', batch });
    return { ok: false, skipped: true, why: 'the source is gone' };
  }
  const isUnit = m.category === 'unit';
  if (!isUnit && (st.size !== m.size || Math.floor(st.mtimeMs) !== m.mtimeMs)) {
    updateMove(db, m.planId, m.idx, { status: 'skipped', error: 'changed since the plan was made', batch });
    return { ok: false, skipped: true, why: 'changed since the plan was made' };
  }
  if (isUnit && !sameVolume(m.fromPath, m.toPath)) {
    updateMove(db, m.planId, m.idx, { status: 'skipped', error: 'a project folder is only moved within the same drive', batch });
    return { ok: false, skipped: true, why: 'a project folder is only moved within the same drive' };
  }
  // Collision handling at execution time: something may have appeared at the destination since the plan.
  let dest = m.toPath;
  const ext = isUnit ? '' : path.extname(dest);
  const stem = isUnit ? path.basename(dest) : path.basename(dest, ext);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(path.dirname(m.toPath), `${stem} (${n})${ext}`);
  let sha = m.sha256;
  if (!isUnit && !sha && m.size <= HASH_LIMIT) sha = await sha256File(m.fromPath);
  const entriesBefore = isUnit ? dirEntryCount(m.fromPath) : 0;
  // Write-ahead: the journal names the destination before the disk changes.
  updateMove(db, m.planId, m.idx, { status: 'moving', finalPath: dest, sha256: sha, batch, error: null });
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (sameVolume(m.fromPath, dest)) {
      fs.renameSync(m.fromPath, dest);
    } else {
      fs.copyFileSync(m.fromPath, dest, fs.constants.COPYFILE_EXCL);
      const copySha = await sha256File(dest);
      if (sha && copySha !== sha) { fs.unlinkSync(dest); throw new Error('the copy did not match the original; the original was kept'); }
      fs.utimesSync(dest, st.atime, st.mtime);
      fs.unlinkSync(m.fromPath);
    }
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(/^[A-Z]+: /, '') : String(err);
    if (fs.existsSync(m.fromPath)) updateMove(db, m.planId, m.idx, { status: 'failed', error: why.slice(0, 300), finalPath: null });
    else updateMove(db, m.planId, m.idx, { status: 'moved', movedAt: nowIso() });
    return fs.existsSync(m.fromPath) ? { ok: false, skipped: false, why } : { ok: true };
  }
  updateMove(db, m.planId, m.idx, { status: 'moved', movedAt: nowIso() });
  // Verify: present at the destination, gone from the source, same size (and same content where hashed).
  try {
    if (fs.existsSync(m.fromPath)) throw new Error('the source still exists');
    if (isUnit) {
      if (dirEntryCount(dest) !== entriesBefore) throw new Error('the folder content count changed');
    } else {
      const after = fs.statSync(dest);
      if (after.size !== m.size) throw new Error(`size ${after.size} ≠ ${m.size}`);
      if (sha && sameVolume(m.fromPath, dest) && m.size <= HASH_LIMIT && (await sha256File(dest)) !== sha) throw new Error('content hash changed');
    }
  } catch (err) {
    updateMove(db, m.planId, m.idx, { status: 'failed', error: `moved but not verified: ${err instanceof Error ? err.message : String(err)}` });
    return { ok: false, skipped: false, why: `moved but not verified: ${err instanceof Error ? err.message : String(err)}` };
  }
  updateMove(db, m.planId, m.idx, { status: 'verified' });
  return { ok: true };
}

/**
 * Applies a plan in batches. Safe to call again after a crash or a partial run: verified rows are never touched again,
 * `moving` rows are settled from the disk first, and failed rows are retried.
 */
export async function applyOrganizationPlan(db: CoreDatabase, planId: string, opts: ApplyOptions): Promise<ApplyReport> {
  let plan = getOrganizationPlan(db, planId);
  if (plan.status === 'undone' || plan.status === 'declined') throw new CoreError('invalid_transition', `plan ${planId} is ${plan.status}; make a new plan`);
  if (opts.expectedDigest && opts.expectedDigest !== plan.digest) throw new CoreError('invalid_request', 'the approved plan does not match the stored plan; nothing was moved');
  plan = updatePlan(db, planId, { status: 'applying', approvedBy: plan.approvedBy ?? opts.actor, approvedAt: plan.approvedAt ?? nowIso() });
  for (const m of listPlanMoves(db, planId, { status: ['moving'] })) recoverMoving(db, m);
  for (const m of listPlanMoves(db, planId, { status: ['moved'] })) await verifyMovedRow(db, m);
  const todo = listPlanMoves(db, planId, { status: ['planned', 'failed'] }).filter((m) => selected(m, opts));
  const limit = Math.min(todo.length, opts.maxMoves ?? todo.length);
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize ?? DEFAULT_BATCH));
  const report: ApplyReport = { plan, counts: moveCounts(db, planId), movedNow: 0, verifiedNow: 0, skippedNow: [], failedNow: [], batches: 0, rulesSaved: 0, remaining: 0 };
  const priorBatches = Number(db.get<{ b: number | null }>('SELECT MAX(batch) AS b FROM organization_moves WHERE planId = ?', [planId])?.b ?? 0);
  for (let i = 0; i < limit; i += batchSize) {
    const batch = priorBatches + 1 + report.batches;
    report.batches += 1;
    for (const m of todo.slice(i, Math.min(limit, i + batchSize))) {
      const r = await moveOne(db, m, batch);
      if (r.ok) { report.movedNow += 1; report.verifiedNow += 1; } else if (r.skipped) report.skippedNow.push({ path: m.fromPath, why: r.why }); else report.failedNow.push({ path: m.fromPath, why: r.why });
    }
  }
  if (opts.saveRules) {
    const seen = new Set<string>();
    for (const m of listPlanMoves(db, planId, { status: ['verified'] })) {
      if (m.category === 'unit' || m.category === 'duplicate') continue;
      const root = plan.roots.find((r) => within(m.fromPath, r));
      if (!root || seen.has(`${root}|${m.category}`)) continue;
      seen.add(`${root}|${m.category}`);
      const relDest = path.relative(root, path.dirname(m.finalPath ?? m.toPath)).replace(/(^|[\\/])\d{4}$/, '$1{year}');
      upsertOrganizationRule(db, { sourceRoot: root, category: m.category as FileCategory, destination: relDest, createdFromPlan: planId, approvedBy: opts.actor });
      report.rulesSaved += 1;
    }
  }
  const counts = moveCounts(db, planId);
  const remaining = listPlanMoves(db, planId, { status: ['planned', 'failed'] }).filter((m) => selected(m, opts)).length;
  const optionalLeft = listPlanMoves(db, planId, { status: ['planned'] }).filter((m) => !selected(m, opts)).length;
  plan = updatePlan(db, planId, { status: remaining === 0 && counts.failed === 0 && optionalLeft === 0 ? 'applied' : 'partially_applied', appliedAt: nowIso() });
  return { ...report, plan, counts, remaining };
}

/** Reverses every move that reached the disk, newest first, and removes folders the plan created if they are now empty. */
export async function undoOrganizationPlan(db: CoreDatabase, planId: string): Promise<{ plan: OrganizationPlan; restored: number; problems: Array<{ path: string; why: string }>; removedFolders: number }> {
  const plan = getOrganizationPlan(db, planId);
  for (const m of listPlanMoves(db, planId, { status: ['moving'] })) recoverMoving(db, m);
  const done = listPlanMoves(db, planId, { status: ['moved', 'verified'] }).reverse();
  const problems: Array<{ path: string; why: string }> = [];
  let restored = 0;
  const touchedDirs = new Set<string>();
  for (const m of done) {
    const at = m.finalPath ?? m.toPath;
    try {
      if (!fs.existsSync(at)) throw new Error('the moved file is no longer where Pandesh put it');
      if (m.category !== 'unit' && fs.statSync(at).size !== m.size) throw new Error('it was changed after the move; left in place');
      let back = m.fromPath;
      if (fs.existsSync(back)) {
        const ext = m.category === 'unit' ? '' : path.extname(back);
        back = path.join(path.dirname(m.fromPath), `${path.basename(m.fromPath, ext)} (restored)${ext}`);
      }
      fs.mkdirSync(path.dirname(back), { recursive: true });
      if (sameVolume(at, back)) fs.renameSync(at, back);
      else {
        fs.copyFileSync(at, back, fs.constants.COPYFILE_EXCL);
        if (m.sha256 && (await sha256File(back)) !== m.sha256) { fs.unlinkSync(back); throw new Error('the restored copy did not verify; the file was left where it was'); }
        fs.unlinkSync(at);
      }
      updateMove(db, planId, m.idx, { status: 'undone', undoneAt: nowIso(), error: back === m.fromPath ? null : `restored as ${path.basename(back)} because the original name is taken` });
      restored += 1;
      for (let d = path.dirname(at); within(d, plan.targetBase) && d.toLowerCase() !== plan.targetBase.toLowerCase(); d = path.dirname(d)) touchedDirs.add(d);
      for (const root of plan.roots) for (let d = path.dirname(at); within(d, root) && d.toLowerCase() !== root.toLowerCase(); d = path.dirname(d)) touchedDirs.add(d);
    } catch (err) {
      problems.push({ path: at, why: err instanceof Error ? err.message : String(err) });
    }
  }
  let removedFolders = 0;
  for (const d of [...touchedDirs].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(d).length === 0) { fs.rmdirSync(d); removedFolders += 1; } } catch { /* not empty or gone */ }
  }
  const next = updatePlan(db, planId, { status: problems.length ? 'partially_undone' : 'undone', undoneAt: nowIso() });
  return { plan: next, restored, problems, removedFolders };
}

// ------------------------------------------------------------------ presentation

export function renderPlanPreview(db: CoreDatabase, plan: OrganizationPlan, limit = 25): string {
  const s = plan.summary as Record<string, any>;
  const counts = moveCounts(db, plan.id);
  const moves = listPlanMoves(db, plan.id);
  const core = moves.filter((m) => m.category !== 'unit' && (m.category as string) !== 'duplicate');
  const lines: string[] = [];
  const state = plan.status === 'proposed' ? 'PROPOSED — nothing has been changed yet' : plan.status.toUpperCase().replace('_', ' ');
  lines.push(`PC organization plan ${plan.id} — ${state}`);
  lines.push(`Scanned ${plan.roots.join(', ')}: ${s.scanned.files} files (${fmtBytes(s.scanned.bytes)}) in ${(s.scanned.elapsedMs / 1000).toFixed(1)} s; read names, sizes, dates and file-type headers${s.inspectContents ? `; read the text of ${s.contentReads} documents locally (text not stored)` : '; file contents were not read'}.`);
  lines.push('', 'Existing folders (largest first):');
  for (const f of (s.inventory ?? []).slice(0, 10)) lines.push(`- ${path.join(f.root, f.folder === '(top level)' ? '' : f.folder)}${f.folder === '(top level)' ? ' (loose files)' : ''}: ${f.files} files, ${fmtBytes(f.bytes)}`);
  lines.push('', `Recommended hierarchy under ${plan.targetBase}:`);
  for (const [cat, v] of Object.entries(s.byCategory ?? {}) as Array<[string, any]>) {
    if (cat === 'unit' || cat === 'duplicate') continue;
    lines.push(`- ${v.destination}  ← ${v.files} ${cat} file(s), ${fmtBytes(v.bytes)}`);
  }
  lines.push('', `Files that would move: ${core.length} (${fmtBytes(core.reduce((t, m) => t + m.size, 0))}). Exact preview${core.length > limit ? ` (first ${limit})` : ''}:`);
  for (const m of core.slice(0, limit)) lines.push(`- ${m.fromPath} → ${m.toPath}  [${m.reason}]`);
  const units = moves.filter((m) => m.category === 'unit');
  const protectedUnits = (s.units ?? []).filter((u: any) => u.protected);
  if (units.length || protectedUnits.length) {
    lines.push('', 'Projects and application folders (kept whole):');
    for (const u of units.slice(0, 10)) lines.push(`- ${u.fromPath} → ${u.toPath} only if you include project folders [${u.reason}]`);
    for (const u of protectedUnits.slice(0, 10)) lines.push(`- ${u.path} stays: ${u.kind} (never moved)`);
  }
  lines.push('', `Stays in place: ${s.stays.count} file(s)${s.stays.examples.length ? `, e.g. ${s.stays.examples.slice(0, 4).map((e: any) => `${path.basename(e.path)} (${e.why})`).join('; ')}` : ''}.`);
  if (s.ambiguous.count) {
    lines.push(`Needs your decision: ${s.ambiguous.count} file(s) Pandesh is not sure about (not moved):`);
    for (const a of s.ambiguous.examples.slice(0, 8)) lines.push(`- ${a.path} — ${a.reason}${a.suggested ? `; suggested ${a.suggested}` : ''}`);
  }
  const d = s.duplicates;
  lines.push('', `Duplicates: ${d.sets} set(s), ${d.redundantFiles} redundant cop${d.redundantFiles === 1 ? 'y' : 'ies'} (${fmtBytes(d.redundantBytes)}).${d.redundantFiles ? ' They can be moved to Archive/Duplicates if you include that option; Pandesh never deletes them.' : ''}`);
  for (const e of d.examples.slice(0, 4)) lines.push(`- keep ${e.keep}; copies: ${e.copies.join(', ')}`);
  lines.push(`Temporary files: ${s.temporary.files} (${fmtBytes(s.temporary.bytes)})${s.temporary.examples.length ? `, e.g. ${s.temporary.examples.slice(0, 3).map((p: string) => path.basename(p)).join(', ')}` : ''} — flagged, not moved or deleted.`);
  if (s.obsoleteDownloads) lines.push(`Obsolete downloads (old installers/archives) in the plan: ${s.obsoleteDownloads}, moved to Archive.`);
  lines.push(`Estimated space you could recover by deleting the redundant copies and temporary files yourself: ${fmtBytes(d.redundantBytes + s.temporary.bytes)}. Organizing alone frees no space.`);
  if (s.mismatches?.length) lines.push(`Type mismatches: ${s.mismatches.map((m: any) => `${path.basename(m.path)} is really ${m.realType}`).join('; ')}.`);
  lines.push('', 'Risks and dependencies:', ...s.risks.map((r: string) => `- ${r}`));
  if (plan.status !== 'proposed') lines.push('', `Journal: ${counts.verified} verified, ${counts.moved} moved, ${counts.planned} not yet moved, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.undone} undone.`);
  else lines.push('', `Plan digest ${plan.digest.slice(0, 12)}. To apply: pc_organize_apply planId="${plan.id}" (asks for your approval). Undo afterwards: pc_organize_undo planId="${plan.id}".`);
  return lines.join('\n');
}

export function renderApplyReport(r: ApplyReport): string {
  const lines = [`Applied plan ${r.plan.id} in ${r.batches} batch(es): ${r.verifiedNow} file(s) moved and verified now; journal total ${r.counts.verified} verified, ${r.counts.skipped} skipped, ${r.counts.failed} failed, ${r.remaining} remaining.`];
  if (r.skippedNow.length) lines.push(`Skipped (${r.skippedNow.length}): ${r.skippedNow.slice(0, 8).map((s) => `${path.basename(s.path)} — ${s.why}`).join('; ')}`);
  if (r.failedNow.length) lines.push(`Failed (${r.failedNow.length}, still in place and retried on the next apply): ${r.failedNow.slice(0, 8).map((s) => `${path.basename(s.path)} — ${s.why}`).join('; ')}`);
  if (r.rulesSaved) lines.push(`Saved ${r.rulesSaved} folder rule(s): a weekly routine may apply exactly these destinations, and nothing else.`);
  lines.push(`Verification: every moved file exists at its new path, is gone from the old path, and has the same size${r.verifiedNow ? ' and SHA-256' : ''}. Undo: pc_organize_undo planId="${r.plan.id}".`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ governed capability

const okResult = (output: string, category: string, normalizedArguments?: Record<string, unknown>): ToolExecutionResult => ({ status: 'succeeded', exitCode: 0, output, resultCategory: category, ...(normalizedArguments ? { normalizedArguments } : {}) });
const failResult = (output: string, category: string): ToolExecutionResult => ({ status: 'failed', exitCode: null, output, resultCategory: category });

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/[;\n]|,(?=\s*[A-Za-z]:\\|\s*~)/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function createPcOrganizerAdapter(deps: { db: CoreDatabase; env?: NodeJS.ProcessEnv }): GovernedCapabilityAdapter {
  const { db } = deps;
  const env = deps.env ?? process.env;
  return {
    id: 'pc-organizer',
    definitions: () => [
      {
        name: 'pc_organize_scan',
        description: 'Scan folders the user names (e.g. Downloads, Documents, Desktop, or exact paths) and propose an organization plan: folder inventory, recommended hierarchy (Tax, Finance, Personal, Career, Business, Projects, AI, Experiments, Media, Archive, Inbox), the exact files that would move, what stays, project/model folders kept whole, duplicates, temporary files, estimated space and risks. Changes nothing on disk. Needs approval because it reads private folders; set inspectContents only if the user allows reading document text locally.',
        parameters: {
          type: 'object',
          properties: {
            roots: { type: 'array', items: { type: 'string' }, description: 'Folders to scan, e.g. ["Downloads"] or ["C:\\\\Users\\\\me\\\\Documents"].' },
            targetBase: { type: 'string', description: 'Folder the new hierarchy is created in. Defaults to Documents when scanned, else the first folder.' },
            inspectContents: { type: 'boolean', description: 'Read PDF/text contents locally to classify better. Only when the user agreed.' },
          },
          required: ['roots'],
        },
      },
      {
        name: 'pc_organize_plan',
        description: 'Show an organization plan (or list recent plans when no planId is given) with its exact move preview and journal state. Read-only.',
        parameters: { type: 'object', properties: { planId: { type: 'string' }, limit: { type: 'number', description: 'How many moves to preview (default 25).' } } },
      },
      {
        name: 'pc_organize_apply',
        description: 'Apply an approved organization plan in verified batches (moves only, never deletes). Asks for approval showing the exact plan. Options: categories (subset), includeUnits (also move project folders whole), archiveDuplicates (move redundant copies to Archive/Duplicates), saveRules (let a weekly routine apply the same destinations). Re-running continues where it stopped without repeating completed moves.',
        parameters: {
          type: 'object',
          properties: {
            planId: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } }, includeUnits: { type: 'boolean' },
            archiveDuplicates: { type: 'boolean' }, saveRules: { type: 'boolean' }, batchSize: { type: 'number' },
          },
          required: ['planId'],
        },
      },
      {
        name: 'pc_organize_undo',
        description: 'Undo an applied organization plan: every moved file goes back to where it was (renamed "(restored)" only if that name is now taken), and folders the plan created are removed when empty. Asks for approval.',
        parameters: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'] },
      },
    ],
    classify: (toolName) => (toolName === 'pc_organize_plan' ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    /** Freezes what the approval card must show: the resolved folders, or the exact plan with its digest. */
    async prepare(toolName, args) {
      if (toolName === 'pc_organize_scan') {
        const roots = stringList(args.roots).map((r) => { const v = validateRoot(r, env); return v.ok ? v.root : r; });
        return { ...args, roots, inspectContents: args.inspectContents === true, reads: args.inspectContents === true ? 'names, sizes, dates, file-type headers and document text (locally)' : 'names, sizes, dates and file-type headers only' };
      }
      if (toolName === 'pc_organize_apply' || toolName === 'pc_organize_undo') {
        try {
          const plan = getOrganizationPlan(db, String(args.planId ?? ''));
          const moves = listPlanMoves(db, plan.id).filter((m) => toolName === 'pc_organize_undo' ? m.status === 'verified' || m.status === 'moved' : selected(m, { actor: '', categories: stringList(args.categories), includeUnits: args.includeUnits === true, archiveDuplicates: args.archiveDuplicates === true }) && (m.status === 'planned' || m.status === 'failed'));
          return {
            ...args, planId: plan.id, planDigest: plan.digest, targetBase: plan.targetBase, files: moves.length,
            bytes: moves.reduce((t, m) => t + m.size, 0), firstMoves: moves.slice(0, 5).map((m) => toolName === 'pc_organize_undo' ? `${m.finalPath ?? m.toPath} → ${m.fromPath}` : `${m.fromPath} → ${m.toPath}`),
          };
        } catch { return args; }
      }
      return args;
    },
    async run(call: ModelToolCall): Promise<ToolExecutionResult> {
      const args = call.arguments ?? {};
      try {
        if (call.name === 'pc_organize_scan') {
          const roots = stringList(args.roots);
          if (!roots.length) return failResult('roots is required: name the folders to scan.', 'invalid_arguments');
          const plan = await proposeOrganization(db, { roots, targetBase: typeof args.targetBase === 'string' && args.targetBase.trim() ? args.targetBase : undefined, inspectContents: args.inspectContents === true }, env);
          return okResult(renderPlanPreview(db, plan), 'organization_plan_proposed', { planId: plan.id });
        }
        if (call.name === 'pc_organize_plan') {
          if (!args.planId) {
            const plans = listOrganizationPlans(db, 10);
            if (!plans.length) return okResult('No organization plans yet. Use pc_organize_scan to make one.', 'organization_plans_listed');
            return okResult(plans.map((p) => `- ${p.id} (${p.status}, ${p.origin}) ${p.roots.join(', ')} → ${p.targetBase}, created ${p.createdAt}`).join('\n'), 'organization_plans_listed');
          }
          return okResult(renderPlanPreview(db, getOrganizationPlan(db, String(args.planId)), Number(args.limit) > 0 ? Math.min(200, Number(args.limit)) : 25), 'organization_plan_shown');
        }
        if (call.name === 'pc_organize_apply') {
          const report = await applyOrganizationPlan(db, String(args.planId ?? ''), {
            actor: 'chat-approval', expectedDigest: typeof args.planDigest === 'string' ? args.planDigest : undefined, categories: stringList(args.categories),
            includeUnits: args.includeUnits === true, archiveDuplicates: args.archiveDuplicates === true, saveRules: args.saveRules === true,
            batchSize: Number(args.batchSize) > 0 ? Number(args.batchSize) : undefined,
          });
          return { ...okResult(renderApplyReport(report), report.failedNow.length ? 'organization_partially_applied' : 'organization_applied'), status: report.failedNow.length && !report.verifiedNow ? 'failed' : 'succeeded' };
        }
        if (call.name === 'pc_organize_undo') {
          const r = await undoOrganizationPlan(db, String(args.planId ?? ''));
          return okResult(`Undo of ${r.plan.id}: ${r.restored} item(s) restored to their original place; ${r.removedFolders} empty folder(s) removed.${r.problems.length ? ` Not restored (${r.problems.length}): ${r.problems.slice(0, 6).map((p) => `${path.basename(p.path)} — ${p.why}`).join('; ')}` : ''}`, r.problems.length ? 'organization_partially_undone' : 'organization_undone');
        }
        return failResult(`unknown tool '${call.name}'`, 'invalid_arguments');
      } catch (err) {
        return failResult(err instanceof Error ? err.message : String(err), err instanceof CoreError ? 'organization_refused' : 'organization_failed');
      }
    },
  };
}
