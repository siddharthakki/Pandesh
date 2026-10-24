# Contributing to Pandesh

Thanks for helping make a **local-first Windows AI personal assistant** more useful, accessible, and reliable.

**Start here:** [First contributions](docs/CONTRIBUTOR_START_HERE.md) · [Discussions](https://github.com/siddharthakki/Pandesh/discussions) · [Support](SUPPORT.md) · [Roadmap](docs/ROADMAP.md) · [Code of Conduct](CODE_OF_CONDUCT.md).

**Current source status:** the complete audited Core/Desktop source has **not** yet been imported into this public repository. You can already help through documentation pull requests, real-world alpha testing, accessibility reviews, local-model compatibility reports and reproducible bug reports. Core code PRs will begin after audited source publication.

## Where to contribute right now

- **Questions, ideas, show & tell, and model experiences:** use [GitHub Discussions](https://github.com/siddharthakki/Pandesh/discussions).
- **Windows installer, model connectivity, UI or actual task failure:** use [Pandesh_Releases issues](https://github.com/siddharthakki/Pandesh_Releases/issues/new/choose).
- **Docs, architecture, accessibility, source-publication feedback:** use [Pandesh issues](https://github.com/siddharthakki/Pandesh/issues/new/choose).
- **Security vulnerabilities:** follow [SECURITY.md](SECURITY.md) via private vulnerability reporting, never public issues.

## Contributor workflow

We follow a strict, auditable, and security-conscious contribution lifecycle:

```text
Fork repository
  -> Create feature/fix branch
  -> Implement & self-test
  -> Open Pull Request (fill out PR template)
  -> Automated security scanning & isolated checks
  -> Maintainer security & code review
  -> Merged to main by Maintainer
```

Contributors do not receive direct write access to `main`. All changes enter through pull requests.

## Send your first PR

1. Check [good first issues](https://github.com/siddharthakki/Pandesh/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) (e.g. documentation, model compatibility tables, accessibility audits).
2. Fork `siddharthakki/Pandesh` to your personal GitHub account.
3. Create a branch with a descriptive name (`docs/improve-setup-guide`).
4. Make your changes and verify accuracy of markdown, links, and formatting.
5. Open a Pull Request targeting `main`. Complete the PR template checklists.
6. The maintainer will review the diff on GitHub. Re-reviews are triggered on new pushes.

## P0: Security & untrusted code execution boundary

- **We never execute untrusted contributor code on our development Windows PC.**
- No pull request will be pulled down to a maintainer machine or run under a personal environment without thorough diff review.
- Any future execution of tests or builds will occur only on disposable, isolated GitHub-hosted runners with least-privilege tokens, zero secrets, and zero access to personal files, Ollama servers, local disks, or private network services.
- Never add hidden install scripts, network payloads, unverified binary blobs, or unauthorized telemetry.

## After Core source publication

Once the **buildable source** snapshot is published:
- The contribution guide will provide exact `npm ci`, build, and test commands.
- All PR checks will run in isolated GitHub-hosted environments with read-only default tokens.
- Maintainer approval is required before running workflows on forks.
- Protect least-privilege approvals, process-ownership safety, and durable task outcomes.

## Copyright and licensing

Pandesh is licensed under the [MIT License](LICENSE). By submitting a pull request, you confirm that your contribution is your original work (or you have the legal right to submit it) and agree that it will be licensed under the MIT License. Third-party components, fonts, icons, and AI models retain their respective upstream licenses.

## Privacy and conduct

Follow our [Code of Conduct](CODE_OF_CONDUCT.md). Never submit credentials, private personal data, confidential files, or unredacted database contents.
