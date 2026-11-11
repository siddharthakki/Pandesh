# Pandesh logo

<img src="png/pandesh-lockup.png" width="420" alt="Pandesh logo: a panda rising into a deep-teal tile, next to the lowercase wordmark pandesh">

PAN-DA rises into view from the bottom edge of a deep-teal tile: the presence at the edge of your screen.
Its eyes are the presence light. Teal means Pandesh is there; amber means it needs you.

The SVG files are the masters. Every shape is a circle, a circle segment or a capsule between two circles,
and the wordmark is drawn, not typed: a monoline geometric lowercase, stroke 19 on a 100-unit x-height.

## Files

| File | Use |
|---|---|
| `pandesh-icon.svg` | App icon master, 32 px and up |
| `pandesh-icon-small.svg` | Small-size master for 16–24 px: a larger panda with bigger, brighter pupils |
| `png/pandesh-icon-<size>.png` | 16, 20, 24, 32, 40, 48, 64, 128, 256, 512 and 1024 px (16–24 come from the small master) |
| `pandesh.ico` | Windows icon with 16, 20, 24, 32, 40, 48, 64 and 256 px entries |
| `pandesh-lockup.svg`, `pandesh-lockup-on-dark.svg` | Icon and wordmark side by side, for light and dark grounds |
| `pandesh-lockup-stacked.svg`, `pandesh-lockup-stacked-on-dark.svg` | Icon above the wordmark |
| `pandesh-wordmark.svg`, `pandesh-wordmark-ink.svg` | Wordmark alone, black and ink |
| `pandesh-glyph.svg`, `pandesh-glyph-white.svg` | One-colour glyph for places that allow a single colour |
| `tray/tray-<state>.svg` and `tray/tray-<state>-<16/20/24/32>.png` | Proposed tray icons: `present`, `needs-you`, `paused` |

## Colour

All colours are JARVIS design-system tokens.

| Role | Token | Hex |
|---|---|---|
| Tile | `pulse-dim` | `#0f6e6b` |
| Eyes | `pulse` | `#34d9cb` |
| Eyes at 16–24 px | `pulse-bright` | `#8cf5ea` |
| Face | `ink` | `#eaf0f2` |
| Ears, eye patches, wordmark on light grounds | `canvas` | `#05070a` |
| Eyes when Pandesh needs you | `attention` | `#f4b547` |

## Use

- Keep clear space of a quarter of the tile's width on every side.
- Smallest sizes: 16 px for the icon, 120 px wide for the horizontal lockup.
- Below 32 px use `pandesh-icon-small.svg`. The `.ico` already does.
- The eyes are the only place bright teal or amber appears. Don't recolour the tile, stretch the panda or set the wordmark in a font.

## Tray states (proposed)

| State | Eyes | Meaning |
|---|---|---|
| `present` | Teal | Core is running |
| `needs-you` | Amber | An approval is waiting |
| `paused` | Closed | Core is stopped or offline |

## Status

The desktop app, its installer and the phone app use this logo. Their sources are in `apps/desktop/assets/`:

| Source | Becomes |
|---|---|
| `icon.svg`, `icon-small.svg` | `icon.ico`, `icon-512.png` and the icon embedded in `src/host/appIcon.ts`, via `node apps/desktop/scripts/build-icons.mjs` |
| `icon.svg`, `icon-square.svg`, `icon-maskable.svg` | The phone app's icons in `renderer/mobile/icons/`, via `node apps/desktop/scripts/build-mobile-icons.mjs` |

The tray states are still a proposal: the tray shows one icon whatever Pandesh is doing.
