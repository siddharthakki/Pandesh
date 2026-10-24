# Pandesh Security Policy

**Pandesh is experimental alpha software.** We welcome responsible disclosure and security review. Because this project runs on local Windows systems with tool-execution capabilities, security and contributor isolation are paramount.

## Report vulnerabilities privately

Do **not** post vulnerabilities, exploit instructions, credentials, or private user data in public Issues, PRs, or Discussions.

**Private Vulnerability Reporting is active.**
Report vulnerabilities directly through GitHub:
👉 **[Report a vulnerability](https://github.com/siddharthakki/Pandesh/security/advisories/new)** (Security → Advisories → Report a vulnerability)

Reports are received privately by the repository maintainer. We aim to triage and acknowledge valid reports promptly.

## Trust model & contributor safety boundaries

Anyone may **fork** this project and propose a Pull Request. Forking or submitting a PR **never** grants direct write access to `main`, permission to publish releases, access to maintainer secrets, or execution on the maintainer's personal computer.

### Absolute maintainer security boundaries:
- **Never execute contributor code on a personal Windows PC:** We never run `npm install`, `npm test`, PowerShell scripts, binary executables, or IDE tasks from external PRs on developer machines.
- **No self-hosted runners:** All public workflows run strictly on GitHub-hosted, disposable runners.
- **Least-privilege tokens:** Default `GITHUB_TOKEN` permissions are set to `read-only`. GitHub Actions are prohibited from creating or approving PRs.
- **Workflow approval required:** Workflows triggered by outside contributors require explicit maintainer authorization before running.
- **No secrets in PRs:** No personal credentials, local Ollama endpoints, Google Workspace tokens, or cloud API keys are exposed to PR environments.
- **No automatic merging or publishing:** Merges require human review. Release binary creation is strictly isolated and gated.

## Branch protection rulesets

An **active GitHub ruleset** protects the `main` branch across both repositories (`Pandesh` and `Pandesh_Releases`):
- **Pull requests required:** Direct pushes to `main` are blocked.
- **Deletion blocked:** The `main` branch cannot be deleted.
- **Force pushes blocked:** Non-fast-forward pushes are rejected.
- **Stale reviews dismissed:** Approvals are automatically dismissed when new commits are pushed.
- **Latest push review required:** Review of the most recent code changes is enforced.
- **Thread resolution required:** All conversation threads must be resolved before merging.

### Sole-maintainer configuration & future strengthening:
GitHub rulesets do not permit a pull request author to approve their own PR. In a sole-maintainer project, requiring `1` approving review without bypass would permanently lock the sole maintainer out of maintaining their repository.

Therefore, our active ruleset implements a secure, workable sole-maintainer configuration:
1. All changes must pass through a Pull Request.
2. Direct pushes, deletions, and force-pushes are blocked.
3. The Repository Admin has `bypass_mode: pull_request` permissions, allowing PR merges by the authenticated owner while blocking direct push without a PR.
4. **When trusted co-maintainers join:** the ruleset will be strengthened to require `1+` independent approving reviews, CODEOWNERS approval enforcement, and strict bypass restrictions.

## Automated security features

- **Secret Scanning:** Active on all pushes.
- **Secret Scanning Push Protection:** Blocks commits containing recognized credentials before they reach the repository.
- **Dependabot Alerts & Automated Security Fixes:** Enabled for vulnerable dependency monitoring.
- **Private Vulnerability Reporting:** Enabled for confidential disclosure.

## Local development & safe PR review workflow

Maintainers and reviewers follow these safety rules:
1. Review all diffs and changed files exclusively in the GitHub web interface.
2. Never `git checkout` an untrusted branch locally.
3. Check `package.json` scripts, lockfiles, workflows, and dotfiles for injected hooks.
4. Use disposable cloud environments or isolated throwaway VMs without network access to personal resources if dynamic execution testing is necessary.

[Contribution Guide](CONTRIBUTING.md) · [Maintainer Security Setup](docs/MAINTAINER_SECURITY_SETUP.md) · [Open-Source Status](docs/OPEN_SOURCE_STATUS.md)
