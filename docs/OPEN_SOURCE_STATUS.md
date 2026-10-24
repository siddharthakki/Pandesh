# Open-source publication checklist

**Checked:** 2026-10-24. **Status: public documentation and media live; actual Core/Desktop source still pending audited publication.**

This file describes the migration from private `siddharthakki/ollama-agent` to the new public `siddharthakki/Pandesh`. The private repository should **remain private**; publishing it directly would expose historic commits and CI configurations.

## Verified in the private release baseline

Source revision: `8166f627a3522493eb129ff8d91a1f164770a112` (v0.1.1 Pandesh alpha).

- Root `LICENSE` contains **MIT**, copyright © 2026 Siddharth Akkinepalli.
- Root `package.json` says `"license": "MIT"`.
- The old source README erroneously says `UNLICENSED`; do not copy it.
- Release snapshot includes code, test suites, media and a large amount of generated evidence/caches.
- The private repository's former self-hosted pull-request CI has been replaced with `ubuntu-latest` on `master` and `release/pandesh-alpha` (2026-10-24). The Windows guardian already uses `windows-latest`. **The old local runner still needs deregistration and any auto-start service/Windows Task Scheduler entry disabled.** Do not reintroduce the historical WSL-hosted workflow.
- The OpenCode adapter uses a reusable local server password in the released baseline. A **draft, unmerged** security change is under review in the private development repository (PR #78); functional and packaged acceptance are still required.
- Older review text contains personal Windows user paths. Do not import historical reports, logs or design artifacts without review.
- No obvious plaintext provider keys were found in the subset of files manually inspected. **This is not a comprehensive secrets certification.**

## Outstanding publication gates

- [ ] Export a *fresh tree snapshot*, **without the original commit history**.
- [ ] Remove obsolete experiment/debug scripts, tracked generated caches, local paths and internal planning artifacts.
- [ ] Run a complete Gitleaks scan of the exported source and review findings without posting secrets.
- [ ] Review any previous secret exposure in the **private** repository's history; rotate affected live credentials.
- [ ] Merge **after tests** [OpenCode session credential hardening (private PR #78)](https://github.com/siddharthakki/ollama-agent/pull/78) and verify that the local API is not exposed insecurely. (Link requires private repository access.)
- [ ] Review every image, icon, font, voice sample, audio/video file and design asset that will be published; verify provenance and permissions.
- [ ] Confirm build completeness and tests using the sanitized snapshot; do not silently omit required runtime assets.
- [ ] Inventory production dependencies and include all required third-party license and copyright notices.
- [x] Replace the old self-hosted PR workflow with GitHub-hosted `ubuntu-latest` and keep product guardian on `windows-latest`.
- [ ] Deregister the old runner in the private GitHub repository and disable its Windows/WSL auto-start tasks/services. No GitHub workflow presently requests it.
- [ ] Ensure README, package metadata, `LICENSE`, CONTRIBUTING and SECURITY all agree.
- [ ] Publish sanitized source to this repository, verify no sensitive files are tracked, and *then* mark the source release ready.
- [x] Link to this code repository from `Pandesh_Releases`, and clearly label development-preview screenshots versus released installer builds.
- [x] Publish six gallery screenshots in both public repositories, source architecture diagrams, privacy notes and prioritized roadmap.
- [x] Prepare an SEO-focused static landing page under `docs/index.html` (GitHub Pages deployment still requires maintainer setup).
- [ ] Publish matching buildable source revision and verify release correspondence.

## Staging aid

The maintainer can run [`scripts/prepare-public-source.ps1`](../scripts/prepare-public-source.ps1) from **their own Windows computer**, where the original private checkout exists.

The script prepares an **uncommitted review directory** with explicitly selected source file types, excludes old CI/history/artifacts, runs Gitleaks if available, and leaves all uploads to a separate, deliberate reviewed step. **It never pushes or changes visibility.**

It intentionally skips binaries/assets until their redistribution rights are reviewed, so its output is **not presumed buildable**. The maintainer must verify and add only authorized necessary assets and dependencies.

## Release alignment

Public installers and download documentation: [Pandesh_Releases](https://github.com/siddharthakki/Pandesh_Releases). The v0.1.1 installers are already distributed separately; public source snapshots should state what release they correspond to.

## Current tracked work

- [Public source publication issue](https://github.com/siddharthakki/Pandesh/issues/1) — consolidated outstanding gates.
- [Architecture](ARCHITECTURE.md), [roadmap](ROADMAP.md) and [gallery](SCREENSHOTS.md) are available now.
- [Windows alpha releases](https://github.com/siddharthakki/Pandesh_Releases/releases) remain independent of source-publication status.
