import { BitbucketClient } from "./bitbucket/client.js";
import { User } from "./bitbucket/types.js";

/**
 * Result of the one-time startup scope probe (design decision: option C,
 * "auto-probe once at startup", with automatic fail-open to option A,
 * "register everything", when the probe can't be trusted).
 *
 * `kind: "known"` - Bitbucket returned x-oauth-scopes on a successful call;
 * scopes are exactly what this credential holds. Use to filter tool
 * registration.
 *
 * `kind: "unknown"` - the header was absent, empty, or the probe call itself
 * failed. Deliberately fails open rather than closed: every tool is
 * registered, and Bitbucket's own per-call 403s (with their own
 * scope-mismatch detail) remain the real enforcement layer either way. This
 * mirrors GitHub's official MCP server, which filters when it trusts the
 * signal (classic PATs) and falls back to "list everything, let the API
 * decide" when it doesn't (fine-grained PATs, OAuth).
 */
export type ScopeProbeResult = { kind: "known"; scopes: Set<string> } | { kind: "unknown" };

/**
 * GET /2.0/user requires no scope at all (confirmed via the live OpenAPI
 * spec), so any valid credential can call it and get back x-oauth-scopes
 * regardless of what scopes it actually holds - a cheap, side-effect-free
 * self-probe that works before any real tool call is made.
 */
export async function probeGrantedScopes(client: BitbucketClient): Promise<ScopeProbeResult> {
  try {
    const { response } = await client.getWithResponse<User>("/user");
    const header = response.headers.get("x-oauth-scopes");
    if (!header) {
      return { kind: "unknown" };
    }
    const scopes = new Set(
      header
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return scopes.size > 0 ? { kind: "known", scopes } : { kind: "unknown" };
  } catch {
    // Network error, unexpected response shape, etc. - fail open, never closed.
    return { kind: "unknown" };
  }
}

/**
 * Operator-configured ceiling (design decision B), independent of and
 * layered on top of whatever the scope probe found:
 * - "readonly": no write/destructive tool of any kind, draft or not.
 * - "draft": only tools whose write is enforced-non-live (a draft PR, a
 *   pending comment) - see writeLevel below. Nothing that's ever live the
 *   moment it runs.
 * - "readwrite": everything the credential's actual scopes allow (default).
 */
export type Mode = "readonly" | "draft" | "readwrite";

/**
 * What a tool actually does to Bitbucket:
 * - "read": never writes.
 * - "draft": writes, but the result is enforced non-live (forced
 *   draft:true / pending:true, no way for the caller to override it - see
 *   tools/pullRequests.ts's *Draft tool variants).
 * - "write": a live mutation, or destructive, or both.
 */
export type ToolWriteLevel = "read" | "draft" | "write";

/**
 * Should a tool requiring `requiredScope` be registered, given the probe
 * result and the operator's mode ceiling?
 */
export function isToolAllowed(
  probe: ScopeProbeResult,
  requiredScope: string,
  writeLevel: ToolWriteLevel,
  mode: Mode,
): boolean {
  if (mode === "readonly" && writeLevel !== "read") return false;
  if (mode === "draft" && writeLevel === "write") return false;
  if (probe.kind === "unknown") return true; // fail open
  return probe.scopes.has(requiredScope);
}
