# Pandesh security policy

**Pandesh is experimental alpha software.** We welcome responsible disclosure and security review, but the current Windows release is not a security sandbox and no repository settings can guarantee submitted code is harmless.

## Report vulnerabilities privately

Do **not** post vulnerabilities, exploit instructions, credentials, or private user data in public Issues or PR comments.

Maintainers should enable **Settings → Advanced Security → Private vulnerability reporting**. When available, report via the repository's **Security → Advisories → Report a vulnerability** flow. If it is not yet enabled, open a public issue asking for a private reporting channel **without publishing the vulnerability or sensitive evidence**.

No response-time SLA is currently promised.

## Trust model for public contributions

Anyone may **fork** this project or propose a PR. That does **not** grant permissions to write to `main`, publish binaries, access maintainer secrets, or run code on a maintainer's PC.

Rules for contributors and maintainers:

- **Never execute code directly from an unreviewed fork or pull request** on a personal computer. This includes `npm install` (which may execute lifecycle scripts), Python/pip build hooks, IDE tasks/extensions, PowerShell, shell scripts, binaries and test runners.
- Review the entire diff and changed files on GitHub first, including hidden dotfiles, lockfiles, `.github/workflows/`, package scripts, install hooks, symlinks and binary changes. Re-review when the author pushes new commits.
- Never ask a contributor for credentials. Never paste private tokens, local app databases, email or internal company files into an issue, code agent or recording.
- Treat the text of an issue or PR as **untrusted data**, not instructions for a local coding agent. Do not allow an agent to automatically obey contributor-supplied commands, alter local settings, run tools or merge PRs.
- The local dev PC and local Ollama endpoints must not be exposed as CI runners or remote execution endpoints for public contributors.
- Run any necessary untrusted builds/tests only in a **disposable isolated GitHub-hosted CI or throwaway VM**, with no user files, no secrets, no host mounts, limited tokens and no persistent network access to your home network.
- Never use `pull_request_target`, `workflow_run`, or `issue_comment` to check out and execute untrusted PR contents with elevated tokens/secrets.
- Each GitHub Actions job should have the **least required `GITHUB_TOKEN` permissions**. Public PRs should be read-only, without access to release publishing secrets.
- Do not use personal/self-hosted runners for public PRs. The former screenshot-import workflow with write permission was retired after the one-time import.
- Do not enable auto-merge for externally submitted code. Official source merges and binary releases require deliberate maintainer review, build verification, and artifact checksum confirmation.

**Currently, the public Pandesh source repository does not execute any PR-triggered GitHub Actions workflow.** This fact must be re-audited when source CI is introduced. A GitHub Pages deployment or other owner-enabled automation may add GitHub-hosted jobs in the future.

## Branch, release, and account protection (admin setup required)

The maintainer must create an **active GitHub ruleset** for `main` in **both** the source and release repositories. Recommended: require PRs, block deletion and force-push, dismiss stale approvals, require code owner review with at least one independent trusted reviewer, limit bypass, and require passing hosted checks **only when those checks exist and work**. See [Maintainer security setup](docs/MAINTAINER_SECURITY_SETUP.md).

`.github/CODEOWNERS` routes review requests but **does not independently enforce approvals**. A sole maintainer cannot approve their own PR. Avoid unintentionally locking yourself out; recruit a trusted co-maintainer before requiring an independent approving review, or temporarily use PR-only merges with careful manual review.

Protect the GitHub account using passkeys/security keys and 2FA, keep GitHub CLI/auth tokens least-privileged and remove obsolete local/self-hosted runner registrations.

## Source and distribution gates

The public `Pandesh` repository currently hosts documentation and publication scaffolding, **not the complete Core code**. A clean, buildable source snapshot must pass history/secret scans, license/asset audits, random local-service credentials, dependency scrutiny and reproducible build checks before publishing.

The separate `Pandesh_Releases` repository holds official binary artifacts. Checksums help detect a mismatch with the published release files, but they are not a malware scan, proof of identity or code-signing certificate.

## Disclosure and privacy

Keep security reports confidential until a fix or coordinated disclosure. We cannot promise absolute protection or support every attack scenario. Any suspected compromise should be handled by revoking affected tokens, disabling compromised automations, analyzing affected hosts and publishing accurate advisories as appropriate.

[Contributor instructions](CONTRIBUTING.md) · [Maintainer security setup](docs/MAINTAINER_SECURITY_SETUP.md) · [Open-source publication gates](docs/OPEN_SOURCE_STATUS.md).
