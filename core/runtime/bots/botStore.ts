/**
 * Pandesh's own record of each Bot: what it is responsible for, which read-only sources it may use, whether it is
 * paused, what it has already reported, and its run history. The Bot's identity, instructions and memory live in
 * its Hermes profile (hermesBotRuntime.ts); nothing here duplicates that.
 *
 * Kept as files under `<dataDir>/bots/` (like AI Radar's state), so this adds no database migration and an older
 * build can still open the profile. `bots.json` holds the records; `runs/<botId>.jsonl` is an append-only history.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type BotSourceId = 'gmail_inbox' | 'outlook_mail' | 'pc_software' | 'ai_radar' | 'engineering';
export type BotStatus = 'active' | 'paused';
export type BotRunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted';
export type BotRunTrigger = 'schedule' | 'catch_up' | 'manual' | 'chat';

export const BOT_SOURCES: Record<BotSourceId, { label: string; reads: string; privateData: boolean; needsApproval: string }> = {
  gmail_inbox: { label: 'Gmail inbox (read)', reads: 'Subjects, senders and snippets of recent inbox mail, through the Gmail connection', privateData: true, needsApproval: 'Sending, replying, labelling, archiving or deleting mail' },
  outlook_mail: { label: 'Outlook mail via Mail Hub (read)', reads: 'Subjects, senders, dates and short excerpts of mail in the Mail Hub index, from the Outlook accounts you authorized there', privateData: true, needsApproval: 'Sending, replying, moving, deleting or marking mail, saving attachments, creating calendar events' },
  pc_software: { label: 'This PC: software, updates, disks, services', reads: 'Installed software and versions, available updates, disk space, listening ports and services', privateData: false, needsApproval: 'Installing or updating software, cleanup, stopping a process or service, restart' },
  ai_radar: { label: 'AI Radar: releases and advisories', reads: 'Public releases and security advisories of the watched local-AI projects, compared with what is installed and the GPU here', privateData: false, needsApproval: 'Installing a model or tool, or changing a configuration' },
  engineering: { label: 'Pandesh source, git history and logs', reads: 'The Pandesh repository (search, git log), the installed build identity, Core and desktop logs, recent failed tasks', privateData: false, needsApproval: 'Editing code, committing, merging, building, installing or deploying' },
};

export interface BotRecord {
  id: string;
  /** The Hermes profile that is this Bot's identity and memory. */
  profile: string;
  name: string;
  responsibility: string;
  /** Which standard Bot this is, when it is one of them. */
  kind: 'inbox' | 'pc' | 'scout' | 'engineer' | 'custom';
  sources: BotSourceId[];
  model: string;
  status: BotStatus;
  /** Source-specific settings that hold no secret, e.g. the repository path of the Engineer. */
  settings: { repoPath?: string | null };
  /** Item ids this Bot has already reported, with the day it did: the "no repetition" memory Core enforces. */
  seen: Record<string, string>;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotEvidenceSummary { source: BotSourceId; ok: boolean; reason: string | null; items: number; newItems: number; sha256: string; refs: string[] }
export interface BotRunRecord {
  id: string;
  botId: string;
  trigger: BotRunTrigger;
  taskId: string | null;
  question: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: BotRunStatus;
  /** One plain sentence: why it ended this way. */
  reason: string;
  evidence: BotEvidenceSummary[];
  /** The report as delivered. For a Bot that reads private data this is the only place it is kept besides its conversation. */
  report: string | null;
  proposals: string[];
  notified: boolean;
  hermes: { profile: string; model: string | null; provider: string | null; inputTokens: number | null; outputTokens: number | null; durationMs: number } | null;
}

const SEEN_KEEP_DAYS = 120;
const RUNS_KEEP = 200;

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export class BotStore {
  constructor(private readonly dataDir: string) {}

  private get dir(): string { return path.join(this.dataDir, 'bots'); }
  private get file(): string { return path.join(this.dir, 'bots.json'); }
  private runsFile(botId: string): string { return path.join(this.dir, 'runs', `${botId.replace(/[^a-z0-9_-]/gi, '')}.jsonl`); }

  list(): BotRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { bots?: BotRecord[] };
      return Array.isArray(raw.bots) ? raw.bots.filter((b) => b && typeof b.id === 'string' && typeof b.profile === 'string') : [];
    } catch { return []; }
  }

  get(id: string): BotRecord | null {
    return this.list().find((b) => b.id === id) ?? null;
  }

  /** Finds a Bot by id, profile or name (case-insensitive), the way a person or the model refers to it. */
  find(ref: string): BotRecord | null {
    const key = ref.trim().toLowerCase();
    if (!key) return null;
    const bots = this.list();
    return bots.find((b) => b.id === key || b.profile === key) ?? bots.find((b) => b.name.toLowerCase() === key) ?? bots.find((b) => b.name.toLowerCase().includes(key) || key.includes(b.name.toLowerCase())) ?? null;
  }

  private write(bots: BotRecord[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, bots }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  save(bot: BotRecord): BotRecord {
    const bots = this.list();
    const next = { ...bot, updatedAt: new Date().toISOString() };
    const at = bots.findIndex((b) => b.id === bot.id);
    if (at === -1) bots.push(next); else bots[at] = next;
    this.write(bots);
    return next;
  }

  remove(id: string): void {
    this.write(this.list().filter((b) => b.id !== id));
    try { fs.unlinkSync(this.runsFile(id)); } catch { /* no history */ }
  }

  /** Records which items a run reported, and forgets ones older than the keep window so the file stays small. */
  markSeen(id: string, itemIds: string[], now: Date = new Date()): void {
    const bot = this.get(id);
    if (!bot) return;
    const day = now.toISOString().slice(0, 10);
    const cutoff = new Date(now.getTime() - SEEN_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    const seen: Record<string, string> = {};
    for (const [k, v] of Object.entries(bot.seen ?? {})) if (v >= cutoff) seen[k] = v;
    for (const k of itemIds) seen[k] = day;
    this.save({ ...bot, seen });
  }

  runs(botId: string, limit = 20): BotRunRecord[] {
    let lines: string[] = [];
    try { lines = fs.readFileSync(this.runsFile(botId), 'utf8').split('\n').filter(Boolean); } catch { return []; }
    // A run is written when it starts and again when it ends; the last line for an id is its state.
    const byId = new Map<string, BotRunRecord>();
    for (const line of lines) { try { const r = JSON.parse(line) as BotRunRecord; if (r?.id) byId.set(r.id, r); } catch { /* a torn line */ } }
    return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  writeRun(run: BotRunRecord): void {
    const file = this.runsFile(run.botId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(run) + '\n', 'utf8');
    // Compact now and then: keep the latest state of the most recent runs only.
    try {
      if (fs.statSync(file).size > 2_000_000) {
        const keep = this.runs(run.botId, RUNS_KEEP).reverse();
        fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      }
    } catch { /* compaction is best effort */ }
  }

  /**
   * A run still marked "running" when Core starts was cut off by the last shutdown, sleep or crash. It is recorded
   * as interrupted, with nothing claimed about its result.
   */
  settleInterrupted(now: Date = new Date()): number {
    let settled = 0;
    for (const bot of this.list()) {
      for (const run of this.runs(bot.id, RUNS_KEEP)) {
        if (run.status !== 'running') continue;
        this.writeRun({ ...run, status: 'interrupted', finishedAt: now.toISOString(), reason: 'Pandesh stopped while this run was in progress; nothing was delivered.' });
        settled++;
      }
    }
    return settled;
  }
}
