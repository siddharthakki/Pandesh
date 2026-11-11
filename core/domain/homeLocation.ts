/**
 * The user's home place for local questions (micro-test cluster C6, D-LOC-5 / D-LOC-3).
 *
 * In Build 163 the model knew only the PC's time zone (Europe/Berlin), so "free events this weekend", "a museum open on
 * Monday", "train disruptions today" and "wholesale grocery options nearby" were all searched in Berlin, once in
 * London, although the user had stored "I live in Ulm, Germany" (memory: residence → location). This reads that
 * stored fact; Core puts it in the turn so local questions use it unless the user names another place.
 */
import type { CoreDatabase } from '../db/connection';

const SUBJECTS = ['residence', 'home', 'user', 'me', 'self'];
const PREDICATES = ['location', 'city', 'lives_in', 'home_city', 'home_location', 'place_of_residence', 'address_city'];

export function readHomeLocation(db: CoreDatabase): string | null {
  try {
    const rows = db.all<{ subject: string; predicate: string; displayValue: string | null }>(
      `SELECT subject, predicate, displayValue FROM memory_facts
        WHERE state = 'active' AND scopeType = 'user' AND forgottenAt IS NULL
          AND lower(subject) IN (${SUBJECTS.map(() => '?').join(', ')})
          AND lower(predicate) IN (${PREDICATES.map(() => '?').join(', ')})
        ORDER BY updatedAt DESC LIMIT 1`,
      [...SUBJECTS, ...PREDICATES],
    );
    const value = rows[0]?.displayValue?.trim();
    return value && value.length <= 120 ? value : null;
  } catch {
    return null;
  }
}

export function homeLocationFact(place: string | null): string {
  if (!place) return '';
  return `HOME LOCATION (stored by the user in memory): ${place}. For local questions (weather, events, shops, opening hours, routes, distances, transport, "near me", "nearby", "this city") use this place unless the user names another one. Never infer a place from the time zone; if neither this nor the user names a place, ask.`;
}
