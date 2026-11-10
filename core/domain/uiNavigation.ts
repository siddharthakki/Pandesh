/**
 * `navigate_to`: the assistant opens a real place in the Pandesh window the message came from.
 *
 * Governed and truthful by construction:
 *  - only destinations registered for that window's interface exist (core/shared/uiDestinations.ts); anything else is
 *    answered with "not a place here" and the nearest real places, and nothing is requested;
 *  - Core records the request as a runtime event; the desktop host passes it to the window, which switches with its
 *    own navigation and confirms back (POST /v1/ui-navigation/:id/confirm);
 *  - the tool says OPENED only after that confirmation. Without it the model is told it is NOT CONFIRMED and gives
 *    the user the way there instead.
 * Navigation never touches a running task: it changes what the window shows, nothing else.
 */
import type { CoreDatabase } from '../db/connection';
import { newId } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import type { RuntimeEventRecord } from '../shared/wireTypes';
import { destinationById, destinationsFor, nearestDestinations, type UiSurface } from '../shared/uiDestinations';

export const NAVIGATION_CONFIRM_TIMEOUT_MS = 5_000;

export interface NavigationResult {
  status: 'opened' | 'not_opened' | 'not_confirmed' | 'unknown_destination';
  text: string;
  navigationId?: string;
}

/** What the window reported for a navigation, or null while it has not answered. */
export function navigationConfirmation(db: CoreDatabase, navigationId: string): { ok: boolean; detail: string | null } | null {
  const row = db.get<{ metadata: string }>(
    "SELECT metadata FROM runtime_events WHERE domain = 'ui_navigation' AND entityId = ? AND eventType = 'ui_navigation_confirmed' ORDER BY sequence DESC LIMIT 1",
    [navigationId],
  );
  if (!row) return null;
  const m = JSON.parse(row.metadata || '{}') as { ok?: unknown; detail?: unknown };
  return { ok: m.ok === true, detail: typeof m.detail === 'string' ? m.detail : null };
}

/** Records the window's answer to a navigation it was asked for. Refuses an id nobody requested. */
export function confirmNavigation(db: CoreDatabase, input: { navigationId: string; ok: boolean; detail?: string | null; surface?: UiSurface | null; actor: string }): RuntimeEventRecord {
  const requested = db.get<{ metadata: string }>(
    "SELECT metadata FROM runtime_events WHERE domain = 'ui_navigation' AND entityId = ? AND eventType = 'ui_navigation_requested'",
    [input.navigationId],
  );
  if (!requested) throw Object.assign(new Error(`navigation '${input.navigationId}' was not requested`), { code: 'not_found' });
  return recordRuntimeEvent(db, {
    domain: 'ui_navigation',
    entityId: input.navigationId,
    eventType: 'ui_navigation_confirmed',
    actor: input.actor,
    metadata: { ok: input.ok, detail: input.detail ? String(input.detail).slice(0, 300) : null, surface: input.surface ?? null },
  });
}

export async function navigateTo(db: CoreDatabase, input: {
  attemptId: string;
  surface: UiSurface;
  destination: string;
  actor: string;
  publish?: (event: RuntimeEventRecord) => void;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<NavigationResult> {
  const requested = String(input.destination ?? '').trim();
  const dest = destinationById(requested);
  const target = dest?.targets[input.surface];
  const where = dest?.where[input.surface];
  if (!dest || !target || !where) {
    const real = destinationsFor(input.surface);
    const near = nearestDestinations(`${requested.replace(/_/g, ' ')} ${dest?.label ?? ''}`, input.surface);
    return {
      status: 'unknown_destination',
      text: `NOT OPENED: "${requested}" is not a place in this Pandesh window, so nothing was opened. Say plainly that it does not exist here; never describe it as if it did. `
        + (near.length ? `Nearest real places: ${near.map((d) => `${d.id} (${d.label}: ${d.where[input.surface]})`).join('; ')}. ` : '')
        + `All places you can open: ${real.map((d) => d.id).join(', ')}.`,
    };
  }

  const navigationId = newId('uinav');
  const event = recordRuntimeEvent(db, {
    domain: 'ui_navigation',
    entityId: navigationId,
    eventType: 'ui_navigation_requested',
    actor: input.actor,
    metadata: { attemptId: input.attemptId, destination: dest.id, label: dest.label, target, where, surface: input.surface },
  });
  input.publish?.(event);

  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (input.timeoutMs ?? NAVIGATION_CONFIRM_TIMEOUT_MS);
  for (;;) {
    const answer = navigationConfirmation(db, navigationId);
    if (answer?.ok) return { status: 'opened', navigationId, text: `OPENED: ${dest.label} is now showing in the Pandesh window (${where}).` };
    if (answer) return { status: 'not_opened', navigationId, text: `NOT OPENED: the Pandesh window could not open ${dest.label}${answer.detail ? `: ${answer.detail}` : ''}. Do not say it is open; tell the user the way there: ${where}.` };
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  return { status: 'not_confirmed', navigationId, text: `NOT CONFIRMED: the Pandesh window did not confirm opening ${dest.label}, so do not say it is open. Tell the user the way there: ${where}.` };
}
