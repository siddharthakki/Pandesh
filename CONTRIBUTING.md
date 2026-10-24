# Contributing to Pandesh

Thanks for helping make a **local-first Windows AI personal assistant** more useful and reliable.

**Start here:** [First contributions](docs/CONTRIBUTOR_START_HERE.md) · [Support](SUPPORT.md) · [Roadmap](docs/ROADMAP.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

**Current source status:** the complete audited Core/Desktop source has **not** yet been imported. You can already help through documentation pull requests, real-world alpha testing, accessibility review, local-model compatibility reports and reproducible bugs. Core code PRs will become practical after source publication.

## Where to contribute

- **Windows installer, model connectivity, UI or actual task failure:** use [Pandesh_Releases issues](https://github.com/siddharthakki/Pandesh_Releases/issues/new/choose).
- **Docs, architecture explanation, source-publication feedback or future contribution proposals:** use [Pandesh issues](https://github.com/siddharthakki/Pandesh/issues/new/choose).
- **Questions:** use GitHub Discussions when the maintainer enables it; until then a concise issue is acceptable if action is needed.
- **Security concerns:** follow [SECURITY.md](SECURITY.md), not a public bug report.

## Send your first documentation PR

1. Check [good beginner tasks](docs/CONTRIBUTOR_START_HERE.md) or open a focused issue.
2. Fork `siddharthakki/Pandesh`.
3. Create a branch, make a small Markdown change, and confirm links/instructions are accurate.
4. Open a PR to `main`, describing the user problem, the change and what you verified.
5. Expect review. Don't silently change release checksums, license declarations, acceptance claims, or model safety policies.

## After code publication

Once the **buildable source** is available, contributors will use the same fork/branch/PR flow with documented `npm ci`, build and test commands. Pull requests must run **on GitHub-hosted runners only**. We do not execute untrusted public PRs on a personal machine.

Protect least-privilege approvals, process-ownership safety and durable task outcomes. Changes affecting execution of host processes, external communication or file mutation require explicit tests and reviewer scrutiny.

## Copyright and licensing

The project's own code is [MIT-licensed](LICENSE). By submitting, you confirm that you have the rights to your contribution and agree it can be distributed under MIT. **Upstream projects, fonts, audio, icons, images and AI model weights retain separate licenses**; include required attribution and do not copy proprietary assets or private files.

## Privacy and conduct

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Only post synthetic or appropriately redacted diagnostics; never upload credentials, full databases, private emails/calendars, or unreviewed screen recordings.
