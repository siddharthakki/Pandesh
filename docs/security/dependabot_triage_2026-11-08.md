# Dependabot triage — 2026-11-08 (read-only)

Scope: the 101 open alerts on `siddharthakki/Pandesh` (default branch `main`), fetched with `gh api repos/…/dependabot/alerts?state=open`. Versions were compared against the lockfiles on `origin/main` and on `fix/reliability-remediation` (identical for every affected package). Reachability was checked against source imports, `esbuild.core.js` / `apps/desktop/esbuild.mjs` (what is bundled), and `apps/desktop/scripts/package-portable.mjs` (what ships). **Nothing was upgraded, installed or changed.**

**Important:** Dependabot marks *every* alert `scope: development`, because these packages sit in `devDependencies`. That label is misleading for Pandesh. esbuild inlines pure-JS dev dependencies into the shipped `core.js`, and Electron itself is the shipped runtime. Core runs as Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`, `CoreLauncher.ts:283`) with full user privileges.

## Counts

| Severity | Alerts |
|---|---|
| High | 43 |
| Medium | 44 |
| Low | 14 |

| Package | Alerts (H) | Installed | First fixed | Ships in product? |
|---|---|---|---|---|
| electron | 45 (12) | 33.4.11 | 38.8.6 … 42.11.16 | **Yes — the runtime** |
| fast-uri | 11 (7) | 3.1.3 | 3.1.9 | No (ajv, dev tooling) |
| @xmldom/xmldom | 8 (6) | 0.8.13 | 0.8.15 | **Yes — via mammoth, bundled in core.js** |
| protobufjs | 6 (3) | 6.11.6 (dev, onnx-proto) / 7.6.6 (prod, @google/genai) | 7.5.6 | Vulnerable copy is dev only; prod 7.6.6 is outside the range |
| sharp | 3 (3) | 0.32.6 | 0.35.5 | No — the packaged `runtime-assets/node_modules/sharp` is a `0.0.0-unavailable-shim` |
| extract-zip | 2 (2) | 2.0.1 | none | No (Electron download at install time, dev machine) |
| js-yaml | 2 (2) | 4.3.0 | 4.3.2 | No (mocha, vsce, test tooling) |
| markdown-it | 4 (2) | 14.3.0 | 14.3.3 | No (@vscode/vsce) |
| @azure/msal-node | 1 (1) | 5.3.1 | 7.1.0 | No (@azure/identity, tooling) |
| pdfjs-dist | 1 (1) | 6.1.200 | 6.2.108 | **Yes — bundled in core.js** |
| postcss, source-map-js, vite, vitest, @vitest/mocker | 11 (3) | — | — | No (test/dev server) |
| serialize-javascript, brace-expansion, minimatch, qs | 7 (1) | — | — | No (dev tooling) |

## Production-reachable findings (ranked)

### T1 — pdfjs-dist 6.1.200: arbitrary JavaScript execution on opening a malicious PDF (GHSA-hq66-cqwq-w95j) · **Critical in practice**
- **Reachability:** `core/attachments/documentExtraction.ts:130–146` loads `pdfjs-dist/legacy/build/pdf.mjs` and calls `getDocument({ data })` on user-supplied PDFs: attachments, `document_read`, `gmail_read_attachment` and household document reading. An emailed PDF counts as attacker-controlled input.
- **Exploitability:** this runs inside Core, which is Electron-as-Node and not sandboxed. JS execution there means code execution as the user, with access to the Core database, tokens and the filesystem. The `isEvalSupported` mitigation no longer exists in pdf.js 6 (the code comment at line 141 notes this).
- **Upgrade risk:** low. This is a minor-version bump (6.1 → 6.2.108), and the API used is just `getDocument` + `getTextContent`. Verify with the existing document-extraction tests plus one real PDF in the app.
- **Interim mitigation (no upgrade):** none in config. Consider holding PDF attachment parsing from untrusted mail until the bump.

### T2 — Electron 33.4.11 (45 alerts, 12 high) · **High, but a large upgrade**
- **Reachability:** all of it ships. Electron 33 is out of upstream support, so these fixes will not be backported.
- **Exploitability is reduced by the current hardening:** the renderer loads only a local file (`loadFile`). It runs with `nodeIntegration:false`, `contextIsolation:true` and `sandbox:true` (except in smoke-test mode). `setWindowOpenHandler` denies new windows, and `will-navigate` is blocked. No `<webview>` tag or custom privileged protocol was found. Most of the high alerts (sandboxed-iframe popup escapes, `<webview>` Node workers, custom-protocol CORS, contextBridge setter/bind hijack) need attacker-controlled content running in the renderer. They become serious if any XSS appears where the renderer shows model output, email text or web snippets.
- **Directly relevant even with the hardening:** GHSA-jr5w-w6x2-84p9 (compromised eMudhra intermediate certificates, a TLS-trust issue for any HTTPS done through Chromium's network stack) and the use-after-free bugs in PowerMonitor and fullscreen (memory safety in the main process). The app also switches on `disable-gpu-sandbox` (`main.ts:183`).
- **Upgrade risk:** high. 33 → 42 crosses nine majors, bringing a new Chromium and a new bundled Node. Core depends on `node:sqlite` from Electron's Node, and the packaging, installer, updater, wake-word, speech and the Panda bridge native host could all be affected. This needs its own branch, a full reliability-gate run and a smoke run of the installed build. Do not fold it into another change.
- **Interim:** keep the renderer free of HTML injection (render model, email and web text as text). Keep `sandbox` on in real builds. Consider dropping `disable-gpu-sandbox` if no longer needed.

### T3 — @xmldom/xmldom 0.8.13 via mammoth (8 alerts, 6 high) · **Medium**
- **Reachability:** `documentExtraction.ts:173` uses `mammoth.extractRawText` on user DOCX files, so it is bundled.
- **Exploitability:** the injection advisories affect serialisation (`createElement`, `setAttribute`, `requireWellFormed`), which mammoth does not use for output. The quadratic-time advisories (GHSA-8344-3jmq-59r6, GHSA-93r5-fhx6-vmg9) do apply: a crafted DOCX can tie up Core's event loop, a denial of service.
- **Upgrade risk:** low. mammoth 1.12.0 declares `@xmldom/xmldom ^0.8.6`, so 0.8.15 is a lockfile-only update.

## Not production-reachable (tooling / test / dev server)

fast-uri (ajv), js-yaml, markdown-it, serialize-javascript, @azure/msal-node, extract-zip, postcss, source-map-js, vite (dev server: `launch-editor` Windows command issues), vitest / @vitest/mocker, brace-expansion, minimatch, qs, protobufjs 6.11.6 (onnx-proto), and sharp 0.32.6 (the packaged copy is a shim).

Risk here is to the developer machine and CI (e.g. vite dev server exposure, vitest mock path traversal), not to users. They are low priority, best handled as one batched lockfile refresh with the full test suite, after the reliability gate.

## Recommended order (each as its own controlled change, after explicit approval)

1. **pdfjs-dist → ≥ 6.2.108** (lockfile + range). Test document extraction and a real PDF in an isolated build. *Smallest change, largest risk reduction.*
2. **@xmldom/xmldom → 0.8.15** (lockfile only). Test DOCX extraction.
3. **Electron upgrade plan:** a separate branch targeting a supported major (≥ 42.11.16). Run the full 19-mission gate, installer/updater/smoke, wake word, speech, bridge and `node:sqlite` checks. Schedule it after the reliability verdict.
4. Batched dev-tooling refresh (vite/vitest/ajv/mocha/vsce chain) with the full test suite.
5. Dismiss nothing in Dependabot until the matching fix has landed. Record "not reachable" reasoning per alert if dismissals are wanted.

Open question for the owner: should T1 count as a Phase 1 reliability/security blocker (I recommend yes, as an isolated one-package change), or wait for the batched update?
