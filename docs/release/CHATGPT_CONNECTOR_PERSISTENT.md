# ChatGPT connector: persistent supervisor (dev branch, NOT installed, NOT deployed)

Pandesh's desktop host now owns the ChatGPT connector's lifecycle, so nobody runs a launcher by hand.
Code: `apps/desktop/src/host/chatgptConnector.ts`, IPC in `ipc.ts`/`preload.ts`/`main.ts`, card in `renderer-v2/src/ChatgptConnector.tsx`
(Connections page). Tests: `apps/desktop/test/chatgptConnector*.test.ts`, integration driver `scripts/acceptance/chatgpt-connector-it.mjs`.

## What it does
- **Off by default.** Start/Stop in the Connections card. When on, it starts again whenever Pandesh opens.
- **Key:** stored once in Windows Credential Manager (existing `CredentialVault`, provider id `openai-tunnel`, target `pandesh/openai-tunnel/api-key`).
  Read at process start and given to `tunnel-client` only via that process's environment (`env:CONTROL_PLANE_API_KEY`). Never on a command line,
  in a file, in a log (every log line is redacted against the key), or returned to the renderer (masked hint only).
- **Processes:** the MCP gateway (loopback only: HTTPS 127.0.0.1:3974 for MCP + /register + /token, plain 127.0.0.1:3973 for /authorize) and OpenAI's
  outbound-only `tunnel-client`, both non-elevated, fixed argv, no shell, reduced environment.
- **Recovery:** crash -> restart with backoff 2/4/8/16/32 s; more than 5 crashes in 10 minutes -> stop retrying and show the failure. A health watchdog
  ends a process that is alive but not answering (3 missed checks, 30 s apart) so it restarts. Only processes the supervisor started are ever stopped.
- **Duplicate prevention:** refuses to start when a port is taken (never kills a process it did not start); Pandesh itself is single-instance.
- **Certificate:** self-signed ECDSA P-256 loopback leaf (SAN 127.0.0.1), created with OpenSSL when missing or within 14 days of expiry, reused across restarts.
  **Pin check:** before the tunnel starts the supervisor handshakes with the gateway trusting ONLY the on-disk certificate and compares SHA-256 fingerprints;
  a different process or certificate on the port stops the start. (`tunnel-client --ca-bundle` adds trust; it cannot itself pin, so the pin is enforced by this check
  plus loopback-only binding.)
- **Pairing:** created only from the Pandesh window (host token) as a one-time code; the existing pairing survives restarts (refresh token persisted in the gateway
  state; the access token is in memory, so ChatGPT refreshes after a restart). Disconnect revokes every "ChatGPT connector" pairing and switches off.
- **Visibility:** card shows state, which Core (port, build, "TEST COPY" vs real), tunnel connected, last failure with time, recent redacted log.
- **Which Core:** the connector always uses the data directory of the Pandesh instance that hosts it (its own `core.json`); it never searches for or falls back to
  another profile, so it cannot silently attach to production. A missing/unreachable Core shows as "degraded", not as running.

## Evidence (2026-11-21, isolated; production on 3030 and the live session on 3973-3975 untouched)
- Unit: 13 tests (key never in args/log/status/env of the gateway, key only in the tunnel's environment, redaction when the program echoes the key, port conflict,
  no key, off-by-default, pinning accepts/refuses/none-listening, certificate expiry, crash backoff + bounded give-up, watchdog, Core status). Full desktop suite: 1000 passed.
- Integration (`chatgpt-connector-it.mjs`, real supervisor + gateway + tunnel-client with a DUMMY key + isolated Build 188 Core 3962, scratch ports 4973-4975): **28/28**
  - certificate generation, pin verified, key absent from every process command line, Core shown as isolated/not production;
  - plain listener serves only /healthz and /authorize; HTTPS without the pinned certificate fails validation; 401 challenge; issuer/S256/HTTPS endpoints;
  - consent CSP names the redirect origin; wrong code refused; wrong PKCE verifier refused; token exchange; exactly 5 tools (no approve tool); list_agents executed on the isolated Core;
  - gateway crash restarted; second instance refused; stop releases ports; certificate and pairing survive restart (refresh works once, old access token gone);
  - revoking the pairing in Pandesh cuts access immediately.
- Left alone: the owner's live ChatGPT pairing `pair_0ea3dc05` is still active; every test pairing was revoked.

## Not done / needs the owner
1. **Key:** I do not have the replacement key (correct). Revoking the old key in the OpenAI dashboard and creating the Tunnels Read + Use key is the owner's step; paste it into the card (never into chat).
2. **Start at Windows login:** the connector starts when Pandesh starts, so it needs Pandesh's own start-at-login entry. That entry is a registry write that must be made from the owner's own session (agent shells are
   MSIX-virtualized); not tested here. Verify with `scripts/panda-bridge/install-native-host.mjs --check`-style checks or by signing out/in.
3. **Real tunnel + ChatGPT test, network-interruption test:** needs the owner's key in an installed or dev-run Pandesh. Only the dummy-key failure path of the real `tunnel-client` was exercised.
4. **Packaging:** the gateway script is not yet shipped inside the Pandesh package (the card takes its path); `tunnel-client.exe` is OpenAI's binary and is configured by path, not bundled.
5. **Finding:** the gateway keeps each pairing token in `mcp-gateway.json` in the profile folder (user-only permissions, not encrypted). Wrapping it with DPAPI is a worthwhile follow-up.
6. Production needs Build 188 (or later) installed with this code: separate approval.
