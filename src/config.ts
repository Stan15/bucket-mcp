/** Server configuration, read once from the environment at startup. */
export interface Config {
  /** Bitbucket scoped API token. Sent as `Authorization: Bearer <token>` on every request. */
  apiToken: string;
  /**
   * Operator override (design decision B): when true, write/destructive tools
   * are never registered, regardless of what the token's scope probe finds.
   * Independent of and layered on top of the scope-based gating in scopeProbe.ts.
   */
  readOnly: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.BITBUCKET_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "BITBUCKET_API_TOKEN is not set. Create a scoped API token in Bitbucket " +
        "(Personal settings -> API tokens) and set it as an environment variable.",
    );
  }

  const readOnly = env.BITBUCKET_MCP_READONLY === "1" || env.BITBUCKET_MCP_READONLY === "true";

  return { apiToken, readOnly };
}
