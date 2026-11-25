# ChatGPT connector qualification: isolated Build 188 test package (NOT installed, NOT deployed)

## Build
- Branch `release/b188-connector-test` (worktree `D:\PandeshRelease188c`) = Build 188 candidate `d1b94da` + cherry-picks of the dev-branch connector commits.
- **Exact commit: `94b4272f878c308ef219b4975c50135dd4396725`** (dev-branch equivalents: gateway 05a5804, TLS 7e56416, CSP 5ae8f91, supervisor dfc6652, DPAPI/package 3abe1a3, refresh fix 6012356).
- Built 2026-11-21 ~13:00: package OK, package-smoke OK (62 s), installer staging OK (3001 files, identity b188, commit 94b4272). Start-at-login entry unchanged before/after. Production not touched.
- Artifacts: portable `D:\PandeshRelease188c\dist\pandesh-win32-x64`, staged payload `D:\PandeshRelease188c\dist\pandesh-installer-staging`. Scripts `D:\PandeshAssistantDev\rel188c`.

## Changes
1. Gateway pairing tokens are DPAPI-protected (CurrentUser, Pandesh entropy) at rest; fail-closed; legacy plaintext is read but converted only by an explicit `node server.mjs --migrate-state`; a corrupted/foreign blob drops that pairing and the gateway still starts.
2. A refresh asks Core first and forgets a revoked pairing (also for grants never used again).
3. The gateway ships in the package (`components/mcp-gateway/server.mjs`), listed in `build-fingerprint.json` and the updater's regenerated fingerprint; the host runs it only when its SHA-256 matches, with no fallback to a workspace path inside a package.
4. `tunnel-client.exe` is approved by SHA-256 when set up; a changed file is refused until the setup is saved again.
5. Startup order: gateway -> certificate pin -> Pandesh Core answering -> tunnel (retries while Core is down).
6. Card: Start/Stop, Core/build ("TEST COPY"), tunnel state, last failure, recent redacted log, gateway source.

## Evidence
- Unit/regression: desktop suite 1007 passed (incl. 16 connector tests); gateway state tests 5/5 (encryption at rest, restart, legacy unchanged, explicit migration, revocation incl. unused stale grant, corrupted blob).
- Packaged-build qualification (`scripts/acceptance/chatgpt-connector-package-qualification.mjs`, isolated profile `D:\PandeshB188cAccept`, Core 3964, connector ports 4983-4985, dummy key in a separate Credential Manager namespace, since deleted): **24/24**
  - phase 1 (16): connector starts by itself with the host; startup order from the log; packaged gateway verified; Core/build shown as isolated; key only a masked hint; failure of the dummy key visible; pairing code from the app's own IPC; OAuth + PKCE; token DPAPI-protected on disk; 5 tools, no approve tool; list_agents; a read-only OpenCode task submitted through the connector reaches `completed` with a retrievable report (Pandesh's own check: nothing changed); a Claude Code task waits for the owner and is cancellable.
  - phase 2 (8): host restart -> connector back by itself; old access token gone; pairing survives (DPAPI state reopened); recovered session works; revocation in Pandesh cuts access; refresh cannot revive it; the grant is removed from the state file.
- Shutdown: stopping the host released every connector port.

## Not verified / blockers
- Real ChatGPT and the real tunnel (needs the owner's new Tunnels Read+Use key; only the real `tunnel-client` failing with a dummy key was exercised). Network-interruption test not run.
- Windows start-at-login: not testable without writing the registry; the existing entry still points at `E:\Pandesh`. Verified only that the connector starts when Pandesh starts.
- The Allow / Don't allow card was not exercised visually (gate verified through the connector API).
- Claude Code model/effort selection does not exist yet (gateway passes no model; no effort setting).
- Native agent cannot be confined to a project: read-only inspection of a project goes through OpenCode/Claude Code.
- Port 3030 was served by a staging Build 188 on the real profile (the owner confirmed it was them); at close it was no longer running.

## Rollback
Nothing is installed. Remove the test package: `git worktree remove D:\PandeshRelease188c`, delete branch `release/b188-connector-test`, delete `D:\PandeshB188cAccept`. The old launcher, tunnel, gateway and pairing were never changed. Switchover steps and the real-ChatGPT checklist: `CHATGPT_ACCEPTANCE_CHECKLIST.md`.
