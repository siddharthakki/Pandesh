import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText, type MobileAccess, type MobileDevice, type MobilePairing } from './bridge';
import { encodeQr, qrSvgPath } from './qr';

/**
 * Connections → Phone: pair a phone with Pandesh Mobile and decide who can reach it.
 * The QR code carries the pairing link (one-time code inside). The secure link is the Tailscale HTTPS address that
 * `tailscale serve` provides; Pandesh only reads Tailscale's settings, the owner sets Tailscale up.
 */

const ACCESS: Array<{ id: MobileAccess; label: string; hint: string }> = [
  { id: 'off', label: 'Off', hint: 'No phone can reach Pandesh.' },
  { id: 'lan', label: 'Home Wi-Fi and Tailscale', hint: 'Phones on this Wi-Fi (plain http: no voice, no install) and phones on Tailscale.' },
  { id: 'tailscale', label: 'Tailscale only', hint: 'Pandesh listens on this PC alone (127.0.0.1); only the Tailscale link reaches it.' },
];

const SECURE_LABEL: Record<MobilePairing['secure']['state'], { text: string; tone: string }> = {
  ready: { text: 'Ready', tone: 'var(--verified)' },
  'not-installed': { text: 'Not set up', tone: 'var(--muted)' },
  'not-running': { text: 'Tailscale is off', tone: 'var(--attention)' },
  'not-serving': { text: 'Not served yet', tone: 'var(--attention)' },
  funnel: { text: 'Public: turn Funnel off', tone: 'var(--danger)' },
  error: { text: 'Could not check', tone: 'var(--attention)' },
  unchecked: { text: 'Not checked', tone: 'var(--muted)' },
};

function since(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function expiresIn(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'Expired; a new code is on its way.';
  return s >= 60 ? `Works once · expires in ${Math.ceil(s / 60)} min` : `Works once · expires in ${s} s`;
}

function QrCode({ text }: { text: string }) {
  const svg = useMemo(() => {
    try { return qrSvgPath(encodeQr(text, 'M')); } catch { return null; }
  }, [text]);
  if (!svg) return null;
  return (
    <svg role="img" aria-label="QR code with the pairing link. Scan it with the phone's camera." viewBox={`0 0 ${svg.viewBox} ${svg.viewBox}`}
      width={184} height={184} shapeRendering="crispEdges" style={{ background: '#fff', borderRadius: 10, flex: '0 0 auto' }}>
      <path d={svg.path} fill="#000" />
    </svg>
  );
}

function deviceLine(d: MobileDevice, now: number): string {
  const lastSeen = since(d.lastSeenAt ?? d.pairedAt, now);
  const seen = d.connected ? 'connected now' : lastSeen ? `last seen ${lastSeen}` : '';
  const paired = Number.isFinite(Date.parse(d.pairedAt)) ? `paired ${new Date(d.pairedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
  return [seen, paired].filter(Boolean).join(' · ');
}

export function PhoneCard() {
  const [view, setView] = useState<MobilePairing | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [linkKind, setLinkKind] = useState<'secure' | 'wifi'>('secure');
  const [now, setNow] = useState(() => Date.now());

  // A host without phone pairing (an older preload) shows no card rather than a broken one.
  const supported = typeof api?.getMobilePairing === 'function';
  const load = useCallback(() => {
    if (typeof api?.getMobilePairing !== 'function') return Promise.resolve();
    return api.getMobilePairing().then(setView).catch((err) => setNote({ text: errorText(err), error: true }));
  }, []);
  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 4000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const run = async (kind: string, work: () => Promise<MobilePairing>, done?: string) => {
    setBusy(kind);
    setNote(null);
    try {
      setView(await work());
      if (done) setNote({ text: done });
    } catch (err) {
      setNote({ text: errorText(err), error: true });
    } finally {
      setBusy(null);
    }
  };
  const copy = async (text: string, what: string) => {
    try {
      // Through the host: the app window allows pages only the microphone, so navigator.clipboard is refused there.
      if (typeof api?.copyToClipboard === 'function') await api.copyToClipboard(text);
      else await navigator.clipboard.writeText(text);
      setNote({ text: `${what} copied.` });
    } catch {
      setNote({ text: 'Could not copy. Select the text and copy it.', error: true });
    }
  };

  if (!supported) return null;
  if (!view) {
    return (
      <section className="card" aria-label="Phone">
        <span className="title" style={{ fontSize: 16 }}>Phone</span>
        <span className="meta" role="status">{note?.text ?? 'Checking…'}</span>
      </section>
    );
  }

  const off = view.access === 'off';
  const secureReady = view.secure.state === 'ready' && Boolean(view.secureUrl);
  const link = linkKind === 'secure' && secureReady ? view.secureUrl : view.url || (secureReady ? view.secureUrl : '');
  const showingSecure = Boolean(link) && link === view.secureUrl;
  const live = view.connectedClients;
  const status = off ? 'Off' : !view.listening ? 'Not running' : live > 0 ? `${live} phone${live === 1 ? '' : 's'} connected` : 'Ready to pair';
  const secure = SECURE_LABEL[view.secure.state] ?? SECURE_LABEL.unchecked;
  const serveCommand = `tailscale serve --bg http://127.0.0.1:${view.port}`;
  const setupOpen = !secureReady && !off;

  const changeAccess = (mode: MobileAccess) => {
    if (mode === view.access) return;
    if (mode === 'tailscale' && !secureReady && !window.confirm('Tailscale is not serving Pandesh yet, so no phone will be able to reach it until you finish the steps below. Switch to Tailscale only anyway?')) return;
    if (mode === 'off' && live > 0 && !window.confirm('Turn phone access off? Connected phones lose Pandesh until you turn it on again.')) return;
    void run('access', () => api.setMobileAccess(mode), mode === 'off' ? 'Phone access is off.' : mode === 'tailscale' ? 'Pandesh now listens only for the Tailscale link.' : 'Pandesh listens on the home network and for Tailscale.');
  };
  const forget = (d: MobileDevice | 'all') => {
    const question = d === 'all' ? 'Forget every paired phone? Each one needs a new code to use Pandesh again.' : `Forget ${d.name}? It needs a new code to use Pandesh again.`;
    if (!window.confirm(question)) return;
    void run('forget', () => api.forgetMobileDevice(d === 'all' ? 'all' : d.id), d === 'all' ? 'All phones forgotten.' : `${d.name} forgotten.`);
  };

  return (
    <section className="card" aria-label="Phone">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="title" style={{ fontSize: 16 }}>Phone</span>
        <span className="meta" role="status" data-state={off ? 'off' : view.listening ? 'on' : 'down'}>{status}</span>
      </div>
      <span style={{ fontSize: 14, color: 'var(--muted)' }}>
        Use Pandesh from your phone: chat, see what it is doing, and approve actions. Scan the code with the phone's camera, or open the link on the phone and type the code.
      </span>

      {!off && view.listening && view.code && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          {link ? <QrCode text={link} /> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 260px' }}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Pairing code</span>
            <strong aria-label={`Pairing code ${view.code.split('').join(' ')}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 600, letterSpacing: 3 }}>{view.code}</strong>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{expiresIn(view.codeExpiresAt, now)}</span>
            {secureReady && view.url && (
              <div role="radiogroup" aria-label="Which link the QR code holds" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" role="radio" aria-checked={showingSecure} className={`btn small${showingSecure ? ' primary' : ''}`} onClick={() => setLinkKind('secure')}>Secure link</button>
                <button type="button" role="radio" aria-checked={!showingSecure} className={`btn small${!showingSecure ? ' primary' : ''}`} onClick={() => setLinkKind('wifi')}>Home Wi-Fi link</button>
              </div>
            )}
            {link ? (
              <>
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, overflowWrap: 'anywhere', color: 'var(--muted)' }}>{link}</code>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>{showingSecure ? 'Secure link: works anywhere Tailscale is on, with voice and app install.' : 'Home Wi-Fi link: same Wi-Fi only, plain http (no voice, no install).'}</span>
              </>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--attention)' }}>No link yet: set up the secure link below.</span>
            )}
            <div className="actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('code', () => api.rotateMobilePairingCode(), 'New code ready.')}>New code</button>
              {link && <button type="button" className="btn small" onClick={() => { void copy(link, 'Link'); }}>Copy link</button>}
            </div>
          </div>
        </div>
      )}

      {view.pairingPausedUntil && (
        <div className="notice error" role="alert" style={{ margin: '6px 0 0', maxWidth: 'none' }}>
          Pairing is paused until {new Date(view.pairingPausedUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} after too many wrong codes.{' '}
          <button type="button" className="btn link" onClick={() => void run('resume', () => api.resumeMobilePairing(), 'Pairing allowed again.')}>Allow pairing again</button>
        </div>
      )}
      {view.secure.state === 'funnel' && (
        <div className="notice error" role="alert" style={{ margin: '6px 0 0', maxWidth: 'none' }}>{view.secure.detail}</div>
      )}

      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', gap: '8px 12px', margin: '8px 0 0', fontSize: 14 }}>
        <dt>Secure link</dt>
        <dd style={{ margin: 0 }}><span style={{ color: secure.tone, fontWeight: 500 }}>{secure.text}</span><span style={{ color: 'var(--muted)' }}> · {view.secure.detail}</span></dd>
        <dt>Home Wi-Fi</dt>
        <dd style={{ margin: 0, color: 'var(--muted)' }}>{off ? 'Off' : view.url ? `On · http://${view.ip}:${view.port} (same Wi-Fi only)` : 'Off · Pandesh listens on this PC only'}</dd>
      </dl>

      <fieldset style={{ border: 0, margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <legend style={{ fontSize: 14, fontWeight: 500, padding: 0, marginBottom: 4 }}>Who can reach Pandesh from a phone</legend>
        {ACCESS.map((a) => (
          <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, cursor: 'pointer' }}>
            <input type="radio" name="mobile-access" checked={view.access === a.id} disabled={busy === 'access'} onChange={() => changeAccess(a.id)} style={{ marginTop: 3 }} />
            <span><span style={{ fontWeight: 500 }}>{a.label}</span><span style={{ color: 'var(--muted)' }}> · {a.hint}</span></span>
          </label>
        ))}
      </fieldset>

      {!off && (
        <details open={setupOpen} style={{ marginTop: 6 }}>
          <summary style={{ fontWeight: 500, cursor: 'pointer' }}>Set up the secure link (Tailscale)</summary>
          <ol style={{ margin: '6px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
            <li>Install Tailscale on this PC and on your phone, and sign in with the same account on both. <button type="button" className="btn link" onClick={() => void api.openExternalUrl('https://tailscale.com/download').catch((err) => setNote({ text: errorText(err), error: true }))}>Get Tailscale</button></li>
            <li>In the Tailscale admin console, on the DNS page, turn on MagicDNS and HTTPS Certificates. <button type="button" className="btn link" onClick={() => void api.openExternalUrl('https://login.tailscale.com/admin/dns').catch((err) => setNote({ text: errorText(err), error: true }))}>Open the DNS page</button></li>
            <li>Give this PC a neutral name there (Machines → ⋯ → Edit machine name), for example desktop-1. The secure address appears in public certificate logs, so it should not contain your name.</li>
            <li>On this PC, run this in a terminal: <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{serveCommand}</code> <button type="button" className="btn link" onClick={() => { void copy(serveCommand, 'Command'); }}>Copy</button>. Never use <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>tailscale funnel</code>: that would put Pandesh on the public internet.</li>
            <li>On the phone, turn Tailscale on (on Android it takes the VPN slot, so another VPN cannot be on at the same time), then scan the QR code above.</li>
          </ol>
          <div className="actions" style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('check', () => api.getMobilePairing())}>Check again</button>
          </div>
        </details>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>Paired phones</span>
        {view.devices.length === 0 ? (
          <span style={{ fontSize: 14, color: 'var(--muted)' }}>No phone is paired yet.</span>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {view.devices.map((d) => (
              <li key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 14 }}>
                <span style={{ fontWeight: 500 }}>{d.name}</span>
                <span style={{ color: d.connected ? 'var(--verified)' : 'var(--muted)', flex: '1 1 auto' }}>{deviceLine(d, now)}</span>
                <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => forget(d)}>Forget</button>
              </li>
            ))}
          </ul>
        )}
        {view.devices.length > 1 && (
          <div><button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => forget('all')}>Forget all phones</button></div>
        )}
      </div>

      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, minHeight: 1, color: note?.error ? 'var(--danger)' : 'var(--verified)' }}>{note?.text ?? ''}</p>
    </section>
  );
}
