import React, { useRef, useState } from 'react';
import { api, errorText, type Snapshot } from './bridge';
import { NOT_CONNECTED, SETUP_STEPS, STATE_LABEL, googleActions, googleState, serviceRows, type Busy, type Tone } from './googleModel';
import { PhoneCard } from './Phone';
import { FreeModelsCard } from './FreeModels';

const TONE: Record<Tone, string> = { ok: 'var(--verified)', busy: 'var(--pulse)', warn: 'var(--attention)', neutral: 'var(--muted)' };

/**
 * Connections: pair a phone (Pandesh Mobile, Phone.tsx), and set up and connect Google (Gmail, Calendar) from v2,
 * through the same host calls as the Classic Google card. The OAuth client is imported from its JSON file or pasted
 * here and goes into encrypted storage on this PC.
 */
export function Connections({ snapshot, refresh }: { snapshot: Snapshot | null; refresh: () => void }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState('');
  const [clientNote, setClientNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const idInput = useRef<HTMLInputElement | null>(null);
  const setupRef = useRef<HTMLDetailsElement | null>(null);

  const g = snapshot?.gmail ?? NOT_CONNECTED;
  const state = googleState(g, busy);
  const cal = (snapshot?.everydayTools?.catalog ?? []).find((c) => c.id === 'calendar');
  const rows = serviceRows(g, state, Boolean(cal && cal.connectorState === 'connected' && cal.availability === 'available'), busy);
  const can = googleActions(g, state);
  const blocked = Boolean(busy) || state === 'connecting';

  const run = async (kind: Busy, work: () => Promise<unknown>) => {
    setBusy(kind);
    try { await work(); } catch (err) { setNote(errorText(err)); } finally { setBusy(null); refresh(); }
  };
  const open = (url: string) => { void api.openExternalUrl(url).catch((err) => setNote(errorText(err))); };

  const connect = () => {
    if (!g.clientSource) {
      if (setupRef.current) setupRef.current.open = true;
      setNote('Add your OAuth Client ID first; the steps are just below.');
      idInput.current?.focus();
      return;
    }
    setNote('');
    void run('connecting', () => api.connectGmail());
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setClientNote(null);
    void run('saving', async () => {
      try {
        await api.saveGoogleOAuthClient(clientId, secret);
        setClientId(''); setSecret('');
        setClientNote({ text: 'Saved (encrypted). Now press Connect Google.' });
      } catch (err) { setClientNote({ text: errorText(err), error: true }); }
    });
  };
  const importFile = () => {
    setClientNote(null);
    void run('saving', async () => {
      try {
        const r = await api.importGoogleOAuthClientFile();
        if (!r?.cancelled) setClientNote({ text: 'Imported (encrypted). Now press Connect Google.' });
      } catch (err) { setClientNote({ text: errorText(err), error: true }); }
    });
  };

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Connections</span>
        <span className="grow" />
        <button type="button" className="btn small" disabled={blocked} onClick={() => void run('checking', () => api.retryGmailProbe())}>Check again</button>
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}>
        <PhoneCard />
        <FreeModelsCard />
        <section className="card" aria-label="Google">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="title" style={{ fontSize: 16 }}>Google</span>
            <span className="meta" role="status" data-state={state}>{STATE_LABEL[state]}</span>
          </div>
          <span style={{ fontSize: 14, color: 'var(--muted)' }}>Let Pandesh read and draft email in your own Gmail and read your calendar. Nothing is connected until Google confirms it, and every send or change still asks you.</span>
          <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '8px 12px', margin: '6px 0 0' }}>
            {rows.map((r) => (
              <React.Fragment key={r.id}>
                <dt style={{ fontSize: 14 }}>{r.label}</dt>
                <dd style={{ margin: 0, fontSize: 14 }}><span style={{ color: TONE[r.tone], fontWeight: 500 }}>{r.chip}</span><span style={{ color: 'var(--muted)' }}> · {r.detail}</span></dd>
              </React.Fragment>
            ))}
          </dl>
          {g.recovery && state !== 'connecting' && state !== 'connected' && (
            <div className="notice error" role="alert" style={{ margin: '6px 0 0' }}>
              <strong>{g.recovery.title}</strong>
              <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>{g.recovery.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              {g.recovery.link && <button type="button" className="btn link" onClick={() => open(g.recovery!.link!.url)}>{g.recovery.link.label}</button>}
            </div>
          )}
          <div className="actions">
            {can.connect && <button type="button" className="btn primary small" disabled={blocked} onClick={connect}>{can.connectLabel}</button>}
            {can.cancel && <button type="button" className="btn small" onClick={() => void api.cancelGoogleConnect().catch((err) => setNote(errorText(err)))}>Cancel sign-in</button>}
            {can.allowOrganize && <button type="button" className="btn small" disabled={blocked} onClick={() => { setNote('Approve the inbox organization permission in your browser.'); void run('connecting', () => api.allowInboxOrganization()); }}>Allow inbox organization</button>}
            {can.disconnect && <button type="button" className="btn small" disabled={blocked} onClick={() => { setNote(''); void run('checking', () => api.disconnectGmail()); }}>{can.disconnectLabel}</button>}
          </div>
          <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, minHeight: 1 }}>{note || (state === 'setup' ? 'Add your OAuth Client ID first.' : g.helperStaged === false && state !== 'connected' ? "Google helper (gws) not found: Gmail checks will fail until it's installed." : '')}</p>
        </section>

        {can.showSetup && (
          <details ref={setupRef} className="card" open={state === 'setup' || (state === 'problem-disconnected' && g.recovery?.code === 'invalid_client')}>
            <summary style={{ fontWeight: 500, cursor: 'pointer' }}>One-time setup: your Google OAuth client</summary>
            <p style={{ margin: '6px 0', fontSize: 14, color: 'var(--muted)' }}>Google requires every app to sign in with an OAuth client. Yours stays on this PC; Pandesh sends it only to Google.</p>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
              {SETUP_STEPS.map((s) => (
                <li key={s.text}>{s.text} {s.links.map((l) => <button key={l.url} type="button" className="btn link" style={{ marginRight: 8 }} onClick={() => open(l.url)}>{l.label}</button>)}</li>
              ))}
            </ol>
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn small" disabled={!can.clientEditable || busy === 'saving'} onClick={importFile}>Import the downloaded JSON file…</button>
              {can.removeSavedClient && <button type="button" className="btn small" disabled={busy === 'saving'} onClick={() => void run('saving', async () => { await api.clearGoogleOAuthClient(); setClientNote({ text: 'Saved client removed.' }); })}>Remove saved client</button>}
            </div>
            <form aria-label="Google OAuth client" onSubmit={save} autoComplete="off" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>Client ID
                <input ref={idInput} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!can.clientEditable} spellCheck={false} autoComplete="off"
                  placeholder={g.clientSource === 'environment' ? `Using the client from your environment (${g.clientHint ?? 'set'})` : g.clientSource === 'saved' ? `Saved: ${g.clientHint ?? 'client'}; paste a new Client ID to replace it` : '1234567890-abcdefg.apps.googleusercontent.com'}
                  style={{ height: 36, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>Client secret (optional)
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={!can.clientEditable} spellCheck={false} autoComplete="off"
                  style={{ height: 36, padding: '0 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)' }} />
              </label>
              <div className="actions"><button type="submit" className="btn small" disabled={!can.clientEditable || busy === 'saving' || !clientId.trim()}>Save</button></div>
              {clientNote && <p role={clientNote.error ? 'alert' : 'status'} style={{ margin: 0, fontSize: 14, color: clientNote.error ? 'var(--danger)' : 'var(--verified)' }}>{clientNote.text}</p>}
            </form>
          </details>
        )}
      </div>
    </>
  );
}
