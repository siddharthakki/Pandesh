# ChatGPT ↔ Pandesh direct integration — architecture and proof

Status: **design plus a working local gateway. Nothing is exposed publicly, no connector exists on any OpenAI account, no tunnel was created.** Date: 2026-11-20.

## 1. What ChatGPT's connector mechanisms actually support

From OpenAI's own pages (read 2026-11-20): `developers.openai.com/api/docs/guides/developer-mode` ("Add custom MCP server"), `.../plugins/build/auth`, `.../plugins/deploy/connect-chatgpt`, `.../api/docs/guides/secure-mcp-tunnels`.

| Question | Answer from the docs |
|---|---|
| Local stdio / localhost server? | **No.** ChatGPT talks only to a remote MCP server over **SSE or streamable HTTP**. The existing `apps/panda-bridge/mcp-server/index.cjs` (stdio) cannot be attached to ChatGPT; it suits clients on the same PC (Claude Desktop, Codex). |
| How can a private PC server be reached? | Three documented ways: a public HTTPS endpoint, a public HTTPS proxy in front of the private server (mTLS and/or OAuth), or a **Secure MCP Tunnel**. A tailnet or LAN address is not addressed and ChatGPT's cloud cannot reach it directly. |
| Secure MCP Tunnel | An OpenAI-hosted endpoint plus `tunnel-client`, which **you run on your PC**. It is **outbound-only** HTTPS to `api.openai.com:443`, needs no inbound port, and forwards MCP requests to your server over HTTP or stdio. Limits: 600 requests/min, 10 MiB, 120 s per request. Needs an OpenAI Platform organization, a runtime API key, Tunnels permissions, and a tunnel associated with the ChatGPT workspace. The pages do not name a required plan, do not confirm Windows support, and do not say whether a loopback `--mcp-server-url` is accepted. |
| Authentication ChatGPT can present | **OAuth 2.1 authorization code + PKCE (S256)**, with dynamic client registration, client-metadata documents or static credentials; or **no authentication**; or a mix per tool. **No API keys, no custom headers, no client-credentials grant, no customer mTLS certificate.** ChatGPT presents an OpenAI-managed client certificate that a server may validate. Redirect URI `https://chatgpt.com/connector_platform_oauth_redirect`. |
| Confirmation | Tools without `readOnlyHint: true` are treated as writes and **ask the user to confirm** by default, remembered per conversation only. |
| Where | The docs say "ChatGPT on the web"; they do not mention the desktop app or voice mode. |

**Consequences.** The shortest *supported* path is a remote MCP server with OAuth, reached through the Secure MCP Tunnel (private) rather than public exposure. Voice mode support is unconfirmed and must be tested with the owner's account.

## 2. Architecture

```
I speak to ChatGPT
  → ChatGPT (OpenAI cloud) calls the Pandesh connector over MCP
  → OpenAI-hosted tunnel endpoint ⇐ outbound HTTPS from tunnel-client on this PC   (no inbound port, no public URL)
  → Pandesh MCP gateway, 127.0.0.1:3973   [apps/panda-bridge/mcp-gateway/server.mjs]
  → Pandesh Core /v1/bridge/* with a pairing of kind "browser"   (the EXISTING Panda Bridge task lifecycle)
  → approved executors and services (local agents, deterministic services; Claude Code only after the owner's card)
  ← status and report come back through the same path; ChatGPT continues the workflow
```

Reused, not rebuilt: task submit/dispatch/status/report/cancel, executor discovery, the capability router, read-only project inspection, the approval card, the audit trail (`bridge_task_checkpoints`), pairing and revocation. New code is one file: the gateway (about 300 lines, Node built-ins only).

Tools: `pandesh_list_agents`, `pandesh_task_status` (`wait_seconds` up to 50 s), `pandesh_task_report` (all `readOnlyHint`), `pandesh_submit_task`, `pandesh_cancel_task`. There is **no approve tool**: ChatGPT can ask for a cloud agent but cannot authorise it.

## 3. Authentication and consent

- The gateway is its own OAuth 2.1 authorization server: discovery (`/.well-known/oauth-protected-resource`, `.../oauth-authorization-server`), dynamic client registration (https or loopback redirect URIs only), authorization code with mandatory PKCE S256, single-use 5-minute codes, access tokens 1 h, refresh tokens rotated on every use.
- **Owner consent = a Pandesh pairing code.** The consent page asks for a one-time code created inside the Pandesh app (the same code used to pair a browser). That proves presence at the PC and creates a normal pairing labelled "ChatGPT connector (…)". Revoking that pairing in Pandesh kills the connector immediately (proved below).
- Tokens are stored as SHA-256 hashes; the pairing token behind a grant sits in `mcp-gateway.json` (mode 0600) in the profile, next to `core.token`.

## 4. Security boundaries

1. **Only the gateway is reachable.** The tunnel points at `127.0.0.1:3973`, never at Core. Core's full API (host token, approvals, projects, files) is not on that path.
2. **Authority = a paired browser.** It cannot approve, read approvals, register projects, or start a cloud agent. A request for Claude Code yields "waiting for the owner" and starts nothing.
3. **No silent cloud fallback.** `auto` chooses local executors only; the cloud agent needs the owner's per-task card (commit-pinned, single-use, expiring, as in Build 188).
4. **Read-only projects stay read-only**; the inspection mode (private clone, no remote, change check) applies unchanged.
5. **Auditability.** Every connector task carries `sourceRef.kind='chatgpt', via='mcp'` in the existing task record; the gateway appends submit/cancel/consent lines to `logs/mcp-gateway.log` (no secrets).
6. **Data that leaves.** Reports go back to ChatGPT (OpenAI) over the tunnel. They are produced from whatever the task read, so the owner's data in a report leaves the PC when ChatGPT asks for it. Mitigations: ChatGPT confirmation prompts on write tools, tasks are read-only by default wording, and the owner can revoke at any time. A policy "never return reports for confidential tasks" is a follow-up.
7. **Residual risk.** A ChatGPT conversation that is manipulated by a web page or file (prompt injection) can submit tasks. Limits: local executors only, per-task owner card for cloud, read-only projects, ChatGPT's own write confirmation.

## 5. Network requirements

Outbound HTTPS 443 to `api.openai.com` (and `mtls.api.openai.com` if control-plane mTLS is used); loopback only on the PC; **no inbound firewall rule, no port forward, no Tailscale Funnel, no public DNS name.**

## 6. Minimal end-to-end proof (done) and what remains

Done, against the isolated packaged Build 188 on port 3962 with the gateway on 3973 (script `D:\PandeshAssistantDev\rel188\mcp-proof.mjs`), using a client that behaves like ChatGPT's connector:

- No token → 401 with `WWW-Authenticate: resource_metadata`; metadata advertises S256 and registration; a non-https, non-loopback redirect is refused; a wrong owner code is refused (403).
- Owner code → redirect with code and state; wrong PKCE verifier refused; codes are single-use; tokens issued; refresh rotates and the old refresh token is dead.
- `initialize`, `tools/list`, `pandesh_list_agents` work.
- **Local task** (`service:fs.list`) started at once, no model. It failed with "path is outside the roots this service is allowed to read" because I pointed it at the acceptance folder: the file-service boundary held.
- **Cloud task** (`executor: claude`): status `awaiting_executor`, "waiting for the owner", nothing sent; the owner's card names project `sample-repo`, branch and commit; the owner approved in Pandesh; ChatGPT-side status followed it to `completed`; the report came back with the worker-only label and the "your checkout is exactly as it was" check.
- Revoking the pairing in Pandesh made the next tool call fail with "pairing was revoked".

**Not done (needs the owner's separate approval, none of it done or attempted):**

1. An OpenAI Platform organization/tunnel and a runtime API key (an account/key action only the owner can create).
2. Downloading and running `tunnel-client` (an unreviewed third-party binary; Windows support unverified).
3. Creating the connector in ChatGPT (workspace permission, plan) and testing it, including voice mode.
4. The single unresolved technical risk: **where ChatGPT's browser-side OAuth redirect lands.** The authorize page is opened by the owner's browser, which runs on this PC, so `http://127.0.0.1:3973/authorize` works for it, but the metadata advertises one `PANDESH_MCP_PUBLIC_URL`. If the tunnel passes OAuth discovery only, the token endpoint (called by ChatGPT's servers) must be reachable through the tunnel path while the authorize endpoint may be loopback. This needs one live test. The fallback is the documented public-HTTPS-proxy option with the same gateway, which needs a separate approval because it exposes an endpoint.

## 6a. Finding 2026-11-20: OAuth through the tunnel (live test, isolated Build 188)

**Symptom.** ChatGPT: "Couldn't discover OAuth settings", then "The MCP server denied access". Tunnel healthy; ChatGPT's `server/discover` reached `main` and got the intended 401; 4 commands hit the `harpoon` channel and were refused (`unsupported_channel`, harpoon disabled).

**Cause: configuration, not a tunnel limit.** Sources: `tunnel-client help oauth`, OpenAI's tunnel guide, `openai/tunnel-client` docs/configuration.md and connectors.md, and live client state.
- Discovery (401 challenge, protected-resource metadata, authorization-server metadata) is run by tunnel-client on this PC. It worked (`oauth: complete`).
- Endpoints in the metadata are then handled in one of two ways. An endpoint on an **approved HTTPS forward origin** (`--harpoon.oauth-forward-origin`, HTTPS only, exact scheme/host/port) is rewritten to a `harpoon://` shim, so `/register` and `/token` POSTs travel **through the tunnel** to the local server. Any other http(s) endpoint is "called by the product OAuth caller" directly, which cannot reach `http://127.0.0.1`.
- `authorization_endpoint` is never rewritten: the owner's browser goes to it directly, so a loopback URL is correct there.
- My gateway advertised `http://127.0.0.1:3973/...` for everything and no forward origin was approved. (OpenAI's own `dev mcp-stub` advertises the same loopback http URLs, so the advertisement alone was not the defect; the missing HTTPS forward origin was.)
- The flag rejects `http://` origins even with `--harpoon.allow-plaintext-http` (verified with `doctor`), so the endpoint must be HTTPS.

**Fix (smallest, off by default).** `PANDESH_MCP_TLS_PORT=3974`: the gateway also listens with TLS on `127.0.0.1:3974` using a self-signed leaf (SAN `127.0.0.1`, CA:FALSE, 90 days, key in the isolated profile, ACL limited to the owner). MCP, metadata, `/register`, `/token` are served there; issuer = `https://127.0.0.1:3974`. The plain listener on 3973 then serves only `/authorize` and `/healthz`. tunnel-client runs with `--ca-bundle <that cert>`, `--mcp.server-url url=https://127.0.0.1:3974/mcp`, `--harpoon.oauth-forward-origin https://127.0.0.1:3974`. No no-auth path, no public listener, no system trust-store change, no permission change.

**Evidence (without ChatGPT, scratch ports 3983/3984, then removed).** Strict-TLS client: connection without the pinned cert is refused; PRMD `resource`/`authorization_servers` and AS `issuer` all equal `https://127.0.0.1:3974`-origin (RFC 8414 §3.3, RFC 9728); only S256 advertised; DCR accepts the ChatGPT redirect and refuses a non-HTTPS one; `/token` returns `invalid_grant` with `Cache-Control: no-store` for a bad code; the plain listener returns 404 for `/mcp`, `/token`, `/register` and metadata. `tunnel-client doctor`: with `--ca-bundle` all checks pass (MCP 401 reachable, OAuth metadata 200 over HTTPS); without it, `x509: certificate signed by unknown authority`, so verification is not disabled. **Not yet verified:** ChatGPT completing the flow, in particular whether it accepts an `http://127.0.0.1` authorization endpoint beside an HTTPS issuer. Needs one live attempt by the owner.

**If ChatGPT rejects that authorization endpoint,** the next step (needs approval) is to serve `/authorize` over the same HTTPS origin and let the owner's browser trust that certificate once; still no public exposure.

## 7. Decisions for the owner

- C1. Approve creating a tunnel and runtime key on your OpenAI Platform organization, and downloading `tunnel-client` from `github.com/openai/tunnel-client/releases` (I would check its hash and publisher first and run it only with `--mcp-server-url http://127.0.0.1:3973/mcp`).
- C2. Approve creating the connector in your ChatGPT workspace, as a private (not published) connector.
- C3. Confirm whether you use ChatGPT on the web or the desktop app, and whether voice mode must work. The docs only promise the web.
- C4. Decide whether report text from tasks marked confidential may be returned to ChatGPT (default today: yes, after the same read-only rules).
- C5. Review `apps/panda-bridge/mcp-server/index.cjs` (untracked, from an earlier session): it pairs itself with the host token read from disk. I did not use or change it; I recommend it stays local-only and is not tracked.
