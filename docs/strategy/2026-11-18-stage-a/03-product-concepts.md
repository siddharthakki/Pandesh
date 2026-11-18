# Pandesh — three product directions & recommendation

**Date:** 2026-11-18 · Stage A concept selection. Each concept is evaluated against the same question: **why would someone use this instead of an existing agent product?**

## The strategic premise

The market's unsolved problems are **trust, verification, consent ergonomics, cost, and continuity** — not raw capability (see competitive report, complaints 1–8). Pandesh's existing assets — the enforced permission chokepoint, the evidence/tool ledger, deliverable verification, durable missions, frozen-scope routines — are precisely the substrate for solving those. The product opportunity is to make that substrate *visible and usable*, not to add more capability.

The hierarchy to build toward: **Human goal → Workspace → Tasks → Agents → Tools → Verified results.** The primary unit is a meaningful outcome, not a model conversation.

---

## Concept A — "Verified Delegation" (Mission Control + Proof of Work)

**One line:** *Give your AI team real work, watch it happen, and see exactly what got done — on your own PC.*

The product is a personal operating system for intentions where **every outcome is receipted**. Signature experiences: Mission Control (live, evidence-backed timelines), Outcome Receipts (verified results, not confident claims), Rehearsal (preview exact changes before authorizing), Living Workspaces (continuity), Autonomy Contracts (scoped, revocable delegation).

- **Builds on:** missionRunner, deliverableLedger, claim guards, pcOrganizer (propose→apply→undo), approvals, Auto grants, event ledger. Mostly UX + verification depth on existing rails.
- **Flagship demos:** Demo 1 storage cleanup (pcOrganizer + rehearsal + before/after receipt); Demo 2 price research (research + PC compatibility + Reviewer); Demo 3 small app build (coding mission + tests + receipt).
- **Audience:** privacy-conscious Windows power users with a GPU; developers; the r/localLLaMA / r/selfhosted crowd burned by OpenClaw's security and token burn.
- **Why instead of X:** OpenClaw can't prove what it did and exposes you; Goose is a dev tool, not a personal OS with receipts; Cowork/ChatGPT are cloud + subscription and can't show a local ledger. **Pandesh is the only one that returns a receipt.**
- **Strengths:** leverages the moat directly; answers complaints 1–5,7; Windows-native wedge; demo-able with real work; the ledger already exists.
- **Weaknesses / risks:** verification *depth* (Reviewer judgment) must improve; local-model plan-quality ceiling; requires fixing DRV-010-class writes before the file demo.
- **Effort:** medium. **Risk:** medium (mostly product + verification, not new infrastructure).

## Concept B — "The Self-Maintaining PC" (PC + household autonomy)

**One line:** *The computer that looks after itself — and your household's recurring obligations.*

Focus: PC Workspace + Autonomy Contracts + reliable routines + Mail Hub. Daily verified health reports, contract-gated cleanup, bill/renewal reminders, inbox triage. Demo 1 *is* this product.

- **Builds on:** M3 routines (now reliable), Mail Hub (fresh), pcOrganizer, Bots, briefing.
- **Audience:** non-developer Windows users, families.
- **Why instead of X:** Windows built-ins + Copilot don't do verified, contract-gated, local cleanup with receipts.
- **Strengths:** narrow, shippable; routines are now dependable; Mail Hub is new and real.
- **Weaknesses:** smaller wow-factor; "PC health" alone may not justify adopting a whole app; household needs connectors (family calendars) that don't exist; competes with scripts + Goose; less differentiated.
- **Effort:** low–medium. **Risk:** low technical, **high product** (is the wedge big enough?).

## Concept C — "Local Creation Studio" (Workshop / Studio-led)

**One line:** *Make videos, 3D and images entirely on your PC — with version history and honest cost.*

Focus: the Workshop viewers (Babylon 3D, sim, design-diff, video) + Studio missions. The most visually compelling demos (bedtime video).

- **Builds on:** Workshop (42/46 tests), Studio/narratedVideo, ComfyUI/Piper/FFmpeg.
- **Audience:** creators, hobbyists.
- **Why instead of X:** local-only, no upload, version history, "ran on this PC · no money spent."
- **Strengths:** genuinely differentiated UI; visually astonishing demos.
- **Weaknesses:** **local-model quality ceiling is outside our control** (rabbit missing, biryani wrong); ComfyUI/Piper/FFmpeg install friction; narrow audience; videos are slideshows (no audio/transitions); competes with better cloud tools.
- **Effort:** medium. **Risk:** **high** (quality ceiling + dependency friction).

---

## Evaluation

| Criterion (weight) | A: Verified Delegation | B: Self-Maintaining PC | C: Creation Studio |
|---|---|---|---|
| Uses the existing moat (25%) | ●●●●● | ●●●● | ●● |
| Answers top market complaints (25%) | ●●●●● | ●●● | ●● |
| Differentiation vs competitors (20%) | ●●●●● | ●●● | ●●●● |
| Demo-able with real work (15%) | ●●●●● | ●●●● | ●●●●● |
| Shippable risk / effort (15%) | ●●●● | ●●●●● | ●●● |
| **Weighted** | **4.7** | **3.6** | **3.0** |

## Recommendation: **Concept A**, absorbing B's best parts, keeping C as a surface

Build **Verified Delegation** as the spine:
- **Mission Control + Proof of Work** is the first vertical slice (Stage C), on the file-organization task — including the *failed* scenario, honestly.
- **PC Workspace** (from B) is the first Living Workspace and Demo 1's home; Autonomy Contracts gate its cleanup.
- **Workshop/Studio** (C) stays as a capability surface and a demo, **not the product thesis** — its quality ceiling makes it a poor foundation.

This is the only direction where Pandesh's existing assets *are the product* rather than features, and the only one that answers "why use this instead of X" with a concrete, demonstrable artifact: **the receipt.**

### Rejected alternatives (and why)
- **B as primary:** wedge too small; household connectors absent; folds into A as the first workspace.
- **C as primary:** quality ceiling outside our control; dependency friction; folds into A as a surface.
- **New agent engine / second scheduler / universal sandbox / 3D office / swarm-by-default / autonomous cloud fallback:** no dependable user benefit; reuse Hermes/Core/missions/scheduler (Part 7).
- **v2-only flip now:** viable (attachments landed) but should wait until receipts + onboarding land, so the first-run story is coherent. Recommend making v2 default at Stage C completion.
- **Copying Bot HQ's multi-screen swarm:** demand signal only (10★ repo); default stays one responsible lead + specialist + reviewer, traceable contributions.

## Positioning (to test)

> **Pandesh — Your AI team. Your computer. Your rules.**
> Give your AI agents real work, watch them do it, and see what actually got done — all from your own PC.

Test against: OpenClaw ("runs everywhere" — but exposes you), Goose ("local dev agent" — not personal), Cowork ("agentic files" — cloud, Mac-first, paid). Pandesh's claim is **verifiable local delegation**, and it must never claim guaranteed autonomy, total privacy in cloud configs, or universal app control.