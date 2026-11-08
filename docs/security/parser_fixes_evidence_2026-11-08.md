# Document-parser security fixes — evidence (2026-11-08)

Branch `fix/xmldom-ghsa` = two stacked, separately reviewable commits on `fix/reliability-remediation` @ 0d654d7:

| Commit | Change | Alerts |
|---|---|---|
| 869f3ac (`fix/pdfjs-ghsa-hq66`) | `pdfjs-dist` 6.1.200 → **6.2.108** (lockfile pin; package.json range `^6.2.108`) | #79 GHSA-hq66-cqwq-w95j — arbitrary JS execution on opening a malicious PDF |
| 6d2b526 | `@xmldom/xmldom` 0.8.13 → **0.8.15** (lockfile only; mammoth's `^0.8.6` admits it) | #84 #89 #90 #93 #96 #97 #98 #99 |

No other package moves (lockfile diff: 8 + 6 lines).

## Unit / integration

- Attachment + extraction suites (`documentExtraction`, `attachmentExecution`, `attachmentUpload`, `contractExtractionResumption`): **34/34 pass** on the stacked branch.
- Security-floor tests fail below the patched versions (verified by substituting 6.1.200 and 0.8.13).
- Crafted-DOCX regression (60,000 attributes on one element, through the real `extractDocument()`): **7.4 s → fails** with xmldom 0.8.13; passes inside the 1.5 s bound with 0.8.15.

## Packaged application

Portable build produced by `apps/desktop/scripts/package-portable.mjs` from the stacked branch (build identity v0.1.8 · b159, output in a scratch folder, not installed, not deployed). Packaged `runtime/core.js` contains pdfjs `"6.2.108"` only.

Probe: launch the **packaged** Core (`runtime/node.exe runtime/core.js`) on a fresh data dir and OS-assigned port, then upload through the authenticated `/v1/conversations/:id/attachments` + `/v1/attachments/:id/bytes` routes (extraction runs at upload).

| Upload | Before (core.js with xmldom 0.8.13) | After (shipped core.js) |
|---|---|---|
| report.pdf (real text) | ready, pdfjs-dist, text extracted, 100 ms | ready, pdfjs-dist, text extracted, 109 ms |
| letter.docx | ready, mammoth, 50 ms | ready, mammoth, 50 ms |
| crafted DOCX, 60K attributes (134 KB) | **6,850 ms** | **122 ms** |
| crafted DOCX, 120K attributes (268 KB) | **29,143 ms** | **192 ms** |

`desktop:package-smoke` against the same package: all steps pass (api-ready → core-connected → ollama-models → model-selected → speech/wake probes → submitted → question-completed).

## Not covered

- No proof-of-concept exploit PDF for GHSA-hq66 was built; the fix is established by version (the advisory's first patched release) plus unchanged extraction behaviour.
- Electron 33.4.11 (T2, 45 alerts) is unchanged and needs its own branch and the full gate.
- Not merged into `fix/reliability-remediation`; not pushed.
