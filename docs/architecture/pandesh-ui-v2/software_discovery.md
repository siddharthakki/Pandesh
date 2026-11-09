# Software Discovery & Update Manager — milestone 1B (read-only)

Owner brief: "Pandesh — Additional Feature: Software Discovery & Update Manager" (2026-11-08). Branch `feat/pandesh-ui-v2`. Update **execution** (milestone 2B) is not implemented and needs separate approval.

## Port & Service Manager — read-only part

No earlier "Port & Service Manager" proposal exists in this repository or in other sessions' transcripts. What exists is `core/runtime/portManager.ts` (P0): it manages Pandesh's own services and terminates only processes whose ownership is proven. The read-only milestone delivered here adds the system-wide view on top of it: every listening TCP port with its owning process and executable, the Pandesh-managed service registered on it (from `port-manager-registry.json`, read only), the Windows service hosted by that process, and all Windows services. Nothing is stopped, freed or restarted.

## What it does

| Area | Implementation (`core/runtime/software/`) |
|---|---|
| Discovery | `inventory.ts` collectors, isolated and parallel: listening ports + processes + Windows services (one PowerShell CIM query), installed programs (Uninstall registry keys), winget (`winget export`, no agreements accepted on the user's behalf), Scoop (`scoop export`), Chocolatey (`choco list`), Python interpreters (`py -0p`, PATH) and each one's packages via `importlib.metadata`, uv tools, global npm packages (their `package.json`), Docker containers/images, Ollama models (local API), Git repositories under the scan folders (default `D:\Projects`, configurable via `PANDESH_SOFTWARE_SCAN_ROOTS`). A failing collector reports why; the rest still show. |
| Install method | From the collector that found the item (Git clone, winget, Scoop, Chocolatey, pip, uv, npm, installer, Docker, Ollama). |
| Upstream | Only from local evidence: git remotes (exact `github.com` owner/repo; `upstream` remote recorded), `package.json` "repository", Python Home-page / Project-URL. Installer "about" URLs are vendor-stated and stay **unverified**. Look-alike hosts, organisation URLs and pages sites never match. No name-based guessing anywhere. |
| Git state (read-only) | Branch, HEAD, nearest tag, changed/untracked counts, unpushed/behind vs the local upstream ref (no fetch), whether HEAD is pushed, worktrees, branches. Every git call uses `--no-optional-locks`. |
| Update discovery | `updates.ts`: the package managers' own views (`winget upgrade`, `pip list --outdated` per environment, `npm outdated -g`, `choco outdated`); `scoop status` is not used because it writes bucket repositories. GitHub REST (unauthenticated) only for verified upstreams of git repositories and npm packages: repository (fork/parent, archived, default branch), releases (latest stable separately from prereleases), compare of the default branch against a **pushed** HEAD (commits behind), published security advisories when an update exists. |
| Privacy | Requests carry owner/repo and, only when already on a remote branch, the HEAD hash. Never paths, file contents, configuration or credentials. Unpushed commits are reported as "not compared online". |
| Cache & limits | `software-update-cache.json` in the Core data folder with ETags (304 responses do not count against GitHub's limit); on a 403/429 with `x-ratelimit-remaining: 0` further GitHub requests stop and the rest are marked `rate_limited` until the reset time; a network failure keeps the last result marked stale. Check history (last 50). |
| Periodic checks | Off by default; user setting 6 h … 7 days (`software-update-settings.json`); a 15-minute timer that never keeps Core alive. |
| Dependencies | For each item, listening ports and Windows services whose executable lives in its install folder ("Updating may interrupt …"). |
| API | Host-only Core routes `GET /v1/software/inventory[?refresh=1]`, `GET /v1/software/updates`, `POST /v1/software/updates/check`, `POST /v1/software/settings` (`core/api/softwareRoutes.ts`), reached through the existing `household` desktop bridge actions. |
| UI | v2: System → **Software & Services** (also in Ctrl+K): tabs Services & Ports, Installed Tools (method filter), GitHub Projects, Available Updates (release notes via the governed external-link opener, advisories, interruption warnings, periodic setting), Update History (checks run; states plainly that no update was installed). Search on every tab. No Update button: the page says updating is not enabled. |

## Verified

- Unit tests `core/test/softwareDiscovery.test.ts` 12/12: strict GitHub matching (look-alikes rejected), metadata URLs, porcelain counts, version/prerelease ordering, winget table with spinner, periodic schedule; collector isolation with a failing Docker, read-only command audit (no fetch/pull/install/update/…; all git calls lock-free), dependents; update check: newer stable vs separate prerelease, advisories, only `api.github.com/repos/<owner>/<repo>` URLs and no local path, unpushed HEAD never sent, fork detection, rate limit stops and marks, ETag 304 reuse after reset, stale fallback on network failure, package-manager answers authoritative.
- Real app (isolated profile, this PC): scan 22 s — 51 listening ports, 308 services, 690 items (101 programs, 86 winget, 447 Python packages across environments, 8 npm, 21 Docker, 14 Ollama models, 3 uv, 1 Scoop), 18 Git repositories; Chocolatey correctly "not installed". "Check for updates" from the UI: 62 s, winget 40, pip 254, npm 7 updates; GitHub 9 projects (37 of 60 hourly requests left); the Pandesh worktrees correctly "not compared online" (unpushed); docs branch correctly "2 unpushed". Screenshots in `acceptance-software/`.

## Not done / limits

- Update execution, checkpoints, rollback, service restarts (milestone 2B) — not implemented by design.
- Release notes are linked, not fetched in full; changelog files are not parsed.
- pip/npm packages use their package managers' versions; their GitHub upstream is shown but not compared (to save GitHub's request budget).
- Ollama model updates are not determined (no reliable public version signal without pulling).
- Executable paths of protected system processes are not disclosed to a non-elevated Core; Pandesh does not elevate.
- `winget upgrade` needs the source agreement accepted once by the user; Pandesh never accepts it.
