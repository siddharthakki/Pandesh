# Implementation roadmap

**Entry condition for any milestone below: Phase 1 verified complete** (full 19-mission re-run on one clean build with a written verdict, open P0 defects closed or explicitly accepted by the owner) **and this design approved.** Until then only documentation and isolated throwaway prototypes are allowed.

Each milestone: one branch, additive migrations only, feature flag `PANDESH_UI_V2`, existing UI keeps working, real-app acceptance (not unit tests alone).

| M | Scope | Depends on | Acceptance criteria (real installed build, isolated profile) |
|---|---|---|---|
| **2a Foundations** | Event domains `agent/resource/process`; Core activity endpoint replacing host JSON authority; board projection function; React mount + design tokens; new rail/palette shell behind flag | Phase 1 | Kill and restart Core mid-task: activity and board reconstruct identically from Core alone; old UI unaffected with flag off; idle screen = rail + chat only |
| **2b Agents** | `agent_definitions`, `requests/attempts.agentId`, scope gate (exposure + dispatch), 6 built-ins (Chief, Personal, Coding, Research, Operations, Voice-local), handoffs, arbiter, structured results; Agent Team UI | 2a | A Research agent cannot call `write_file` (refusal recorded, not "succeeded"); delegation cannot widen grant (test with crafted brief); 2 concurrent requests → 1 interactive LLM lease, background waits with visible reason; per-agent tool list ≤ 40 tools and local model calls tools correctly |
| **2c Tools & Skills Hub** | Catalog, mapping matrix, connector status, capability tests; Core MCP registry (port), SKILL.md reviewed import | 2b | Mapping matrix matches dispatch behaviour for every agent×tool (automated cross-check); a failing connector shows cause; MCP tool call goes through approval + audit |
| **2d Second Brain** | `knowledge_sources/chunks` + FTS5, source registration via read grants, search/inspector/timeline/2D graph, citation highlighting; optional embeddings behind eval gate | 2a | 5K notes vault: search p95 < 300 ms; graph view never renders > 150 nodes; every edge opens its evidence; forgetting a fact removes it from search and graph; `secret` source never appears in any model prompt (leak scan) |
| **2e Visual Execution** | `execution_processes`, host watchdog, PTY terminal (after dependency approval), preview pane, owned-window placement, takeover | 2b | Kitchen-inventory walkthrough passes end to end; cancel kills only the owned tree (unrelated `node.exe` survives); Core hard kill leaves no orphan Edge/node; no window moved that Pandesh did not open |
| **2f Spaces** | Projects, Media Studio, Wish to Reality (read-only view first), Social Studio drafts desk (no publishing) | 2b, 2d | Nothing can be posted from Social Studio (no outward path exists); Media Studio jobs queue behind the arbiter with reason shown; Wish view marks demo claims |
| **2g Voice polish** | Finish window, barge-in words, mute, speaking-state view, language routing | 2a | Mid-sentence pause test; "stop" interrupts within 300 ms; Wi-Fi-off drill passes |
| **3 Proactive & external** (separate approval) | Standing orders, shadow governor, briefings, Customer Support/Sales/Marketing/Social publishing, Metricool/n8n/Telegram/telephony connectors | 2b–2g + owner authorization per connector | Every outward action has an approval record; shadow policies log ≥ 1 week before activation; costs shown before any paid call |

## Risks

| Risk | Mitigation |
|---|---|
| UI rewrite destabilises daily driver | Flagged, surface-by-surface migration; old renderer remains default until 2f |
| Model latency makes agents feel slow | Honest "thinking" states; fewer tools per agent; small-model routing for classification; no parallel LLM runs on one GPU |
| Scope gate gaps → privilege escalation | Enforce at dispatch (not only exposure); adversarial tests in 2b |
| Second Brain becomes a second memory authority | Chunks/embeddings are derived and rebuildable; facts remain in `memory_facts` |
| New native dependency (`node-pty`) packaging on Windows | Prototype in isolation first; fallback: read-only log tail without PTY |
| Social/sales features drift into unsolicited contact | No outward executor until Phase 3; always-ask approvals; no bulk send |
| Copying third-party designs/code | No AI Workshop code is used (none was obtained); only patterns; licences checked for any imported skill |
| Parallel sessions editing the same tree | Each milestone in its own worktree; reliability branch untouched |
