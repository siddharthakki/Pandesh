# Pandesh desktop Build 188 — formal release review

Status: **review only. Nothing merged, installed or deployed.** Date: 2026-11-20.

## 1. Verdict

**GO for owner approval of Build 188, with conditions** (section 8). Not yet GO for install: the packaged smoke build and the real-Chrome acceptance run (section 6) have not been executed on the final candidate commit, and the owner has not approved.

## 2. Exact scope

- Candidate: branch `release/b188-candidate`, worktree `D:\PandeshRelease188`, head **806e8c6**.
- Base: production Build 187 = `f4cc50a` (`release/b187-panda-bridge`).
- f4cc50a + 20 cherry-picks from the dev branch + `ecad0a9` (build number 188) + two fixes found during this review: `.gitattributes` keeps `scripts/panda-bridge/*.mjs` LF, and `build-number.json` rewritten without BOM/CRLF.
- 49 files changed, about 4,300 lines added.
- Excluded: every Stage C commit and worktree. The branch contains no Stage C code, and the Stage C Core was not touched.

Included capabilities, one commit each:

| Capability | Commit |
|---|---|
| Deterministic capability routing, Automatic executor | 61a5a11 |
| Workflow verification = weakest step; steps in activity feed | cd55560 |
| Magika optional engine (signature table stays authority for hard magic) | 4349986 |
| Tailscale status-only adapter, own M54 allowlist entry | c4dc29e (proposal f329e41) |
| Project registry, project resolution, read-only inspection | 7b86caa |
| Household-isolated documents, receipt parser, FTS, resumable upload | a06125c |
| Approval for external agents, card in Pandesh, Claude Code selectable | d087959, 09804db |
| Legacy household records follow access controls | 863f7c6 |
| Reprocess with preserved original and append-only history (pipeline v4) | 21a3be9, 2905769 |
| Approval hardening (single use, 5-minute use window, commit-pinned, content-checked, stale-card refusal) | c5b03cc |
| Open-in-Pandesh launch merge script, app-target fix | 2a0b896, 403500f |

## 3. Comparison with installed Build 187

- `package.json` / lockfile / dependency diff: **empty**. Native modules and the Electron version are unchanged.
- Database schema and migrations: **none added or changed.** Approval events are rows in the existing `bridge_task_checkpoints.snapshot` column.
- New files on first use, all inert: `projects.json`, `jugaad\households.json`, per-household folders with a SQLite FTS file, `processing_runs` inside those per-household databases.
- New HTTP surface: host-only approval and audit routes. Browsers get only an executor, label and expiry.

## 4. Rollback behaviour

- Build 187 ignores the approval snapshots (it never reads them) and ignores `projects.json` and the household files. Rolling back leaves them on disk, unread, and loses no data.
- Pending approvals die with the old process; nothing external is ever started after a rollback.
- Phone pairing, the extension pairing and the Credential Manager keys are untouched by this release, so they survive a rollback.

## 5. Evidence

All counts are from the candidate worktree.

| Suite | Result |
|---|---|
| `tsc` | clean |
| Core vitest, full (`rc188-core-suite.log`, before the two fixes) | 3,672 passed, 1 failed, 35 skipped; 1 suite failed to load |
| Desktop/renderer vitest, `apps` | 975 passed, 4 failed, 3 skipped (before the BOM fix) |
| `hostLaunchConfig` after the `.gitattributes` fix | 2/2 pass |
| `buildIdentity` after the BOM fix | 7/7 pass |

Baseline failures (present before this work, not caused by it):

- `core/test/bots.test.ts` "stays quiet on a scheduled run with nothing new" fails on Build 187 too.
- `hermesProviderRouting` (2 tests) failed on the Build 187 baseline; they did not fail in the candidate run.
- The 10 failing desktop tests recorded on the 187 baseline are down to the 4 below, which are mine and now fixed.

Defects found and fixed in this review (all inside the candidate):

1. The bump script wrote a BOM and CRLF into `build-number.json`, so 4 `buildIdentity` tests failed. Fixed.
2. A Windows checkout turned the shebang of `set-host-launch.mjs` into `#!/usr/bin/env node\r`, so `hostLaunchConfig` could not load. Fixed with `.gitattributes`.
3. Approval hardening gaps found earlier: replay, commit substitution, stale card, edited instruction on an old approval. Fixed in c5b03cc with tests.

**Not re-run on 806e8c6:** the two fixes touch only one config file and one `.gitattributes` line, so I re-ran just the affected tests. A full re-run before install is part of the approval step (section 7).

Claim verification:

- Capability Registry, routing: covered by the Core suite; the live run in real Chrome used the Automatic executor.
- Magika, Tailscale status-only, project resolution, inspection mode: unit/integration tests; Claude Code ran read-only on a registered project in the real acceptance (private clone, no remote, source proven unchanged).
- Household isolation: real-TLS phone simulator tests; a device in household A cannot list, search, fetch or see history of household B.
- Reprocess: original hash checked, history append-only, "kept-previous" when a new run finds no text.

## 6. Approval review (external agent)

| Attack | Result |
|---|---|
| Task substitution (edit text after approval) | refused: instruction hashed and checked against its content at dispatch and at Allow |
| Commit substitution | refused: branch and commit pinned at approval; mismatch cancels the start before any copy |
| Expiry | 30 minutes to decide, 5 minutes to use after Allow |
| Replay | single use; the second dispatch finds it consumed |
| Browser authorising itself | browsers can only request; approve/refuse routes are host-only |
| Data exposure change (context, confidentiality) | card compared again at Allow; confidential tasks need a separate override |
| Refusal | cancels the task; nothing else starts in its place |

Legacy household records: a phone with no household sees legacy records **until the owner names a `legacyOwner`**. No automatic migration and no reassignment. Decision D3 below.

Real-Chrome acceptance plan, to run after install approval, on the production profile, started by the owner:

1. Owner starts Pandesh Build 188 from the shortcut; confirm the build label.
2. In ChatGPT in real Chrome, ask Pandesh Bridge for a read-only review of a registered project with Claude Code selected.
3. The card appears in Pandesh; press Allow; watch the task finish with the report; confirm the project checkout is unchanged (`git status`).
4. Repeat and press Refuse; confirm the task is cancelled and nothing reached Claude Code.
5. Edit the task text after the card is shown; confirm Allow is refused.
6. Phone: upload one document from the paired phone, search it, reprocess it from Pandesh, check the history.

## 7. Backup, deployment and rollback (derive from `D:\PandeshAssistantDev\rel187\install-b187.ps1`)

Before: Core idle and no user message in the last 5 minutes (`idle-check.mjs`); `mission-state.mjs` before/after.

1. Build the package in a new `D:\PandeshAssistantDev\rel188` (adapted `rc-build-b187.ps1`; smoke on ports 3961/3962, never 3030). The Inno installer step is known broken; the staged payload is what gets installed.
2. Back up the profile: copy `C:\Users\siddh\AppData\Local\KarkeDikha\desktop` to a timestamped `b188-upgrade-<UTC>` folder.
3. Move the current `E:\Pandesh` to `E:\Pandesh-b187-rollback` (rename, not delete).
4. Place the staged payload at `E:\Pandesh`; run `verify-b188.mjs` (copy of verify-b187).
5. Owner starts production from the shortcut. Check the build label and the paired Chrome and phone.
6. Rollback: stop Pandesh, rename `E:\Pandesh` to `E:\Pandesh-b188-failed`, rename `E:\Pandesh-b187-rollback` back to `E:\Pandesh`, restore the profile backup only if the data directory was damaged (not needed for schema reasons), owner starts it.

## 8. Decisions needing owner approval

- D1. Approve building the Build 188 package and running the smoke on isolated ports (no install). Recommended.
- D2. Approve installing Build 188 (separate approval, after D1 and a full re-run on 806e8c6) and merging `release/b188-candidate`.
- D3. Legacy household records: name a `legacyOwner` household, or choose default-deny for unassigned phones. Recommended: name the owner household.
- D4. Approve the `.gitattributes` and build-number fixes (already in the candidate).
- D5. The scratch extension key `pandaBridge:com.pandesh.panda_bridge_dev` is still untouched; say when its identity may be verified and removed.

## 9. Qualification result (2026-11-20, after the owner approved the build and isolated smoke)

Final candidate: `release/b188-candidate` at **d1b94da** = the reviewed 806e8c6 plus one owner-requested commit: legacy household records are **default-deny** (a phone without a household sees none; nothing is migrated, assigned or deleted; the owner names a `legacyOwner` to expose them). Nothing was installed, merged or changed in production (production still running, 11 processes, untouched).

- Package: built from d1b94da, `clean`, identity build 188; Pandesh-Setup.exe produced and its SHA-256 matches the published value (the Inno step worked this time); staged payload = portable tree (3,000 files; `runtime/core.js` byte-identical, 6,357,877 bytes, hash equals build-fingerprint). The shipped Core contains the single-use approval, scope-changed refusal, Tailscale status, households and pipeline v4 code, and the default-deny rule.
- Package smoke on ports 3961/3962: ok, ten steps (api-ready … question-completed).
- Full suites on d1b94da: **core 3,674 passed, 1 failed** (`bots.test.ts` "stays quiet on a scheduled run", present on Build 187 too), 35 skipped; **apps 979 passed, 0 failed**, 3 skipped. `hostLaunchConfig` and `buildIdentity` pass.
- Acceptance on the isolated packaged build (script `rel188\accept188.mjs`, paired-browser contract over HTTP):
  - Claude Code request → card for the owner naming project, branch, commit, read-only access and what leaves the PC; nothing started.
  - A paired browser cannot read approvals (403) or approve (403).
  - Owner approved → task completed read-only; the source checkout unchanged (HEAD same, status clean); the audit shows requested → approved → consumed; a second approve of the same request is refused (409).
  - Refusal → task cancelled, audit requested → refused.
  - Branch moved after the card → Allow refused with `approval_scope_changed`; audit requested → expired.
  - A write-capable wording against a read-only project is refused with a clear message.
- **Not achieved: the real-Chrome run against the isolated build.** The extension's host switch needs the extension service-worker DevTools, which opened blank on this PC, and the URL tools mangle `chrome://` addresses. I closed what I opened and changed nothing in the extension. The same code path was exercised in real Chrome with ChatGPT on the dev build earlier today (approval card, Allow, refusal), and the packaged build passed the identical contract over HTTP. A real-Chrome pass on the installed build is still part of the post-install check (section 6).
- Android: see `JUGAAD_ANDROID_RELEASE_REVIEW.md` (combined tree builds, unit tests pass, installs and launches on the emulator).

Updated verdict: **GO for owner approval to install Build 188**, subject to the real-Chrome check after install and D3 (name the legacy owner household; until then phones see no legacy records).
