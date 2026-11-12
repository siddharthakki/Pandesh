import React, { useState } from 'react';
import { api, type EverydayNote, type HostTelemetry, type Snapshot } from './bridge';
import { formatBytes } from './attachments';

/**
 * Everyday tools from Core, placed where the v2 plan puts them: notes in Second Brain, reminders and timers in
 * Automations, PC health in Diagnostics. Everything is read from and written to Core through the host.
 */
export const AVAILABILITY: Record<string, string> = { available: 'Ready', not_connected: 'Not connected', not_implemented: 'Not available yet' };

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** A local date-time input value (yyyy-mm-ddThh:mm) for `minutes` from now. */
export function localInputValue(minutesFromNow: number, now = new Date()): string {
  const d = new Date(now.getTime() + minutesFromNow * 60_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function telemetryRows(t: HostTelemetry | null | undefined): Array<[string, string]> {
  if (!t) return [['PC health', 'Sampling…']];
  const gpu = t.gpu;
  return [
    ['CPU', t.cpu?.available && Number.isFinite(t.cpu.value) ? `${Math.round(t.cpu.value as number)}%${t.cpu.model ? ` · ${t.cpu.model}` : ''}${t.cpu.cores ? ` · ${t.cpu.cores} cores` : ''}` : 'Unavailable'],
    ['Memory', t.memory?.available ? `${Math.round(t.memory.usedPercent)}% · ${formatBytes(t.memory.usedBytes)} of ${formatBytes(t.memory.totalBytes)}` : 'Unavailable'],
    ['GPU', gpu?.available && Number.isFinite(gpu.usagePercent) ? [
      `${Math.round(gpu.usagePercent as number)}%`,
      Number.isFinite(gpu.temperatureC) ? `${Math.round(gpu.temperatureC as number)}°C` : null,
      Number.isFinite(gpu.vramUsedBytes) && Number.isFinite(gpu.vramTotalBytes) ? `${formatBytes(gpu.vramUsedBytes as number)} / ${formatBytes(gpu.vramTotalBytes as number)} VRAM` : null,
      gpu.name || 'GPU',
    ].filter(Boolean).join(' · ') : (gpu?.blocker || 'Unavailable')],
    ['Disk', t.disk?.available ? `${Math.round(t.disk.usedPercent ?? 0)}% used · ${formatBytes(t.disk.freeBytes ?? 0)} free${t.disk.mount ? ` on ${t.disk.mount}` : ''}` : (t.disk?.blocker || 'Unavailable')],
    ['Ollama', t.ollama?.reachable ? `Answering at ${t.ollama.apiBase}` : `Not answering${t.ollama?.detail ? ` — ${t.ollama.detail}` : ''}`],
  ];
}

export function NotesCard({ notes, run }: { notes: EverydayNote[]; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  return (
    <section className="card" aria-label="Notes">
      <span className="title">Notes ({notes.length})</span>
      <form style={{ display: 'flex', flexDirection: 'column', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (!body.trim()) return; void run(async () => { await api.createNote({ title: title.trim() || undefined, body: body.trim() }); setTitle(''); setBody(''); }, 'Note saved.'); }}>
        <label className="sr-only" htmlFor="note-title">Note title</label>
        <input id="note-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" />
        <label className="sr-only" htmlFor="note-body">Note</label>
        <textarea id="note-body" className="field" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a note…" />
        <div className="actions"><button type="submit" className="btn small primary" disabled={!body.trim()}>Save note</button></div>
      </form>
      {notes.length === 0 && <span className="meta">No notes yet. You can also ask Pandesh: “note that …”.</span>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {notes.map((n) => (
          <li key={n.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {editing?.id === n.id ? (
              <form style={{ display: 'flex', flexDirection: 'column', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (!editing.body.trim()) return; void run(async () => { await api.updateNote(n.id, { title: editing.title.trim() || n.title, body: editing.body.trim() }); setEditing(null); }, 'Note updated.'); }}>
                <label className="sr-only" htmlFor={`ne-t-${n.id}`}>Title</label>
                <input id={`ne-t-${n.id}`} className="field" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                <label className="sr-only" htmlFor={`ne-b-${n.id}`}>Note</label>
                <textarea id={`ne-b-${n.id}`} className="field" rows={3} autoFocus value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                <div className="actions"><button type="submit" className="btn small primary">Save</button><button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button></div>
              </form>
            ) : (
              <>
                {n.title && n.title.trim() !== n.body.trim() && <strong style={{ fontSize: 14 }}>{n.title}</strong>}
                <span style={{ whiteSpace: 'pre-wrap', fontSize: 14, userSelect: 'text' }}>{n.body}</span>
                <span className="meta">Updated {new Date(n.updatedAt).toLocaleString()}</span>
                <div className="actions">
                  <button type="button" className="btn small" onClick={() => setEditing({ id: n.id, title: n.title, body: n.body })}>Edit</button>
                  <button type="button" className="btn small" onClick={() => { if (window.confirm('Delete this note? It cannot be restored.')) void run(() => api.deleteNote(n.id), 'Note deleted.'); }}>Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RemindersCard({ tools, timers, now, run }: { tools: NonNullable<Snapshot['everydayTools']>; timers: NonNullable<NonNullable<Snapshot['everydayTools']>['activeTimers']>; now: number; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(() => localInputValue(15));
  const reminders = tools.reminders ?? [];
  const dueSoon = new Set((tools.dueReminders ?? []).map((r) => r.id));
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const at = new Date(due);
    if (!title.trim() || Number.isNaN(at.getTime())) return;
    void run(async () => { await api.createReminder({ title: title.trim(), dueAt: at.toISOString(), timezone: tools.timezone }); setTitle(''); setDue(localInputValue(15)); }, 'Reminder set.');
  };
  return (
    <section className="card" aria-label="Reminders and timers">
      <span className="title">Reminders and timers</span>
      <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onSubmit={create}>
        <label className="sr-only" htmlFor="rem-title">Remind me to</label>
        <input id="rem-title" className="field" style={{ flex: '1 1 180px' }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Remind me to…" />
        <label className="sr-only" htmlFor="rem-due">When</label>
        <input id="rem-due" className="field" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="submit" className="btn small primary" disabled={!title.trim()}>Set reminder</button>
      </form>
      {timers.map((t) => (
        <div key={t.id} className="kv" style={{ alignItems: 'center' }}>
          <span className="k">Timer</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{t.label || 'Timer'}</strong>
            <span role="timer">{t.state === 'paused' ? `${formatCountdown(t.remainingMs)} (paused)` : formatCountdown(t.deadlineMs - now)}</span>
            {t.state === 'running'
              ? <button type="button" className="btn small" onClick={() => void run(() => api.submitTask(`pause timer id:${t.id}`))}>Pause</button>
              : <button type="button" className="btn small" onClick={() => void run(() => api.submitTask(`resume timer id:${t.id}`))}>Resume</button>}
            <button type="button" className="btn small" onClick={() => void run(() => api.submitTask(`cancel timer id:${t.id}`))}>Cancel</button>
          </span>
        </div>
      ))}
      {reminders.length === 0 && timers.length === 0 && <span className="meta">No reminders or timers. You can also ask Pandesh: “remind me at 5 to …” or “set a timer for 10 minutes”.</span>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reminders.map((r) => (
          <li key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 6 }} title={r.overdueExplanation ?? undefined}>
            <span style={{ flex: '1 1 200px', fontSize: 14 }}>
              {(r.overdue || dueSoon.has(r.id)) && <span className="dot attention" aria-hidden="true" style={{ marginRight: 6 }} />}
              {r.title} — {new Date(r.dueAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{r.overdue ? ' (overdue)' : ''}
            </span>
            <button type="button" className="btn small" onClick={() => void run(() => api.completeReminder(r.id), 'Marked done.')}>Done</button>
            <button type="button" className="btn small" onClick={() => void run(() => api.cancelReminder(r.id), 'Reminder cancelled.')}>Cancel</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
