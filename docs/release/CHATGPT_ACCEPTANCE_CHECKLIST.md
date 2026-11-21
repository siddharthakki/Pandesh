# ChatGPT connector: real-ChatGPT acceptance checklist and controlled switchover

Nothing here runs until the owner says so. Production Build 187 (`E:\Pandesh`), the live tunnel and the live pairing stay as they are until step S5.

## A. Port owners today (read-only facts, 2026-11-21 ~13:35)

| Port | Owner (pid) | Belongs to |
|---|---|---|
| 3975 | `tunnel-client.exe` (58528) | the OLD launcher: its parent is the launcher's PowerShell (15836, window opened from cmd 33448) |
| 3973 / 3974 | `node.exe` gateway (47196) | the OLD connector path: started by the assistant to replace the launcher's gateway (the launcher's own gateway was replaced after the CSP fix); not a child of the launcher |
| 3961/3962/9483 | isolated Build 188 (host 46468, Core 25252) | the isolated test instance the live gateway talks to (Core 3962) |
| 3030 | `electron.exe` (7280) from `D:\PandeshRelease188\dist\pandesh-installer-staging` | **NOT `E:\Pandesh`.** A Build 188 staging payload was started at 13:13 today on the real profile (`C:\Users\siddh\AppData\Local\KarkeDikha\desktop`). The assistant did not start it. See the report. |

### How to stop ONLY the old launcher's processes (do this yourself, in this order)
1. In the launcher's PowerShell window press Ctrl+C. Its `finally` block stops the tunnel-client and its own (already replaced) gateway; it does not stop the isolated Build 188 because it did not start it.
2. Confirm port 3975 is free: `Get-NetTCPConnection -State Listen -LocalPort 3975 -ErrorAction SilentlyContinue` (no output = free).
3. Stop the replacement gateway (pid 47196 only; verify first that it is `node.exe ...\mcp-gateway\server.mjs`):
   `Get-CimInstance Win32_Process -Filter "ProcessId=47196" | Select CommandLine` then `Stop-Process -Id 47196`.
4. Leave 3030 (Pandesh) and 3961/3962 (isolated Build 188) alone. Ports 3973-3975 must now be free before the new connector starts.
Never use `Stop-Process -Name node` or `-Name electron`: other Pandesh and Claude processes share those names.

## S. Controlled switchover (each step needs the owner's explicit go)
- S1. Revoke the old OpenAI key in the dashboard; create a key with only Tunnels: Read + Use.
- S2. Stop the old launcher processes (section A). The existing ChatGPT pairing keeps working afterwards only if the gateway state file is read again: the new gateway reads `mcp-gateway.json` as a legacy plaintext file and does NOT migrate it.
- S3. In the new Build 188 test package (isolated profile): Connections -> ChatGPT: enter tunnel id and tunnel-client path, paste the key, Store key, Start.
- S4. Run the acceptance checklist (section B). Rollback if anything fails (section C).
- S5. Only then, separately: protect the live pairing (`node components/mcp-gateway/server.mjs --migrate-state`, the owner runs it, with the gateway stopped), and decide about installing into `E:\Pandesh`.

## B. Real-ChatGPT acceptance checklist (the owner types these into ChatGPT)
Each item: what to do, expected result, evidence to keep.
1. Connection: ChatGPT -> "@Pandesh say hello". Expect a reachable reply naming the agents. Card shows Running, Core answering (isolated build, TEST COPY).
2. List agents: "Ask Pandesh which agents it can use." Expect the five-tool set; Claude Code listed as cloud, needs your approval.
3. Native read-only task: "Ask Pandesh to list the files in D:\\PandeshB188cAccept (read only), then show me the report." Expect: a task id, status completed, a report with the listing, nothing changed. Evidence: task id, report text, Pandesh Missions entry.
4. Cloud gate: "Ask Pandesh to run a read-only Claude Code task: say hello." Expect: ChatGPT says it is waiting for your approval; **nothing runs**; the Pandesh Missions dock shows an Allow / Don't allow card naming Claude Code and what would be sent. Press Don't allow once (expect refusal, task ends), then repeat and press Allow (expect the task to run and the report to return). Evidence: both card states, `bridge_task_checkpoints` audit rows.
   - **Result 2026-11-21 (isolated B188c): PARTIAL.** Card and Allow worked; Claude ran and answered exactly (13:49:54, `ptask_509b…`). The task then ended `needs_attention`: a no-project task is verified as a code change, and "the worker made no changes" failed it 3 times. Open: audit A1 (answer-only tasks use inspection acceptance). Don't allow: not yet exercised.
   - Note: the first Claude attempt (13:40) failed because the borrowed Claude sign-in had expired; opening Claude Code once fixed it.
5. The pending Claude Code task: re-submit the earlier Claude Code task (the incorrect `completed` status bug) as read-only analysis first; confirm the card text matches what was submitted.
   - **Result 2026-11-21: FAILED at workspace and verification, not at launch.**
     - The coding task `ptask_a38e…` (14:04) was given an empty scratch workspace, because no Pandesh source project is registered in this instance.
     - Claude found no code and refused to make up a diff, which was correct.
     - Verification failed 3 times in 60 s, and Claude's explanation was not in the report.
   - The follow-up `ptask_c698…` (14:16) has been stuck since 14:17 on 3 worker-action approvals (Find outside the worktree, correctly held by policy). There is no desktop button to answer them; the phone app has one.
   - `ptask_2f8a…` (14:19) is still waiting for a worker slot.
   - Open: audit A2, A3, A4, C2, and the owner decision A5 (bridge writes to a registered project). Details in `docs/audit/2026-11-21/KANDEV_TO_UI_AUDIT.md` §5.
5a. OpenCode read-only inspection through ChatGPT. **PASS 2026-11-21**, 3 runs (`ptask_701e…`, `ptask_4d2b…`, `ptask_5a97…`): KKD confirmed nothing changed, and the report returned to ChatGPT, labelled worker-only. Cancel from ChatGPT also worked (`ptask_9ba2…`).
6. Model / effort selection: **not a prerequisite** (owner, 2026-11-21). Claude Code runs on its installed CLI with the existing subscription sign-in and its defaults (Kandev profile default `sonnet`, `KARKEDIKHA_KANDEV_CLAUDE_MODEL`). Optional later: pass `model`/`effort` through `pandesh_submit_task` and show them on the card.
7. Restart recovery: quit and reopen Pandesh. Without touching ChatGPT's connector, ask "@Pandesh hello" again. Expect it to work (the session refreshes from the DPAPI-protected pairing). Card shows the same Core and the last-failure line.
8. Failure recovery: turn off Wi-Fi for ~60 s, turn it on. Expect the card to show Not connected, then Running again with no click; the log shows bounded restarts, no loop.
9. Revocation: Disconnect ChatGPT in the card. Expect ChatGPT's next call to fail and the connector to be off. Reconnect with a fresh pairing code.
10. Privacy: confirm the key is not visible anywhere (card, logs, Task Manager command lines).

## C. Rollback
- The old launcher and old gateway are untouched until S2; if S3-S4 fail, stop the new connector (card Stop), then start the old launcher as before: `powershell -NoProfile -ExecutionPolicy Bypass -File D:\PandeshTunnel\start-chatgpt-connector.ps1 -TunnelId <tunnel id>`.
- The new test package lives in `D:\PandeshRelease188c`; remove it with `git worktree remove D:\PandeshRelease188c` and delete branch `release/b188-connector-test`. Its profile `D:\PandeshB188cAccept` is separate and can be deleted.
- Production (`E:\Pandesh`, Build 187) and its rollback `E:\Pandesh-b186-rollback` are not touched by any of this.

## D. After reliability is established
Stop expanding the connector. The demonstration that matters: ChatGPT asks Pandesh to fix the incorrect `completed` task status with Claude Code; the approval card appears; Claude executes; the test evidence is reviewed in Pandesh.

Status 2026-11-21: approval and Claude execution are proven. The fix itself cannot run from the bridge yet: tasks that change a registered project are refused by design (`core/runtime/kandev/pandaBridge.ts:252`), and an unregistered project silently gets an empty workspace. That needs audit items A2 and A5 (owner policy decision) first.
