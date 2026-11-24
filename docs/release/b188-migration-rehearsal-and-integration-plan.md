# Build 187 → 188: migration rehearsal and integration plan

Written 2026-11-24 on `fix/daily-operator`. Nothing in this document has been carried out. Every step that touches
the real profile, the installed app, `main` or GitHub needs the owner's explicit approval, named per step.

## 1. Where things stand

| | Build 187 (daily app) | Build 188 (candidate) |
|---|---|---|
| Installed at | `E:\Pandesh` | not installed; release folder `D:\PandeshRelease188e` |
| Source | `release/b187-panda-bridge` f4cc50a | `release/b188f-missions` 65300af, local only |
| Commits ahead of `main` (0b73473) | 19 | 134 (contains all of Build 187 and all of `main`) |
| Profile | `%LOCALAPPDATA%\KarkeDikha\desktop`, 1.26 GB, 406 files | acceptance profile only; never ran on the real profile |
| Database schema | 55 | 55 |

`fix/daily-operator` = Build 188 + 6 local commits (the everyday-task fixes). It is the candidate, not 65300af.

Acceptance state of the candidate (isolated instance, 2026-11-24, run `pc-run-10`): all twelve everyday PC tasks
completed on the first try in 4 to 27 seconds each, one new chat per task, every outcome checked on the PC (disk and
GPU figures against a fresh measurement, the created file's three lines, the renamed file's SHA-256, a new Notepad
process, the reminder recorded as notified at its due time, the activity report against Core's records). The two
approval cards (allow file changes, rename) appeared and were needed. Checked once; not yet repeated on another day.

Facts that shape the plan, all read from the repositories and (read-only) from the profile:

- **No database migration separates 187 and 188.** Both stop at schema 55, and the real profile is at 55. Build 188
  adds no table through a migration, so Build 187 can open a profile that Build 188 has used. This is what the
  rehearsal has to confirm, because tables or JSON fields written at run time are not covered by the schema number.
- **The real profile holds live credentials and schedules**: Gmail connector and cloud-provider credential files, the
  phone pairing and companion files, 11 scheduled routines, 5 reminders, 1 standing authorization, 180 conversations
  with 1,538 messages. A second Pandesh started on a plain copy would run those routines a second time and use the
  same Gmail access. There is no switch that turns the scheduler off.
- **The Build 188 branch is not what the open pull requests contain.** #131 (`feat/stage-c-vertical-slice`) and #132
  (`feat/supervised-missions`) share history with it up to eadcdd7 and then differ: 61 commits are only in Build 188,
  13 only in #132 (5 of them with no equivalent in Build 188), 3 only in #131. The two trees differ in 16 files.
  Merging #131 and #132 would therefore not produce Build 188.
- **The three-place navigation (#133) is 10 commits on `main`.** A trial merge into `fix/daily-operator` conflicts in
  two files only: `apps/desktop/renderer/v2/app.css` and `core/runtime/piAgentEngine.ts`.

## 2. Migration rehearsal (on a protected copy; the real profile is only read)

Goal: prove that the candidate starts on the owner's real data, shows all of it, changes nothing it should not, and
that going back to Build 187 works. The rehearsal fails closed: any refusal below stops it.

### 2.1 Preconditions

1. Build 187 is not running (the copy must be consistent, and its start-at-login entry is not touched).
2. No other Pandesh instance holds the scratch ports (3991/3992/9481).
3. 3 GB free on `D:` (two copies of the profile plus the database backup). Today: 408 GB free.

### 2.2 Steps

| # | Step | Touches |
|---|---|---|
| 1 | Record the source: file list with sizes and SHA-256 of `core.db`, schema version, row counts of every table. | real profile, read-only |
| 2 | Copy the profile to `D:\PandeshP0Dev\migration-rehearsal\<timestamp>\profile-original` (database through SQLite's own backup, files by copy). Mark the folder read-only. This copy is never started. | new folder |
| 3 | Copy it again to `...\profile-working`. Only this one is ever opened by an app. | new folder |
| 4 | **Neutralise the working copy** so it cannot act in the world: disable every scheduled routine (`enabled = 0`, originals listed in a side file), remove the Gmail and cloud-provider credential files, the phone pairing, companion and host-token files (their presence and sizes are recorded first). | working copy |
| 5 | Start the candidate on the working copy through the safe launcher (needs a `--profile` option restricted to `D:\PandeshP0Dev`), loopback only, local models only. Confirm port 3030 is not opened. | scratch slot |
| 6 | Verify (table below). | read |
| 7 | Run three everyday tasks in a new chat (read a file, free disk space, "what did you do today") to prove it works on this data. | working copy |
| 8 | Stop the candidate. Record what it changed: schema version, row counts per table, new tables, files added or changed. | read |
| 9 | **Rollback proof**: start Build 187's own code (`release/b187-panda-bridge` worktree, not the installed app) on the working copy. It must open without the "upgraded by a newer Pandesh" refusal and show the same conversations. | scratch slot |
| 10 | Compare `profile-original` byte for byte with the real profile's recorded hashes: the source was not changed. | read |
| 11 | Write the rehearsal report; keep both copies until the owner says otherwise (they contain personal data and stay on this PC). | new file |

### 2.3 What is verified in step 6

| Area | Check | Pass when |
|---|---|---|
| Conversation history | conversation and message counts; open the three newest and the oldest chat in the window | counts equal the source; text renders |
| Permissions | permission mode per conversation, the standing authorization, workspace folders with their read / read-write setting | identical to the source; nothing widened |
| Paired devices | pairing records as the candidate lists them (the secrets themselves were removed in step 4) | same devices listed; no pairing lost by the code itself |
| Scheduled routines | the 11 routines and 5 reminders with schedule, text and model | all present and unchanged apart from the deliberate `enabled = 0`; none ran |
| Existing data | memory facts, projects and tasks, Second Brain, mail index, attachments, bots, skill proposals | counts and a sample of each equal the source |
| Nothing left the PC | Core's records of the rehearsal: no connector call, no cloud model call, no outbound message | zero of each |
| No flood | messages written by Core without a request during 10 minutes idle | zero |

Not covered by a rehearsal on a neutralised copy, and said so in the report: live Gmail and calendar access, the phone
connection, and routines actually firing. These are checked after the real upgrade, one at a time, with the owner.

### 2.4 The real upgrade, only after the rehearsal passed and the owner approved it

1. Core idle, no message in the last 5 minutes; quit Build 187 from the tray.
2. Back up the profile (`b188-upgrade-<timestamp>`) and keep the installed app as `E:\Pandesh-b187-rollback`.
3. Install the candidate from a staged payload (the installer step has been unreliable since Build 184).
4. Start it the normal way; check the list in 2.3 on the live profile, then Gmail, phone and one routine.
5. Rollback at any point: quit, restore `E:\Pandesh-b187-rollback`; because the schema is unchanged the profile needs
   no restore unless a check in 2.3 failed, in which case the backup is restored too.

## 3. Integration plan (how the candidate reaches `main`)

The aim is one reviewed line of history, not three overlapping stacks. No force-push, no admin merge without the
owner naming the pull requests.

### 3.1 Decide what the Build 188 line is

`release/b188f-missions` is local only and differs from #131 and #132. Two ways to reconcile; the first is recommended.

- **A (recommended): make the pull requests equal to what was tested.** Bring the 5 commits that exist only in #132
  and the 3 only in #131 into the Build 188 line where they are not already there in another form, re-run the focused
  checks, then update #131 and #132 so their heads carry the tested tree. Review happens on the existing pull
  requests; nothing reaches `main` that was not in the tested candidate.
- **B: one new pull request for the Build 188 line** and close #131 and #132 as superseded. Simpler history, but 134
  commits in a single review.

### 3.2 Order of pull requests

| Order | Pull request | Contains | Gate before merge |
|---|---|---|---|
| 1 | #131 Stage C vertical slice | Mission Control, outcome records | CI green; tree equals the tested line for its files |
| 2 | #132 supervised missions (re-targeted to `main` after #131) | A5 fix, missions, worker reliability | CI green; worker tests |
| 3 | new: Build 188 remainder | the 61 commits only in the release branch (bridge, worker resume, path rules) | CI green; the bridge and worker suites |
| 4 | new: daily operator (`fix/daily-operator`) | message box, sums, folder card, rename/move, open app, notification flood, activity report, permission wording | the twelve everyday tasks on the merged tree |
| 5 | #133 three places | Home / Work / Settings | rebased on the result; the two conflicts resolved; "Needs you" worker cards moved to Work → Needs attention |

#134 (3D scenes) stays frozen and is not part of this. #128, #102, #84 and #73 are unrelated and stay as they are.

### 3.3 The daily-use candidate

After step 5 the tree is "Build 188 execution + three-place navigation", which is the milestone. It gets a build
number, the twelve everyday tasks are run on it once more, and the migration rehearsal (section 2) is repeated with
that exact build before any installation is proposed.

### 3.4 Risks and how each is held

| Risk | Held by |
|---|---|
| A rehearsal instance acts on the owner's accounts | step 4 of 2.2: credentials removed and routines disabled in the working copy before anything starts |
| The real profile is changed by the rehearsal | it is only read; hashes compared in step 10 |
| Build 188 writes data Build 187 cannot read | step 9 of 2.2 starts Build 187's code on the used copy |
| The merged tree differs from what was tested | 3.1 A: pull-request heads are made equal to the tested tree, compared by tree hash |
| A background routine repeats itself, as the worker report did | rule in `CLAUDE.md`; "no flood" check in 2.3; scheduled automations, reminders and nightly maintenance still need the same review before nightly work is switched on |
| Timings measured while another program uses the model server | check `Get-NetTCPConnection -RemotePort 11434` before a timed run |
