# Projects, worktrees, branches and staging (2026-11-21)

**Rule followed:** Git state was checked before anything was called redundant. Folder age alone was not used. **Nothing was deleted, moved or archived.**

## Active projects (located today)

| Project | Location(s) | VCS | State |
|---|---|---|---|
| Pandesh | `D:\Projects\Pandesh` (main checkout) + 14 worktrees + release worktrees | GitHub `siddharthakki/Pandesh` | Active; production at `E:\Pandesh` |
| Pandesh releases repo | `D:\Projects\Pandesh_Releases`, `Z:\Projects\Projects\Pandesh_Releases` | GitHub | Two clones |
| JUGAAD / household-platform | `D:\PandeshJugaadDev` (branch `feat/pandesh-documents`, 6 uncommitted), `Z:\Projects\Projects\household-platform`, `Z:\…\jugaadu`, `Z:\…\_jugaad_backup_20261028_1428` | GitHub (ssh) | Active dev copy on D:; check that NAS copies are not ahead of it |
| KKD eval lab | `E:\kkd-eval-lab` (master, **40 uncommitted, no remote**), `Z:\AI\kkd-eval` | local only | **At risk:** no remote; commit and push, or snapshot |
| Novocomedy, devradar, JobFinder/JobHub (`resume`), trading-bot, FlavorAcademy, real_estate, Kingshot, Chithra, collusion_hackathon, Hi-Event, OpenSourceJev, portfolios, gsd | `Z:\Projects\Projects\*` | git | On the NAS since about 11-17 |
| Image Studio (ComfyUI) | `C:\Projects\ImageGeneration` | no git | Required by Pandesh Image Studio; **no backup** (memory note 11-17) |
| WhatsApp Community Brain, Hybrid ScoreLab | not found under the scanned roots | — | Ask the owner where they live |

## Pandesh worktrees

| Path | Branch | Uncommitted | vs upstream | Recommendation |
|---|---|---|---|---|
| D:\Projects\Pandesh | feat/kandev-live-workers | 12 untracked (acceptance evidence, scripts) | — | Keep; commit or move the untracked evidence |
| D:\Projects\Pandesh-consolidation | feat/capability-consolidation | 0 | new | Keep (this work) |
| D:\Projects\Pandesh-activity | feat/live-activity-visibility | **7** | no upstream | **Preserve**: uncommitted work; review before anything |
| D:\Projects\Pandesh-journal | fix/tool-execution-journal | **14** | 246 behind | **Preserve**: uncommitted; the branch content shipped (memory: P0 journal in PR #69), but the 14 edits are unknown |
| D:\Projects\Pandesh-rc | rc/trial-2026-11-14 | 0 | 125 behind / 8 ahead | 8 commits not on upstream: check whether they are in main by diff, then candidate for removal |
| D:\Projects\Pandesh-assistant | feat/personal-assistant | 0 | 0/0 | Merged (#126). Candidate for removal |
| D:\Projects\Pandesh-mailhub | chore/build-186 | 0 | 0/0 | Merged (#127/#129). Candidate |
| D:\Projects\Pandesh-websearch | fix/web-search-blocked | 0 | 0/0 | Merged (#125). Candidate |
| D:\Projects\Pandesh-jarvis | fix/overview-event-loop-stall | 0 | 0/0 | Check that it is in main; candidate |
| D:\Projects\Pandesh-v2only | feat/v2-only-ui | 0 | 0/0 | Open PR #73: keep |
| D:\Projects\Pandesh-workshop | feat/workshop | 0 | no upstream | Merged (#60); memory says another session junctions its node_modules: keep until that is gone |
| D:\Projects\Pandesh-audit (+ .tmp/pr48-wake) | fix/post-v2-max-audit | 0 | — | Merged (#47). Candidate |
| D:\Projects\Pandesh-pdfjs-fix, -xmldom-fix | fix/* | 0 | — | Security fixes already in main (memory). Candidates |
| D:\Projects\Pandesh-freshcheck | release-build (separate clone) | 0 | 0/0 | Build 160 check clone. Candidate |
| D:\Projects\pbe\verifyA, verifyB | detached | 0 | — | Kandev calculator-test integrations from 10-27. Candidates |
| D:\PandeshProd186 | detached @ 0d04fde | 0 | — | **Keep while Build 186 is a rollback target** |
| D:\PandeshRelease187 / 188 / 188c | release/* | 0 | — | Keep 188c (live ChatGPT test package). Keep 187 while it is production's base. 188 per release decision |
| scratch worktree `…\Temp\claude\…\m69` | detached fc31843 | ? | — | Another session's scratch worktree; leave to it |

**Removal command for later** (owner OK, one at a time, after checking the "Candidate" rows):

```powershell
git -C D:\Projects\Pandesh worktree remove <path>
```

It refuses if there are uncommitted changes. Never use `--force` on the "Preserve" rows.

## Branches with commits not in `origin/main` (24 of 54 local branches)
The counts include squash-merged work: a branch whose PR was squash-merged still shows its commits.

**Verify with `git diff origin/main...<branch>` before calling any branch redundant.**
- Active: `feat/stage-c-vertical-slice` (59, PR #131), `feat/kandev-live-workers` (65), `feat/capability-consolidation` (66), `release/b188-*`, `release/b187-panda-bridge`.
- Open PRs: #73 `feat/v2-only-ui`, #84 `m4/routing-baseline`, #102 `feat/operator-pilot`, #128 `docs/readme-build-185`.
- Probably landed via other PRs (memory notes): `fix/xmldom-ghsa`, `fix/pdfjs-ghsa-hq66`, `fix/v2-wake-word`, `fix/login-item-owner-check`, `chore/build-170`, `build/pandesh-147`.
- Unknown value, worth one look each: `feat/jugaad-bridge`, `feat/intent-kernel` (the NAS has a `Pandesh-intent-kernel` repo), `hold/renderer-mascot`, `fix/model-selection-media-intent`, `docs/stage-a-review`, `docs/stage-b-design`, `test/b170-installed-validation`, `rc/trial-2026-11-14`.

## Staging, eval and test folders on D: / E:
Sizes are in the table appended below (measured with `du`; Git state checked where relevant). **Recommended structure:**

```
D:\Projects\<repo>               main checkouts only
D:\Projects\_worktrees\<repo>\<branch>   feature worktrees (today they sit beside the main checkout)
D:\PandeshLab\<purpose>-<date>   scratch profiles, eval runs, acceptance profiles (today about 40 top-level D:\Pandesh* folders)
E:\PandeshReleases\<build>       installed builds and rollbacks (keep the last 2)
E:\AI\models\…                   one model library (see MODEL_INVENTORY.md)
```
