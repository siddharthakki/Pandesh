# Launch and discoverability checklist

This is the **maintainer-only checklist** for making Pandesh easy to find in GitHub and search engines. GitHub Pages is not automatically enabled by committing website files. Do not describe a site as live until you can open it anonymously.

## Repository description and topics

Set the following text in [Pandesh → About → Edit](https://github.com/siddharthakki/Pandesh):

**Suggested description (copy/paste):**

> Local-first AI personal assistant for Windows, powered by Ollama. A Jarvis-inspired open-source desktop agent for chat, tasks and governed automation.

**Suggested topics:** `local-ai`, `personal-ai-assistant`, `ollama`, `windows`, `ai-agent`, `desktop-assistant`, `local-llm`, `self-hosted`, `automation`, `electron`, `open-source`, `jarvis-inspired`

Set the **Website** to the GitHub Pages URL *only after it is enabled and working*.

For the downloads repository, use:

> Official Windows installer and portable downloads for Pandesh — an Ollama-powered, local-first AI personal assistant.

## Publish the prepared website

1. Go to [Pandesh → Settings → Pages](https://github.com/siddharthakki/Pandesh/settings/pages).
2. Choose **Deploy from a branch** and select branch `main`, folder `/docs`, then save.
3. Check the result in a logged-out browser at **https://siddharthakki.github.io/Pandesh/**.
4. Only after the site works, use this address as the GitHub repository homepage / canonical website.
5. Verify screenshots, download links, meta description, responsive layout and [sitemap.xml](sitemap.xml). Run a public search engine URL inspection after search indexing is available.

The site is intentionally **static**, requires no account and embeds no tracking or analytics script.

## Search phrases covered naturally in public copy

- local AI assistant for Windows
- AI personal assistant
- Ollama desktop assistant and local LLM
- Jarvis-inspired AI companion (comparison only, not an affiliation)
- open-source AI agent
- self-hosted Windows desktop assistant
- governed automation and privacy-oriented local models

Avoid stuffing keywords or claiming “fully offline” when users can enable network connectors.

## Media and version truthfulness

- The currently downloadable installer is **v0.1.1 Build 142**.
- Existing gallery images are **v0.1.2 Build 143 development previews** with synthetic demonstration data.
- The gallery cannot be marketed as independent evidence of live model inference, system diagnostics, memory mutation or approval execution.
- No complete walkthrough video is published yet. Do not fabricate interactions or claim a video is attached until verified.

## Search and community trust

- Keep direct download URLs and SHA-256 values accurate.
- Do not rehost model weights or third-party artwork without their actual licenses.
- Publish safe, reproducible source before calling the full Core “open source”.
- Include accessible image alt text, concise screenshots, a getting-started guide and an honest limitations section.

[Homepage](../README.md) · [Architecture](ARCHITECTURE.md) · [Roadmap](ROADMAP.md) · [Core publication tracker](OPEN_SOURCE_STATUS.md)
