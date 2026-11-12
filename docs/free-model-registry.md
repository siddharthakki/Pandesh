# Free model registry and provider keys

Pandesh keeps a self-updating registry of free AI model providers and uses it, through the existing pool router, only
for public text you approve. Private content always stays on this PC.

## How it works

| Piece | File | What it does |
|---|---|---|
| Registry (pure) | `core/platform/freeModelRegistry.ts` | Parses the two upstream data files, sanitises every value, reconciles both into one record per provider and model with provenance and conflicts, computes status, diffs refreshes. |
| Eligibility (pure) | `core/platform/freeModelEligibility.ts` | Admission rules plugged into the existing `rankPool`/`decidePool` (`cloudRouting.ts`): no second router. |
| Service | `core/runtime/freeModelRegistryService.ts` | Fetch, last known-good persistence (`<core data>/free-models/`), Pandesh's own provider checks, qualifications, routing preferences. |
| Qualification | `core/runtime/modelQualification.ts` | Suite `pandesh-qual-v1`: basic, coding (static check, never executed), tool-call schema, JSON, ~3k-token recall, unknown-model error handling, rate-limit headers. At most 7 short requests, stops at the first 429, explicit action only. |
| Daily refresh | `core/runtime/freeModelRegistryRoutine.ts` | Routine `free_model_registry` in the existing scheduler (05:45). Starts after the first manual refresh; can be switched off. |
| Fallback | `core/runtime/executor.ts` (`runCloudPublicText`) | On a 429/402 before any text arrives, moves to the next approved alternative frozen into the approval, re-checked at that moment; records `cloud_provider_switched` for the live activity view. |
| Keys | `apps/desktop/src/host/credentialVault.ts` | Windows Credential Manager (`pandesh/<provider>/api-key`), legacy `safeStorage` files still read, explicit migration, encrypted backup/restore. |
| UI | `apps/desktop/renderer-v2/src/FreeModels.tsx` (Connections) and the Classic approval card | Registry, status, setup, health, qualification, routing preferences, keys, backup/restore. |

### Status meanings

- **unverified**: an upstream registry lists it as free. Never used automatically.
- **verified_free**: Pandesh asked the provider itself, with your key, and the provider's own model list shows it free (zero price, or the catalog's documented free-tier rule).
- **restricted**: trial or credit-limited, card required, prompts may be used for training, non-commercial, paid-only now, or instruction-like text in its registry entry.
- **unavailable**: archived, no adapter, failed its health check, or no longer listed free by the provider.
- **unknown**: not enough information.

A model is chosen automatically only when it is verified free, its provider holds a key, you approved that provider for automatic routing, and it passed the qualification test for the task (chat, coding, JSON, tools, long context are separate).

### Sources

| Source | License | Use |
|---|---|---|
| [mvalentsev/awesome-free-ai-coding](https://github.com/mvalentsev/awesome-free-ai-coding) `index.json` | MIT | primary discovery |
| [pacocartones/free-llm-api-hub](https://github.com/pacocartones/free-llm-api-hub) `data/providers.json` | MIT | secondary verification |
| [golapkamal/awesome-free-llm-apis](https://github.com/golapkamal/awesome-free-llm-apis) | MIT | not imported: README tables only |

Only those two files are fetched (https, 4 MB cap, 20 s timeout). Nothing from those repositories is executed. A source that fails, is not JSON, fails validation, or shrinks by more than half keeps its last good data.

## Keys: where they live

- Active store: Windows Credential Manager, generic credentials `pandesh/<provider>/api-key`, for your Windows user on this PC. Outside the repository, the install folder, the data folder and the renderer.
- Reinstalling, updating, rebuilding or recloning Pandesh does not touch them.
- Non-secret settings (enabled providers, selected model) stay in `%LOCALAPPDATA%\KarkeDikha\desktop\cloud-providers.json`.
- Keys saved by earlier builds (`cloud-provider-<id>.credential.bin`, Electron safeStorage) keep working. **Connections → Free cloud models → Keys → Move them to Credential Manager** copies them over and checks each by reading it back.
- Core receives a key in memory only, and never returns it. Agents and models never see keys.

## Recovery on a new PC or after reinstalling Windows

Before (on the working PC):

1. Open **Connections → Free cloud models → Keys: backup and restore**.
2. Enter a passphrase of at least 12 characters, twice. Pandesh does not store it, so keep it in your password manager (KeePassXC works well).
3. Click **Save encrypted backup…** and save the `.pandesh-keys` file somewhere off the system drive (for example `D:\PandeshBackups` or a USB stick).

The file is encrypted with scrypt (N=2^17, r=8, p=1) and AES-256-GCM. Provider names are inside the encrypted part, and the header is authenticated. The file is not tied to Windows or to your profile.

After (on the new PC or the fresh Windows):

1. Install Pandesh and open **Connections → Free cloud models → Keys: backup and restore**.
2. Enter the passphrase and click **Open a backup…**, then pick the file.
3. Tick only the providers you want back and click **Restore selected**. The chosen keys go into Credential Manager; nothing else is imported.

If a key may have leaked, rotate it at the provider and save the new one in Pandesh; also make a fresh backup.

## Git protection

- `.gitignore` excludes credential files, backups (`*.pandesh-keys`, `*.kdbx`) and runtime registry data. `.env.example` holds placeholders only.
- `npm run hooks:install` once per clone enables `.githooks/pre-commit`, which runs `scripts/secret-scan.mjs --staged`. It uses Pandesh's key shapes, plus gitleaks when installed, and blocks a commit that adds a secret without printing it.
- `npm run secrets:scan` scans all history and reports commit, file, line and rule only. It never rewrites history.

## Acceptance scripts

- `node esbuild.core.js && node scripts/acceptance/free-model-registry-acceptance.mjs D:/PandeshFreeModelsAcceptance` runs an isolated Core (own data dir and port, no Ollama) against live upstream data.
- `node scripts/acceptance/credential-vault-acceptance.mjs D:/PandeshFreeModelsAcceptance` uses dummy keys in an isolated `pandesh-acc*` Credential Manager namespace and cleans up after itself.
