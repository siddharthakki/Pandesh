import React, { useEffect, useState } from 'react';
import { api, errorText, type AppMetadata, type Snapshot, type UpdateStatus } from './bridge';
import { useComposerControls } from './ComposerControls';
import { AUTO_MODEL, PERMISSION_LABELS, cloudAvailability, cloudChoices, modelLabel } from './composerModel';
import {
  CLOUD_BOUNDARY_NOTE, SETTINGS_SECTIONS, capabilityWords, cloudSelectionLabel, updateStatusText, usingCloud, type SettingsSection, type Tone,
} from './settingsModel';

const TONE: Record<Tone, string> = { ok: 'var(--verified)', warn: 'var(--attention)', danger: 'var(--danger)', plain: 'var(--muted)' };
type Notice = { text: string; error?: boolean } | null;
type GoTarget = 'connections' | 'tools' | 'software';

interface Props {
  snapshot: Snapshot | null;
  refresh: () => void;
  narrow: boolean;
  initialSection?: SettingsSection;
  theme: string;
  setTheme: (t: 'system' | 'light' | 'dark') => void;
  labels: boolean;
  setLabels: (on: boolean) => void;
  variantForced: boolean;
  onUseClassic: () => void;
  onGo: (view: GoTarget) => void;
}

/**
 * Settings: the places a person changes how Pandesh behaves, behind one System entry. Every control calls an existing
 * host function (selectModel, setPermissionMode, getDiagnosticsReport, startUpdate, ...) and shows what the host
 * reports afterwards. Secrets are not handled here: provider keys and Google sign-in stay in Connections, which keeps
 * them in write-only password fields backed by encrypted storage.
 */
export function Settings({ snapshot, refresh, narrow, initialSection, theme, setTheme, labels, setLabels, variantForced, onUseClassic, onGo }: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'models');
  useEffect(() => { if (initialSection) setSection(initialSection); }, [initialSection]);
  const [notice, setNotice] = useState<Notice>(null);
  const controls = useComposerControls({ snapshot, refresh, onNotice: setNotice, disabled: !snapshot || snapshot.coreState !== 'connected' });

  const nav = (
    <nav className="settings-nav" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map((s) => (
        <button key={s.id} type="button" className="menu-item" aria-current={section === s.id ? 'page' : undefined} onClick={() => { setSection(s.id); setNotice(null); }}>
          <span>{s.label}</span>{!narrow && <span className="sub">{s.hint}</span>}
        </button>
      ))}
    </nav>
  );

  return (
    <>
      <div className="topbar"><span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Settings</span></div>
      <div className={`settings${narrow ? ' narrow' : ''}`} data-section={section}>
        {nav}
        <div className="settings-body">
          {notice && <div className={`notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
          {section === 'models' && <ModelsSection snapshot={snapshot} refresh={refresh} modelControl={controls.modelControl} cloudConfirm={controls.cloudConfirm} chooseModel={controls.chooseModel} pendingCloud={controls.pendingCloud} setNotice={setNotice} onGo={onGo} />}
          {section === 'permissions' && (
            <section className="card" aria-label="Permissions">
              <span className="title" style={{ fontSize: 16 }}>What Pandesh may do without asking</span>
              <p className="settings-note">This applies to the conversation you are in (or the next one you start). Core enforces it; nothing here weakens an approval.</p>
              <div className="settings-row">{controls.modeControl}</div>
              <ul className="settings-modes">
                <li><strong>{PERMISSION_LABELS.ask}.</strong> Pandesh asks before it changes files, runs commands or goes online.</li>
                <li><strong>{PERMISSION_LABELS.auto}.</strong> Only the things you tick, for 1, 8 or 24 hours, in the chosen folder. Email, purchases, installs, git push and anything destructive still ask.</li>
                <li><strong>{PERMISSION_LABELS.plan}.</strong> Pandesh researches and plans. Nothing is created, changed, sent or run.</li>
              </ul>
              {controls.panel}
            </section>
          )}
          {section === 'diagnostics' && <DiagnosticsSection snapshot={snapshot} refresh={refresh} setNotice={setNotice} onGo={onGo} />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'appearance' && (
            <section className="card" aria-label="Appearance">
              <span className="title" style={{ fontSize: 16 }}>Appearance</span>
              <fieldset className="settings-fieldset">
                <legend>Theme</legend>
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <label key={t}><input type="radio" name="v2-theme" checked={theme === t} onChange={() => setTheme(t)} /> {t === 'system' ? 'Follow Windows' : t === 'light' ? 'Light' : 'Dark'}</label>
                ))}
              </fieldset>
              <label className="settings-check"><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Show names next to the navigation icons</label>
              <div>
                <span className="settings-sub">Interface</span>
                {variantForced
                  ? <p className="settings-note">The Classic interface is locked off for this launch (PANDESH_UI_V2=1). Start without it to switch.</p>
                  : <p className="settings-note">You are using the v2 interface. <button type="button" className="btn small" onClick={onUseClassic}>Reload in the Classic UI</button></p>}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function ModelsSection({ snapshot, refresh, modelControl, cloudConfirm, chooseModel, pendingCloud, setNotice, onGo }: { snapshot: Snapshot | null; refresh: () => void; modelControl: React.ReactNode; cloudConfirm: React.ReactNode; chooseModel: (value: string) => void; pendingCloud: string | null; setNotice: (n: Notice) => void; onGo: (v: GoTarget) => void }) {
  const [saving, setSaving] = useState(false);
  const cloud = usingCloud(snapshot);
  const choices = cloudChoices(snapshot);
  const running = Boolean(snapshot?.running);
  const pick = async (value: string) => {
    setSaving(true); setNotice(null);
    try {
      await api.selectModel(value);
      setNotice({ text: value === AUTO_MODEL ? 'Back on this PC: Auto picks a local model for each message.' : 'Selected. The next chat runs entirely on that cloud model.' });
    } catch (err) { setNotice({ text: errorText(err), error: true }); } finally { setSaving(false); refresh(); }
  };
  const enabled = (snapshot?.cloud?.providers ?? []).filter((p) => p.enabled && p.configured);
  const availability = cloudAvailability(snapshot);
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true); setNotice(null);
    try {
      for (const p of enabled) await api.testProviderKey(p.id);
      setNotice({ text: 'Free model lists checked.' });
    } catch (err) { setNotice({ text: errorText(err), error: true }); } finally { setChecking(false); refresh(); }
  };
  return (
    <>
      <section className="card" aria-label="Where answers come from">
        <span className="title" style={{ fontSize: 16 }}>Where answers come from</span>
        <dl className="settings-kv">
          <dt>Provider</dt><dd>{cloud ? 'Free cloud' : 'This PC Â· Ollama'}</dd>
          <dt>Model</dt><dd>{cloud ? cloudSelectionLabel(snapshot) : modelLabel(snapshot)}</dd>
          <dt>Model server</dt><dd>{cloud ? 'Not used while a cloud model is chosen' : snapshot?.modelServerReachable === false ? 'Not answering' : snapshot?.modelServerReachable ? 'Answering' : 'Unknown'}</dd>
          <dt>Context</dt><dd>{snapshot?.contextEnvelope ? `${Math.round(snapshot.contextEnvelope / 1024)}K tokens` : 'Not reported'}</dd>
        </dl>
        {snapshot?.modelNote && <p className="settings-note">{snapshot.modelNote}</p>}
      </section>

      <section className="card" aria-label="Local model">
        <span className="title" style={{ fontSize: 16 }}>This PC</span>
        <p className="settings-note">Auto lets Pandesh pick an installed model for each message. Pick one to always use it.</p>
        <div className="settings-row">{modelControl}</div>
        {cloud && <div><button type="button" className="btn small" disabled={saving || running} onClick={() => void pick(AUTO_MODEL)}>Stop using the cloud model</button></div>}
      </section>

      <section className="card" aria-label="Free cloud models">
        <span className="title" style={{ fontSize: 16 }}>Free cloud models</span>
        <p className="settings-note">Off until you add a provider key. Nothing is sent to a cloud model until you pick one and confirm. {CLOUD_BOUNDARY_NOTE}</p>
        {availability.length > 0 && (
          <ul className="settings-availability" aria-label="Cloud provider availability">
            {availability.map((a) => <li key={a.id} data-state={a.state}><strong>{a.name}</strong>: {a.text}</li>)}
          </ul>
        )}
        <div className="settings-row">
          {enabled.length > 0 && <button type="button" className="btn small" disabled={checking || saving} onClick={() => void checkNow()}>{checking ? 'Checkingâ€¦' : 'Check free models now'}</button>}
          <button type="button" className="btn small" onClick={() => onGo('connections')}>Open Connections</button>
        </div>
        {cloudConfirm}
        {choices.length === 0 ? (
          <p className="settings-note" role="status">{enabled.length === 0 ? 'No provider is set up yet.' : 'No verified free model is listed yet.'}</p>
        ) : (
          <fieldset className="settings-fieldset" disabled={saving || running}>
            <legend className="sr-only">Free cloud model</legend>
            {choices.map((c) => (
              <label key={c.value} className="settings-choice">
                <input type="radio" name="v2-cloud-model" checked={(pendingCloud ?? snapshot?.cloud?.selectedModel) === c.value} onChange={() => chooseModel(c.value)} />
                <span><strong>{c.label}</strong> Â· {c.providerName}<br /><span className="settings-sub">{capabilityWords('Vision', c.vision)} Â· {capabilityWords('Tools', c.tools)}</span></span>
              </label>
            ))}
          </fieldset>
        )}
        {running && <p className="settings-note">A task is running. Change the model when it ends.</p>}
      </section>
    </>
  );
}

function DiagnosticsSection({ snapshot, refresh, setNotice, onGo }: { snapshot: Snapshot | null; refresh: () => void; setNotice: (n: Notice) => void; onGo: (v: GoTarget) => void }) {
  const [meta, setMeta] = useState<AppMetadata | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getAppMetadata().then(setMeta).catch(() => setMeta(null)); }, []);
  const load = async () => {
    setBusy(true); setNotice(null);
    try { setReport(await api.getDiagnosticsReport()); } catch (err) { setNotice({ text: errorText(err), error: true }); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!report) return;
    try {
      if (typeof api.copyToClipboard !== 'function') throw new Error('This build cannot copy from the window. Select the text and press Ctrl+C.');
      const r = await api.copyToClipboard(report);
      setNotice(r?.copied ? { text: 'Report copied. It contains no passwords or keys.' } : { text: 'Nothing was copied.', error: true });
    } catch (err) { setNotice({ text: errorText(err), error: true }); }
  };
  const core = snapshot?.coreState ?? 'unknown';
  const coreOk = core === 'connected' || core === 'ready';
  return (
    <>
      <section className="card" aria-label="Health">
        <span className="title" style={{ fontSize: 16 }}>Health</span>
        <dl className="settings-kv">
          <dt>Core</dt><dd style={{ color: coreOk ? 'var(--verified)' : 'var(--danger)' }}>{coreOk ? 'Connected' : core}{snapshot?.coreDetail ? ` â€” ${snapshot.coreDetail}` : ''}</dd>
          <dt>Model server</dt><dd>{snapshot?.modelServerReachable === false ? 'Not answering' : snapshot?.modelServerReachable ? 'Answering' : 'Unknown'}</dd>
          <dt>Build</dt><dd>{meta ? `${meta.productName} ${meta.version}${meta.buildNumber ? ` Â· build b${meta.buildNumber}` : ''} Â· ${meta.buildKind}${meta.commit ? ` Â· ${meta.commit.slice(0, 8)}` : ''}` : 'Not reported'}</dd>
          <dt>Core version</dt><dd>{meta?.coreVersion ?? 'Not reported'}{meta?.coreVersionMismatch ? ' â€” differs from this window' : ''}</dd>
        </dl>
        {!coreOk && <div><button type="button" className="btn small" onClick={() => void api.retryCoreConnection().then(refresh).catch((err) => setNotice({ text: errorText(err), error: true }))}>Reconnect to Core</button></div>}
      </section>
      <section className="card" aria-label="Diagnostics report">
        <span className="title" style={{ fontSize: 16 }}>Report</span>
        <p className="settings-note">Build, platform and runtime state in one block you can paste into a bug report. The host leaves out passwords and keys.</p>
        <div className="actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => void load()}>{report ? 'Refresh report' : 'Show report'}</button>
          {report && <button type="button" className="btn small" onClick={() => void copy()}>Copy report</button>}
          <button type="button" className="btn small" onClick={() => onGo('software')}>Ports and installed tools</button>
        </div>
        {report && <pre className="settings-report" tabIndex={0} aria-label="Diagnostics report text">{report}</pre>}
      </section>
    </>
  );
}

function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.getUpdateStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void load(); }, []);
  const start = async () => {
    setBusy(true); setMsg('Checking the updateâ€¦');
    try {
      void api.acknowledgeUpdateResult?.();
      const r = await api.startUpdate();
      setMsg(r.message);
    } catch (err) { setMsg(`The update did not start: ${errorText(err)}`); } finally { setBusy(false); void load(); }
  };
  const t = updateStatusText(status);
  return (
    <section className="card" aria-label="Updates">
      <span className="title" style={{ fontSize: 16 }}>Updates</span>
      <p className="settings-note" role="status" style={{ color: TONE[t.tone] }}>{t.text}</p>
      <p className="settings-note">Pandesh does not download updates by itself. Choose an update package (.pdupdate) from your PC. It is checked first, Pandesh finishes safe work, installs it and restarts; if the new build does not start, the old one is restored.</p>
      <div className="actions"><button type="button" className="btn primary small" disabled={busy || !status?.available} onClick={() => void start()}>Choose an update packageâ€¦</button></div>
      {msg && <p className="settings-note" role="status">{msg}</p>}
    </section>
  );
}
