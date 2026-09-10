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
 * Should a tool requiring `requiredScope` be registered, given the probe
 * result and the operator's readonly override (design decision B, always
 * independent of and layered on top of whatever the probe found)?
 */
export function isToolAllowed(
  probe: ScopeProbeResult,
  requiredScope: string,
  isWriteOrDestructive: boolean,
  readOnly: boolean,
): boolean {
  if (readOnly && isWriteOrDestructive) return false;
  if (probe.kind === "unknown") return true; // fail open
  return probe.scopes.has(requiredScope);
}
