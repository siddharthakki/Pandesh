import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from './bridge';
import {
  CATEGORY_LABEL, SCREENS, askAbout, bytesWords, careerView, connectorWords, detectedDates, financeView, isScreen, sender, suggestedTasks, weekStrip, whenWords,
  type CareerStage, type MailAccount, type MailAskRun, type MailCategory, type MailOverview, type MailRow, type MailSettings, type MailStatus, type ScreenId,
} from './mailHubModel';

type Reply<T> = T & { ok?: boolean; error?: string; code?: string };
const call = async <T,>(action: string, args?: Record<string, unknown>): Promise<Reply<T>> => (await api.household(action, args)) as Reply<T>;
type Notice = { text: string; error?: boolean } | null;
interface ListState { rows: MailRow[]; total: number }
interface Detail { row: MailRow; body: string; attachments: Array<{ name: string; size: number }>; source: 'outlook' | 'index'; note?: string }

const pillTone = (c: MailCategory) => (c === 'finance' ? 'finance' : c === 'career' ? 'career' : c === 'security' ? 'alert' : '');
const Pill = ({ children, tone = '' }: { children: React.ReactNode; tone?: string }) => <span className={`mh-pill ${tone}`}>{children}</span>;
/** How sure a statement is: said in the message, worked out by a fixed rule, or written by the local model. */
const Basis = ({ kind }: { kind: 'confirmed' | 'rule' | 'ai' }) => <span className={`mh-basis ${kind}`} title={kind === 'confirmed' ? 'Read directly from the message text' : kind === 'rule' ? 'Worked out by a fixed rule from the message text; may be wrong' : 'Written by the local model; check it against the message'}>{kind === 'confirmed' ? 'From the message' : kind === 'rule' ? 'Detected by rule' : 'AI-inferred'}</span>;

export function MailHub({ narrow, initial, onAskPandesh, onOpenBots, onOpenAutomations }: { narrow: boolean; initial: { screen: string; n: number } | null; onAskPandesh: (text: string) => void; onOpenBots: () => void; onOpenAutomations: () => void }) {
  const [screen, setScreen] = useState<ScreenId>('overview');
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [readerId, setReaderId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (initial && isScreen(initial.screen)) setScreen(initial.screen); }, [initial?.n]);

  const loadStatus = useCallback(async () => {
    try { const s = await call<MailStatus>('mailStatus'); if (alive.current) setStatus(s); } catch (err) { if (alive.current) setNotice({ text: errorText(err), error: true }); }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const authorized = (status?.accounts ?? []).filter((a) => a.enabled);
  const open = (id: string) => { setReaderId(id); setScreen('reader'); };
  const go = (s: ScreenId) => setScreen(s);
  const run = async (key: string, work: () => Promise<string | void>) => {
    setBusy(key); setNotice(null);
    try { const done = await work(); if (done) setNotice({ text: done }); } catch (err) { setNotice({ text: errorText(err), error: true }); } finally { setBusy(null); await loadStatus(); }
  };
  const sync = (storeId?: string) => run('sync', async () => {
    const r = await call<{ results: Array<{ ok: boolean; indexed: number; removed: number; error?: string; complete: boolean }> }>('mailSync', { storeId });
    if (r.ok === false) throw new Error(r.error ?? 'Outlook did not answer');
    const bad = r.results.find((x) => !x.ok);
    if (bad) throw new Error(`Sync stopped: ${bad.error}`);
    const n = r.results.reduce((s, x) => s + x.indexed, 0); const gone = r.results.reduce((s, x) => s + x.removed, 0);
    return `Read ${n} message(s) from Outlook${gone ? `, removed ${gone} that are no longer there` : ''}${r.results.some((x) => !x.complete) ? '. The limit was reached, so the oldest part of the window is not indexed yet' : ''}.`;
  });

  const ctx = { status, authorized, open, go, sync, run, busy, setNotice, reload: loadStatus, onAskPandesh, onOpenBots, onOpenAutomations, narrow };
  const connector = status ? connectorWords(status.connector) : null;
  const unavailableHere = status && status.platform !== 'win32';

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Mail Hub / {SCREENS.find(([id]) => id === screen)?.[2]}</span>
        <span className="grow" />
        {connector && <span className={`mh-pill ${connector.tone === 'good' ? 'good' : connector.tone === 'alert' ? 'alert' : ''}`} title={connector.text}>{connector.tone === 'good' ? 'Outlook connected' : connector.tone === 'alert' ? 'Outlook unavailable' : 'Outlook idle'}</span>}
        <span className="mh-pill">Read-only</span>
        <button type="button" className="btn small" disabled={!authorized.length || busy === 'sync'} onClick={() => void sync()}>{busy === 'sync' ? 'Reading Outlook…' : 'Sync now'}</button>
      </div>
      <div className={`mh${narrow ? ' narrow' : ''}`}>
        <nav className="mh-nav" aria-label="Mail Hub screens">
          <div className="mh-nav-label">Workspace</div>
          {SCREENS.slice(0, 8).map(([id, icon, label]) => <NavBtn key={id} id={id} icon={icon} label={label} current={screen === id} counter={id === 'inbox' && status?.overview.unread ? status.overview.unread : null} onClick={() => go(id)} />)}
          <div className="mh-nav-label">Control &amp; trust</div>
          {SCREENS.slice(8).map(([id, icon, label]) => <NavBtn key={id} id={id} icon={icon} label={label} current={screen === id} counter={null} onClick={() => go(id)} />)}
        </nav>
        <div className="mh-work board" data-screen={screen}>
          {notice && <div className={`notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'} style={{ margin: '0 0 12px', maxWidth: 'none' }}>{notice.text}</div>}
          {unavailableHere && <div className="notice error" role="alert" style={{ margin: '0 0 12px', maxWidth: 'none' }}>Mail Hub reads Classic Outlook, which is only available on Windows.</div>}
          {status && !unavailableHere && status.connector.state === 'down' && <div className="notice error" role="alert" style={{ margin: '0 0 12px', maxWidth: 'none' }}>{connector?.text}. Showing what was indexed earlier; Pandesh keeps working. Start Classic Outlook and press Sync now.</div>}
          {!status && !notice && <div className="notice" role="status">Reading Mail Hub…</div>}
          {status && screen === 'overview' && <Overview ctx={ctx} />}
          {status && screen === 'inbox' && <Inbox ctx={ctx} />}
          {status && screen === 'reader' && <Reader ctx={ctx} id={readerId} />}
          {status && screen === 'assistant' && <Assistant ctx={ctx} />}
          {status && screen === 'finance' && <Finance ctx={ctx} />}
          {status && screen === 'career' && <Career ctx={ctx} />}
          {status && screen === 'calendar' && <CalendarScreen ctx={ctx} />}
          {status && screen === 'tasks' && <Tasks ctx={ctx} />}
          {status && screen === 'rules' && <Rules ctx={ctx} />}
          {status && screen === 'activity' && <Activity ctx={ctx} />}
          {status && screen === 'settings' && <SettingsScreen ctx={ctx} />}
        </div>
      </div>
    </>
  );
}

type Ctx = {
  status: MailStatus | null; authorized: MailAccount[]; open: (id: string) => void; go: (s: ScreenId) => void; sync: (storeId?: string) => Promise<void>; run: (k: string, w: () => Promise<string | void>) => Promise<void>;
  busy: string | null; setNotice: (n: Notice) => void; reload: () => Promise<void>; onAskPandesh: (t: string) => void; onOpenBots: () => void; onOpenAutomations: () => void; narrow: boolean;
};

function NavBtn({ id, icon, label, current, counter, onClick }: { id: string; icon: string; label: string; current: boolean; counter: number | null; onClick: () => void }) {
  return <button type="button" className={`mh-navbtn${current ? ' active' : ''}`} aria-current={current ? 'page' : undefined} data-screen-id={id} title={label} onClick={onClick}><span className="mh-navicon" aria-hidden="true">{icon}</span><span className="mh-navtext">{label}</span>{counter ? <span className="mh-counter">{counter > 999 ? '999+' : counter}</span> : null}</button>;
}

const Head = ({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) => <div className="mh-head"><div><h1>{title}</h1><p className="mh-muted">{sub}</p></div>{right}</div>;
const Box = ({ title, extra, children }: { title: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) => <div className="mh-card"><div className="mh-card-head"><h2>{title}</h2>{extra}</div>{children}</div>;
const Kpi = ({ title, value, sub }: { title: string; value: React.ReactNode; sub: string }) => <div className="mh-card mh-kpi"><div className="mh-muted small">{title}</div><div className="mh-value">{value}</div><div className="mh-muted xs">{sub}</div></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <div className="mh-empty">{children}</div>;

/** Shown in place of a screen's data when no account is authorized or nothing is indexed: no zero that looks like a result. */
function NeedsSetup({ ctx, what }: { ctx: Ctx; what: string }) {
  const none = ctx.authorized.length === 0;
  return (
    <div className="mh-card"><Empty>
      <p><strong>{none ? 'No Outlook account is authorized yet.' : 'Nothing is indexed yet.'}</strong></p>
      <p className="mh-muted">{none ? `Choose which accounts Pandesh may read (read-only) to see ${what}.` : `Press Sync now to read a bounded sample of recent mail from Outlook and show ${what}.`}</p>
      <div className="mh-btns" style={{ justifyContent: 'center', marginTop: 12 }}>{none ? <button type="button" className="btn small primary" onClick={() => ctx.go('settings')}>Open Settings</button> : <button type="button" className="btn small primary" disabled={ctx.busy === 'sync'} onClick={() => void ctx.sync()}>Sync now</button>}</div>
    </Empty></div>
  );
}
const ready = (ctx: Ctx) => ctx.authorized.length > 0 && (ctx.status?.overview.indexed ?? 0) > 0;

function useMessages(query: Record<string, unknown>, deps: unknown[]) {
  const [data, setData] = useState<ListState | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call<ListState>('mailMessages', query).then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, deps);
  return { data, error };
}

// ── Overview ─────────────────────────────────────────────────────────────────────────────────

function Overview({ ctx }: { ctx: Ctx }) {
  const [o, setO] = useState<MailOverview | null>(null);
  const idx = ctx.status?.overview.indexed ?? 0;
  useEffect(() => { let live = true; call<MailOverview>('mailOverview').then((d) => live && setO(d)).catch(() => undefined); return () => { live = false; }; }, [idx, ctx.status?.accounts.map((a) => a.lastSyncAt).join()]);
  const { data: fin } = useMessages({ category: 'finance', limit: 50, unread: true }, [idx]);
  if (!ready(ctx)) return <><Head title="Your email, under control" sub="Everything important, in one local-first workspace." /><NeedsSetup ctx={ctx} what="your overview" /></>;
  const c = ctx.status!.overview;
  const priority = o?.priority ?? [];
  const cats = (['career', 'finance', 'event', 'orders', 'security', 'other'] as MailCategory[]).map((k) => ({ k, n: c.byCategory[k] ?? 0 }));
  const max = Math.max(1, ...cats.map((x) => x.n));
  const lastSync = ctx.authorized.map((a) => a.lastSyncAt).filter(Boolean).sort().pop();
  return (
    <>
      <Head title="Your email, under control" sub={`From ${ctx.authorized.length} authorized account(s)${o?.dateRange ? `, ${o.dateRange.from.slice(0, 10)} to ${o.dateRange.to.slice(0, 10)}` : ''}${lastSync ? `. Last read from Outlook ${whenWords(lastSync)} ${new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.`}
        right={<button type="button" className="btn small primary" onClick={() => ctx.go('assistant')}>✧ Ask Pandesh</button>} />
      <div className="mh-grid4">
        <Kpi title="Unread (indexed)" value={c.unread} sub={`of ${c.indexed} indexed messages`} />
        <Kpi title="May need a reply" value={c.needsReply} sub="Unread, wording asks for an answer" />
        <Kpi title="Unread bills" value={fin?.total ?? '…'} sub="Finance mail, unread" />
        <Kpi title="Unread career" value={c.byCategory.career ?? 0} sub="Recruiters and applications" />
      </div>
      <div className="mh-split">
        <Box title="Priority queue" extra={<button type="button" className="btn link" onClick={() => ctx.go('tasks')}>View suggested tasks →</button>}>
          {priority.length === 0 && <Empty>Nothing unread stands out in the indexed mail.</Empty>}
          {priority.map((r) => (
            <button key={r.id} type="button" className="mh-item" onClick={() => ctx.open(r.id)}>
              <span className="mh-initial">{sender(r).slice(0, 2).toUpperCase()}</span>
              <span className="grow"><span className="mh-between"><strong className="small">{r.subject || '(no subject)'}</strong><Pill tone={pillTone(r.category)}>{r.facts.needsReply ? 'May need reply' : CATEGORY_LABEL[r.category]}</Pill></span>
                <span className="mh-muted small">{sender(r)} · {whenWords(r.received)}{r.facts.amounts[0] ? ` · ${r.facts.amounts[0].text}` : ''}</span></span>
            </button>
          ))}
          <div className="mh-notice">Priority is a fixed rule (unread and a category or a request in the text), not a model's opinion. Open a message to see its source.</div>
        </Box>
        <Box title="Unread by category">
          {cats.map(({ k, n }) => <div key={k}><div className="mh-between small"><strong>{CATEGORY_LABEL[k]}</strong><span className="mh-muted">{n}</span></div><div className="mh-progress"><i style={{ width: `${(n / max) * 100}%` }} /></div></div>)}
          <div className="mh-notice">Categories come from keywords in the sender, subject and text. “Other” means no rule matched.</div>
        </Box>
      </div>
    </>
  );
}

// ── Unified Inbox ────────────────────────────────────────────────────────────────────────────

const PAGE = 25;
function Inbox({ ctx }: { ctx: Ctx }) {
  const [filter, setFilter] = useState<'all' | 'unread' | 'reply' | 'attachments'>('all');
  const [account, setAccount] = useState('');
  const [text, setText] = useState(''); const [q, setQ] = useState(''); const [offset, setOffset] = useState(0);
  const { data, error } = useMessages({ unread: filter === 'unread', needsReply: filter === 'reply', q, store: account || undefined, limit: filter === 'attachments' ? 100 : PAGE, offset }, [filter, q, account, offset, ctx.status?.overview.indexed]);
  if (!ready(ctx)) return <><Head title="Unified Inbox" sub="One searchable view across your Outlook mail accounts." /><NeedsSetup ctx={ctx} what="your inbox" /></>;
  const rows = (data?.rows ?? []).filter((r) => filter !== 'attachments' || r.attachments > 0);
  return (
    <>
      <Head title="Unified Inbox" sub="Search runs on the local index of authorized accounts; Outlook is read again only when you open a message." right={<button type="button" className="btn small primary" onClick={() => ctx.go('assistant')}>Ask about mail</button>} />
      <div className="mh-card" style={{ marginBottom: 12 }}>
        <div className="mh-between"><div className="mh-filters" role="group" aria-label="Filter">{([['all', 'All'], ['unread', 'Unread'], ['reply', 'May need reply'], ['attachments', 'Attachments']] as const).map(([id, label]) => <button key={id} type="button" className={`mh-filter${filter === id ? ' selected' : ''}`} aria-pressed={filter === id} onClick={() => { setFilter(id); setOffset(0); }}>{label}</button>)}</div>
          <span className="mh-muted xs">{data ? `${data.total} message${data.total === 1 ? '' : 's'}` : ''}</span></div>
        <form className="mh-row" onSubmit={(e) => { e.preventDefault(); setQ(text); setOffset(0); }}>
          <label className="sr-only" htmlFor="mh-search">Search messages</label>
          <input id="mh-search" className="mh-field" placeholder="Search sender, subject and text…" value={text} onChange={(e) => setText(e.target.value)} />
          {ctx.authorized.length > 1 && <select className="mh-field" style={{ maxWidth: 220 }} aria-label="Account" value={account} onChange={(e) => { setAccount(e.target.value); setOffset(0); }}><option value="">All accounts</option>{ctx.authorized.map((a) => <option key={a.storeId} value={a.storeId}>{a.name}</option>)}</select>}
          <button type="submit" className="btn small">Search</button>{q && <button type="button" className="btn small" onClick={() => { setText(''); setQ(''); setOffset(0); }}>Clear</button>}
        </form>
      </div>
      {error && <div className="notice error" role="alert" style={{ maxWidth: 'none' }}>{error}</div>}
      <div className="mh-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="mh-scroll"><table className="mh-table"><thead><tr><th>Sender</th><th>Message</th><th>Category</th><th>Date</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="mh-mailrow" tabIndex={0} onClick={() => ctx.open(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') ctx.open(r.id); }}>
              <td className={r.unread ? 'unread' : ''} style={{ minWidth: 120 }}>{r.unread ? <i className="mh-dot" aria-label="unread" /> : null}{sender(r)}</td>
              <td style={{ minWidth: 200 }}><div className={r.unread ? 'unread' : ''}>{r.subject || '(no subject)'} {r.attachments > 0 ? <span title={`${r.attachments} attachment(s)`}>▣</span> : null}</div><div className="mh-muted xs">{r.snippet}</div></td>
              <td><Pill tone={pillTone(r.category)}>{CATEGORY_LABEL[r.category]}</Pill>{r.duplicates > 0 ? <span className="mh-muted xs" title="The same message is in more than one authorized account"> +{r.duplicates}</span> : null}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{whenWords(r.received)}</td>
            </tr>))}
            {data && rows.length === 0 && <tr><td colSpan={4}><Empty>No matching messages in the index.</Empty></td></tr>}
          </tbody></table></div>
      </div>
      {data && data.total > PAGE && filter !== 'attachments' && (
        <div className="mh-between" style={{ marginTop: 10 }}><span className="mh-muted xs">{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
          <span className="mh-btns"><button type="button" className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button><button type="button" className="btn small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older</button></span></div>
      )}
    </>
  );
}

// ── Email Reader ─────────────────────────────────────────────────────────────────────────────

/** Starts a question to the Inbox Assistant and waits for its answer; a local-model run takes a while. */
function useAsk(onNotice: (n: Notice) => void) {
  const [state, setState] = useState<{ question: string; running: boolean; run: MailAskRun | null } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  useEffect(() => stop, []);
  const ask = async (question: string) => {
    stop(); setState({ question, running: true, run: null });
    try { await call('mailAsk', { question }); } catch (err) { setState(null); onNotice({ text: errorText(err), error: true }); return; }
    const started = Date.now();
    timer.current = setInterval(async () => {
      try {
        const r = await call<{ running: boolean; run: MailAskRun | null }>('mailAskStatus');
        const mine = r.run && r.run.question === question && r.run.status !== 'running' ? r.run : null;
        if (mine || (!r.running && Date.now() - started > 8000 && r.run?.question === question)) { stop(); setState({ question, running: false, run: r.run }); }
        else if (Date.now() - started > 15 * 60_000) { stop(); setState({ question, running: false, run: null }); onNotice({ text: 'The Inbox Assistant did not answer in 15 minutes. Check My Bots.', error: true }); }
      } catch { /* keep waiting */ }
    }, 3000);
  };
  return { state, ask, clear: () => { stop(); setState(null); } };
}

function AiAnswer({ run }: { run: MailAskRun }) {
  const failed = run.status !== 'completed' || !run.report;
  return (
    <div>
      <div className="mh-between"><Basis kind="ai" /><span className="mh-muted xs">Local model · cites the messages it used</span></div>
      {failed ? <div className="mh-notice">No answer: {run.reason || 'the run did not finish'}.</div> : <div className="mh-answer">{run.report}</div>}
    </div>
  );
}

function Reader({ ctx, id }: { ctx: Ctx; id: string | null }) {
  const [d, setD] = useState<Detail | null>(null); const [err, setErr] = useState<string | null>(null);
  const ask = useAsk(ctx.setNotice);
  const [mode, setMode] = useState<'summary' | 'draft' | null>(null);
  useEffect(() => {
    setD(null); setErr(null); ask.clear(); setMode(null);
    if (!id) return;
    let live = true;
    call<{ message: Detail }>('mailMessage', { id }).then((r) => { if (!live) return; if (r.ok === false) setErr(r.error ?? 'Outlook did not answer'); else setD(r.message); }).catch((e) => live && setErr(errorText(e)));
    return () => { live = false; };
  }, [id]);
  if (!id) return <><Head title="Email Reader" sub="Open a message from the inbox, the overview or any finding." /><Box title="No message open"><Empty><button type="button" className="btn small primary" onClick={() => ctx.go('inbox')}>Go to the inbox</button></Empty></Box></>;
  if (err) return <><button type="button" className="btn link" onClick={() => ctx.go('inbox')}>← Back to inbox</button><div className="notice error" role="alert" style={{ maxWidth: 'none', marginTop: 8 }}>{err}</div></>;
  if (!d) return <div className="notice" role="status">Reading the message from Outlook…</div>;
  const r = d.row; const usable = ctx.status?.inboxAssistant.usesOutlookMail;
  const start = (m: 'summary' | 'draft') => { setMode(m); void ask.ask(m === 'summary' ? askAbout.summarize(r) : askAbout.draftReply(r)); };
  return (
    <>
      <button type="button" className="btn link" onClick={() => ctx.go('inbox')} style={{ marginBottom: 10 }}>← Back to inbox</button>
      <div className="mh-split">
        <div>
          <Box title={<><Pill tone={pillTone(r.category)}>{CATEGORY_LABEL[r.category]}</Pill> <span className="mh-muted xs">{r.account} / Inbox</span></>}>
            <h1 style={{ fontSize: 20, margin: '12px 0' }}>{r.subject || '(no subject)'}</h1>
            <div className="mh-between"><strong>{sender(r)}{r.fromAddress && r.fromName ? <span className="mh-muted xs"> &lt;{r.fromAddress}&gt;</span> : null}</strong><span className="mh-muted xs">{new Date(r.received).toLocaleString()}</span></div>
            <div className="mh-divider" />
            {/* Plain text only: Outlook's text body is shown as text, never as HTML, so a message cannot run anything here. */}
            <div className="mh-bodytext" data-testid="mail-body">{d.body || '(empty message)'}</div>
            {d.source === 'index' && d.note && <div className="mh-notice">{d.note}</div>}
            {d.attachments.length > 0 && <div className="mh-notice">▣ {d.attachments.length} attachment(s): {d.attachments.map((a) => `${a.name} (${bytesWords(a.size)})`).join(', ')}. Attachments are listed, not downloaded.</div>}
            <div className="mh-btns" style={{ marginTop: 12 }}>
              <button type="button" className="btn small" disabled={!usable || ask.state?.running} onClick={() => start('summary')}>✦ Summarize (local model)</button>
              <button type="button" className="btn small" disabled={!usable || ask.state?.running} onClick={() => start('draft')}>✎ Draft a reply (not sent)</button>
              <button type="button" className="btn small" onClick={() => ctx.onAskPandesh(`Use the Inbox Assistant to help me with the email [Mail ${r.id}]. (Only its id is in this chat: the sender, subject and text stay on this PC.)`)}>Ask Pandesh in chat</button>
            </div>
            {!usable && <div className="mh-notice">To summarize or draft, allow the Inbox Assistant to read Mail Hub in <button type="button" className="btn link" onClick={() => ctx.go('settings')}>Settings</button>.</div>}
          </Box>
          {ask.state && <div className="mh-card" style={{ marginTop: 12 }}><div className="mh-card-head"><h2>{mode === 'draft' ? 'Draft preview · not sent' : 'Summary'}</h2></div>
            {ask.state.running ? <div className="mh-notice" role="status">The local Inbox Assistant is reading this message. This can take a minute or two…</div> : ask.state.run ? <AiAnswer run={ask.state.run} /> : null}
            {mode === 'draft' && <div className="mh-notice">Nothing was sent. Sending is not available in Mail Hub; copy the text into your mail program if you want to use it.</div>}</div>}
        </div>
        <div>
          <Box title="What Pandesh found">
            <div className="mh-eyebrow">Signals <Basis kind="rule" /></div>
            <div className="mh-btns"><Pill tone={pillTone(r.category)}>{CATEGORY_LABEL[r.category]}</Pill>{r.facts.needsReply && <Pill tone="finance">May need a reply</Pill>}{r.attachments > 0 && <Pill>Attachment</Pill>}<Pill>{r.facts.confidence} confidence</Pill></div>
            {r.facts.amounts.length > 0 && <><div className="mh-divider" /><div className="mh-eyebrow">Amounts in the text <Basis kind="confirmed" /></div>{r.facts.amounts.map((a) => <div key={a.text} className="small">{a.text}</div>)}</>}
            {r.facts.dates.length > 0 && <><div className="mh-divider" /><div className="mh-eyebrow">Dates in the text <Basis kind="confirmed" /></div>{r.facts.dates.map((x) => <div key={x.text} className="small">{x.text}{x.yearInferred ? <span className="mh-muted xs"> (year assumed from the send date: confirm)</span> : null}</div>)}</>}
            <div className="mh-divider" /><p className="mh-muted xs">Every finding comes from this message. Suggestions are never carried out for you.</p>
          </Box>
          <div style={{ marginTop: 12 }}><Box title="Source &amp; permissions"><p className="small mh-muted">Account: {r.account}<br />Connector: Classic Outlook (read-only)<br />Text shown from: {d.source === 'outlook' ? 'Outlook, read just now' : 'the local index'}<br />AI processing: local model only</p></Box></div>
        </div>
      </div>
    </>
  );
}

// ── Ask Pandesh ──────────────────────────────────────────────────────────────────────────────

const EXAMPLES = ['What important messages arrived this week?', 'Which emails require a response?', 'Have recruiters responded to my applications?', 'Which invoices are due soon?', 'What appointments were mentioned in email?'];
function Assistant({ ctx }: { ctx: Ctx }) {
  const ask = useAsk(ctx.setNotice); const [text, setText] = useState('');
  const ia = ctx.status?.inboxAssistant;
  const allowed = Boolean(ia?.usesOutlookMail) && ready(ctx);
  return (
    <>
      <Head title="Ask Pandesh" sub="Questions about your authorized, indexed mail, answered by the Inbox Assistant on a local model." right={<Pill tone="good">Local model</Pill>} />
      {!ia?.exists && <div className="notice error" style={{ maxWidth: 'none', marginBottom: 12 }}>The Inbox Assistant does not exist yet. <button type="button" className="btn link" onClick={ctx.onOpenBots}>Create it in My Bots</button>.</div>}
      {ia?.exists && !ia.usesOutlookMail && <div className="notice" style={{ maxWidth: 'none', marginBottom: 12 }}>The Inbox Assistant may not read Mail Hub yet. <button type="button" className="btn link" onClick={() => ctx.go('settings')}>Allow it in Settings</button>.</div>}
      {!ready(ctx) && <NeedsSetup ctx={ctx} what="answers" />}
      <div className="mh-card">
        {ask.state && <><div className="mh-chat human"><div className="mh-bubble">{ask.state.question}</div></div>
          <div className="mh-chat"><div className="mh-bubble">{ask.state.running ? <span role="status">Searching the index and asking the local model… this can take a minute or two.</span> : ask.state.run ? <AiAnswer run={ask.state.run} /> : 'No answer.'}</div></div></>}
        {!ask.state && <div className="mh-chat"><div className="mh-bubble"><strong>✦ Inbox Assistant</strong><p style={{ marginTop: 8 }}>Ask me to find messages, summarize a conversation, list bills or follow-ups. I only use the indexed mail of accounts you authorized, and I cite the message for each point.</p></div></div>}
        <p className="small mh-muted" style={{ margin: '18px 0 8px' }}>Example questions</p>
        <div className="mh-btns">{EXAMPLES.map((e) => <button key={e} type="button" className="btn small" disabled={!allowed || ask.state?.running} onClick={() => void ask.ask(e)}>{e}</button>)}</div>
        <form className="mh-row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void ask.ask(text.trim()); setText(''); } }}>
          <label className="sr-only" htmlFor="mh-ask">Ask about your mail</label>
          <input id="mh-ask" className="mh-field" placeholder="Ask about your messages…" value={text} disabled={!allowed} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn small primary" disabled={!allowed || ask.state?.running || !text.trim()}>Ask →</button>
        </form>
        <p className="mh-muted xs" style={{ marginTop: 8 }}>The answer is the model's reading of your mail, not a fact: open the cited message to check. The index holds recent mail only.</p>
      </div>
    </>
  );
}

// ── Finance, Career, Calendar, Tasks ─────────────────────────────────────────────────────────

function MessageLink({ row, ctx }: { row: MailRow; ctx: Ctx }) { return <button type="button" className="btn link" onClick={() => ctx.open(row.id)}>Open source email</button>; }

function Finance({ ctx }: { ctx: Ctx }) {
  const { data } = useMessages({ category: 'finance', limit: 100 }, [ctx.status?.overview.indexed]);
  if (!ready(ctx)) return <><Head title="Finance & Documents" sub="Invoices, billing deadlines and receipts with evidence." /><NeedsSetup ctx={ctx} what="bills and receipts" /></>;
  const v = financeView(data?.rows ?? []);
  return (
    <>
      <Head title="Finance & Documents" sub="Amounts and dates are read from the message text. Verify each one at its source." right={<button type="button" className="btn small" onClick={() => ctx.go('inbox')}>Search the inbox</button>} />
      <div className="mh-grid3"><Kpi title="Upcoming, unread" value={v.due.length} sub={v.due.length ? `Named amounts: ${v.dueTotal}` : 'No unread bill names a future date'} /><Kpi title="Finance messages" value={data?.total ?? '…'} sub="In the indexed window" /><Kpi title="With attachments" value={v.withAttachment} sub="Listed, never downloaded" /></div>
      <div className="space" />
      <Box title="Upcoming payments" extra={<Basis kind="confirmed" />}>
        {v.due.length === 0 && <Empty>No unread finance message in the index names a date that is still ahead.</Empty>}
        {v.due.map(({ row, amount, date }) => <div key={row.id} className="mh-between mh-line"><div><strong>{row.subject}</strong><p className="small mh-muted">{sender(row)} · {date.text}{date.yearInferred ? ' (year assumed)' : ''}</p><MessageLink row={row} ctx={ctx} /></div><strong>{amount ? amount.text : 'amount not stated'}</strong></div>)}
        <div className="mh-notice">An emailed bill may not be genuine and may already be paid. Pandesh does not pay anything.</div>
      </Box>
      <div className="space" />
      <Box title="Extracted records">
        <div className="mh-scroll"><table className="mh-table"><thead><tr><th>Message</th><th>Sender</th><th>Amount</th><th>Date</th></tr></thead><tbody>
          {v.records.map((r) => <tr key={r.id} className="mh-mailrow" tabIndex={0} onClick={() => ctx.open(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') ctx.open(r.id); }}><td>{r.subject}{r.attachments ? ' ▣' : ''}</td><td>{sender(r)}</td><td>{r.facts.amounts[0]?.text ?? '—'}</td><td>{r.facts.dates[0]?.iso ?? whenWords(r.received)}</td></tr>)}
          {v.records.length === 0 && <tr><td colSpan={4}><Empty>No finance mail in the index.</Empty></td></tr>}</tbody></table></div>
      </Box>
    </>
  );
}

const STAGES: Array<[CareerStage, string]> = [['reply', 'Needs a reply'], ['interview', 'Interview or call'], ['applied', 'Applications acknowledged'], ['other', 'Other recruiter mail']];
function Career({ ctx }: { ctx: Ctx }) {
  const { data } = useMessages({ category: 'career', limit: 100 }, [ctx.status?.overview.indexed]);
  if (!ready(ctx)) return <><Head title="Career & Applications" sub="Follow recruiter conversations without losing context." /><NeedsSetup ctx={ctx} what="recruiter mail" /></>;
  const v = careerView(data?.rows ?? []);
  return (
    <>
      <Head title="Career & Applications" sub="Sorted by fixed rules from the wording of each message; open one to check." right={<button type="button" className="btn small primary" onClick={() => ctx.onAskPandesh('Have recruiters responded to my applications? Use the Inbox Assistant and the Mail Hub index.')}>Ask about career mail</button>} />
      <div className="mh-grid3"><Kpi title="Career messages" value={v.total} sub="In the indexed window" /><Kpi title="May need a reply" value={v.needsReply} sub="Unread and asks for an answer" /><Kpi title="Unread" value={v.unread} sub="Career mail" /></div>
      <div className="space" />
      <div className="mh-grid2">{STAGES.map(([stage, label]) => (
        <Box key={stage} title={label} extra={<Pill>{v.stages[stage].length}</Pill>}>
          {v.stages[stage].length === 0 && <p className="small mh-muted">Nothing here.</p>}
          {v.stages[stage].slice(0, 6).map((r) => <button key={r.id} type="button" className="mh-item" onClick={() => ctx.open(r.id)}><span className="grow"><strong className="small">{r.subject}</strong><span className="mh-muted small" style={{ display: 'block' }}>{sender(r)} · {whenWords(r.received)}</span></span></button>)}
        </Box>))}</div>
    </>
  );
}

function CalendarScreen({ ctx }: { ctx: Ctx }) {
  const { data } = useMessages({ limit: 100 }, [ctx.status?.overview.indexed]);
  const now = useMemo(() => new Date(), []);
  if (!ready(ctx)) return <><Head title="Calendar & Appointments" sub="Dates extracted from emails; no events are created." /><NeedsSetup ctx={ctx} what="dates" /></>;
  const dates = detectedDates(data?.rows ?? [], now);
  const strip = weekStrip(now, dates);
  return (
    <>
      <Head title="Calendar & Appointments" sub="Dates found in message text. Pandesh does not write to any calendar: confirm each date at its source." />
      <div className="mh-split">
        <Box title={`Week of ${strip[0].day} ${new Date(now.getFullYear(), now.getMonth(), strip[0].day).toLocaleDateString(undefined, { month: 'long' })}`}>
          <div className="mh-week">{strip.map((d) => <div key={d.ymd} className="mh-weekhead xs mh-muted">{d.weekday}</div>)}{strip.map((d) => <div key={d.ymd} className={`mh-day${d.today ? ' today' : ''}${d.count ? ' has-event' : ''}`} title={d.count ? `${d.count} date(s) found in mail` : undefined}>{d.day}</div>)}</div>
          <div className="mh-notice">A dot marks a day that some indexed message names. It is not a calendar entry.</div>
        </Box>
        <Box title="Detected dates" extra={<Basis kind="confirmed" />}>
          {dates.length === 0 && <Empty>No indexed message names a date in the next 45 days.</Empty>}
          {dates.slice(0, 12).map((d) => <div key={`${d.row.id}:${d.iso}`} className="mh-line"><div className="mh-between"><strong className="small">{new Date(`${d.iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>{d.yearInferred && <Pill tone="finance">Confirm year</Pill>}</div><div className="small">{d.row.subject}</div><div className="mh-muted xs">“{d.text}” · {sender(d.row)}</div><MessageLink row={d.row} ctx={ctx} /></div>)}
        </Box>
      </div>
    </>
  );
}

function Tasks({ ctx }: { ctx: Ctx }) {
  const { data } = useMessages({ unread: true, limit: 100 }, [ctx.status?.overview.indexed]);
  if (!ready(ctx)) return <><Head title="Tasks & Follow-ups" sub="Suggestions remain proposals until you approve them." /><NeedsSetup ctx={ctx} what="suggested tasks" /></>;
  const tasks = suggestedTasks(data?.rows ?? []);
  return (
    <>
      <Head title="Tasks & Follow-ups" sub="Suggested from unread mail by fixed rules. “Hand to Pandesh” opens a chat request; anything it does there goes through the normal approval cards." right={<Pill>{tasks.length} suggested</Pill>} />
      <div className="mh-split">
        <Box title="Suggested actions">
          {tasks.length === 0 && <Empty>No unread mail asks for a reply, names a bill date, or names an event date.</Empty>}
          {tasks.map((t) => <div key={t.id} className="mh-task"><div className="grow"><strong className="small">{t.title}</strong><p className="small mh-muted">{t.why}</p><div className="mh-btns" style={{ marginTop: 6 }}><Pill tone={t.kind === 'bill' ? 'finance' : t.kind === 'reply' ? 'career' : ''}>{t.kind === 'bill' ? 'Bill' : t.kind === 'reply' ? 'Reply' : 'Date'}</Pill>{t.due && <Pill>{t.due}</Pill>}<MessageLink row={t.row} ctx={ctx} /><button type="button" className="btn link" onClick={() => ctx.onAskPandesh(`Use the Inbox Assistant to propose the steps for the ${t.kind} task from [Mail ${t.row.id}]. Do not send, pay or create anything without my approval. (Only the id is in this chat: the mail itself stays on this PC.)`)}>Hand to Pandesh</button></div></div></div>)}
        </Box>
        <Box title="Safety controls"><p className="small mh-muted">✓ No automatic sending<br />✓ No payment execution<br />✓ No calendar writes<br />✓ No mailbox changes (read-only)<br />✓ Every suggestion links to its source email</p></Box>
      </div>
    </>
  );
}

// ── Smart Rules ──────────────────────────────────────────────────────────────────────────────

function Rules({ ctx }: { ctx: Ctx }) {
  const ia = ctx.status?.inboxAssistant;
  const [routines, setRoutines] = useState<Array<{ id: string; title: string; dailyTime: string | null; enabled: boolean; nextRunAt: string | null }> | null>(null);
  const load = useCallback(async () => {
    if (!ia?.botId) { setRoutines([]); return; }
    try { const d = await call<{ bot: { routines: Array<{ id: string; title: string; dailyTime: string | null; enabled: boolean; nextRunAt: string | null }> } }>('bot', { id: ia.botId }); setRoutines(d.bot?.routines ?? []); } catch { setRoutines([]); }
  }, [ia?.botId]);
  useEffect(() => { void load(); }, [load]);
  const add = () => ctx.run('routine', async () => { await call('botRoutineAdd', { id: ia!.botId, title: 'Morning mail summary (Mail Hub)', dailyTime: '07:30', enabled: true }); await load(); return 'Added a daily 07:30 routine to the Inbox Assistant. It refreshes the index first when it is older than 30 minutes. Core\'s scheduler runs it; see Automations.'; });
  const builtIn: Array<[string, string]> = [['Priority detection', 'Unread messages with a category or a request for an answer are listed first.'], ['Finance extraction', 'Amounts and dates in bills and receipts are read from the text.'], ['Career classification', 'Recruiter, interview and application wording is recognised.'], ['Calendar suggestions', 'Dates in the text are listed for you to confirm; no event is created.']];
  return (
    <>
      <Head title="Smart Rules" sub="What Pandesh analyzes and when. Everything here is read-only." right={<Pill tone="good">No mailbox writes</Pill>} />
      <Box title="Built-in classification" extra={<span className="mh-muted xs">Always on · runs on the local index</span>}>
        {builtIn.map(([t, d]) => <div key={t} className="mh-cfg"><div><strong className="small">{t}</strong><p className="small mh-muted">{d}</p></div><Pill tone="good">On</Pill></div>)}
        <div className="mh-notice">These are fixed rules, not settings you can break. Moving, archiving, labelling or deleting mail is not offered in this version.</div>
      </Box>
      <div className="space" />
      <Box title="Scheduled mail routine" extra={<button type="button" className="btn link" onClick={ctx.onOpenAutomations}>Open Automations</button>}>
        {!ia?.exists && <p className="small mh-muted">The Inbox Assistant does not exist yet. Create it in My Bots, then schedule a routine here.</p>}
        {ia?.exists && !ia.usesOutlookMail && <p className="small mh-muted">Allow the Inbox Assistant to read Mail Hub in Settings first.</p>}
        {ia?.exists && ia.usesOutlookMail && <>
          {(routines ?? []).map((r) => <div key={r.id} className="mh-cfg"><div><strong className="small">{r.title}</strong><p className="small mh-muted">Daily {r.dailyTime ?? ''} · {r.enabled ? (r.nextRunAt ? `next ${new Date(r.nextRunAt).toLocaleString()}` : 'on') : 'paused'}</p></div><Pill tone={r.enabled ? 'good' : ''}>{r.enabled ? 'Scheduled' : 'Paused'}</Pill></div>)}
          {routines && routines.length === 0 && <p className="small mh-muted">No routine yet. Core's existing scheduler runs routines; Mail Hub adds no scheduler of its own.</p>}
          <div className="mh-btns" style={{ marginTop: 10 }}><button type="button" className="btn small" disabled={ctx.busy === 'routine'} onClick={() => void add()}>Add a daily 07:30 routine</button></div>
        </>}
      </Box>
    </>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────

function Activity({ ctx }: { ctx: Ctx }) {
  const [d, setD] = useState<{ activity: Array<{ id: number; at: string; kind: string; ok: boolean; detail: string }> } | null>(null);
  useEffect(() => { let live = true; call<{ activity: Array<{ id: number; at: string; kind: string; ok: boolean; detail: string }> }>('mailActivity').then((r) => live && setD(r)).catch(() => undefined); return () => { live = false; }; }, [ctx.status?.accounts.map((a) => a.lastSyncAt).join(), ctx.status?.connector.lastOkAt]);
  const c = ctx.status!.connector; const w = connectorWords(c);
  const kind: Record<string, string> = { discover: 'Accounts discovered', authorize: 'Access granted', revoke: 'Access revoked', sync: 'Sync', read: 'Message read', clear: 'Index cleared', inference: 'Question to local model' };
  return (
    <>
      <Head title="Activity & Audit" sub="What Pandesh read, indexed and asked. No message text is kept in this log." right={<Pill tone={w.tone === 'good' ? 'good' : w.tone === 'alert' ? 'alert' : ''}>{w.tone === 'good' ? 'Connected' : w.tone === 'alert' ? 'Unavailable' : 'Idle'}</Pill>} />
      <div className="mh-split">
        <Box title="Recent operations">
          {(d?.activity ?? []).length === 0 && <Empty>Nothing yet.</Empty>}
          <div className="mh-timeline">{(d?.activity ?? []).map((a) => <div key={a.id} className="mh-log"><div className="mh-between"><strong className="small">{kind[a.kind] ?? a.kind}{a.ok ? '' : ' (failed)'}</strong><span className="mh-muted xs">{new Date(a.at).toLocaleString()}</span></div><p className="small mh-muted">{a.detail}</p></div>)}</div>
        </Box>
        <Box title="Connector health">
          <div className="small"><strong>{w.text}</strong></div>
          <p className="small mh-muted" style={{ marginTop: 6 }}>Last answer: {c.lastOkAt ? new Date(c.lastOkAt).toLocaleString() : 'never'}<br />Worker restarts: {c.restarts} · Waiting calls: {c.queued}<br />Runs in its own process, with a timeout on every call.</p>
          <div className="mh-divider" /><p className="small mh-muted">✓ Read-only: no mail sent, moved, deleted or marked<br />✓ Local model only for private mail<br />✓ Each finding links to its source email</p>
        </Box>
      </div>
    </>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

const SETTING_FIELDS: Array<[keyof MailSettings, string, string]> = [['windowDays', 'Days of mail to index', 'The first read covers this many days'], ['maxPerAccount', 'Messages kept per account', 'The oldest leave the index first'], ['maxPerSync', 'Messages read per sync', 'A sync stops at this many'], ['bodyChars', 'Text kept per message (characters)', '0 keeps only sender and subject'], ['retentionDays', 'Keep mail in the index for (days)', 'Older mail is removed']];

function SettingsScreen({ ctx }: { ctx: Ctx }) {
  const s = ctx.status!;
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [draft, setDraft] = useState<MailSettings>(s.settings);
  const [advanced, setAdvanced] = useState(false);
  const list = accounts ?? s.accounts;
  const discover = () => ctx.run('discover', async () => { const r = await call<{ accounts: MailAccount[] }>('mailDiscover'); if (r.ok === false) throw new Error(r.error ?? 'Outlook did not answer'); setAccounts(r.accounts); return `Found ${r.accounts.length} Outlook account(s). Nothing is read until you authorize one.`; });
  const authorize = (a: MailAccount, enabled: boolean) => ctx.run('auth', async () => { const r = await call<{ accounts: MailAccount[] }>('mailAuthorize', { storeId: a.storeId, enabled }); if (r.ok === false) throw new Error(r.error ?? 'failed'); setAccounts((cur) => (cur ?? list).map((x) => (x.storeId === a.storeId ? { ...x, enabled } : x))); return enabled ? `${a.name} authorized for read-only access. Press Sync now to read a bounded sample.` : `${a.name} revoked and its indexed mail removed. Outlook itself was not touched.`; });
  const save = () => ctx.run('settings', async () => { await call('mailSettings', { settings: draft }); return 'Saved. Limits apply from the next sync.'; });
  const clear = () => { if (window.confirm('Remove all indexed mail from Pandesh? Outlook itself is not touched.')) void ctx.run('clear', async () => { await call('mailClear', {}); return 'The local index was emptied.'; }); };
  const allowBot = (enabled: boolean) => ctx.run('bot', async () => { await call('mailInboxAssistant', { enabled }); return enabled ? 'The Inbox Assistant may now read the Mail Hub index (read-only, local model).' : 'The Inbox Assistant no longer reads Mail Hub.'; });
  return (
    <>
      <Head title="Settings & Privacy" sub="Choose what Pandesh may read. Nothing is read until you authorize an account." right={<Pill tone="good">Local-first</Pill>} />
      <Box title="Outlook accounts" extra={<button type="button" className="btn small" disabled={ctx.busy === 'discover'} onClick={() => void discover()}>{ctx.busy === 'discover' ? 'Asking Outlook…' : 'Find accounts in Outlook'}</button>}>
        {list.length === 0 && <Empty>No accounts yet. Make sure Classic Outlook is installed, then press “Find accounts in Outlook”. It lists names and counts only.</Empty>}
        {list.map((a) => (
          <div key={a.storeId} className="mh-cfg"><div><strong className="small">{a.name}</strong><p className="small mh-muted">{a.enabled ? `Authorized ${a.authorizedAt ? new Date(a.authorizedAt).toLocaleDateString() : ''} · ${a.indexed ?? 0} indexed${a.lastSyncAt ? ` · last read ${new Date(a.lastSyncAt).toLocaleString()}` : ' · not read yet'}` : 'Not authorized: Pandesh does not read this account.'}{typeof a.inboxItems === 'number' ? ` · Outlook inbox: ${a.inboxItems} items, ${a.inboxUnread ?? 0} unread` : ''}{a.lastError ? ` · last error: ${a.lastError}` : ''}</p></div>
            <span className="mh-btns">{a.enabled && <button type="button" className="btn small" disabled={ctx.busy === 'sync'} onClick={() => void ctx.sync(a.storeId)}>Sync</button>}<button type="button" className={`mh-toggle${a.enabled ? ' on' : ''}`} role="switch" aria-checked={a.enabled} aria-label={`${a.enabled ? 'Revoke' : 'Authorize'} ${a.name}`} onClick={() => void authorize(a, !a.enabled)} /></span></div>))}
        <div className="mh-notice">Start with one account. Revoking an account also removes what was indexed from it.</div>
      </Box>
      <div className="space" />
      <div className="mh-grid2">
        <Box title="Inbox Assistant"><p className="small mh-muted" style={{ marginBottom: 10 }}>Ask Pandesh, summaries and routines use the Inbox Assistant from My Bots (a local Hermes profile). It reads this index as one more source; Gmail stays as it was.</p>
          {s.inboxAssistant.exists ? <div className="mh-cfg"><span className="small">Allow it to read Mail Hub</span><button type="button" className={`mh-toggle${s.inboxAssistant.usesOutlookMail ? ' on' : ''}`} role="switch" aria-checked={s.inboxAssistant.usesOutlookMail} aria-label="Allow the Inbox Assistant to read Mail Hub" onClick={() => void allowBot(!s.inboxAssistant.usesOutlookMail)} /></div> : <p className="small">It does not exist yet. <button type="button" className="btn link" onClick={ctx.onOpenBots}>Create it in My Bots</button>.</p>}</Box>
        <Box title="Privacy">
          {[['Mail access', 'Read-only'], ['Where the index lives', 'Pandesh database on this PC'], ['Index protection', 'Your Windows account’s file permissions (not separately encrypted)'], ['Attachments', 'Names and sizes only; never downloaded'], ['Sending, moving, deleting, marking', 'Not available'], ['Cloud models', 'Never receive mail; no automatic fallback']].map(([k, v]) => <div key={k} className="mh-cfg"><span className="small">{k}</span><strong className="small" style={{ textAlign: 'right' }}>{v}</strong></div>)}
        </Box>
      </div>
      <div className="space" />
      <Box title="Storage" extra={<button type="button" className="btn small" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>{advanced ? 'Hide limits' : 'Limits'}</button>}>
        <p className="small mh-muted">{s.storage.messages} message(s) indexed, about {bytesWords(s.storage.approxBytes)}.</p>
        {advanced && <div style={{ marginTop: 10 }}>{SETTING_FIELDS.map(([k, label, hint]) => <label key={k} className="mh-cfg"><span><strong className="small">{label}</strong><span className="small mh-muted" style={{ display: 'block' }}>{hint}</span></span><input className="mh-field" style={{ width: 110 }} type="number" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /></label>)}<div className="mh-btns" style={{ marginTop: 10 }}><button type="button" className="btn small primary" disabled={ctx.busy === 'settings'} onClick={() => void save()}>Save limits</button></div></div>}
        <div className="mh-btns" style={{ marginTop: 12 }}><button type="button" className="btn small" disabled={s.storage.messages === 0 || ctx.busy === 'clear'} onClick={clear}>Remove all indexed mail</button></div>
      </Box>
      <div className="mh-notice">Mail Hub needs Classic Outlook running in your signed-in Windows session. A background service cannot use Outlook this way.</div>
    </>
  );
}
