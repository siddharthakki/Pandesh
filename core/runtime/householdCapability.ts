/**
 * The household surface of chat: obligations (bills, subscriptions, contracts), recurring routines and the JUGAAD phone.
 *
 * Reads are read-only tools. Everything that grants or uses authority — scanning private sources, confirming a record
 * (which puts it on the phone), creating or changing a routine (a standing permission), sending something to the phone —
 * is consequential, so it goes through the one existing approval card. The routine approval shows the exact scope the
 * routine will hold; `prepare` freezes it into the approved arguments, so what runs is what was approved.
 *
 * Reading the text inside documents is not a scan option the model can set: it happens only in folders the person
 * allowed through `household_allow_document_reading`, a card of its own (see documentReadGrants.ts).
 */
import type { CoreDatabase } from '../db/connection';
import type { ConnectorId } from '../shared/wireTypes';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';
import { CoreError } from '../domain/errors';
import { nowIso } from '../domain/ids';
import { decideObligation, getObligation, listObligations, renderObligation, type ObligationAction, type ObligationStatus } from '../domain/householdObligations';
import {
  controlHouseholdRoutine, createHouseholdRoutine, describeSchedule, editHouseholdRoutine, HOUSEHOLD_ROUTINES, listHouseholdRoutines, renderRoutine, validateRoutineScope,
  type HouseholdRoutineKind, type RoutineScope,
} from '../domain/householdRoutines';
import { getScheduledTask, type Recurrence } from '../domain/scheduledTasks';
import { activeCompanionDeviceCount, latestCompanionRevision, listCompanionDevices, listCompanionRecords, recentCompanionOps, upsertCompanionRecord } from '../domain/companionSync';
import { readConnector } from './assistantBrief';
import { publishBriefing, renderHouseholdBriefing, renderObligationList, scanObligationSources, type ConnectorReader } from './householdService';
import { runHouseholdRoutine } from './householdRoutineRunner';
import { documentReadPolicy, grantDocumentReading, listDocumentReadGrants, revokeDocumentReading } from '../domain/documentReadGrants';
import { validateRoot } from './pcOrganizer';

const ok = (output: string, category: string): ToolExecutionResult => ({ status: 'succeeded', exitCode: 0, output, resultCategory: category });
const fail = (output: string, category: string): ToolExecutionResult => ({ status: 'failed', exitCode: null, output, resultCategory: category });

const list = (v: unknown): string[] => Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean) : [];

function recurrenceFrom(args: Record<string, unknown>): Recurrence | null | undefined {
  const weekdays = list(args.weekdays).map((d) => {
    const n = Number(d);
    if (Number.isInteger(n)) return n;
    return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(d.toLowerCase().slice(0, 3));
  }).filter((n) => n >= 0 && n <= 6);
  if (weekdays.length) return { kind: 'weekly', weekdays };
  if (Number(args.everyDays) >= 2) return { kind: 'interval_days', every: Math.trunc(Number(args.everyDays)), anchor: nowIso().slice(0, 10) };
  if (args.frequency === 'daily') return null;
  if (args.frequency === 'weekly') return { kind: 'weekly', weekdays: [0] };
  return undefined;
}

function scopeFrom(kind: HouseholdRoutineKind, args: Record<string, unknown>): RoutineScope {
  const raw: Partial<RoutineScope> = {};
  if (args.folders !== undefined) raw.folders = list(args.folders);
  if (args.operations !== undefined) raw.operations = list(args.operations);
  if (args.sources !== undefined) raw.sources = list(args.sources) as Array<'gmail'>;
  if (args.maxMovesPerRun !== undefined) raw.maxMovesPerRun = Number(args.maxMovesPerRun);
  if (args.lookbackDays !== undefined) raw.lookbackDays = Number(args.lookbackDays);
  return validateRoutineScope(kind, raw);
}

function resolveGrantFolders(v: unknown): { ok: true; roots: string[] } | { ok: false; reason: string } {
  const raw = list(v);
  if (!raw.length) return { ok: false, reason: 'name the folders, e.g. ["Documents"]' };
  const roots: string[] = [];
  for (const r of raw) {
    const checked = validateRoot(r);
    if (!checked.ok) return { ok: false, reason: `${r}: ${checked.reason}` };
    roots.push(checked.root);
  }
  return { ok: true, roots };
}

export function createHouseholdCapabilityAdapter(deps: { db: CoreDatabase; connectorRegistry?: Map<ConnectorId, ConnectorAdapter> }): GovernedCapabilityAdapter {
  const { db } = deps;
  const readerFor = (ctx: ToolExecutionContext): ConnectorReader => async (toolName, args) => {
    const r = await readConnector(db, deps.connectorRegistry ?? new Map(), 'gmail', toolName, args, ctx.cwd, ctx.signal ?? new AbortController().signal);
    return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason ?? 'Gmail could not be read' };
  };

  async function run(call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = call.arguments ?? {};
    switch (call.name) {
      case 'household_scan_obligations': {
        const sources = list(a.sources);
        const folders = list(a.folders);
        if (!sources.includes('gmail') && !folders.length) return fail('Name what to scan: sources ["gmail"] and/or folders.', 'invalid_arguments');
        const report = await scanObligationSources(db, {
          gmail: sources.includes('gmail') ? { reader: readerFor(ctx), lookbackDays: Math.min(365, Math.max(1, Number(a.lookbackDays) || 60)) } : undefined,
          folders, inspectContents: documentReadPolicy(db),
        });
        const briefing = renderHouseholdBriefing(db, report, Date.now(), 'Obligations found');
        const proposed = listObligations(db, { status: ['proposed'] });
        return ok(`${briefing.markdown}\n\nRecords waiting for confirmation (${proposed.length}):\n${renderObligationList(db, proposed.slice(0, 12))}\n\nConfirm one with household_obligation_update action="confirm" — that also puts it in JUGAAD Important Dates when a phone is paired.`, 'household_scan_completed');
      }
      case 'household_obligations': {
        const statuses = list(a.status) as ObligationStatus[];
        const obligations = listObligations(db, { status: statuses.length ? statuses : ['proposed', 'confirmed'], withinDays: Number(a.withinDays) > 0 ? Number(a.withinDays) : undefined });
        return ok(renderObligationList(db, obligations), 'household_obligations_listed');
      }
      case 'household_obligation_update': {
        const action = String(a.action ?? '') as ObligationAction;
        if (!['confirm', 'resolve', 'dismiss', 'reopen'].includes(action)) return fail('action must be confirm, resolve, dismiss or reopen', 'invalid_arguments');
        const amount = a.amount === undefined || a.amount === null || a.amount === '' ? undefined : Math.round(Number(String(a.amount).replace(',', '.')) * 100);
        const ob = decideObligation(db, String(a.obligationId ?? ''), {
          action, actor: 'chat-approval', resolution: a.resolution === 'paid' ? 'paid' : a.resolution === 'cancelled' ? 'cancelled' : undefined,
          corrections: { title: typeof a.title === 'string' ? a.title : undefined, nextDate: typeof a.date === 'string' ? a.date : undefined, amountCents: Number.isFinite(amount) ? amount : undefined, cadence: typeof a.cadence === 'string' ? a.cadence as never : undefined },
        });
        const phones = activeCompanionDeviceCount(db);
        const sync = ob.status === 'confirmed' || ob.status === 'resolved' ? (phones ? ` It is queued for ${phones} paired JUGAAD phone(s) as an Important Date (revision ${latestCompanionRevision(db)}).` : ' No JUGAAD phone is paired yet, so it stays on the PC until one is.') : '';
        return ok(`${action} → ${ob.status}.${sync}\n${renderObligation(db, ob)}`, 'household_obligation_updated');
      }
      case 'routine_create': {
        const kind = String(a.kind ?? '') as HouseholdRoutineKind;
        if (!HOUSEHOLD_ROUTINES.has(kind)) return fail('kind must be folder_cleanup, obligations_check or expiry_watch', 'invalid_arguments');
        const task = createHouseholdRoutine(db, {
          kind, title: typeof a.title === 'string' ? a.title : undefined, purpose: typeof a.purpose === 'string' ? a.purpose : undefined,
          dailyTime: typeof a.time === 'string' ? a.time : undefined, timezone: typeof a.timezone === 'string' ? a.timezone : undefined,
          recurrence: recurrenceFrom(a), scope: scopeFrom(kind, a),
        });
        const view = listHouseholdRoutines(db).find((r) => r.id === task.id)!;
        return ok(`Routine created. It runs on Core's durable scheduler and survives restarts.\n${renderRoutine(view)}\nPause, resume, run now, edit or cancel it with routine_control.`, 'routine_created');
      }
      case 'routine_list': {
        const routines = listHouseholdRoutines(db, 5);
        return ok(routines.length ? routines.map(renderRoutine).join('\n\n') : 'No household routines yet.', 'routines_listed');
      }
      case 'routine_control': {
        const id = String(a.routineId ?? '');
        const action = String(a.action ?? '');
        const task = getScheduledTask(db, id);
        if (!task.routine || !HOUSEHOLD_ROUTINES.has(task.routine)) return fail('that is not a household routine', 'invalid_arguments');
        if (action === 'run_now') {
          const r = await runHouseholdRoutine(db, null, task, 'manual', { connectorRegistry: deps.connectorRegistry, cwd: ctx.cwd });
          return r.run ? ok(`Ran now (${r.run.status}): ${r.run.summary}`, r.run.status === 'succeeded' ? 'routine_ran' : 'routine_run_failed') : fail(r.reason, 'routine_not_run');
        }
        if (action === 'edit') {
          const kind = task.routine as HouseholdRoutineKind;
          const scopeKeys = ['folders', 'operations', 'sources', 'maxMovesPerRun', 'lookbackDays'];
          editHouseholdRoutine(db, id, {
            dailyTime: typeof a.time === 'string' ? a.time : undefined, timezone: typeof a.timezone === 'string' ? a.timezone : undefined, recurrence: recurrenceFrom(a),
            scope: scopeKeys.some((k) => a[k] !== undefined) ? scopeFrom(kind, { ...(task.scope ?? {}), ...a }) : undefined,
            title: typeof a.title === 'string' ? a.title : undefined,
          });
        } else if (action === 'pause' || action === 'resume' || action === 'cancel') {
          controlHouseholdRoutine(db, id, action);
        } else return fail('action must be pause, resume, cancel, run_now or edit', 'invalid_arguments');
        return ok(renderRoutine(listHouseholdRoutines(db).find((r) => r.id === id)!), 'routine_controlled');
      }
      case 'household_allow_document_reading': {
        const folders = resolveGrantFolders(a.folders);
        if (!folders.ok) return fail(folders.reason, 'invalid_arguments');
        if (a.action === 'revoke') {
          const revoked = folders.roots.flatMap((f) => { try { return revokeDocumentReading(db, f, 'chat-approval'); } catch { return []; } });
          return ok(revoked.length ? `Document reading revoked for ${revoked.map((g) => g.folder).join(', ')}. Scans and routines read only names, sizes, dates and file types there from now on.` : 'No document-reading permission was active for those folders.', 'document_reading_revoked');
        }
        const granted = folders.roots.map((f) => grantDocumentReading(db, f, 'chat-approval'));
        return ok(`Document reading allowed in ${granted.map((g) => g.folder).join(', ')}. Pandesh may read the text of PDFs and text files there, on this PC only, to classify them and find dates; the text is not stored or sent anywhere. Revoke it any time (Home → Household, or ask).`, 'document_reading_allowed');
      }
      case 'jugaad_status': {
        const devices = listCompanionDevices(db);
        const records = listCompanionRecords(db);
        const lines = [
          devices.length ? devices.map((d) => `- ${d.label} (${d.id}) ${d.revokedAt ? 'REVOKED' : 'paired'}; last seen ${d.lastSeenAt ?? 'never'}; has revision ${d.lastPulledRevision} of ${latestCompanionRevision(db)}`).join('\n') : 'No JUGAAD phone is paired. Pair it from the Pandesh app: Home → Household → JUGAAD phone → "Pair a phone", then enter the code in JUGAAD → Config → Pandesh.',
          `Records shared with the phone: ${records.filter((r) => r.kind === 'important_date').length} Important Date(s), ${records.filter((r) => r.kind === 'briefing').length} briefing(s), ${records.filter((r) => r.kind === 'task_status').length} task status(es), ${records.filter((r) => r.kind === 'document_ref').length} document reference(s).`,
          ...recentCompanionOps(db, 5).map((o) => `- from phone: ${o.op} ${o.recordId} → ${o.result}${o.detail ? ` (${o.detail})` : ''} at ${o.appliedAt}`),
          'The phone can read only these records and resolve Pandesh dates. It cannot run anything on this PC.',
        ];
        return ok(lines.join('\n'), 'jugaad_status');
      }
      case 'jugaad_send': {
        const kind = String(a.kind ?? '');
        if (kind === 'briefing') {
          const b = renderHouseholdBriefing(db, null, Date.now(), typeof a.title === 'string' && a.title ? a.title : 'Household briefing');
          const r = publishBriefing(db, typeof a.title === 'string' && a.title ? a.title : 'Household briefing', b.lines);
          return ok(`Briefing queued for the phone (revision ${r.revision}).\n${b.markdown}`, 'jugaad_sent');
        }
        if (kind === 'obligation') {
          const ob = getObligation(db, String(a.ref ?? ''));
          if (ob.status !== 'confirmed' && ob.status !== 'resolved') return fail('only a confirmed obligation is sent to the phone; confirm it first', 'jugaad_not_sent');
          const r = decideObligation(db, ob.id, { action: 'confirm', actor: 'chat-approval' });
          return ok(`Queued for the phone as an Important Date: ${r.title} (${r.nextDate ?? 'no date'}).`, 'jugaad_sent');
        }
        if (kind === 'note' || kind === 'document_ref' || kind === 'result') {
          const title = String(a.title ?? '').trim().slice(0, 120);
          const text = String(a.text ?? '').trim().slice(0, 1500);
          if (!title) return fail('a title is required', 'invalid_arguments');
          const recordId = `note:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
          const r = upsertCompanionRecord(db, { recordId, kind: 'document_ref', payload: { title, summary: text, reference: typeof a.ref === 'string' ? a.ref : null, note: 'The document itself stays on the PC.', sentAt: nowIso() } });
          return ok(`Queued for the phone: "${title}" (revision ${r.revision}). Only this summary travels; any file stays on the PC.`, 'jugaad_sent');
        }
        return fail('kind must be briefing, obligation, note or result', 'invalid_arguments');
      }
      default:
        return fail(`unknown tool '${call.name}'`, 'invalid_arguments');
    }
  }

  return {
    id: 'household',
    definitions: () => [
      {
        name: 'household_scan_obligations',
        description: 'Find bills, invoices, subscriptions, renewals, contracts, warranties, payment confirmations, deliveries, appointments and service notices in Gmail and/or named folders, locally and without a model. Each finding keeps its source (email subject/date or file) and is deduplicated into one record per obligation. Never pays, replies or cancels. Needs approval (reads private mail/files).',
        parameters: { type: 'object', properties: { sources: { type: 'array', items: { type: 'string', enum: ['gmail'] } }, folders: { type: 'array', items: { type: 'string' } }, lookbackDays: { type: 'number', description: 'Mail look-back, default 60.' } } },
      },
      {
        name: 'household_obligations',
        description: 'List household obligations with date, amount, cadence, payment status (requested / due soon / possibly overdue / confirmed / unknown), confidence and the evidence they came from. Read-only. withinDays limits to upcoming dates (e.g. 31 for "next month").',
        parameters: { type: 'object', properties: { withinDays: { type: 'number' }, status: { type: 'array', items: { type: 'string', enum: ['proposed', 'confirmed', 'resolved', 'dismissed'] } } } },
      },
      {
        name: 'household_obligation_update',
        description: 'Record the user\'s decision on an obligation: confirm (optionally correcting title/date YYYY-MM-DD/amount/cadence; confirmed records become JUGAAD Important Dates), resolve (resolution paid/done/cancelled), dismiss, or reopen. Needs approval.',
        parameters: { type: 'object', properties: { obligationId: { type: 'string' }, action: { type: 'string', enum: ['confirm', 'resolve', 'dismiss', 'reopen'] }, resolution: { type: 'string', enum: ['paid', 'done', 'cancelled'] }, title: { type: 'string' }, date: { type: 'string' }, amount: { type: 'number' }, cadence: { type: 'string', enum: ['monthly', 'quarterly', 'yearly', 'once'] } }, required: ['obligationId', 'action'] },
      },
      {
        name: 'routine_create',
        description: 'Create a durable recurring routine Core runs itself: folder_cleanup (e.g. "keep my Downloads organized every week": applies only destinations the user approved, proposes the rest, flags duplicates/temp files, never deletes), obligations_check ("every morning check for bills and subscriptions": reads Gmail, briefs what changed), expiry_watch ("monitor my documents for expiry dates"). Set time HH:MM and weekdays (e.g. ["sun"]) or everyDays. The approval card shows the exact bounded scope it will hold.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['folder_cleanup', 'obligations_check', 'expiry_watch'] }, title: { type: 'string' }, purpose: { type: 'string' }, time: { type: 'string', description: 'HH:MM 24-hour' },
            weekdays: { type: 'array', items: { type: 'string' } }, everyDays: { type: 'number' }, frequency: { type: 'string', enum: ['daily', 'weekly'] }, timezone: { type: 'string' },
            folders: { type: 'array', items: { type: 'string' } }, operations: { type: 'array', items: { type: 'string' } }, maxMovesPerRun: { type: 'number' }, lookbackDays: { type: 'number' },
          },
          required: ['kind'],
        },
      },
      { name: 'routine_list', description: 'List household routines with purpose, schedule and timezone, bounded authority, last/next run and recent results, failures and missed runs. Read-only.', parameters: { type: 'object', properties: {} } },
      {
        name: 'routine_control',
        description: 'Pause, resume, cancel, run_now or edit (time, weekdays, folders, operations, limits) a household routine. Needs approval.',
        parameters: { type: 'object', properties: { routineId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'run_now', 'edit'] }, time: { type: 'string' }, weekdays: { type: 'array', items: { type: 'string' } }, everyDays: { type: 'number' }, folders: { type: 'array', items: { type: 'string' } }, operations: { type: 'array', items: { type: 'string' } }, maxMovesPerRun: { type: 'number' }, title: { type: 'string' } }, required: ['routineId', 'action'] },
      },
      {
        name: 'household_allow_document_reading',
        description: 'Ask the person to allow (or revoke) Pandesh reading the TEXT inside PDFs and text files of named folders, locally. This is a separate decision from scanning: scans and routines otherwise read only names, sizes, dates and file types. Use it only when the person asked for their documents to be read, or after asking them in your own words; never as a side step of another task. Needs its own approval.',
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['allow', 'revoke'] }, folders: { type: 'array', items: { type: 'string' } } }, required: ['action', 'folders'] },
      },
      { name: 'jugaad_status', description: 'Show whether a JUGAAD phone is paired, when it last synced, and what is shared with it. Read-only.', parameters: { type: 'object', properties: {} } },
      {
        name: 'jugaad_send',
        description: 'Send a result to the JUGAAD phone: kind briefing (today\'s household briefing), obligation (ref = a confirmed obligation id), or note/result (a short title + text summary; files never travel). Needs approval.',
        parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['briefing', 'obligation', 'note', 'result'] }, ref: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } }, required: ['kind'] },
      },
    ],
    classify: (toolName) => (['household_obligations', 'routine_list', 'jugaad_status'].includes(toolName) ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    /** Freezes the authority an approval grants, so the card shows it and execution runs exactly that. */
    async prepare(toolName, args) {
      try {
        if (toolName === 'routine_create') {
          const kind = String(args.kind ?? '') as HouseholdRoutineKind;
          if (!HOUSEHOLD_ROUTINES.has(kind)) return args;
          const scope = scopeFrom(kind, args);
          const rec = recurrenceFrom(args);
          const schedule = describeSchedule({ dailyTime: typeof args.time === 'string' ? args.time : kind === 'folder_cleanup' ? '10:00' : kind === 'obligations_check' ? '07:30' : '08:00', timezone: typeof args.timezone === 'string' ? args.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone, recurrence: rec === undefined ? (kind === 'obligations_check' ? null : { kind: 'weekly', weekdays: [kind === 'folder_cleanup' ? 0 : 1] }) : rec, repeat: 'daily' });
          return { ...args, folders: scope.folders, sources: scope.sources, operations: scope.operations, ...(scope.maxMovesPerRun ? { maxMovesPerRun: scope.maxMovesPerRun } : {}), ...(scope.lookbackDays ? { lookbackDays: scope.lookbackDays } : {}), ...(scope.inspectContents ? { documentText: 'only in folders where you allowed document reading (checked at every run)' } : {}), schedule, neverDoes: 'send, pay, cancel, delete, or move files outside approved rules' };
        }
        if (toolName === 'household_allow_document_reading') {
          const folders = resolveGrantFolders(args.folders);
          if (!folders.ok) return args;
          return args.action === 'revoke'
            ? { action: 'revoke', folders: folders.roots, decision: `Stop reading document text in ${folders.roots.join(', ')}` }
            : {
              action: 'allow', folders: folders.roots,
              decision: `Allow Pandesh to read the text of PDFs and text files in ${folders.roots.join(', ')} (and folders inside them)`,
              scope: 'Read locally on this PC to classify files and find dates and amounts; the text is not stored, not sent to any model or service, and not synced to the phone',
              lasts: 'Until you revoke it (Home → Household, or ask Pandesh)',
              alreadyAllowed: listDocumentReadGrants(db).map((g) => g.folder),
            };
        }
        if (toolName === 'household_obligation_update') {
          const ob = getObligation(db, String(args.obligationId ?? ''));
          return { ...args, record: `${ob.title} — ${ob.nextDate ?? 'no date'}`, effect: args.action === 'confirm' ? 'becomes a JUGAAD Important Date' : args.action };
        }
      } catch (err) {
        if (err instanceof CoreError) return args;
      }
      return args;
    },
    run: async (call, ctx) => {
      try { return await run(call, ctx); } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), err instanceof CoreError ? 'household_refused' : 'household_failed');
      }
    },
  };
}
