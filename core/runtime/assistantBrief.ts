/**
 * The runtime layer of the Personal Assistant brief.
 *
 * The domain layer (`core/domain/assistantBrief.ts`) projects Core's durable
 * state. This layer adds the two things only a live integration can answer —
 * calendar commitments and email — and it does so through the very same
 * connector adapters and permission grants the agent loop uses.
 *
 * The rules this file keeps:
 *
 * - A connector that is not connected is reported as not connected, with the
 *   real reason. It is never reported as "nothing to see".
 * - A read only happens when the connector is live AND its `read` tier has
 *   been granted. The grant is checked with the same `hasConnectorPermission`
 *   the governed dispatch path uses.
 * - A read is read-only: it creates no approval, no attempt and no delivery.
 *   Email is never sent and nothing is ever drafted by a briefing.
 */
import type { CoreDatabase } from '../db/connection';
import type {
  AssistantBrief,
  AssistantBriefItem,
  AssistantBriefSection,
  AssistantBriefService,
  ConnectorId,
} from '../shared/wireTypes';
import { buildAssistantHomeItems, buildAssistantTodaySections } from '../domain/assistantBrief';
import { hasConnectorPermission, listConnectorStatuses } from '../domain/connectors';
import { CONNECTOR_LABELS } from './connectors/connectorDefinitions';
import type { ConnectorAdapter } from './connectors/connectorCapability';

const EXTERNAL_TIMEOUT_MS = 8_000;

export interface AssistantBriefRuntimeOptions {
  connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
  nowMs?: number;
  timezone?: string;
  /**
   * Read live calendar and email. A fast Home load leaves this off; asking
   * for the briefing turns it on.
   */
  includeExternal?: boolean;
  /** Working directory the connector reads run in. */
  cwd?: string;
  externalTimeoutMs?: number;
}

interface ConnectorRead {
  ok: boolean;
  data?: Record<string, unknown>;
  reason?: string;
}

/** `YYYY-MM-DD` for the given instant in the given zone. */
function localDate(instantMs: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `HH:MM` for the given instant in the given zone. */
function localTime(instantMs: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}`;
}

/**
 * One read-only connector call, behind the same permission gate the governed
 * dispatch path applies. Returns a reason instead of pretending.
 *
 * Exported so the follow-up routine can ask the same live services the brief
 * asks, with the same permission gate and the same honest failure wording —
 * there is no second, laxer reader for a different feature.
 */
export async function readConnector(
  db: CoreDatabase,
  adapters: Map<ConnectorId, ConnectorAdapter>,
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal,
): Promise<ConnectorRead> {
  const adapter = adapters.get(connectorId);
  // The adapter itself carries no label; the connector catalogue owns it.
  const label = CONNECTOR_LABELS[connectorId] ?? connectorId;
  if (!adapter) return { ok: false, reason: 'this integration is not present in this build' };
  if (!hasConnectorPermission(db, connectorId, 'read')) {
    return { ok: false, reason: `${label} read access has not been granted` };
  }
  if (!adapter.isConfigured()) {
    return { ok: false, reason: `${label} is not connected` };
  }
  // The cached health is only refreshed by an explicit probe. When it has
  // never been probed, probe once — and report the real reason when it fails.
  let health = adapter.health();
  if (health.state !== 'available') {
    health = await adapter.probeHealth(signal);
  }
  if (health.state !== 'available' && health.state !== 'degraded') {
    return { ok: false, reason: health.reason ?? `${label} is ${health.state}` };
  }
  try {
    const result = await adapter.run({ name: toolName, arguments: args }, { cwd, signal });
    if (result.status !== 'succeeded') {
      return { ok: false, reason: String(result.output ?? '').split('\n')[0].slice(0, 200) };
    }
    try {
      const parsed = JSON.parse(String(result.output));
      return { ok: true, data: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, reason: 'the service returned a result this build cannot read' };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function calendarSection(
  read: ConnectorRead,
  timezone: string,
  checkedAt: string,
): AssistantBriefSection {
  if (!read.ok) {
    return {
      id: 'calendar',
      label: 'Calendar commitments',
      available: false,
      unavailableReason: read.reason ?? 'Google Calendar is not available',
      items: [],
    };
  }
  const data = read.data ?? {};
  const events = Array.isArray(data.events) ? (data.events as Array<Record<string, unknown>>) : [];
  const zone = typeof data.timeZone === 'string' && data.timeZone ? data.timeZone : timezone;
  const items: AssistantBriefItem[] = events.slice(0, 8).map((event, index) => {
    const title = typeof event.title === 'string' ? event.title : '(untitled event)';
    const when = typeof event.when === 'string' ? event.when : typeof event.start === 'string' ? event.start : '';
    const location = typeof event.location === 'string' ? event.location : '';
    return {
      id: `calendar:${typeof event.id === 'string' ? event.id : index}`,
      kind: 'calendar_event',
      stance: 'fact',
      title,
      detail: `${when}${location ? ` · ${location}` : ''}`,
      state: 'scheduled',
      at: typeof event.start === 'string' ? event.start : checkedAt,
      source: { kind: 'connector', label: 'Google Calendar', reference: typeof event.id === 'string' ? event.id : null, checkedAt },
      actions: [],
    };
  });
  return {
    id: 'calendar',
    label: `Calendar commitments (${zone})`,
    available: true,
    unavailableReason: null,
    items,
  };
}

function emailSection(
  read: ConnectorRead,
  checkedAt: string,
): AssistantBriefSection {
  if (!read.ok) {
    return {
      id: 'email',
      label: 'Email worth knowing',
      available: false,
      unavailableReason: read.reason ?? 'Gmail is not available',
      items: [],
    };
  }
  const data = read.data ?? {};
  const counts = (data.counts ?? {}) as Record<string, unknown>;
  const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
  const matched = typeof counts.matched === 'number' ? counts.matched : results.length;
  const exact = counts.matchedIsExact !== false;
  const totalText = exact ? String(matched) : `about ${matched}`;
  const shown = results.slice(0, 6);
  const items: AssistantBriefItem[] = shown.map((message, index) => {
    const subject = typeof message.subject === 'string' ? message.subject : '(no subject)';
    const from = typeof message.from === 'string' ? message.from.replace(/\s*<.*>/, '').slice(0, 40) : '';
    const received = typeof message.receivedLocal === 'string'
      ? message.receivedLocal
      : typeof message.date === 'string' ? message.date : '';
    return {
      id: `email:${typeof message.id === 'string' ? message.id : index}`,
      kind: 'email',
      stance: 'fact',
      title: subject.slice(0, 120),
      detail: `${from}${from ? ' · ' : ''}${received}`,
      state: 'unread',
      at: typeof message.receivedAt === 'string' ? message.receivedAt : checkedAt,
      source: { kind: 'connector', label: 'Gmail', reference: typeof message.id === 'string' ? message.id : null, checkedAt },
      actions: [],
    };
  });
  if (matched > shown.length) {
    items.push({
      id: 'email:total',
      kind: 'email',
      stance: 'fact',
      title: `${totalText} unread message${matched === 1 ? '' : 's'} in the inbox`,
      detail: `Showing the ${shown.length} most recent. The count is Gmail's own.`,
      state: 'unread',
      at: checkedAt,
      source: { kind: 'connector', label: 'Gmail', reference: null, checkedAt },
      actions: [],
    });
  }
  return {
    id: 'email',
    label: 'Email worth knowing — unread inbox',
    available: true,
    unavailableReason: null,
    items,
  };
}

/**
 * The whole brief: Home attention items, the Today briefing, and the live
 * truth about every integration.
 */
export async function buildAssistantBrief(
  db: CoreDatabase,
  options: AssistantBriefRuntimeOptions = {},
): Promise<AssistantBrief> {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const adapters = options.connectorRegistry ?? new Map<ConnectorId, ConnectorAdapter>();

  const home = buildAssistantHomeItems(db, { nowMs, timezone });
  const coreSections = buildAssistantTodaySections(db, { nowMs, timezone });

  const services: AssistantBriefService[] = listConnectorStatuses(db, adapters).map((status) => ({
    id: status.id,
    label: status.label,
    state: status.state,
    reason: status.reason,
    checkedAt: status.checkedAt,
  }));

  let externalSections: AssistantBriefSection[] = [];
  if (options.includeExternal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.externalTimeoutMs ?? EXTERNAL_TIMEOUT_MS);
    const cwd = options.cwd ?? process.cwd();
    try {
      const [calendar, email] = await Promise.all([
        readConnector(db, adapters, 'google_calendar', 'calendar_list_events', {
          from: localDate(nowMs, timezone),
          to: localDate(nowMs + 36 * 3600_000, timezone),
          maxResults: 25,
        }, cwd, controller.signal),
        readConnector(db, adapters, 'gmail', 'gmail_search', {
          query: 'is:unread in:inbox',
          maxResults: 20,
        }, cwd, controller.signal),
      ]);
      externalSections = [
        calendarSection(calendar, timezone, checkedAt),
        emailSection(email, checkedAt),
      ];
    } finally {
      clearTimeout(timer);
    }
  }
  // Without a live read there is nothing truthful to say about the calendar
  // or the mailbox, so those sections are simply absent — never a placeholder
  // that reads like an empty inbox.

  return {
    generatedAt: checkedAt,
    timezone,
    home,
    today: [...externalSections, ...coreSections],
    services,
  };
}

/* ── Rendering ───────────────────────────────────────────────────────── */

/** The same brief, as plain text. One wording for the app and the routine. */
export function renderAssistantBriefMarkdown(brief: AssistantBrief): string {
  const zone = brief.timezone;
  const generated = formatInstant(brief.generatedAt, zone);
  const lines: string[] = [];
  lines.push(`**Your brief — ${generated}**`);
  lines.push('');
  lines.push('*Facts come from the source named on each line. Suggestions are mine, and are marked as such.*');
  for (const section of brief.today) {
    lines.push('');
    lines.push(`**${section.label}**`);
    if (!section.available) {
      lines.push(`- Not available: ${section.unavailableReason ?? 'the source could not be read'}`);
      continue;
    }
    if (!section.items.length) {
      // "Nothing recorded" is ambiguous: say what was actually found, after a successful read.
      lines.push(section.id === 'calendar' ? '- No events scheduled in this window.' : '- Nothing to report from this source.');
      continue;
    }
    for (const item of section.items) {
      const marker = item.stance === 'suggestion' ? '_Suggestion:_ ' : item.stance === 'action_performed' ? '_Already done:_ ' : '';
      lines.push(`- ${marker}${item.title} — ${item.detail} (${item.source.label}, ${formatInstant(item.at, zone)})`);
    }
  }
  return lines.join('\n');
}

/** A readable local timestamp, never a bare ISO string. */
export function formatInstant(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
