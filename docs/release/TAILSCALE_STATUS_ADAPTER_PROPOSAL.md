# Proposal: dedicated Tailscale status-only adapter (M54 allowlist entry)

Status: PROPOSAL. Nothing is implemented, allowlisted or deployed. Needs owner approval before any code is written.

## Need
Pandesh services (phone access, NAS, shared JUGAAD services) depend on the tailnet. Today nothing can answer "is Tailscale up, which peers are reachable" deterministically, so it would fall to a model or a human. A read-only status service closes that without any model.

## Proposed file
`core/runtime/tailscaleStatus.ts` — a new, single-purpose module, added to the M54 allowlist **by itself**. No command is added to `documentOcr.ts` or any other already-allowlisted module.

## What it may run
Exactly one fixed argv, never built from input, never through a shell:

    <tailscale.exe> status --json

- Executable resolved from a fixed list (`C:\Program Files\Tailscale\tailscale.exe`, optional `KARKEDIKHA_TAILSCALE_EXE`), must exist, must be named `tailscale.exe`.
- No arguments from tasks, users or models. No `up`, `down`, `login`, `logout`, `set`, `serve`, `funnel`, `cert`, `ssh`, `file`, `lock`, `switch`, `ip` variants.
- Timeout 8 s, process-tree kill on cancel, sanitized environment, output cap 1 MB, `windowsHide`.
- Implementation uses its own `spawn` with those constants (this is why it needs its own allowlist entry) — or, if the owner prefers, a new `runFixedTool` export in a *new* module that wraps the same primitive; either way a separate file.

## What it returns (allow-list of fields, everything else dropped)
`BackendState`, `Self{HostName, DNSName, TailscaleIPs, Online}`, per peer `{HostName, DNSName, TailscaleIPs, Online, LastSeen, OS}`, `CurrentTailnet.Name`, `Health[]`. Auth URLs, node/machine keys, user profiles, routes, and the rest of the JSON are removed before the value leaves the module.

## Bridge integration
Service `net.tailscale-status`, task class `network.status`, `readOnly: true`, `roots: []`, declared in the capability registry like every other service; routed deterministically by the intent router for phrases such as "is tailscale connected". Evidence `{kind:'tailscale-status', ...allowlisted fields}`, verification `independent`.

## Guardrails and tests
- M54 guard test updated with exactly one new allowlist line for `core/runtime/tailscaleStatus.ts`; a test asserts the allowlist grew by that one entry only.
- Unit tests: argv is exactly `['status','--json']`; field filtering drops keys/auth URLs (fixture with fake secrets); not-installed, not-running, timeout and malformed JSON each yield a clear error, never a guess.
- No network call is made by Pandesh itself; the CLI talks to the local Tailscale daemon only.

## Explicitly out of scope
Changing tailnet state (login, serve/funnel, exit nodes, ACLs), reading Tailscale admin API, any write. If those are ever wanted they need a separate proposal.

## Decision requested
Approve (a) the module and its single allowlist entry, and (b) which executable path policy (fixed path + env override) to use.
