import { Mode } from "./scopeProbe.js";

/** Server configuration, read once from the environment at startup. */
export interface Config {
  /** Bitbucket scoped API token. Sent as `Authorization: Bearer <token>` on every request. */
  apiToken: string;
  /** Operator-configured ceiling - see scopeProbe.ts's Mode for what each level actually permits. */
  mode: Mode;
  /**
   * Optional default workspace slug. When set, every tool's `workspace`
   * argument becomes optional and falls back to this value - the AI can
   * still target a different workspace by passing one explicitly (typically
   * after calling bitbucket_workspace_list to discover it), it just isn't
   * required to on every call for the common single-workspace case.
   */
  defaultWorkspace?: string;
  /**
   * Undocumented escape hatch (see scopeProbe.ts's isToolAllowed) - hides a
   * tool the mode allows when the startup scope probe says the credential
   * lacks it, instead of the default of registering it and letting a real
   * call surface Bitbucket's own clear 403. Not mentioned in README or the
   * configure wizard on purpose: it trades a clearer error for a shorter
   * tool list, which isn't the right default for anyone to reach for.
   */
  strictScopeFilter: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.BITBUCKET_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "BITBUCKET_API_TOKEN is not set. Create a scoped API token in Bitbucket " +
        "(avatar -> Account settings -> Security -> Create and manage API tokens -> " +
        "Create API token with scopes) and set it as an environment variable.",
    );
  }

  const mode = resolveMode(env);
  const defaultWorkspace = env.BITBUCKET_DEFAULT_WORKSPACE || undefined;
  const strictScopeFilter = env.BITBUCKET_MCP_STRICT_SCOPE_FILTER === "1" || env.BITBUCKET_MCP_STRICT_SCOPE_FILTER === "true";

  return { apiToken, mode, defaultWorkspace, strictScopeFilter };
}

export function resolveMode(env: NodeJS.ProcessEnv): Mode {
  const raw = env.BITBUCKET_MCP_MODE?.toLowerCase();
  if (raw === "readonly" || raw === "draft" || raw === "readwrite") {
    return raw;
  }
  if (raw) {
    throw new Error(`BITBUCKET_MCP_MODE must be "readonly", "draft", or "readwrite" - got "${env.BITBUCKET_MCP_MODE}".`);
  }
  // Back-compat: BITBUCKET_MCP_READONLY predates BITBUCKET_MCP_MODE and is
  // still honored so nobody's existing setup breaks.
  if (env.BITBUCKET_MCP_READONLY === "1" || env.BITBUCKET_MCP_READONLY === "true") {
    return "readonly";
  }
  // Safe by default: an unconfigured server can create draft PRs and pending
  // comments/tasks, but nothing live or destructive, until someone
  // deliberately opts into BITBUCKET_MCP_MODE=readwrite.
  return "draft";
}
