import React, { useEffect, useState } from 'react';
import { api, errorText, type AppMetadata, type HostTelemetry, type ImageStudioStatus, type Snapshot, type UpdateStatus } from './bridge';
import { AVAILABILITY, telemetryRows } from './Everyday';

/**
 * About & diagnostics: the build this app really is, Update & Restart, the diagnostics block to copy, this PC's
 * hardware, local models, speech, the image studio and what each tool can do now.
 */
export function buildLabel(meta: AppMetadata | null): string {
  if (!meta) return 'unknown';
  const n = Number(meta.buildNumber);
  return meta.buildKind === 'release' && Number.isInteger(n) && n > 0 ? `b${n}` : 'development build (no official build number)';
}

export function updateLine(status: UpdateStatus | null): string {
  if (!status) return '';
  if (!status.available) return 'Updates need the latest Pandesh installer, run once.';
  const last = status.lastResult;
  if (last && !last.acknowledged) {
    if (last.status === 'success') return `Updated to build b${last.revision}.`;
    if (last.status === 'rolled_back') return `The update to b${last.attemptedRevision} did not start correctly and was undone. You are on b${last.revision}. ${last.reason ?? ''}`.trim();
    if (last.status === 'aborted') return `Update not applied: ${last.reason || 'nothing was changed.'}`;
    return `The update failed and could not be undone automatically. Run the Pandesh installer to recover. ${last.reason ?? ''}`.trim();
  }
  return `Installed build b${status.installedRevision ?? '?'}.`;
}

export function About({ snapshot, refresh, narrow }: { snapshot: Snapshot | null; refresh: () => void; narrow: boolean }) {
  const [meta, setMeta] = useState<AppMetadata | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateNote, setUpdateNote] = useState('');
  const [updating, setUpdating] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  const [telemetry, setTelemetry] = useState<HostTelemetry | null>(null);
  const [studio, setStudio] = useState<ImageStudioStatus | null>(null);
  const [studioError, setStudioError] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    api.getAppMetadata().then((m) => alive && setMeta(m)).catch(() => undefined);
    api.getUpdateStatus().then((u) => alive && setUpdate(u)).catch(() => undefined);
    api.probeImageStudio().then((s) => alive && setStudio(s)).catch((err) => alive && setStudioError(errorText(err)));
    const read = () => api.getHostTelemetry().then((t) => alive && setTelemetry(t)).catch(() => undefined);
    void read();
    const t = setInterval(read, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const copyDiagnostics = async () => {
    setCopyNote('');
    try {
      const report = await api.getDiagnosticsReport();
      const r = api.copyToClipboard ? await api.copyToClipboard(String(report || '')) : { copied: false };
      setCopyNote(r.copied ? 'Copied. It holds build, platform and runtime state; no keys or messages.' : 'Could not copy to the clipboard.');
    } catch (err) { setCopyNote(`Could not copy: ${errorText(err)}`); }
  };
  const startUpdate = async () => {
    setUpdating(true);
    setUpdateNote('Checking the update…');
    let applying = false;
    try {
      void api.acknowledgeUpdateResult().catch(() => undefined);
      const r = await api.startUpdate();
      applying = r.status === 'applying';
      setUpdateNote(r.message);
    } catch (err) { setUpdateNote(`The update did not start: ${errorText(err)}`); } finally { setUpdating(applying); }
  };

  const speech = snapshot?.localSpeech as { capability?: string; engine?: string; blocker?: string } | undefined;
  const row = (k: string, v: React.ReactNode) => <div className="kv" key={k}><span className="k">{k}</span><span style={{ overflowWrap: 'anywhere' }}>{v}</span></div>;

  return (
    <>
      <div className="topbar"><span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>About &amp; diagnostics</span></div>
      <div className="board" style={{ display: 'grid', gap: 12, gridTemplateColumns: narrow ? '1fr' : 'repeat(auto-fill, minmax(380px, 1fr))', alignContent: 'start' }}>
        {note && <div className={`notice${note.error ? ' error' : ''}`} role={note.error ? 'alert' : 'status'} style={{ margin: 0, maxWidth: 'none', gridColumn: '1 / -1' }}>{note.text}</div>}
        <section className="card" aria-label="About Pandesh">
          <span className="title">About Pandesh</span>
          {row('Version', meta?.version ? `v${meta.version.replace(/^v/i, '')}` : 'unknown')}
          {row('Build', buildLabel(meta))}
          {row('Channel', meta?.releaseChannel ?? 'dev')}
          {row('Commit', meta?.commit ?? 'unknown')}
          {row('Built', meta?.builtAt ? new Date(meta.builtAt).toLocaleString() : 'unknown')}
          {row('Installer', meta?.installerVersion ?? 'unknown')}
          {row('Core', meta?.coreVersion ?? 'not running')}
          {meta?.coreVersionMismatch && <div className="notice error" role="alert" style={{ margin: 0 }}>The running Core reports a different version than this app. Restart Pandesh; if it stays, run the installer again.</div>}
          <div className="actions"><button type="button" className="btn small" onClick={() => void copyDiagnostics()}>Copy diagnostics</button></div>
          {copyNote && <span role="status" className="meta">{copyNote}</span>}
        </section>
        <section className="card" aria-label="Update">
          <span className="title">Update &amp; restart</span>
          <span style={{ fontSize: 14 }}>{updateLine(update)}</span>
          <span className="meta">You choose a Pandesh update package on this PC. It is verified, Core is stopped safely, and the update is undone automatically if the new build does not start.</span>
          <div className="actions"><button type="button" className="btn small" disabled={!update?.available || updating} onClick={() => void startUpdate()}>Update &amp; restart…</button></div>
          {updateNote && <span role="status" style={{ fontSize: 14 }}>{updateNote}</span>}
        </section>
        <section className="card" aria-label="This PC">
          <span className="title">This PC</span>
          {telemetryRows(telemetry).map(([k, v]) => row(k, v))}
          {telemetry?.repository?.available && row('Workspace git', `${telemetry.repository.branch ?? 'no branch'}${telemetry.repository.dirty ? ` · ${telemetry.repository.changedFileCount ?? 'some'} changed files` : ' · clean'}`)}
        </section>
        <section className="card" aria-label="Local models">
          <span className="title">Local models (Ollama)</span>
          {row('Model now', snapshot?.modelIsAuto ? `Auto${snapshot.model ? ` (last: ${snapshot.model})` : ''}` : (snapshot?.model ?? 'not chosen'))}
          {row('Model server', snapshot?.modelServerReachable === false ? 'Not answering' : snapshot?.modelServerReachable ? 'Answering' : 'Unknown')}
          {row('Installed', snapshot?.installedModels?.length ? snapshot.installedModels.join(', ') : 'none found')}
          {row('Routing', snapshot?.routingPolicy ?? 'local-only')}
          <span className="meta">Choose the model for a chat in the model menu under the message box.</span>
        </section>
        <section className="card" aria-label="Voice and speech">
          <span className="title">Voice &amp; speech</span>
          {row('Recognition', speech?.capability === 'available' ? `Ready on this PC${speech.engine ? ` (${speech.engine})` : ''}` : (speech?.blocker ?? 'Not available'))}
          {row('Wake word', snapshot?.wakeWord ? (snapshot.wakeWord.capability !== 'available' ? (snapshot.wakeWord.blocker ?? 'Not available') : `${snapshot.wakeWord.phrase ?? 'Hey Jarvis'} · ${snapshot.wakeWord.enabled ? (snapshot.wakeWord.muted ? 'on, muted' : 'on') : 'off'}`) : 'Unknown')}
          {row('Speak replies', snapshot?.voiceMode ? 'On' : 'Off')}
          <span className="meta">Turn these on or off in the route menu under the message box.</span>
        </section>
        <section className="card" aria-label="Image Studio">
          <span className="title">Image Studio (local ComfyUI)</span>
          {studio ? (
            <>
              {row('Studio', studio.studio ? 'Running' : 'Not running')}
              {row('ComfyUI', studio.comfyui ? 'Answering' : 'Not answering')}
              {row('Models', studio.checkpoints?.length ? studio.checkpoints.map((c) => c.name).join(', ') : 'None detected')}
              {studio.detail && <span className="meta">{studio.detail}</span>}
            </>
          ) : <span className="meta">{studioError || 'Checking…'}</span>}
          <div className="actions"><button type="button" className="btn small" onClick={() => void api.openExternalUrl('http://127.0.0.1:8989/').catch((err) => setNote({ text: errorText(err), error: true }))}>Open the Studio web page</button></div>
        </section>
        <section className="card" aria-label="What each tool can do">
          <span className="title">What each tool can do now</span>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(snapshot?.everydayTools?.catalog ?? []).map((e) => (
              <li key={e.id} style={{ display: 'flex', gap: 10, fontSize: 14 }} title={e.detail}>
                <span style={{ flex: '1 1 auto' }}>{e.label ?? e.id}</span>
                <span style={{ color: e.availability === 'available' ? 'var(--verified)' : 'var(--muted)' }}>{AVAILABILITY[e.availability ?? ''] ?? e.availability}</span>
              </li>
            ))}
          </ul>
          <span className="meta">{snapshot?.everydayTools?.alertsWhileClosed ? 'Reminders also alert while Pandesh is closed.' : (snapshot?.everydayTools?.alertsWhileClosedDetail || 'Reminders alert only while Pandesh is open.')}</span>
          <div className="actions"><button type="button" className="btn small" onClick={() => void api.refreshEverydayTools().then(refresh).catch((err) => setNote({ text: errorText(err), error: true }))}>Check again</button></div>
        </section>
      </div>
    </>
  );
}
