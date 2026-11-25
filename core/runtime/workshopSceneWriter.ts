/**
 * Writes a 3D scene for the Workshop and has it looked at, with models on THIS PC only.
 *
 * The scene is the body of `function (THREE, kit) { ... }` (core/shared/workshop/scenePage.ts): three.js, drawn inside the
 * sandboxed preview. The writer is the conversation's local model with one job and a JSON schema to fill. The judge is a
 * local vision model that is shown pictures the scene rendered of itself and says which requested things it can see.
 * Neither call leaves the machine: both go to a loopback address, and a non-loopback endpoint is refused.
 *
 * Core never runs the scene function. It only checks that the text is a function body the engine can parse.
 */
import * as fs from 'node:fs';
import { checkSceneCode } from '../shared/workshop/scenePage';
import { DEFAULT_OLLAMA_URL } from './modelBackend';
import { isLoopbackUrl } from './localVisionInspector';
import { chooseModel, snapshotModels, type ModelSnapshot } from './modelAwareness';

export interface SceneWriterOptions {
  model: string;
  ollamaUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  numCtx?: number;
  /** Frees the writer's memory as soon as it has answered: set when another model (the chat's, the one that looks at the pictures) must run next, since two large models do not fit one graphics card. */
  unloadAfter?: boolean;
  timeoutMs?: number;
  onStage?: (stage: string) => void;
}

export type SceneWriteResult =
  | { ok: true; code: string; title: string; model: string; attempts: number }
  | { ok: false; error: string; model: string; attempts: number };

/** What the writer is told about the page it writes for. The example is deliberately small: a pattern, not a scene. */
export const SCENE_WRITER_RULES = [
  'You write one 3D scene with three.js for an interactive viewer. Answer only with JSON: {"title": "...", "things": [...], "code": "..."}.',
  'First fill "things": one entry for every thing the request names, counted (three birds are three entries placed apart), each with the parts you will build it from, its real size in metres and where it stands. Then write "code" so that it builds exactly those things.',
  '"code" is the BODY of function (THREE, kit) { ... }. Do not write the function line, HTML, imports or a render loop: the page already has the renderer, sky, sun with shadows, orbit camera and resize handling.',
  'Units are metres. Y is up. The ground is y = 0. A position is the CENTRE of a shape: a box of height h standing on the ground has y = h / 2. Things rest on what carries them; nothing floats unless it flies and nothing is buried.',
  'One box, cylinder or sphere is never a thing. Build every thing from several parts so that it is recognised by its outline: a rowing boat is a long hull that narrows to a pointed bow, a rim, two bench seats and two oars; a bird is a body, a head with a beak, two wings angled upward and a tail; a jetty is a deck of planks on a row of posts. Write a small function for a thing that appears more than once and call it for each one.',
  'Use real sizes (a person 1.7 m, a door 2 m, a car 4.5 m long, a house 6 to 10 m wide) and keep all things within about 60 m of each other, close enough to be seen together. Small things next to large ones may be made up to twice their real size so they can be seen. The land or water around them is kit.ground(size, color, surface), never a shape of your own.',
  'Give things fitting colours that stand out from what is behind them.',
  'Put every thing in a named group so the viewer can show and hide it: kit.add(object, "Boat"). Use 3 to 10 groups with plain names.',
  'kit helpers (all return three.js objects you still have to add with kit.add):',
  '- kit.box(w, h, d, color, [x, y, z]); kit.cylinder(radiusTop, radiusBottom, height, color, [x, y, z]); kit.cone(radius, height, color, [x, y, z]); kit.sphere(radius, color, [x, y, z])',
  '- kit.extrude([[x, y], ...], depth, color, [x, y, z]) — a flat outline (in X/Y) pushed into depth along Z: hulls, wings, arches, letters, gables. kit.lathe([[radius, y], ...], color, [x, y, z]) — a profile spun round the Y axis: towers, domes, vases, wheels. kit.tube([[x, y, z], ...], radius, color) — a round bar along a path: ropes, rails, pipes, branches.',
  '- kit.mat(color, { roughness, metalness, opacity, emissive, surface, repeat: [x, y] }) — surface is one of brick, roof, grass, wood, paving, soil, sand, water, stone, asphalt. Wherever a color is asked, a hex string or a kit.mat(...) may be given.',
  '- kit.ground(size, color, surface) adds the ground itself. kit.sky(topColor, horizonColor). kit.sun([x, y, z], intensity). The camera frames the scene by itself.',
  'Ready-made assets. Use them whenever the request names such a thing instead of building it from shapes; each returns a group that stands on y = 0 around its own origin and faces +Z, which you position (asset.position.set(x, 0, z)), turn (asset.rotation.y) and add with kit.add(asset, "Name"):',
  '- kit.house({ width: 10, depth: 8, storeys: 1 | 2 | 3, walls: "render" | "brick" | "wood" | "stone", groundWalls: (same choices, for a different ground floor), wallColor, roofColor, trimColor, doorColor, shutters: "#3d6b5c" | false, chimney: true, porch: true, balcony: true, dormers: 0 to 3, garage: "left" | "right" | false, flowerBoxes: true, furnished: true, lit: false }) — a complete house: walls with real framed windows, shutters, front door with porch and steps, balcony, tiled gable roof with chimney and dormers, garage, furnished rooms. Its roof and floors get their own show/hide toggles by themselves. After building, house.userData.door = { x, z } is where a path to the front door should end and house.userData.garageDoor = { x, z } where a driveway should end (both relative to the house), and house.userData.width, depth, height give its size. Never rebuild a house from boxes.',
  '- kit.tree("oak" | "spruce" | "apple" | "palm" | "birch", scale); kit.shrub(radius, color, flowerColor); kit.hedge([x0, z0], [x1, z1], height); kit.flowerBed(width, depth, [colors]); kit.vegetablePatch(width, depth); kit.pond(radius); kit.rock(size, color)',
  '- kit.path([[x, z], [x, z], ...], width, "paving" | "asphalt" | "sand" | "stone", color) — a path or driveway on the ground; kit.patio(width, depth); kit.patioSet({ chairs: 4, parasol: true }); kit.bench(); kit.swing(); kit.lamp(height); kit.mailbox()',
  '- kit.fenceAround(width, depth, { gate: "front" | "back" | "left" | "right" | false, gateAt: x, color, height }) — a picket fence round a plot centred on its origin, with posts and a gate; kit.fence([x0, z0], [x1, z1], color) for one run.',
  '- kit.car(color) — 4.4 m long along X; kit.person(shirtColor, height); kit.cloud(scale).',
  '- kit.wall({ length, height, thickness, color, surface, openings: [{ x, w, y, h, kind: "window" | "door" | "glassdoor" | "gap" }] }) and kit.gableRoof({ width, depth, rise, overhang, color }) — for buildings that are not a house (a barn, a shop, a station).',
  'A house with a garden is laid out like this: the house at the origin facing +Z; a fenced plot about 2.4 times the house width and 2.6 times its depth, its gate in front at the x of the front door (gateAt: house.userData.door.x); a straight path from the door point to the gate; trees of different kinds near the corners of the plot, well away from the house and the path; flower beds and shrubs along the front wall beside the door; the patio with its table behind or beside the house, touching it; a bench, lamp or pond in the free lawn. Work out each position from the house and plot sizes and check that no two things stand on the same spot.',
  '- kit.animate(function (t, dt) { ... }) for movement; t and dt are in seconds. Set positions from t (x = cx + r * Math.cos(t)), do not add to them every frame.',
  'There are no other kit helpers. Everything else comes from THREE (THREE.Group, THREE.Mesh, THREE.TorusGeometry, THREE.PointLight, object.rotation, object.scale ...).',
  'Not available: import, fetch, images or files, eval, storage. Textures come only from kit.mat surfaces.',
  'Example of the form (a duck on a pond by a tree):',
  'kit.ground(40, "#5f9a3d", "grass");\nconst pond = kit.cylinder(5, 5, 0.1, kit.mat("#3f8fc4", { surface: "water", repeat: [3, 3], roughness: 0.2 }), [0, 0.05, 0]);\nkit.add(pond, "Pond");\nfunction duck(x, z, turn) {\n  const g = new THREE.Group();\n  const body = kit.sphere(0.35, "#f4f1e8", [0, 0.3, 0]); body.scale.set(1.5, 0.8, 1);\n  const tail = kit.cone(0.14, 0.3, "#f4f1e8", [-0.55, 0.42, 0]); tail.rotation.z = 1.1;\n  const neck = kit.cylinder(0.09, 0.11, 0.35, "#f4f1e8", [0.38, 0.6, 0]);\n  const head = kit.sphere(0.16, "#2f6b3a", [0.42, 0.84, 0]);\n  const beak = kit.cone(0.06, 0.2, "#e8a020", [0.62, 0.82, 0]); beak.rotation.z = -Math.PI / 2;\n  g.add(body, tail, neck, head, beak); g.position.set(x, 0.1, z); g.rotation.y = turn; return g;\n}\nkit.add(duck(1, 0.5, 0.4), "Ducks");\nconst tree = kit.tree("oak", 1.1); tree.position.set(-7, 0, 2);\nkit.add(tree, "Trees");',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    things: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, parts: { type: 'string' }, size: { type: 'string' }, place: { type: 'string' } }, required: ['name', 'parts', 'size', 'place'] } },
    code: { type: 'string' },
  },
  required: ['title', 'things', 'code'],
};

/** True when the text parses as a function body. It is compiled, never called. */
export function parsesAsFunctionBody(code: string): { ok: true } | { ok: false; error: string } {
  try {
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    void new Function('THREE', 'kit', `"use strict";\n${code}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Both checks a scene function must pass before it is saved. */
export function checkWrittenScene(code: string): { ok: true } | { ok: false; errors: string[] } {
  const rules = checkSceneCode(code);
  if (!rules.ok) return rules;
  const parsed = parsesAsFunctionBody(code);
  return parsed.ok ? { ok: true } : { ok: false, errors: [`it is not valid JavaScript: ${parsed.error}`] };
}

/**
 * Asks the local model for the scene. `feedback` is what was wrong with the previous version (a runtime error, or what the
 * picture check could not see), with that version's code, for one repair.
 */
export async function writeSceneCode(description: string, options: SceneWriterOptions, feedback?: { previousCode: string; problems: string[] }): Promise<SceneWriteResult> {
  const root = (options.ollamaUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  if (!isLoopbackUrl(root)) return { ok: false, error: `the model endpoint ${root} is not on this PC`, model: options.model, attempts: 0 };
  const fetcher = options.fetchImpl ?? fetch;
  const ask = description.replace(/\s+/g, ' ').trim().slice(0, 2_000);
  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SCENE_WRITER_RULES }, { role: 'user', content: `Scene: ${ask}` }];
  if (feedback) {
    messages.push({ role: 'assistant', content: JSON.stringify({ title: '', code: feedback.previousCode.slice(0, 24_000) }) });
    messages.push({ role: 'user', content: `That scene was drawn and checked. Problems: ${feedback.problems.join('; ').slice(0, 1_500)}. Write the whole scene again with these fixed, keeping what was right.` });
  }
  let last = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    options.onStage?.(attempt === 1 ? `${feedback ? 'Correcting' : 'Writing'} the scene with ${options.model} on this PC` : `Asking ${options.model} again: ${last.slice(0, 80)}`);
    let raw = '';
    try {
      const res = await fetcher(`${root}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 600_000),
        body: JSON.stringify({ model: options.model, stream: false, think: false, format: SCHEMA, messages, ...(options.unloadAfter ? { keep_alive: 0 } : {}), options: { temperature: 0.3, num_ctx: options.numCtx ?? SCENE_WRITER_CTX } }),
      });
      if (!res.ok) return { ok: false, error: `the local model answered ${res.status}`, model: options.model, attempts: attempt };
      raw = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
    } catch (err) {
      return { ok: false, error: options.signal?.aborted ? 'cancelled' : `the local model did not answer: ${err instanceof Error ? err.message : String(err)}`, model: options.model, attempts: attempt };
    }
    let value: { title?: unknown; code?: unknown };
    try { value = JSON.parse(raw) as typeof value; } catch { last = 'the answer was not JSON'; messages.push({ role: 'assistant', content: raw.slice(0, 4_000) }, { role: 'user', content: 'That was not valid JSON. Answer again with JSON only.' }); continue; }
    const code = String(value.code ?? '');
    const check = checkWrittenScene(code);
    if (check.ok) return { ok: true, code, title: String(value.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || ask.slice(0, 60), model: options.model, attempts: attempt };
    last = check.errors.join('; ');
    messages.push({ role: 'assistant', content: raw.slice(0, 24_000) }, { role: 'user', content: `That scene cannot be used: ${last.slice(0, 600)}. Answer again with the whole JSON.` });
  }
  return { ok: false, error: last, model: options.model, attempts: 2 };
}

// ------------------------------------------------------------------ the picture check

export interface SceneJudgement { verdict: 'matches' | 'partly' | 'does_not_match'; visible: string[]; missing: string[]; looksLike: string; model: string }
export type SceneJudgeResult = { ok: true; judgement: SceneJudgement } | { ok: false; reason: string };
export interface SceneJudgeOptions { baseUrl?: string; numCtx?: number; /** The chat's own local model: used to look when it can see (it is loaded already). */ prefer?: string | null; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; snapshot?: () => Promise<ModelSnapshot> }

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    looks_like: { type: 'string' },
    visible: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['matches', 'partly', 'does_not_match'] },
  },
  required: ['looks_like', 'visible', 'missing', 'verdict'],
};

const BLIND_SCHEMA = { type: 'object', properties: { looks_like: { type: 'string' }, things: { type: 'array', items: { type: 'string' } } }, required: ['looks_like', 'things'] };

/** The context a scene is written in: the rules, one scene and one correction fit several times over. */
export const SCENE_WRITER_CTX = 16_384;

/**
 * The model on this PC that should write scene code: the largest one made for writing code, or null when there is none
 * (the chat's own model then writes). Only local models are ever returned.
 *
 * "Fits graphics memory" is deliberately not asked: that figure is for Pandesh's chat context. A scene is written in
 * SCENE_WRITER_CTX, where a 27B coder runs on a 24 GB card (measured 2026-11-23: 94 s for a 121-part scene, against a
 * general 26B chat model that never got a rowing boat right in four tries).
 */
export function localSceneWriter(snap: ModelSnapshot): string | null {
  if (!snap.available) return null;
  const big = (m: ModelSnapshot['models'][number]) => (m.paramsB ?? 0) >= 12 || (m.paramsB === undefined && (m.estimatedBytes ?? 0) >= 10e9);
  const able = snap.models.filter((m) => m.autoEligible && !m.isEmbedding && /cod(?:e|er|ing)/i.test(m.name) && big(m));
  able.sort((a, b) => (b.paramsB ?? 0) - (a.paramsB ?? 0) || a.name.localeCompare(b.name));
  return able[0]?.name ?? null;
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 16) : []);

/**
 * Shows the scene's own pictures to a vision model on this PC and asks which of the requested things can be seen.
 * A failure to look is a reason, never a judgement: no picture, no vision model or a bad answer returns { ok: false }.
 */
export async function judgeScenePictures(description: string, picturePaths: string[], options: SceneJudgeOptions = {}): Promise<SceneJudgeResult> {
  const root = (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/v1\/?$/, '').replace(/\/$/, '');
  if (!isLoopbackUrl(root)) return { ok: false, reason: `the model endpoint ${root} is not on this PC` };
  const images: string[] = [];
  for (const p of picturePaths.slice(0, 3)) {
    try { const bytes = fs.readFileSync(p); if (bytes.byteLength > 200 && bytes.byteLength <= 8 * 1024 * 1024) images.push(bytes.toString('base64')); } catch { /* a missing picture is simply not shown */ }
  }
  if (!images.length) return { ok: false, reason: 'no picture of the scene could be read' };
  let model: string | null;
  try {
    const choice = chooseModel(await (options.snapshot ? options.snapshot() : snapshotModels({ baseUrl: root, selectedModel: options.prefer ?? null })), { vision: true });
    model = choice.model;
    if (!model) return { ok: false, reason: `no model on this PC can look at pictures (${choice.why})` };
  } catch (err) { return { ok: false, reason: `the local model server did not answer: ${err instanceof Error ? err.message : String(err)}` }; }
  try {
    const ask = async (messages: unknown[], format: unknown): Promise<{ ok: true; raw: string } | { ok: false; reason: string }> => {
      const r = await (options.fetchImpl ?? fetch)(`${root}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 240_000),
        body: JSON.stringify({ model, stream: false, think: false, format, options: { temperature: 0, num_ctx: options.numCtx ?? 32_768 }, messages }),
      });
      if (!r.ok) return { ok: false, reason: `the local vision model ${model} returned HTTP ${r.status}` };
      return { ok: true, raw: String(((await r.json()) as { message?: { content?: string } }).message?.content ?? '') };
    };
    // First look WITHOUT the request: a model that is told what to find tends to find it (seen live 2026-11-23: a 7B
    // model answered with the request word for word). What it says here is its own account of the pictures.
    const blindAsk = { role: 'user', content: 'These pictures show one 3D scene built from simple shapes, from different sides. List every separate thing you can see and what it looks like, with how many there are.', images };
    const blind = await ask([{ role: 'system', content: 'You describe pictures of a 3D scene. Say only what is actually visible. Answer with JSON: looks_like (one sentence), things (each separate thing you can see, with its count and colour).' }, blindAsk], BLIND_SCHEMA);
    if (!blind.ok) return { ok: false, reason: blind.reason };
    let seen: { looks_like?: unknown; things?: unknown };
    try { seen = JSON.parse(blind.raw) as typeof seen; } catch { return { ok: false, reason: `the local vision model ${model} did not answer in the asked form` }; }
    const blindLooksLike = String(seen.looks_like ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const res = await (options.fetchImpl ?? fetch)(`${root}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 240_000),
      body: JSON.stringify({
        // The same context size as the writer: when one model does both jobs, a different size makes Ollama load it again
        // for every look (64K also spills out of video memory on this class of PC; found live 2026-11-23, a 240 s timeout).
        model, stream: false, think: false, format: JUDGE_SCHEMA, options: { temperature: 0, num_ctx: options.numCtx ?? 32_768 },
        messages: [
          { role: 'system', content: 'You check a rendered 3D scene against a request. You are shown pictures of the same scene from different sides. The scene is built from simple shapes, like a model made of blocks: judge whether each thing is there and can be told apart by its shape, not whether it looks real. Check only the physical things the request names (objects, animals, people, buildings, land, water) and how many of each; ignore words about mood, light, texture, age or style. Say only what is actually visible in the pictures. Answer with JSON: looks_like (one sentence on what the pictures show), visible (the requested things you can recognise), missing (the requested things you cannot find, cannot tell apart from a plain block, or that are fewer than asked), verdict (matches when every requested thing is recognisable, partly when most are, does_not_match otherwise). Never count something as visible because the request mentions it.' },
          blindAsk,
          { role: 'assistant', content: JSON.stringify({ looks_like: blindLooksLike, things: list(seen.things) }) },
          { role: 'user', content: `The request was: ${description.replace(/\s+/g, ' ').trim().slice(0, 1_500)}\nLook at the pictures again and compare. A requested thing counts as visible only if you can point to it in a picture.` },
        ],
      }),
    });
    if (!res.ok) return { ok: false, reason: `the local vision model ${model} returned HTTP ${res.status}` };
    const raw = String(((await res.json()) as { message?: { content?: string } }).message?.content ?? '');
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return { ok: false, reason: `the local vision model ${model} did not answer in the asked form` }; }
    const verdict = value.verdict === 'matches' || value.verdict === 'partly' || value.verdict === 'does_not_match' ? value.verdict : null;
    if (!verdict) return { ok: false, reason: `the local vision model ${model} gave no verdict` };
    const missing = list(value.missing);
    // An answer that names nothing it saw and nothing it missed did not compare anything: that is no judgement.
    if (!list(value.visible).length && !missing.length) return { ok: false, reason: `the local vision model ${model} gave a verdict without naming what it saw or missed` };
    // A verdict of "matches" with things listed as missing is not a match.
    // What the pictures look like is the model's own first account, never the wording it gave after reading the request.
    return { ok: true, judgement: { verdict: verdict === 'matches' && missing.length ? 'partly' : verdict, visible: list(value.visible), missing, looksLike: blindLooksLike || String(value.looks_like ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), model } };
  } catch (err) {
    return { ok: false, reason: options.signal?.aborted ? 'cancelled' : `the local vision model ${model} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
