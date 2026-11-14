import React, { useEffect, useState } from 'react';
import { api, errorText } from './bridge';
import { confirmText, describeLimits, OPERATION_LABEL, operationsOf, statusLabel, type GrantCatalog, type GrantRow } from './grantModel';

type GrantApi = { listRoutineWriteGrants(): Promise<GrantCatalog>; grantRoutineWrite(taskId: string, limits?: Record<string, number>): Promise<unknown>; revokeRoutineWrite(taskId: string): Promise<unknown> };
const grantApi = api as unknown as GrantApi;

/** Per-routine standing write permission: what is allowed, where, with which limits, and Grant / Revoke. Core enforces it. */
export function RoutineGrants() {
  const [cat, setCat] = useState<GrantCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setError(null); setCat(await grantApi.listRoutineWriteGrants()); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setConfirming(null); await load(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } };

  return (
    <section aria-label="Standing write permission" data-testid="routine-grants" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>Standing write permission</h2>
      <p className="meta" style={{ margin: 0 }}>Lets one routine write files in its own folder without asking each time. Off unless you turn it on for that routine.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {cat && cat.routines.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>No routine works in a folder yet.</div>}
      {cat?.routines.map((r: GrantRow) => {
        const st = statusLabel(r);
        return (
          <div className="card" key={r.taskId} data-testid={`grant-${r.taskId}`}>
            <span className="title">{r.title}</span>
            <span className="meta">Folder: {r.folder}{r.dailyTime ? ` · daily at ${r.dailyTime}` : ''}</span>
            <span className="meta">Operation: {operationsOf(r, cat).map((o) => OPERATION_LABEL[o] ?? o).join(', ')} · Limits: {describeLimits(r.active?.frozen.limits ?? cat.defaults)}</span>
            <span className="meta" role="status" data-status={r.status}>{st.text}</span>
            {r.grantable && confirming === r.taskId && (
              <div className="notice" role="group" aria-label="Confirm standing permission">
                {confirmText(r, cat).map((l) => <div key={l}>{l}</div>)}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button type="button" className="btn small primary" disabled={busy} onClick={() => void act(() => grantApi.grantRoutineWrite(r.taskId))}>Confirm and grant</button>
                  <button type="button" className="btn small" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              </div>
            )}
            {r.grantable && confirming !== r.taskId && (
              <div style={{ display: 'flex', gap: 8 }}>
                {r.status !== 'active' && <button type="button" className="btn small" disabled={busy} onClick={() => setConfirming(r.taskId)}>Grant…</button>}
                {r.status !== 'none' && <button type="button" className="btn small" disabled={busy} onClick={() => void act(() => grantApi.revokeRoutineWrite(r.taskId))}>Revoke</button>}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
