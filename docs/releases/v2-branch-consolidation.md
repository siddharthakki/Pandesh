# Pandesh v2: branch consolidation (2026-11-09)

`main` is the single source of truth. Before the merge, `main` was tagged **`pre-v2-main`** (6863812, Build 158).

## Merged into main

| PR | Content | Merge commit |
|---|---|---|
| [#37](https://github.com/siddharthakki/Pandesh/pull/37) | v2: UI v2, specialist delegation, coding engines, Second Brain, Software Discovery; reliability remediation; pdfjs/xmldom security fixes; Build 159 (supersedes #36); UI v2 design docs | 7c4085b |
| [#38](https://github.com/siddharthakki/Pandesh/pull/38) | Coding delegation never scoped to web-only; unknown-tool loop guard | 0d22750 |
| [#39](https://github.com/siddharthakki/Pandesh/pull/39) | Suggested-command check resolves the folder the command ran in | 80e6edc |
| [#40](https://github.com/siddharthakki/Pandesh/pull/40) | "our X is …" facts go to Core memory | 1b48090 |
| [#41](https://github.com/siddharthakki/Pandesh/pull/41), [#42](https://github.com/siddharthakki/Pandesh/pull/42) | User-scope recall includes the user's project facts | 9ad6859, e84abe8 |

Verification for #37: Core 2598 passed / 16 skipped; desktop 617 passed. A fresh clone with `npm ci` and bundles built
gave Core 2594 passed / 20 skipped and desktop 614 passed / 3 skipped (the extra skips need staged speech models).
Core, root and renderer-v2 typecheck cleanly, and desktop sources have 0 type errors.

## Removed during integration

- `acceptance/rwts/{results.json, evidence/, acceptance_report.md, execution_progress.json}` and
  `scripts/acceptance/execute-rwts-acceptance.mjs`: a "343/343 PASS" ledger that was generated without running the app or
  a model. The scenario library and manifest remain in `docs/testing/rwts/`.
- `scripts/deploy-to-production.mjs`: it copied a build over the installed app with no backup or updater.

## Not merged, deliberately

| Branch | Reason |
|---|---|
| `feat/intent-kernel`, `feat/jugaad-bridge` | Experimental (durable intents, phone bridge), 119 commits behind. They would need a re-design against v2's delegation and capability dispatch. Preserved on origin. |
| `fix/model-selection-media-intent` | Superseded: `softwareIntent.ts` and the explicit-model rule are already in main through the rescue merge. |
| `build/pandesh-147`, `arch/build-144-release-verification` | Obsolete release-prep commits for old builds. |
| `hold/renderer-mascot` | Restores renderer fonts (OFL, wanted) together with mascot images of unknown licence that a later commit removed on purpose. The fonts will be restored separately in the release-blocker work. |
| `docs/pandesh-ui-v2`, `fix/reliability-remediation`, `fix/xmldom-ghsa`, `fix/pdfjs-ghsa-hq66`, `chore/release-b159` | Fully contained in main through #37. |
| Dependabot #14, #15, #24, #32 | Dev-tooling bumps, to be reviewed separately. |

## Not published, deliberately

Local audit evidence (`acceptance/claude-independent-audit/`, untracked) and the untracked Gemini gate-2 scripts stay
local. A scan of the v2 diff found no credentials. Test fixtures use synthetic keys. Screenshots come from isolated test
profiles with fictional data.

The installed app at `E:\Pandesh` was not touched: it is still Build 159, deployed 2026-11-06.
