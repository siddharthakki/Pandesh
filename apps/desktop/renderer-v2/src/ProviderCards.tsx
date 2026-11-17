import React, { useEffect, useState } from 'react';
import { api, errorText, type FreeModelsState, type Snapshot } from './bridge';
import { cloudAvailability, type CloudProviderAvailability } from './composerModel';
import { TONE_COLOR, credentialWords, type BotsResponse, type Tone } from './botsModel';

type Notice = { text: string; error?: boolean } | null;
interface CloudProviderView { id: string; displayName?: string; enabled?: boolean; configured?: boolean; endpoint?: string | null; privacyWarning?: string | null; apiKeysUrl?: string; keySource?: string | null; freeTier?: { kind: string; note?: string } }

const STATE_TONE: Record<CloudProviderAvailability['state'], Tone> = { ready: 'ok', no_key: 'warn', off: 'neutral', not_checked: 'neutral', failed: 'bad', none_free: 'warn' };

/**
 * One card per provider Pandesh can use: where it is, whether its credential is stored (never the value), what it
 * provides, and the actions that exist for it. Local providers first; a cloud provider is used only for a chat you
 * moved to it yourself.
 */
export function ProviderCards({ snapshot, refresh }: { snapshot: Snapshot | null; refresh: () => void }) {
  const [free, setFree] = useState<FreeModelsState | null>(null);
  const [hermes, setHermes] = useState<BotsResponse['hermes'] | null>(null);
  const [notice, setNotice] = useState<Record<string, Notice>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [adding, setAdding] = useState('');

  // Either read can be missing (an older host, Core still starting): the card then says "Not checked".
  const loadFree = async () => { try { setFree(await api.getFreeModels()); } catch { setFree(null); } };
  const loadHermes = async (force = false) => { try { setHermes(((await api.household('bots', force ? { refresh: true } : undefined)) as BotsResponse).hermes ?? null); } catch { setHermes(null); } };
  useEffect(() => { void loadFree(); void loadHermes(); }, []);

  const say = (id: string, n: Notice) => setNotice((cur) => ({ ...cur, [id]: n }));
  const run = async (id: string, op: string, work: () => Promise<unknown>, done: string | ((r: unknown) => string)) => {
    setBusy(`${op}:${id}`); say(id, null);
    try { const r = await work(); say(id, { text: typeof done === 'function' ? done(r) : done }); }
    catch (err) { say(id, { text: errorText(err), error: true }); }
    finally { setBusy(null); refresh(); void loadFree(); }
  };

  const cloud = (snapshot?.cloud ?? null) as { providers?: CloudProviderView[] } | null;
  const providers = cloud?.providers ?? [];
  const availability = cloudAvailability(snapshot);
  const shown = providers.filter((p) => p.configured || p.enabled);
  const addable = providers.filter((p) => !p.configured && !p.enabled);
  const legacyOnly = new Set(free?.credentials.legacyOnly ?? []);
  const installed = snapshot?.installedModels ?? [];

  const saveKey = (p: CloudProviderView) => {
    const value = key.trim();
    if (!value) return;
    void run(p.id, 'key', async () => { await api.setCloudProviderKey(p.id, value); setKey(''); setEditing(null); setAdding(''); await api.testProviderKey(p.id); }, 'Key saved and checked. Its free models are now offered in the model menu.');
  };
  const keyForm = (p: CloudProviderView) => (
    <form className="settings-row" aria-label={`${p.displayName ?? p.id} API key`} autoComplete="off" onSubmit={(e) => { e.preventDefault(); saveKey(p); }}>
      <input type="password" className="bot-input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the API key" aria-label="API key" autoComplete="off" spellCheck={false} />
      <button type="submit" className="btn small primary" disabled={Boolean(busy) || !key.trim()}>{busy === `key:${p.id}` ? 'Saving…' : 'Save and test'}</button>
      <button type="button" className="btn small" onClick={() => { setEditing(null); setAdding(''); setKey(''); }}>Cancel</button>
      {p.apiKeysUrl && <button type="button" className="btn link" onClick={() => void api.openExternalUrl(p.apiKeysUrl as string)}>Get a key</button>}
    </form>
  );
  const note = (id: string) => notice[id] && <p role={notice[id]!.error ? 'alert' : 'status'} className="settings-note" style={notice[id]!.error ? { color: 'var(--danger)' } : undefined}>{notice[id]!.text}</p>;

  return (
    <>
      <section className="card" aria-label="Ollama">
        <div className="provider-head"><span className="title" style={{ fontSize: 16 }}>Ollama</span><span className="meta">Local models · this PC</span>
          <span style={{ color: snapshot?.modelServerReachable === false ? TONE_COLOR.bad : snapshot?.modelServerReachable ? TONE_COLOR.ok : TONE_COLOR.neutral, fontWeight: 500, fontSize: 14 }}>{snapshot?.modelServerReachable === false ? 'Not answering' : snapshot?.modelServerReachable ? 'Connected' : 'Not checked'}</span></div>
        <dl className="settings-kv">
          <dt>Endpoint</dt><dd>http://localhost:11434</dd>
          <dt>Credential</dt><dd>None needed</dd>
          <dt>Provides</dt><dd>Chat, tools and vision on local models ({installed.length} installed). Nothing leaves this PC.</dd>
        </dl>
        <div className="actions"><button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('ollama', 'test', () => api.listModels(), (r) => `Ollama answered: ${(r as string[]).length} model(s) installed.`)}>{busy === 'test:ollama' ? 'Testing…' : 'Test'}</button></div>
        {note('ollama')}
      </section>

      <section className="card" aria-label="Hermes">
        <div className="provider-head"><span className="title" style={{ fontSize: 16 }}>Hermes</span><span className="meta">Bots: identity and memory · this PC</span>
          <span style={{ color: hermes ? (hermes.available ? TONE_COLOR.ok : TONE_COLOR.bad) : TONE_COLOR.neutral, fontWeight: 500, fontSize: 14 }}>{hermes ? (hermes.available ? `Connected · ${hermes.version}` : 'Not available') : 'Not checked'}</span></div>
        <dl className="settings-kv">
          <dt>Endpoint</dt><dd>Local program (no network address); each Bot is one Hermes profile</dd>
          <dt>Credential</dt><dd>None needed: Bots run on local Ollama models only</dd>
          <dt>Provides</dt><dd>My Bots: a persistent profile, instructions and memory per Bot. Pandesh keeps every action.</dd>
        </dl>
        {hermes && !hermes.available && <p className="settings-note" style={{ color: 'var(--danger)' }}>{hermes.reason}</p>}
        <div className="actions"><button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { setBusy('test:hermes'); void loadHermes(true).finally(() => setBusy(null)); }}>{busy === 'test:hermes' ? 'Testing…' : 'Test'}</button></div>
      </section>

      {shown.map((p) => {
        const a = availability.find((x) => x.id === p.id);
        const source = free?.credentials.status[p.id]?.source ?? p.keySource ?? null;
        const isEditing = editing === p.id;
        return (
          <section key={p.id} className="card" aria-label={p.displayName ?? p.id}>
            <div className="provider-head"><span className="title" style={{ fontSize: 16 }}>{p.displayName ?? p.id}</span><span className="meta">Free cloud models</span>
              {a && <span style={{ color: TONE_COLOR[STATE_TONE[a.state]], fontWeight: 500, fontSize: 14 }}>{a.state === 'ready' ? 'Connected' : a.state === 'failed' ? 'Problem' : a.state === 'no_key' ? 'No key' : a.state === 'off' ? 'Off' : a.state === 'none_free' ? 'No free model' : 'Not checked'}</span>}</div>
            <dl className="settings-kv">
              <dt>Endpoint</dt><dd>{p.endpoint ?? 'Not reported'}</dd>
              <dt>Credential</dt><dd>{credentialWords(p.configured, source)}</dd>
              <dt>Provides</dt><dd>{a ? a.text : 'Chat models'}. Used only for a chat you move to it yourself; your files, mail and memory are never sent.</dd>
            </dl>
            {p.privacyWarning && <p className="settings-note">{p.privacyWarning}</p>}
            {legacyOnly.has(p.id) && <p className="settings-note">This key is in the older encrypted file. It works; you can move it to Windows Credential Manager.</p>}
            <div className="actions">
              {!p.configured && !isEditing && <button type="button" className="btn small primary" disabled={Boolean(busy)} onClick={() => { setEditing(p.id); setKey(''); }}>Connect</button>}
              {p.configured && !p.enabled && <button type="button" className="btn small primary" disabled={Boolean(busy)} onClick={() => void run(p.id, 'on', async () => { await api.setCloudProviderEnabled(p.id, true); await api.testProviderKey(p.id); }, 'Switched on and checked. Its free models are now offered in the model menu; nothing is sent until you pick one and confirm.')}>{busy === `on:${p.id}` ? 'Switching on…' : 'Switch on'}</button>}
              {p.configured && p.enabled && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run(p.id, 'off', () => api.setCloudProviderEnabled(p.id, false), 'Switched off. The key stays stored; its models are no longer offered.')}>Switch off</button>}
              {p.configured && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run(p.id, 'test', () => api.testProviderKey(p.id), 'The key works. Free models were checked again.')}>{busy === `test:${p.id}` ? 'Testing…' : 'Test'}</button>}
              {p.configured && !isEditing && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { setEditing(p.id); setKey(''); }}>Edit</button>}
              {legacyOnly.has(p.id) && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run(p.id, 'move', () => api.migrateLegacyKeys([p.id]), (r) => { const res = (r as { results: Array<{ migrated: boolean; reason?: string }> }).results[0]; return res?.migrated ? 'Moved and read back correctly. The old file is kept.' : `Not moved: ${res?.reason ?? 'unknown reason'}`; })}>Move key</button>}
              {p.configured && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Disconnect ${p.displayName ?? p.id}? Its key is removed from this PC and any chat using it goes back to a local model.`)) void run(p.id, 'del', () => api.clearCloudProviderKey(p.id), 'Disconnected. The key was removed from this PC.'); }}>Disconnect</button>}
            </div>
            {isEditing && keyForm(p)}
            {note(p.id)}
          </section>
        );
      })}

      {addable.length > 0 && (
        <section className="card" aria-label="Add a cloud provider">
          <span className="title" style={{ fontSize: 16 }}>Add a free cloud provider</span>
          <p className="settings-note">Optional. Pandesh stays local unless you add one and then move a chat to it.</p>
          <div className="settings-row">
            <select className="ctl-select" value={adding} onChange={(e) => { setAdding(e.target.value); setKey(''); setEditing(null); }} aria-label="Provider">
              <option value="">Choose a provider…</option>
              {addable.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.id}</option>)}
            </select>
          </div>
          {adding && (() => { const p = addable.find((x) => x.id === adding); return p ? <>{p.endpoint && <span className="meta">Endpoint: {p.endpoint}</span>}{p.privacyWarning && <p className="settings-note">{p.privacyWarning}</p>}{keyForm(p)}{note(p.id)}</> : null; })()}
        </section>
      )}
    </>
  );
}
