import React, { useCallback, useEffect, useState } from 'react';
import { api, errorText, type ChatgptConnectorView } from './bridge';

/**
 * Connections → ChatGPT: let ChatGPT give Pandesh tasks through OpenAI's Secure MCP Tunnel.
 * Off by default. The OpenAI tunnel key goes in once and is kept in Windows Credential Manager; it never comes back out
 * (only a masked hint). ChatGPT is paired with a one-time code shown here, and "Disconnect" revokes every ChatGPT pairing.
 */

const STATE: Record<ChatgptConnectorView['state'], { text: string; tone: string }> = {
  off: { text: 'Off', tone: 'var(--muted)' },
  'needs-setup': { text: 'Needs setup', tone: 'var(--attention)' },
  'needs-key': { text: 'Needs the tunnel key', tone: 'var(--attention)' },
  starting: { text: 'Starting', tone: 'var(--attention)' },
  running: { text: 'Running', tone: 'var(--verified)' },
  degraded: { text: 'Restarting a part', tone: 'var(--attention)' },
  failed: { text: 'Not running', tone: 'var(--danger)' },
};

export function ChatgptConnectorCard() {
  const supported = typeof api?.getChatgptConnector === 'function';
  const [view, setView] = useState<ChatgptConnectorView | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [setup, setSetup] = useState<{ tunnelId: string; clientPath: string; gatewayPath: string } | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    if (typeof api?.getChatgptConnector !== 'function') return Promise.resolve();
    return api.getChatgptConnector().then(setView).catch((err) => setNote({ text: errorText(err), error: true }));
  }, []);
  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 4000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);
  useEffect(() => { if (view && !setup) setSetup({ tunnelId: view.tunnelId, clientPath: view.clientPath, gatewayPath: view.gatewayPath }); }, [view, setup]);

  const run = async (kind: string, work: () => Promise<ChatgptConnectorView>, done?: string) => {
    setBusy(kind); setNote(null);
    try { setView(await work()); if (done) setNote({ text: done }); } catch (err) { setNote({ text: errorText(err), error: true }); } finally { setBusy(null); }
  };

  if (!supported) return null;
  if (!view || !setup) return <section className="card" aria-label="ChatGPT"><span className="title" style={{ fontSize: 16 }}>ChatGPT</span><span style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</span></section>;

  const st = STATE[view.state];
  const secondsLeft = code ? Math.round((Date.parse(code.expiresAt) - now) / 1000) : 0;
  const codeLive = code && secondsLeft > 0;
  const setupDirty = setup.tunnelId !== view.tunnelId || setup.clientPath !== view.clientPath || setup.gatewayPath !== view.gatewayPath;
  const field = (label: string, value: string, onChange: (v: string) => void, placeholder: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 14 }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" style={{ font: 'inherit', padding: '6px 8px' }} />
    </label>
  );

  return (
    <section className="card" aria-label="ChatGPT" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="title" style={{ fontSize: 16 }}>ChatGPT</span>
        <span className="meta" role="status" style={{ color: st.tone, fontWeight: 500 }}>{st.text}</span>
      </div>
      <span style={{ fontSize: 14, color: 'var(--muted)' }}>
        Lets ChatGPT give Pandesh tasks, follow them and read their reports through OpenAI's private tunnel (outbound only; nothing on this PC is opened to the internet). Tasks that use a cloud agent still ask you here first. Off unless you switch it on.
      </span>
      <span style={{ fontSize: 14 }}>{view.detail}</span>

      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '4px 12px', margin: 0, fontSize: 14 }}>
        <dt>Pandesh Core</dt>
        <dd style={{ margin: 0 }}><span style={{ color: view.core.reachable ? 'var(--verified)' : 'var(--danger)', fontWeight: 500 }}>{view.core.reachable ? 'Answering' : 'Not answering'}</span><span style={{ color: 'var(--muted)' }}> · {view.core.build ?? 'this Pandesh'}{view.core.port ? ` · port ${view.core.port}` : ''} · {view.core.production ? 'your real Pandesh' : 'TEST COPY'}</span></dd>
        <dt>Tunnel</dt>
        <dd style={{ margin: 0, color: 'var(--muted)' }}>{view.tunnelReachable ? 'Connected to OpenAI' : 'Not connected'}</dd>
        <dt>Last problem</dt>
        <dd style={{ margin: 0, color: 'var(--muted)' }}>{view.lastFailure ? `${new Date(view.lastFailure.at).toLocaleString()} · ${view.lastFailure.message}` : 'None'}</dd>
      </dl>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn small" disabled={Boolean(busy) || view.enabled} onClick={() => void run('start', () => api.setChatgptConnectorEnabled(true), 'Starting…')}>Start</button>
        <button type="button" className="btn small" disabled={Boolean(busy) || !view.enabled} onClick={() => void run('stop', () => api.setChatgptConnectorEnabled(false), 'Stopped. ChatGPT can no longer reach Pandesh.')}>Stop</button>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{view.enabled ? 'Starts again whenever Pandesh opens.' : 'Stays off until you press Start.'}</span>
      </div>

      <details open={view.state === 'needs-setup' || view.state === 'needs-key'} style={{ marginTop: 2 }}>
        <summary style={{ fontWeight: 500, cursor: 'pointer' }}>Setup</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {field('Tunnel id', setup.tunnelId, (v) => setSetup({ ...setup, tunnelId: v }), 'tunnel_…')}
          {field('tunnel-client.exe', setup.clientPath, (v) => setSetup({ ...setup, clientPath: v }), 'D:\\PandeshTunnel\\client\\tunnel-client.exe')}
          {view.gatewaySource === 'packaged-verified'
            ? <span style={{ fontSize: 14 }}><strong>Gateway</strong><span style={{ color: 'var(--verified)' }}> · included in this Pandesh and verified against its release manifest</span></span>
            : view.gatewaySource === 'tampered'
              ? <span role="alert" style={{ fontSize: 14, color: 'var(--danger)' }}>The gateway inside this Pandesh failed its integrity check and will not run. Reinstall Pandesh.</span>
              : field('MCP gateway script (development only, not verified)', setup.gatewayPath, (v) => setSetup({ ...setup, gatewayPath: v }), 'D:\\Projects\\Pandesh\\apps\\panda-bridge\\mcp-gateway\\server.mjs')}
          <div><button type="button" className="btn small" disabled={Boolean(busy) || !setupDirty} onClick={() => void run('setup', () => api.setChatgptConnectorSetup(setup), 'Setup saved.')}>Save setup</button></div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 14 }}>
            <span style={{ fontWeight: 500 }}>OpenAI tunnel key{view.keyConfigured ? ` · stored (${view.keyHint ?? '••••'})` : ''}</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={view.keyConfigured ? 'Paste a new key to replace it' : 'Paste the restricted key (Tunnels: Read + Use)'} autoComplete="off" spellCheck={false} style={{ font: 'inherit', padding: '6px 8px' }} />
          </label>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>Kept in Windows Credential Manager for this Windows user. Pandesh never shows it again and never writes it to a file or log. Use a restricted key that can only use this tunnel.</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn small" disabled={Boolean(busy) || key.trim().length < 20} onClick={() => { const k = key; setKey(''); void run('key', () => api.setChatgptConnectorKey(k), 'Key stored.'); }}>Store key</button>
            {view.keyConfigured && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('clear', () => api.clearChatgptConnectorKey(), 'Key removed and the connector switched off.')}>Remove key</button>}
          </div>
        </div>
      </details>

      {view.state === 'running' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>Connect ChatGPT</span>
          <span style={{ fontSize: 14, color: 'var(--muted)' }}>In ChatGPT, add the Pandesh connector. When its sign-in page asks for a code, create one here and type it there. It works once and expires in 5 minutes.</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn small" disabled={Boolean(busy)} onClick={async () => { setBusy('code'); setNote(null); try { setCode(await api.chatgptConnectorPairingCode()); } catch (err) { setNote({ text: errorText(err), error: true }); } finally { setBusy(null); } }}>New pairing code</button>
            {codeLive && <code style={{ fontFamily: 'var(--font-mono)', fontSize: 22, letterSpacing: 2 }} aria-label="Pairing code">{code!.code}</code>}
            {codeLive && <span style={{ fontSize: 13, color: 'var(--muted)' }}>expires in {secondsLeft >= 60 ? `${Math.ceil(secondsLeft / 60)} min` : `${secondsLeft} s`}</span>}
          </div>
        </div>
      )}

      {view.recentLog.length > 0 && (
        <details><summary style={{ cursor: 'pointer', fontSize: 14 }}>Recent log</summary>
          <pre style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{view.recentLog.join('\n')}</pre>
        </details>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn small" disabled={Boolean(busy) || !view.enabled && view.activePairings === 0} onClick={async () => {
          setBusy('disconnect'); setNote(null); setCode(null);
          try { const r = await api.disconnectChatgptConnector(); setView(r.view); setNote({ text: `Disconnected. ${r.revoked} ChatGPT pairing(s) revoked${r.errors ? `, ${r.errors} could not be revoked (Pandesh Core was not reachable)` : ''}; the connector is off.`, error: r.errors > 0 }); } catch (err) { setNote({ text: errorText(err), error: true }); } finally { setBusy(null); }
        }}>Disconnect ChatGPT</button>
        <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void load()}>Check again</button>
      </div>

      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, minHeight: 1, color: note?.error ? 'var(--danger)' : 'var(--verified)' }}>{note?.text ?? ''}</p>
    </section>
  );
}
