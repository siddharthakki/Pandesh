# P1 — DESIGN FROZEN (2026-11-08)

Canvas: https://claude.ai/artifact/Y4C6zFkHTqQtYwnLf33T9Y (version 5). Frozen source: `source/` (`Main.dc.html` is the single source; every other board imports it). Screenshots: `desktop-idle.png`, `desktop-approval.png`, `narrow-morning-expanded.png`, `narrow-long-approval.png`.

Visual language, layout, type scale, colours, navigation and interaction patterns are frozen. Implementation (Phase 2, `feat/pandesh-ui-v2`) follows this file.

## Final polish — before / after

| # | Check | Before (rev 2) | After (final) |
|---|---|---|---|
| 1 | Narrow decision bar never hides approval details | 320×568: scroll area above the bar 87 px; recipients and body not reachable | Bar slimmed (reply link moved into the card), header 44 px, nav 56 px; on effective heights < 640 px the summary line drops (the card lists every recipient; the button keeps the count). 320×568: 211 px scroll area, all 15 card elements reachable by scrolling |
| 2 | Responsive 320 / 375 / 390 / 768 / 900, short, enlarged text, keyboard | Not tested | Automated layout check (no horizontal scroll, nothing past the right edge, every card element reachable, decision buttons on screen, no unnamed controls): 320×568, 375×667, 390×844, 390×480 (short / keyboard-open height), 768×1024, 900×700 (rail layout) all PASS. Enlarged text (CSS zoom 1.25 at 320 px, 1.5 at 390 px): recipient chips overflowed → fixed (wrap); labels stack above values on narrow; verified visually (hit-testing is unreliable under CSS zoom) |
| 3 | Brief and composer never overlap; items update | Narrow: brief pushed composer/status under the bottom bar | Idle content scrolls in its own region above the fixed composer on narrow; on desktop the centred group scrolls as a whole. Items: Review → approval; Later / Dismiss / Snooze / Done remove the item, announce the result in a polite live region, and decrement the count and Board badge; See why expands the reason in place; empty → "Nothing needs you right now." |
| 4 | Buttons name the action and recipients; full payload inspectable | "Send email" | "Send to Anna Schmidt" / "Send to 3 recipients"; narrow bar summary lists every recipient and the attachment; card lists all recipients (incl. Cc), subject, attachment with Open file, expiry, full body via Show full message |
| 5 | Keyboard and accessibility | Ctrl K only via button; Escape only inside palette | Ctrl+K (when focus is inside the app) opens the palette with focus in its input; Escape closes palette/menus and returns focus to the opener; menus focus their first item; tooltips (`title`) and accessible names on every icon button; browser default focus ring kept (no outline removal); no motion except user-started Play, so reduced-motion has nothing to suppress |
| 6 | Truthful compact status | First-run copy: "Nothing leaves this machine unless you approve it" | "I use local models by default; you decide what else is allowed." Footer stays "Local · qwen3:14b"; details state the provider in use now (Local · Ollama), model, web tools, and that outward actions ask first — no absolute privacy claim |
| 7 | Dark/light parity | — | Same tokens/spacing; light frames regenerate from the same source |

Also fixed: the answer to the first question was missing in the approval states (rev-2 regression).

## Not tested in the prototype

- Real screen-reader output (NVDA/Narrator) — structure and names checked only.
- A real on-screen keyboard (simulated by a 480 px-tall viewport).
- Browser text-size setting (simulated with CSS zoom).
- Ctrl+K when focus is outside the prototype (the canvas forbids global key handlers; the product binds it app-wide).
- Hover styles (inline-style prototype; tooltips are native `title`).
