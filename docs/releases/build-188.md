# Build 188 (v0.1.8)

Released 2026-11-25. Commit `e8fb45e` plus documentation. Installer: `Pandesh-Setup.exe` (340 MB), SHA-256
`58C781777CD9E1493C4B318DB3C290E7D4CFCFEE977C4C9317718720E7F1EEDF`. Not code-signed.

## What it is

The consolidated stabilization release: supervised missions, the daily-operator fixes, the Home / Work / Settings layout, 3D
scenes, the Panda Bridge connector and a storage lifecycle, merged into one line (PR #132 replaces #131, #133 and #134).

## New and changed

- **Home, Work, Settings** replace the long list of screens. Worker tasks (Claude Code, OpenCode) show their details under Work
  and only the current chat's live workers appear in the chat, as one plain sentence.
- **Direct answers:** free disk space is read from the system tool without loading a model (about 4 s instead of about 28 s).
- **Everyday chores:** rename or move a file and open an app as governed tools.
- **Honest mail claims:** "you have unread emails" is withheld unless a mailbox read succeeded.
- **3D scenes** from a description, opened in the Workshop viewer.
- **Reliability:** workers resume after dying mid-turn, a failed worker is announced once, expiring approval cards.
- **Storage:** private task copies are swept automatically (Core start and hourly); golden evidence is bounded by size;
  `npm run storage:preflight` and `storage:postflight` enforce one repository, one active branch and exact, expiring exceptions.

## Checked before release

- Full suite on the final commit: 8,209 passed and 1 load-sensitive failure (`diffReview`, passes alone); CI green.
- Installer smoke on a clean directory: 14 of 14 (install, run, upgrade while running, data preserved, uninstall).
- Twelve everyday tasks on the packaged app, including a reminder; one task failed on the first try because the model refused
  to write outside the selected folder and passed on a re-run.
- Production upgrade from Build 187: payload verified file by file (2,988 of 2,988), database `quick_check` ok, schema 55,
  180 conversations intact, Core healthy, phone pairing record and Gmail connector state preserved.

## Known issues

- The Settings page showed "Â·" for "·" in one label; fixed in source after this build and shipped with the next one.
- A first message after a big model swap can fail with "Ollama is not reachable"; send it again.
- Not shown in a recording: a live Gmail read, a real phone pairing.
- Unsigned installer: SmartScreen may warn.

## Rolling back

Keep `E:\Pandesh-b187-rollback` (Build 187) and the profile snapshot taken before the upgrade. Build 188 adds no migration
that Build 187 cannot ignore (schema 55 in both).
