import React, { useEffect, useState } from 'react';
import { api, errorText } from './bridge';
import { timeOf } from './ui';

// Shapes returned by Core's /v1/revenue routes (core/domain/revenuePipeline.ts).
interface Lead { id: string; name: string; category: string; sourceUrl: string; why: string; contactRoute: string | null; status: string; at: string }
interface Offer { id: string; title: string; file: string; summary: string; at: string }
interface Draft { id: string; kind: 'outreach' | 'social'; channel: string; leadId: string | null; text: string; at: string; status: 'awaiting_approval' | 'approved' | 'rejected'; decidedAt: string | null }
interface Outcome { id: string; kind: string; leadId: string | null; amountEur: number | null; evidence: string; at: string }
interface Summary { qualifiedLeads: number; offersPrepared: number; draftsAwaitingApproval: number; approvedOutreach: number; approvedSocial: number; responsesReceived: number; opportunities: number; confirmedOrders: number; orderValueEur: number; verifiedRevenueEur: number }
interface Track { id: 'catering' | 'digital'; name: string; summary: Summary; leads: Lead[]; offers: Offer[]; drafts: Draft[]; outcomes: Outcome[] }

const TILES: Array<{ key: keyof Summary; label: string; money?: boolean }> = [
  { key: 'qualifiedLeads', label: 'Qualified leads' }, { key: 'offersPrepared', label: 'Offers prepared' },
  { key: 'draftsAwaitingApproval', label: 'Drafts awaiting you' }, { key: 'approvedOutreach', label: 'Approved outreach' },
  { key: 'responsesReceived', label: 'Responses received' }, { key: 'opportunities', label: 'Opportunities' },
  { key: 'confirmedOrders', label: 'Confirmed orders' }, { key: 'verifiedRevenueEur', label: 'Verified revenue', money: true },
];
const eur = (n: number) => `€${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Revenue() {
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [active, setActive] = useState<'catering' | 'digital'>('catering');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState({ kind: 'response', amountEur: '', evidence: '' });

  const load = async () => { try { setTracks(((await api.household('revenue')) as { tracks: Track[] }).tracks); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { void load(); }, []);
  const t = tracks?.find((x) => x.id === active);

  const decide = async (d: Draft, decision: 'approved' | 'rejected') => {
    try { await api.household('revenueDecide', { track: active, id: d.id, decision }); await load(); } catch (err) { setError(errorText(err)); }
  };
  const addOutcome = async () => {
    setError(null);
    try { await api.household('revenueOutcome', { track: active, kind: outcome.kind, amountEur: outcome.amountEur || undefined, evidence: outcome.evidence }); setOutcome({ kind: 'response', amountEur: '', evidence: '' }); await load(); } catch (err) { setError(errorText(err)); }
  };

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Revenue</span>
        <span className="grow" />
        {(tracks ?? []).map((x) => (
          <button key={x.id} type="button" className={`btn small${active === x.id ? ' primary' : ''}`} aria-pressed={active === x.id} onClick={() => setActive(x.id)}>{x.name}</button>
        ))}
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>
          Every number comes from a record. Agents can add researched leads, offers and drafts; only you can approve a draft and record responses, orders and money — with evidence. Pandesh sends nothing: approved drafts are yours to send.
        </p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {t && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
              {TILES.map((tile) => (
                <div key={tile.key} className="card" style={{ padding: '10px 12px' }}>
                  <div className="meta">{tile.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 650, color: 'var(--ink)' }}>{tile.money ? eur(t.summary[tile.key]) : t.summary[tile.key]}</div>
                </div>
              ))}
            </div>

            <section aria-label="Approval queue" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h2 style={{ fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: 0 }}>Waiting for your approval · {t.drafts.filter((d) => d.status === 'awaiting_approval').length}</h2>
              {t.drafts.filter((d) => d.status === 'awaiting_approval').map((d) => (
                <article key={d.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="meta">{d.kind === 'social' ? 'Social post' : 'Outreach'} · {d.channel}{d.leadId ? ` · for ${t.leads.find((l) => l.id === d.leadId)?.name ?? d.leadId}` : ''} · {timeOf(d.at)}</div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{d.text}</div>
                  <div className="actions" style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="btn small primary" onClick={() => void decide(d, 'approved')} title="Marks it approved. Pandesh does not send it — you do.">Approve (I'll send it)</button>
                    <button type="button" className="btn small" onClick={() => void decide(d, 'rejected')}>Reject</button>
                  </div>
                </article>
              ))}
            </section>

            <section aria-label="Leads" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h2 style={{ fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: 0 }}>Leads · {t.leads.length}</h2>
              {t.leads.map((l) => (
                <div key={l.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div><b>{l.name}</b> <span className="meta">· {l.category} · {l.status}</span></div>
                  <div style={{ fontSize: 14 }}>{l.why}</div>
                  <div className="meta">Source: <a href={l.sourceUrl} onClick={(e) => { e.preventDefault(); void api.openExternalUrl(l.sourceUrl); }}>{l.sourceUrl}</a>{l.contactRoute ? ` · Contact: ${l.contactRoute}` : ''}</div>
                </div>
              ))}
            </section>

            <section aria-label="Offers" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h2 style={{ fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', margin: 0 }}>Offers · {t.offers.length}</h2>
              {t.offers.map((o) => <div key={o.id} className="card"><b>{o.title}</b><div style={{ fontSize: 14 }}>{o.summary}</div><div className="meta">{o.file}</div></div>)}
            </section>

            <section aria-label="Record an outcome" className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <b>Record what actually happened</b>
              <div className="meta">Only you can record these. Write down the evidence: who answered, when, and how (e.g. "e-mail from … on 12 Nov asking for a quote for 40 people").</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select value={outcome.kind} onChange={(e) => setOutcome({ ...outcome, kind: e.target.value })} aria-label="Kind">
                  <option value="response">Response received</option><option value="opportunity">Opportunity</option><option value="order">Confirmed order</option><option value="payment">Payment received</option>
                </select>
                {(outcome.kind === 'order' || outcome.kind === 'payment') && <input value={outcome.amountEur} onChange={(e) => setOutcome({ ...outcome, amountEur: e.target.value })} placeholder="Amount in EUR" aria-label="Amount in EUR" style={{ width: 140 }} />}
                <input value={outcome.evidence} onChange={(e) => setOutcome({ ...outcome, evidence: e.target.value })} placeholder="Evidence" aria-label="Evidence" style={{ flex: '1 1 260px' }} />
                <button type="button" className="btn small" onClick={() => void addOutcome()}>Record</button>
              </div>
              {t.outcomes.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{t.outcomes.map((o) => <li key={o.id} style={{ fontSize: 14 }}>{o.kind}{o.amountEur ? ` · ${eur(o.amountEur)}` : ''} — {o.evidence} <span className="meta">({timeOf(o.at)})</span></li>)}</ul>}
            </section>
          </>
        )}
      </div>
    </>
  );
}
