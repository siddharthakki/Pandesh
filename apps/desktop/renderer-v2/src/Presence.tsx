import React, { useEffect, useRef } from 'react';
import type { PresenceState } from './jarvisModel';

/**
 * The particle presence. Rendering rules (owner directive "no event, no movement", and keep the GPU for Ollama):
 * - idle and thinking (the local model is generating): ONE static frame, no animation loop at all;
 * - acting (a worker sent an event in the last minute) and needs_you: animated, capped at 30 fps, only while the window is visible;
 * - prefers-reduced-motion: always one static frame.
 * 2D canvas, about 1,400 points: cheap on the CPU and never competes with inference for the GPU.
 */
export function Presence({ state, size = 380 }: { state: PresenceState; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const N = 1400;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (2 * (i + 0.5)) / N; const r = Math.sqrt(1 - y * y); const phi = i * 2.399963;
      return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r, s: ((i * 9301 + 49297) % 233280) / 233280 };
    });
    let reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* treat as motion allowed */ }
    let raf = 0; let last = 0;

    const draw = (t: number) => {
      const mode = stateRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth; const h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3;
      const need = mode === 'needs_you'; const act = mode === 'acting';
      const a = 0.6 + t * (act ? 0.00032 : need ? 0.00008 : 0); const ca = Math.cos(a), sa = Math.sin(a);
      const cb = Math.cos(0.38), sb = Math.sin(0.38);
      for (const p of pts) {
        let rr = R; let am = 1;
        if (act && p.s < 0.2) { const f = (t * 0.00045 + p.s * 5) % 1; rr = R * (1 + f * 1.5); am = 1 - f; }
        else if (need) rr = R * 0.84 * (1 + 0.025 * Math.sin(t * 0.002 + p.s * 6.28));
        const x1 = p.x * ca - p.z * sa, z1 = p.x * sa + p.z * ca;
        const y2 = p.y * cb - z1 * sb, z2 = p.y * sb + z1 * cb;
        const sc = 1 + z2 * 0.22;
        const al = (0.16 + (z2 + 1) * 0.34) * am * (mode === 'thinking' ? 0.7 : 1);
        const col = need ? (p.s > 0.9 ? '255,232,190' : '255,181,71') : p.s > 0.87 ? '170,150,255' : p.s > 0.7 ? '205,246,255' : '79,216,255';
        ctx.fillStyle = `rgba(${col},${al.toFixed(3)})`;
        const sz = 0.7 + (z2 + 1) * 0.8;
        ctx.fillRect(cx + x1 * rr * sc, cy + y2 * rr * sc, sz, sz);
      }
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
      g.addColorStop(0, need ? 'rgba(255,220,160,.5)' : 'rgba(210,248,255,.45)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    };

    const animated = () => !reduce && (stateRef.current === 'acting' || stateRef.current === 'needs_you') && document.visibilityState === 'visible';
    const loop = (t: number) => {
      raf = 0;
      if (!animated()) { draw(t); return; }
      if (t - last >= 33) { last = t; draw(t); }
      raf = requestAnimationFrame(loop);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
    kick();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(kick);
    ro?.observe(cv);
    document.addEventListener('visibilitychange', kick);
    const poll = setInterval(kick, 1000); // picks up a state change without re-creating the canvas
    return () => { if (raf) cancelAnimationFrame(raf); ro?.disconnect(); document.removeEventListener('visibilitychange', kick); clearInterval(poll); };
  }, []);

  return <canvas ref={ref} className="jv-canvas" style={{ width: size, height: size }} aria-hidden="true" />;
}
