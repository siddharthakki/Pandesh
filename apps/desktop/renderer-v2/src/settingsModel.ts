/**
 * Pure helpers for the v2 Settings screen: the words it shows for updates and the route, decided in one place so the
 * screen and the tests agree. No IPC and no React here.
 */
import type { ModelSnapshot } from './composerModel';
import type { UpdateStatus } from './bridge';

export type SettingsSection = 'models' | 'permissions' | 'diagnostics' | 'updates' | 'appearance';
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; hint: string }> = [
  { id: 'models', label: 'Models', hint: 'Which model answers: this PC or a free cloud model' },
  { id: 'permissions', label: 'Permissions', hint: 'Ask, Auto or Plan only for this conversation' },
  { id: 'diagnostics', label: 'Diagnostics', hint: 'Core, model server and build, with a report you can copy' },
  { id: 'updates', label: 'Updates', hint: 'Install a Pandesh update package' },
  { id: 'appearance', label: 'Appearance', hint: 'Theme, navigation labels, interface' },
];

export type Tone = 'ok' | 'warn' | 'danger' | 'plain';

/** Plain words for the last update attempt, shown until the person acknowledges it. */
export function updateStatusText(s: Pick<UpdateStatus, 'available' | 'installedRevision' | 'lastResult'> | null): { text: string; tone: Tone } {
  if (!s) return { text: 'Update status is not available yet.', tone: 'plain' };
  if (!s.available) return { text: 'This install cannot update itself yet. Run the latest Pandesh installer once to enable updates.', tone: 'warn' };
  const last = s.lastResult;
  if (last && !last.acknowledged) {
    const why = last.reason ? ` ${last.reason}` : '';
    if (last.status === 'success') return { text: `Updated to build b${last.revision}.`, tone: 'ok' };
    if (last.status === 'rolled_back') return { text: `The update to b${last.attemptedRevision} did not start correctly and was undone. You are on b${last.revision}.${why}`, tone: 'warn' };
    if (last.status === 'aborted') return { text: `Update not applied: ${last.reason || 'nothing was changed.'}`, tone: 'warn' };
    return { text: `The update failed and could not be undone automatically. Run the Pandesh installer to recover.${why}`, tone: 'danger' };
  }
  return { text: `Installed build b${s.installedRevision ?? '?'}.`, tone: 'plain' };
}

/** True when a free cloud model is the selection in use (the whole chat then runs there). */
export function usingCloud(s: ModelSnapshot | null): boolean {
  return Boolean(s?.cloud?.selectedModel);
}

export function cloudSelectionLabel(s: ModelSnapshot | null): string | null {
  const sel = s?.cloud?.selectedModel;
  if (!sel) return null;
  const at = sel.indexOf('::');
  const id = at > 0 ? sel.slice(0, at) : 'cloud';
  const provider = (s?.cloud?.providers ?? []).find((p) => p.id === id);
  return `${sel.slice(at + 2)} (${provider?.displayName ?? id})`;
}

export function capabilityWords(label: string, v: boolean | 'unknown'): string {
  return v === true ? `${label}: yes` : v === false ? `${label}: no` : `${label}: not reported`;
}

/** What a cloud model can and cannot reach (from the host's cloud routing and Core's data boundary). */
export const CLOUD_BOUNDARY_NOTE = "A cloud model runs Pandesh's own assistant only. It never reads your images, files, email, calendar or memory, and earlier local turns stay on this PC. Core refuses the send unless the provider key is set and the model is on the verified free list.";
