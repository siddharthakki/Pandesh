import React from 'react';
import {
  stampKind, stampLabel, stampClass, formatDuration, formatTokens,
  visibleOps, hasPartial, shareable, type Receipt,
} from './receiptModel';

interface Props { receipt: Receipt; onReviewDiff?: () => void; onUndo?: () => void; onShare?: () => void; onNext?: () => void; }

export function OutcomeReceipt({ receipt, onReviewDiff, onUndo, onShare, onNext }: Props) {
  const kind = stampKind(receipt.status);
  const ops = visibleOps(receipt);
  const handleShare = () => {
    const text = shareable(receipt);
    if (onShare) onShare(); else if (navigator.clipboard) navigator.clipboard.writeText(text);
  };
  return (
    <div className="receipt" role="article" aria-label={`Outcome receipt: ${receipt.objective}`}>
      <div className="stamp-row">
        <span className={`stamp ${stampClass(kind)}`}>{stampLabel(kind)}</span>
        <span className="muted" style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
          {receipt.completedAt ? new Date(receipt.completedAt).toLocaleString() : ''} · {formatDuration(receipt.durationMs)}
        </span>
      </div>
      <div className="objective serif">{receipt.objective}</div>
      {receipt.nextAction && <div className="muted" style={{ fontSize: '13px', marginBottom: '12px' }}>{receipt.nextAction}</div>}

      <div className="h3">Operations performed</div>
      <div className="ops">
        {ops.map((o) => (
          <div className="op" key={o.label}><span className="n">{o.count}</span> {o.label}</div>
        ))}
        {ops.length === 0 && <div className="muted" style={{ fontSize: '13px' }}>No operations recorded.</div>}
      </div>

      {receipt.artifacts.length > 0 && (
        <>
          <div className="h3">Artifacts</div>
          <div className="artifacts">
            {receipt.artifacts.map((a, i) => (
              <span className="artifact" key={i}>{a.kind === 'file' ? '{}' : ' '} {a.path.split(/[\\/]/).pop()}</span>
            ))}
          </div>
        </>
      )}

      {receipt.verifiedOutputs.length > 0 && (
        <>
          <div className="h3">Verified outputs</div>
          {receipt.verifiedOutputs.map((v, i) => (
            <div className="evidence-row" key={i}><span>{v.label}</span><span className={`level ${v.level}`}>{v.level}</span></div>
          ))}
        </>
      )}

      {hasPartial(receipt) && (
        <>
          <div className="h3" style={{ color: 'var(--danger)', marginTop: '12px' }}>Not completed</div>
          <div className="not-changed">
            <ul>
              {receipt.partialOrFailed.map((p, i) => (
                <li key={i}>step {p.step}: {p.status} — {p.reason}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      {receipt.partialOrFailed.length === 0 && receipt.status === 'completed' && (
        <div className="muted" style={{ fontSize: '11px', marginTop: '8px', fontFamily: 'var(--font-mono)' }}>
          Nothing was left undone. Core recorded every step.
        </div>
      )}

      <div className="meta-row">
        <span>Model: {receipt.model ?? '—'}</span>
        <span>Provider: {receipt.provider ?? '—'}</span>
        <span>Approvals used: {receipt.approvalsUsed}</span>
        <span>{formatTokens(receipt.tokens)}</span>
        {receipt.independentlyReviewed && <span>Independently reviewed</span>}
      </div>

      <div className="h3">Next action</div>
      <div className="muted" style={{ fontSize: '13px', marginBottom: '10px' }}>{receipt.nextAction ?? 'No further action recorded.'}</div>

      <div className="actions">
        {onReviewDiff && <button className="btn btn-ghost" onClick={onReviewDiff}>Review diff</button>}
        {receipt.undoAvailable && onUndo && <button className="btn btn-ghost" onClick={onUndo}>{receipt.undoHint ?? 'Undo'}</button>}
        <button className="btn btn-ghost" onClick={handleShare}>Share (redacted)</button>
        {onNext && <button className="btn btn-primary" onClick={onNext}>Continue</button>}
      </div>
      <div className="muted" style={{ fontSize: '10px', marginTop: '10px', fontFamily: 'var(--font-mono)' }}>
        Shareable: paths, tokens and identifiers redacted. Evidence levels: observed / checked / reviewed.
      </div>
    </div>
  );
}