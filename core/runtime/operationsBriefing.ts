/**
 * "Pandesh at work": the one place the morning briefing reports Pandesh's own background work — the reliability
 * watchdog, the AI Radar and the revenue team. Only what changed since the previous brief is listed; a quiet night
 * collapses to one line, so the brief does not repeat itself every day.
 *
 * It reads each feature's own records (the watchdog's history file, ai-radar.json, revenue-pipeline.json) and never
 * calls a model.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';

interface WatchdogHistoryLine { runId: string; commit: string; regressions: number; fixed: number; known: number; environment: number; complete: boolean }
interface RadarFindingLite { title: string; url: string; classification: string; status: string; firstSeenAt: string; urgent?: boolean; action?: string }
interface PipelineLite { leads: Array<{ at: string }>; offers: Array<{ at: string; title: string }>; drafts: Array<{ at: string; status: string; kind: string }>; outcomes: Array<{ at: string; kind: string; amountEur: number | null }> }

const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
const ACTIONABLE = new Set(['update_available', 'missing_capability', 'worth_testing']);
const LABEL: Record<string, string> = { update_available: 'update available', missing_capability: 'missing capability', worth_testing: 'worth testing' };

export function watchdogLines(db: CoreDatabase, sinceIso: string): string[] {
  const row = db.get<{ scopeJson: string | null; enabled: number }>("SELECT scopeJson, enabled FROM scheduled_tasks WHERE routine = 'reliability_watchdog' LIMIT 1");
  if (!row?.scopeJson) return [];
  const stateDir = (JSON.parse(row.scopeJson) as { stateDir?: string }).stateDir;
  if (!stateDir) return [];
  let runs: Array<WatchdogHistoryLine & { at: string }> = [];
  try {
    runs = fs.readFileSync(path.join(stateDir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as WatchdogHistoryLine)
      .map((r) => ({ ...r, at: r.runId.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z') }))
      .filter((r) => r.at > sinceIso);
  } catch { return []; }
  if (!runs.length) return [];
  const last = runs[runs.length - 1];
  const reg = runs.reduce((a, r) => a + r.regressions, 0);
  const fixed = runs.reduce((a, r) => a + r.fixed, 0);
  const env = runs.reduce((a, r) => a + r.environment, 0);
  const parts = [reg ? `**${reg} new regression${reg === 1 ? '' : 's'}**` : 'no new regressions', fixed ? `${fixed} fixed` : '', env ? `${env} environment failure${env === 1 ? '' : 's'}` : '', last.known ? `${last.known} known failure${last.known === 1 ? '' : 's'} unchanged` : '']
    .filter(Boolean);
  return [`- Reliability: ${runs.length} watchdog run${runs.length === 1 ? '' : 's'} (latest on \`${last.commit}\`): ${parts.join(', ')}.${reg ? ' Details in the "Reliability watchdog" chat.' : ''}`];
}

export function radarLines(dataDir: string, sinceIso: string): string[] {
  const state = readJson<{ findings: Record<string, RadarFindingLite> }>(path.join(dataDir, 'ai-radar.json'));
  if (!state) return [];
  const fresh = Object.values(state.findings).filter((f) => f.firstSeenAt > sinceIso && f.status !== 'dismissed' && ACTIONABLE.has(f.classification));
  if (!fresh.length) return [];
  const order = ['update_available', 'missing_capability', 'worth_testing'];
  fresh.sort((a, b) => Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) || order.indexOf(a.classification) - order.indexOf(b.classification));
  return [
    `- AI Radar: ${fresh.length} new finding${fresh.length === 1 ? '' : 's'}.`,
    ...fresh.slice(0, 5).map((f) => `  - ${f.urgent ? '⚠ ' : ''}[${f.title}](${f.url}) — ${LABEL[f.classification]}${f.action ? `. ${f.action}` : ''}`),
    ...(fresh.length > 5 ? [`  - …and ${fresh.length - 5} more in AI Radar.`] : []),
  ];
}

export function revenueLines(dataDir: string, sinceIso: string): string[] {
  const p = readJson<Record<'catering' | 'digital', PipelineLite>>(path.join(dataDir, 'revenue-pipeline.json'));
  if (!p) return [];
  const names = { catering: 'Catering', digital: 'Digital services' } as const;
  const out: string[] = [];
  for (const track of ['catering', 'digital'] as const) {
    const t = p[track];
    if (!t) continue;
    const newLeads = (t.leads ?? []).filter((x) => x.at > sinceIso).length;
    const newOffers = (t.offers ?? []).filter((x) => x.at > sinceIso);
    const newDrafts = (t.drafts ?? []).filter((x) => x.at > sinceIso && x.status === 'awaiting_approval').length;
    const waiting = (t.drafts ?? []).filter((x) => x.status === 'awaiting_approval').length;
    const outcomes = (t.outcomes ?? []).filter((x) => x.at > sinceIso);
    if (!newLeads && !newOffers.length && !newDrafts && !outcomes.length) continue;
    const money = outcomes.filter((o) => o.kind === 'payment').reduce((a, o) => a + (o.amountEur ?? 0), 0);
    const bits = [
      newLeads ? `${newLeads} new qualified lead${newLeads === 1 ? '' : 's'}` : '',
      newOffers.length ? `${newOffers.length} new offer${newOffers.length === 1 ? '' : 's'} (${newOffers.map((o) => o.title).slice(0, 2).join('; ')})` : '',
      newDrafts ? `${newDrafts} new draft${newDrafts === 1 ? '' : 's'} — ${waiting} waiting for your approval in Revenue` : '',
      outcomes.length ? `${outcomes.length} outcome${outcomes.length === 1 ? '' : 's'} you recorded${money ? `, €${money.toFixed(2)} received` : ''}` : '',
    ].filter(Boolean);
    out.push(`- Revenue · ${names[track]}: ${bits.join('; ')}.`);
  }
  return out;
}

/** The section appended to the daily brief. */
export function renderOperationsSection(db: CoreDatabase, dataDir: string, sinceIso: string): string {
  const lines = [...watchdogLines(db, sinceIso), ...radarLines(dataDir, sinceIso), ...revenueLines(dataDir, sinceIso)];
  return ['', '**Pandesh at work**', ...(lines.length ? lines : [`- Nothing new from the watchdog, AI Radar or the revenue team since ${sinceIso.slice(0, 16).replace('T', ' ')} UTC.`])].join('\n');
}
