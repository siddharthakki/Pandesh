/**
 * What the v2 composer shows for the two choices the person makes before a
 * message: which model answers, and the conversation's permission mode
 * (Ask / Auto / Plan only). Pure functions over the host snapshot, so the
 * Chat component and the tests share one decision. Core stores and enforces
 * both choices; this only presents them (same rules as the Classic composer,
 * apps/desktop/renderer/renderer.js renderModels / renderPermission).
 */

/** The host's value for "let Core pick the local model per request" (apps/desktop/src/host/desktopSession.ts AUTO_MODEL). */
export const AUTO_MODEL = '__auto__';

export type PermissionMode = 'ask' | 'auto' | 'plan';

export interface PermissionAuthorization { id: string; categories: string[]; workspaceRoot: string | null; expiresAt: string; pinnedScripts?: string[] }
export interface PermissionState {
  conversationId: string | null;
  mode: PermissionMode;
  authorizations: PermissionAuthorization[];
  /** Category id -> plain description, from Core (core/domain/permissionModes.ts AUTHORIZATION_CATEGORIES). */
  categories: Record<string, string>;
  pending: boolean;
  pendingWorkspaceRoot?: string | null;
  activeTurnMode?: PermissionMode | null;
}

interface CloudProvider { id: string; displayName?: string; enabled?: boolean; configured?: boolean; privacyWarning?: string | null }
interface CloudListing { ok?: boolean; checkedAt?: string; error?: string; errorClass?: string; pool?: Array<{ id: string; displayName?: string; vision?: boolean | 'unknown'; tools?: boolean | 'unknown' }> }
export interface ModelSnapshot {
  model: string | null;
  modelIsAuto: boolean;
  installedModels?: string[];
  running?: boolean;
  cloud?: { selectedModel?: string | null; providers?: CloudProvider[]; listings?: Record<string, CloudListing>; [k: string]: unknown } | null;
}

export interface ModelOption { value: string; label: string; group: 'auto' | 'local' | 'cloud'; disabled?: boolean }

export const PERMISSION_LABELS: Record<PermissionMode, string> = { ask: 'Ask permission', auto: 'Auto (governed)', plan: 'Plan only' };

/** The expiry choices the desktop offers; Core caps any grant at 24 hours (MAX_AUTHORIZATION_MINUTES). */
export const EXPIRY_CHOICES: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 60, label: '1 hour' },
  { minutes: 480, label: '8 hours' },
  { minutes: 1440, label: '24 hours' },
];

/** Same note as the Classic grant form: what Auto never covers (core/domain/permissionModes.ts alwaysEscalateReason). */
export const STILL_ASKS_NOTE = 'Still asks you: outbound email and messages, purchases, payments, contracts, file edits, installs, git push, anything destructive and anything outside what you tick here.';

/** Categories Core binds to the selected workspace folder; without a folder they cannot be granted. */
export const WORKSPACE_PERMISSION_CATEGORIES: ReadonlySet<string> = new Set(['workspace_read_commands', 'workspace_validation', 'workspace_git_commit', 'workspace_inspect_page']);

/** A model value of the form `<provider>::<model>` is a cloud model; everything else runs on this PC. */
export function isCloudValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.indexOf('::') > 0;
}

/**
 * The model menu: Auto first, then the installed local models, then every verified-free model of the cloud providers
 * the person switched on and gave a key. The selected value is always one of the options, so the menu never shows a
 * model that is not chosen. Picking a cloud model is confirmed first (ComposerControls): the whole chat then runs there.
 */
export function modelMenu(s: ModelSnapshot | null): { options: ModelOption[]; selected: string } {
  const options: ModelOption[] = [{ value: AUTO_MODEL, label: 'Auto (recommended)', group: 'auto' }];
  const installed = s?.installedModels ?? [];
  for (const name of installed) options.push({ value: name, label: name, group: 'local' });
  const cloud = s?.cloud ?? null;
  const selectedCloud = cloud?.selectedModel ?? null;
  if (installed.length === 0) options.push({ value: '', label: 'No local Ollama models found', group: 'local', disabled: true });
  for (const c of cloudChoices(s)) options.push({ value: c.value, label: `${c.label} · ${c.providerName}`, group: 'cloud' });
  if (selectedCloud && !options.some((o) => o.value === selectedCloud)) {
    // A stored pick whose list has not been checked yet (or that left the free list) is still shown as the selection.
    const at = selectedCloud.indexOf('::');
    const providerId = at > 0 ? selectedCloud.slice(0, at) : 'cloud';
    const provider = (cloud?.providers ?? []).find((p) => p.id === providerId);
    options.push({ value: selectedCloud, label: `${selectedCloud.slice(at + 2)} · ${provider?.displayName ?? providerId} (not on the checked free list)`, group: 'cloud' });
  }
  let selected = selectedCloud ?? (s?.modelIsAuto ? AUTO_MODEL : (s?.model ?? ''));
  if (!selected) {
    if (!options.some((o) => o.value === '')) options.unshift({ value: '', label: 'Choose a model', group: 'local', disabled: true });
  } else if (!options.some((o) => o.value === selected)) {
    // Ollama resolves "gemma4" to "gemma4:latest"; show the tag it resolves to.
    const tagged = installed.find((name) => name.startsWith(`${selected}:`));
    if (tagged) selected = tagged;
    // A configured model Ollama no longer lists is shown as such, never silently replaced by another entry.
    else options.splice(1, 0, { value: selected, label: `${selected} (not installed)`, group: 'local' });
  }
  return { options, selected };
}

export interface CloudChoice { value: string; label: string; providerName: string; vision: boolean | 'unknown'; tools: boolean | 'unknown' }

/**
 * The verified-free cloud models the person may choose in Settings: only providers that are enabled and have a key,
 * and only models in the pool Core verified free. The value is `<provider>::<model>`, which selectModel routes to the
 * host's cloud selection (the whole chat then runs on that model; Core's data boundary still applies).
 */
export function cloudChoices(s: ModelSnapshot | null): CloudChoice[] {
  const cloud = s?.cloud ?? null;
  const out: CloudChoice[] = [];
  for (const p of cloud?.providers ?? []) {
    if (!p.enabled || !p.configured) continue;
    for (const m of cloud?.listings?.[p.id]?.pool ?? []) {
      out.push({ value: `${p.id}::${m.id}`, label: m.displayName || m.id, providerName: p.displayName ?? p.id, vision: m.vision ?? 'unknown', tools: m.tools ?? 'unknown' });
    }
  }
  return out;
}

export type CloudProviderState = 'ready' | 'no_key' | 'off' | 'not_checked' | 'failed' | 'none_free';
export interface CloudProviderAvailability { id: string; name: string; state: CloudProviderState; text: string; models: number; checkedAt: string | null; privacyWarning: string | null }

/**
 * One line per cloud provider that has a key or is switched on: can it be used right now, and why not. Read from
 * the same snapshot as the menu, so the two never disagree. Never a key, only whether one is stored.
 */
export function cloudAvailability(s: ModelSnapshot | null, now: number = Date.now()): CloudProviderAvailability[] {
  const cloud = s?.cloud ?? null;
  const out: CloudProviderAvailability[] = [];
  for (const p of cloud?.providers ?? []) {
    if (!p.enabled && !p.configured) continue;
    const listing = cloud?.listings?.[p.id];
    const models = listing?.ok === false ? 0 : (listing?.pool ?? []).length;
    const checkedAt = listing?.checkedAt ?? null;
    let state: CloudProviderState;
    let text: string;
    if (!p.configured) { state = 'no_key'; text = 'Switched on, but no key is stored'; }
    else if (!p.enabled) { state = 'off'; text = 'Key stored, switched off'; }
    else if (!listing) { state = 'not_checked'; text = 'Free models not checked yet'; }
    else if (listing.ok === false) { state = 'failed'; text = `Could not read its model list (${listing.errorClass || listing.error || 'unknown error'})`; }
    else if (models === 0) { state = 'none_free'; text = 'No verified free model right now'; }
    else { state = 'ready'; text = `${models} free model${models === 1 ? '' : 's'}, checked ${agoWords(checkedAt, now)}`; }
    out.push({ id: p.id, name: p.displayName ?? p.id, state, text, models, checkedAt, privacyWarning: p.privacyWarning ?? null });
  }
  return out;
}

export function agoWords(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return 'at an unknown time';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** What the person is told, and must confirm, before a chat is moved to a cloud model. */
export function cloudConfirmation(s: ModelSnapshot | null, value: string): { title: string; lines: string[] } {
  const at = value.indexOf('::');
  const providerId = value.slice(0, at);
  const provider = (s?.cloud?.providers ?? []).find((p) => p.id === providerId);
  const name = provider?.displayName ?? providerId;
  const lines = [
    `Your messages in this chat, and Pandesh's own instructions, are sent to ${name} over the internet.`,
    'Your files, pictures, email, calendar and memory are not sent: Core refuses a cloud send that carries them, and earlier local turns stay on this PC.',
    'Only models Core verified as free are offered. Nothing is paid for, and Pandesh does not move to another cloud model on its own.',
    'Choose Auto or a local model at any time to go back to this PC.',
  ];
  if (provider?.privacyWarning) lines.splice(1, 0, provider.privacyWarning);
  return { title: `Run this chat on ${value.slice(at + 2)} at ${name}?`, lines };
}

/** What the route line says about the model: "Auto" is a choice, not a missing one. */
export function modelLabel(s: ModelSnapshot | null): string {
  if (!s) return 'model not chosen';
  if (s.modelIsAuto) return s.model ? `${s.model} (auto)` : 'Auto — picks a model per message';
  return s.model ?? 'model not chosen';
}

export interface GrantRow { id: string; text: string; disabled: boolean }

/** The categories the person can tick for Auto; workspace ones need a selected folder. */
export function grantRows(p: PermissionState | null | undefined, hasFolder: boolean): GrantRow[] {
  return Object.entries(p?.categories ?? {}).map(([id, text]) => {
    const disabled = WORKSPACE_PERMISSION_CATEGORIES.has(id) && !hasFolder;
    return { id, text: disabled ? `${text} (select a workspace folder first)` : text, disabled };
  });
}

/** Returns the reason a grant cannot be sent, or null when it may be. */
export function grantProblem(categories: string[], expiresInMinutes: number): string | null {
  if (categories.length === 0) return 'Tick at least one thing Auto may do, or choose Ask.';
  if (!EXPIRY_CHOICES.some((c) => c.minutes === expiresInMinutes)) return 'Choose how long Auto lasts: 1, 8 or 24 hours.';
  return null;
}

export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The chip on the composer: the mode in force, and for Auto the time its last grant ends. */
export function permissionChip(p: PermissionState | null | undefined): { mode: PermissionMode; label: string } {
  const mode = p?.mode ?? 'ask';
  if (mode !== 'auto') return { mode, label: mode === 'plan' ? 'Plan only' : 'Ask' };
  const last = (p?.authorizations ?? []).filter((a) => Number.isFinite(Date.parse(a.expiresAt)))
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
  if (!last) return { mode, label: p?.pending ? 'Auto · from next message' : 'Auto · nothing granted' };
  return { mode, label: `Auto · until ${shortTime(last.expiresAt)}` };
}

export interface StatusLine { text: string; revokeId?: string; items?: string[] }

/** What is in force right now, in plain sentences, with a Revoke handle for each active grant. */
export function permissionStatus(p: PermissionState | null | undefined): StatusLine[] {
  if (!p) return [];
  const lines: StatusLine[] = [];
  if (p.activeTurnMode && p.activeTurnMode !== p.mode) {
    lines.push({ text: `The running task keeps ${PERMISSION_LABELS[p.activeTurnMode]}, fixed when it started; your change applies to the next message.` });
  } else if (p.activeTurnMode && p.activeTurnMode !== 'ask') {
    // A task running in the default Ask mode needs no line: the panel would otherwise appear on every message.
    lines.push({ text: `This task runs in ${PERMISSION_LABELS[p.activeTurnMode]} mode.` });
  }
  if (p.mode === 'plan') lines.push({ text: 'Plan only: Pandesh researches and plans. Nothing is created, changed, sent or run.' });
  if (p.mode === 'auto') {
    if (p.authorizations.length === 0 && !p.pending) lines.push({ text: 'Auto has no active authorization, so everything still asks you.' });
    for (const a of p.authorizations) {
      const where = a.workspaceRoot ? ` in ${a.workspaceRoot}` : '';
      const scripts = a.pinnedScripts?.length ? ` (pinned npm scripts: ${a.pinnedScripts.join(', ')})` : '';
      lines.push({ text: `Auto until ${shortTime(a.expiresAt)}${where}${scripts}. Everything else still asks you.`, revokeId: a.id, items: a.categories.map((c) => p.categories?.[c] || c) });
    }
  }
  if (p.pending) {
    lines.push({ text: p.mode === 'auto'
      ? `${PERMISSION_LABELS.auto} applies from your next message, for ${p.pendingWorkspaceRoot || 'no workspace folder'} only.`
      : `${PERMISSION_LABELS[p.mode]} applies from your next message.` });
  }
  return lines;
}

/** The notice shown when a chat's messages could not be loaded (Core still starting, or restarting). */
export const LOAD_FAILURE = 'Could not load this chat: ';

/** True for that notice only, so a successful load can retire it without touching any other notice. */
export function isLoadFailure(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(LOAD_FAILURE);
}
