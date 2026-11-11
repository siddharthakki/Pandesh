/**
 * The Simulation Lab: the stall's queue animated from the very run Core measures (same seeded model,
 * core/shared/workshop/simulation.ts), live and final numbers, a queue-length chart, what-if sliders that re-run the
 * model at once (saved only when the person says so), and the assumptions, always on screen.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { queueAssumptions, runQueue, stateAt, type QueueParams, type QueueRun, type SimulationSpec } from '../../../../../core/shared/workshop/simulation';
import type { CommandOutcome, ViewerHandle } from './viewerTypes';

interface Props {
  spec: SimulationSpec;
  /** An earlier version to compare with (its parameters), when comparing. */
  compareSpec?: SimulationSpec | null;
  onSave(set: Partial<QueueParams>, what: string): Promise<void>;
}

const SPEEDS = [1, 2, 5, 10, 30];
const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '–');

export const SimulationLab = forwardRef<ViewerHandle, Props>(function SimulationLab({ spec, compareSpec, onSave }, ref) {
  const [draft, setDraft] = useState<QueueParams>(spec.params);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { setDraft(spec.params); setT(0); setPlaying(false); }, [spec]);

  // The run the window shows is always the model run of what is on screen (the draft while sliders moved).
  const run: QueueRun = useMemo(() => runQueue(draft), [draft]);
  const saved = useMemo(() => runQueue(spec.params), [spec]);
  const compared = useMemo(() => (compareSpec ? runQueue(compareSpec.params) : null), [compareSpec]);
  const live = stateAt(run, t);
  const changed = (Object.keys(draft) as Array<keyof QueueParams>).filter((k) => draft[k] !== spec.params[k]);
  const end = run.metrics.endMinutes;

  // Playback: 1 real second = speed simulated minutes.
  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((cur) => {
        const next = Math.min(end, cur + dt * speed);
        if (next >= end) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, end]);

  // The stall: a queue of waiting customers, the counters with whoever is being served, and how many are done.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth; const h = c.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim() || '#ddd';
    const muted = css.getPropertyValue('--muted').trim() || '#999';
    const pulse = css.getPropertyValue('--pulse').trim() || '#3dd6c6';
    const attention = css.getPropertyValue('--attention').trim() || '#f0b44c';
    const line = css.getPropertyValue('--line').trim() || 'rgba(255,255,255,.1)';
    g.clearRect(0, 0, w, h);
    const counters = draft.counters;
    const rowH = Math.min(46, (h - 30) / counters);
    const counterX = w - 120;
    g.font = '12px "Segoe UI", sans-serif';
    for (let k = 0; k < counters; k += 1) {
      const y = 20 + k * rowH;
      g.strokeStyle = line; g.lineWidth = 1; g.strokeRect(counterX, y, 90, rowH - 8);
      g.fillStyle = muted; g.fillText(`Counter ${k + 1}`, counterX + 6, y + 14);
      if (live.atCounter[k] !== undefined && live.atCounter[k] !== null) {
        g.fillStyle = pulse; g.beginPath(); g.arc(counterX + 72, y + (rowH - 8) / 2, 7, 0, Math.PI * 2); g.fill();
      }
    }
    // Waiting customers queue from the counters towards the left (one shared line).
    const qy = 20 + (counters * rowH) / 2 - 4;
    const spacing = 18;
    const shown = Math.min(live.waiting, Math.floor((counterX - 40) / spacing));
    for (let i = 0; i < shown; i += 1) {
      g.fillStyle = attention; g.beginPath(); g.arc(counterX - 22 - i * spacing, qy, 6, 0, Math.PI * 2); g.fill();
    }
    if (live.waiting > shown) { g.fillStyle = ink; g.fillText(`+${live.waiting - shown} more`, 8, qy + 4); }
    g.fillStyle = ink;
    g.fillText(`${live.waiting} waiting · ${live.serving} being served · ${live.done} done`, 8, h - 8);
  }, [live.waiting, live.serving, live.done, draft.counters, t]);

  const metric = (label: string, value: string, id: string) => (
    <div className={`ws-metric${highlight === id ? ' highlight' : ''}`} key={id}><span className="meta">{label}</span><strong>{value}</strong></div>
  );

  useImperativeHandle(ref, () => ({
    async run(action: string, args: Record<string, unknown>): Promise<CommandOutcome> {
      switch (action) {
        case 'play': if (t >= end) setT(0); setPlaying(true); return { ok: true, detail: `playing at ${speed}× (1 s = ${speed} simulated min)` };
        case 'pause': setPlaying(false); return { ok: true, detail: `paused at minute ${fmt(t)}`, state: { minute: Math.round(t * 10) / 10, waiting: live.waiting, served: live.done } };
        case 'reset': setPlaying(false); setT(0); return { ok: true, detail: 'back to minute 0' };
        case 'speed': {
          const want = Number(args.value ?? args.speed);
          const next = Number.isFinite(want) && want > 0 ? SPEEDS.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), SPEEDS[0]) : SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)];
          setSpeed(next);
          return { ok: true, detail: `speed ${next}×` };
        }
        case 'show_metric': {
          const m = String(args.value ?? args.metric ?? 'wait').toLowerCase();
          const id = /queue|line/.test(m) ? 'queue' : /util|busy/.test(m) ? 'utilization' : 'wait';
          setHighlight(id);
          const r = run.metrics;
          const value = id === 'queue' ? `average queue ${r.averageQueueLength}, longest ${r.maxQueueLength}` : id === 'utilization' ? `counters busy ${Math.round(r.utilization * 100)}%` : `average wait ${r.averageWaitMinutes} min (longest ${r.maxWaitMinutes} min)`;
          return { ok: true, detail: `highlighted: ${value}`, state: { metric: id, ...r } };
        }
        default: return { ok: false, detail: `"${action.replace(/_/g, ' ')}" is not available in the Simulation Lab` };
      }
    },
    inspect: () => ({ minute: t, playing, speed, params: draft, metrics: run.metrics, unsaved: changed }),
  }), [t, playing, speed, draft, run, live.waiting, live.done, end]);

  // The queue-length chart (queue length over simulated time, with the playhead).
  const chart = useMemo(() => {
    const W = 600; const H = 120;
    const maxQ = Math.max(1, run.metrics.maxQueueLength);
    let d = `M0,${H}`;
    for (const [time, q] of run.queueSeries) d += ` L${((time / end) * W).toFixed(1)},${(H - (q / maxQ) * (H - 10)).toFixed(1)}`;
    return { W, H, d, maxQ };
  }, [run, end]);

  const slider = (key: keyof QueueParams, label: string, min: number, max: number, step: number) => (
    <label className="ws-slider" key={key}>
      <span>{label} <strong>{String(draft[key])}</strong></span>
      <input type="range" min={min} max={max} step={step} value={Number(draft[key])} onChange={(e) => { setDraft({ ...draft, [key]: Number(e.target.value) }); setT(0); setPlaying(false); }} />
    </label>
  );

  return (
    <div className="ws-sim">
      <div className="ws-toolbar" role="toolbar" aria-label="Simulation">
        <button type="button" className="btn small" aria-pressed={playing} onClick={() => { if (!playing && t >= end) setT(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="btn small" onClick={() => { setPlaying(false); setT(0); }}>Reset</button>
        <label className="sr-only" htmlFor="ws-sim-speed">Speed</label>
        <select id="ws-sim-speed" className="ws-select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}× ({s} min/s)</option>)}</select>
        <span className="meta">minute {fmt(t)} of {fmt(end)}</span>
        <span className="grow" />
        {changed.length > 0 && <span className="meta">What-if: {changed.join(', ')} changed (not saved)</span>}
        {changed.length > 0 && <button type="button" className="btn small" onClick={() => setDraft(spec.params)}>Undo changes</button>}
        {changed.length > 0 && <button type="button" className="btn small primary" disabled={saving} onClick={() => { setSaving(true); const set = Object.fromEntries(changed.map((k) => [k, draft[k]])) as Partial<QueueParams>; void onSave(set, changed.map((k) => `${k} ${String(spec.params[k])} → ${String(draft[k])}`).join(', ')).finally(() => setSaving(false)); }}>{saving ? 'Saving…' : 'Save as new version'}</button>}
      </div>
      <div className="ws-sim-body">
        <div className="ws-sim-main">
          <canvas ref={canvas} className="ws-sim-canvas" aria-label={`The stall at minute ${fmt(t)}: ${live.waiting} waiting, ${live.serving} being served, ${live.done} served`} role="img" />
          <svg className="ws-sim-chart" viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none" role="img" aria-label={`Queue length over time, longest ${chart.maxQ}`}>
            <path d={chart.d} fill="none" stroke="var(--attention)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <line x1={(t / end) * chart.W} x2={(t / end) * chart.W} y1="0" y2={chart.H} stroke="var(--pulse)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="meta">Queue length over the run (longest {chart.maxQ}); the line is minute {fmt(t)}.</div>
          <div className="ws-metrics" aria-label="Live">
            {metric('Waiting now', String(live.waiting), 'live-wait')}
            {metric('Served so far', String(live.done), 'live-done')}
            {metric('Average wait so far', `${fmt(live.averageWaitSoFar)} min`, 'live-avg')}
          </div>
        </div>
        <aside className="ws-sim-side">
          <h4>Measured over the whole run</h4>
          <div className="ws-metrics">
            {metric('Average wait', `${fmt(run.metrics.averageWaitMinutes)} min`, 'wait')}
            {metric('Longest wait', `${fmt(run.metrics.maxWaitMinutes)} min`, 'wait-max')}
            {metric('Average queue', fmt(run.metrics.averageQueueLength), 'queue')}
            {metric('Longest queue', String(run.metrics.maxQueueLength), 'queue-max')}
            {metric('Counters busy', `${Math.round(run.metrics.utilization * 100)}%`, 'utilization')}
            {metric('Served', `${run.metrics.served} of ${run.metrics.arrived}`, 'served')}
          </div>
          {(compared || changed.length > 0) && (
            <table className="ws-compare-table">
              <thead><tr><th /><th>{compared ? 'Earlier version' : 'Saved'}</th><th>{changed.length ? 'What-if' : 'This version'}</th></tr></thead>
              <tbody>
                {([['Average wait (min)', 'averageWaitMinutes'], ['Longest queue', 'maxQueueLength'], ['Counters busy', 'utilization'], ['Served', 'served']] as const).map(([label, key]) => {
                  const a = (compared ?? saved).metrics[key]; const b = run.metrics[key];
                  const show = (v: number) => (key === 'utilization' ? `${Math.round(v * 100)}%` : String(v));
                  return <tr key={key}><td>{label}</td><td>{show(a)}</td><td>{show(b)}</td></tr>;
                })}
              </tbody>
            </table>
          )}
          <h4>Try a change</h4>
          {slider('arrivalEveryMinutes', 'A customer every (min)', 0.5, 10, 0.5)}
          {slider('serviceMinutes', 'Serving takes (min)', 0.5, 15, 0.5)}
          {slider('counters', 'Counters', 1, 8, 1)}
          {slider('durationMinutes', 'Open for (min)', 15, 480, 15)}
          <details className="ws-assumptions" open>
            <summary>Assumptions — a simulation, not a forecast</summary>
            <ul>{queueAssumptions(draft).map((a, i) => <li key={i}>{a}</li>)}</ul>
          </details>
        </aside>
      </div>
    </div>
  );
});
