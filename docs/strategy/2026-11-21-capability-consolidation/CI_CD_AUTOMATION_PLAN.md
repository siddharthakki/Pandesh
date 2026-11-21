# CI/CD and automation plan (2026-11-21)

## What exists (verified today)

| Piece | State |
|---|---|
| GitHub Actions | One workflow, `.github/workflows/ci.yml`: jobs `test` and `timing-sensitive` on `windows-latest` (hosted). Last two runs on `feat/stage-c-vertical-slice` failed (11-18). Main green on 11-18. |
| Self-hosted runner | Scripts exist (`scripts/github-actions/ensure-runner.ps1`, `install-runner-service.sh`, `keep-runner-alive.ps1`, `watch-latest-ci.ps1`); **no runner is registered** (API returns none). |
| Local test entry points | `npm test` (heap wrapper, about 8,100 tests; the Core suite loads the real 27B unless `KARKEDIKHA_OLLAMA_URL` is dead), `npm run compile`, `typecheck:core`, `typecheck:webview-v2`, `secrets:scan:staged`, `scripts/check-ai-os-docs.mjs` (failing: AI OS root docs missing). |
| Release scripts | `D:\PandeshAssistantDev\rel18x`, `D:\PandeshJarvisDev\rel184` per build; installer (Inno) step known broken, installs use the staged payload. |
| Windows Task Scheduler | See below. Three owner automations are **broken**. |
| Docker / WSL | Installed, both stopped. |
| n8n / Dagu | Not installed. |
| Pandesh's own scheduler | `core/runtime/scheduler.ts`, scheduled tasks + routine write grants (host-only) exist in Core. |

### Scheduled tasks: health

| Task | Last result | Cause | Fix (owner OK needed; not applied) |
|---|---|---|---|
| Cloudflare DDNS - khakedikha.de | 2 (file not found) | `C:\Projects\_scripts\cloudflare_ddns.py` moved to `Z:\Projects\Projects\_scripts\` on about 11-17 | Repoint the action (below) |
| JobHub Daily Automation | 1 | `C:\Projects\resume\jobhub\run_daily.bat` moved to `Z:\Projects\Projects\resume\jobhub\` | Repoint; check the script's own relative paths |
| AutoClaw Launch At Login | 0x80070002 (not found) | `C:\Program Files\AutoClaw\AutoClaw.exe` absent | Disable the task, or reinstall AutoClaw |
| Hermes_Gateway | 0xC000013A (terminated) | Gateway process ended at logon on 11-15 | Check Hermes logs; Kandev also reports `hermes-acp` not installed |
| cua-driver-serve | 0 | — | — |

**Repoint commands** (run in an elevated PowerShell **only if you want this**; they rewrite standing configuration, and the DDNS one updates a public DNS record):

```powershell
$a = New-ScheduledTaskAction -Execute 'python' -Argument 'Z:\Projects\Projects\_scripts\cloudflare_ddns.py'
Set-ScheduledTask -TaskName 'Cloudflare DDNS - khakedikha.de' -Action $a
```

```powershell
$a = New-ScheduledTaskAction -Execute 'Z:\Projects\Projects\resume\jobhub\run_daily.bat' -WorkingDirectory 'Z:\Projects\Projects\resume\jobhub'
Set-ScheduledTask -TaskName 'JobHub Daily Automation' -Action $a
```

A task that reads its script from the NAS fails whenever the NAS is not mounted at logon. A local copy plus a NAS backup is more robust.

## Recommended design (simplest reliable, using what is installed)
1. **Scheduler: Windows Task Scheduler**, already in use, plus Pandesh's own scheduled tasks for anything that should show in Pandesh. Do not add n8n or Dagu: neither is installed, and both would duplicate Pandesh's scheduler.
2. **One lock file per shared resource**, honoured by every job:
   - `gpu` (the RTX 3090; same rule as Kandev's GPU lane: one at a time)
   - `scratch-ports` (3991/3992/9481)
   - `ollama-27b`

   Implement as a tiny `scripts/lib/resource-lock.mjs` (an exclusive create of `%LOCALAPPDATA%\Pandesh\locks\<name>.lock` with pid + start time, stale after the pid dies). Every scheduled job and the test runner take the lock they need.
3. **Pandesh pipeline (local), one script:** `scripts/ci/local-pipeline.mjs`
   1. Changed files → targeted vitest (map `core/runtime/kandev/*` → `core/test/kandev*`, `pandaBridge*`)
   2. `typecheck:core` + renderer typecheck
   3. Full suite with a dead Ollama URL (takes the `gpu` lock only for the opt-in 27B suite)
   4. Bundle (`esbuild.core.js`, `apps/desktop/esbuild.mjs`)
   5. Smoke on the scratch instance (takes `scratch-ports`): start, `/v1/bridge/executors`, one deterministic service, stop by pid
   6. Write `evidence/<sha>/` (test JSON, timings, screenshot)
   7. Mark RC

   No deploy step; production install stays manual.
4. **GitHub:** keep hosted CI for PRs. Add the self-hosted runner only for jobs that need the GPU or Kandev, labelled `gpu`, and give them the same locks. The known flaky tests (`missionRepair` "bounded repair, then commits", `conversationRelevanceSequence` "operator declines") get one automatic re-run.
5. **KKD (`E:\kkd-eval-lab`, `Z:\AI\kkd-eval`):** `E:\kkd-eval-lab` has 40 uncommitted changes and no remote. Commit (owner) before any pipeline.
6. **JUGAAD (`D:\PandeshJugaadDev`, household-platform):** pipeline = Gradle unit tests + backend tests + emulator qualification (`docs/release/B188_DESKTOP_RELEASE_REVIEW.md` / JUGAAD Android review have the commands). It needs the emulator, which is GPU-heavy, so it takes the `gpu` lock. No signing.

## Recurring automation (prepare in isolation; do not enable on production without OK)

| Workload | Where it should run | Deterministic? | Status |
|---|---|---|---|
| Daily diagnostics (services, disk, scheduled-task results, NAS mount) | Pandesh `svc.health` + a small scheduled workflow | yes | `svc.health` exists; scheduled-task results are not yet included |
| Backup health (NAS reachable, last backup age) | Pandesh workflow | yes | not built |
| Model compatibility check | `scripts/model-inventory-audit.mjs --eval` (exists) + the new store inventory | mostly | exists; run weekly under the `gpu` lock |
| Document processing (authorized folders) | `extract-document` workflow + OCR | yes | exists; folder grants per `documentReadGrants` |
| Job monitoring | JobHub (repoint first) | partly | broken (path) |
| Hardware price monitoring, research reports | model-driven, local | no | not built |
| WhatsApp export processing | authorized exports only | yes (parse) + model (summary) | not built |

## Next implementation steps
1. `resource-lock.mjs` + tests.
2. `local-pipeline.mjs` (steps above) + an evidence folder.
3. Add the scheduled-task result check to `svc.health`. It would have caught the three broken tasks.
