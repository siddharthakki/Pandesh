# Build 188 integration for real-project testing (prepared 2026-11-22, NOT installed)

## What it is
- Branch `release/b188-live-workers` @ **505746b**, worktree `D:\PandeshRelease188d`. Not pushed.
- = `release/b188-connector-test` (94b4272, the package your ChatGPT connector runs on) merged with `feat/kandev-live-workers` @ cc79820 (live worker panels, A5 scoped coding, View diff).
- 8 files conflicted. Each was resolved with the live-workers version, because every b188-only line in them was an older form that those commits replaced. Examples: "not run from the browser bridge yet", the empty-workspace path, the old slot regex, the "Build a calculator" tests.
- The merged tree differs from `feat/kandev-live-workers` only by `build-number.json` (188) and `.gitattributes` (LF for panda-bridge scripts). The connector work was already on the live-workers line through #131.

## Built and checked
- Built by `D:\PandeshAssistantDev\rel188d\rc-build-b188d.ps1`, log `rc-build-log.txt` there:
  - package 24 s, exit 0
  - package smoke 80 s, exit 0
  - installer 444 s, exit 0
- Build identity:
  - build 188, release kind, commit 505746b…, `sourceState: clean`
  - staged payload 3,001 files
- Installer hashes:
  - `Pandesh-Setup.exe` SHA-256 `8c30850e…db01724`
  - smoke installer `EA5E8033…71D3AE`
- The start-at-login entry was present both before and after. Production (`E:\Pandesh`) was not touched; it was not running during the build.
- Tests in the merged worktree: bridge, diff, A5, worker and build-identity suites 91/91.
- Boot check on a fresh isolated profile (`D:\PandeshB188dAccept`, ports 3967/3968, CDP 9485):
  - health 200
  - no projects registered
  - `GET /v1/bridge/tasks/:id/diff` answers, and refuses a call without the host token (403)
  - stopped by pid afterwards

## Not done (your decisions)
- **Not switched.** Your live connector (gateway + tunnel-client) runs under the b188c desktop host (pid 17944, Core 3964). Switching stops it, so `switch-to-b188d.ps1` is yours to run:
  1. It stops only the recorded b188c pid.
  2. It backs up `D:\PandeshB188cAccept\profile` to `D:\PandeshBackups\b188c-profile-<time>` and verifies the file count.
  3. It starts b188d on the same profile and ports.
  4. Then press Start in Connections > ChatGPT; pairings and the key carry over.

  Undo with `rollback-to-b188c.ps1`.
- **No project registered.** The b188c profile has only "connector test workspace" (read). To test A5 on a real project, run `register-project.mjs --profile b188c --name … --path … --access read-write`. Every change still needs:
  1. your Allow on the card,
  2. your "Approve change" after View diff,
  3. your "Bring into my checkout" press, which delivers it as a new branch only.
- **Not installed** to production. Installing Build 188 needs your OK and the usual idle check.
