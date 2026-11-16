# Operator intelligence pass (2026-11-16, branch `feat/operator-intelligence`)

Not merged, not installed. Built on Build 172 (main f579b3e).

## What the audit found

- The lead prompt was long and procedural but had no short statement of *how to decide* (answer, own tool, specialist).
- `delegate_to_agent` could reach only 4 of the 10 specialists; Reviewer had no working method; no agent could work on skills.
- Skills: only the owner's `skills` folder was searched, only by keyword match on the request, and the model could neither search nor read the 10 built-in skills. Built-in "host hooks" (cloud budget etc.) look like skills but are behaviours.
- Keys: the architecture is already right (Windows Credential Manager vault in the host, pushed to Core memory only, passphrase-protected `.pandesh-keys` backup, status() never returns a key). The gap was that the model had no way to ask "is provider X usable?" without guessing.

## Changes

| Area | Change |
|---|---|
| Lead prompt | `HOW YOU DECIDE` block (six lines): answer directly, own tool, specialist, discovery, receipts + one retry, local by default. |
| Specialists | Sharper `workingRules` for chief, coding, research, operations; new rules for reviewer; new **Skill Engineering** specialist (`skills`); shared `SPECIALIST_COMMON_RULES` (receipts, recovery, skills, limits, keys) appended to every specialist prompt. |
| Delegation | `delegate_to_agent` now reaches reviewer and skills. |
| Skills | `find_skill` (built-in + installed, says procedure vs built-in behaviour, needs, why a near match is unusable), `read_skill` reads built-in skills, `propose_skill` saves a *draft* to `skill-proposals/` (never loaded, secrets masked, refuses "skip approval" text). |
| Providers | `provider_readiness`: local runtime + each cloud provider configured yes/no, endpoint host only, chosen free model, routing rules. No key, ever. |
| Offering | Both groups are task-aware (`skills`, `providers`) so a small model pays nothing for them on unrelated requests; specialists always get them. |

## Real check (isolated instance, qwen9b-fixed, one run each)

- greeting: direct answer, no tool, 12.5 s (includes model load)
- skill question: `find_skill`, honest "no specific skill exists", offers to propose one, 8 s
- provider question: `provider_readiness`, correct local/cloud state, no key, 6 s
- "ask the reviewer to check this draft": delegation happened (26 s); verdict first, each claim listed as untraceable

Before the offering fix the same prompts led the model to `memory_recall` / `navigate_to`: the new tools were defined after tool selection ran and were never offered. Fixed in the same branch.

## Not done / limits

- The scratch profile has no cloud keys, so the "configured" branch of `provider_readiness` is covered by a unit test only.
- Skill reuse ("record what worked") is a proposal path, not automatic: nothing is recorded without the model or owner choosing it.
- Implicit routing stays off (see operator-pilot doc): the lead handles simple facts itself.

## Round 2 (same branch): external candidates, layered provider readiness, privacy

- **External skill candidates.** `find_skill` now also reads the owner's *approved local repositories* (`skill-repositories.json` in the data folder lists folders; `skill-repositories/` is read too) when no installed skill fits. Each candidate is reported with provenance (source, content hash, version), trust (always "unreviewed"), license (declared or LICENSE file, classified), dependencies (installs, downloads, scripts, keys, MCP, macOS/Linux-only), Windows/Pandesh compatibility and the directive scanner's result. Public candidates: the specialist reads the maker's page with `web_research` and passes the text to `assess_skill_candidate` (pure analysis). Nothing is downloaded, installed, loaded or run.
- **provider_readiness** answers five separate questions per provider: key configured, endpoint reachable, requested model available, authorized for this task, overall status (ready / unverified / unavailable). Optional `provider`, `model`, `private`. Cloud endpoints are never called to display configuration (a probe would carry the key out without the owner's yes), so cloud reachability and model availability say "unverified" unless the owner's verified free model matches.
- **Privacy / authorization audit of the new tools.** Cloud turns: Core's private-data boundary removes every tool outside `CLOUD_SAFE_TOOLS` both before selection and again after all tools are added, so find/read/propose/assess skill tools cannot run there (they were added after the first partition; the second one catches them). Gap found: Ollama's own `-cloud` models run through the local server and are not `cloudTarget`; the skill tools now check the model name and, on such a model, search built-in skills only, refuse reading the owner's skills and refuse drafts. `ALWAYS_ALLOWED` additions are read-only and carry no key. Residual risk (not enforced in code): a local-model specialist that holds both skill text and `web_research` could put skill text into a query; the per-query approval shows it to the owner and the shared rules forbid it.
- **Proposals.** Every field (id, name, description, body, evidence, source) is masked for secrets, loses the home folder, email addresses, control and zero-width characters, `---` header lines and URL credentials/query; the directive scanner runs over all of it; drafts say `status: draft`, `active: false` and live only in `skill-proposals/`.
