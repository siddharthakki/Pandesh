/**
 * The Workshop: the third context beside Chat and Activity. It shows what Pandesh made in this conversation in a
 * viewer that fits it (3D scene, image, video…), with every version, what made it, what Core checked, and the
 * controls to change it, compare versions and take the file away. Everything shown comes from Core's verified
 * artifacts; nothing is drawn from the model's own description.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, type WorkshopContent, type WorkshopSummary } from '../bridge';
import { timeOf } from '../ui';
import { WORKSHOP_TYPE_LABEL, type WorkshopVersion } from '../../../../../core/shared/workshop/model';
import { diffScenes, type Scene3D } from '../../../../../core/shared/workshop/scene3d';
import { lineDiff } from '../../../../../core/shared/workshop/design';
import { Viewer3D } from './Viewer3D';
import { ImageViewer } from './ImageViewer';
import { SimulationLab } from './SimulationLab';
import { DesignPreview } from './DesignPreview';
import { VideoWorkshop } from './VideoWorkshop';
import type { CommandOutcome, ViewerHandle } from './viewerTypes';
import type { WorkshopState } from './useWorkshop';

interface Props {
  conversationId: string | null;
  workshop: WorkshopState;
  narrow: boolean;
}

const OP_WORDS: Record<string, string> = { create: 'Created', edit: 'Edited', restore: 'Restored', export: 'Exported', generate: 'Generated', refine: 'Refined', render: 'Rendered' };

function costLine(v: WorkshopVersion): string {
  const e = v.meta.engine;
  const where = e.provider === 'local' ? 'Ran on this PC' : 'Cloud';
  const cost = e.costUsd === null ? 'cost not reported' : e.costUsd === 0 ? 'no money spent' : `$${e.costUsd.toFixed(4)}`;
  return `${where} · ${cost}`;
}

export function WorkshopPanel({ conversationId, workshop, narrow }: Props) {
  const { ui, setUi, list, refresh, queue, take, progress, confirm } = workshop;
  const [extra, setExtra] = useState<WorkshopSummary | null>(null);
  const [recent, setRecent] = useState<WorkshopSummary[]>([]);
  const [content, setContent] = useState<WorkshopContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<null | 'history' | 'info'>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [compareContent, setCompareContent] = useState<WorkshopContent | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const viewer = useRef<ViewerHandle | null>(null);
  const busyCommands = useRef(new Set<string>());

  const summary = useMemo(() => (ui?.workshopId ? list.find((w) => w.workshopId === ui.workshopId) ?? (extra?.workshopId === ui.workshopId ? extra : null) : null), [list, extra, ui?.workshopId]);
  const artifactId = ui?.artifactId ?? summary?.latestArtifactId ?? null;
  const version = summary?.versions.find((v) => v.artifactId === artifactId) ?? null;

  // A workshop from another conversation ("open the last design") is looked up among the recent ones.
  useEffect(() => {
    if (!ui?.workshopId || list.some((w) => w.workshopId === ui.workshopId)) return;
    void api.listWorkshops(null, 'recent').then((all) => setExtra(all.find((w) => w.workshopId === ui.workshopId) ?? null)).catch(() => setExtra(null));
  }, [ui?.workshopId, list]);
  useEffect(() => { if (!ui?.workshopId) void api.listWorkshops(null, 'recent').then(setRecent).catch(() => setRecent([])); }, [ui?.workshopId, list.length]);

  // The version on screen: read from Core's verified file every time it changes.
  useEffect(() => {
    if (!artifactId) { setContent(null); return; }
    let live = true;
    setLoadError(null);
    api.loadWorkshopVersion(artifactId).then((c) => { if (live) setContent(c); }).catch((err) => { if (live) { setContent(null); setLoadError(errorText(err)); } });
    return () => { live = false; };
  }, [artifactId]);

  useEffect(() => {
    if (!compareId) { setCompareContent(null); return; }
    let live = true;
    api.loadWorkshopVersion(compareId).then((c) => { if (live) setCompareContent(c); }).catch(() => { if (live) setCompareContent(null); });
    return () => { live = false; };
  }, [compareId]);
  useEffect(() => { setCompareId(null); setDrawer(null); setNotice(null); }, [ui?.workshopId]);

  // Core's commands, carried out once the right version is on screen; each answered with what really happened.
  const loaded = Boolean(content && content.artifactId === artifactId);
  useEffect(() => {
    for (const cmd of queue) {
      if (busyCommands.current.has(cmd.id)) continue;
      if (cmd.workshopId !== ui?.workshopId) continue;
      if (loadError && (cmd.action === 'open' || cmd.action === 'show_version')) { take(cmd.id); confirm(cmd, false, `the version could not be opened: ${loadError}`); continue; }
      if (!loaded || !summary || !version) continue;
      busyCommands.current.add(cmd.id);
      void runCommand(cmd.action, cmd.args).then((out) => {
        take(cmd.id);
        busyCommands.current.delete(cmd.id);
        confirm(cmd, out.ok, out.detail ?? '', out.state);
      });
    }
  }, [queue, loaded, loadError, summary?.workshopId, version?.artifactId]);

  async function runCommand(action: string, args: Record<string, unknown>): Promise<CommandOutcome> {
    if (!summary || !version) return { ok: false, detail: 'nothing is open in the Workshop' };
    if (action === 'open' || action === 'show_version') {
      return { ok: true, detail: `showing ${WORKSHOP_TYPE_LABEL[summary.type]} "${summary.title}", version ${version.number} of ${summary.versions.length}`, state: { workshopId: summary.workshopId, artifactId: version.artifactId, version: version.number } };
    }
    if (action === 'compare') {
      const other = summary.versions.find((v) => v.artifactId === args.compareWith);
      if (!other) return { ok: false, detail: 'no version to compare with' };
      if (other.artifactId === version.artifactId) return { ok: false, detail: `both sides are version ${version.number}` };
      // The newer version is shown; the changes read from the older one to it.
      const [older, newer] = other.number < version.number ? [other, version] : [version, other];
      setCompareId(older.artifactId);
      if (newer.artifactId !== version.artifactId) show(newer.artifactId === summary.latestArtifactId ? null : newer.artifactId);
      return { ok: true, detail: `comparing version ${older.number} with version ${newer.number}`, state: { from: older.number, to: newer.number } };
    }
    if (!viewer.current) return { ok: false, detail: `the ${WORKSHOP_TYPE_LABEL[summary.type]} viewer is not ready` };
    return viewer.current.run(action, args);
  }

  const show = (id: string | null) => { if (ui) setUi({ ...ui, artifactId: id }); };
  const onEdit = async (edits: unknown[] | { set?: Record<string, unknown> }, what: string) => {
    if (!summary || !version) return;
    try {
      const { artifactId: next } = await api.saveWorkshopEdit(summary.workshopId, version.artifactId, conversationId, edits);
      await refresh();
      if (ui) setUi({ ...ui, artifactId: next });
      setNotice({ text: `${what} — saved as a new version. The earlier version is kept.` });
    } catch (err) {
      setNotice({ text: `Not saved: ${errorText(err)}`, error: true });
    }
  };

  const changes = useMemo(() => {
    if (!compareContent || !content || compareContent.type !== '3d' || content.type !== '3d') return null;
    return diffScenes((compareContent as { scene: Scene3D }).scene, (content as { scene: Scene3D }).scene);
  }, [compareContent, content]);
  const designChanges = useMemo(() => {
    if (compareContent?.type !== 'design' || content?.type !== 'design') return null;
    const lines = lineDiff(compareContent.html, content.html, 0);
    return { added: lines.filter((l) => l.kind === '+').length, removed: lines.filter((l) => l.kind === '-').length };
  }, [compareContent, content]);

  if (!ui) return null;
  const mode = ui.mode;
  const compareVersion = summary?.versions.find((v) => v.artifactId === compareId) ?? null;
  const progressHere = progress && (!progress.workshopId || progress.workshopId === summary?.workshopId) && Date.now() - Date.parse(progress.at) < 5 * 60_000 ? progress : null;

  return (
    <section className={`ws-panel${narrow ? ' narrow' : ''}`} data-mode={mode} aria-label="Workshop">
      <header className="ws-head">
        <span className="ws-type">{summary ? WORKSHOP_TYPE_LABEL[summary.type] : 'Workshop'}</span>
        <span className="ws-title" title={summary?.title}>{summary?.title ?? (ui.workshopId ? 'Opening…' : 'Workshop')}</span>
        {summary && version && (
          <span className="ws-versions">
            <button type="button" className="ghost-icon" aria-label="Previous version" disabled={version.number <= 1} onClick={() => show(summary.versions[version.number - 2]?.artifactId ?? null)}>‹</button>
            <label className="sr-only" htmlFor="ws-version">Version</label>
            <select id="ws-version" className="ws-select" value={version.artifactId} onChange={(e) => show(e.target.value === summary.latestArtifactId ? null : e.target.value)}>
              {summary.versions.map((v) => <option key={v.artifactId} value={v.artifactId}>v{v.number} of {summary.versions.length} · {OP_WORDS[v.meta.op.kind] ?? v.meta.op.kind}{v.artifactId === summary.latestArtifactId ? ' (latest)' : ''}</option>)}
            </select>
            <button type="button" className="ghost-icon" aria-label="Next version" disabled={version.number >= summary.versions.length} onClick={() => show(summary.versions[version.number]?.artifactId ?? null)}>›</button>
          </span>
        )}
        <span className="grow" />
        {summary && <button type="button" className="btn small" aria-pressed={drawer === 'history'} onClick={() => setDrawer(drawer === 'history' ? null : 'history')}>History</button>}
        {summary && <button type="button" className="btn small" aria-pressed={drawer === 'info'} onClick={() => setDrawer(drawer === 'info' ? null : 'info')}>Details</button>}
        {version && <button type="button" className="btn small" onClick={() => void api.saveWorkshopFile(version.artifactId).then((r) => r.saved && setNotice({ text: `Saved a copy to ${r.path}` })).catch((err) => setNotice({ text: errorText(err), error: true }))}>Save a copy</button>}
        {!narrow && <button type="button" className="btn small" onClick={() => setUi({ ...ui, mode: mode === 'full' ? 'side' : 'full' })}>{mode === 'full' ? 'Beside chat' : 'Full window'}</button>}
        <button type="button" className="ghost-icon" aria-label="Close the Workshop" title="Close (the work is kept)" onClick={() => setUi(null)}>×</button>
      </header>

      {progressHere && <div className="ws-progress" role="status">{progressHere.stage}{progressHere.total ? ` · ${progressHere.index ?? 0} of ${progressHere.total}` : ''}</div>}
      {notice && <div className={`notice${notice.error ? ' error' : ''} ws-notice`} role={notice.error ? 'alert' : 'status'}>{notice.text} <button type="button" className="btn link" onClick={() => setNotice(null)}>OK</button></div>}
      {compareId && compareVersion && version && (
        <div className="ws-compare" role="region" aria-label="Compare versions">
          <strong>Comparing v{compareVersion.number} → v{version.number}</strong>
          {changes && (changes.length ? <ul>{changes.slice(0, 12).map((c, i) => <li key={i}><span className="meta">{c.name}</span> {c.field}: {c.from && <><del>{c.from}</del> → </>}{c.to}</li>)}</ul> : <p className="meta">No differences.</p>)}
          {designChanges && <p className="meta">{designChanges.added} line{designChanges.added === 1 ? '' : 's'} added, {designChanges.removed} removed in the page source. Open <strong>Changes</strong> in the preview's toolbar to read them.</p>}
          {content?.type === 'image' && compareContent?.type === 'image' && (
            <div className="ws-side-by-side">
              <figure><img src={compareContent.dataUrl} alt={`Version ${compareVersion.number}`} /><figcaption>v{compareVersion.number} · {compareVersion.meta.op.summary.slice(0, 80)}</figcaption></figure>
              <figure><img src={content.dataUrl} alt={`Version ${version.number}`} /><figcaption>v{version.number} · {version.meta.op.summary.slice(0, 80)}</figcaption></figure>
            </div>
          )}
          {content?.type === 'video' && compareContent?.type === 'video' && (
            <div className="ws-side-by-side">
              <figure><video src={compareContent.fileUrl} controls muted preload="metadata" aria-label={`Version ${compareVersion.number}`} /><figcaption>v{compareVersion.number}{compareContent.recipe ? ` · ${compareContent.recipe.width}×${compareContent.recipe.height}` : ''}</figcaption></figure>
              <figure><video src={content.fileUrl} controls muted preload="metadata" aria-label={`Version ${version.number}`} /><figcaption>v{version.number}{content.recipe ? ` · ${content.recipe.width}×${content.recipe.height}` : ''}</figcaption></figure>
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn small" onClick={() => { const a = compareId; setCompareId(version.artifactId); show(a); }}>Swap</button>
            <button type="button" className="btn small" onClick={() => setCompareId(null)}>Done comparing</button>
          </div>
        </div>
      )}

      <div className="ws-body">
        {!ui.workshopId && <Gallery list={list} recent={recent} onOpen={(w) => setUi({ workshopId: w.workshopId, artifactId: null, mode: ui.mode })} />}
        {ui.workshopId && loadError && <div className="notice error" role="alert" style={{ margin: 16 }}>This version could not be opened: {loadError}</div>}
        {ui.workshopId && !loadError && !loaded && <div className="ws-loading" role="status">Opening…</div>}
        {summary && version && loaded && content?.type === '3d' && (
          <Viewer3D ref={viewer} scene={content.scene} artifactId={content.artifactId} workshopId={summary.workshopId} conversationId={conversationId} title={summary.title} onEdit={onEdit} onNotice={(text, error) => setNotice({ text, error })} />
        )}
        {summary && version && loaded && content?.type === 'image' && <ImageViewer ref={viewer} src={content.dataUrl} title={summary.title} />}
        {summary && version && loaded && content?.type === 'video' && (
          <VideoWorkshop ref={viewer} fileUrl={content.fileUrl} title={summary.title} recipe={content.recipe} onSave={(set, what) => onEdit({ set }, what)} />
        )}
        {summary && version && loaded && content?.type === 'simulation' && (
          <SimulationLab ref={viewer} spec={content.spec} compareSpec={compareContent?.type === 'simulation' ? compareContent.spec : null}
            onSave={(set, what) => onEdit({ set }, `Simulation: ${what}`)} />
        )}
        {summary && version && loaded && content?.type === 'design' && (
          <DesignPreview ref={viewer} artifactId={content.artifactId} html={content.html} title={summary.title}
            compareHtml={compareContent?.type === 'design' ? compareContent.html : null} compareLabel={compareVersion ? `v${compareVersion.number}` : null} />
        )}
        {drawer && summary && version && (
          <aside className="ws-drawer" aria-label={drawer === 'history' ? 'Version history' : 'Details'}>
            {drawer === 'history' && (
              <ol className="ws-history">
                {[...summary.versions].reverse().map((v) => (
                  <li key={v.artifactId} className={v.artifactId === version.artifactId ? 'current' : undefined}>
                    <div><strong>v{v.number}</strong> · {OP_WORDS[v.meta.op.kind] ?? v.meta.op.kind} · {timeOf(v.createdAt)}</div>
                    <div className="meta">{v.meta.op.summary}</div>
                    <div className="actions">
                      {v.artifactId !== version.artifactId && <button type="button" className="btn small" onClick={() => show(v.artifactId === summary.latestArtifactId ? null : v.artifactId)}>Show</button>}
                      {v.artifactId !== version.artifactId && <button type="button" className="btn small" onClick={() => setCompareId(v.artifactId)}>Compare with shown</button>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {drawer === 'info' && (
              <dl className="ws-info">
                <dt>Made by</dt><dd>{version.meta.engine.tool}{version.meta.engine.engine ? ` · ${version.meta.engine.engine}` : ''}{version.meta.engine.model ? ` · model ${version.meta.engine.model}` : ''}</dd>
                <dt>Where</dt><dd>{costLine(version)}</dd>
                <dt>What changed</dt><dd>{version.meta.op.summary}</dd>
                <dt>Checked by Core</dt><dd>{version.meta.verification ? version.meta.verification.checks.map((c, i) => <div key={i}>{c}</div>) : 'No checks recorded for this version.'}</dd>
                {version.meta.notes?.length ? <><dt>Notes</dt><dd>{version.meta.notes.map((n, i) => <div key={i}>{n}</div>)}</dd></> : null}
                <dt>File</dt><dd>{version.mimeType} · {Math.max(1, Math.round(version.byteSize / 1024))} KB · {version.availability === 'ready' ? 'verified on disk (SHA-256)' : version.availability}</dd>
                <dt>Made</dt><dd>{new Date(version.createdAt).toLocaleString()}</dd>
                <dt>Ids</dt><dd className="mono">{summary.workshopId}<br />{version.artifactId}</dd>
                {summary.exports.length > 0 && <><dt>Exports</dt><dd>{summary.exports.map((x) => <div key={x.artifactId}>{x.title} · {Math.round(x.byteSize / 1024)} KB · {x.meta.verification?.ok ? 'verified by Core' : 'not verified'} <button type="button" className="btn link" onClick={() => void api.saveWorkshopFile(x.artifactId).then((r) => r.saved && setNotice({ text: `Saved a copy to ${r.path}` }))}>Save a copy</button></div>)}</dd></>}
              </dl>
            )}
          </aside>
        )}
      </div>
      {version && (
        <footer className="ws-foot">
          <span>{OP_WORDS[version.meta.op.kind] ?? version.meta.op.kind} {timeOf(version.createdAt)}: {version.meta.op.summary}</span>
          <span className="grow" />
          <span className={version.meta.verification?.ok ? 'ok' : undefined}>{version.meta.verification ? (version.meta.verification.ok ? 'Checked by Core' : 'Check failed') : ''}</span>
          <span>{costLine(version)}</span>
        </footer>
      )}
    </section>
  );
}

function Gallery({ list, recent, onOpen }: { list: WorkshopSummary[]; recent: WorkshopSummary[]; onOpen(w: WorkshopSummary): void }) {
  const others = recent.filter((r) => !list.some((w) => w.workshopId === r.workshopId)).slice(0, 12);
  const card = (w: WorkshopSummary) => (
    <button key={w.workshopId} type="button" className="ws-card" onClick={() => onOpen(w)}>
      <span className="ws-type">{WORKSHOP_TYPE_LABEL[w.type]}</span>
      <span className="ws-card-title">{w.title}</span>
      <span className="meta">{w.versions.length} version{w.versions.length === 1 ? '' : 's'} · {new Date(w.updatedAt).toLocaleString()}</span>
    </button>
  );
  return (
    <div className="ws-gallery">
      <h3>In this conversation</h3>
      {list.length ? <div className="ws-cards">{list.map(card)}</div> : <p className="meta">Nothing yet. Ask Pandesh to build a 3D model, run a simulation or design a page, and it opens here.</p>}
      {others.length > 0 && <><h3>Recent, from other conversations</h3><div className="ws-cards">{others.map(card)}</div></>}
    </div>
  );
}
