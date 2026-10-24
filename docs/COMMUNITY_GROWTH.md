# Pandesh community growth and outreach playbook

**Goal:** Find genuine users of local AI on Windows, learn from reproducible feedback, and gradually attract contributors to an MIT-licensed local-first AI assistant. This is an organic, technical community plan—not paid-ad or engagement-farming instructions.

## What is available today?

- **Public Windows download:** [v0.1.1 Alpha, Build 142](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha).
- **Build 143 screenshots:** [Actual updated application interface](SCREENSHOTS.md). This build includes reported New Conversation and Results navigation fixes, but its binaries are not yet uploaded to the public release.
- **Public source repository:** MIT license, screenshots, architecture, docs, issues and contribution guidelines; **audited Core source is not yet published**.
- **First contribution paths:** [Windows/Ollama setup issue #2](https://github.com/siddharthakki/Pandesh/issues/2) and [model compatibility issue #3](https://github.com/siddharthakki/Pandesh/issues/3), both tagged `good first issue`.

Do not market the source as complete, claim the patched build is downloadable before it is, or claim a generated result is independent proof of tool execution.

## First three priorities

1. **Fix GitHub discovery:** In each repository's About panel, set a concise description and repository topics; see [Launch checklist](LAUNCH_CHECKLIST.md). They are currently empty and GitHub cannot categorize the project properly. Enable GitHub Discussions in the source repository to collect questions and ideas.
2. **Make the download match the screenshots:** publish a *separate versioned* verified Build 143 installer/portable release only when packaged acceptance and SHA-256 checks are complete. Record version, model, and verification conditions accurately.
3. **Open the actual Core source:** pass the [publication gates](OPEN_SOURCE_STATUS.md); then offer build instructions and focused code issues people can work on.

## Positioning that sets realistic expectations

**One-liner:** "Pandesh is a local-first Windows AI personal assistant powered by Ollama, with a lightweight Panda interface, task tracking and explicit approval for consequential actions."

**Why users may care:** you can choose models hosted on your own PC, see task results, and give permission to supported actions. External integrations are optional and require their own authorization.

**Honest limitations:** alpha-quality reliability, Windows-only public packages, unsigned installer, optional connectors can fail when permission is missing, and currently published binaries differ from newer screenshots.

Avoid unsupported claims such as "100% private", "fully autonomous", "works with every model", "all your AI apps replaced", "guaranteed safe", and "complete open source" until the supporting behavior and code are public.

## Who to reach and where

| Audience | Place | Useful angle | Guardrail |
| --- | --- | --- | --- |
| Local LLM builders | [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/) | Exact Windows/RTX GPU and Ollama setup, model behavior, verified local tasks, what failed | Respect the subreddit's rules on self-promotion and LLM-generated posts. Participate genuinely; no canned generated launch posts |
| Ollama users | [r/ollama](https://www.reddit.com/r/ollama/) | Desktop integration and easy first-run steps | Check current subreddit rules before posting |
| Self-hosting enthusiasts | [r/selfhosted](https://www.reddit.com/r/selfhosted/) | Local-first assistant and explicit data/network boundaries | The product is Windows alpha, not proven production-ready; check promotion rules |
| Developers | [GitHub](https://github.com/siddharthakki/Pandesh) | Architecture diagram, MIT licensing, real beginner issues, build reproducibility | Do not claim Core source is public before it lands |
| Technical early adopters | [Hacker News Show HN](https://news.ycombinator.com/showhn.html) | Personal motivation, a working downloadable demo and learned security lessons | Wait for a matched patched release and source clarity. HN explicitly discourages AI-written or automated submissions; personally write the story |
| Developers & makers | [DEV Community](https://dev.to/) | Deep technical build log: process ownership, model routing, approvals and failures | Publish useful technical substance, not just an ad |
| Professional connections | LinkedIn, relevant communities | Short screen recording with actual behavior and candid limitations | Real first-hand experience, no mass unsolicited DMs |

The moderators and platform rules are authoritative; do not cross-post identical ads or artificially solicit stars, votes or reviews.

## Fourteen-day approach

**Days 1–3 — discoverability and trust:** Update repository descriptions/topics, enable Discussions, link the contributing guide, publish Build 143 only after verified packaging, and record a clean 60–90-second walkthrough of *real* tool output.

**Days 4–7 — authentic early feedback:** Ask 5–10 relevant Windows/Ollama users for one concrete tested scenario. Offer the public issue forms, not a private spreadsheet. Answer reports quickly, publish known limitations, and prioritize the top three reproducible bugs.

**Days 8–10 — technical explanation:** Publish a first-person engineering article or short video explaining *one* hard problem solved (e.g., safe process ownership or reliable blank new conversations) with limitations and reproducible evidence.

**Days 11–14 — community launch:** Once the public code snapshot is usable and the patched binary matches demos, consider a personally written Show HN and a community-appropriate post wherever rules allow. Share the direct source and release links, answer questions and incorporate feedback.

This sequence is a suggested cadence, not a promised release schedule.

## Content assets needed

- **Landing page:** `docs/index.html` (prepared; enable GitHub Pages)
- **Six updated screenshots:** already on both public GitHub repositories
- **90-second real app demo:** not yet uploaded
- **One factual developer deep dive:** start with design tradeoffs and the approval/process-safety boundary
- **A verified compatibility report:** GPU/VRAM, exact model tag, Ollama version, speed if measured, tool success and failure conditions
- **An honestly labeled v0.1.2 release:** with installer, portable ZIP, SHA-256 and changes, once ready

## Lightweight community measures

Check once a week: unique users providing reproducible feedback, open versus resolved bug reports, actual external pull requests, model compatibility reports, installation blockers and installer downloads. Use GitHub's own download counts/traffic where available. Stars are a side effect—not the primary outcome.

Never buy stars, solicit votes, create fake testimonials or claim synthetic demo responses are verified live results.

## Suggested outreach snippets

**LinkedIn (rewrite in your own voice and include a real screenshot):**

> I've been building Pandesh, a local-first Windows AI assistant using Ollama. My goal is an assistant that doesn't just talk, but handles supported tasks with visible approvals and verifiable results. The first public alpha is available, and I'm looking for Windows/Ollama users willing to try one real scenario and report what works or breaks. The Core source is being prepared for an audited MIT release; documentation and compatibility contributions are welcome already. Project: https://github.com/siddharthakki/Pandesh

**Short social caption:**

> Meet Pandesh 🐼 — a local-first AI assistant for Windows, powered by Ollama. The free public alpha is live. Try it, report a real-world bug, or help with docs and model compatibility: https://github.com/siddharthakki/Pandesh

**Technical article idea:** "Building a local AI desktop assistant without terminating unrelated Windows processes: lessons from Pandesh's first public alpha."

**For Reddit and Hacker News:** Use your own firsthand writing, technical detail, meaningful limitations and the platform's current rules. Do not paste generated promotional copy where AI-generated submissions are restricted.

[First contributions](CONTRIBUTOR_START_HERE.md) · [Getting started](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/GETTING_STARTED.md) · [Source status](OPEN_SOURCE_STATUS.md)
