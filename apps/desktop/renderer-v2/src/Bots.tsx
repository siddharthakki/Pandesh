import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from './bridge';
import {
  TONE_COLOR, botStatus, createProblem, permissionSummary, proposalRequest, runWords, scheduleWords, triggerWords, validDailyTime, whenWords,
  type Bot, type BotDetail, type BotSourceId, type BotsResponse,
} from './botsModel';

type Notice = { text: string; error?: boolean } | null;
const call = <T,>(action: string, args?: Record<string, unknown>) => api.household(action, args) as Promise<T>;

/**
 * My Bots: each Bot is a Hermes profile with its own memory. A Bot reads only what is ticked for it and reports;
 * it cannot change anything. What it proposes is handed to Pandesh as an ordinary request, where approvals apply.
 */
export function Bots({ onOpenConversation, onAskPandesh }: { onOpenConversation: (id: string) => void; onAskPandesh: (text: string) => void }) {
  const [data, setData] = useState<BotsResponse | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const alive = useRef(true);

  const load = async (refresh = false) => {
    try { const d = await call<BotsResponse>('bots', refresh ? { refresh: true } : undefined); if (alive.current) setData(d); }
    catch (err) { if (alive.current) setNotice({ text: errorText(err), error: true }); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  // While a Bot is working, look again every few seconds so "Working now" turns into its result.
  const anyRunning = Boolean(data?.bots.some((b) => b.running));
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(key); setNotice(null);
    try { await work(); if (done) setNotice({ text: done }); } catch (err) { setNotice({ text: errorText(err), error: true }); } finally { setBusy(null); await load(); }
  };

  const open = data?.bots.find((b) => b.id === openId) ?? null;
  const missing = (data?.standard ?? []).filter((s) => !s.exists);

  return (
    <>
      <div className="topbar">
        <span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>{open ? <button type="button" className="btn link" onClick={() => setOpenId(null)}>My Bots</button> : 'My Bots'}{open ? ` / ${open.name}` : ''}</span>
        <span className="grow" />
        {!open && <button type="button" className="btn small primary" disabled={!data?.hermes.available} onClick={() => setCreating((v) => !v)}>{creating ? 'Close' : 'New Bot'}</button>}
        <button type="button" className="btn small" onClick={() => void load(true)}>Refresh</button>
      </div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {notice && <div className={`notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'} style={{ margin: 0, maxWidth: 'none' }}>{notice.text}</div>}
        {!data && !notice && <div className="notice" role="status">Reading your Bots…</div>}
        {data && !data.hermes.available && (
          <div className="notice error" role="alert" style={{ margin: 0, maxWidth: 'none' }}>
            Bots cannot run right now: {data.hermes.reason ?? 'Hermes is not available'}. Nothing is run on another engine instead. Chat, missions and your other routines are not affected.
          </div>
        )}

        {data && !open && (
          <>
            <p className="settings-note">A Bot has its own memory and a job. It only reads what you tick for it and tells you what it found; anything it proposes needs your approval in Pandesh.{data.hermes.available ? ` Runs on Hermes ${data.hermes.version}, on a local model.` : ''}</p>
            {creating && <CreateBot data={data} busy={busy === 'create'} onCancel={() => setCreating(false)}
              onCreate={(input) => void run('create', async () => { await call('botCreate', input); setCreating(false); }, `${input.name} created. Give it a routine, or ask it something.`)} />}
            {data.bots.length === 0 && !creating && <div className="empty" style={{ color: 'var(--faint)' }}>No Bots yet.</div>}
            <div className="bot-grid">
              {data.bots.map((b) => <BotCard key={b.id} bot={b} data={data} onOpen={() => setOpenId(b.id)} />)}
            </div>
            {missing.length > 0 && (
              <section className="card" aria-label="Standard Bots">
                <span className="title">Ready-made Bots</span>
                <ul className="bot-list">{missing.map((s) => <li key={s.kind}><strong>{s.name}</strong>: {s.responsibility}</li>)}</ul>
                <p className="settings-note">Each is created with its routine switched off; you turn it on when you want it.</p>
                <div className="actions">
                  <button type="button" className="btn small primary" disabled={Boolean(busy) || !data.hermes.available} onClick={() => void run('standard', () => call('botsStandard', {}), 'Created. Their routines are off until you switch them on.')}>{busy === 'standard' ? 'Creating…' : `Create ${missing.length === 1 ? 'it' : `these ${missing.length}`}`}</button>
                </div>
              </section>
            )}
            {data.otherProfiles.length > 0 && (
              <details className="card">
                <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Other Hermes profiles on this PC ({data.otherProfiles.length})</summary>
                <p className="settings-note">These belong to Hermes itself. Pandesh shows them and never runs them.</p>
                <ul className="bot-list">{data.otherProfiles.map((p) => <li key={p.name}><strong>{p.name}</strong>{p.model ? ` · ${p.model}` : ''}{p.localOnly ? ' · local model' : ' · may use a cloud model'}{p.description ? ` · ${p.description}` : ''}</li>)}</ul>
              </details>
            )}
          </>
        )}

        {data && open && <BotPage key={open.id} bot={open} data={data} busy={busy} run={run} onOpenConversation={onOpenConversation} onAskPandesh={onAskPandesh} onRemoved={() => setOpenId(null)} />}
      </div>
    </>
  );
}

function BotCard({ bot, data, onOpen }: { bot: Bot; data: BotsResponse; onOpen: () => void }) {
  const status = botStatus(bot, data.hermes);
  const last = runWords(bot.lastRun);
  return (
    <button type="button" className="card bot-card" onClick={onOpen} aria-label={`Open ${bot.name}`}>
      <span className="title" style={{ fontSize: 16 }}>{bot.name}</span>
      <span style={{ fontSize: 14, color: TONE_COLOR[status.tone], fontWeight: 500 }}>{status.text}</span>
      <span className="bot-clamp">{bot.responsibility}</span>
      <span className="meta">Reads: {bot.sourcesDetail.map((s) => s.label).join(', ') || 'nothing'}</span>
      <span className="meta" style={{ color: TONE_COLOR[last.tone] }}>Last: {last.text}</span>
    </button>
  );
}

function CreateBot({ data, busy, onCreate, onCancel }: { data: BotsResponse; busy: boolean; onCreate: (input: { name: string; responsibility: string; instructions: string; sources: BotSourceId[] }) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [instructions, setInstructions] = useState('');
  const [sources, setSources] = useState<BotSourceId[]>([]);
  const [problem, setProblem] = useState('');
  const perms = permissionSummary(data.sources.filter((s) => sources.includes(s.id)));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = createProblem({ name, responsibility, sources }, data.bots);
    if (p) { setProblem(p); return; }
    setProblem('');
    onCreate({ name: name.trim(), responsibility: responsibility.trim(), instructions: instructions.trim(), sources });
  };
  return (
    <form className="card" aria-label="New Bot" onSubmit={submit}>
      <span className="title" style={{ fontSize: 16 }}>New Bot</span>
      <label className="bot-field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Travel Planner" /></label>
      <label className="bot-field">What is it responsible for?<textarea value={responsibility} onChange={(e) => setResponsibility(e.target.value)} rows={2} maxLength={600} /></label>
      <label className="bot-field">How should it work and report? (optional)<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={4000} /></label>
      <fieldset className="settings-fieldset">
        <legend>What it may read</legend>
        {data.sources.map((s) => (
          <label key={s.id} className="settings-choice">
            <input type="checkbox" checked={sources.includes(s.id)} onChange={(e) => setSources((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} />
            <span><strong>{s.label}</strong><br /><span className="settings-sub">{s.reads}{s.privateData ? ' Stays on this PC.' : ''}</span></span>
          </label>
        ))}
      </fieldset>
      {sources.length > 0 && <p className="settings-note">It can read the above and nothing else. It always needs your approval for: {perms.asks.join('; ')}.</p>}
      {problem && <p className="perm-error" role="alert">{problem}</p>}
      <div className="actions">
        <button type="submit" className="btn small primary" disabled={busy}>{busy ? 'Creating…' : 'Create Bot'}</button>
        <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function BotPage({ bot, data, busy, run, onOpenConversation, onAskPandesh, onRemoved }: {
  bot: Bot; data: BotsResponse; busy: string | null; run: (key: string, work: () => Promise<unknown>, done?: string) => Promise<void>;
  onOpenConversation: (id: string) => void; onAskPandesh: (text: string) => void; onRemoved: () => void;
}) {
  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [question, setQuestion] = useState('');
  const [time, setTime] = useState('08:00');
  const [every, setEvery] = useState(1);
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [responsibility, setResponsibility] = useState(bot.responsibility);
  const [repoPath, setRepoPath] = useState(bot.settings.repoPath ?? '');
  const [openRun, setOpenRun] = useState<string | null>(null);
  const status = botStatus(bot, data.hermes);
  const canRun = data.hermes.available && bot.profileOk && !bot.running && bot.status === 'active';

  const loadDetail = async () => { try { const d = await call<BotDetail>('bot', { id: bot.id }); setDetail(d); } catch { /* the page keeps its last copy */ } };
  // Re-read when the Bot finishes a run, or when its record changes.
  useEffect(() => { void loadDetail(); }, [bot.id, bot.running, bot.lastRun?.id, bot.lastRun?.status, bot.routines.length]);

  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    void run(`run:${bot.id}`, async () => { await call('botRun', { id: bot.id, question: q || undefined }); setQuestion(''); }, q ? `${bot.name} is working on it. The answer appears under Recent results and in its conversation.` : `${bot.name} is running now.`);
  };
  const perms = permissionSummary(bot.sourcesDetail);

  return (
    <>
      <section className="card" aria-label={bot.name}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className="title" style={{ fontSize: 18 }}>{bot.name}</span>
          <span style={{ fontSize: 14, color: TONE_COLOR[status.tone], fontWeight: 500 }} role="status">{status.text}</span>
        </div>
        <span style={{ fontSize: 14 }}>{bot.responsibility}</span>
        <span className="meta">Hermes profile {bot.profile} · model {bot.model} (local) · memory kept by Hermes</span>
        <div className="actions">
          {bot.status === 'active'
            ? <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run('pause', () => call('botUpdate', { id: bot.id, status: 'paused' }), `${bot.name} is paused. Its routines are recorded as skipped until you resume it.`)}>Pause</button>
            : <button type="button" className="btn small primary" disabled={Boolean(busy)} onClick={() => void run('resume', () => call('botUpdate', { id: bot.id, status: 'active' }), `${bot.name} is active again.`)}>Resume</button>}
          {bot.conversationId && <button type="button" className="btn small" onClick={() => onOpenConversation(bot.conversationId as string)}>Open its conversation</button>}
          <button type="button" className="btn small" onClick={() => { setEditing((v) => !v); setInstructions(detail?.instructions ?? ''); }}>{editing ? 'Close editing' : 'Edit'}</button>
          <button type="button" className="btn small" disabled={Boolean(busy) || bot.running} onClick={() => { if (window.confirm(`Remove ${bot.name}? Its routines and its memory are deleted. This cannot be undone.`)) void run('remove', async () => { await call('botRemove', { id: bot.id }); onRemoved(); }, `${bot.name} was removed.`); }}>Remove</button>
        </div>
        {editing && (
          <form className="bot-edit" aria-label={`Edit ${bot.name}`} onSubmit={(e) => { e.preventDefault(); void run('edit', async () => { await call('botUpdate', { id: bot.id, responsibility, instructions, ...(bot.kind === 'engineer' ? { repoPath: repoPath.trim() || null } : {}) }); setEditing(false); }, 'Saved.'); }}>
            <label className="bot-field">Responsibility<textarea value={responsibility} onChange={(e) => setResponsibility(e.target.value)} rows={2} maxLength={600} /></label>
            <label className="bot-field">Instructions (its Hermes SOUL.md)<textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={8} maxLength={4000} /></label>
            {bot.kind === 'engineer' && <label className="bot-field">Folder of the Pandesh git repository<input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="The folder you cloned Pandesh into" spellCheck={false} /></label>}
            <div className="actions"><button type="submit" className="btn small primary" disabled={Boolean(busy)}>Save</button></div>
          </form>
        )}
      </section>

      <form className="card" aria-label={`Ask ${bot.name}`} onSubmit={ask}>
        <span className="title">Ask {bot.name}</span>
        <div className="settings-row">
          <input className="bot-input" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1500} placeholder={bot.kind === 'engineer' ? 'e.g. Why is Pandesh slow at startup?' : 'Ask a question, or leave empty for its normal report'} aria-label="Question" />
          <button type="submit" className="btn small primary" disabled={!canRun || Boolean(busy)}>{bot.running ? 'Working…' : question.trim() ? 'Ask' : 'Run now'}</button>
        </div>
        {!canRun && !bot.running && <p className="settings-note">{bot.status === 'paused' ? 'Resume the Bot to run it.' : status.text}</p>}
        <p className="settings-note">You can also just say it in chat: “{bot.name}, …”.</p>
      </form>

      <section className="card" aria-label="What it may do">
        <span className="title">What it may do</span>
        <dl className="settings-kv">
          <dt>Reads</dt><dd>{perms.reads.length ? <ul className="bot-list">{perms.reads.map((r) => <li key={r}>{r}</li>)}</ul> : 'Nothing'}</dd>
          <dt>Tools</dt><dd>Its own memory only. No terminal, files, browser or mail tools.</dd>
          <dt>Always asks you</dt><dd>{perms.asks.join('; ') || 'Any action'}</dd>
          <dt>Cloud</dt><dd>Never. It runs on a local model; a Bot whose profile is not local-only is refused.</dd>
        </dl>
      </section>

      <section className="card" aria-label="Schedule">
        <span className="title">Schedule</span>
        {bot.routines.length === 0 && <span className="meta">No routine yet.</span>}
        {bot.routines.map((r) => (
          <div key={r.id} className="bot-row">
            <span><strong>{r.title}</strong><br /><span className="settings-sub">{scheduleWords(r)}{r.enabled && r.nextRunAt ? ` · next ${whenWords(r.nextRunAt)}` : ''}{r.lastRunAt ? ` · last ${whenWords(r.lastRunAt)}` : ''}</span></span>
            <span className="actions">
              <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run(`rt:${r.id}`, () => call('automationUpdate', { id: r.id, enabled: !r.enabled }), r.enabled ? 'Routine switched off.' : 'Routine switched on.')}>{r.enabled ? 'Switch off' : 'Switch on'}</button>
              <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Remove the routine "${r.title}"?`)) void run(`rtdel:${r.id}`, () => call('botRoutineRemove', { id: r.id }), 'Routine removed.'); }}>Remove</button>
            </span>
          </div>
        ))}
        <form className="settings-row" aria-label="Add a routine" onSubmit={(e) => { e.preventDefault(); if (!validDailyTime(time)) return; void run('rtadd', () => call('botRoutineAdd', { id: bot.id, dailyTime: time, everyDays: every > 1 ? every : undefined }), 'Routine added and switched on.'); }}>
          <label className="settings-check">Run at <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time of day" className="bot-time" /></label>
          <label className="settings-check">every <select value={every} onChange={(e) => setEvery(Number(e.target.value))} aria-label="How often" className="ctl-select"><option value={1}>day</option><option value={2}>2 days</option><option value={3}>3 days</option><option value={7}>7 days</option></select></label>
          <button type="submit" className="btn small" disabled={Boolean(busy) || !validDailyTime(time)}>Add routine</button>
        </form>
        <p className="settings-note">{data.scheduler}. A routine tells you only when something is new.</p>
      </section>

      <section className="card" aria-label="Recent results">
        <span className="title">Recent results</span>
        {!detail && <span className="meta">Reading…</span>}
        {detail && detail.runs.length === 0 && <span className="meta">It has not run yet.</span>}
        {detail?.runs.map((r) => {
          const w = runWords(r);
          const isOpen = openRun === r.id;
          return (
            <div key={r.id} className="bot-run">
              <button type="button" className="bot-run-head" aria-expanded={isOpen} onClick={() => setOpenRun(isOpen ? null : r.id)}>
                <span style={{ color: TONE_COLOR[w.tone], fontWeight: 500 }}>{r.status === 'completed' ? 'Done' : r.status === 'running' ? 'Running' : r.status === 'skipped' ? 'Skipped' : r.status === 'interrupted' ? 'Interrupted' : 'Failed'}</span>
                <span className="settings-sub">{triggerWords(r.trigger)} · {whenWords(r.finishedAt ?? r.startedAt)}{r.question ? ` · “${r.question.slice(0, 80)}”` : ''}</span>
              </button>
              {isOpen && (
                <div className="bot-run-body">
                  <p className="settings-note">{r.reason}</p>
                  {r.evidence.length > 0 && <p className="settings-sub">Read: {r.evidence.map((e) => `${data.sources.find((s) => s.id === e.source)?.label ?? e.source} — ${e.ok ? `${e.items} item(s), ${e.newItems} new` : `not read (${e.reason})`}`).join(' · ')}{r.hermes ? ` · ${r.hermes.model ?? 'local model'}, ${Math.round(r.hermes.durationMs / 1000)} s` : ''}</p>}
                  {r.report && <pre className="settings-report" style={{ maxHeight: 420 }}>{r.report}</pre>}
                  {r.proposals.length > 0 && (
                    <div>
                      <span className="settings-sub">Proposed (nothing was done). Hand one to Pandesh; it will ask for your approval:</span>
                      <ul className="bot-list">{r.proposals.map((p) => <li key={p}>{p} <button type="button" className="btn link" onClick={() => onAskPandesh(proposalRequest(bot.name, p))}>Ask Pandesh to do this</button></li>)}</ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="card" aria-label="Memory">
        <span className="title">Memory</span>
        <span className="meta">What the Bot chose to remember, kept by Hermes on this PC{detail?.memory.updatedAt ? ` · updated ${whenWords(detail.memory.updatedAt)}` : ''}.</span>
        {detail && (detail.memory.text.trim() ? <pre className="settings-report">{detail.memory.text}</pre> : <span className="meta">Nothing remembered yet.</span>)}
      </section>
    </>
  );
}
