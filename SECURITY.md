# Security Policy

Pandesh is early alpha software with local model execution and selectively authorized external tools.

## Reporting a security problem

**Please do not post exploit details, credentials, or private data in a public GitHub issue.**

If GitHub's private security advisory reporting is available for this repository, use the repository's **Security → Report a vulnerability** option. Otherwise, open a minimal public issue asking the maintainer for a private reporting channel, **without disclosing the exploit**. The maintainer should enable GitHub's private vulnerability reporting before promoting the repository to external security researchers.

Include the affected version, platform and impact through the private reporting channel. We have not published a response-time guarantee.

## Scope and boundaries

- Local-first does not imply every optional integration is offline.
- A tool invocation, model response, or approval does not by itself prove successful execution.
- Treat file deletion, process control, external communication and privilege changes as consequential.
- User-provided code and pull-request changes are untrusted. **Never run public PR content on personal self-hosted CI infrastructure.**
- Do not commit credentials, OAuth tokens, local data directories, runtime logs or process IDs.
- The downloadable alpha is not an operating-system sandbox; only grant permissions you understand.

## Open-source publication

The original development repository is **not** being made public. The new source repository will receive a reviewed snapshot with no inherited development history. See [the publication checklist](docs/OPEN_SOURCE_STATUS.md).
