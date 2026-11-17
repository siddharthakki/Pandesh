import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from './bridge';
import { RoutineGrants } from './RoutineGrants';
import { TONE_COLOR, automationKind, scheduleWords, sortAutomations, validDailyTime, whenWords, type Automation, type Tone } from './botsModel';

type Notice = { text: string; error?: boolean } | null;
type Row = Automation & { runNow: 'bot' | 'household' | null };
const call = <T,>(action: string, args?: Record<string, unknown>) => api.household(action, args) as Promise<T>;

const RESULT_TONE: Record<string, Tone> = { completed: 'ok', running: 'busy', skipped: 'neutral', interrupted: 'warn', failed: 'bad' };

/**
 * Automations: everything Pandesh does on its own, in one list. Each row is one schedule owned by Core's scheduler,
 * with when it runs next, what it last did, and the controls that really exist for it.
 */
export function Automations({ onOpenConversation, onOpenBot }: { onOpenConversation: (id: string) => void; onOpenBot: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [scheduler, setScheduler] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; time: string } | null>(null);
  const alive = useRef(true);

  const load = async () => {
    try {
      const d = await call<{ automations: Row[]; scheduler: string }>('automations');
      if (!alive.current) return;
      setRows(sortAutomations(d.automations) as Row[]); setScheduler(d.scheduler);
    } catch (err) { if (alive.current) setNotice({ text: errorText(err), error: true }); }
  };
  useEffect(() => { alive.current = true; void load(); const t = setInterval(() => void load(), 15_000); return () => { alive.current = false; clearInterval(t); }; }, []);

  const run = async (key: string, work: () => Promise<unknown>, done: string) => {
    setBusy(key); setNotice(null);
    try { await work(); setNotice({ text: done }); } catch (err) { setNotice({ text: errorText(err), error: true }); } finally { setBusy(null); await load(); }
  };
  const runNow = (a: Row) => {
    if (a.runNow === 'bot' && a.bot) return run(`run:${a.id}`, () => call('botRun', { id: a.bot!.id }), `${a.bot.name} is running now. Its result appears here and in My Bots.`);
    if (a.runNow === 'household') return run(`run:${a.id}`, () => call('routine', { id: a.id, op: 'run' }), `"${a.title}" was started.`);
    return Promise.resolve();
  };

  const on = rows?.filter((a) => a.enabled) ?? [];
  const off = rows?.filter((a) => !a.enabled) ?? [];
  const renderRow = (a: Row) => {
    const isEditing = editing?.id === a.id;
    const paused = a.bot?.status === 'paused';
    return (
      <div key={a.id} className="card" data-enabled={a.enabled}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className="title">{a.title}</span>
          <span className="meta">{automationKind(a)}</span>
        </div>
        <span style={{ fontSize: 14 }}>{scheduleWords(a)}{a.enabled && a.nextRunAt ? ` · next ${whenWords(a.nextRunAt)}` : ''}{paused ? ' · its Bot is paused, so runs are skipped' : ''}</span>
        <span className="meta" style={a.lastResult ? { color: TONE_COLOR[RESULT_TONE[a.lastResult.status] ?? 'neutral'] } : undefined}>
          Last: {a.lastResult ? `${whenWords(a.lastResult.at)} — ${a.lastResult.reason}` : a.lastRunAt ? whenWords(a.lastRunAt) : 'has not run yet'}
        </span>
        {a.purpose && <span className="meta">{a.purpose}</span>}
        <div className="actions">
          {a.runNow && <button type="button" className="btn small" disabled={Boolean(busy) || paused} onClick={() => void runNow(a)}>{busy === `run:${a.id}` ? 'Starting…' : 'Run now'}</button>}
          <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void run(`en:${a.id}`, () => call('automationUpdate', { id: a.id, enabled: !a.enabled }), a.enabled ? `"${a.title}" is paused.` : `"${a.title}" is on again.`)}>{a.enabled ? 'Pause' : 'Resume'}</button>
          {!isEditing && <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => setEditing({ id: a.id, time: a.dailyTime })}>Edit time</button>}
          {a.kind === 'bot' && a.bot && <button type="button" className="btn small" onClick={onOpenBot}>Open {a.bot.name}</button>}
          {a.conversationId && <button type="button" className="btn small" onClick={() => onOpenConversation(a.conversationId as string)}>Open its reports</button>}
        </div>
        {isEditing && (
          <form className="settings-row" aria-label={`Change the time of ${a.title}`} onSubmit={(e) => { e.preventDefault(); if (!editing || !validDailyTime(editing.time)) return; void run(`time:${a.id}`, async () => { await call('automationUpdate', { id: a.id, dailyTime: editing.time }); setEditing(null); }, `"${a.title}" now runs at ${editing.time}.`); }}>
            <label className="settings-check">Run at <input type="time" className="bot-time" value={editing.time} onChange={(e) => setEditing({ id: a.id, time: e.target.value })} aria-label="Time of day" /></label>
            <button type="submit" className="btn small primary" disabled={Boolean(busy) || !validDailyTime(editing.time)}>Save</button>
            <button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button>
          </form>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="topbar"><span className="title" style={{ color: 'var(--ink)', fontWeight: 600 }}>Automations</span><span className="grow" /><button type="button" className="btn small" onClick={() => void load()}>Refresh</button></div>
      <div className="board" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
        {notice && <div className={`notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'} style={{ margin: 0, maxWidth: 'none' }}>{notice.text}</div>}
        {!rows && !notice && <div className="notice" role="status">Reading from Core…</div>}
        {rows && (
          <>
            <p className="settings-note">Everything Pandesh does on its own. To add one, say it in chat (“every morning check my email and tell me what's important”) or give a Bot a routine in My Bots.{scheduler ? ` All of these are fired by the ${scheduler}.` : ''}</p>
            <h2 style={{ margin: 0, fontSize: 15 }}>On ({on.length})</h2>
            {on.length === 0 && <div className="empty" style={{ color: 'var(--faint)' }}>Nothing is switched on.</div>}
            {on.map(renderRow)}
            {off.length > 0 && <h2 style={{ margin: '6px 0 0', fontSize: 15 }}>Paused ({off.length})</h2>}
            {off.map(renderRow)}
            <details className="card">
              <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Advanced: standing write permissions for folder routines</summary>
              <RoutineGrants />
            </details>
          </>
        )}
      </div>
    </>
  );
}
