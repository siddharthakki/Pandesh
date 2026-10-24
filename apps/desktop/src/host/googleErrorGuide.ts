/**
 * Turns the raw failure text from Google's OAuth/Gmail path into something a
 * person can act on: what happened, what to do next, and a link to the exact
 * Google page when there is one. Pure and secret-free (it only ever sees
 * already-sanitized error messages), so it is directly unit-testable.
 */
export interface GoogleRecoveryGuide {
  /** Stable machine id (used by tests and for the UI's data attribute). */
  code:
    | 'not_configured'
    | 'invalid_client'
    | 'access_denied'
    | 'redirect_mismatch'
    | 'cancelled'
    | 'timed_out'
    | 'state_mismatch'
    | 'no_refresh_token'
    | 'grant_revoked'
    | 'api_disabled'
    | 'storage_unavailable'
    | 'helper_missing'
    | 'helper_tampered'
    | 'core_unreachable'
    | 'unknown';
  title: string;
  steps: string[];
  link?: { label: string; url: string };
}

export const GOOGLE_CONSOLE_LINKS = {
  gmailApi: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  calendarApi: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
  consent: 'https://console.cloud.google.com/apis/credentials/consent',
  credentials: 'https://console.cloud.google.com/apis/credentials',
  permissions: 'https://myaccount.google.com/permissions',
} as const;

export function classifyGoogleError(rawMessage: string | null | undefined): GoogleRecoveryGuide | null {
  const message = String(rawMessage ?? '').trim();
  if (!message) return null;
  const m = message.toLowerCase();

  if (m.includes('digest mismatch') || m.includes('unpinned executable')) {
    return {
      code: 'helper_tampered',
      title: "Panda's Google helper failed its integrity check",
      steps: ['The helper program changed from the version Panda pinned. Re-stage it with: node scripts/fetch-gws.mjs'],
    };
  }
  if (m.includes('gws binary') || m.includes('gws_bin') || m.includes('not staged')) {
    return {
      code: 'helper_missing',
      title: "Panda's Google helper is not installed",
      steps: ['Gmail needs a small helper program (gws). Install it with: node scripts/fetch-gws.mjs, then restart Panda.'],
    };
  }
  if (m.includes('not set up yet') || m.includes('karkedikha_gmail_oauth_client_id')) {
    return {
      code: 'not_configured',
      title: 'Add your Google OAuth client first',
      steps: ['Follow the setup steps below, paste the Client ID, then press Save.'],
      link: { label: 'Open Google Cloud credentials', url: GOOGLE_CONSOLE_LINKS.credentials },
    };
  }
  if (m.includes('invalid_client') || m.includes('unauthorized_client') || m.includes('client_secret')) {
    return {
      code: 'invalid_client',
      title: 'Google did not accept this OAuth client',
      steps: [
        'Check that the client type is "Desktop app" (not Web application).',
        'Copy the Client ID again, and the Client secret if Google shows one, then save them here.',
      ],
      link: { label: 'Open Google Cloud credentials', url: GOOGLE_CONSOLE_LINKS.credentials },
    };
  }
  if (m.includes('redirect_uri_mismatch')) {
    return {
      code: 'redirect_mismatch',
      title: 'The OAuth client is the wrong type',
      steps: ['Create a new OAuth client with application type "Desktop app". Web clients cannot be used for this sign-in.'],
      link: { label: 'Open Google Cloud credentials', url: GOOGLE_CONSOLE_LINKS.credentials },
    };
  }
  if (m.includes('access_denied') || m.includes('access denied') || m.includes('verification') || m.includes('not a test user')) {
    return {
      code: 'access_denied',
      title: 'Google blocked or cancelled the sign-in',
      steps: [
        'If you pressed Cancel, just try again.',
        'If you saw "app not verified" or "access blocked": open the OAuth consent screen and add your Google account under Test users, then try again.',
      ],
      link: { label: 'Open OAuth consent screen', url: GOOGLE_CONSOLE_LINKS.consent },
    };
  }
  if (m.includes('connection cancelled')) {
    return {
      code: 'cancelled',
      title: 'Sign-in cancelled',
      steps: ['Nothing was connected. Press Connect Google when you are ready.'],
    };
  }
  if (m.includes('timed out')) {
    return {
      code: 'timed_out',
      title: 'Sign-in did not finish in time',
      steps: ['Press Connect Google again and complete the sign-in in your browser within a few minutes.'],
    };
  }
  if (m.includes('state mismatch')) {
    return {
      code: 'state_mismatch',
      title: 'The sign-in response could not be verified',
      steps: ['Nothing was connected. Close any extra Google sign-in tabs and press Connect Google again.'],
    };
  }
  if (m.includes('refresh token')) {
    return {
      code: 'no_refresh_token',
      title: 'Google did not grant long-lived access',
      steps: ['Remove Panda from your Google account permissions, then press Connect Google again.'],
      link: { label: 'Open Google account permissions', url: GOOGLE_CONSOLE_LINKS.permissions },
    };
  }
  if (m.includes('invalid_grant')) {
    return {
      code: 'grant_revoked',
      title: 'Google access expired or was revoked',
      steps: [
        'Press Connect Google to sign in again.',
        'Apps in Testing mode on Google Cloud lose access after 7 days. Publishing the app (or reconnecting weekly) avoids this.',
      ],
      link: { label: 'Open OAuth consent screen', url: GOOGLE_CONSOLE_LINKS.consent },
    };
  }
  if (m.includes('accessnotconfigured') || m.includes('has not been used in project') || m.includes('api has not been enabled') || m.includes('service_disabled')) {
    return {
      code: 'api_disabled',
      title: m.includes('calendar') ? 'The Google Calendar API is not enabled for your Google project' : 'The Gmail API is not enabled for your Google project',
      steps: [m.includes('calendar')
        ? 'Open the Google Calendar API page for your project, press Enable, wait a minute, then press Check again.'
        : 'Open the Gmail API page for your project, press Enable, wait a minute, then press Check again.'],
      link: m.includes('calendar')
        ? { label: 'Open Calendar API page', url: GOOGLE_CONSOLE_LINKS.calendarApi }
        : { label: 'Open Gmail API page', url: GOOGLE_CONSOLE_LINKS.gmailApi },
    };
  }
  if (m.includes('encrypted storage')) {
    return {
      code: 'storage_unavailable',
      title: 'Windows encrypted storage is not available',
      steps: ['Panda will not store Google access without it. Sign in to Windows normally (not a restricted/service session) and restart Panda.'],
    };
  }
  if (m.includes('core is not reachable') || m.includes('core is not connected')) {
    return {
      code: 'core_unreachable',
      title: 'Panda is still starting',
      steps: ['Wait a few seconds and press Check again.'],
    };
  }
  return {
    code: 'unknown',
    title: 'Google connection problem',
    steps: ['Press Check again. If it keeps failing, disconnect and reconnect Google.'],
  };
}
