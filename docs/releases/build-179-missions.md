# Build 179 release notes and rollback (PR #118, missions)

Status when written (2026-11-16): release candidate. Not merged, not installed. Production is Build 178.

## What changes for a running installation

- **Database:** schema 52 → 53. Two new, empty tables (`missions`, `mission_steps`) and their indexes. No existing table
  or row is changed. Core makes its own copy of the schema-52 database first
  (`<profile>\migration-backups\core-schema52-<time>.db`, the three newest are kept).
- **Files in the profile:** none are rewritten by the upgrade (settings, credential blobs, phone pairing, tokens).
- **New folders created on use, never at install:** `Documents\Pandesh\Missions\<date>-<objective>` for a mission started
  without a selected folder; `<profile>\skill-proposals\mission-…` for the inactive draft a clean mission leaves.
- **Behaviour:** see `docs/architecture/missions-2026-11-16.md`.

## Migration qualification (isolated copies, never the live profile)

Source: the profile backup taken with Pandesh stopped right before the Build 178 install
(`D:\PandeshBackups\b178-upgrade-20261116T131623Z\profile-final-…`, 247 files, 892 MB, schema 52). It is about two hours
older than the live profile; the live profile was not read or copied.

| Check | Result |
|---|---|
| Backup against its own SHA-256 manifest, before and after the whole exercise | 247/247 both times |
| Working copy against the same manifest | 247/247 |
| Upgrade with this branch's database-open path (what Core runs at start) | schema 53, `quick_check` ok, migration 53 applied, pre-migration copy written |
| Every pre-existing table, row count and SHA-256 over all rows, before vs after | 112 of 112 identical (`schema_migrations` and `core_metadata` change by design) |
| Conversations / messages / attempts / approvals by status / scheduled tasks | 133 / 1323 / 793 / approved 208, expired 19, pending 5, rejected 12, superseded 11 / 7: unchanged |
| Settings, credential blobs, tokens, phone pairing (20 files, by hash) | 20 of 20 identical; pairing still version 2 with 1 phone |
| A mission written and read back on the upgraded copy, on one of its real conversations | stored, listed, shown by the mission view, marked interrupted by the boot rule; the conversation's messages untouched |
| Build 178's database-open code on the **upgraded** copy | refuses: "upgraded by a newer Pandesh (schema 53); this build supports schema 52 at most. Nothing was changed." |
| Build 178's database-open code on a **freshly restored, hash-verified** copy of the backup | opens at schema 52, no migration, all 112 tables identical to the original |

Not done, on purpose: neither the Build 179 app nor the Build 178 app was *launched* on a copy of the real profile. A
launched app would start the owner's routines, reminders and connectors (Gmail, calendar, phone server) from the copy,
against real accounts. The checks above use the same database-open code each build runs at start. The first real launch
of Build 179 on the real profile is the install itself.

Scripts and outputs: `D:\PandeshJarvisDev\migration-qual\` (`snapshot.mjs`, `compare.mjs`, `open-with.ts`,
`mission-roundtrip.ts`, `before.json`, `after.json`, `restored.json`).

## Rollback procedure (replacing the program files is not enough)

Build 178 cannot open a schema-53 database, so a rollback always restores the profile too.

1. **Before the install** (the established install script already does this): stop Pandesh only when it is idle; copy
   the stopped profile `%LOCALAPPDATA%\KarkeDikha\desktop` to `D:\PandeshBackups\b179-upgrade-<time>\profile-final-<time>`
   with a SHA-256 manifest (`hashtree.mjs`), verify the manifest against the live profile, and rename `E:\Pandesh` to
   `E:\Pandesh-b178-backup`.
2. **To roll back:**
   1. Quit Pandesh from the tray; confirm no process runs from `E:\Pandesh` (the Core, `runtime\node.exe core.js`, can
      outlive the window: stop only that one).
   2. Rename `E:\Pandesh` → `E:\Pandesh-b179-failed`, and `E:\Pandesh-b178-backup` → `E:\Pandesh`.
   3. Rename the profile `%LOCALAPPDATA%\KarkeDikha\desktop` → `desktop-b179-failed` (keep it: it holds everything done on
      Build 179).
   4. Copy `D:\PandeshBackups\b179-upgrade-<time>\profile-final-<time>` to `%LOCALAPPDATA%\KarkeDikha\desktop`.
   5. Verify the restored profile: `node hashtree.mjs --verify "%LOCALAPPDATA%\KarkeDikha\desktop" manifest-profile-final-<time>.json`
      must report every file.
   6. Start Pandesh from the Start menu. Check: build identity says 178, Core answers, the conversation count matches the
      backup, the phone is still paired.
3. **What a rollback loses:** everything written after the backup was taken (chats, approvals, missions, memory,
   reminders created on Build 179). It stays in `desktop-b179-failed` and is not merged back automatically.
4. **Lighter alternative, only if nothing worth keeping was done on Build 179 and only the database must go back:** with
   Pandesh stopped, replace `core.db` (and delete `core.db-wal` / `core.db-shm`) with
   `migration-backups\core-schema52-<time>.db`. This restores the database as it was at the first Build 179 start, not
   the other profile files. Prefer the full restore.

## Release risks

- **One-way schema step.** Mitigated by the backup and the procedure above; verified on copies only.
- **A local 9B lead plans unevenly.** Core enforces mode, evidence and the independent check, not plan quality.
- **GPU contention.** A mission's specialists and the lead share one GPU; the Studio step may start ComfyUI, which then
  stays running and holds VRAM until it is closed.
- **New files outside the profile** (mission folders in Documents) appear when missions run.
- **The full test suite was not run**; CI runs the unit tier for the files this change touches.
