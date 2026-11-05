# All-in-One operator: what Pandesh can really do

This is the operator-facing companion to the All-in-One work: how the
product decides what it can do, what it claims, and where the evidence for
each claim lives.

## The one rule

The **governed capability registry** is the authority. A capability is
operable only when a governed tool can really drive it, and it is "working"
only when that tool answers right now.

Everything else follows from that:

| Where you look | What it tells you |
| --- | --- |
| `core/runtime/governedCapability.ts` | what can be executed, and whether it is healthy right now |
| `core/runtime/capabilityInventory.ts` | what is INSTALLED on this PC, and which tool drives it |
| `core/runtime/capabilityBrief.ts` | the short, current brief the model is given |
| `core/runtime/productionOfferings.ts` | what this PC can really deliver for a customer, and what is still missing |

An item that is only installed is reported as
`FOUND (no Pandesh tool drives it)`. It is never reported as something
Pandesh can do.

## The capability brief

The model receives one extra block in its system prompt:

```
WHAT PANDESH CAN DO RIGHT NOW (each line is a tool you may call):
- image and video generation: image_list_checkpoints, image_generate, video_generate, comfyui_status, ...
- reading documents (OCR) and downloading media: document_read, document_ocr, media_download
- the managed browser: browser_open_site, browser_goto, browser_read, ...
- ... (and for anything that is down: NOT AVAILABLE (the reason) - do not promise it; say why)
```

It is built from the registry's live health, so it is current, and it is
short on purpose: a local 27B model is measurably worse at choosing between
a large undirected tool list.

## Why the chat surface is bounded

The chat bridge deliberately exposes ten capabilities, not every tool the
registry owns. This was measured, not guessed:

| Chat allowlist | Tools sent | Prompt tokens | Live result with `gemma4:26b-a4b-it-qat` |
| --- | --- | --- | --- |
| 20 capabilities | 149 | ~29,000 | one output token, no tool call, empty reply |
| 10 capabilities | 113 | ~24,000 | `comfyui_status` called, 7 checkpoints named, 23 s |

The ten are the ones the acceptance workflows need: image-studio, filesystem,
document-tools, household, plan, wish, browser, research, capability-inventory
and ollama-management. The rest still work through the governed dispatch
route and the desktop panels. They can return to chat when a lazy
tool-selection step exists; adding them all at once reproduces the 149-tool
failure. `scripts/acceptance/run-chat-capability-live-acceptance.mjs` fails if
the surface grows past 130 tools.

## The three testing layers

| Command | What it is | Typical time |
| --- | --- | --- |
| `npm run test:unit` | typecheck + the tests of the files you touched | under 60 s |
| `npm run test:regression` | the impacted suites for a change, plus the privacy / approval / mutation / cancellation / replay invariants whenever the governed surface moved | 1-3 min |
| `npm run test:full` | the broad sweep over every test file | about 7 min |
| `npm run test:acceptance` | the real thing: real Core, real tools, real approvals | depends on the scenario |

`npm run test:status` shows the last result of each tier and whether it is
still fresh for the current source tree. A validation that ran against
different bytes is reported as STALE and is never reused.

The impacted suites are derived from the real import graph
(`scripts/lib/test-impact.mjs`), not from a hand-kept list.

## The acceptance drivers

Each one drives the REAL Core over REAL HTTP with REAL approvals, and
writes its evidence under `.acceptance-evidence/`.

| Driver | What it proves |
| --- | --- |
| `scripts/acceptance/run-artifact-restart-acceptance.mjs` | an artifact is still retrievable and renderable after a real Core restart, and an unauthenticated caller is refused |
| `scripts/acceptance/run-comfyui-direct-acceptance.mjs` | Pandesh drives ComfyUI itself: checkpoints, prompt id, render, retrieval, and the RECOVERY of a render that finished while the Core was down |
| `scripts/acceptance/run-aw1-ocr-summary-acceptance.mjs` | scanned invoices are read by OCR, the numbers and totals come out right, the summary file is written through the gate, and a refused write leaves no file |
| `scripts/acceptance/run-aw2-companion-delivery-acceptance.mjs` | a real 1024x1024 ComfyUI render survives a restart, is queued for the paired phone, pulled back over pinned TLS and acknowledged exactly once. No JUGAAD APK exists here, so the Android UI itself is the recorded limit. |
| `scripts/acceptance/run-aw3-research-price-acceptance.mjs` | research -> the vendor's own page in the browser -> the note with the price the browser saw -> the calendar attempted for real |
| `scripts/acceptance/run-wish-sandbox-journey-acceptance.mjs` | one complete sandboxed Wish-to-Reality journey, with the honest ladder (prepared / demonstrated / approved / delivered / paid) |
| `scripts/acceptance/run-chat-capability-live-acceptance.mjs` | a real local model, a real chat turn, reads the brief, chooses `comfyui_status`, calls it, and names the checkpoints the tool returned |
| `scripts/acceptance/run-all-in-one-capability-matrix.mjs` | the capability matrix, generated from the live inventory of this PC |

## What is deliberately not done

- No customer is contacted by any of these drivers.
- No invoice is issued and no payment is claimed.
- Nothing is published.
- The live calendar step is attempted for real; when Google is not connected
  the result is recorded as BLOCKED with the exact reason, and the
  acceptance proves that nothing was created.
