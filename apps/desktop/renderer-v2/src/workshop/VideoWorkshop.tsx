/**
 * The Video workshop's viewer: the verified MP4 in a player, what the player itself measures (length, frame size,
 * where playback is), the recipe it was rendered from (the pictures and how long each is shown), and buttons that
 * render it again in another shape as a new version (Core re-renders from its own copies of the same pictures).
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { VIDEO_ASPECTS, recipeDuration, type VideoAspect, type VideoRecipe } from '../../../../../core/shared/workshop/video';
import type { CommandOutcome, ViewerHandle } from './viewerTypes';

interface Props {
  fileUrl: string;
  title: string;
  recipe: VideoRecipe | null;
  onSave(set: Record<string, unknown>, what: string): Promise<void>;
}

interface Measured { duration: number; width: number; height: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const VideoWorkshop = forwardRef<ViewerHandle, Props>(function VideoWorkshop({ fileUrl, title, recipe, onSave }, ref) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setMeasured(null); setError(null); }, [fileUrl]);

  const state = (): Record<string, unknown> => {
    const v = video.current;
    if (!v) return { loaded: false };
    return {
      loaded: v.readyState >= 1, durationSeconds: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
      videoWidth: v.videoWidth, videoHeight: v.videoHeight, currentTimeSeconds: Math.round(v.currentTime * 100) / 100,
      paused: v.paused, ended: v.ended, readyState: v.readyState, ...(error ? { error } : {}),
      ...(recipe ? { recipe: { aspect: recipe.aspect, pictures: recipe.scenes.length, secondsPerPicture: recipe.secondsPerScene } } : {}),
    };
  };

  useImperativeHandle(ref, () => ({
    async run(action: string, args: Record<string, unknown>): Promise<CommandOutcome> {
      const v = video.current;
      if (!v) return { ok: false, detail: 'the player is not ready' };
      switch (action) {
        case 'play': {
          if (v.ended) v.currentTime = 0;
          try { await v.play(); } catch (err) { return { ok: false, detail: `the player could not start: ${(err as Error).message}` }; }
          const from = v.currentTime;
          await sleep(700);
          const moved = v.currentTime > from;
          return { ok: moved, detail: moved ? `playing (at ${v.currentTime.toFixed(2)} s of ${v.duration.toFixed(2)} s)` : 'the player did not advance', state: state() };
        }
        case 'pause': v.pause(); return { ok: v.paused, detail: `paused at ${v.currentTime.toFixed(2)} s`, state: state() };
        case 'reset': v.pause(); v.currentTime = 0; return { ok: true, detail: 'back at the start', state: state() };
        case 'inspect': return { ok: v.readyState >= 1, detail: v.readyState >= 1 ? 'measured by the player' : 'the video has not loaded', state: state() };
        default: return { ok: false, detail: `"${action}" does not apply to a video (try play, pause, reset or inspect)` };
      }
    },
    inspect: state,
  }), [recipe, error]);

  async function reshape(aspect: VideoAspect) {
    if (!recipe || aspect === recipe.aspect) return;
    setBusy(`Rendering a ${VIDEO_ASPECTS[aspect].label.toLowerCase()} version on this PC…`);
    try { await onSave({ aspect }, `Video: ${VIDEO_ASPECTS[aspect].label.toLowerCase()} ${VIDEO_ASPECTS[aspect].width}×${VIDEO_ASPECTS[aspect].height}`); } finally { setBusy(null); }
  }

  const ratio = measured ? `${measured.width}×${measured.height}` : '';
  return (
    <div className="ws-video">
      <div className="ws-toolbar" role="toolbar" aria-label="Video">
        <button type="button" className="btn small" onClick={() => void video.current?.play()}>Play</button>
        <button type="button" className="btn small" onClick={() => video.current?.pause()}>Pause</button>
        {recipe && <span className="sep" />}
        {recipe && (Object.keys(VIDEO_ASPECTS) as VideoAspect[]).map((a) => (
          <button key={a} type="button" className="btn small" aria-pressed={recipe.aspect === a} disabled={Boolean(busy) || recipe.aspect === a}
            title={recipe.aspect === a ? 'This version' : `Render again as ${VIDEO_ASPECTS[a].ratio} (a new version)`} onClick={() => void reshape(a)}>
            {VIDEO_ASPECTS[a].label} {VIDEO_ASPECTS[a].ratio}
          </button>
        ))}
        <span className="grow" />
        <span className="meta">{measured ? `${ratio} · ${measured.duration.toFixed(2)} s · measured by the player` : 'Loading…'}</span>
      </div>
      {busy && <div className="ws-progress" role="status">{busy}</div>}
      <div className="ws-video-body">
        <div className="ws-video-stage">
          {error && <div className="notice error" role="alert">The video could not be played: {error}</div>}
          <video
            key={fileUrl}
            ref={video}
            src={fileUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={title}
            onLoadedMetadata={(e) => { const v = e.currentTarget; setMeasured({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }); }}
            onError={() => setError(video.current?.error?.message || `media error ${video.current?.error?.code ?? ''}`.trim())}
          />
        </div>
        <aside className="ws-video-side" aria-label="How it was made">
          <h4>This version</h4>
          {measured ? (
            <dl className="ws-facts">
              <dt>Frame</dt><dd>{measured.width}×{measured.height}{recipe ? ` (${VIDEO_ASPECTS[recipe.aspect].label} ${VIDEO_ASPECTS[recipe.aspect].ratio})` : ''}</dd>
              <dt>Length</dt><dd>{measured.duration.toFixed(2)} s{recipe ? ` (planned ${recipeDuration(recipe)} s)` : ''}</dd>
            </dl>
          ) : <p className="meta">Waiting for the player…</p>}
          {recipe ? (
            <>
              <h4>Pictures</h4>
              <ol className="ws-scenes">
                {recipe.scenes.map((s, i) => <li key={`${s.artifactId}-${i}`}><span>{s.name}</span> <span className="meta">{recipe.secondsPerScene} s{s.caption ? ` · “${s.caption}”` : ''}</span></li>)}
              </ol>
              <p className="meta">Pictures {recipe.fit === 'cover' ? 'fill the frame (edges cropped)' : 'are shown whole (with bars)'}. Rendered on this PC with FFmpeg; Core keeps its own copies of the pictures and checks them by SHA-256 before every render.</p>
            </>
          ) : <p className="meta">This video was made before the Workshop; it can be watched and saved, not rendered again.</p>}
        </aside>
      </div>
    </div>
  );
});
