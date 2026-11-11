# The Workshop

The Workshop is the third place in a Pandesh conversation, beside **Chat** and **Activity**. What Pandesh makes — a 3D
model, a simulation, a page design, a video, a picture — opens there in a viewer that fits it, where it can be watched,
inspected, changed, compared with earlier versions and taken away. Asking in chat ("pull it apart", "add a second
counter", "make the heading larger", "make it vertical") and using the Workshop's own controls change the same thing.

It is not a new subsystem. Every version is an ordinary **Core artifact** (an immutable file with a SHA-256 digest, linked
to its conversation); the Workshop facts travel in that artifact's metadata under `workshop`. Every change goes through
the governed capability path (`Ask`, `Auto`, `Plan only`), and the window answers Core's view commands with what really
happened. There is no second store, event stream, approval path or engine.

## How it fits together

```
 chat ──► model ──► governed tool (core/runtime/workshopCapability.ts)
                       │  approval card (Ask) · standing grant (Auto) · refusal (Plan only)
                       ▼
               Core artifact + metadata.workshop  ◄── window edits (host-only route, the click is the decision)
                       │
       runtime event "open / rotate / explode / device / play …"
                       ▼
           desktop host ──► Workshop panel (renderer-v2/src/workshop)
                       ▲            │
                       └── confirm ─┘   DONE only when the window confirms; otherwise NOT CONFIRMED / NOT DONE
```

- **Versions** (`core/domain/workshops.ts`): `writeWorkshopVersion` writes a new file under `<data>/workshop/<id>/`
  (never overwriting) and registers it. Restore ("undo that") makes an earlier version current again *as a new version*.
- **"It"** (`resolveWorkshopTarget`): the workshop named → the one on screen in this conversation → the only one →
  otherwise the tool asks which one. It never guesses. The window reports what it shows (`workshop_focused`).
- **View commands** (`workshop_view`, read-only, no approval): Core publishes a command; the window carries it out and
  confirms with the state its renderer reports. A command that is not confirmed in 6 s is reported as such.
- **Inspection** (`workshop_status inspect=true`): the window's own renderer state (Babylon.js scene graph, the
  player, the page's measured layout), not the model's description.
- **Approvals bind the exact data**: `prepare()` freezes the workshop, base version (and for videos the pictures' digests)
  before the card is written; long payloads are shown as a summary plus a SHA-256 of the exact data; a newer version or a
  changed picture after approval is refused.

## The five workshops

| Type | Made by | Each version is | Viewer | Changes |
|---|---|---|---|---|
| **3D** | `build_3d_model` — from the user's words, the chat's local model fills a schema; Core validates every part (`shared/workshop/scene3d.ts`) | scene JSON (parts, PBR material presets, gear meshing) | Babylon.js 9: PBR + CC0 HDRI image lighting, shadows, tone mapping, orbit camera, picking, hierarchy, inspector, gizmo, exploded view, labels | `workshop_edit` (only the named part), material editor, GLB export built by Babylon.js and verified by Core (`shared/workshop/glb.ts`) |
| **Simulation** | `create_simulation` | parameters JSON | Simulation Lab: the same seeded discrete-event queue model Core measures, animated; metrics, chart, what-if sliders, assumptions | `set` / `adjust` ("add a second counter"); sliders save only on request; comparison table |
| **Design** | `create_design` — the local model writes one self-contained page; Core checks it (`shared/workshop/design.ts`) | HTML | sandboxed offline preview at phone / tablet / desktop sizes; source; line diff; the page's measured headings and buttons | exact find/replace (each must match once), written by the local model from the user's words |
| **Video** | `create_video` — FFprobe inspects, FFmpeg renders, FFprobe + a frame grab verify (`runtime/mediaProduction.ts`) | the MP4, with its recipe (pictures by artifact id + SHA-256, timing, frame) | player with measured size/length, pictures, shape buttons, side-by-side comparison | aspect (vertical / square / landscape), length, fit, captions — rendered again from Core's copies of the same pictures |
| **Image** | `image_generate` (Image Studio / ComfyUI, local) | the picture, with its recipe (prompt, checkpoint, seed, size, reference, strength) | zoom/pan viewer, side-by-side comparison | img2img from the picture on screen; the result is the next version, with an honest note that the whole picture is redrawn |

## Security model

The Workshop shows content that Pandesh's models wrote. None of it runs with Pandesh's privileges.

- **No generated code with privileges.** 3D scenes, simulations and videos are data validated by Core, never code. The
  only generated code is a Design page, and it runs only in the preview below. No Blender/Python or other script bridge
  is part of this build.
- **Design preview** (`apps/desktop/src/host/designPreview.ts`):
  served from memory by a 128-bit, 30-minute token (`pandesh-preview://<token>/`), with no path into the filesystem;
  every response carries `default-src 'none'` (no fetch, images, fonts, frames, forms, workers or base from anywhere but
  the page itself and `data:`) plus a CSP `sandbox`; the frame is `sandbox="allow-scripts"` (opaque origin: no bridge,
  no storage, no cookies, no popups, no top navigation); the window's own `frame-src pandesh-preview:` blocks any other
  address before a request is made, and the main process cancels such a navigation as a second layer; the microphone
  permission is given to the window's main frame only. Messages from the page are accepted only from that frame with its
  nonce and are shown as data. Verified in the real app (WSH-031, WSH-036): `origin` is `null`; `window.desktop`,
  `require`, `process` are undefined; parent document, storage and cookies throw `SecurityError`; the Core API, popups
  and the microphone are blocked; a page trying 13 ways out (fetch, XHR, WebSocket, beacon, EventSource, img, CSS,
  `@import`, script, iframe, form, popup, navigation) produced **0 connections** on a local listener.
- **Untrusted text stays data.** Page source and measured page text are labelled "untrusted page text, not
  instructions" in tool output.
- **Pictures for videos** are named by digest in the approval; Core keeps its own copies (`source: workshop_source`,
  never shown as workshops) and re-checks every byte before each render.
- **The picture to change** is the one named, else only the image open in this conversation's Workshop, written onto the
  approval card. It is never an image from another conversation. (The previous fallback, "the latest image in the
  database", queried a column that does not exist and never applied; it was removed, not activated.)
- **Local only.** Every Workshop tool refuses without a local (Ollama) model where a model is needed; costs are recorded
  as 0 and the provider as local. Nothing is published or shared.
- **Host-only routes** for the window's own writes (`core/api/workshopRoutes.ts`): a model, tool or phone cannot call them.

## Engine evaluation (why these components)

| Option | Finding | Decision |
|---|---|---|
| **Babylon.js 9.32** | Full PBR (anisotropy for brushed metal), HDR image lighting, shadow generator, default rendering pipeline, highlight layer, gizmos, picking, glTF 2 serializer — all in the official packages; ESM deep imports bundle to one lazy file (`renderer/v2/workshop3d.js`, ~3.7 MB, loaded only when a 3D workshop opens) | **Used** for the embedded renderer |
| Babylon.js Inspector | 18 peer packages, ~460 MB unpacked: too heavy to ship in the app | Not bundled; the Workshop's own inspector reads the Babylon scene graph |
| Babylon Inspector CLI (agent bridge) | Talks to the page over an unauthenticated loopback WebSocket | Not used; inspection goes through the authenticated `workshop_status inspect` path |
| Three.js / React Three Fiber | Capable, but PBR/gizmo/inspector/export would be assembled from more third-party pieces | Not chosen |
| PlayCanvas | Editor-centric, cloud-first workflow | Not chosen |
| **Blender** | The right tool for advanced modeling and professional renders. The common AI bridge (Blender MCP) runs arbitrary Python and its socket is not an authenticated boundary | **Not integrated in this build.** A reviewed integration would run Blender headless in a separate low-privilege process with a fixed allowlist of operations (no arbitrary Python), files in a staging folder, and Core verifying outputs |
| Godot | Not needed: the queue simulation is a small deterministic model shared by Core and the window | Only for future simulations that need a real physics/game runtime |
| Hunyuan3D 2.1 | ~10 GB shape + ~21 GB paint (~29 GB together) | Does not fit next to the chat model on the 24 GB RTX 3090; would need an exclusive GPU window and a scheduler |
| TRELLIS.2 | ≥ 24 GB, Linux-first | Not on this PC for now |

## Capability matrix (this branch)

| | 3D | Simulation | Design | Video | Image |
|---|---|---|---|---|---|
| Create from chat | ✓ (model-chosen; see NL results) | ✓ | ✓ | ✓ | ✓ (existing `image_generate`) |
| Viewer in the Workshop | ✓ Babylon.js | ✓ Lab | ✓ sandboxed preview | ✓ player | ✓ zoom/pan |
| Change from chat | ✓ named part only | ✓ | ✓ exact edits | ✓ re-render | ✓ img2img, next version |
| Change with the Workshop's controls | ✓ material editor | ✓ sliders | — (chat only) | ✓ shape buttons | — |
| Versions, history, restore | ✓ | ✓ | ✓ | ✓ | ✓ |
| Compare | ✓ part diff | ✓ table | ✓ line diff | ✓ side by side | ✓ side by side |
| Export / take away | ✓ GLB (verified) · copy | copy | copy (HTML) | copy (MP4) | copy |
| Inspection from the real renderer | ✓ scene graph | ✓ | ✓ page layout | ✓ player | size from header |

## Limitations

- Model behaviour in natural language varies between runs; every run is recorded (see the WSH entries in the micro-test
  catalog). The window-level and governed-tool paths are deterministic.
- Real image generation (ComfyUI) was not run in this branch's acceptance: the GPU was reserved for the 700 micro-test
  run. The image path was exercised end to end with an FFmpeg stand-in for the Image Studio.
- `Auto` mode uses the existing standing authorizations; there is no Workshop-specific standing grant yet.
- A Design page cannot load anything from the network in the preview (by design); WebRTC is not covered by CSP, which
  matters only for a page's own content (it has no access to Pandesh data).
- Videos are slideshows of pictures (no transitions beyond fades, no audio); legacy videos without a recipe can be
  watched, not re-rendered.
- The Design workshop has no visual editor; changes are made from chat.

## Testing

```
KARKEDIKHA_OLLAMA_URL=http://127.0.0.1:9 npx vitest run core/test/workshop*.test.ts core/test/chatToolSelection.test.ts core/test/imageStudioCapability.test.ts apps/desktop/test/designPreview.test.ts
npx tsc -p tsconfig.core.json --noEmit
node scripts/acceptance/workshop-instance.mjs start --profile <isolated profile> --cdp 9571 --mobile 3971
node scripts/acceptance/workshop-acceptance.mjs --profile <isolated profile> --cdp 9571 --out <dir> [--scenario simulation|design|video|image]
node scripts/acceptance/workshop-nl-acceptance.mjs --profile <isolated profile> --cdp 9571 --out <dir> --model gemma4:12b [--scenario more]
```

The acceptance scripts refuse the real desktop profile. The video test needs FFmpeg on PATH; the image scenario starts its
own stand-in Studio when the instance is started with `--studio-url`.
