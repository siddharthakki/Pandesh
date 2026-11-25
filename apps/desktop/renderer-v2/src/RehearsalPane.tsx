import React, { useState } from 'react';
import { formatBytes, rehearsalHeadline, hasConflicts, conflictCount, type RehearsalPlan } from './rehearsalModel';

interface Props {
  plan: RehearsalPlan;
  onAuthorize: () => void;
  onCancel: () => void;
}

export function RehearsalPane({ plan, onAuthorize, onCancel }: Props) {
  const [tab, setTab] = useState<'moves' | 'dups' | 'conflicts' | 'undo'>('moves');
  return (
    <div className="rehearse">
      <div className="h3">{rehearsalHeadline(plan)}</div>
      <div className="banner sim">
        Simulated: the move map and conflicts. Tested against real target: file existence, sizes, free space.
        Not tested: antivirus / permission errors during the real move.
      </div>
      <div style={{ display: 'flex', gap: '4px', margin: '8px 0' }}>
        {(['moves', 'dups', 'conflicts', 'undo'] as const).map((t) => (
          <button key={t} className={`btn ${tab === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t)} style={{ fontSize: '12px', padding: '4px 8px' }}>
            {t === 'moves' ? 'Moves' : t === 'dups' ? 'Duplicates' : t === 'conflicts' ? `Conflicts (${conflictCount(plan)})` : 'Undo plan'}
          </button>
        ))}
      </div>
      {tab === 'moves' && (
        <div className="card" style={{ padding: 0 }}>
          <table className="move-table">
            <thead><tr><th>Source</th><th>→ Destination</th><th>Size</th></tr></thead>
            <tbody>
              {plan.moves.map((m, i) => (
                <tr key={i} className={m.conflict ? 'conflict' : ''}>
                  <td>{m.source}</td>
                  <td>{m.destination}{m.conflict ? ' ⚠ exists' : ''}</td>
                  <td>{formatBytes(m.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'dups' && (
        <div className="card">
          {plan.duplicates.map((d, i) => (
            <div key={i} style={{ fontSize: '12px', marginBottom: '6px' }}>
              Set {d.set}: {d.files} files, {formatBytes(d.bytes)} redundant
            </div>
          ))}
          {plan.duplicates.length === 0 && <div className="muted" style={{ fontSize: '12px' }}>No duplicates found.</div>}
          <div className="banner tested" style={{ marginTop: '8px' }}>
            Duplicates verified by SHA-256. {formatBytes(plan.spaceFreedBytes)} can be freed.
          </div>
        </div>
      )}
      {tab === 'conflicts' && (
        <div className="card">
          {hasConflicts(plan)
            ? plan.moves.filter((m) => m.conflict).map((m, i) => (
                <div key={i} style={{ fontSize: '12px', marginBottom: '6px', color: 'var(--attention)' }}>
                  ⚠ {m.source} → {m.destination} (destination exists)
                </div>
              ))
            : <div className="muted" style={{ fontSize: '12px' }}>No conflicts.</div>}
        </div>
      )}
      {tab === 'undo' && (
        <div className="card">
          <div style={{ fontSize: '12px' }}>Undo plan available after apply. Every move is verified (existence + size + SHA-256). On partial failure, retry the failed moves or undo all.</div>
        </div>
      )}
      <div className="card" style={{ marginTop: '10px' }}>
        <div className="h3">Space</div>
        <div className="muted" style={{ fontSize: '12px' }}>
          Frees {formatBytes(plan.spaceFreedBytes)} (duplicates) · {formatBytes(plan.spaceMovedBytes)} to move · {plan.totalMoves} moves proposed
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={onAuthorize}>Authorize the real run</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      <div className="muted" style={{ fontSize: '10px', marginTop: '8px', fontFamily: 'var(--font-mono)' }}>
        Rehearsal ≠ success. The real run is verified per move. Plan digest: {plan.digest.slice(0, 12)}.
      </div>
    </div>
  );
}