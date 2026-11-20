# JUGAAD Android — documents-to-Pandesh release review

Status: **review only. Nothing installed on the phone, nothing committed to the owner's checkout, no signing performed.** Date: 2026-11-20.

## 1. Verdict

**GO for the integration strategy and for the owner to build and sign; NO-GO for installing on the real phone until the owner approves.** I produced no signed release candidate: signing runs only through the owner's keystore process, and I did not use it.

## 2. What is installed versus what the repositories hold

- Installed app: version 1.0.30 (code 31).
- NAS checkout (`Z:\Projects\Projects\household-platform`): `main` at `fa38ee9` **plus the owner's uncommitted work**. The installed app matches that combination, not the committed `main`.
- A release built from committed `main` alone would therefore **regress** the installed app. Do not do that.
- The NAS checkout was never modified. I read it only (git status with a per-process `safe.directory` override; nothing persisted). Secrets in `D:\PandeshJugaadRC` (a copy of the working tree) were deleted from my copy only.

## 3. Scope

One commit, `704bd12` on branch `feat/pandesh-documents` in the isolated clone `D:\PandeshJugaadDev`, and the same change as a patch: `D:\PandeshJugaadDev\patches\0001-feat-pandesh-documents-and-photos-to-Pandesh-over-th.patch`.

New files: `pandesh/documents/PandeshDocumentUploads.kt`, `PandeshUploadLogic.kt`, `ui/v2/pandesh/PandeshDocumentsCard.kt`, `PandeshUploadLogicTest.kt`. Edited: `PandeshSyncRepository.kt`, `PandeshSyncWork.kt`, `V2ConfigHubScreen.kt`.

Behaviour: pick a document or photo, it queues one file per item and uploads in resumable chunks over the existing paired, certificate-pinned channel; status per item; search with snippets; a **"How Pandesh read this"** button on each search hit shows the processing history (first reading and each owner re-reading, with what changed, for example "total: 64.74 → 4321.09"). Offline: items stay queued and resume.

Integration check: none of the owner's modified files is touched by the patch, and `git apply --check` succeeds against the NAS working tree including uncommitted changes.

## 4. Evidence

| Check | Result |
|---|---|
| Unit tests, owner's working tree + patch (`D:\PandeshJugaadRC`, full `testDebugUnitTest`) | **pass** (build successful, 244 tasks) |
| Unit tests, patch branch, `PandeshUploadLogicTest` (7 tests incl. history lines) | pass |
| Pairing with certificate pinning, sealed requests | exercised earlier on the emulator against an isolated dev Core |
| Household isolation | tests with a real-TLS phone simulator; emulator device sees only its household's documents |
| Resumable upload, offline queue | queue and resume unit-tested; demonstrated on the emulator |
| OCR and search | text and image documents processed by Pandesh, found by search on the emulator |
| Reprocessing visibility | history lines unit-tested; the on-device button was added after the last emulator run |

**Not done:** the combined tree (owner's work plus patch) was compiled and unit-tested but **not re-run on the emulator**, and the new history button has not been tapped on a device. Nothing was run on the real phone `R3CXB0K5SEF`.

Unresolved: none open in this feature. Known limits: one level of history only (no diff viewer), and a phone without a household assignment is subject to Pandesh's legacy-record rule (see the desktop review, D3).

## 4a. Integration strategy (no overwrite)

1. Owner commits or stashes their working changes in their own checkout (or tells me they want a branch made from them).
2. Apply the patch: `git am patches/0001-…patch` on a new branch `feat/pandesh-documents` cut from that state.
3. Owner bumps the version through their usual process (for example 1.0.31 / code 32).
4. Owner builds the signed AAB with their keystore, **not** via `publish_internal.bat`, which I did not and will not run.
5. Emulator run first: build with `-PjugaadEmulatorBuild=true -PjugaadAppIdSuffix=.pandeshdev`, pair against a dev Core, run the checks in section 5.
6. Only then, with approval, install on the real phone.

## 5. Emulator acceptance checklist

Pair (pinned certificate; a wrong certificate must fail); upload a PDF and a photo; kill the network mid-upload and confirm resume; search a word from the document; ask the owner to reprocess in Pandesh and tap "How Pandesh read this"; confirm a second household's device sees none of it.

## 6. Backup and rollback

Back up before install: `adb backup` is not reliable here, so rely on the app's existing server-side sync; keep the current APK (`adb pull` of the installed package) so 1.0.30 can be reinstalled. Rollback is reinstalling that APK; the new feature stores only its upload queue and settings, so nothing older reads or depends on them.

## 7. Decisions needing owner approval

- A1. Approve the integration strategy (commit WIP first, then `git am`). Recommended.
- A2. Approve an emulator run of the combined tree (needs the dev Core started briefly).
- A3. Owner (or explicit authorisation) for the signed build, and the version number.
- A4. Separate approval to install on the real phone.
