/**
 * Pure HTML rendering for the Setup control center. No vscode import and no I/O, so the whole surface — including
 * the Ollama-down, no-provider and quota-exhausted states — is testable as a string. The panel owns messaging; this
 * owns what the user sees.
 *
 * Mental model: LOCAL COMPUTE + FREE CLOUD BOOST + UNIFIED MODEL POOL + CLEAR COST/PRIVACY POLICY. Everything shown
 * derives from the readiness snapshot (registry/catalog/settings truth); this file invents no provider, model count,
 * readiness or capability. Credentials are never rendered: the only key input is an empty password field.
 *
 * Every optional field of `OnboardingReadiness` is read defensively so a snapshot from an older code path still renders.
 */
import type { CapabilityRow, CloudPoolProviderRow, CloudPoolReadiness, ModeReadiness, ModelSummary, OnboardingReadiness, SetupModelEntry } from './OnboardingReadiness';
import { formatBuildIdentity } from './BuildIdentity';
import type { RuntimeCapabilityProfile, Tri } from '../runtimeProfile/RuntimeCapabilityProfile';
import { computeSystemReadiness, type ReadinessVerdict } from '../../core/platform/readinessState';

export type SetupSectionId = 'models' | 'fallback' | 'profile' | 'advanced' | 'diagnostics' | 'routing' | 'build';

export interface SetupNotice {
  kind: 'ok' | 'bad' | 'info';
  text: string;
}

/** The Connect panel for one provider. Holds no secret: a staged key only reports that one is staged. */
export interface SetupConnectState {
  providerId: string;
  /** True once a key was pasted from the clipboard (the key itself stays in the extension host). */
  keyStaged?: boolean;
  /** Last attempt's message, key-free. */
  message?: { kind: 'ok' | 'bad' | 'info'; text: string };
  /** Set after a successful connection. */
  connected?: { modelCount: number; freeCount: number };
  busy?: boolean;
}

export interface SetupViewState {
  loading: boolean;
  readiness?: OnboardingReadiness;
  openSections: ReadonlySet<string>;
  notice?: SetupNotice;
  connect?: SetupConnectState;
  /** Webview URIs for the shared model palette; absent (tests) means the browse button is hidden. */
  paletteScriptUri?: string;
  paletteCssUri?: string;
  /** Injected so the same state always renders the same string. */
  now?: Date;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 32768 → "32K", 131072 → "128K", 1000 → "1000". */
export function formatContext(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return 'unknown';
  return tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}K` : String(tokens);
}

function triLabel(value: Tri): string {
  return value === 'yes' ? 'Supported' : value === 'no' ? 'Not supported' : 'Unknown';
}

export type ProfileHealth = 'healthy' | 'degraded' | 'learning' | 'not_probed';

export interface ProfileSummary {
  health: ProfileHealth;
  label: string;
  context: string;
  structured: string;
  tools: string;
  reasoning: string;
  lastProbe: string;
}

function relativeTime(iso: string | undefined, now: Date): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'never';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Summarises what is known about one model on this runtime. "Healthy" is only claimed when a probe or live
 * observation exists and recorded no timeouts or stalls; a model nothing is known about is "Not probed yet", which
 * is neutral — an unknown model is usable, not suspect.
 */
export function summarizeProfile(model: ModelSummary | undefined, now: Date = new Date()): ProfileSummary {
  const profile = model?.profile;
  const health: ProfileHealth = !model || model.profileStatus === 'none'
    ? 'not_probed'
    : model.profileStatus === 'conservative'
      ? 'learning'
      : profile && (profile.providerHealth.timeouts > 0 || profile.providerHealth.stalls > 0)
        ? 'degraded'
        : 'healthy';
  const label = health === 'healthy'
    ? 'Healthy'
    : health === 'degraded'
      ? `Degraded (${profile?.providerHealth.timeouts ?? 0} timeouts, ${profile?.providerHealth.stalls ?? 0} stalls)`
      : health === 'learning'
        ? 'Learning'
        : 'Not probed yet';
  return {
    health,
    label,
    context: formatContext(model?.contextTokens),
    structured: triLabel(model?.structuredOutput ?? 'unknown'),
    tools: triLabel(model?.tools ?? 'unknown'),
    reasoning: triLabel(model?.reasoning ?? 'unknown'),
    lastProbe: relativeTime(model?.probedAt, now),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Projection: readiness → what each section shows. Pure, so tests can assert the decisions without parsing HTML.

export interface ProviderRowView {
  id: string;
  name: string;
  state: 'connected' | 'exhausted' | 'error' | 'disabled' | 'available';
  /** Plain-language classification; promotional/trial credit is never described as recurring free service. */
  classification: string;
  detail: string;
  tags: string[];
  warning?: string;
  error?: string;
}

export function freeTierLabel(kind: CloudPoolProviderRow['freeTierKind']): string {
  switch (kind) {
    case 'recurring': return 'Free tier';
    case 'promotional': return 'Promotional credits';
    case 'trial': return 'Trial / evaluation';
    case 'paid': return 'Paid';
    default: return 'Free status unknown';
  }
}

function paymentLabel(value: CloudPoolProviderRow['paymentRequired']): string {
  return value === 'requiresPaymentMethod' ? 'Card required' : value === 'doesNotRequirePaymentMethod' ? 'No card required' : 'Card requirement unknown';
}

function capabilityTagLabel(tag: string): string {
  return tag === 'structured-output' ? 'Structured output' : tag.charAt(0).toUpperCase() + tag.slice(1);
}

export function projectProvider(row: CloudPoolProviderRow): ProviderRowView {
  const tags = row.capabilityTags.filter(tag => tag === 'vision' || tag === 'tools').map(capabilityTagLabel);
  const classification = freeTierLabel(row.freeTierKind);
  let state: ProviderRowView['state'] = 'available';
  let detail: string;
  if (row.connected && !row.enabled) {
    state = 'disabled';
    detail = 'Connected · switched off for the pool';
  } else if (row.connected && row.quotaExhausted) {
    state = 'exhausted';
    detail = 'Free quota exhausted';
  } else if (row.connected && row.error) {
    state = 'error';
    detail = row.error.kind === 'auth' ? 'Credential rejected' : 'Could not list models';
  } else if (row.connected) {
    state = 'connected';
    detail = row.modelCount !== undefined
      ? `Connected · ${row.modelCount} model${row.modelCount === 1 ? '' : 's'}${row.freeCount !== undefined ? ` · ${row.freeCount} free` : ''}`
      : 'Connected · models load on refresh';
  } else {
    detail = [classification, ...tags, paymentLabel(row.paymentRequired)].join(' · ');
  }
  return {
    id: row.id,
    name: row.displayName,
    state,
    classification,
    detail,
    tags,
    ...(row.privacyWarning ? { warning: row.privacyWarning } : {}),
    ...(row.error ? { error: row.error.reason } : {}),
  };
}

export interface RoutingRowView { label: string; value: string; tone: 'local' | 'cloud' | 'neutral' | 'warn' }

/** Current routing, from real mode readiness and the known model list. Nothing here is a default someone typed in. */
export function projectRouting(readiness: OnboardingReadiness): RoutingRowView[] {
  const pool = readiness.cloudPool;
  const baat = readiness.modes.find(mode => mode.mode === 'baat_kar');
  const karke = readiness.modes.find(mode => mode.mode === 'karke_dikha') ?? readiness.modes.find(mode => mode.mode === 'saath_kar');
  const entries = readiness.modelEntries ?? [];
  const vision = entries.find(entry => entry.vision === true && entry.cloud !== true)
    ?? entries.find(entry => entry.vision === true && entry.freeness === 'free');
  const poolOn = pool?.useFreeCloud === true;
  const connected = pool?.connectedCount ?? 0;
  const modelLine = (mode: ModeReadiness | undefined): RoutingRowView =>
    mode?.model ? { label: '', value: `${mode.model} · Local`, tone: 'local' } : { label: '', value: 'No local model available', tone: 'warn' };
  return [
    { ...modelLine(baat), label: 'Conversation / reasoning' },
    { ...modelLine(karke), label: 'Coding / tools' },
    vision
      ? { label: 'Vision', value: `${vision.displayName ?? vision.name} · ${vision.cloud ? `${vision.providerName ?? 'Cloud'} (cloud, ${vision.freeness === 'free' ? 'free' : String(vision.freeness ?? 'unknown')})` : 'Local'}`, tone: vision.cloud ? 'cloud' : 'local' }
      : { label: 'Vision', value: 'No vision-capable model known yet', tone: 'neutral' },
    {
      label: 'When local is unavailable',
      value: poolOn ? (connected > 0 ? `Free cloud pool (${connected} provider${connected === 1 ? '' : 's'})` : 'Free cloud pool — no provider connected') : 'Stay local (cloud not enabled for Auto)',
      tone: poolOn && connected > 0 ? 'cloud' : 'neutral',
    },
    { label: 'Paid cloud', value: pool?.paidBlocked === false ? 'Allowed' : 'Blocked', tone: pool?.paidBlocked === false ? 'warn' : 'neutral' },
  ];
}

export type CapabilityRowView = CapabilityRow;

/**
 * Capability rows from facts the readiness snapshot actually carries. Capabilities that arrive with later platform
 * phases are supplied by the host through `readiness.capabilities`-style registration; this function never lists one
 * it has no evidence for.
 */
export function projectCapabilities(readiness: OnboardingReadiness, extra: readonly CapabilityRowView[] = []): CapabilityRowView[] {
  const pool = readiness.cloudPool;
  const entries = readiness.modelEntries ?? [];
  const visionCount = entries.filter(entry => entry.vision === true).length;
  const rows: CapabilityRowView[] = [];
  rows.push(pool && pool.connectedCount > 0
    ? { name: 'Cloud Models', status: 'ok', detail: `${pool.connectedCount} provider${pool.connectedCount === 1 ? '' : 's'} connected`, action: { label: 'Manage', act: 'scrollCompute' } }
    : { name: 'Cloud Models', status: 'off', detail: 'No provider connected', action: { label: 'Connect', act: 'scrollCompute' } });
  rows.push(visionCount > 0
    ? { name: 'Vision', status: 'ok', detail: `Available through ${visionCount} model${visionCount === 1 ? '' : 's'}` }
    : { name: 'Vision', status: 'off', detail: 'No model with confirmed image support' });
  return [...rows, ...(readiness.capabilityRows ?? []), ...extra];
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML

function row(status: 'ok' | 'warn' | 'bad' | 'info', html: string): string {
  const mark = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : status === 'bad' ? '✗' : 'ℹ';
  return `<div class="row"><span class="mark ${status}">${mark}</span><span class="text">${html}</span></div>`;
}

function button(label: string, action: string, attrs: Record<string, string> = {}, secondary = true): string {
  const data = Object.entries(attrs).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join('');
  return `<button class="${secondary ? 'secondary' : ''}" data-act="${action}"${data}>${escapeHtml(label)}</button>`;
}

function details(id: SetupSectionId | string, state: SetupViewState, summary: string, body: string, extraClass = ''): string {
  return `<details class="disclosure ${extraClass}" data-section="${escapeHtml(id)}"${state.openSections.has(id) ? ' open' : ''}><summary>${escapeHtml(summary)}</summary>${body}</details>`;
}

function card(id: string, title: string, accent: string, body: string, aside = ''): string {
  return `<section class="card ${accent}" id="section-${id}" aria-labelledby="h-${id}">
<div class="card-head"><h2 id="h-${id}">${escapeHtml(title)}</h2>${aside}</div>
${body}
</section>`;
}

function badge(label: string, tone: string, title = ''): string {
  return `<span class="badge ${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
}

export function systemVerdict(readiness: OnboardingReadiness): ReadinessVerdict {
  if (readiness.system) return readiness.system;
  const pool = readiness.cloudPool;
  return computeSystemReadiness({
    core: readiness.coreRuntime.connected ? 'connected' : readiness.coreRuntime.state === 'starting' || readiness.coreRuntime.state === 'reconnecting' ? 'starting' : 'unavailable',
    localReachable: readiness.provider.reachable,
    localUsable: readiness.provider.reachable && readiness.modes.some(mode => Boolean(mode.model)),
    cloudConnected: pool?.connectedCount ?? 0,
    cloudAvailable: pool?.availableCount ?? 0,
    useFreeCloud: pool?.useFreeCloud ?? false,
  });
}

function renderHeader(readiness: OnboardingReadiness): string {
  const verdict = systemVerdict(readiness);
  const tone = verdict.state === 'READY' ? 'ready' : verdict.state === 'READY_CLOUD' ? 'ready-cloud' : verdict.state === 'LIMITED' ? 'limited' : 'attention';
  const build = readiness.build ? escapeHtml(`v${readiness.build.version}`) : '';
  return `<header class="page-head">
<div class="title-block">
<h1>KarkeDikha Setup</h1>
<div class="subline">${escapeHtml(verdict.subline)}</div>
</div>
<div class="head-right">
<span class="overall ${tone}" role="status" data-readiness="${verdict.state}"><span class="dot" aria-hidden="true">●</span> ${escapeHtml(verdict.badge)}</span>
<div class="head-meta">${build ? `<span class="muted">${build}</span>` : ''}${button('Copy diagnostics', 'copyDiagnostics')}</div>
</div>
</header>`;
}

function renderLocal(readiness: OnboardingReadiness): string {
  const provider = readiness.provider;
  const endpoint = provider.apiBase ? escapeHtml(provider.apiBase) : '<span class="muted">not set</span>';
  const karkeModel = (readiness.models ?? []).find(model => model.name === readiness.recommendedKarkeModel);
  const summary = summarizeProfile(karkeModel);
  const core = readiness.coreRuntime?.connected
    ? ''
    : readiness.coreRuntime?.state === 'starting'
      ? row('warn', `Core runtime starting<span class="sub">${escapeHtml(readiness.coreRuntime.summary)}</span>`)
      : readiness.coreRuntime
        ? row('bad', `Core runtime unavailable<span class="sub">${escapeHtml(readiness.coreRuntime.summary)}</span>`)
        : '';
  if (provider.reachable) {
    const modelLine = readiness.recommendedKarkeModel
      ? `<span class="sub">${escapeHtml(readiness.recommendedKarkeModel)} · ${escapeHtml(summary.label)}</span>`
      : `<span class="sub">${readiness.installedModelCount} model(s) reported; none yet meets Karke Dikha's requirements</span>`;
    return `<div class="block local">
<div class="block-title"><span class="kicker">LOCAL AI</span>${badge('RECOMMENDED', 'good')}</div>
${row('ok', `<b>${escapeHtml(provider.label)} Connected</b> <span class="mono">${endpoint}</span>${modelLine}`)}
${core}
<div class="actions">${button('Test', 'testConnection')}${button('Refresh Models', 'recheck')}${button('Edit Endpoint', 'editEndpoint')}</div>
</div>`;
  }
  const verdict = systemVerdict(readiness);
  const cloudOk = verdict.state === 'READY_CLOUD';
  return `<div class="block local down">
<div class="block-title"><span class="kicker">LOCAL AI</span></div>
${row(cloudOk ? 'info' : 'bad', `<b>${escapeHtml(provider.label)} unavailable</b> <span class="mono">${endpoint}</span><span class="sub">${escapeHtml(provider.detail)}${provider.nextAction ? ' — ' + escapeHtml(provider.nextAction) : ''}</span>`)}
${verdict.message ? `<div class="callout ${cloudOk ? 'cloud' : 'warn'}">${escapeHtml(verdict.message)}</div>` : ''}
${core}
<div class="actions">${button('Start Ollama', 'setupHelp', {}, false)}${verdict.state === 'NEEDS_ATTENTION' ? button('Connect free cloud', 'scrollCompute', {}, false) : ''}${button('Retry', 'recheck')}${button('Edit endpoint', 'editEndpoint')}${button('Test connection', 'testConnection')}${button('Setup help', 'setupHelp')}</div>
</div>`;
}

function renderProviderRow(row: CloudPoolProviderRow): string {
  const view = projectProvider(row);
  const mark = view.state === 'connected' ? '✓' : view.state === 'exhausted' ? '⚠' : view.state === 'error' ? '✗' : view.state === 'disabled' ? '⏸' : '○';
  const actions = row.connected
    ? `${button('Browse models', 'openPalette', { id: row.id })}${button('Refresh', 'refreshModels', { id: row.id })}
<details class="manage"><summary>Manage</summary><div class="manage-body">
${button('Change key', 'connectProvider', { id: row.id })}
${button(row.enabled ? 'Turn off for pool' : 'Turn on for pool', 'toggleProvider', { id: row.id, enabled: row.enabled ? 'false' : 'true' })}
${button('Remove credentials', 'removeCredentials', { id: row.id })}
${button('Remove provider', 'removeProvider', { id: row.id })}
</div></details>`
    : button('Connect', 'connectProvider', { id: row.id }, false);
  const note = view.state === 'available' && row.freeTierNote ? `<span class="sub">${escapeHtml(row.freeTierNote)}</span>` : '';
  const warning = view.warning ? `<span class="sub warn-text">⚠ ${escapeHtml(view.warning)}</span>` : '';
  const error = view.state === 'error' && view.error ? `<span class="sub bad-text">${escapeHtml(view.error)}</span>` : '';
  const exhausted = view.state === 'exhausted' ? '<span class="sub warn-text">Routing switches to another free provider.</span>' : '';
  return `<li class="provider ${view.state}" data-provider="${escapeHtml(row.id)}" data-state="${view.state}">
<span class="pmark ${view.state}" aria-hidden="true">${mark}</span>
<div class="pmain"><div class="pname">${escapeHtml(view.name)} ${row.connected ? '' : badge(view.classification.toUpperCase(), row.freeTierKind === 'recurring' ? 'good' : row.freeTierKind === 'unknown' ? 'muted' : 'amber')}</div>
<div class="pdetail">${escapeHtml(view.detail)}</div>${note}${warning}${error}${exhausted}</div>
<div class="pact">${actions}</div>
</li>`;
}

function renderCloudBoost(readiness: OnboardingReadiness): string {
  const pool: CloudPoolReadiness | undefined = readiness.cloudPool;
  if (!pool) return '';
  const ordered = [...pool.providers].sort((a, b) => Number(b.connected) - Number(a.connected) || 0);
  const list = `<ul class="providers" aria-label="Cloud providers">${ordered.map(renderProviderRow).join('')}</ul>`;
  const toggle = (id: string, act: string, label: string, on: boolean, locked = false, hint = '') =>
    `<label class="toggle${locked ? ' locked' : ''}"><input type="checkbox" data-act="${act}" data-id="${id}" ${on ? 'checked' : ''}${locked ? ' disabled' : ''}><span class="tlabel">${escapeHtml(label)}</span><span class="tstate ${on ? 'on' : 'off'}">${on ? 'ON' : 'OFF'}</span>${hint ? `<span class="sub">${escapeHtml(hint)}</span>` : ''}</label>`;
  const paidHint = pool.paidBlocked
    ? 'Paid cloud: BLOCKED. Only models known to be free can be used; nothing is ever charged silently.'
    : 'Paid cloud: ALLOWED. Models that are not known to be free may be used and may incur charges.';
  return `<div class="block cloud" id="free-cloud">
<div class="block-title"><span class="kicker">FREE CLOUD BOOST</span></div>
<p class="sub lead">Use connected free quotas when local cannot do the job.</p>
${list}
<div class="actions">${button('Refresh free providers', 'refreshCatalog')}${button('Refresh models', 'refreshModels', { id: '*' })}<span class="muted catalog-version">Catalog ${escapeHtml(pool.catalogVersion)}</span></div>
<div class="policy" role="group" aria-label="Cloud policy">
${toggle('localFirst', 'toggleLocalFirst', 'Local first', true, true, 'KarkeDikha always tries your machine first.')}
${toggle('useFreeCloud', 'toggleUseFreeCloud', 'Use free cloud when needed', pool.useFreeCloud)}
${toggle('neverPaid', 'toggleNeverPaid', 'Never incur paid usage', pool.paidBlocked, false, paidHint)}
</div>
<div class="policy-banner ${pool.paidBlocked ? 'blocked' : 'allowed'}" data-paid="${pool.paidBlocked ? 'blocked' : 'allowed'}">${pool.paidBlocked ? '🛡 Paid cloud usage is BLOCKED' : '⚠ Paid cloud usage is ALLOWED'}</div>
</div>`;
}

function renderCompute(readiness: OnboardingReadiness): string {
  const body = `${renderLocal(readiness)}${renderCloudBoost(readiness)}`;
  return card('compute', 'COMPUTE', 'accent-green', body);
}

function modelRow(entry: SetupModelEntry): string {
  const cloud = entry.cloud === true;
  const badges: string[] = [badge(cloud ? 'CLOUD' : 'LOCAL', cloud ? 'purple' : 'good')];
  if (entry.freeness === 'free') badges.push(badge('FREE', 'good'));
  else if (entry.freeness === 'paid') badges.push(badge('PAID', 'bad'));
  else if (entry.freeness === 'trial') badges.push(badge('TRIAL', 'amber'));
  else if (entry.freeness === 'promotional') badges.push(badge('PROMO', 'amber'));
  if (entry.vision === true) badges.push(badge('VISION', 'blue'));
  if (entry.tools === true) badges.push(badge('TOOLS', 'blue'));
  if (entry.coding === true) badges.push(badge('CODING', 'teal'));
  const name = entry.displayName ?? entry.name;
  return `<li class="mrow"><div class="mname">${escapeHtml(name)}</div><div class="mid mono">${escapeHtml(entry.modelId ?? entry.name)}</div><div class="mmeta"><span class="mprov">${escapeHtml(entry.providerName ?? 'Ollama')}</span>${badges.join('')}</div></li>`;
}

/** Entries as JSON for the palette. `<` is escaped so a hostile model id can never close the script element. */
export function modelDataJson(entries: readonly SetupModelEntry[]): string {
  return JSON.stringify(entries).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function renderModels(readiness: OnboardingReadiness, state: SetupViewState): string {
  const entries = readiness.modelEntries ?? [];
  const total = entries.length;
  const local = entries.filter(entry => entry.cloud !== true).slice(0, 3);
  const recommended = entries.filter(entry => entry.cloud === true && entry.freeness === 'free')
    .sort((a, b) => Number(b.tools === true) - Number(a.tools === true) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0))
    .slice(0, 4);
  const filters = ['All', 'Local', 'Cloud', 'Free', 'Coding', 'Vision', 'Tools'];
  const canBrowse = Boolean(state.paletteScriptUri);
  const section = (title: string, rows: SetupModelEntry[]) => rows.length
    ? `<div class="mgroup"><div class="mgroup-title">${escapeHtml(title)}</div><ul class="mlist">${rows.map(modelRow).join('')}</ul></div>`
    : '';
  const body = total === 0
    ? '<p class="sub">No models yet. Start Ollama or connect a free cloud provider.</p>'
    : `${canBrowse ? `<input id="setup-model-search" class="search" type="search" placeholder="🔎 Search models…" aria-label="Search models" autocomplete="off">
<div class="chips" role="group" aria-label="Model filters">${filters.map(f => `<button class="chip" data-act="openPalette" data-filter="${f.toLowerCase()}">${f}</button>`).join('')}</div>` : ''}
${section('AVAILABLE NOW — LOCAL', local)}
${section('RECOMMENDED — FREE', recommended)}
${canBrowse ? `<div class="actions">${button('View all models', 'openPalette', {}, false)}</div>` : ''}`;
  return card('models', 'MODELS', 'accent-blue', body, `<span class="count">${total} available</span>`);
}

function renderRouting(readiness: OnboardingReadiness): string {
  const rows = projectRouting(readiness).map(item => `<div class="kvrow"><span class="k">${escapeHtml(item.label)}</span><span class="v ${item.tone}">${escapeHtml(item.value)}</span></div>`).join('');
  const body = `<div class="kvrow"><span class="k">Default mode</span><span class="v">Auto</span></div>
<div class="kvrow"><span class="k">Default supervision</span><span class="v">Ask me</span></div>
<div class="kvsep"></div>
${rows}
<p class="sub">Mode and supervision are chosen per message in the chat composer; this page only summarises how routing behaves.</p>
<div class="actions">${button('Configure routing', 'configureRouting')}</div>`;
  return card('routing', 'ROUTING & SUPERVISION', 'accent-teal', body);
}

function renderCapabilities(readiness: OnboardingReadiness, extra: readonly CapabilityRowView[]): string {
  const rows = projectCapabilities(readiness, extra).map(item => `<div class="cap ${item.status}"><span class="cmark" aria-hidden="true">${item.status === 'ok' ? '✓' : item.status === 'warn' ? '⚠' : '○'}</span><div class="cmain"><b>${escapeHtml(item.name)}</b><span class="sub">${escapeHtml(item.detail)}</span></div>${item.action ? button(item.action.label, item.action.act) : ''}</div>`).join('');
  return card('capabilities', 'CAPABILITIES', 'accent-blue', rows);
}

function renderProfileDiagnostics(profile: RuntimeCapabilityProfile | undefined): string {
  if (!profile) return '<div class="sub">No profile has been recorded for this model yet. Re-probe runs a short bounded check.</div>';
  const kv = (key: string, value: string) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`;
  const rows = [
    kv('Served context', profile.contextWindow ? `${formatContext(profile.contextWindow.tokens)} (${profile.contextWindow.provenance})` : 'unknown'),
    kv('Largest completion seen', profile.practicalOutputTokens ? `${profile.practicalOutputTokens} tokens` : 'not observed'),
    kv('Tool continuation', profile.postToolContinuation),
    kv('Structured schema', profile.structuredSchema),
    kv('Prompt-only JSON contract', profile.promptOnlyContract),
    kv('Schema enforcement helps', profile.schemaEnforcementHelps),
    kv('Reasoning channel', profile.reasoning.supported),
    kv('Reasoning can be disabled', profile.reasoning.canDisable),
    kv('Reasoning levels', profile.reasoning.levels?.join(', ') ?? 'not reported'),
    kv('Empty completion', profile.emptyCompletion),
    kv('Latency', profile.latencyMs !== undefined ? `${Math.round(profile.latencyMs)} ms` : 'not measured'),
    kv('Generation speed', profile.tokensPerSecond !== undefined ? `${profile.tokensPerSecond.toFixed(1)} tok/s` : 'not measured'),
    kv('Provider health', `${profile.providerHealth.timeouts} timeouts, ${profile.providerHealth.stalls} stalls, ${profile.providerHealth.emptyCompletions} empty, ${profile.providerHealth.recovered} recovered`),
  ].join('');
  return `<table class="kv">${rows}</table>`;
}

function renderModes(readiness: OnboardingReadiness): string {
  return readiness.modes.map(mode => `<div class="mode"><div class="mode-head"><b>${escapeHtml(mode.label)}</b> <span class="pill">Auto</span> ${mode.model ? escapeHtml(mode.model) : '<span class="muted">no model available</span>'}</div>
<span class="sub">${mode.ready ? escapeHtml(mode.reason) : `<span class="bad-text">${escapeHtml(mode.reason)}</span>`}</span></div>`).join('');
}

function renderLocalModelList(readiness: OnboardingReadiness): string {
  const models = readiness.models ?? [];
  if (!readiness.provider.reachable) return '';
  if (models.length === 0) return '<div class="sub">No models reported by the provider yet. Use "Refresh models" after loading or pulling one.</div>';
  return models.map(model => {
    const profile = model.profileStatus === 'none' ? 'no profile yet' : `profile: ${model.profileStatus}`;
    return `<div class="model"><div><b>${escapeHtml(model.name)}</b> <span class="pill ${model.state === 'ready' ? 'ok' : 'bad'}">${model.state}</span></div>
<span class="sub">context ${escapeHtml(formatContext(model.contextTokens))} · reasoning ${escapeHtml(triLabel(model.reasoning).toLowerCase())} · tools ${escapeHtml(triLabel(model.tools).toLowerCase())} · structured output ${escapeHtml(triLabel(model.structuredOutput).toLowerCase())} · vision ${escapeHtml(triLabel(model.vision).toLowerCase())} · ${escapeHtml(profile)}</span></div>`;
  }).join('');
}

function renderHealth(readiness: OnboardingReadiness, state: SetupViewState): string {
  const pool = readiness.cloudPool;
  const local = readiness.provider.reachable ? 'Healthy' : 'Unavailable';
  const core = readiness.coreRuntime.connected ? 'Healthy' : readiness.coreRuntime.state === 'starting' ? 'Starting' : 'Unavailable';
  const overallHealthy = readiness.provider.reachable && readiness.coreRuntime.connected;
  const tone = (ok: boolean, warn = false) => (ok ? 'ok' : warn ? 'warn' : 'bad');
  const line = (label: string, value: string, t: string) => `<div class="kvrow"><span class="k">${escapeHtml(label)}</span><span class="v ${t}">${escapeHtml(value)}</span></div>`;
  const karke = readiness.modes.find(mode => mode.mode === 'karke_dikha');
  const model = (readiness.models ?? []).find(item => item.name === karke?.model);
  const summary = summarizeProfile(model, state.now);
  const diag = `${readiness.provider.reachable ? `<div class="sub">Runtime profile: ${escapeHtml([summary.label, summary.context, `Tools: ${summary.tools}`, `Structured: ${summary.structured}`].join(' · '))}${model ? ` — ${escapeHtml(model.name)} · last probe ${escapeHtml(summary.lastProbe)}` : ''}</div>
<div class="actions">${model ? button('Re-probe', 'reprobe', { model: model.name }) : ''}</div>
${details('profile', state, 'Profile details', renderProfileDiagnostics(model?.profile))}` : ''}
${readiness.coreRuntime.connected ? row('ok', 'Core runtime connected<span class="sub">Authority and governance engine ready</span>') : ''}
${details('fallback', state, 'Mode readiness', renderModes(readiness))}
${details('models', state, `Discovered local models (${(readiness.models ?? []).length})`, renderLocalModelList(readiness))}
${pool ? `<div class="sub">Cloud policy: ${escapeHtml(pool.spendMode)}${pool.allowCredits ? ' + credits' : ''} · exhausted: ${escapeHtml(pool.exhaustedIds.join(', ') || 'none')} · catalog ${escapeHtml(pool.catalogVersion)}</div>` : ''}`;
  const body = `<div class="health-head"><span class="hdot ${overallHealthy ? 'ok' : 'warn'}" aria-hidden="true">●</span> <b>${overallHealthy ? 'Healthy' : 'Needs attention'}</b></div>
${line('Local inference', local, tone(readiness.provider.reachable, false))}
${line('Core runtime', core, tone(readiness.coreRuntime.connected, readiness.coreRuntime.state === 'starting'))}
${line('Cloud providers', pool ? `${pool.connectedCount} connected` : 'none', pool && pool.connectedCount > 0 ? 'ok' : 'neutral')}
${details('diagnostics', state, 'Diagnostics ▾', diag, 'diagnostics')}`;
  return card('health', 'SYSTEM HEALTH', 'accent-green', body);
}

function renderAdvanced(readiness: OnboardingReadiness, state: SetupViewState): string {
  const advanced = readiness.advanced;
  const parts: string[] = [];
  if (advanced) {
    const context = advanced.context.kind === 'manual' ? `Manual — ${formatContext(advanced.context.tokens)}` : 'Auto — resolved from the provider and the model profile';
    const output = advanced.outputReservation.kind === 'manual' ? `${advanced.outputReservation.tokens} tokens (manual)` : 'profile default';
    parts.push(`<table class="kv">
<tr><td>Context</td><td>${escapeHtml(context)}</td></tr>
<tr><td>Output cap sent to the runtime</td><td>none — KarkeDikha does not set <code>num_predict</code>; the runtime's own limit applies</td></tr>
<tr><td>Output reservation (internal budget)</td><td>${escapeHtml(output)} — used for planning only, not a wire setting</td></tr>
<tr><td>Reasoning</td><td>Auto — negotiated per model from its profile</td></tr>
<tr><td>Automatic context recovery ceiling</td><td>${escapeHtml(formatContext(advanced.recoveryCeiling.tokens))} (${advanced.recoveryCeiling.source === 'env' ? 'environment override' : 'default'}) — only used once, after a truncated reply; an explicit context is never widened</td></tr>
</table>
<div class="sub">Large contexts use a lot of memory and slow every request. Leave Context on Auto unless a model genuinely needs more.</div>
<div class="actions">${button('Set context window…', 'setContext')}${advanced.context.kind === 'manual' ? button('Use Auto context', 'autoContext') : ''}</div>`);
  }
  const pool = readiness.cloudPool;
  if (pool) {
    parts.push(`<div class="adv-block"><b>Cloud credentials</b>
<div class="sub">Keys live only in VS Code SecretStorage and are delivered to the Core runtime in memory. They are never written to settings, logs, prompts or diagnostics. Opening Setup never contacts a cloud service.</div>
<div class="actions">${button('Remove all cloud credentials', 'removeAllCloud')}</div></div>`);
    parts.push(`<div class="adv-block"><b>Provider endpoints</b><table class="kv">${pool.providers.map(p => `<tr><td>${escapeHtml(p.displayName)}</td><td class="mono">${escapeHtml(p.host ?? '')}</td></tr>`).join('')}</table></div>`);
  }
  const cloud = readiness.cloudFallback;
  parts.push(`<div class="adv-block"><b>Single-endpoint cloud fallback (legacy)</b>
<div class="sub">${escapeHtml(cloud.summary)} Opening Setup never contacts a cloud service.</div>
<div class="actions">${button('Configure cloud fallback', 'setUpCloudFallback')}${cloud.policy !== 'local-only' ? button('Turn off (local only)', 'disableCloudFallback') : ''}</div></div>`);
  return card('advanced', 'ADVANCED', 'accent-muted', details('advanced', state, 'Context · output · providers · credentials', parts.join('')));
}

function renderBuild(readiness: OnboardingReadiness): string {
  const build = readiness.build;
  const body = build
    ? `<div class="kvrow"><span class="k">KarkeDikha</span><span class="v">${escapeHtml(formatBuildIdentity(build))}</span></div>
<div class="sub">Milestone/build ${escapeHtml(build.milestone)} · product SHA ${escapeHtml(build.sha)}${build.dirty ? ' (uncommitted changes at build)' : ''}${build.builtAt ? ' · built ' + escapeHtml(build.builtAt) : ''}</div>`
    : '<div class="sub">Build identity unavailable.</div>';
  return card('build', 'BUILD', 'accent-muted', `${body}<div class="actions">${button('Copy diagnostics', 'copyDiagnostics')}</div>`);
}

function renderConnect(state: SetupViewState): string {
  const connect = state.connect;
  const pool = state.readiness?.cloudPool;
  const provider = connect ? pool?.providers.find(p => p.id === connect.providerId) : undefined;
  if (!connect || !provider) return '';
  const name = escapeHtml(provider.displayName);
  if (connect.connected) {
    return `<div class="scrim"><div class="modal success" role="dialog" aria-modal="true" aria-labelledby="connect-title">
<h3 id="connect-title">✓ ${name.toUpperCase()} CONNECTED</h3>
<p>${connect.connected.modelCount} model${connect.connected.modelCount === 1 ? '' : 's'} discovered</p>
<p>${connect.connected.freeCount} currently free</p>
<div class="actions">${button('Browse models', 'openPalette', { id: provider.id }, false)}${button('Change key', 'connectProvider', { id: provider.id })}${button('Disconnect', 'removeProvider', { id: provider.id })}${button('Done', 'closeConnect')}</div>
</div></div>`;
  }
  const free = freeTierLabel(provider.freeTierKind);
  const accountField = provider.requiresAccountId
    ? `<label class="field"><span>Account ID</span><input id="connect-account" type="text" autocomplete="off" spellcheck="false" aria-label="Account ID"></label>`
    : '';
  const keyPlaceholder = connect.keyStaged ? '•••••••••••••••• (pasted from clipboard)' : 'Paste your API key';
  const message = connect.message ? `<div class="notice ${connect.message.kind}" role="alert">${escapeHtml(connect.message.text)}</div>` : '';
  return `<div class="scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" data-provider="${escapeHtml(provider.id)}">
<h3 id="connect-title">Connect ${name}</h3>
<p class="sub">${escapeHtml(free)}${provider.freeTierNote ? ' — ' + escapeHtml(provider.freeTierNote) : ''}</p>
${provider.privacyWarning ? `<p class="warn-text">⚠ ${escapeHtml(provider.privacyWarning)}</p>` : ''}
<div class="step"><div class="step-n">STEP 1</div><b>Get an API key</b>
<div class="actions">${button('Open in VS Code', 'openKeysPage', { id: provider.id, mode: 'vscode' }, false)}${button('Open externally', 'openKeysPage', { id: provider.id, mode: 'external' })}</div></div>
<div class="step"><div class="step-n">STEP 2</div>Sign in yourself, then create and copy your key. KarkeDikha never reads your browser, cookies or passwords.</div>
<div class="step"><div class="step-n">STEP 3</div>
${accountField}
<label class="field"><span>API key</span><input id="connect-key" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(keyPlaceholder)}" aria-label="API key"></label>
<div class="actions">${button('Paste from clipboard', 'pasteClipboard', { id: provider.id })}${button('Save & test', 'saveProvider', { id: provider.id }, false)}${button('Cancel', 'closeConnect')}</div></div>
${message}
<p class="sub foot">Your key is stored securely and reused automatically. It is never written to settings, logs, prompts or diagnostics.</p>
</div></div>`;
}

function renderBody(readiness: OnboardingReadiness, state: SetupViewState, extraCaps: readonly CapabilityRowView[]): string {
  const modelData = state.paletteScriptUri
    ? `<script type="application/json" id="kd-setup-models">${modelDataJson(readiness.modelEntries ?? [])}</script>`
    : '';
  return `${renderHeader(readiness)}
<div class="grid">
${renderCompute(readiness)}
${renderModels(readiness, state)}
${renderRouting(readiness)}
${renderCapabilities(readiness, extraCaps)}
${renderHealth(readiness, state)}
${renderAdvanced(readiness, state)}
${renderBuild(readiness)}
</div>
${modelData}
${renderConnect(state)}`;
}

const STYLE = `
:root{color-scheme:light dark;--kd-green:#3fb950;--kd-cyan:#58a6ff;--kd-purple:#a78bfa;--kd-teal:#2dd4bf;--kd-amber:#d29922;--kd-red:#f85149;
--kd-surface:var(--vscode-editorWidget-background,#252526);--kd-border:var(--vscode-widget-border,var(--vscode-panel-border,#3c3c3c));--kd-muted:.72}
*{box-sizing:border-box}
body{font:13px/1.45 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px 20px 48px}
.wrap{max-width:1040px;margin:0 auto}
h1{font-size:20px;margin:0;font-weight:650;letter-spacing:.01em}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin:0;font-weight:700;opacity:.9}
h3{margin:0 0 6px;font-size:15px}
.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.subline{opacity:var(--kd-muted);margin-top:3px}
.head-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.head-meta{display:flex;align-items:center;gap:10px}
.overall{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 14px;font-weight:700;font-size:12px;letter-spacing:.06em;border:1px solid}
.overall .dot{font-size:10px}
.overall.ready{color:var(--kd-green);border-color:color-mix(in srgb,var(--kd-green) 60%,transparent);background:color-mix(in srgb,var(--kd-green) 12%,transparent);box-shadow:0 0 14px color-mix(in srgb,var(--kd-green) 28%,transparent)}
.overall.ready-cloud{color:var(--kd-purple);border-color:color-mix(in srgb,var(--kd-purple) 60%,transparent);background:color-mix(in srgb,var(--kd-purple) 12%,transparent);box-shadow:0 0 14px color-mix(in srgb,var(--kd-purple) 26%,transparent)}
.overall.limited{color:var(--kd-amber);border-color:color-mix(in srgb,var(--kd-amber) 60%,transparent);background:color-mix(in srgb,var(--kd-amber) 12%,transparent)}
.overall.attention{color:var(--kd-red);border-color:color-mix(in srgb,var(--kd-red) 60%,transparent);background:color-mix(in srgb,var(--kd-red) 10%,transparent)}
.grid{display:grid;grid-template-columns:1fr;gap:24px}
.card{background:var(--kd-surface);border:1px solid var(--kd-border);border-radius:8px;padding:18px 20px}
.card.accent-green{border-top:2px solid color-mix(in srgb,var(--kd-green) 60%,transparent)}
.card.accent-blue{border-top:2px solid color-mix(in srgb,var(--kd-cyan) 55%,transparent)}
.card.accent-teal{border-top:2px solid color-mix(in srgb,var(--kd-teal) 55%,transparent)}
.card.accent-muted{border-top:2px solid var(--kd-border)}
.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.count{font-size:12px;opacity:var(--kd-muted)}
.block{padding:4px 0 14px}
.block + .block{border-top:1px solid var(--kd-border);padding-top:16px}
.block-title{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.kicker{font-size:11px;letter-spacing:.08em;font-weight:700;opacity:.8}
.lead{margin:0 0 8px}
.row{display:flex;align-items:flex-start;gap:8px;padding:4px 0}
.row .mark{width:16px;flex:0 0 auto}
.row .mark.ok{color:var(--kd-green)}.row .mark.warn{color:var(--kd-amber)}.row .mark.bad{color:var(--kd-red)}.row .mark.info{opacity:.72}
.row .text{flex:1}
.sub{opacity:var(--kd-muted);display:block;margin-top:2px}
.muted{opacity:var(--kd-muted)}
.mono{font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
.bad-text{color:var(--kd-red)}.warn-text{color:var(--kd-amber)}
.callout{margin:8px 0;padding:10px 12px;border-radius:6px;border:1px solid var(--kd-border)}
.callout.cloud{border-color:color-mix(in srgb,var(--kd-purple) 55%,transparent);background:color-mix(in srgb,var(--kd-purple) 9%,transparent)}
.callout.warn{border-color:color-mix(in srgb,var(--kd-amber) 55%,transparent);background:color-mix(in srgb,var(--kd-amber) 9%,transparent)}
.actions{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font:inherit}
button.secondary{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--kd-border))}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}
code{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:3px}
.badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;padding:1px 7px;border-radius:4px;border:1px solid var(--kd-border);white-space:nowrap}
.badge.good{color:var(--kd-green);border-color:color-mix(in srgb,var(--kd-green) 55%,transparent)}
.badge.purple{color:var(--kd-purple);border-color:color-mix(in srgb,var(--kd-purple) 55%,transparent)}
.badge.blue{color:var(--kd-cyan);border-color:color-mix(in srgb,var(--kd-cyan) 55%,transparent)}
.badge.teal{color:var(--kd-teal);border-color:color-mix(in srgb,var(--kd-teal) 55%,transparent)}
.badge.amber{color:var(--kd-amber);border-color:color-mix(in srgb,var(--kd-amber) 55%,transparent)}
.badge.bad{color:var(--kd-red);border-color:color-mix(in srgb,var(--kd-red) 55%,transparent)}
.badge.muted{opacity:.7}
.providers{list-style:none;margin:6px 0 0;padding:0}
.provider{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--kd-border) 70%,transparent)}
.provider:last-child{border-bottom:0}
.pmark{text-align:center;opacity:.8}.pmark.connected{color:var(--kd-green);opacity:1}.pmark.exhausted{color:var(--kd-amber);opacity:1}.pmark.error{color:var(--kd-red);opacity:1}
.pname{font-weight:600;font-size:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pdetail{opacity:.82}
.pact{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:flex-start}
.manage summary{cursor:pointer;display:inline-block;padding:6px 10px;border:1px solid var(--vscode-dropdown-border,var(--kd-border));border-radius:4px;background:var(--vscode-dropdown-background)}
.manage-body{display:flex;flex-direction:column;gap:6px;margin-top:6px;align-items:stretch}
.policy{display:flex;flex-direction:column;gap:6px;margin-top:14px}
.toggle{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center}
.toggle .sub{grid-column:2 / 4}
.toggle.locked{opacity:.85}
.tstate{font-size:11px;font-weight:700;letter-spacing:.05em;padding:1px 8px;border-radius:999px;border:1px solid var(--kd-border)}
.tstate.on{color:var(--kd-green);border-color:color-mix(in srgb,var(--kd-green) 55%,transparent)}
.tstate.off{opacity:.7}
.policy-banner{margin-top:12px;padding:9px 12px;border-radius:6px;font-weight:650;border:1px solid}
.policy-banner.blocked{color:var(--kd-green);border-color:color-mix(in srgb,var(--kd-green) 55%,transparent);background:color-mix(in srgb,var(--kd-green) 9%,transparent)}
.policy-banner.allowed{color:var(--kd-amber);border-color:color-mix(in srgb,var(--kd-amber) 60%,transparent);background:color-mix(in srgb,var(--kd-amber) 10%,transparent)}
.search{width:100%;padding:9px 11px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--kd-border));border-radius:6px;font:inherit}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 6px}
.chip{background:transparent;color:var(--vscode-foreground);border:1px solid var(--kd-border);border-radius:999px;padding:3px 11px;font-size:12px}
.mgroup{margin-top:12px}.mgroup-title{font-size:11px;letter-spacing:.06em;opacity:.65;font-weight:700;margin-bottom:4px}
.mlist{list-style:none;margin:0;padding:0}
.mrow{padding:8px 0;border-bottom:1px solid color-mix(in srgb,var(--kd-border) 60%,transparent)}
.mname{font-weight:600;font-size:14px}.mid{opacity:.72}.mmeta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:3px}.mprov{opacity:.85;margin-right:2px}
.kvrow{display:grid;grid-template-columns:minmax(150px,230px) 1fr;gap:12px;padding:5px 0}
.kvrow .k{opacity:var(--kd-muted)}.kvrow .v.local{color:var(--kd-green)}.kvrow .v.cloud{color:var(--kd-purple)}.kvrow .v.warn{color:var(--kd-amber)}.kvrow .v.ok{color:var(--kd-green)}.kvrow .v.bad{color:var(--kd-red)}
.kvsep{height:1px;background:var(--kd-border);margin:8px 0}
.cap{display:grid;grid-template-columns:20px 1fr auto;gap:10px;align-items:center;padding:7px 0}
.cap.ok .cmark{color:var(--kd-green)}.cap.off .cmark{opacity:.6}.cap.warn .cmark{color:var(--kd-amber)}
.cmain{display:flex;flex-direction:column}
.health-head{margin-bottom:6px}.hdot.ok{color:var(--kd-green)}.hdot.warn{color:var(--kd-amber)}
.disclosure{margin-top:10px}.disclosure>summary{cursor:pointer;opacity:.9}
.diagnostics{border-top:1px dashed var(--kd-border);padding-top:8px}
.adv-block{margin:12px 0}
.model{padding:5px 0}.mode{padding:6px 0;border-bottom:1px solid var(--kd-border)}
.mode-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pill{border:1px solid var(--kd-border);border-radius:10px;padding:0 7px;font-size:11px;opacity:.9}
.pill.ok{color:var(--kd-green)}.pill.bad{color:var(--kd-red)}
.kv{border-collapse:collapse;margin-top:6px}.kv td{padding:2px 14px 2px 0;vertical-align:top}.kv td:first-child{opacity:.72;white-space:nowrap}
.notice{margin:0 0 14px;padding:9px 12px;border-radius:6px;border:1px solid var(--kd-border)}
.notice.ok{border-color:var(--kd-green)}.notice.bad{border-color:var(--kd-red)}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-start;justify-content:center;padding:6vh 14px;overflow:auto;z-index:50}
.modal{width:min(560px,100%);background:var(--vscode-editor-background);border:1px solid var(--kd-border);border-radius:10px;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.modal.success{border-color:color-mix(in srgb,var(--kd-green) 60%,transparent);box-shadow:0 0 22px color-mix(in srgb,var(--kd-green) 25%,transparent)}
.step{margin:12px 0}.step-n{font-size:10px;letter-spacing:.1em;opacity:.6;font-weight:700}
.field{display:flex;flex-direction:column;gap:4px;margin:8px 0}
.field input{padding:8px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--kd-border));border-radius:5px;font:inherit}
.foot{margin-top:12px}
@media (min-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}#section-compute{grid-column:1 / -1}#section-health,#section-advanced{grid-column:auto}}
@media (max-width:620px){body{padding:14px 12px 40px}.provider{grid-template-columns:20px 1fr}.pact{grid-column:2;justify-content:flex-start}.kvrow{grid-template-columns:1fr;gap:2px}.head-right{align-items:flex-start}.card{padding:14px}}
@media (max-width:420px){button{white-space:normal;text-align:left}.modal{padding:14px 14px}.scrim{padding:3vh 8px}.pact button,.actions button{flex:1 1 auto}.manage-body{align-items:stretch}.mmeta{gap:4px}.policy-banner{font-size:12px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
let paletteLoaded = false;
function paletteModels() {
  const el = document.getElementById('kd-setup-models');
  if (!el || !window.KDModelPalette) return [];
  try { return JSON.parse(el.textContent || '[]').map(window.KDModelPalette.normalize); } catch (e) { return []; }
}
let palette;
function openPalette(init) {
  if (!window.KDModelPalette) return;
  if (!palette) {
    palette = window.KDModelPalette.createPalette({
      getModels: paletteModels, getSelected: () => '', onSelect: () => undefined, readOnly: true,
      title: 'Models', autoLabel: 'Auto', getRecent: () => [], onRecent: () => undefined,
    });
  }
  palette.open(init);
}
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
  if (!target || target.tagName === 'INPUT') return;
  const act = target.getAttribute('data-act');
  if (act === 'openPalette') { openPalette({ filter: target.getAttribute('data-filter') || 'all' }); return; }
  if (act === 'scrollCompute') { const c = document.getElementById('free-cloud'); if (c) c.scrollIntoView({ block: 'start' }); return; }
  const message = { type: act };
  for (const attr of Array.from(target.attributes)) {
    if (attr.name.startsWith('data-') && attr.name !== 'data-act') message[attr.name.slice(5)] = attr.value;
  }
  if (act === 'saveProvider') {
    // The key crosses once, from the field to the extension host, and is cleared immediately. It is never rendered back.
    const key = document.getElementById('connect-key');
    const account = document.getElementById('connect-account');
    message.apiKey = key ? key.value : '';
    message.accountId = account ? account.value : '';
    if (key) key.value = '';
  }
  vscode.postMessage(message);
});
document.addEventListener('change', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.tagName !== 'INPUT' || target.getAttribute('type') !== 'checkbox') return;
  const act = target.getAttribute('data-act');
  if (act) vscode.postMessage({ type: act, id: target.getAttribute('data-id') || '', on: target.checked });
});
const search = document.getElementById('setup-model-search');
if (search) search.addEventListener('input', () => { const text = search.value; search.value = ''; openPalette({ text }); });
for (const el of document.querySelectorAll('details[data-section]')) {
  el.addEventListener('toggle', () => vscode.postMessage({ type: 'toggleSection', id: el.getAttribute('data-section'), open: el.open }));
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.querySelector('.scrim') && !document.querySelector('.kd-pal-overlay')) vscode.postMessage({ type: 'closeConnect' }); });
const first = document.querySelector('.modal input, .modal button');
if (first) first.focus();
`;

export function renderSetupHtml(state: SetupViewState, cspSource: string, nonce: string, extraCapabilities: readonly CapabilityRowView[] = []): string {
  const notice = state.notice ? `<div class="notice ${state.notice.kind}" role="status">${escapeHtml(state.notice.text)}</div>` : '';
  const body = state.loading && !state.readiness
    ? '<p class="muted">Checking the local model provider and its models…</p>'
    : state.readiness
      ? renderBody(state.readiness, state, extraCapabilities)
      : '<p class="muted">Setup check failed. Select "Re-check setup" to try again.</p>';
  const fallbackActions = !state.readiness ? `<div class="actions">${button('Re-check setup', 'recheck')}</div>` : '';
  const palette = state.paletteScriptUri
    ? `<link rel="stylesheet" href="${escapeHtml(state.paletteCssUri ?? '')}">\n<script nonce="${nonce}" src="${escapeHtml(state.paletteScriptUri)}"></script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};">
<title>KarkeDikha Setup</title>
<style nonce="${nonce}">${STYLE}</style>
${palette}
</head>
<body>
<div class="wrap">
${notice}
${body}
${fallbackActions}
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
