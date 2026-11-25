# Gate 1, Gate 2 and shared JUGAAD services — results (2026-11-20)

Branch `feat/stage-c-vertical-slice`, dev only. Nothing merged, nothing deployed, production untouched. Evidence ran on the isolated dev
Pandesh (`D:\PandeshAcceptDev`, Core :4412, phone sync :47831, own profile) with the real Chrome extension.

## Gate 1 — project-aware workspace resolution
- `core/domain/projectRegistry.ts`: an owner-authorised registry (`<dataDir>/projects.json`): canonical paths, repository identity
  (root commit), capabilities, preferred agents, access (`read` / `read-write`). Only the Pandesh app registers (host-only
  `/v1/bridge/projects`). No discovery, no scan, no "open workspace" default.
- `resolveProject`: a path inside exactly one project -> that project; a path in none -> `unauthorized` (asked, never searched);
  two projects -> `ambiguous` (asked); a bare name only counts together with code words ("repo", "tests", "branch"...). The product name in
  "ask Pandesh for my brief" is not a repository reference.
- Dispatch enforces it: ambiguous/unauthorised/read-only-vs-write/missing branch all stop with a question on the task card, nothing
  is cloned, no permission is widened.
- Live: the acceptance sentence resolved to `Pandesh` (via path, ref `feat/stage-c-vertical-slice`, read-only requested).

## Gate 2 — ChatGPT -> Panda Bridge -> Pandesh -> Claude Code (real run)
Task text exactly as specified, typed in real ChatGPT, relayed by the real extension to the dev Core (`ptask_8244ba56…`).

| Item | Actual |
|---|---|
| Executor | `claude` (Claude Code via Kandev ACP), `routing: explicit`; no Qwen/OpenCode/other substituted |
| Consent | refused without host consent (`external_consent_required`), then allowed with host consent `externalTransfer:true` |
| Workspace | private clone of `feat/stage-c-vertical-slice` @ `d4d6570`, no remote; owner checkout never given to the agent |
| Session evidence | 28 commands recorded (vitest runs, grep, head, find ...); Kandev task `c2a54e20…`, session `1486807e…` |
| Tests it ran | `npx vitest run core/test/routing.test.ts core/test/deterministicRouting.test.ts core/test/taskToolSurface.test.ts core/test/mutationIntentGovernanceMatrix.test.ts src/test/suite/mutationIntentBoundary.test.ts` -> 5 files / 220 tests passed (as reported by the worker) |
| Defects reported | none (worker-only; labelled "not independently verified") |
| Read-only proof | KKD: no change in the agent's copy; every write and every path outside the copy refused by policy (1 read of the owner path was held and rejected) |
| Report delivery | card "completed" in ChatGPT -> "Send report to ChatGPT" -> preview -> inserted into the composer, paths redacted (`<path>`), not sent |

### Integration gaps found and fixed (existing agent infrastructure only)
1. ACP executors could only run isolated "write code + tests + integrate" stories in an empty repo: no way to inspect an authorised project.
   Fixed: story `mode: 'inspect'` (devStories) — private clone, read-only policy (writes rejected, reads confined to the copy), completion
   without a diff, report = the worker's last message, `level=worker-only`.
2. The task text names the owner's path; the agent tried to read it (held by policy). Fixed: prompt + policy now say "your working directory is the copy".
3. Source-checkout fingerprint wrongly blocked the task because the owner (me) edited the repo meanwhile. Fixed: reported, not blamed; only changes inside the copy block.
4. `verify-existing` could not accept an inspection (no changed files). Fixed for inspect stories.
5. Browser report truncated the findings (700-char cap, commands before report). Fixed: evidence order (report first) and a 5000-char
   room for inspections in `content.js` (needs the extension reloaded).

### Open gap (needs a decision) — selecting Claude Code from the browser
The browser dropdown cannot select Claude Code and no Pandesh screen can approve and start an external bridge task: by design the browser can
never grant an external transfer ("Approve the transfer for this task in Pandesh"), but Pandesh has **no UI for that approval**; only the host API
does. For this acceptance the owner-authorised run used the host API (`consent.externalTransfer:true`). Proposed fix: a "Bridge tasks" approval card in
Pandesh (renderer) that shows task, executor, what leaves the PC, then dispatches with host consent. Not built.

## Shared JUGAAD services
Built on the existing companion channel (TLS pinned, per-device key, nonce replay protection), Panda bridge lifecycle, capability registry, permissions.
- `core/runtime/jugaad/households.ts`: households are hard boundaries (own folder, own SQLite index, own upload staging); a phone belongs to
  exactly one; host-only attach (`/v1/jugaad/*`). The household always comes from the device, never from a parameter.
- `jugaadGateway.ts` (rpc `household.info, doc.put, doc.status, doc.search, doc.list, doc.get, tasks.recent`).
- `uploads.ts`: resumable chunked upload; server offset is the truth; SHA-256 verified; dedupe by content (index and inbox); 25 MB / 64 KB chunk / 20 open uploads / 24 h sweep.
- `documentIntake.ts` + service `jugaad.ingest` (internal: not advertised to browsers, not startable by one): hash -> detect (signature table + Magika) -> text
  (PDF text layer, else OCR; images OCR; plain text) -> receipt/invoice fields (rule parser, `receiptParser.ts`) -> FTS5 index -> phone `document_ref` + `task_status` records (household-scoped ids).
- Sync: pull cursor advances over other households' records, which a phone never receives. Offline: resume, replay-safe.
- Local only; no model, no cloud step, no external executor reachable from this path (`authority:'host'` without consent). Tailscale unchanged (status-only).

### Live end-to-end (real TLS protocol, real DPAPI vault, two paired phones, two households)
- PDF (text layer) -> Telekom, 2026-11-02, 1 234,56 EUR, RE-2026-88123; text -> REWE 3,68 EUR; PNG photo -> OCR (tesseract) EDEKA 12,00 EUR (labelled worker-only);
  binary -> stored, indexed by name, "no text extractor".
- Search `coffee` finds only the OCR'd photo; `mobilfunk` finds the PDF.
- Offline: 440 KB upload dropped after 3 chunks; phone resumed at the server's offset 120000 and completed; same file again -> duplicate.
- Isolation: the second household's phone saw 0 documents, 0 search hits, `task not found`, `document not found`, 0 household records in sync; the first saw its 10.
- Defects found by the live run and fixed: long statements truncated before the total (74,50 instead of 948,70); duplicate detected only after
  the first copy finished indexing; CRLF in snippets; task origin shown as "ChatGPT" in the host feed.

## Known limits / not done
- No "reprocess" of an already indexed document when the parser improves (the old record keeps its fields). Needs a host route.
- OCR language is English only (German traineddata not installed): digits and amounts read fine, German words may not.
- Legacy (unscoped) companion records (important dates, briefings) are still shared by all phones of this Pandesh; only new JUGAAD records are household-scoped.
- No JUGAAD Android changes were made; the phone side was simulated with the real protocol.
- No production deployment; no release review done for these commits.
