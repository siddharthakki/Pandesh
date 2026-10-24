# Pandesh Maintainer Security Setup & Verification

**Security status:** Both public repositories are online, active branch rulesets are enforced on `main`, Actions permissions are locked down to read-only, and vulnerability reporting is enabled. This guide documents the configured defenses and maintenance guidelines.

## Verified Configured Protections

- [x] **Branch ruleset active on `main` in both repos:** Deletion blocked, force-push blocked, PR required, stale reviews dismissed, latest push approval required, review thread resolution required.
- [x] **Sole-maintainer workable configuration:** Repository Admin has PR-bypass to prevent lockout while author cannot self-approve. Direct pushes remain blocked. Ready to strengthen to 1+ independent reviewers when trusted co-maintainers join.
- [x] **GitHub Actions permissions locked down:** Default GITHUB_TOKEN set to `read-only`, Actions prohibited from creating/approving PRs.
- [x] **Third-party action restrictions:** Allowed actions set to `selected` (GitHub-owned and verified creators only).
- [x] **Zero self-hosted runners:** No personal or self-hosted runners registered.
- [x] **Repository security scanning:** Secret scanning and push protection enabled on both repos.
- [x] **Dependabot alerts & automated fixes:** Enabled on both repos.
- [x] **Private vulnerability reporting:** Active on both repos (`Security -> Advisories -> Report a vulnerability`).
- [x] **CODEOWNERS configured:** Assigns review routing to `@siddharthakki` across both repos.
- [x] **Repository metadata configured:** About description, topics, and verified live website URL (`https://siddharthakki.github.io/Pandesh/`).
- [x] **GitHub Discussions enabled:** Community categories configured for Announcements, Q&A, Ideas, Show & Tell, and Model discussions.

## Maintainer Review Checklist for Community PRs

1. **Diff inspection in browser:** Always inspect pull requests via GitHub's web interface. Never check out an unreviewed PR locally.
2. **Review trust boundaries:** Check `.github/workflows/`, `package.json` scripts, lockfiles, dotfiles, PowerShell, and binaries.
3. **No local execution:** Never run `npm install`, `npm test`, or contributor scripts on a personal PC.
4. **Isolated evaluation:** If execution is required, use disposable GitHub-hosted runners or an isolated throwaway VM with no credentials or access to your home network.
5. **No automated merging or binary releases:** Merges require human review. Binaries are never built or released from community PRs.

## Strengthening Rulesets When Co-Maintainers Join

When trusted co-maintainers join the project:
1. Open **Settings → Rules → Rulesets → `main-protection`**.
2. Increase **Required approvals** from `0` to `1` (or `2`).
3. Enable **Require review from Code Owners**.
4. Restrict bypass actors so all maintainers must have independent peer review before merging.
