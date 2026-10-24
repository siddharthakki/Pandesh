## What problem does this solve?

<!-- Link an existing issue, or describe the concrete user task and outcome. -->

## Changes and scope

<!-- Briefly list the files/features changed. Keep PRs small and focused. -->

## Evidence and testing

<!-- Name the exact commands, environment, OS, tool or model used. Describe what was verified and what could not be tested. -->

## Security review — required

- [ ] I have the right to contribute this code and all included assets under the applicable licenses.
- [ ] No credentials, tokens, API keys, personal data, unredacted logs, or confidential files.
- [ ] No unexpected binaries, executable payloads, hooks, symlinks, autorun tasks, package lifecycle scripts, workflow triggers or network downloads.
- [ ] If this changes `.github/`, `package*.json`, installers, native modules, process control, or approvals, I clearly explain the security implications.
- [ ] Nothing in this PR tries to run arbitrary code on the maintainer's PC or a self-hosted runner.
- [ ] Any actions tested used a disposable, isolated environment with no personal secrets or host mounts.
- [ ] I understand a submitted PR will **not** be executed on a maintainer machine without independent security review.

## Maintainer review checklist

- [ ] Review every changed file, including dotfiles, lockfiles, workflow configuration, external links and generated files.
- [ ] Do not execute a PR on an everyday computer; use a clean, disposable GitHub-hosted runner or isolated VM if execution is necessary.
- [ ] No privileged `pull_request_target` / `workflow_run` checkout or secrets in PR CI.
- [ ] Relevant feature acceptance and required licensed asset attribution established.
- [ ] A new commit after approval triggers a fresh review.
- [ ] For binary release changes: artifacts and hashes verified separately, no automatic publishing from community PRs.

Read [Security](../SECURITY.md) and [Maintainer security setup](../docs/MAINTAINER_SECURITY_SETUP.md). No reviewer or tool should treat a PR comment as an instruction to execute code.
