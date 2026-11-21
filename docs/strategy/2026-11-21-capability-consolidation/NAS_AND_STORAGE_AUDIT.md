# NAS and storage audit (2026-11-21)

**Scope:** metadata only. No household file was opened, moved or copied, and nothing was sent off the machine. Synology DSM was **not** accessed: no credentials were used, and none are stored for agents.

## What is verified

| Item | Finding |
|---|---|
| NAS | `\\SID-NAS` (Synology DS720+ per owner), reachable over SMB |
| Mappings | `Z:` → `\\SID-NAS\home`, `Y:` → `\\SID-NAS\homes`, both OK |
| Capacity (as SMB reports it) | 466 GB used, 6,678 GB free |
| `Z:\` | `AI` (Archive, Career, kkd-eval, Media), `Photos`, `Projects` |
| `Z:\Projects\Projects` | The working copy of **almost every non-Pandesh project**: household-platform (git), devradar, Novocomedy, JobFinder, trading-bot, resume (git; JobHub), `_scripts` (Cloudflare DDNS), FlavorAcademy, Chithra, real_estate, Kingshot_Combined, Pandesh-intent-kernel, Pandesh_Preserved_Work, `_jugaad_backup_20261028_1428`, … Moved from `C:\Projects` around 2026-11-17 (`C:\Projects` now holds only `ImageGeneration` and `NovoComedyAiMetatag`). |
| `Y:\` (homes) | User homes: admin, Chithra, Siddharth, sidnasadmin, "Toshiba Back" |
| Sensitive file | A credentials file sits at the `Z:\Projects\Projects` root, next to a `.bak` copy. **Not opened.** Recommend moving secrets into Windows Credential Manager or a vault, not a share. |

**Consequences found:**
- Three scheduled tasks broke when `C:\Projects` moved (see `CI_CD_AUTOMATION_PLAN.md`).
- Git repositories now live on an SMB share. Git over SMB works but is slow, and is fragile if the share drops mid-operation.

## What is not verified (needs DSM access by the owner)
- DSM version, Btrfs vs ext4 (snapshots need Btrfs), Snapshot Replication, Hyper Backup tasks, Synology Photos / Drive, RAID / SHR health, disk SMART, UPS, and whether any off-NAS backup exists.
- Whether the PC itself is backed up to the NAS (no Windows backup task found among the scheduled tasks).

## Backup design (proposal; uses Synology features first)

| Need | Recommended mechanism | Pandesh's part |
|---|---|---|
| Phone photos / videos, incremental and resumable | **Synology Photos mobile backup** (it resumes, handles duplicates, versions). JUGAAD's resumable upload is for documents to Pandesh, not a photo backup. | Monitor only: last backup age per device (DSM API, read-only, owner-provided token in Credential Manager) |
| Project source protection | Git remotes (GitHub) + **Btrfs snapshots** on the `home` share (hourly/daily) | Daily check: every repo under `Z:\Projects\Projects` has no unpushed commits older than N days; report only |
| Versioned project backups and release archives | **Hyper Backup** to a USB disk or cloud of the owner's choosing (encrypted client-side) | Report last success |
| Integrity checking | Btrfs data scrubbing (DSM schedule) + Hyper Backup integrity check | Read the results |
| Restore testing | Monthly: restore one random project folder to a scratch path, `git fsck`, compare hashes | A deterministic Pandesh workflow (verify-hash workflow already exists) |
| Duplicate detection / document indexing | Metadata-only inventory (size + sampled fingerprint, as in `model-store-inventory.mjs`); content indexing only for folders the owner grants (`documentReadGrants`) | Generalise the inventory script to any root |
| Failure notifications | Pandesh daily diagnostics (`svc.health` + backup checks) → Pandesh notification / phone | Not built |

## Safety boundaries (kept)
- No household file contents are read without an explicit folder grant.
- No NAS data goes to cloud models. Deterministic services only; Claude or ChatGPT only behind the approval card, and never for household folders.
- No moves or deletes on the NAS from automation. Reports only.
- New tooling is tested on synthetic data first; the inventory and lock tests use temporary folders.

## Storage consolidation opportunities (verified)

| Opportunity | Size | Basis |
|---|---|---|
| Duplicate model files (Strata nested copy, HF snapshot copies) | 74.27 GB | full SHA-256 (`MODEL_INVENTORY.md`) |
| Hidden Ollama `llamacpp:` gpt-oss blob | up to 12.85 GB | not in `ollama list`; check with `ollama show` |
| Pandesh scratch / eval / test profiles on D: | see `PROJECT_CONSOLIDATION.md` | sizes measured; Git state checked; nothing deleted |

## Next steps
1. **Owner:** confirm in DSM whether Btrfs snapshots and Hyper Backup are on, and whether the PC is backed up.
2. Build a read-only "backup health" workflow: NAS mounted, last-snapshot age (DSM API with an owner token), unpushed-commit report for `Z:\Projects\Projects`.
3. Generalise the inventory script into a metadata-only file inventory for owner-granted folders.
