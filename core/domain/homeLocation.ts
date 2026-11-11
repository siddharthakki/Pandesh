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

/**
 * Only a message that needs a place gets the fact. Fix-build A/B check: with the fact on every turn, CAT-002 ("Scale my
 * test biryani recipe") and SAL-015 ("conversion rate for the synthetic leads") stopped reading the workspace / the
 * catering track (0 of 2 on the fix build, 2 of 2 on Build 163 against the same profile).
 */
const NEEDS_PLACE = /\b(?:near(?:by|\s+me|\s+here)?|around\s+(?:here|me|town)|local(?:ly)?|in\s+town|this\s+city|my\s+(?:city|town|area)|weather|forecast|rain(?:s|ing|y)?|snow|temperature\s+(?:outside|today|tomorrow)|events?|concerts?|festivals?|markets?|museums?|restaurants?|caf[eé]s?|bars?|shops?|stores?|pharmac(?:y|ies)|post\s+office|bank\s+branch|stations?|trains?|bus(?:es)?|trams?|traffic|drive|driving|route|walk(?:ing)?|distance|how\s+far|how\s+long\s+to|directions?|parking|hotels?|things\s+to\s+do|activit(?:y|ies)|wholesale|grocer(?:y|ies)|supermarkets?|open\s+(?:on|today|tomorrow|now|late)|opening\s+hours|this\s+weekend|tonight)\b/i;

export function needsPlace(message: string): boolean {
  return NEEDS_PLACE.test(message);
}

export function homeLocationFact(place: string | null, message?: string): string {
  if (!place) return '';
  if (message !== undefined && !needsPlace(message)) return '';
  // Verification on the fix build: listing "weather" first made the model look up the weather for unrelated local
  // questions (LOC-008, LOC-010, LOC-012, LOC-021). The place is a default, not a reason to call a tool.
  return `HOME LOCATION (stored by the user in memory): ${place}. When a question needs a place and the user names none ("near me", "nearby", "this weekend", events, shops, opening hours, routes, transport, weather), use this place. Never infer a place from the time zone; if neither this nor the user names a place, ask. This is only a default place: do not look anything up (weather included) that the user did not ask about.`;
}
