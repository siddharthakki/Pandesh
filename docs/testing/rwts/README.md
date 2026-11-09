# RWTS scenario library

`RWTS_scenario_library.md` is a bank of real-world smoke-test prompts (280 original cases plus
appended regressions). `acceptance/rwts/manifest.json` is generated from it by
`scripts/acceptance/generate-rwts-manifest.mjs`.

## Removed: the "343/343 PASS" ledger

Earlier branches carried `acceptance/rwts/results.json`, per-scenario `evidence.json` files and an
`acceptance_report.md` claiming 343/343 scenarios passed. An independent audit (2026-11-06) found
that the ledger was produced in about half a second by a script that templated outputs without
launching the app or a model. Those files, the generating script and a raw copy-over-production
deploy script (`scripts/deploy-to-production.mjs`, no backup, no updater) were removed during the
v2 integration. They remain in Git history only.

Genuine acceptance evidence for v2 lives under `docs/architecture/pandesh-ui-v2/` (alpha e2e,
real-world challenge runs), each with screenshots from real app runs on an isolated profile.

`stabilization_audit_build158.md` is a source audit written against `main` at Build 158; it is a
specification, not evidence that anything passed.
