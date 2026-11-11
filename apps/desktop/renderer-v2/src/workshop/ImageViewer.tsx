import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { CommandOutcome, ViewerHandle } from './viewerTypes';

/** An image version: fit, zoom (buttons, wheel) and pan (drag). The pixels are the verified artifact's bytes. */
export const ImageViewer = forwardRef<ViewerHandle, { src: string; title: string }>(function ImageViewer({ src, title }, ref) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [size, setSize] = useState<[number, number] | null>(null);
  const drag = useRef<{ x: number; y: number; pan: [number, number] } | null>(null);
  const clamp = (z: number) => Math.min(8, Math.max(0.25, z));
  const fit = () => { setZoom(1); setPan([0, 0]); };

  useImperativeHandle(ref, () => ({
    async run(action: string, args: Record<string, unknown>): Promise<CommandOutcome> {
      if (action === 'fit') { fit(); return { ok: true, detail: 'fitted to the panel' }; }
      if (action === 'zoom') {
        const v = String(args.value ?? 'in');
        const next = v === 'in' ? clamp(zoom * 1.5) : v === 'out' ? clamp(zoom / 1.5) : clamp(Number(v) || 1);
        setZoom(next);
        return { ok: true, detail: `zoom ${Math.round(next * 100)}%` };
      }
      return { ok: false, detail: `"${action.replace(/_/g, ' ')}" is not available for an image` };
    },
    inspect: () => ({ zoom, pan, naturalSize: size }),
  }), [zoom, pan, size]);

  return (
    <div className="ws-image">
      <div className="ws-toolbar" role="toolbar" aria-label="Image view">
        <button type="button" className="btn small" onClick={fit}>Fit</button>
        <button type="button" className="btn small" onClick={() => setZoom((z) => clamp(z / 1.5))} aria-label="Zoom out">−</button>
        <span className="meta" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn small" onClick={() => setZoom((z) => clamp(z * 1.5))} aria-label="Zoom in">+</button>
        <span className="grow" />
        {size && <span className="meta">{size[0]} × {size[1]} px</span>}
      </div>
      <div
        className="ws-image-stage"
        onWheel={(e) => { setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, pan }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (d) setPan([d.pan[0] + e.clientX - d.x, d.pan[1] + e.clientY - d.y]); }}
        onPointerUp={() => { drag.current = null; }}
      >
        <img src={src} alt={title} draggable={false} onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
          style={{ transform: `translate(${pan[0]}px, ${pan[1]}px) scale(${zoom})` }} />
      </div>
    </div>
  );
});
