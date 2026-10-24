# Contributing to Pandesh

Thanks for helping improve the local-first Pandesh assistant.

**Source status:** The audited source snapshot is being prepared. Until it lands in this repository, please focus on product feedback, documentation, reproducible bugs, accessibility suggestions, and discussion.

## Before submitting a bug

- Search existing issues in this source repository and in [Pandesh_Releases](https://github.com/siddharthakki/Pandesh_Releases/issues).
- Give the **exact Pandesh version/build**, Windows version, selected model and local provider, reproducible steps, expected behavior and actual result.
- Include *redacted* logs and cropped screenshots only when necessary. Do not upload tokens, private emails, home directories, full SQLite databases, or private code.

## Code contributions (after source import)

1. Open an issue before a substantial feature or architecture change.
2. Fork the public repository and branch from the published default branch.
3. Make focused changes; add reproduction coverage for fixes.
4. Respect task/action permissions and process-ownership safety; don't weaken them for convenience.
5. Prefer actual end-to-end behavior over mock-only claims; accurately label the scope of tests.
6. Submit a pull request explaining the user scenario, risk and validation steps.

**All public PRs must run in isolated GitHub-hosted CI.** We do not execute untrusted public contributions on a personal self-hosted runner.

By submitting a contribution, you agree that your contribution can be distributed under the project's [MIT license](LICENSE), and you confirm you have the rights to contribute that code or asset. Do not copy third-party licensed code, datasets, proprietary credentials, or copyrighted media without appropriate rights and notices.

## Security reports

For a potential vulnerability, follow [SECURITY.md](SECURITY.md) rather than publicly posting exploit steps or secrets.
