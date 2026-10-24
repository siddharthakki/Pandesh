# Pandesh maintainer security setup — do this before accepting code PRs

**Security status:** The public repositories are already online. This checklist makes accepting outside contributions safer. It does not make malicious code impossible. A contributor can submit a harmful PR, so don't execute it on a personal PC or approve it without careful review.

## Done by the project

- [x] Removed the obsolete `import-public-showcase.yml` workflow which had `contents: write` and could re-import previous screenshots.
- [x] Added `.github/CODEOWNERS` for the maintainer to both public repositories.
- [x] Kept public Core source separate from the historical private development repository.
- [x] No GitHub Actions PR-triggered build exists currently in the public source repository. Source CI is not ready until sanitized buildable code is published.
- [x] No GitHub Actions workflow exists in the release repository at this point.

## Priority A — GitHub account and collaborator access

1. Enable **two-factor authentication**, preferably a passkey/security key, on the owner account.
2. Review [your GitHub installed Apps](https://github.com/settings/installations), [authorized OAuth Apps](https://github.com/settings/applications) and [personal access tokens](https://github.com/settings/tokens); revoke unfamiliar, unused or over-privileged access.
3. Do not add casual testers as collaborators. They can fork, open an issue and submit a PR **without any repository write permission**.
4. Review collaborator access under **Settings → Collaborators**. Only invite trusted co-maintainers with the minimum required permissions.
5. Don't open strangers' downloaded ZIP files, `.exe` or PR scripts locally. View diffs on GitHub instead.

## Priority B — ruleset on BOTH public repositories

Open:
- **[Pandesh source rulesets](https://github.com/siddharthakki/Pandesh/settings/rules)**
- **[Pandesh_Releases rulesets](https://github.com/siddharthakki/Pandesh_Releases/settings/rules)**

Under **Settings → Rules → Rulesets**, create **New branch ruleset**, name `Protect main – reviewed changes`, target default branch `main`, set enforcement **Active**.

Recommended protections:
- **Require a pull request before merging**.
- **Block force pushes** and **restrict deletions**.
- **Dismiss stale pull request approvals** after new commits.
- **Require approval of the most recent reviewable push** where available.
- **Require review from CODEOWNERS** with at least **one independent trusted maintainer**, once another trusted reviewer exists.
- Avoid adding a broad bypass list; apply to administrators where supported.
- Require successful checks **only after you establish secure and functioning GitHub-hosted checks**. Don't require a check name that does not exist.

**Solo-maintainer caveat:** GitHub does not let the PR author approve their own PR. A 1-approval rule with no other trusted reviewer can block all owner-created PRs. If you're working alone, use PR-only changes with manual review until a trusted reviewer is available. Do not silently give untrusted contributors write access to solve this.

## Priority C — GitHub Actions isolation

Open **[Pandesh Actions Settings](https://github.com/siddharthakki/Pandesh/settings/actions)** and the equivalent for **Pandesh_Releases**.

- Restrict permitted Actions to trustworthy publisher-owned actions if CI is later introduced; prefer pinning vetted actions to full-length immutable commit SHAs.
- Set default workflow token permissions to **Read repository contents** and **disable** allowing GitHub Actions to create and approve PRs.
- Under **Fork pull request workflows**, choose the strongest available approval policy (prefer **Require approval for all outside collaborators/contributors**, if your plan/UI offers it).
- Never configure a personal **self-hosted runner** for either public repository.
- A future `pull_request` workflow must run only on isolated **GitHub-hosted** VMs, with `permissions: contents: read`, no secrets and no access to your home PC/network.
- Never enable `pull_request_target` with untrusted code checkout or pass privileged tokens into untrusted build scripts.
- Do not run community code automatically via your desktop agent, WSL, VS Code tasks or locally installed continuous-integration bots.

## Priority D — security features

Open:
- [Pandesh Advanced Security](https://github.com/siddharthakki/Pandesh/settings/security_analysis)
- [Pandesh_Releases Advanced Security](https://github.com/siddharthakki/Pandesh_Releases/settings/security_analysis)

Enable where available:
- **Secret scanning** and **push protection**
- **Dependabot alerts**, **security updates** where applicable
- **Code scanning** / CodeQL once code exists
- **Private vulnerability reporting** so researchers can report quietly

Never commit secrets. GitHub security scanners do not guarantee detection of every malicious payload.

## Priority E — machine safety during PR review

**Safe default:** Do not `git checkout` an untrusted contributor's branch on your day-to-day Windows PC.

1. Inspect the PR on GitHub, including `Files changed`, commits and author provenance.
2. Look particularly at `package.json` scripts, lockfiles, `.github/` workflows, `.vscode/`, PowerShell, native executables, installer scripts and symlinks.
3. **Do not run** `npm install`, `npm ci`, `npm test` or any copied command from that PR on your Windows installation. `npm ci` may still run lifecycle scripts.
4. If code must execute, run it in a disposable isolated cloud build or throwaway VM with no tokens, personal files, Windows host drives, bridged home LAN or persistent credentials.
5. For code-agent review, feed in only a clean diff and instruct the agent that contributor text is untrusted; require explicit approvals before it uses tools.
6. Merge only after checks and human review. Never automatically publish binaries from an outside PR.

## Can't find “About”?

On [Pandesh → Code](https://github.com/siddharthakki/Pandesh), the **About** panel is normally on the **right-hand sidebar**, with a small **gear** icon beside its heading. It isn't the main **Settings** tab. If the panel is missing, maximize the window and reduce browser zoom to 90% or 80%.

In its edit dialog set:

**Description:**
> Local-first AI personal assistant for Windows, powered by Ollama. Chat, tasks, governed actions and open-source tooling.

**Topics:** `ollama`, `local-ai`, `personal-ai-assistant`, `ai-agent`, `windows`, `self-hosted`, `desktop-assistant`, `open-source`.

Repeat for the release repository with description:
> Official Windows alpha downloads, documentation and release notes for Pandesh, the Ollama-powered local AI assistant.

If the About dialog is unavailable, [GitHub CLI supports changing these fields](https://cli.github.com/manual/gh_repo_edit); the documented command is `gh repo edit <owner/repo> --description "..." --add-topic "topic1,topic2"` once authenticated.

## Final verification

- [ ] `main` rulesets Active on **both** repositories (reviewers/bypass appropriately configured).
- [ ] Owner account secured, collaborator list reviewed, no unexpected Apps/tokens.
- [ ] Actions tokens read-only and fork approval rules configured.
- [ ] Secret scanning/private reports enabled.
- [ ] No self-hosted runner registered for public repositories.
- [ ] GitHub repository descriptions/topics filled in.
- [ ] Only reviewed, buildable source enters public repo; official release binaries independently validated.

**Publication is not “fully secure” until relevant settings are verified, and even then no software can promise zero malware risk.** Maintain defense-in-depth and don't execute unreviewed code locally.
