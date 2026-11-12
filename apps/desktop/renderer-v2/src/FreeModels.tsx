import React, { useCallback, useEffect, useState } from 'react';
import { api, errorText, type FreeModelsState, type RegistryProviderView } from './bridge';
import { timeOf } from './ui';

/**
 * Free cloud models: what the free-model registry discovered, what Pandesh verified itself, which providers need a
 * key, qualification results, routing preferences, and key backup/restore. Keys go in through password fields and
 * never come back: the page sees only "configured", a masked hint and where the key is kept.
 */
const STATUS: Record<string, { label: string; color: string }> = {
  verified_free: { label: 'Verified free', color: 'var(--verified)' },
  unverified: { label: 'Listed free, not verified', color: 'var(--pulse)' },
  restricted: { label: 'Restricted', color: 'var(--attention)' },
  unavailable: { label: 'Unavailable', color: 'var(--muted)' },
  unknown: { label: 'Unknown', color: 'var(--muted)' },
};
const input: React.CSSProperties = { height: 32, padding: '0 8px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', minWidth: 0 };
const small: React.CSSProperties = { fontSize: 13, color: 'var(--muted)' };

function Chip({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.unknown;
  return <span style={{ color: s.color, fontWeight: 500, fontSize: 13 }}>{s.label}</span>;
}

export function FreeModelsCard() {
  const [state, setState] = useState<FreeModelsState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [qualifyPick, setQualifyPick] = useState<Record<string, string>>({});
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [restore, setRestore] = useState<{ file: string; providers: string[]; chosen: string[] } | null>(null);

  const load = useCallback(() => { api.getFreeModels().then(setState).catch((err) => setNote({ text: errorText(err), error: true })); }, []);
  useEffect(load, [load]);

  const run = async (label: string, work: () => Promise<FreeModelsState | void | null>, done?: string) => {
    setBusy(label); setNote(null);
    try {
      const next = await work();
      if (next && typeof next === 'object' && 'registry' in next) setState(next);
      else load();
      if (done) setNote({ text: done });
    } catch (err) { setNote({ text: errorText(err), error: true }); } finally { setBusy(null); }
  };

  const reg = state?.registry;
  const creds = state?.credentials;
  const prefs = reg?.preferences ?? { autoProviders: [], disabledProviders: [], preferredOrder: [], fallbackOnRateLimit: true };
  const providers = reg?.providers ?? [];
  const withAdapter = providers.filter((p) => p.hasAdapter);
  const discovered = providers.filter((p) => !p.hasAdapter);
  const quals = new Map((reg?.qualifications ?? []).map((q) => [`${q.providerId}::${q.modelId}`, q]));
  const configured = (id: string) => Boolean(creds?.status[id]?.configured);
  const toggleAuto = (id: string, on: boolean) => run(`auto:${id}`, () => api.setFreeModelPreferences({ autoProviders: on ? [...prefs.autoProviders, id] : prefs.autoProviders.filter((x) => x !== id) }));

  const row = (p: RegistryProviderView) => {
    const cred = creds?.status[p.id];
    const verifiedModels = p.models.filter((m) => m.status === 'verified_free');
    const pick = qualifyPick[p.id] ?? verifiedModels[0]?.modelId ?? '';
    return (
      <div key={p.id} style={{ borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>{p.displayName}</strong>
          <Chip status={p.status} />
          <span style={small}>{p.models.length} model{p.models.length === 1 ? '' : 's'} · sources: {p.sources.map((s) => s.source).join(' + ') || 'provider only'}</span>
          <span className="grow" />
          <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }} title={!cred?.configured ? 'Add a key first' : 'Let Auto pick this provider and use it for rate-limit fallback'}>
            <input type="checkbox" disabled={!cred?.configured || Boolean(busy)} checked={prefs.autoProviders.includes(p.id)} onChange={(e) => void toggleAuto(p.id, e.target.checked)} />
            Auto routing
          </label>
        </div>
        {p.statusReasons[0] && <span style={small}>{p.statusReasons.join('; ')}</span>}
        {p.conflicts.length > 0 && <span style={{ ...small, color: 'var(--attention)' }}>Sources disagree: {p.conflicts.join('; ')}</span>}
        <span style={small}>
          Key: {cred?.configured ? `${cred.hint ?? 'set'} · ${cred.source === 'credential-manager' ? 'Windows Credential Manager' : 'earlier encrypted file'}` : p.requiresKey ? 'pending setup (no key)' : 'not needed'}
          {p.health && ` · last check ${timeOf(p.health.checkedAt)}: ${p.health.ok ? `${p.health.freeModels} free model(s), ${p.health.latencyMs} ms` : p.health.errorClass}`}
          {reg?.exhaustedProviders.includes(p.id) && ' · rate-limited, cooling down'}
          {p.training !== 'unknown' && ` · training on prompts: ${p.training}`}
        </span>
        <form onSubmit={(e) => { e.preventDefault(); const k = keys[p.id]; if (k) void run(`key:${p.id}`, async () => { await api.setCloudProviderKey(p.id, k); setKeys((x) => ({ ...x, [p.id]: '' })); return api.getFreeModels(); }, 'Key saved in Windows Credential Manager.'); }}
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} autoComplete="off">
          <input type="password" aria-label={`${p.displayName} API key`} placeholder={cred?.configured ? 'Paste a new key to replace' : 'Paste API key'} value={keys[p.id] ?? ''} onChange={(e) => setKeys((x) => ({ ...x, [p.id]: e.target.value }))} style={{ ...input, flex: '1 1 180px' }} spellCheck={false} />
          <button type="submit" className="btn small" disabled={Boolean(busy) || !(keys[p.id] ?? '').trim()}>{cred?.configured ? 'Replace' : 'Save key'}</button>
          {cred?.configured && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run(`test:${p.id}`, () => api.testProviderKey(p.id), 'Key works; free models re-checked.')}>Test</button>}
          {cred?.configured && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Remove the ${p.displayName} key from this PC?`)) void run(`del:${p.id}`, async () => { await api.clearCloudProviderKey(p.id); return api.getFreeModels(); }, 'Key removed.'); }}>Remove</button>}
          {p.keyUrl && !cred?.configured && <button type="button" className="btn link" onClick={() => void api.openExternalUrl(p.keyUrl!)}>Get a key</button>}
        </form>
        {verifiedModels.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <select aria-label="Model to qualify" value={pick} onChange={(e) => setQualifyPick((x) => ({ ...x, [p.id]: e.target.value }))} style={{ ...input, flex: '1 1 200px' }}>
              {verifiedModels.map((m) => <option key={m.modelId} value={m.modelId}>{m.modelId}</option>)}
            </select>
            <button type="button" className="btn small" disabled={Boolean(busy) || !pick} onClick={() => void run(`q:${p.id}`, () => api.qualifyFreeModel(p.id, pick))}>{busy === `q:${p.id}` ? 'Qualifying…' : 'Qualify (≤7 short requests)'}</button>
          </div>
        )}
        {verifiedModels.map((m) => {
          const q = quals.get(`${p.id}::${m.modelId}`);
          if (!q) return null;
          const caps = Object.entries(q.capabilities).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ');
          return (
            <details key={m.modelId} style={small}>
              <summary>{m.modelId}: {caps} · {q.suiteVersion} · {timeOf(q.ranAt)}</summary>
              <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{q.results.map((r) => <li key={r.id}>{r.id}: {r.outcome} ({r.latencyMs} ms) {r.detail}</li>)}</ul>
              {q.modelVersion && <div>Provider reported model: {q.modelVersion}</div>}
            </details>
          );
        })}
      </div>
    );
  };

  const backupIds = withAdapter.filter((p) => configured(p.id)).map((p) => p.id);
  return (
    <section className="card" aria-label="Free cloud models">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="title" style={{ fontSize: 16 }}>Free cloud models</span>
        <span className="meta">{reg?.generatedAt ? `registry ${timeOf(reg.generatedAt)}` : 'not refreshed yet'}</span>
        <span className="grow" />
        <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('refresh', () => api.refreshFreeModels())}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh discovery'}</button>
      </div>
      <span style={{ fontSize: 14, color: 'var(--muted)' }}>
        Private content always stays on this PC. A cloud model only ever gets one public text you approve, never files, history, memory or tools, and never a paid model. Upstream lists are hints: a model counts as free only after Pandesh checks it with the provider.
      </span>
      {reg && (
        <span style={small}>
          {reg.counts.providers} providers, {reg.counts.models} models · verified free {reg.counts.modelsByStatus.verified_free} · listed, unverified {reg.counts.modelsByStatus.unverified} · restricted {reg.counts.modelsByStatus.restricted} · unavailable {reg.counts.modelsByStatus.unavailable}
          {reg.lastReport && ` · last refresh: ${reg.lastReport.summary}`}
        </span>
      )}
      {reg?.lastReport?.errors?.length ? <div className="notice error" role="alert">{reg.lastReport.errors.join(' ')}</div> : null}
      <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" disabled={Boolean(busy) || !reg?.schedule} checked={Boolean(reg?.schedule?.enabled)} onChange={(e) => void run('sched', () => api.setFreeModelSchedule(e.target.checked))} />
        Refresh the registry daily{reg?.schedule ? ` (${reg.schedule.dailyTime})` : ' (starts after the first refresh)'}
      </label>
      <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" disabled={Boolean(busy)} checked={prefs.fallbackOnRateLimit} onChange={(e) => void run('fb', () => api.setFreeModelPreferences({ fallbackOnRateLimit: e.target.checked }))} />
        If an approved free model is rate-limited, offer another approved free one (shown on the approval card)
      </label>

      {withAdapter.map(row)}

      {discovered.length > 0 && (
        <details style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <summary style={{ fontSize: 14, cursor: 'pointer' }}>Discovered elsewhere ({discovered.length}): listed upstream, no Pandesh adapter yet, never used</summary>
          <ul style={{ margin: '6px 0', paddingLeft: 18, ...small }}>
            {discovered.map((p) => <li key={p.id}><strong>{p.displayName}</strong> · <Chip status={p.status} /> · {p.models.length} models · {p.statusReasons[0] ?? ''}</li>)}
          </ul>
        </details>
      )}

      <details style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <summary style={{ fontSize: 14, cursor: 'pointer' }}>Keys: backup and restore</summary>
        <p style={{ ...small, margin: '6px 0' }}>
          Keys are kept in Windows Credential Manager ({creds?.backend ?? '…'}), so reinstalling or updating Pandesh keeps them. For a new PC or a fresh Windows, save an encrypted backup (ideally on another drive) and restore it there with your passphrase. Pandesh never stores the passphrase.
        </p>
        {creds && creds.legacyOnly.length > 0 && (
          <div className="actions">
            <span style={small}>{creds.legacyOnly.length} key(s) are still only in the earlier encrypted file.</span>
            <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('migrate', async () => { const r = await api.migrateLegacyKeys(creds.legacyOnly); setNote({ text: r.results.map((x) => `${x.provider}: ${x.migrated ? 'moved' : x.reason}`).join(', ') }); return r.state; })}>Move them to Credential Manager</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <input type="password" aria-label="Backup passphrase" placeholder="Passphrase (12+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} style={{ ...input, flex: '1 1 180px' }} autoComplete="new-password" />
          <input type="password" aria-label="Repeat passphrase" placeholder="Repeat for a new backup" value={pass2} onChange={(e) => setPass2(e.target.value)} style={{ ...input, flex: '1 1 160px' }} autoComplete="new-password" />
          <button type="button" className="btn small" disabled={Boolean(busy) || backupIds.length === 0 || pass.length < 12 || pass !== pass2}
            onClick={() => void run('backup', async () => { const r = await api.exportCredentialBackup(pass, backupIds); if (r) setNote({ text: `Saved ${r.providers.length} key(s), encrypted, to ${r.file}` }); setPass2(''); })}>Save encrypted backup…</button>
          <button type="button" className="btn small" disabled={Boolean(busy) || pass.length < 12}
            onClick={() => void run('inspect', async () => { const r = await api.inspectCredentialBackup(null, pass); if (r) setRestore({ ...r, chosen: [] }); })}>Open a backup…</button>
        </div>
        {restore && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={small}>Choose what to restore from {restore.file}:</span>
            {restore.providers.map((id) => (
              <label key={id} style={{ fontSize: 13, display: 'flex', gap: 6 }}>
                <input type="checkbox" checked={restore.chosen.includes(id)} onChange={(e) => setRestore({ ...restore, chosen: e.target.checked ? [...restore.chosen, id] : restore.chosen.filter((x) => x !== id) })} />
                {id}{configured(id) ? ' (replaces the key stored now)' : ''}
              </label>
            ))}
            <div className="actions">
              <button type="button" className="btn small primary" disabled={Boolean(busy) || restore.chosen.length === 0}
                onClick={() => void run('restore', async () => { const r = await api.restoreCredentialBackup(restore.file, pass, restore.chosen); setRestore(null); setPass(''); setNote({ text: `Restored: ${r.restored.join(', ') || 'none'}` }); return r.state; })}>Restore selected</button>
              <button type="button" className="btn small" onClick={() => setRestore(null)}>Cancel</button>
            </div>
          </div>
        )}
      </details>

      <span style={small}>
        Sources: {(reg?.sources ?? []).map((s) => `${s.name} (${s.license}${s.fetch ? `, ${s.fetch.carriedOver ? 'last good copy kept' : `fetched ${timeOf(s.fetch.fetchedAt)}`}` : ''})`).join(' · ')}
        {(reg?.unimportedSources ?? []).map((s) => ` · ${s.name} (${s.license}, not imported: ${s.reason})`).join('')}
      </span>
      <p role={note?.error ? 'alert' : 'status'} aria-live="polite" style={{ margin: 0, fontSize: 14, minHeight: 1, color: note?.error ? 'var(--danger)' : undefined }}>{note?.text ?? ''}</p>
    </section>
  );
}
