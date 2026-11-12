/**
 * What the v2 Connections view says about Google (Gmail, Calendar). The same states and wording as the Classic
 * Google card (the retired Classic renderer's googleDeriveState / renderGoogleCard): before this, v2 had no place to
 * enter the OAuth client or connect Google at all.
 */

export interface GmailStatus {
  connected: boolean;
  accountEmail: string | null;
  lastError: string | null;
  lastRefreshedAt?: string | null;
  configBlocker?: string | null;
  capabilityBlocker?: string | null;
  connecting?: boolean;
  clientSource?: 'environment' | 'saved' | 'bundled' | null;
  clientHint?: string | null;
  verified?: boolean;
  helperStaged?: boolean;
  inboxOrganization?: 'granted' | 'not_granted';
  calendarAccess?: 'granted' | 'not_granted';
  calendarBlocker?: string | null;
  recovery?: { code: string; title: string; steps: string[]; link?: { label: string; url: string } } | null;
}

export type GoogleState = 'connecting' | 'connected' | 'problem' | 'checking' | 'setup' | 'problem-disconnected' | 'ready';
export type Busy = 'connecting' | 'checking' | 'saving' | null;

export const NOT_CONNECTED: GmailStatus = { connected: false, accountEmail: null, lastError: null, configBlocker: null, capabilityBlocker: null };

export function googleState(g: GmailStatus, busy: Busy = null): GoogleState {
  if (busy === 'connecting' || g.connecting) return 'connecting';
  if (g.verified) return 'connected';
  if (g.connected && (g.capabilityBlocker || g.lastError)) return 'problem';
  if (g.connected) return 'checking';
  if (!g.clientSource) return 'setup';
  if (g.recovery && g.recovery.code !== 'cancelled') return 'problem-disconnected';
  return 'ready';
}

export const STATE_LABEL: Record<GoogleState, string> = {
  connecting: 'Waiting for sign-in…',
  connected: 'Gmail connected',
  problem: 'Needs attention',
  'problem-disconnected': 'Not connected',
  checking: 'Checking…',
  setup: 'Setup needed',
  ready: 'Not connected',
};

export type Tone = 'ok' | 'busy' | 'warn' | 'neutral';
export interface ServiceRow { id: 'gmail' | 'calendar' | 'organize'; label: string; tone: Tone; chip: string; detail: string }

/** Gmail, Calendar and inbox organization, each only "Connected" when Core verified it. */
export function serviceRows(g: GmailStatus, state: GoogleState, calendarVerified: boolean, busy: Busy = null): ServiceRow[] {
  const at = g.lastRefreshedAt ? new Date(g.lastRefreshedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const gmail: Omit<ServiceRow, 'id' | 'label'> =
    state === 'connected' ? { tone: 'ok', chip: 'Connected', detail: `${g.accountEmail} · verified${at ? ` at ${at}` : ''} with a live check` }
      : state === 'connecting' ? { tone: 'busy', chip: 'Signing in…', detail: 'Finish signing in with Google in your browser, then come back here.' }
        : state === 'problem' ? { tone: 'warn', chip: 'Not verified', detail: `${g.accountEmail ? `Signed in as ${g.accountEmail}, but ` : ''}Pandesh could not confirm Gmail access. See the fix below.` }
          : state === 'checking' ? { tone: 'busy', chip: 'Checking…', detail: 'A saved Google sign-in exists. Verifying it with Google now.' }
            : state === 'setup' ? { tone: 'neutral', chip: 'Not connected', detail: 'Add your Google OAuth client below (one time), then press Connect Google.' }
              : { tone: 'neutral', chip: 'Not connected', detail: g.clientHint ? `OAuth client ${g.clientHint} is ready. Press Connect Google.` : 'Press Connect Google to sign in.' };
  const calendar: Omit<ServiceRow, 'id' | 'label'> =
    calendarVerified ? { tone: 'ok', chip: 'Connected', detail: 'Verified with a live read of your calendar.' }
      : state === 'connecting' ? { tone: 'busy', chip: 'Signing in…', detail: 'Calendar access is part of the same Google sign-in.' }
        : g.connected && g.calendarAccess === 'not_granted' ? { tone: 'warn', chip: 'Not granted', detail: 'This sign-in did not include Calendar. Disconnect, then connect again and keep the Calendar permission ticked.' }
          : g.connected && g.calendarBlocker ? { tone: 'warn', chip: 'Not verified', detail: `Pandesh could not confirm Calendar access: ${g.calendarBlocker}` }
            : g.connected && busy === 'checking' ? { tone: 'busy', chip: 'Checking…', detail: 'Verifying Calendar access with Google now.' }
              : g.connected ? { tone: 'warn', chip: 'Not verified', detail: g.lastError ? `Calendar could not be verified: ${g.lastError}` : 'Calendar has not been verified yet. Press Check again to verify it with Google.' }
                : { tone: 'neutral', chip: 'Not connected', detail: 'Connect Google to let Pandesh read and manage your calendar events.' };
  const organize: Omit<ServiceRow, 'id' | 'label'> =
    g.connected && g.inboxOrganization === 'granted' ? { tone: 'ok', chip: 'Allowed', detail: 'Pandesh can move mail to Promotions, label and archive it after you approve each change, and undo it. It never deletes mail.' }
      : g.connected ? { tone: 'neutral', chip: 'Not allowed', detail: 'Optional. Reading and drafting work without it. Allow it to let Pandesh organize mail after you approve each change; it never deletes mail.' }
        : { tone: 'neutral', chip: 'Not allowed', detail: 'Connect Google first. Inbox organization is a separate, optional permission.' };
  return [
    { id: 'gmail', label: 'Gmail', ...gmail },
    { id: 'calendar', label: 'Calendar', ...calendar },
    { id: 'organize', label: 'Inbox organization', ...organize },
  ];
}

/** Which buttons the view offers in each state (the same rules as the Classic card). */
export function googleActions(g: GmailStatus, state: GoogleState) {
  return {
    connect: !(state === 'connected' || state === 'checking' || state === 'problem'),
    connectLabel: state === 'connecting' ? 'Opening Google…' : state === 'problem-disconnected' ? 'Try again' : 'Connect Google',
    cancel: state === 'connecting',
    allowOrganize: g.connected && state === 'connected' && g.inboxOrganization !== 'granted',
    check: g.connected,
    disconnect: g.connected,
    disconnectLabel: state === 'problem' ? 'Disconnect and start over' : 'Disconnect',
    /** An app-owned client means ordinary users never see developer setup. */
    showSetup: g.clientSource !== 'bundled',
    clientEditable: !g.connected,
    removeSavedClient: g.clientSource === 'saved',
  };
}

export const SETUP_STEPS: ReadonlyArray<{ text: string; links: ReadonlyArray<{ label: string; url: string }> }> = [
  { text: 'Create or pick a Google Cloud project.', links: [{ label: 'Open Google Cloud', url: 'https://console.cloud.google.com/projectcreate' }] },
  { text: 'Enable the Gmail API and the Google Calendar API for that project.', links: [
    { label: 'Gmail API', url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com' },
    { label: 'Calendar API', url: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com' },
  ] },
  { text: 'Set up the OAuth consent screen: choose External, then add your own Google account under Test users. While the app is in Testing, Google signs you out every 7 days; just connect again.', links: [{ label: 'Open consent screen', url: 'https://console.cloud.google.com/apis/credentials/consent' }] },
  { text: 'Create credentials → OAuth client ID → application type Desktop app. No redirect address is needed; Pandesh uses a temporary local one (127.0.0.1) for Google\'s reply.', links: [{ label: 'Open credentials', url: 'https://console.cloud.google.com/apis/credentials' }] },
  { text: 'On the OAuth client page press Download JSON, then import that file below. Or paste the Client ID (and the Client secret if Google shows one). Either way they go straight into encrypted storage on this PC; never type them into the chat.', links: [] },
];
