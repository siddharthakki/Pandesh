import React, { useState } from 'react';
import { api, errorText, type Snapshot } from './bridge';
import {
  AUTO_MODEL, EXPIRY_CHOICES, PERMISSION_LABELS, STILL_ASKS_NOTE,
  grantProblem, grantRows, modelMenu, permissionChip, permissionStatus, type PermissionMode,
} from './composerModel';

type Notice = { text: string; error?: boolean } | null;

/**
 * The two choices made before a message — the conversation's permission mode and the model — plus the panel that
 * says what is in force (Auto's grants with Revoke) and the form that grants Auto. Uses the host bridge only
 * (setPermissionMode, revokeAuthorization, selectModel); Core stores and enforces both choices.
 */
export function useComposerControls(opts: { snapshot: Snapshot | null; refresh: () => void; onNotice: (n: Notice) => void; disabled: boolean }) {
  const { snapshot, refresh, onNotice, disabled } = opts;
  const [granting, setGranting] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(60);
  const [grantError, setGrantError] = useState('');
  const [saving, setSaving] = useState(false);

  const permission = snapshot?.permission;
  const mode: PermissionMode = permission?.mode ?? 'ask';
  const chip = permissionChip(permission);
  const status = permissionStatus(permission);
  const rows = grantRows(permission, Boolean(snapshot?.folder));
  const menu = modelMenu(snapshot);

  const run = async (work: () => Promise<unknown>) => {
    setSaving(true);
    onNotice(null);
    try { await work(); } catch (err) { onNotice({ text: errorText(err), error: true }); } finally { setSaving(false); refresh(); }
  };

  const chooseMode = (next: PermissionMode) => {
    if (next === 'auto') { setGranting(true); setTicked([]); setExpiry(60); setGrantError(''); return; }
    setGranting(false);
    void run(() => api.setPermissionMode(next));
  };

  const grant = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = grantProblem(ticked, expiry);
    if (problem) { setGrantError(problem); return; }
    setGrantError('');
    void run(async () => { await api.setPermissionMode('auto', { categories: ticked, expiresInMinutes: expiry }); setGranting(false); });
  };

  const chooseModel = (value: string) => {
    if (!value) return;
    void run(() => api.selectModel(value));
  };

  const panel = (granting || status.length > 0) ? (
    <section className="perm-panel" aria-label="What the permission mode allows">
      {status.length > 0 && (
        <ul className="perm-status" aria-live="polite">
          {status.map((line, i) => (
            <li key={line.revokeId ?? i}>
              <span>{line.text}</span>
              {line.revokeId && <button type="button" className="btn small" disabled={saving} onClick={() => void run(() => api.revokeAuthorization(line.revokeId!))}>Revoke</button>}
              {line.items?.length ? <ul className="perm-items">{line.items.map((it) => <li key={it}>{it}</li>)}</ul> : null}
            </li>
          ))}
          {mode === 'auto' && !granting && (
            <li><button type="button" className="btn small" disabled={disabled || saving} onClick={() => chooseMode('auto')}>{permission?.authorizations.length ? 'Grant more to Auto…' : 'Choose what Auto may do…'}</button></li>
          )}
        </ul>
      )}
      {granting && (
        <form className="perm-grant" aria-label="Turn on Auto" onSubmit={grant}>
          <p className="perm-title">Auto: choose what Pandesh may do in this conversation without asking</p>
          {rows.length === 0 && <p className="perm-note">Core has not reported what Auto can cover yet. Try again in a moment.</p>}
          <fieldset className="perm-cats">
            <legend className="sr-only">What Auto may do</legend>
            {rows.map((r) => (
              <label key={r.id} className={r.disabled ? 'disabled' : undefined}>
                <input type="checkbox" value={r.id} disabled={r.disabled} checked={ticked.includes(r.id)}
                  onChange={(e) => setTicked((cur) => (e.target.checked ? [...cur, r.id] : cur.filter((id) => id !== r.id)))} />
                <span>{r.text}</span>
              </label>
            ))}
          </fieldset>
          <label className="perm-expiry">For{' '}
            <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c) => <option key={c.minutes} value={c.minutes}>{c.label}</option>)}
            </select>
          </label>
          <p className="perm-note">{STILL_ASKS_NOTE} You can revoke it at any time.</p>
          {grantError && <p className="perm-error" role="alert">{grantError}</p>}
          <div className="perm-actions">
            <button type="submit" className="btn primary small" disabled={saving}>Turn on Auto</button>
            <button type="button" className="btn small" onClick={() => { setGranting(false); setGrantError(''); }}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  ) : null;

  const controls = (
    <>
      <label className="sr-only" htmlFor="v2-permission-mode">Permission mode</label>
      <select id="v2-permission-mode" className={`ctl-select mode-${granting ? 'auto' : mode}`} title={`Permission mode: what Pandesh may do without asking you (now: ${chip.label})`}
        value={granting ? 'auto' : mode} disabled={disabled || saving || !permission} onChange={(e) => chooseMode(e.target.value as PermissionMode)}>
        {(['ask', 'auto', 'plan'] as const).map((m) => <option key={m} value={m}>{m === mode && m === 'auto' && !granting ? chip.label : PERMISSION_LABELS[m]}</option>)}
      </select>
      <label className="sr-only" htmlFor="v2-model">Model for your next message</label>
      <select id="v2-model" className="ctl-select" title="Model for your next message. Auto lets Pandesh pick for each request; the reply shows which model answered."
        value={menu.selected} disabled={disabled || saving || !snapshot || Boolean(snapshot?.running)} onChange={(e) => chooseModel(e.target.value)}>
        {menu.options.filter((o) => o.group !== 'cloud').map((o) => <option key={o.value || 'none'} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        {menu.options.some((o) => o.group === 'cloud') && (
          <optgroup label="Cloud — the whole chat runs there (chosen in the Classic UI)">
            {menu.options.filter((o) => o.group === 'cloud').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        )}
      </select>
    </>
  );

  return { panel, controls, granting, autoSelected: menu.selected === AUTO_MODEL };
}
