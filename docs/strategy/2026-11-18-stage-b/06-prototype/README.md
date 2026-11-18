# Stage B prototype

A self-contained, clickable HTML prototype of the Pandesh v2 design language and the three flagship flows.

**Run:** open `index.html` in any modern browser (Chrome/Edge/Firefox). No build, no server, no dependencies. Works offline.

**What it demonstrates:**
- Design tokens (dark default + light toggle, top-right rail button)
- The seven-destination rail + "More" grouping
- 10 screen states (state switcher, bottom-right)
- Three flagship flows (Mission Control, Outcome Receipt, Rehearse) via the "Run a flagship flow" button or the Flows group
- Compact/narrow layout toggle

**Important:** all data is seeded prototype data, labeled "PROTOTYPE DATA — not connected to Core." No backend is called. Statuses that are not yet backed by a real Core datum are marked with a `prototype` chip. See `../04-data-contracts.md` for the real-data mapping and the gaps.

**What it does NOT demonstrate:** motion timing beyond CSS transitions, real browser/desktop frames, voice, or the full 10-state light/dark matrix (dark + light toggle covers the token system; per-state light variants are described in `../02-screen-states.md`).