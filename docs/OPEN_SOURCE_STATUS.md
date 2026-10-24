# Open-source publication checklist

**Checked:** 2026-10-24. **Status: staged; source files are not yet published.**

This file describes the migration from private `siddharthakki/ollama-agent` to the new public `siddharthakki/Pandesh`. The private repository should **remain private**; publishing it directly would expose historic commits and CI configurations.

## Verified in the private release baseline

Source revision: `8166f627a3522493eb129ff8d91a1f164770a112` (v0.1.1 Pandesh alpha).

- Root `LICENSE` contains **MIT**, copyright © 2026 Siddharth Akkinepalli.
- Root `package.json` says `"license": "MIT"`.
- The old source README erroneously says `UNLICENSED`; do not copy it.
- Release snapshot includes code, test suites, media and a large amount of generated evidence/caches.
- Development CI includes a `self-hosted` runner on pull requests. **Never copy that workflow into public CI.**
- One OpenCode adapter uses a static local server password; remediate in the source before accepting it as publication-ready.
- Older review text contains personal Windows user paths. Do not import historical reports, logs or design artifacts without review.
- No obvious plaintext provider keys were found in the subset of files manually inspected. **This is not a comprehensive secrets certification.**

## Outstanding publication gates

- [ ] Export a *fresh tree snapshot*, **without the original commit history**.
- [ ] Remove obsolete experiment/debug scripts, tracked generated caches, local paths and internal planning artifacts.
- [ ] Run a complete Gitleaks scan of the exported source and review findings without posting secrets.
- [ ] Review any previous secret exposure in the **private** repository's history; rotate affected live credentials.
- [ ] Replace the hardcoded OpenCode session password with a random secret and verify that the local API is not exposed insecurely.
- [ ] Review every image, icon, font, voice sample, audio/video file and design asset that will be published; verify provenance and permissions.
- [ ] Confirm build completeness and tests using the sanitized snapshot; do not silently omit required runtime assets.
- [ ] Inventory production dependencies and include all required third-party license and copyright notices.
- [ ] Use only GitHub-hosted sandboxed CI on external pull requests. Restrict or disable old private self-hosted PR jobs.
- [ ] Ensure README, package metadata, `LICENSE`, CONTRIBUTING and SECURITY all agree.
- [ ] Publish sanitized source to this repository, verify no sensitive files are tracked, and *then* mark the source release ready.
- [ ] Link to this code repository from `Pandesh_Releases`, and publish the matching source revision/build information.

## Staging aid

The maintainer can run [`scripts/prepare-public-source.ps1`](../scripts/prepare-public-source.ps1) from **their own Windows computer**, where the original private checkout exists.

The script prepares an **uncommitted review directory** with explicitly selected source file types, excludes old CI/history/artifacts, runs Gitleaks if available, and leaves all uploads to a separate, deliberate reviewed step. **It never pushes or changes visibility.**

It intentionally skips binaries/assets until their redistribution rights are reviewed, so its output is **not presumed buildable**. The maintainer must verify and add only authorized necessary assets and dependencies.

## Release alignment

Public installers and download documentation: [Pandesh_Releases](https://github.com/siddharthakki/Pandesh_Releases). The v0.1.1 installers are already distributed separately; public source snapshots should state what release they correspond to.
