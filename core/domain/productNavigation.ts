/**
 * Where things are in Pandesh's own interface, for the assistant to tell the user and to open with `navigate_to`.
 * Built from the destination registry (core/shared/uiDestinations.ts), so the model never improvises a menu. On
 * 2026-11-10 it sent the owner to "Connections → Google Services", which v2 did not have, then could not "take me there".
 */
import { destinationById, destinationsFor, type UiSurface } from '../shared/uiDestinations';

const google = destinationById('google_setup')!;

/** Where the user connects Google (Gmail, Calendar) in this build, in both interfaces. */
export const GOOGLE_SETUP_WHERE = `${google.where.v2} in the v2 interface, or ${google.where.classic} in the Classic interface`;

/** The steps, as the assistant should give them. */
export const GOOGLE_SETUP_STEPS = 'One time: in Google Cloud create an OAuth client of type "Desktop app" (with the Gmail API and the Google Calendar API enabled, and the user\'s own Google account added as a test user on the consent screen), download its JSON file and import it there (or paste the Client ID), then press Connect Google and finish signing in in the browser';

/**
 * The navigation facts for one turn. With `surface` (the message came from that Pandesh window) the model may open the
 * listed places with `navigate_to`; without it, it can only give the way there.
 */
export function navigationPromptLines(surface: UiSurface | undefined): string {
  const lines = [`- Google (Gmail, Calendar) is connected by the user in ${GOOGLE_SETUP_WHERE}. ${GOOGLE_SETUP_STEPS}.`];
  if (surface) {
    lines.push(`- You can open places in this Pandesh window (${surface === 'v2' ? 'v2' : 'Classic'} interface) with 'navigate_to'. These are the only places that exist: ${destinationsFor(surface).map((d) => `${d.id} = ${d.label} (${d.where[surface]})`).join('; ')}.`);
    lines.push('- When the user asks to open, show or go to one of them, or says "take me there" / "open it" about a place you or they just named, call navigate_to at once instead of describing the way. Say it is open only when navigate_to answered OPENED. For anything not in the list, say it does not exist here and offer the nearest listed place; never invent a menu or page.');
  } else {
    lines.push('- You cannot open screens in this conversation (it did not come from the Pandesh window): give the exact way there instead, and never claim a menu exists unless it is named here.');
  }
  lines.push('- Never ask the user to paste a client secret, password, API key or token into the chat; those go only into the setup screens.');
  return lines.join('\n');
}
