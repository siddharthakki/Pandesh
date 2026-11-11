# Workshop assets

| File | What it is | Source | Licence |
|---|---|---|---|
| `studio_small_01_512.hdr` | 512×256 Radiance HDR studio environment, used as the 3D Workshop's image-based lighting so physically based materials (steel, brass, glass) reflect a real studio. | Blender 5.2 LTS bundled studio light `datafiles/studiolights/world/studio.exr` (1K, from Poly Haven's *studio_small_01* by Greg Zaal), converted to HDR and scaled with Blender itself (`bpy.data.images.load` → `scale(512, 256)` → `file_format='HDR'`), offline. | CC0 (Blender's `studiolights/world/license.txt`: "All HDRIs are licensed as CC0") |

The HDR is embedded in `renderer/v2/workshop3d.js` at build time (esbuild base64 loader), so the window never fetches it.
