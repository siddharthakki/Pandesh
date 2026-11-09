# Visual Execution Manager — real windows, real work, persisted truth

## 1. Goal and non-goals

Show real work as it happens and let the user take over, with every view backed by Core records.
**Non-goals:** opening windows as theatre; mouse/keyboard injection (stays intentionally unsupported); controlling windows Pandesh did not open without approval.

## 2. Components

```mermaid
flowchart LR
  RUN[Agent run / attempt] --> VEM[Visual Execution Manager<br/>(Core module)]
  VEM --> PREG[(execution_processes<br/>process registry)]
  VEM --> OWN[processOwnership.ts<br/>owner tokens · verified PIDs]
  VEM --> ARB[Resource Arbiter]
  VEM --> PTY[PTY host<br/>(desktop host)]
  VEM --> WIN[Window placement adapter<br/>(owned windows only)]
  PREG --> EV[(runtime_events: domain 'process')]
  EV --> WS[Workspace mode views]
  EV --> SMW[Show My Work mode]
```

### 2.1 Process registry (additive table)

```sql
CREATE TABLE execution_processes (
  id TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES attempts(id),
  agentId TEXT,
  role TEXT NOT NULL,            -- 'terminal' | 'dev_server' | 'test_run' | 'editor' | 'browser' | 'viewer'
  command TEXT NOT NULL,         -- redacted command line
  cwd TEXT NOT NULL,
  pid INTEGER, ownerToken TEXT NOT NULL, -- from processOwnership; real PID resolved (Edge launcher handoff fixed in b150)
  port INTEGER,                  -- from port_allocate
  mode TEXT NOT NULL,            -- 'workspace' | 'external'
  windowHandle TEXT,             -- external only, for owned windows
  state TEXT NOT NULL,           -- starting|running|exited|killed|orphaned|handed_over
  exitCode INTEGER, logArtifactId TEXT,
  startedAt TEXT NOT NULL, endedAt TEXT, handedOverAt TEXT
);
```

Every process Pandesh starts gets a row before spawn and an owner token; output is streamed to a ring buffer (live) and persisted as an artifact on exit (evidence).

## 3. Two modes

| | Workspace mode (default) | Show My Work mode (opt-in per task or global) |
|---|---|---|
| Terminal | Embedded terminal view (xterm.js in renderer) attached to a PTY owned by the host (ConPTY via `node-pty` — **new dependency, decision needed**); read-only by default, "Type here" = takeover | `wt.exe -w pandesh new-tab --title "<task>" -d <cwd> <cmd>` |
| Editor | Diff + file viewer in Preview pane | `code --new-window <workspace>` (VS Code) — the Pandesh VS Code extension reports the window back |
| Browser preview | Embedded `<webview>`/BrowserView pointing at the allocated localhost port; screenshot timeline from browser tools | Edge with a dedicated Pandesh profile (`--user-data-dir`), new window, real PID resolved |
| Documents | Built-in PDF viewer (pdf.js), image viewer | Default app via `ShellExecute` (registered as `viewer`, not owned beyond launch) |

Neither mode fabricates: a pane renders only when a registry row or artifact exists; a dead process shows its exit code and last lines.

### 3.1 Window placement (Show My Work)

- Only windows of processes in `execution_processes` (verified PID + owner token) may be moved/resized without approval. Placement uses Win32 `SetWindowPos` via a small signed helper or the existing sanitised PowerShell path (`windowsShellExec.ts`) calling `user32` — class 2 in `all-in-one-gaps.md`.
- Layout presets: *Side by side* (Pandesh 1/3 left, work 2/3 right), *Focus* (work window maximised on secondary monitor if present), *Stacked*.
- Respect the user: never steal focus while the user is typing (check foreground window idle ≥ 1.5 s); never move a window the user moved after Pandesh placed it (track last placement rect).
- Max 3 external windows per task; reuse windows across steps.

## 4. Lifecycle, cancellation, cleanup

| Event | Behaviour |
|---|---|
| Cancel task | SIGTERM-equivalent (`taskkill /T` on the **owned tree only**, verified by owner token), then kill after 5 s; registry → `killed` |
| Core restart | Boot reconciliation: rows `running` whose PID+token no longer match → `orphaned`; matching ones are re-attached (terminal re-tails log) |
| Core hard kill | Host watchdog (desktop host is a separate process) sweeps owned PIDs on Core loss — closes the known "orphaned headless Edge" gap |
| Task completes | Dev servers keep running only if the result says "launched for you" (user-visible, with Stop button); others stop |
| User takeover | "Take over" sets `handed_over`; Pandesh stops sending input, stops cleanup for that process, and records it in the result |
| Conflict | Port conflicts via `port_allocate`/`port_check_setup`; one dev server per project; file writes via write leases |

## 5. Interactive tool views (contract)

Every view = `{ kind, sourceRecord, liveChannel?, actions[] }`. Actions call Core endpoints; the view updates only from the resulting events.

| Tool | View | Source of truth | Actions |
|---|---|---|---|
| Timer | Countdown ring + label | host timer manager / `everyday_reminders` | pause, +5 min, cancel |
| Browser | Live screenshot strip + URL + page title; embedded preview for localhost | browser session tool invocations + screenshots | stop, open externally, approve pending submit |
| Coding | Terminal tail, test summary (pass/fail counts from Core's own re-run), diff | `execution_processes`, `run_checks` invocation, git diff via hardened git | stop, re-run tests, open in VS Code, take over |
| PDF | pdf.js viewer | `artifacts` (sha verified) | open externally, reveal in folder |
| Image | Full image + prompt/model/seed + generation time | `artifacts` + ComfyUI job | regenerate (new approval if needed), save as |
| Reminder | Editable item (title, time, channel) | `everyday_reminders` / `commitments` | edit, complete, cancel |
| Voice | Mic state, speaking state, transcript, interrupt | host speech state events | mute, stop speaking, push-to-talk |
| Customer support | Thread, customer, status, escalation level, draft reply | support case records (Phase 3) | approve reply, escalate, close |

## 6. Walk-through: "build a kitchen inventory app, run its tests, launch it, and show me the result"

1. Chief of Staff creates request → plan shows 4 checks (scaffold, tests pass, app launched, preview verified). Board card appears in *Running*.
2. Handoff to Coding (grant: new folder under the user's projects root, `cpu.process`, localhost egress only). Approval: "Create `D:\Projects\kitchen-inventory`".
3. Coding delegates generation to OpenCode (existing D12 path); Core re-reads git diff and re-runs tests itself.
4. VEM spawns `npm test` (registry row, terminal pane live). Failure → Coding repairs (bounded retries from `limits`), Board shows `2 of 4 checks`.
5. VEM allocates a port, spawns `npm run dev`, waits for health; Preview pane loads `http://127.0.0.1:<port>`; a browser tool screenshot is taken as evidence.
6. Show My Work (if enabled): VS Code opens the folder, Windows Terminal tab tails the dev server, Edge window shows the app — placed side by side.
7. Completion gate: tests passed (Core re-run), process alive + health 200, screenshot artifact → `verified`. Reply: one headline + what was not done.
8. Dev server keeps running with a visible Stop; cancelling stops the owned tree only.
