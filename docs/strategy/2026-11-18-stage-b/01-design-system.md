# Stage B — design system

**Direction:** Calm when idle. Alive when working. Precise when deciding. Restrained, professional, warm — closer to a beautifully made desktop instrument than a sci-fi dashboard or an admin template.

## 1. Color tokens

Dark is the default (Pandesh is used for hours; light is for daytime/bright rooms). All values are CSS custom properties on `:root` (dark) with a `data-theme="light"` override and `prefers-color-scheme` fallback.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#0E1013` | `#F4F2EE` | window background |
| `--surface` | `#15181D` | `#FFFFFF` | cards, panes |
| `--raised` | `#1C2027` | `#F0EEE9` | hover, selected row |
| `--ink` | `#E8E6E1` | `#1A1A1A` | primary text |
| `--muted` | `#9A9A94` | `#5A5A55` | secondary text |
| `--faint` | `#5C5C58` | `#8A8A85` | meta, timestamps |
| `--pulse` (accent) | `#3DD6C6` | `#0E9E90` | accent, links, focus, active mission |
| `--verified` | `#6AA8FF` | `#2B6CB0` | done/trusted/succeeded |
| `--attention` | `#F0B429` | `#B7791F` | unverified, needs you, pending |
| `--danger` | `#E5534B` | `#C53030` | failed, refused, destructive |
| `--border` | `#23272F` | `#E2DFD9` | hairlines |
| `--border-strong` | `#2E333C` | `#CFCBC4` | card edges |

**Rules:** accent is teal only. Blue is reserved for *verified/trusted* states (so "done" never competes with "accent"). Amber for "needs attention/unverified." Red only for failure/refusal. No purple, no gradients on surfaces. Color is never the only signal (icons + text accompany).

## 2. Typography

| Role | Family | Weight | Use |
|---|---|---|---|
| Body / UI | Segoe UI Variable, system-ui, sans-serif | 400/500/600 | everything functional |
| Voice (assistant prose) | Cambria, Georgia, serif | 400 | the assistant's written replies — distinctive, readable, human |
| Meta / technical | Cascadia Mono, Consolas, monospace | 400 | timestamps, paths, statuses, tool names, evidence, counts |

**Scale (rem, 16px base):** 0.6875 (meta) · 0.75 (small) · 0.875 (body-sm) · 1 (body) · 1.125 (h3) · 1.375 (h2) · 1.75 (h1) · 2.25 (display, idle hero only).

**Line heights:** 1.4 body, 1.25 headings, 1.35 meta. Max line length for prose: 68ch.

**Distinctive choice:** the serif "voice" for assistant prose. Most agent UIs are sans-everything or mono-everything; the serif gives Pandesh a literate, considered tone and visually separates "what the assistant said" from "what Core recorded."

## 3. Spacing, radius, elevation

- Base 4px. Scale: 4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 48.
- Radius: 2 (chips) · 4 (inputs/buttons) · 6 (cards/panes) · 8 (modals). No 12+ rounded corners.
- Elevation: `--shadow-1` 0 1px 2px rgba(0,0,0,.25) (cards); `--shadow-2` 0 4px 12px rgba(0,0,0,.35) (popovers/modals); `--shadow-inset` for inputs. No glass/blur except the drop overlay.

## 4. Motion

Purposeful, never decorative. All durations respect `prefers-reduced-motion: reduce` (collapse to 0).

| Pattern | Duration | Easing | Use |
|---|---|---|---|
| Fade in | 120ms | ease-out | elements appearing |
| Slide in (pane) | 180ms | cubic-bezier(.2,.8,.2,1) | Mission Control pane, drawers |
| Timeline draw | 240ms staggered | ease-out | mission step rows appearing (60ms stagger, max 6) |
| Pulse (active) | 1.4s loop | ease-in-out | active mission dot, running indicator |
| Receipt stamp | 280ms | cubic-bezier(.34,1.56,.64,1) | the verified stamp lands on completion |
| Count tick | 120ms | ease-out | numbers updating (counts, progress) |

**Rules:** no spinning orbs, no particle effects, no auto-playing loops except the active pulse. Motion always conveys state change (running → done, pending → resolved). Time compression in demos is disclosed.

## 5. Iconography

Hand-drawn 16×16 single-path SVGs (existing `ui.tsx` set). Add: mission (flag), receipt (seal), rehearse (eye), evidence (paperclip), verified (check in circle), unverified (dashed circle), failed (x in circle), paused (two bars), running (pulse dot). No icon fonts, no emoji as icons.

## 6. Accessibility baseline

- `:focus-visible` outlines on every interactive element (2px `--pulse`, 2px offset).
- `role="alert"` for errors, `aria-live="polite"` for status, `aria-live="assertive"` for approval-required.
- Full keyboard: Tab order follows visual order; Ctrl+K palette; Esc closes panes/modals; Enter submits; Space toggles; arrow keys in lists.
- Reduced motion: all loops/pulses become static; transitions become instant.
- Color + icon + text for every status (never color alone).
- Minimum contrast: 4.5:1 body, 3:1 large/UI. Verified in both themes.
- Screen-reader labels on icon-only buttons (`aria-label` + visible tooltip).

## 7. Layout grid

- App shell: rail (56px) · main (flex) · optional contextual pane (360–420px, right) · optional activity aside (320px, right of pane).
- Main content max-width 880px for chat/prose; full-width for Mission Control/workspace grids.
- Compact (≤720px wide): rail collapses to bottom bar (first 3 destinations + More); contextual pane becomes a drawer (bottom sheet); activity aside folds into a tab.