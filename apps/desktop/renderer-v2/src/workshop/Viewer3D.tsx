import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../bridge';
import { MATERIAL_PRESETS, MATERIAL_PRESET_IDS, resolveComponents, type MaterialPreset, type Scene3D, type SceneComponent, type Vec3 } from '../../../../../core/shared/workshop/scene3d';
import type { CameraPreset, InspectState, Workshop3DView } from './engine3d';
import { loadEngine3d } from './loadEngine3d';
import type { CommandOutcome, ViewerHandle } from './viewerTypes';

interface Props {
  scene: Scene3D;
  artifactId: string;
  workshopId: string;
  conversationId: string | null;
  title: string;
  /** The person changed a component with the Workshop's own controls: Core saves it as a new version. */
  onEdit(edits: unknown[], what: string): Promise<void>;
  onNotice(text: string, error?: boolean): void;
}

interface ViewState { exploded: boolean; labels: boolean; rotating: boolean; camera?: { alpha: number; beta: number; radius: number; target: [number, number, number] } }

const viewKey = (workshopId: string) => `pandesh.v2.workshop.view.${workshopId}`;
function readView(workshopId: string): ViewState {
  try { return { exploded: false, labels: false, rotating: false, ...(JSON.parse(localStorage.getItem(viewKey(workshopId)) ?? '{}') as Partial<ViewState>) }; } catch { return { exploded: false, labels: false, rotating: false }; }
}
function writeView(workshopId: string, state: ViewState): void {
  try { localStorage.setItem(viewKey(workshopId), JSON.stringify(state)); } catch { /* the view still works */ }
}

const themeBackground = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#16181d';
};

export const Viewer3D = forwardRef<ViewerHandle, Props>(function Viewer3D({ scene, artifactId, workshopId, conversationId, title, onEdit, onNotice }, ref) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const labelLayer = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<Workshop3DView | null>(null);
  const [engineLabel, setEngineLabel] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<ViewState>(() => readView(workshopId));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [isolated, setIsolated] = useState<string | null>(null);
  const [moveMode, setMoveMode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const ready = useRef<Promise<Workshop3DView> | null>(null);
  const resolveReady = useRef<((v: Workshop3DView) => void) | null>(null);
  if (!ready.current) ready.current = new Promise((r) => { resolveReady.current = r; });

  // Engine: loaded once per viewer; the scene is updated in place when a new version arrives.
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    loadEngine3d().then((engine) => {
      if (disposed || !canvas.current || !labelLayer.current) return;
      const v = engine.createWorkshop3D({
        canvas: canvas.current,
        labelLayer: labelLayer.current,
        background: themeBackground(),
        onSelect: (id) => setSelected(id),
        onError: (message) => onNotice(message, true),
      });
      view.current = v;
      setEngineLabel(engine.ENGINE_LABEL);
      v.setScene(sceneRef.current);
      const saved = readView(workshopId);
      if (saved.camera) v.restoreCamera(saved.camera);
      v.setLabels(saved.labels);
      v.setAutoRotate(saved.rotating);
      if (saved.exploded) void v.setExploded(1);
      observer = new ResizeObserver(() => v.resize());
      if (host.current) observer.observe(host.current);
      resolveReady.current?.(v);
    }).catch((err) => setFailed(errorText(err)));
    return () => {
      disposed = true;
      observer?.disconnect();
      const v = view.current;
      if (v) writeView(workshopId, { ...readView(workshopId), camera: v.cameraState() });
      v?.dispose();
      view.current = null;
    };
  }, [workshopId]);

  useEffect(() => { view.current?.setScene(scene); }, [scene, artifactId]);
  useEffect(() => { writeView(workshopId, { ...state, camera: view.current?.cameraState() ?? state.camera }); }, [state]);

  const component = useMemo(() => scene.components.find((c) => c.id === selected) ?? null, [scene, selected]);
  const groups = useMemo(() => {
    const map = new Map<string, SceneComponent[]>();
    for (const c of scene.components) { const g = c.group ?? ''; map.set(g, [...(map.get(g) ?? []), c]); }
    return [...map.entries()];
  }, [scene]);

  const setExploded = async (on: boolean) => { setState((s) => ({ ...s, exploded: on })); await view.current?.setExploded(on ? 1 : 0); };
  const setLabels = (on: boolean) => { view.current?.setLabels(on); setState((s) => ({ ...s, labels: on })); };
  const setRotating = (on: boolean) => { view.current?.setAutoRotate(on); setState((s) => ({ ...s, rotating: on })); };
  const select = (id: string | null) => { view.current?.select(id); setSelected(id); };
  const toggleHidden = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    view.current?.setVisible(id, !next.has(id));
    setHidden(next);
  };
  const isolate = (id: string | null) => { view.current?.isolate(id); setIsolated(id); };

  const toggleMove = (on: boolean) => {
    setMoveMode(on);
    view.current?.setMoveGizmo(on, (id, position) => {
      const c = sceneRef.current.components.find((x) => x.id === id);
      void onEdit([{ op: 'move', target: id, position }], `Moved ${c?.name ?? id}`);
    });
  };

  const exportGlb = async (): Promise<CommandOutcome> => {
    const v = await ready.current!;
    setBusy('Exporting GLB…');
    try {
      const { bytes, nodes } = await v.exportGlb(`${title}.glb`);
      const result = await api.exportWorkshopGlb(workshopId, artifactId, conversationId, bytes, nodes);
      if (!result.verified || !result.artifactId) return { ok: false, detail: `Core did not accept the export: ${result.checks.join('; ')}`, state: { verified: false, checks: result.checks } };
      onNotice(`Exported ${Math.round(result.byteSize / 1024)} KB GLB, verified by Core (${result.checks.length} checks). Use "Save a copy" to keep it anywhere.`);
      return { ok: true, detail: `GLB exported (${Math.round(result.byteSize / 1024)} KB) and verified by Core`, state: { exportArtifactId: result.artifactId, verified: true, checks: result.checks, byteSize: result.byteSize } };
    } catch (err) {
      return { ok: false, detail: errorText(err) };
    } finally {
      setBusy(null);
    }
  };

  const findComponent = (value: unknown): { id: string } | { error: string } => {
    const r = resolveComponents(sceneRef.current, String(value ?? ''));
    if (!r.ok) return { error: `${r.error}${r.candidates.length ? ` (components: ${r.candidates.slice(0, 8).join(', ')})` : ''}` };
    if (r.components.length > 1) return { error: `"${String(value)}" matches ${r.components.length} components: ${r.components.map((c) => c.name).join(', ')}` };
    return { id: r.components[0].id };
  };

  useImperativeHandle(ref, () => ({
    async run(action: string, args: Record<string, unknown>): Promise<CommandOutcome> {
      const v = await ready.current!;
      switch (action) {
        case 'rotate': setRotating(true); return { ok: true, detail: 'turntable rotation is on', state: { autoRotate: v.autoRotate() } };
        case 'stop_rotation': setRotating(false); return { ok: true, detail: 'rotation stopped', state: { autoRotate: v.autoRotate() } };
        case 'explode': {
          await setExploded(true);
          const inspected = v.inspect();
          return { ok: true, detail: `exploded view: ${inspected.meshCount} components moved apart`, state: { exploded: v.exploded(), meshes: inspected.meshes.slice(0, 12).map((m) => ({ name: m.name, position: m.position })) } };
        }
        case 'assemble': {
          await setExploded(false);
          const inspected = v.inspect();
          const drift = inspected.meshes.filter((m) => { const c = sceneRef.current.components.find((x) => x.id === m.id); return c && m.position.some((p, i) => Math.abs(p - c.position[i]) > 0.01); });
          return drift.length
            ? { ok: false, detail: `${drift.length} component(s) did not return to their stored positions` }
            : { ok: true, detail: `all ${inspected.meshCount} components are back at their stored positions`, state: { exploded: v.exploded() } };
        }
        case 'labels_on': setLabels(true); return { ok: true, detail: 'component labels are shown' };
        case 'labels_off': setLabels(false); return { ok: true, detail: 'labels hidden' };
        case 'reset_camera': v.setCamera('reset'); return { ok: true, detail: 'camera reset to the default view' };
        case 'camera': {
          const preset = String(args.value ?? args.preset ?? '').toLowerCase();
          if (!['front', 'top', 'side', 'iso', 'reset'].includes(preset)) return { ok: false, detail: `camera view must be front, top, side or iso (got "${preset}")` };
          v.setCamera(preset as CameraPreset);
          return { ok: true, detail: `${preset} view` };
        }
        case 'focus': case 'isolate': {
          const found = findComponent(args.component ?? args.value);
          if ('error' in found) return { ok: false, detail: found.error };
          if (action === 'focus') { v.focus(found.id); setSelected(found.id); } else isolate(found.id);
          const c = sceneRef.current.components.find((x) => x.id === found.id);
          return { ok: true, detail: `${action === 'focus' ? 'focused on' : 'showing only'} ${c?.name ?? found.id}` };
        }
        case 'show_all': isolate(null); for (const id of hidden) v.setVisible(id, true); setHidden(new Set()); return { ok: true, detail: 'all components shown' };
        case 'inspect': return { ok: true, detail: 'live renderer state', state: v.inspect() as unknown as Record<string, unknown> };
        case 'export': return exportGlb();
        default: return { ok: false, detail: `"${action.replace(/_/g, ' ')}" is not available in the 3D Workshop` };
      }
    },
    inspect: () => (view.current ? (view.current.inspect() as unknown as Record<string, unknown>) : null),
  }), [workshopId, artifactId, hidden]);

  if (failed) return <div className="notice error" role="alert" style={{ margin: 16 }}>The 3D view could not start: {failed}</div>;

  const presetValue = component ? component.material.preset : 'plastic';
  return (
    <div className="ws3d">
      <div className="ws-toolbar" role="toolbar" aria-label="3D view">
        <button type="button" className="btn small" aria-pressed={state.rotating} onClick={() => setRotating(!state.rotating)} title="Turntable rotation">{state.rotating ? 'Stop rotating' : 'Rotate'}</button>
        <button type="button" className="btn small" aria-pressed={state.exploded} onClick={() => void setExploded(!state.exploded)} title="Pull the components apart, or put them back">{state.exploded ? 'Assemble' : 'Explode'}</button>
        <button type="button" className="btn small" aria-pressed={state.labels} onClick={() => setLabels(!state.labels)}>{state.labels ? 'Hide labels' : 'Labels'}</button>
        <label className="sr-only" htmlFor="ws3d-cam">Camera view</label>
        <select id="ws3d-cam" className="ws-select" value="" onChange={(e) => { if (e.target.value) view.current?.setCamera(e.target.value as CameraPreset); }}>
          <option value="">View…</option>
          <option value="iso">Three-quarter</option>
          <option value="front">Front</option>
          <option value="side">Side</option>
          <option value="top">Top</option>
          <option value="reset">Reset</option>
        </select>
        <button type="button" className="btn small" aria-pressed={moveMode} disabled={!selected} onClick={() => toggleMove(!moveMode)} title={selected ? 'Drag the arrows to move the selected component; the new position is saved as a new version' : 'Select a component first'}>{moveMode ? 'Done moving' : 'Move'}</button>
        <span className="grow" />
        <button type="button" className="btn small" onClick={() => setShowTree(!showTree)} aria-expanded={showTree}>Parts</button>
        <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void exportGlb().then((r) => { if (!r.ok) onNotice(r.detail ?? 'Export failed', true); })}>Export GLB</button>
      </div>
      <div className="ws3d-body">
        {showTree && (
          <nav className="ws-tree" aria-label="Scene hierarchy">
            <div className="ws-tree-head">{scene.components.length} components</div>
            {groups.map(([group, list]) => (
              <div key={group || '_'} role="group" aria-label={group || 'Components'}>
                {group && <div className="ws-tree-group">{group}</div>}
                {list.map((c) => (
                  <div key={c.id} className={`ws-tree-row${selected === c.id ? ' selected' : ''}`}>
                    <button type="button" className="ws-tree-name" aria-current={selected === c.id ? 'true' : undefined} onClick={() => select(selected === c.id ? null : c.id)}>
                      <span className="swatch" style={{ background: c.material.color }} aria-hidden="true" />{c.name}
                    </button>
                    <button type="button" className="ws-eye" aria-label={hidden.has(c.id) ? `Show ${c.name}` : `Hide ${c.name}`} aria-pressed={!hidden.has(c.id)} onClick={() => toggleHidden(c.id)}>{hidden.has(c.id) ? '○' : '●'}</button>
                  </div>
                ))}
              </div>
            ))}
            {isolated && <button type="button" className="btn link" onClick={() => isolate(null)}>Show all components</button>}
          </nav>
        )}
        <div className="ws3d-stage" ref={host}>
          <canvas ref={canvas} className="ws3d-canvas" aria-label={`3D view of ${title}. Drag to orbit, scroll to zoom, right-drag to pan, click a part to select it.`} tabIndex={0} />
          <div ref={labelLayer} className="ws3d-labels" aria-hidden="true" />
          {!engineLabel && <div className="ws-loading" role="status">Starting the 3D engine…</div>}
          {busy && <div className="ws-loading" role="status">{busy}</div>}
          <div className="ws3d-hint">{engineLabel ? `${engineLabel} · drag to orbit · scroll to zoom · right-drag to pan` : ''}</div>
        </div>
        {component && (
          <aside className="ws-inspector" aria-label={`Selected: ${component.name}`}>
            <div className="ws-inspector-head"><strong>{component.name}</strong><button type="button" className="ghost-icon" aria-label="Clear selection" onClick={() => select(null)}>×</button></div>
            <div className="meta">{component.kind} · {Object.entries(component.params).map(([k, v]) => `${k} ${v}`).join(' · ')} mm</div>
            <div className="meta">at {component.position.map((n) => n.toFixed(1)).join(', ')} mm{component.group ? ` · ${component.group}` : ''}</div>
            <MaterialEditor key={`${component.id}:${artifactId}`} component={component} presetValue={presetValue} onApply={(material) => onEdit([{ op: 'set_material', target: component.id, material }], `${component.name}: ${MATERIAL_PRESETS[material.preset as MaterialPreset]?.label ?? material.preset}`)} />
            <div className="actions">
              <button type="button" className="btn small" onClick={() => view.current?.focus(component.id)}>Focus</button>
              <button type="button" className="btn small" onClick={() => isolate(isolated === component.id ? null : component.id)}>{isolated === component.id ? 'Show all' : 'Isolate'}</button>
            </div>
            {component.note && <p className="meta">{component.note}</p>}
          </aside>
        )}
      </div>
    </div>
  );
});

function MaterialEditor({ component, presetValue, onApply }: { component: SceneComponent; presetValue: string; onApply(material: { preset: string; color: string }): Promise<void> }) {
  const [preset, setPreset] = useState(presetValue);
  const [color, setColor] = useState(component.material.color);
  const [saving, setSaving] = useState(false);
  const changed = preset !== component.material.preset || color.toLowerCase() !== component.material.color.toLowerCase();
  return (
    <div className="ws-material">
      <label htmlFor={`ws-mat-${component.id}`} className="meta">Material</label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select id={`ws-mat-${component.id}`} className="ws-select" value={preset} onChange={(e) => { setPreset(e.target.value); setColor(MATERIAL_PRESETS[e.target.value as MaterialPreset]?.color ?? color); }}>
          {MATERIAL_PRESET_IDS.map((id) => <option key={id} value={id}>{MATERIAL_PRESETS[id].label}</option>)}
        </select>
        <input type="color" aria-label="Colour" value={color} onChange={(e) => setColor(e.target.value)} className="ws-color" />
      </div>
      <button type="button" className="btn small primary" disabled={!changed || saving} onClick={() => { setSaving(true); void onApply({ preset, color }).finally(() => setSaving(false)); }}>{saving ? 'Saving…' : 'Apply as new version'}</button>
    </div>
  );
}

export type { InspectState, Vec3 };
