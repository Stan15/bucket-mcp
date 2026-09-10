# Modern MCP Server Design — Best Practices for a Bitbucket MCP

Sources: `modelcontextprotocol.io/specification/*` (official spec, all revisions) and `github.com/modelcontextprotocol` (SDK release history), checked 2026-09-09. No existing Bitbucket MCP implementation was consulted for this document.

## Spec revision landscape and target baseline

Lineage: `2024-11-05` → `2025-03-26` → `2025-06-18` → `2025-11-25` → **`2026-07-28`** (current).

`2026-07-28` is a ground-up, breaking rewrite — sessions removed, the `initialize` handshake removed in favor of a stateless per-request model, server-initiated requests (sampling/elicitation/roots) replaced by a "Multi Round-Trip Request" retry pattern, and Sampling/Roots/Logging formally deprecated. It shipped roughly six weeks before this research, with the SDK's `2.0.0` release simultaneously publishing a `server-legacy` package and a `codemod` migration tool — the ecosystem's own admission this is a slow, non-trivial migration.

**Recommendation: build against `2025-06-18`/`2025-11-25` semantics as the practical baseline** (handshake-based lifecycle, tool annotations, structured output, resource links, elicitation) rather than the `2026-07-28` stateless model, and write the transport/version-negotiation layer to be revision-aware since the spec explicitly designs for this (a client can probe era via a modern-request-first strategy; servers can detect a header-less request and treat it as pre-`2025-06-18`). Revisit the `2026-07-28` shape once client-side adoption data exists — treat this recommendation as time-bound, not permanent.

**This is the single tradeoff most likely to bite:** whichever revision you target, verify current client support before depending on any specific capability. The `modelcontextprotocol.io` clients page is an ecosystem-links page, not a capability matrix — there is no confirmed client-by-client support table for elicitation, sampling, structured output, or the `2026-07-28` stateless model as of this research. Check each target client's own release notes at build time.

---

## Transport

| Transport | Status | Use for a Bitbucket MCP when... |
|---|---|---|
| **stdio** | Universal baseline, all revisions | The server runs locally (Claude Code/Desktop, most CLI-launched MCP configs). No built-in auth — the spec explicitly says stdio implementations should retrieve credentials from the environment rather than implement OAuth. **This is almost certainly the right default for a personal/team Bitbucket MCP**: the Bitbucket credential lives in an env var or OS keychain, read once at startup. |
| **Streamable HTTP** | Current since `2025-03-26` | The server is deployed remotely/shared (a team-hosted MCP endpoint). Requires the full OAuth 2.1 Resource Server flow (below) — real added complexity, only worth it if genuinely multi-tenant. |
| **HTTP+SSE** (`2024-11-05` shape) | Formally Deprecated | Don't implement for a new server. |

If going remote, note the `2026-07-28` transport is a breaking change from the `2025-03-26`→`2025-11-25` shape: no `Mcp-Session-Id`, no GET/SSE standalone stream, no `Last-Event-ID` resumption — a broken connection loses in-flight requests outright, client must re-issue. Given the adoption-lag concern above, implement the pre-`2026-07-28` session-based Streamable HTTP shape first if remote deployment is needed now.

---

## Authorization (only relevant for Streamable HTTP)

The MCP server acts as an **OAuth 2.1 Resource Server**; the MCP client is the OAuth client; the Authorization Server is a separate role (out of MCP spec scope — for a Bitbucket MCP this would be Atlassian's own OAuth AS, since the MCP server itself doesn't mint Bitbucket credentials).

Required flow: `401` + `WWW-Authenticate: Bearer resource_metadata="https://.../.well-known/oauth-protected-resource"` (RFC 9728) → client fetches Protected Resource Metadata → resolves the AS via RFC 8414 and/or OIDC Discovery → registers via Client ID Metadata Documents (preferred, `client_id` is itself an HTTPS URL the AS fetches — no registration round-trip) or falls back to Dynamic Client Registration (now deprecated but retained for AS compatibility). Resource Indicators (RFC 8707) are mandatory on every authorization and token request — the `resource` param must be the MCP server's own canonical URI, not Bitbucket's.

Runtime insufficient-scope handling: `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`, bundling every scope the failed operation needs in one challenge (no incremental round-trips). This is the MCP-level auth challenge and is distinct from — and sits above — Bitbucket's own `X-OAuth-Scopes`/`X-Accepted-OAuth-Scopes` header mechanism documented in the companion API contract doc; don't conflate the two layers when a call fails.

None of this applies to stdio. If the whole design fits on stdio (likely, for a Claude Code use case), skip this section's implementation entirely.

---

## What to implement

| Capability | Verdict | Why |
|---|---|---|
| **Tools** | Implement — core surface | The entire Bitbucket API surface (§3 of the companion doc) maps to tools. |
| **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) | Implement | Cheap to add, genuinely useful UX signal for a server with real write/delete operations against shared team repos (merge, delete branch, decline PR). **Spec explicitly warns these are untrusted hints, not a security control** — still enforce real checks server-side, but surface them for client UI/confirmation flows. |
| **Structured output** (`outputSchema` + `structuredContent`) | Implement for high-value tools | Lets a client render/validate a PR or pipeline-run object without the model re-parsing prose. Also return the same data as `TextContent` for back-compat per spec guidance. |
| **Resource links** in tool results | Implement — directly addresses the user's "less context-heavy" goal | Return a `resource_link` (URI reference) instead of inlining a full diff or file body. Pair naturally with the Bitbucket `diffstat`-by-default / `diff`-on-request design from the companion doc: a "show PR changes" tool returns diffstat inline plus a resource link to the full diff, rather than ever dumping a multi-file diff into the tool result by default. |
| **Pagination** (cursor-based `tools/list`, `resources/list`, etc.) | Implement per spec shape | Independent of Bitbucket's own pagination — the MCP server translates Bitbucket's `next`-URL/cursor pagination into MCP's opaque-cursor convention at the boundary; don't leak Bitbucket's raw `page`/`pagelen` params to the MCP client. |
| **`tools/list_changed`** | Implement, treat as enhancement | Fire it if the server detects the configured credential's scope set changed post-startup. Mechanism: Bitbucket echoes the credential's actual granted scopes on the `x-oauth-scopes` response header of any call; probe it once at startup with one cheap unscoped call (`GET /2.0/user`) to decide which tool families to register, and re-probe/re-fire this notification if a later `403` implies the scope set shrank (companion doc §1.1, §4). Client support for reacting to the notification is inconsistent — real enforcement stays server-side per-call regardless. |
| **Elicitation** | Consider for destructive ops | Good fit for "confirm before this merges/deletes" flows. Not deprecated, still evolving (materially reshaped in both `2025-11-25` and `2026-07-28`). Verify target client support before depending on it — many clients currently no-op or auto-decline elicitation requests. |
| **Resources** (as a standalone capability, beyond resource links in tool results) | Optional, low priority | A Bitbucket MCP's natural resources (files, diffs) are more naturally reached parametrically via tools than via a static resource list — resource *links returned from tools* deliver the token-economy win without needing the full resources capability. |
| **Prompts** | Optional | Useful only if shipping canned prompt templates (e.g. "review this PR"); not core to API coverage. |
| **Sampling** | Skip | **Deprecated as of `2026-07-28`**, and was already one of the least universally-implemented capabilities pre-deprecation. A Bitbucket MCP has no need to ask the client's LLM to generate content on the server's behalf. |
| **Roots** | Skip | **Deprecated as of `2026-07-28`**. No local-filesystem-root concept applies to a remote Git host API — irrelevant regardless of deprecation status. |
| **Logging** (MCP logging capability) | Skip in favor of stderr/OpenTelemetry | **Deprecated as of `2026-07-28`**; write logs to stderr on stdio (explicitly permitted for all log levels since `2025-11-25`) or emit OpenTelemetry traces via the now-documented `_meta` propagation keys (`traceparent`/`tracestate`/`baggage`). |
| **Completions** (`completions/complete`) | Optional, nice-to-have | Argument autocomplete for parametrized inputs (e.g. suggesting workspace/repo slugs as a user types) — genuinely useful for a Bitbucket MCP's identifier-heavy inputs, but not load-bearing. |

---

## Error model: map Bitbucket failures to the MCP two-tier model, not to protocol errors

Since `2025-11-25` the spec formalizes a distinction that was implicit earlier: **Protocol Errors** (a JSON-RPC error object — unknown tool, malformed request, the kind of failure the model can't reason its way out of) versus **Tool Execution Errors** (`isError: true` inside an otherwise-normal tool result, carrying text a model *can* act on). Clients are required to surface Tool Execution Errors to the model and only optionally surface Protocol Errors.

This is the correct home for essentially every Bitbucket failure a tool call will hit:

- A Bitbucket `403` from insufficient OAuth scope → Tool Execution Error, with the `x-accepted-oauth-scopes` vs `x-oauth-scopes` diff (companion doc §1.1) spelled out in the error text so the model can tell the user exactly which scope to add, rather than just "forbidden."
- A Bitbucket `429` rate-limit → Tool Execution Error naming the `Retry-After` value, not a silent retry loop and not a Protocol Error the model can't act on.
- A genuinely malformed tool call (bad workspace/repo slug shape, missing required argument) → Protocol Error, since no amount of Bitbucket-side context fixes it.

Getting this mapping right is a direct token-economy and reliability lever: a model that receives an actionable Tool Execution Error self-corrects in the same turn, while a bare Protocol Error or a raw stack trace burns a round-trip on a failure it can't interpret.

---

## Token-economy techniques, ranked by leverage for a Bitbucket MCP specifically

1. **`fields=` partial responses on every outbound Bitbucket call** (companion doc §2) — applied internally by the server, never exposed to the model as raw syntax. The single biggest lever, because Bitbucket's default representations are chatty.
2. **`diffstat` as the default "what changed" tool, full `diff` as a separate opt-in tool** — avoids ever defaulting a multi-file diff into a tool result.
3. **MCP resource links instead of inlining file/diff content** — lets the client fetch large content only when actually needed, and only once.
4. **Structured output over prose-formatted JSON-in-text** — avoids the model re-deriving structure from text it has to hold in context anyway.
5. **Tight, per-tool scope requirements surfaced via dynamic tool gating** (companion doc §4) — fewer registered tools the model has to reason about when a credential is narrowly scoped, not just a security nicety.

---

## Compatibility tradeoffs to weigh explicitly

- **Targeting `2025-06-18`/`2025-11-25` over `2026-07-28`** buys broad current-client compatibility at the cost of being on a revision the spec itself will eventually mark deprecated. Mitigate by keeping the transport/lifecycle layer isolated enough to swap later, and re-check adoption before the next major version of this server.
- **Elicitation** for destructive-operation confirmation is the most "modern and elegant" fit for merge/delete flows, but only some clients render it — plan a non-elicitation confirmation fallback (e.g. a required `confirm: true` tool argument) so the server degrades gracefully on clients that auto-decline or ignore elicitation requests.
- **Streamable HTTP + OAuth 2.1**, if pursued for a shared/remote deployment, is a materially larger implementation than stdio-with-env-credential. Don't build it speculatively — only take it on when a genuine multi-tenant/remote-hosting requirement exists.
- **`tools/list_changed`-driven dynamic tool sets** are a nice-to-have UX layer, not a portable guarantee — a client that ignores the notification simply keeps showing tools the credential can't actually use, which then fail with a clear `403` message instead of being hidden. Design tool descriptions/error messages assuming this happens.
