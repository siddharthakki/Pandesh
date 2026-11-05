# All-in-One gaps: what is working, what is buildable, what is missing, what is refused

This is the classification the All-in-One work asked for, recorded against
the code that exists today. Each row names the evidence, not an intention.

**Classes**

1. **Working and verified** - a governed tool drives it and it was exercised.
2. **Implementable with existing infrastructure** - the machinery is already
   there (the governed fabric, the approval gate, the artifact store); only
   the adapter is missing.
3. **Requires a specific missing dependency** - it cannot be done here
   without something this PC does not have.
4. **Intentionally unsupported** - a deliberate boundary, not an omission.

## The Windows breadth

| Capability | Class | Evidence / what it would take |
| --- | --- | --- |
| Screenshot of the whole screen | **1 - working** | `desktop_screenshot` (computer-use capability); verified by the live desktop acceptance runs |
| List the visible windows | **1 - working** | `desktop_windows_list` (computer-use capability) |
| Printing a Windows test page | **1 - working** | `print_test_page`; the printer inventory found 5 installed (2 physical: Brother MFC-L2710DN) and the approval gate covers it |
| Printing a REAL document (a PDF, a text file) | **2 - implementable** | `core/runtime/windowsPrinting.ts` already resolves the printer, detects a shell print command and refuses a duplicate submission. What is missing is one governed adapter that takes a file path, prints it through the SAME printer resolution, and reports what the spooler said. No new dependency. |
| Download a media file to disk | **1 - working** | `media_download` (document-tools capability), added in this work: one http(s) URL, no playlist, size capped, nothing executed, approval-gated |
| Network drives | **1 - working** | `network-drive` capability (map / list / unmount); it is now exposed to the chat surface |
| Reading a file outside the workspace | **1 - working** | `filesystem` capability (`list_directory_outside_workspace`, `read_file_outside_workspace`), approval-gated per exact path, credential files refused |
| Installed-app inventory (Start-menu / installed programs) | **2 - implementable** | The inventory already probes PATH, the WinGet package folders and the known install paths. A registry query (or `Get-Package`) would extend the same item list; no new dependency, but the answer would still be "found", not "operable", unless a tool drives the app. |
| Clipboard read / write | **2 - implementable** | A governed adapter with `Get-Clipboard` / `Set-Clipboard` through the existing sanitized PowerShell path (`core/runtime/windowsShellExec.ts`). Two cautions that are design, not difficulty: the clipboard is shared state (reading it can pull a password the user copied), and writing it is a mutation. Both would need the existing approval gate and an explicit scope. |
| Screen-region capture | **2 - implementable** | `desktop_screenshot` already captures the desktop through the same path; a region parameter is a bounded crop of the image it already has. The honest limit: a region capture is still a screenshot of whatever is on screen, so it inherits the same privacy boundary. |
| Window focus / move / resize / close | **2 - implementable** | `desktop_windows_list` already returns the title and the PID of every visible top-level window, so the target identity exists. The missing part is the mutation, and that is exactly the part that needs an approval card naming the window (a wrong PID is another program's window). |
| Mouse and keyboard control | **4 - intentionally unsupported** | Input injection at the OS level is a different risk class from reading the screen or listing windows: it can type into whatever has focus, including a password field and another application's window. The current boundary (see what is on screen, list the windows, screenshot) stops at the point where Pandesh starts acting on someone else's window. |
| Uninstalling an installed program | **4 - intentionally unsupported** | Uninstallation is irreversible and touches the machine outside Pandesh's own data. Installing a vetted utility with approval exists (`pc_install_utility`); removing arbitrary software does not, and is not planned. |
| Registry write | **4 - intentionally unsupported** | Refused by design in the existing policy. The registry is not Pandesh's to change. |

## The engines

| Capability | Class | Evidence / what it would take |
| --- | --- | --- |
| Ollama chat, model list, pull, unload, delete | **1 - working** | `system_list_models` plus the new `ollama-management` capability (list / pull / unload / delete, with the disk check, the "never delete a model that is loaded" rule and the second confirmation) |
| ComfyUI image generation | **1 - working** | `comfyui_generate_image` drives ComfyUI's own API: prompt id, render, retrieval, durable artifact, and the RECOVERY of a render that finished while the Core was down |
| OpenCode | **1 - working** | `delegate_to_opencode` |
| Hermes skills | **1 - working** | `hermes_list_skills`, `hermes_invoke_skill` (about 90 skills installed) |
| Claude Code | **3 - needs a specific dependency** | The CLI is installed and works, but it is only reachable through the Kandev dev-story lane (`dev_stories_*`), which is a development-story workflow, not a general chat route. The Kandev ACP coordinator is the intended path; a general chat route over it is not built. |
| Mid-run steering of a delegated engine (OpenCode / Hermes) | **2 - implementable** | OpenCode's stdio is one-way today (`stdio[0] = 'ignore'`), and Hermes corrects by stopping and starting a new run. Both engines expose an input channel; routing the existing attempt-steer signal into it is the work. The current behaviour (stop, then continue with what is known) is safe but loses the in-flight context. |
| Returning STRUCTURED results from a delegated engine | **2 - implementable** | The engines currently return a text blob. The artifact ids, changed files and tool-invocation rows already exist on the Core side for Pandesh's own calls; the adapters would have to map the engine's output onto the same shape. |

## Accounts and services

| Capability | Class | Evidence / what it would take |
| --- | --- | --- |
| Web research | **1 - working** | `governed_research`: cited, bounded evidence, egress approved per request. Verified live in the AW3 acceptance. |
| Managed browser | **1 - working** | `browser_*` (11 tools), headless Chromium, used live in the AW3 acceptance to read the vendor's own page. |
| Gmail / Google Calendar | **3 - needs a specific dependency** | The connectors exist and are correct; Google is not connected on this machine, so the connector reports `not_configured` and the governed call is refused before anything is sent. That refusal is itself verified. |
| WhatsApp | **4 - intentionally unsupported** | There is no official personal-chat API, and Pandesh never scrapes a WhatsApp Web session. The connector is declared and has no executor, on purpose. |
| Printer connector | **3 - needs a specific dependency** | Declared with no executor: Windows printing goes through the native path (`print_test_page`), not through the connector. |
| GitHub issues and comments | **1 - working, opt-in** | `github_read_issue`, `github_comment_on_issue`; the capability is registered when `KARKEDIKHA_GITHUB_REPOSITORY` is set, so it is absent by default rather than half-present. |

## Research and GitHub integration

| Capability | Class | Evidence |
| --- | --- | --- |
| A cited research answer | **1 - working** | `governed_research` + the SSRF-safe fetcher; the AW3 acceptance used it for real |
| Reading the source page in the managed browser | **1 - working** | `browser_open_site` + `browser_read`; the AW3 acceptance confirmed the price on the vendor's page |
| Carrying a research result into a document | **1 - working** | The AW3 acceptance wrote the browser's own price into the note and verified it byte for byte |
| An issue found in research becoming a tracked GitHub issue | **2 - implementable** | Both halves exist (`governed_research` and the GitHub capability); the missing piece is the handoff, which is the same typed-handoff work as the plan's steps |
