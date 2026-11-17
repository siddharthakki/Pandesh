/**
 * What a Bot is allowed to look at. Each source is Core's own read-only code (the Gmail connection behind its
 * permission gate, the software inventory and update check, AI Radar, git and the log files): a Bot never gets a
 * tool of its own. A source returns bounded text for the Bot to reason over, a list of items with stable ids (so
 * Core can tell what is new since the last report) and the references a conclusion can cite.
 *
 * Nothing here installs, sends, deletes, edits or restarts anything.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../../db/connection';
import type { ConnectorId } from '../../shared/wireTypes';
import type { ConnectorAdapter } from '../connectors/connectorCapability';
import { readConnector } from '../assistantBrief';
import { buildDailyBriefing, type BriefingReader } from '../dailyBriefing';
import { collectSoftwareInventory, type SoftwareInventory } from '../software/inventory';
import { checkForUpdates, readUpdateState, type UpdateState } from '../software/updates';
import { scanAiRadar, readRadarState, type RadarScanResult } from '../aiRadar';
import { detectGpu, type GpuInfo } from '../hardwareCapacity';
import type { BotRecord, BotSourceId } from './botStore';

export interface BotEvidenceItem { id: string; text: string }
export interface BotEvidence {
  /** One line of counts Core computed itself. It heads the delivered report, so the numbers never depend on the model. */
  facts?: string;
  source: BotSourceId;
  ok: boolean;
  /** Why the source could not be read; null when it was. */
  reason: string | null;
  /** True when the text holds personal content that must stay on this PC. */
  privateData: boolean;
  /** Facts for the Bot, bounded. */
  text: string;
  items: BotEvidenceItem[];
  /** What a conclusion may cite: file:line, commit ids, log files, Gmail ids, URLs. */
  refs: string[];
}

export interface BotSourceDeps {
  db: CoreDatabase;
  dataDir: string;
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
  now?: () => Date;
  signal?: AbortSignal;
  /** Test seams: every external read can be replaced. */
  inventory?: () => Promise<SoftwareInventory>;
  updates?: (inv: SoftwareInventory) => Promise<UpdateState>;
  radar?: (installed: Array<{ name: string; version: string | null }>) => Promise<RadarScanResult>;
  gpu?: () => GpuInfo | null;
  disks?: () => Array<{ drive: string; freeGb: number; totalGb: number }>;
  git?: (repo: string, args: string[]) => Promise<{ ok: boolean; out: string }>;
  installRoot?: string | null;
}

const MAX_SOURCE_CHARS = 5200;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bounded = (lines: string[]) => clip(lines.join('\n'), MAX_SOURCE_CHARS);
const unavailable = (source: BotSourceId, reason: string, privateData = false): BotEvidence => ({ source, ok: false, reason, privateData, text: `Not available: ${reason}`, items: [], refs: [] });

// ── Gmail inbox ──────────────────────────────────────────────────────────────────────────────

async function gmailInbox(deps: BotSourceDeps): Promise<BotEvidence> {
  const adapters = deps.connectorRegistry ?? new Map<ConnectorId, ConnectorAdapter>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const read: BriefingReader = async (toolName, args) => {
      const result = await readConnector(deps.db, adapters, toolName === 'gmail_search' ? 'gmail' : 'google_calendar', toolName, args, deps.dataDir, controller.signal);
      return result.ok ? { ok: true, data: result.data } : { ok: false, reason: result.reason ?? 'the service could not be read' };
    };
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const briefing = await buildDailyBriefing(deps.db, { nowMs: (deps.now?.() ?? new Date()).getTime(), timeZone, read });
    const email = briefing.email;
    if (email.status === 'unavailable') return unavailable('gmail_inbox', email.reason ?? 'Gmail is not connected', true);
    const lines: string[] = [`Coverage: ${email.coverage}${email.status === 'partial' ? ' (partial)' : ''}`,
      `Left out as low value: ${email.suppressed.promotion} promotions, ${email.suppressed.lowSignal} low-signal, ${email.suppressed.replied} already answered.`, '', 'NEEDS ATTENTION:'];
    const items: BotEvidenceItem[] = [];
    const refs: string[] = [];
    for (const m of email.surfaced.slice(0, 15)) {
      const line = `- [Gmail ${m.id}] from ${clip(m.from, 60)} | ${clip(m.subject, 90)} | why: ${m.why}${m.dateYmd ? ` | date ${m.dateYmd}` : ''} | suggested: ${m.action}`;
      lines.push(line); items.push({ id: `gmail:${m.id}`, text: line }); refs.push(`Gmail ${m.id}`);
    }
    if (email.surfaced.length === 0) lines.push('- (nothing)');
    lines.push('', 'CAN WAIT:');
    for (const m of email.canWait.slice(0, 10)) {
      const line = `- [Gmail ${m.id}] from ${clip(m.from, 50)} | ${clip(m.subject, 80)} | ${m.why}`;
      lines.push(line); items.push({ id: `gmail:${m.id}`, text: line }); refs.push(`Gmail ${m.id}`);
    }
    if (email.canWait.length === 0) lines.push('- (nothing)');
    const cal = briefing.calendar;
    lines.push('', 'APPOINTMENTS:');
    if (cal.status === 'unavailable') lines.push(`- calendar not available: ${cal.reason ?? 'not connected'}`);
    else {
      const entry = (e: unknown) => { const v = e as { title?: string; summary?: string; start?: string; time?: string }; return `${v.time ?? v.start ?? ''} ${v.title ?? v.summary ?? ''}`.trim(); };
      for (const e of cal.today.slice(0, 6)) lines.push(`- today: ${clip(entry(e), 100)}`);
      for (const e of cal.tomorrow.slice(0, 6)) lines.push(`- tomorrow: ${clip(entry(e), 100)}`);
      if (cal.today.length + cal.tomorrow.length === 0) lines.push('- (none today or tomorrow)');
    }
    return { source: 'gmail_inbox', ok: true, facts: `Inbox: ${email.surfaced.length} message(s) need attention, ${email.canWait.length} can wait, ${email.suppressed.promotion + email.suppressed.lowSignal + email.suppressed.replied} left out as low value.`, reason: email.status === 'partial' ? email.reason : null, privateData: true, text: bounded(lines), items, refs };
  } catch (err) {
    return unavailable('gmail_inbox', err instanceof Error ? err.message : String(err), true);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

// ── This PC ──────────────────────────────────────────────────────────────────────────────────

function readDisks(): Array<{ drive: string; freeGb: number; totalGb: number }> {
  const out: Array<{ drive: string; freeGb: number; totalGb: number }> = [];
  const roots = process.platform === 'win32' ? 'CDEFGH'.split('').map((l) => `${l}:\\`) : ['/'];
  for (const root of roots) {
    try {
      const s = fs.statfsSync(root);
      const total = Number(s.blocks) * Number(s.bsize); const free = Number(s.bavail) * Number(s.bsize);
      if (total > 0) out.push({ drive: root.replace(/\\$/, ''), freeGb: Math.round(free / 1e9), totalGb: Math.round(total / 1e9) });
    } catch { /* no such drive */ }
  }
  return out;
}

const UPDATE_CHECK_MAX_AGE_MS = 20 * 3_600_000;

async function pcSoftware(deps: BotSourceDeps): Promise<BotEvidence> {
  try {
    const inv = await (deps.inventory ?? (() => collectSoftwareInventory({ dataDir: deps.dataDir })))();
    const now = (deps.now?.() ?? new Date()).getTime();
    let state: UpdateState;
    let checkNote = '';
    if (deps.updates) state = await deps.updates(inv);
    else {
      state = readUpdateState(deps.dataDir);
      const last = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : NaN;
      if (!Number.isFinite(last) || now - last > UPDATE_CHECK_MAX_AGE_MS) {
        try { state = await checkForUpdates(inv, { dataDir: deps.dataDir }, 'periodic'); }
        catch (err) { checkNote = ` (a new check failed: ${err instanceof Error ? err.message : String(err)}; showing the last stored result)`; }
      }
    }
    const updates = state.results.filter((u) => u.status === 'update_available' || u.advisories.length > 0);
    const lines: string[] = [`NUMBER OF UPDATES AVAILABLE: ${updates.length}. Updates last checked: ${state.lastCheckedAt ?? 'never'}${checkNote}`,
      `(For context only, not updates: the inventory lists ${inv.items.length} installed programs and packages, ${inv.ports.length} listening ports, ${inv.services.length} services.)`];
    const unavailableSections = inv.sections.filter((s) => !s.available);
    if (unavailableSections.length) lines.push(`Could not read: ${unavailableSections.map((s) => `${s.label} (${s.reason ?? 'unknown'})`).join('; ')}`);
    const items: BotEvidenceItem[] = [];
    const refs: string[] = [];
    lines.push('', 'UPDATES AVAILABLE (nothing was installed):');
    for (const u of updates.slice(0, 30)) {
      const adv = u.advisories.length ? ` | SECURITY: ${u.advisories.slice(0, 2).map((a) => `${a.id}${a.severity ? ` (${a.severity})` : ''}`).join(', ')}` : '';
      const line = `- ${u.name}: installed ${u.installed ?? 'unknown'} -> ${u.latestStable ?? 'unknown'} via ${u.source}${u.publishedAt ? `, released ${u.publishedAt.slice(0, 10)}` : ''}${adv}${u.notesUrl ? ` | ${u.notesUrl}` : ''}`;
      lines.push(line); items.push({ id: `upd:${u.itemId}:${u.latestStable ?? 'adv'}`, text: line }); if (u.notesUrl) refs.push(u.notesUrl);
    }
    if (updates.length === 0) lines.push('- (none found)');
    if (updates.length > 30) lines.push(`- … and ${updates.length - 30} more`);
    lines.push('', 'DISKS:');
    for (const d of (deps.disks ?? readDisks)()) {
      const pct = d.totalGb ? Math.round((d.freeGb / d.totalGb) * 100) : 0;
      const line = `- ${d.drive} ${d.freeGb} GB free of ${d.totalGb} GB (${pct}% free, ${100 - pct}% used)`;
      lines.push(line);
      // Disk space is reported again only when it gets low, and then once per 10-GB step.
      if (pct < 12) items.push({ id: `disk:${d.drive}:${Math.floor(d.freeGb / 10)}`, text: `${line} — LOW` });
    }
    const dirty = inv.repositories.filter((r) => (r as unknown as { modified?: number }).modified).length;
    lines.push('', `Git repositories with uncommitted changes: ${dirty}`);
    const security = updates.filter((u) => u.advisories.length > 0).length;
    const disks = (deps.disks ?? readDisks)();
    const low = disks.filter((d) => d.totalGb && d.freeGb / d.totalGb < 0.12).map((d) => d.drive);
    return { source: 'pc_software', ok: true, facts: `This PC: ${updates.length} update(s) available${security ? `, ${security} with a security advisory` : ''}; nothing was installed. Disks: ${disks.map((d) => `${d.drive} ${d.freeGb} GB free of ${d.totalGb} GB`).join(', ')}${low.length ? ` (low: ${low.join(', ')})` : ''}.`, reason: null, privateData: false, text: bounded(lines), items, refs: [...new Set(refs)].slice(0, 30) };
  } catch (err) {
    return unavailable('pc_software', err instanceof Error ? err.message : String(err));
  }
}

// ── AI Radar ─────────────────────────────────────────────────────────────────────────────────

async function aiRadar(deps: BotSourceDeps): Promise<BotEvidence> {
  try {
    const inv = await (deps.inventory ?? (() => collectSoftwareInventory({ dataDir: deps.dataDir })))();
    const installed = inv.items.filter((i) => i.kind !== 'model').map((i) => ({ name: i.name, version: i.version }));
    const scan = await (deps.radar ?? ((tools) => scanAiRadar({ dataDir: deps.dataDir, installed: tools })))(installed);
    const state = scan.state ?? readRadarState(deps.dataDir);
    const gpu = (deps.gpu ?? detectGpu)();
    const models = inv.items.filter((i) => i.kind === 'model').map((i) => i.name);
    const lines: string[] = [`Scanned ${scan.scannedAt}. GPU here: ${gpu ? `${gpu.name}, ${Math.round(gpu.totalVramMb / 1024)} GB VRAM (${Math.round(gpu.freeVramMb / 1024)} GB free now)` : 'not detected'}.`,
      `Local models installed (${models.length}): ${clip(models.join(', '), 600) || 'none read'}`];
    if (scan.errors.length) lines.push(`Sources that could not be read: ${clip(scan.errors.join('; '), 300)}`);
    const items: BotEvidenceItem[] = [];
    const refs: string[] = [];
    const relevant = Object.values(state.findings)
      .filter((f) => f.status !== 'dismissed' && f.classification !== 'not_relevant' && f.classification !== 'already_implemented')
      .sort((a, b) => Number(b.urgent) - Number(a.urgent) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    lines.push('', 'FINDINGS (public releases and advisories, compared with what is installed):');
    for (const f of relevant.slice(0, 24)) {
      const line = `- ${f.urgent ? 'URGENT ' : ''}${f.kind === 'security' ? 'SECURITY ' : ''}${f.name}: ${clip(f.title, 90)} | installed ${f.installed ?? 'not installed'}, available ${f.available ?? 'n/a'} | ${f.classification} | ${clip(f.why, 160)} | ${f.url}`;
      lines.push(line); items.push({ id: `radar:${f.id}`, text: line }); refs.push(f.url);
    }
    if (relevant.length === 0) lines.push('- (nothing relevant)');
    // Sources failed and nothing relevant is known: that is "could not check", never "nothing new".
    if (scan.errors.length > 0 && relevant.length === 0) {
      return unavailable('ai_radar', `${scan.errors.length} read(s) of the public sources failed (${clip(scan.errors[0], 120)}${scan.errors.length > 1 ? ', and others' : ''}), so new releases could not be checked`);
    }
    return { source: 'ai_radar', ok: true, facts: `AI Radar: ${relevant.length} relevant finding(s), ${relevant.filter((f) => f.urgent).length} urgent, ${relevant.filter((f) => f.kind === 'security').length} security; scanned ${scan.scannedAt}${scan.errors.length ? `; ${scan.errors.length} source(s) could not be read` : ''}.`, reason: scan.errors.length ? `${scan.errors.length} source(s) could not be read` : null, privateData: false, text: bounded(lines), items, refs: [...new Set(refs)].slice(0, 30) };
  } catch (err) {
    return unavailable('ai_radar', err instanceof Error ? err.message : String(err));
  }
}

// ── Engineering: source, git, build, logs ────────────────────────────────────────────────────

const runGit = (repo: string, args: string[]): Promise<{ ok: boolean; out: string }> => new Promise((resolve) => {
  cp.execFile('git', ['-C', repo, ...args], { timeout: 20_000, windowsHide: true, maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
    resolve({ ok: !err || Boolean(stdout), out: (stdout || stderr || (err ? err.message : '')).toString() });
  });
});

const STOP = new Set(['what', 'which', 'when', 'where', 'why', 'with', 'this', 'that', 'from', 'have', 'does', 'into', 'about', 'pandesh', 'engineer', 'please', 'should', 'would', 'could', 'they', 'them', 'there', 'their',
  'tell', 'find', 'cause', 'problem', 'prepare', 'review', 'latest', 'actually', 'working', 'yesterday', 'investigate', 'failed', 'features', 'feature', 'missing', 'slow']);

/** The words of a question worth searching the source for. */
export function searchTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
  const out: string[] = [];
  for (const w of words) if (!STOP.has(w) && !out.includes(w)) out.push(w);
  return out.slice(0, 5);
}

/** The last lines of a log that report a problem, with their line numbers, without message bodies. */
export function logProblems(file: string, max = 12): { lines: string[]; total: number } {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const start = Math.max(0, size - 400_000);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return { lines: [], total: 0 }; }
  const all = text.split(/\r?\n/);
  const hits = all.filter((l) => /\b(error|failed|failure|exception|timed out|timeout|unhandled|rejected|stall|not answering)\b/i.test(l));
  return { lines: hits.slice(-max).map((l) => clip(l.trim(), 220)), total: hits.length };
}

export function installedBuildIdentity(installRoot?: string | null): { buildNumber: number | null; commit: string | null; builtAt: string | null; file: string | null } {
  const candidates = [
    installRoot ? path.join(installRoot, 'app', 'build-identity.json') : null,
    process.env.PANDESH_BUILD_IDENTITY ?? null,
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), '..', 'app', 'build-identity.json') : null,
  ].filter((p): p is string => Boolean(p));
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { buildNumber?: number; commit?: string; builtAt?: string };
      return { buildNumber: typeof j.buildNumber === 'number' ? j.buildNumber : null, commit: typeof j.commit === 'string' ? j.commit : null, builtAt: typeof j.builtAt === 'string' ? j.builtAt : null, file };
    } catch { /* try the next place */ }
  }
  return { buildNumber: null, commit: null, builtAt: null, file: null };
}

async function engineering(bot: BotRecord, deps: BotSourceDeps, question: string | null): Promise<BotEvidence> {
  const repo = bot.settings.repoPath?.trim() || process.env.PANDESH_REPO_PATH || null;
  const git = deps.git ?? runGit;
  const lines: string[] = [];
  const refs: string[] = [];
  const items: BotEvidenceItem[] = [];
  try {
    const build = installedBuildIdentity(deps.installRoot);
    lines.push(build.file
      ? `INSTALLED BUILD: ${build.buildNumber ?? 'unknown'}, commit ${build.commit?.slice(0, 12) ?? 'unknown'}, built ${build.builtAt ?? 'unknown'} [${build.file}]`
      : 'INSTALLED BUILD: this Core is not running from an installed build (no build-identity.json)');
    if (build.file) refs.push(build.file);
    if (!repo || !fs.existsSync(path.join(repo, '.git'))) {
      lines.push(`REPOSITORY: not available (${repo ? `${repo} is not a git repository` : 'no repository folder is set for this Bot'}). Source search and git history were not read.`);
    } else {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const main = await git(repo, ['rev-parse', '--verify', '--quiet', 'origin/main']);
      const headSha = head.out.trim();
      lines.push(`REPOSITORY: ${repo}, branch ${branch.out.trim()}, HEAD ${headSha.slice(0, 12)}, origin/main ${main.ok ? main.out.trim().slice(0, 12) : 'unknown'}`);
      if (build.commit && main.ok) {
        const mainSha = main.out.trim();
        if (mainSha.startsWith(build.commit) || build.commit.startsWith(mainSha)) lines.push('INSTALLED vs MAIN: the installed build is main.');
        else {
          const ahead = await git(repo, ['rev-list', '--count', `${build.commit}..origin/main`]);
          const same = await git(repo, ['diff', '--quiet', build.commit, 'origin/main']);
          lines.push(`INSTALLED vs MAIN: origin/main has ${ahead.ok ? ahead.out.trim() : 'an unknown number of'} commit(s) the installed build does not have${same.ok && !same.out.trim() ? ' (the files are identical: only merge commits differ)' : ''}.`);
        }
      }
      const log = await git(repo, ['log', '-14', '--date=short', '--format=%h %ad %s', 'origin/main']);
      const logLines = (log.ok ? log.out : '').split('\n').filter(Boolean);
      lines.push('', 'RECENT COMMITS ON MAIN:');
      for (const l of logLines) { lines.push(`- ${clip(l, 150)}`); refs.push(`commit ${l.split(' ')[0]}`); items.push({ id: `commit:${l.split(' ')[0]}`, text: l }); }
      const terms = question ? searchTerms(question) : [];
      if (terms.length) {
        // What a recent commit that names one of the words actually changed: the files are where the answer is.
        const matching = logLines.filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3);
        for (const l of matching) {
          const sha = l.split(' ')[0];
          const stat = await git(repo, ['show', '--stat=120', '--format=', sha]);
          const files = (stat.ok ? stat.out : '').split('\n').map((s) => s.trim()).filter((s) => s.includes('|')).slice(0, 8);
          if (files.length) { lines.push('', `FILES CHANGED BY ${sha} (${clip(l.split(' ').slice(2).join(' '), 90)}):`); for (const f of files) lines.push(`- ${clip(f, 120)}`); }
        }
        lines.push('', `SOURCE SEARCH for: ${terms.join(', ')} (Core first, then the desktop app and docs)`);
        for (const term of terms) {
          let count = 0;
          for (const [paths, max] of [[['core/runtime', 'core/domain', 'core/api'], 4], [['apps/desktop/src', 'apps/desktop/renderer-v2/src', 'docs'], 2]] as const) {
            const found = await git(repo, ['grep', '-n', '-i', '-I', '--max-count=2', '-e', term, 'origin/main', '--', ...paths]);
            for (const h of (found.ok ? found.out : '').split('\n').filter(Boolean).slice(0, max)) {
              const m = /^origin\/main:([^:]+):(\d+):(.*)$/.exec(h);
              if (!m) continue;
              lines.push(`- ${m[1]}:${m[2]}: ${clip(m[3].trim(), 130)}`); refs.push(`${m[1]}:${m[2]}`); count++;
            }
          }
          if (count === 0) lines.push(`- "${term}": no match`);
        }
      }
    }
    // Core's own record of what went wrong recently: the facts, not the conversations.
    lines.push('', 'RECENT FAILED OR INTERRUPTED WORK (Core database):');
    try {
      const failed = deps.db.all<{ id: string; status: string; kind: string; updatedAt: string; failureReason: string | null }>(
        `SELECT id, status, kind, updatedAt, failureReason FROM attempts WHERE status IN ('failed', 'interrupted') ORDER BY updatedAt DESC LIMIT 6`, []);
      for (const a of failed) { const l = `- attempt ${a.id} ${a.status} ${a.updatedAt}: ${clip(a.failureReason ?? 'no reason recorded', 160)}`; lines.push(l); refs.push(`attempt ${a.id}`); items.push({ id: `attempt:${a.id}`, text: l }); }
      if (failed.length === 0) lines.push('- attempts: none failed or interrupted');
      const missions = deps.db.all<{ id: string; status: string; objective: string; updatedAt: string; resultSummary: string | null }>(
        `SELECT id, status, objective, updatedAt, resultSummary FROM missions WHERE status NOT IN ('completed', 'running', 'queued') ORDER BY updatedAt DESC LIMIT 5`, []);
      for (const m of missions) { const l = `- mission ${m.id} ${m.status} ${m.updatedAt}: ${clip(m.objective, 90)} | ${clip(m.resultSummary ?? 'no summary', 140)}`; lines.push(l); refs.push(`mission ${m.id}`); items.push({ id: `mission:${m.id}:${m.status}`, text: l }); }
    } catch (err) { lines.push(`- could not read: ${err instanceof Error ? err.message : String(err)}`); }
    for (const [label, file] of [['CORE LOG', path.join(deps.dataDir, 'logs', 'core.log')], ['DESKTOP LOG', path.join(deps.dataDir, 'desktop-host.log')]] as const) {
      const p = logProblems(file, 8);
      lines.push('', `${label} (${file}): ${p.total} problem line(s) in the last 400 KB${p.total ? '; latest:' : '.'}`);
      for (const l of p.lines) lines.push(`- ${l}`);
      if (p.total) refs.push(file);
    }
    return { source: 'engineering', ok: true, reason: null, privateData: false, text: clip(lines.join('\n'), 9000), items, refs: [...new Set(refs)].slice(0, 60) };
  } catch (err) {
    return unavailable('engineering', err instanceof Error ? err.message : String(err));
  }
}

export async function gatherBotEvidence(bot: BotRecord, deps: BotSourceDeps, question: string | null): Promise<BotEvidence[]> {
  const out: BotEvidence[] = [];
  for (const source of bot.sources) {
    if (deps.signal?.aborted) break;
    if (source === 'gmail_inbox') out.push(await gmailInbox(deps));
    else if (source === 'pc_software') out.push(await pcSoftware(deps));
    else if (source === 'ai_radar') out.push(await aiRadar(deps));
    else if (source === 'engineering') out.push(await engineering(bot, deps, question));
  }
  return out;
}
