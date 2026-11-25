/**
 * A 3D scene page: a Design-workshop page whose content is one scene function, drawn with three.js.
 *
 * Any scene a person describes cannot come from a fixed catalogue of parts, so here the scene is a program: the body of
 * `function (THREE, kit) { ... }`, written for the request by a model. It is never run by Core or by the Pandesh
 * window. It runs only inside the Workshop's sandboxed preview (apps/desktop/src/host/designPreview.ts): an opaque
 * origin with no network and no access to the window, files or storage. The host inlines the scene runtime
 * (renderer/v2/sceneRuntime.js) where the marker stands, so a stored page stays small and holds only what was written
 * for it.
 *
 * Pure TypeScript (no Node, no DOM): Core, the host and the window share these rules.
 */
export const SCENE_PAGE_FORMAT = 'pandesh.scene-page';
export const SCENE_RUNTIME_MARKER = '<!--pandesh:scene-runtime-->';
export const MAX_SCENE_CODE_BYTES = 120 * 1024;

const OPEN = '<script id="pandesh-scene">PandeshScene.run(function (THREE, kit) {\n';
const CLOSE = '\n});</script>';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ScenePageInfo { title: string; description: string; code: string }

/**
 * What the scene function may not contain. The sandbox already stops all of it from doing harm (no network, no access to
 * Pandesh); refusing it here keeps a page honest about what it is and gives the writer a clear reason.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/<\/script/i, 'the text "</script" (it would end the page\'s script)'],
  [/\bimport\s*\(|^\s*import\s/m, 'import (three.js is already there as THREE)'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/, 'network calls (the preview has no network)'],
  [/\beval\s*\(|\bnew\s+Function\b/, 'eval or new Function'],
  [/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/, 'browser storage (the preview has none)'],
  [/\bwindow\.(?:parent|top|opener)\b|\bpostMessage\b/, 'messages to the window around the preview'],
  [/\bPandeshScene\b/, 'PandeshScene (the page calls it for you)'],
];

export function checkSceneCode(code: string): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const text = String(code ?? '');
  if (!text.trim()) errors.push('the scene function is empty');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_SCENE_CODE_BYTES) errors.push(`the scene function is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_SCENE_CODE_BYTES / 1024} KB`);
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) errors.push(`it must not use ${what}`);
  if (!/\bkit\.|\bTHREE\./.test(text)) errors.push('it draws nothing: it never uses THREE or kit');
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The stored page for a scene function. The description is kept as data, for the next change and for the check. */
export function composeScenePage(input: ScenePageInfo): string {
  const meta = JSON.stringify({ format: SCENE_PAGE_FORMAT, version: 1, title: input.title.slice(0, 120), description: input.description.slice(0, 2_000) }).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title.slice(0, 120))}</title>`,
    `<script type="application/json" id="pandesh-scene-meta">${meta}</script>`,
    '</head><body>',
    SCENE_RUNTIME_MARKER,
    `${OPEN}${input.code.trim()}${CLOSE}`,
    '</body></html>',
  ].join('\n');
}

export function isScenePage(html: string): boolean {
  return html.includes(SCENE_RUNTIME_MARKER) && html.includes('id="pandesh-scene-meta"');
}

/** The scene function and what it was written for, read back from a stored page; null when it is not a scene page. */
export function parseScenePage(html: string): ScenePageInfo | null {
  if (!isScenePage(html)) return null;
  const start = html.indexOf(OPEN); const end = html.lastIndexOf(CLOSE);
  if (start < 0 || end < start) return null;
  const metaMatch = /<script type="application\/json" id="pandesh-scene-meta">([\s\S]*?)<\/script>/.exec(html);
  let title = 'Scene'; let description = '';
  try { const m = JSON.parse(metaMatch?.[1] ?? '{}') as { title?: unknown; description?: unknown }; title = String(m.title ?? title).slice(0, 120); description = String(m.description ?? '').slice(0, 2_000); } catch { /* the code is still readable */ }
  return { title, description, code: html.slice(start + OPEN.length, end) };
}

/** The page as the preview serves it: the runtime where the marker stands, told the nonce it may report with. */
export function withSceneRuntime(html: string, runtime: string, nonce: string): string {
  if (!html.includes(SCENE_RUNTIME_MARKER)) return html;
  const safe = runtime.replace(/<\/script/gi, '<\\/script');
  // A function, never a replacement string: three.js is full of "$&" and "$'" which String.replace would expand,
  // corrupting the runtime (found live, 2026-11-23: "Unexpected identifier 'mediump'").
  return html.replace(SCENE_RUNTIME_MARKER, () => `<script>window.__PANDESH_SCENE_NONCE=${JSON.stringify(nonce)};</script>\n<script>${safe}</script>`);
}

/** What the scene reported about itself from inside the preview (numbers and names; data, never instructions). */
export interface SceneFacts {
  ok: boolean; error: string | null; engine: string; meshes: number; triangles: number;
  groups: Array<{ name: string; meshes: number; visible: boolean }>;
  size: [number, number, number]; lights: number; shadows: boolean; animated: boolean; frames: number;
}

export function cleanSceneFacts(raw: unknown): SceneFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const size = Array.isArray(r.size) ? r.size.slice(0, 3).map(n) : [0, 0, 0];
  return {
    ok: r.ok === true, error: typeof r.error === 'string' && r.error ? r.error.slice(0, 400) : null,
    engine: String(r.engine ?? '').slice(0, 40), meshes: n(r.meshes), triangles: n(r.triangles),
    groups: Array.isArray(r.groups) ? r.groups.slice(0, 24).map((g) => { const o = (g ?? {}) as Record<string, unknown>; return { name: String(o.name ?? '').slice(0, 40), meshes: n(o.meshes), visible: o.visible !== false }; }) : [],
    size: [size[0] ?? 0, size[1] ?? 0, size[2] ?? 0], lights: n(r.lights), shadows: r.shadows === true, animated: r.animated === true, frames: n(r.frames),
  };
}
