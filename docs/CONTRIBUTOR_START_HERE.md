# Start contributing to Pandesh

You don't need to be a professional developer to help improve Pandesh, a local-first Windows AI assistant.

## Help now: no source checkout required

1. **Try the alpha.** Download [the current public Windows installer](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha), install Ollama, and run a few practical requests in Pandesh. Verify what actually happened.
2. **Report a reproducible bug.** Use the [release issue tracker](https://github.com/siddharthakki/Pandesh_Releases/issues/new/choose), with the exact build, hardware, model and steps. Do not post unredacted personal information.
3. **Test a local model.** State CPU/GPU, RAM, VRAM, Ollama version, exact model and quantization, the prompt, whether Pandesh responded and whether real tool calls executed. Do **not** make unsupported comparative rankings.
4. **Improve guides or screenshots.** Fix an unclear step or typo in this public repository; submit a focused documentation PR.
5. **Accessibility and translation.** Identify confusing labels, keyboard navigation issues, contrast problems or confusing setup language. Don't imply a language/feature is officially supported without testing.

### First tasks

- [Verify the Windows/Ollama getting-started guide on a fresh machine](https://github.com/siddharthakki/Pandesh/issues?q=is%3Aissue+is%3Aopen+Windows+Ollama)
- [Help build the reproducible local-model test matrix](https://github.com/siddharthakki/Pandesh/issues?q=is%3Aissue+is%3Aopen+compatibility)
- [Source publication tracker](https://github.com/siddharthakki/Pandesh/issues/1)

## How to submit a documentation pull request

1. Open an existing small issue or file a focused docs improvement.
2. Select **Fork** in the upper-right of the [Pandesh repository](https://github.com/siddharthakki/Pandesh).
3. In your fork, edit a Markdown guide using GitHub's pencil icon or your preferred editor.
4. Commit the change on a new branch in your fork.
5. Choose **Contribute → Open pull request**, with the original Pandesh `main` branch as the target.
6. Explain what changed, how you checked the links or instructions, and whether any screenshot has been redacted.

The maintainers can review and merge useful documentation changes. Contributors retain their copyright and agree to MIT licensing for contributed project code/material they own.

## Code contributions — what happens next

The original Core remains private while the maintainers prepare a clean source export, fix a local integration credential and verify a reproducible build. The public repository **is not yet a complete source checkout**.

After it publishes, the normal flow will be **fork → create issue/branch → implement one focused change → test → PR → review**. We'll add exact bootstrap/build/test commands for the published tree then. Do not ask for or distribute copies of the private developer repository.

## What makes a strong contribution?

- Reproducible user outcome rather than vague model-generated claims
- Small, reviewable scope and evidence for the result
- Respect for user approvals, privacy, and unrelated Windows processes
- No API keys, tokens, data directories or confidential screenshots
- Honest description of what was *not* verified

[Full contributor policy](../CONTRIBUTING.md) · [Community conduct](../CODE_OF_CONDUCT.md) · [Support](../SUPPORT.md)
